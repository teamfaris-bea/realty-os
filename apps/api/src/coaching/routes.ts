// api/coaching routes, mounted under /api (module 36; PHASE2_3_PLAN §5.4 #36).
//
//   GET  /coaching/today            the caller's daily fix and its two quotes          coaching.view (own)
//   POST /coaching/today/dismiss    set today's fix aside (not suggested for 7 days)    coaching.view (own)
//   GET  /coaching/team             the team's current tips                            coaching.team_view (Owner/Admin; TL: what call_scores RLS lets them read)
//   GET  /admin/coaching            the Owner's coaching settings                      coaching.settings (Owner)
//   PUT  /admin/coaching            change them (🔒 when turning scoring or TL access on) coaching.settings (Owner)
//
// Every handler runs in the caller's tenant transaction under RLS. Quotes play through the existing audited
// recording stream (POST /recordings/:id/stream-token), never from here. Response schemas carry no tenant id,
// no confidence and no score or grade (R-COACH-6, snapshot test).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { actorOf, adminTx, platformOf } from '../admin/common.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { coachingSettings } from './repos/coaching.js';
import * as S from './schemas.js';
import { type CoachingSettingsInput, coachingSettingsView, isWidening, saveCoachingSettings } from './settings.js';
import { dismissToday, teamView, todayView } from './views.js';

function mapCoachingError(e: unknown): never {
  const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message?: unknown }).message ?? '') : '';
  if (msg.startsWith('COACHING_NOT_CLEARED')) throw new AppError('COACHING_NOT_CLEARED');
  throw e;
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const own = { config: { auth: 'coaching.view' as const }, preHandler: authorize('coaching.view', () => ({ own: true })) };
  const team = { config: { auth: 'coaching.team_view' as const }, preHandler: authorize('coaching.team_view', () => ({ team: true })) };
  const settingsRead = { config: { auth: 'coaching.settings' as const }, preHandler: authorize('coaching.settings', () => ({ loosening: false })) };

  r.get('/coaching/today', { ...own, schema: { response: { 200: S.TodayResponse } } }, async (req) => ({
    coaching: await adminTx(req, (tx, now, actor) => todayView(tx, actor, { envelope: platformOf(req).envelope, ids: platformOf(req).ids }, now)),
  }));

  r.post('/coaching/today/dismiss', { ...own, schema: { response: { 200: S.TodayResponse } } }, async (req) => ({
    coaching: await adminTx(req, async (tx, now, actor) => {
      await dismissToday(tx, actor, now);
      return todayView(tx, actor, { envelope: platformOf(req).envelope, ids: platformOf(req).ids }, now);
    }),
  }));

  r.get('/coaching/team', { ...team, schema: { response: { 200: S.TeamResponse } } }, async (req) => ({
    team: await adminTx(req, (tx, now, actor) => teamView(tx, actor, platformOf(req).envelope, now)),
  }));

  r.get('/admin/coaching', { ...settingsRead, schema: { response: { 200: S.SettingsResponse } } }, async (req) => ({ settings: await adminTx(req, (tx) => coachingSettingsView(tx)) }));

  r.put(
    '/admin/coaching',
    {
      config: { auth: 'coaching.settings' as const },
      // turning scoring or Team Lead access on widens who is reviewed or who sees reviews: re-auth (can())
      preHandler: authorize('coaching.settings', async (req) => {
        const b = req.body as CoachingSettingsInput;
        const cur = await adminTx(req, (tx) => coachingSettings(tx));
        return { loosening: cur === null ? true : isWidening(cur, b) };
      }),
      schema: { body: S.SettingsBody, response: { 200: S.SettingsResponse } },
    },
    async (req) => ({
      settings: await adminTx(req, (tx, now) => saveCoachingSettings(tx, actorOf(req), req.body as CoachingSettingsInput, now)).catch(mapCoachingError),
    }),
  );
}

export const coachingRoutes: RouteModule = { name: 'coaching', register };
