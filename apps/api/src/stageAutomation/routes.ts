// api/stage-automation routes (parity module 67), mounted under /api by routes.ts:
//
//   GET /playbooks/:id/auto-enroll-stage                                            self (RLS: whoever sees the playbook)
//   PUT /playbooks/:id/auto-enroll-stage  { stage: <one of the eight> | null }     playbook.auto_enroll_stage
//
// GET is what the playbook settings page shows: the stage, and whether the caller may change it, decided by
// the same can() on the same facts as PUT, so the page never offers a control the PUT would refuse. It reads
// the RLS-visible row only: a playbook the caller cannot see is 404, as GET /playbooks/:id is. It changes
// nothing and reveals nothing the playbook row itself does not.
//
// R-PAR-16: a playbook may name ONE stage whose entry enrolls the person. Team playbooks: Owner/Admin. An
// agent: their own agent playbook only (it covers only their own contacts, reconcile.ts). Nobody else:
// Team Leads, ISAs, TCs and support actors get 404 (R-PERM-5; support is read-only in the DB too). One
// active playbook per (scope, owner, stage) (DB unique index → 409 AUTO_ENROLL_STAGE_TAKEN); never a
// new-lead-response playbook (DB CHECK, refused here first); never a retired one. Audited as
// settings.changed on the playbook. Setting a stage enrolls nobody by itself: only a later stage entry
// does, and only from an approved version.
import { STAGES } from '@realty/core/parity/people';
import { type Instant, type ResourceFacts, type UserActor, can } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import { actorOf, platformOf } from '../leads/common.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import * as R from './repos.js';

const IdParams = z.object({ id: z.uuid() });
const Body = z.strictObject({ stage: z.enum(STAGES).nullable() });
const PlaybookSetting = z.object({ id: z.string(), name: z.string(), scope: z.enum(['team', 'agent']), autoEnrollStage: z.string().nullable() });
const Response = z.object({ playbook: PlaybookSetting });
const GetResponse = z.object({ playbook: PlaybookSetting, canChange: z.boolean() });

async function tx<T>(req: FastifyRequest, fn: (tx: Tx, now: Instant, actor: UserActor) => Promise<T>): Promise<T> {
  const actor = actorOf(req);
  try {
    return await withTenantTx(actor, (t, now) => fn(t, now, actor), { db: platformOf(req).db, retries: 2 });
  } catch (e) {
    const pe = (e && typeof e === 'object' ? e : {}) as { code?: string; constraint?: string };
    if (pe.code === '23505' && pe.constraint === 'playbooks_auto_enroll_one') throw new AppError('AUTO_ENROLL_STAGE_TAKEN');
    if (pe.code === '23514' && pe.constraint === 'playbooks_auto_enroll_not_new_lead') throw new AppError('AUTO_ENROLL_NOT_ALLOWED');
    throw e;
  }
}

/** The facts PUT authorizes on (and GET reports with): the caller's own agent playbook, or a team playbook. */
function settingFacts(p: Pick<R.PlaybookSettingRow, 'scope' | 'ownerUserId'>, actor: UserActor): ResourceFacts {
  return { own: p.scope === 'agent' && p.ownerUserId === actor.userId, teamPlaybook: p.scope === 'team' };
}

/** The caller's relation to the playbook, from the RLS-visible row (null: invisible → 404). */
function playbookFacts(req: FastifyRequest): Promise<ResourceFacts | null> {
  return tx(req, async (t, _now, actor) => {
    const p = await R.playbookSetting(t, (req.params as { id: string }).id);
    if (!p) return null;
    return settingFacts(p, actor);
  });
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/playbooks/:id/auto-enroll-stage', { config: { auth: 'self' }, schema: { params: IdParams, response: { 200: GetResponse } } }, async (req) =>
    tx(req, async (t, _now, actor) => {
      const p = await R.playbookSetting(t, req.params.id);
      if (!p) throw new AppError('NOT_FOUND');
      return { playbook: { id: p.id, name: p.name, scope: p.scope, autoEnrollStage: p.autoEnrollStage }, canChange: can(actor, 'playbook.auto_enroll_stage', settingFacts(p, actor)).ok };
    }),
  );
  r.put(
    '/playbooks/:id/auto-enroll-stage',
    {
      config: { auth: 'playbook.auto_enroll_stage' },
      preHandler: authorize('playbook.auto_enroll_stage', playbookFacts),
      schema: { params: IdParams, body: Body, response: { 200: Response } },
    },
    async (req) =>
      tx(req, async (t, _now, actor) => {
        const p = await R.playbookSetting(t, req.params.id, { lock: true });
        if (!p) throw new AppError('NOT_FOUND');
        const stage = req.body.stage;
        if (stage !== null && (p.kind === 'new_lead_response' || p.kind === 'trigger' || p.kind === 'voice_answering')) throw new AppError('AUTO_ENROLL_NOT_ALLOWED');
        if (stage !== null && p.status !== 'active') throw new AppError('PLAYBOOK_RETIRED');
        if (stage !== p.autoEnrollStage) {
          if (stage !== null) {
            const other = await R.stageHolder(t, p, stage);
            if (other) throw new AppError('AUTO_ENROLL_STAGE_TAKEN', { playbookId: other });
          }
          await R.setAutoEnrollStage(t, p.id, stage);
          await audit(t, actor, {
            action: 'settings.changed',
            entity: { type: 'playbook', id: p.id },
            changes: redactDiff({ auto_enroll_stage: p.autoEnrollStage }, { auto_enroll_stage: stage }, { entity: 'playbooks' }),
            reason: 'AUTO_ENROLL_STAGE',
          });
        }
        return { playbook: { id: p.id, name: p.name, scope: p.scope, autoEnrollStage: stage } };
      }),
  );
}

export const stageAutomationRoutes: RouteModule = { name: 'stage-automation', register };
