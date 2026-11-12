// api/gbp routes, mounted under /api (module 53; PHASE2_3_PLAN §5.4 #53).
//
//   GET  /gbp/status    why Google Business Profile is off, or when each location was last read    gbp.view
//
// Every handler runs in the caller's tenant transaction under FORCE RLS. Responses carry no tenant id, no confidence,
// and nothing about the reviewer beyond what Google shows publicly (never a contact).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { adminTx, platformOf } from '../admin/common.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import * as R from './repos/gbp.js';
import * as S from './schemas.js';
import { gbpStatus } from './status.js';

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const view = { config: { auth: 'gbp.view' as const }, preHandler: authorize('gbp.view', () => ({})) };

  r.get('/gbp/status', { ...view, schema: { response: { 200: S.StatusResponse } } }, async (req) => ({
    status: await adminTx(req, async (tx) => {
      const pack = await R.packState(tx);
      const zone = (await sql<{ z: string }>`SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]?.z ?? 'UTC';
      // R-GBP-3: while uncleared, no location state is read or shown
      return gbpStatus(pack, platformOf(req).providers.gbp, pack.cleared ? await R.locations(tx) : [], zone);
    }),
  }));
}

export const gbpRoutes: RouteModule = { name: 'gbp', register };
