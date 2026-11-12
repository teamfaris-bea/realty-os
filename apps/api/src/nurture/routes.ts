// api/nurture route module (PHASE2_3_PLAN §5.4 #26), mounted under /api by routes.ts:
//   GET /contacts/:id/trigger-runs   the contact's trigger firings: status, the fact (source, time), the visible
//                                    skip reason, the message or draft                       contact.view_detail
//   GET /nurture/triggers            which trigger kinds can fire in this release and the built-in trigger
//                                    templates (home values: "not available yet", wave 2C)       self
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
  home_value: 'Monthly home value (not available yet)',
  deal_date_upcoming: 'A confirmed deal date coming up (not available yet)',
};

const obj = (x: unknown): Record<string, unknown> | null => (typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null);

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = () => app.platform.db;

  r.get('/nurture/triggers', { config: { auth: 'self' }, schema: { response: { 200: S.TriggerKindsResponse } } }, async () => ({
    triggers: (Object.keys(TRIGGER_AVAILABILITY) as (keyof typeof TRIGGER_AVAILABILITY)[]).map((t) => ({ trigger: t, availability: TRIGGER_AVAILABILITY[t], label: LABELS[t] })),
    templates: BUILT_IN_TEMPLATES.filter((t) => t.content !== undefined).map((t) => ({ key: t.key, name: t.name, scope: t.scope, triggers: t.content!.triggers.map((x) => x.trigger) })),
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
          const source = ref?.['source'] === 'mls' ? 'mls' : ref?.['source'] === 'team' ? 'team' : 'deal';
          return {
            id: x.id,
            playbookId: x.playbookId,
            playbookName: x.playbookName,
            trigger: typeof t?.['trigger'] === 'string' ? (t['trigger'] as string) : 'unknown',
            status: x.status,
            scheduledFor: new Date(x.scheduledFor).toISOString(),
            updatedAt: new Date(x.updatedAt).toISOString(),
            fact: ev && typeof ev['snippet'] === 'string' && typeof t?.['firedAt'] === 'number' ? { text: `${String(ref?.['address'] ?? '')}: ${ev['snippet'] as string}`.replace(/^: /, ''), source, at: new Date(t['firedAt'] as number).toISOString() } : null,
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
