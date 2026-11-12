// api/nurture route module (PHASE2_3_PLAN §5.4 #26), mounted under /api by routes.ts:
//   GET /contacts/:id/trigger-runs   the contact's trigger firings: status, the fact (source, time), the visible
//                                    skip reason, the message or draft                       contact.view_detail
//   GET /nurture/triggers            which trigger kinds can fire in this release and the built-in trigger
//                                    templates; home values say in words when they wait for counsel review
//                                    (drafts only) or are not set up on this platform (no AVM vendor)  self
// Read-only. Trigger runs are read under the caller's RLS (policy step_runs_trigger: tenant-wide roles, or
// whoever sees the contact's detail); a contact the caller cannot see is 404 (R-PERM-5). Approving the
// built-in templates is the existing POST /playbooks + POST /playbook-versions/:id/approve.
import type { UserActor } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { BUILT_IN_TEMPLATES, TRIGGER_AVAILABILITY } from '../assistant/templates.js';
import { contactFacts } from '../comms/repos/contacts.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import * as R from './repos.js';
import * as S from './schemas.js';

const IdParams = z.object({ id: z.uuid() });

function actorOf(req: FastifyRequest): UserActor {
  if (!req.actor) throw new AppError('UNAUTHENTICATED');
  return req.actor;
}

const LABELS: Record<keyof typeof TRIGGER_AVAILABILITY, string> = {
  price_drop: 'A followed home drops in price',
  back_on_market: 'A followed home is back on the market',
  home_anniversary: 'Home anniversary (yearly)',
  home_value: 'Monthly home value estimate',
  deal_date_upcoming: 'A confirmed deal date coming up',
};

const obj = (x: unknown): Record<string, unknown> | null => (typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null);

/** Where a stored run's fact comes from, per kind (the same words execute.ts's sourceLabel uses for the claim). */
function factSource(ref: Record<string, unknown> | null): 'mls' | 'team' | 'deal' | 'home_valuation' | 'deal_date' | 'unknown' {
  switch (ref?.['kind']) {
    case 'price_drop':
    case 'back_on_market':
      return ref['source'] === 'mls' ? 'mls' : 'team';
    case 'home_anniversary':
      return 'deal';
    case 'home_value':
      return 'home_valuation';
    case 'deal_date_upcoming':
      return 'deal_date';
    default:
      return 'unknown';
  }
}

/**
 * A run's fact from its stored evidence. A citation whose source was purged (R-DATA-6: app.purge_home_valuations
 * strips the snippet and stores `sourceAvailable: false`, b11 review ownership-data/F3) says so, in the words the
 * evidence views use, and never quotes the estimate.
 */
function factOf(ev: Record<string, unknown> | null, ref: Record<string, unknown> | null, source: ReturnType<typeof factSource>, firedAt: unknown): { text: string; source: ReturnType<typeof factSource>; at: string } | null {
  if (!ev || typeof firedAt !== 'number') return null;
  const said = ev['sourceAvailable'] === false ? 'Source removed under retention policy' : typeof ev['snippet'] === 'string' ? (ev['snippet'] as string) : null;
  if (said === null) return null;
  return { text: `${String(ref?.['address'] ?? '')}: ${said}`.replace(/^: /, ''), source, at: new Date(firedAt).toISOString() };
}

/**
 * Home values (R-INT-1, R-INT-6) say in words what holds them back: no AVM vendor on this platform ("not set up on
 * this platform yet", nothing is requested), or platform:avm not yet counsel-reviewed (drafts only).
 */
async function triggerKinds(app: FastifyInstance, req: FastifyRequest): Promise<{ trigger: string; availability: 'available' | 'not_available_yet'; label: string; note: string | null }[]> {
  const vendor = app.platform.providers.integrations.avm.configured;
  const cleared = vendor ? await withTenantTx(actorOf(req), (tx) => R.platformCleared(tx, 'platform:avm'), { db: app.platform.db }) : false;
  return (Object.keys(TRIGGER_AVAILABILITY) as (keyof typeof TRIGGER_AVAILABILITY)[]).map((t) => {
    if (t !== 'home_value') return { trigger: t, availability: TRIGGER_AVAILABILITY[t], label: LABELS[t], note: null };
    if (!vendor) return { trigger: t, availability: 'not_available_yet', label: LABELS[t], note: 'Home values are not set up on this platform yet.' };
    return { trigger: t, availability: TRIGGER_AVAILABILITY[t], label: LABELS[t], note: cleared ? null : 'Home-value notes wait for counsel review: until then each one is a draft for you to check and send.' };
  });
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = () => app.platform.db;

  r.get('/nurture/triggers', { config: { auth: 'self' }, schema: { response: { 200: S.TriggerKindsResponse } } }, async (req) => ({
    triggers: await triggerKinds(app, req),
    templates: BUILT_IN_TEMPLATES.flatMap((t) => (t.content?.kind === 'triggers' ? [{ key: t.key, name: t.name, scope: t.scope, triggers: t.content.triggers.map((x) => x.trigger) }] : [])),
  }));

  r.get(
    '/contacts/:id/trigger-runs',
    {
      config: { auth: 'contact.view_detail' },
      preHandler: authorize('contact.view_detail', (req) => withTenantTx(actorOf(req), (tx) => contactFacts(tx, (req.params as { id: string }).id), { db: db() })),
      schema: { params: IdParams, response: { 200: S.TriggerRunsResponse } },
    },
    async (req) => {
      const runs = await withTenantTx(actorOf(req), (tx) => R.runsOfContact(tx, req.params.id, 100), { db: db() });
      return {
        runs: runs.map((x) => {
          const t = obj(x.triggerRef);
          const ev = Array.isArray(t?.['evidence']) ? obj((t!['evidence'] as unknown[])[0]) : null;
          const skip = obj(t?.['skip']);
          const ref = obj(t?.['ref']);
          const source = factSource(ref);
          return {
            id: x.id,
            playbookId: x.playbookId,
            playbookName: x.playbookName,
            trigger: typeof t?.['trigger'] === 'string' ? (t['trigger'] as string) : 'unknown',
            status: x.status,
            scheduledFor: new Date(x.scheduledFor).toISOString(),
            updatedAt: new Date(x.updatedAt).toISOString(),
            fact: factOf(ev, ref, source, t?.['firedAt']),
            skip: skip && typeof skip['reason'] === 'string' && typeof skip['text'] === 'string' ? { reason: skip['reason'] as string, text: skip['text'] as string } : null,
            messageId: x.messageId,
            assistantActionId: x.actionId,
          };
        }),
      };
    },
  );
}

export const nurtureRoutes: RouteModule = { name: 'nurture', register };
