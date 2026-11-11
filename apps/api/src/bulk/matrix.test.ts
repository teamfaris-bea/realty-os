// Parity module 63: route × role matrix for the templates and bulk routes, checked against core can()
// (DATA_MODEL §12; R-PERM-1, R-PERM-5: every denial is 404, re-auth 401).
import { randomUUID } from 'node:crypto';
import { type Action, ROLES, type ResourceFacts, type Role, can } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { call, freshReauth, leadsWorld, randomPhone } from '../leads/testing.js';
import { BATCH_TEXT_ATTESTATION } from './batchText.js';

let h: ApiHarness;
const users = {} as Record<Role, TestClient>;
let tagId: string;
const contactOf = {} as Record<Role, string>;

beforeAll(async () => {
  h = await createApiHarness();
  const w = await leadsWorld(h, { agents: 1, rule: false, teamLead: true, others: ['admin', 'isa', 'tc'] });
  users.owner = w.owner;
  users.agent = w.agents[0]!;
  users.team_lead = w.teamLead!;
  [users.admin, users.isa, users.tc] = w.others as [TestClient, TestClient, TestClient];
  tagId = randomUUID();
  await withTenantTx(users.owner.actor(), (tx) => sql`INSERT INTO tags (tenant_id, id, name, created_by_kind, created_by_user_id) VALUES (app.tenant_id(), ${tagId}, 'Matrix', 'user', app.user_id())`.execute(tx), { db: h.database });
  for (const role of ROLES) {
    const by = role === 'tc' ? users.agent : users[role];
    const r = await call<{ contact: { id: string } }>(by, 'POST', '/contacts', { commandId: randomUUID(), displayName: `Matrix ${role}`, phones: [randomPhone()] });
    contactOf[role] = r.body.contact.id;
  }
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const AUTH_DENIALS = new Set([401, 403, 404]);
function expected(role: Role, action: Action, facts: ResourceFacts, reauth = true): string {
  const c = users[role];
  const now = 2_000_000_000_000 as never;
  const r = can({ kind: 'user', userId: c.userId!, tenantId: c.tenantId!, role, sessionId: 'x' }, action, { ...facts, ...(reauth ? { reauth: { reauthenticatedAt: now, now } } : {}) });
  return r.ok ? 'allowed' : r.code;
}
function outcome(r: { status: number; body: unknown }): string {
  const code = (r.body as { error?: { code?: string } }).error?.code ?? null;
  return AUTH_DENIALS.has(r.status) && code !== null ? code : 'allowed';
}

describe('R-PERM-1 R-PAR-23 R-PAR-33 route × role matrix (templates, bulk, batch-text switch)', () => {
  for (const role of ROLES) {
    it(`R-PAR-23 R-PAR-33 ${role}`, async () => {
      const u = users[role];
      await freshReauth(h, u);
      const got: Record<string, string> = {};
      const want: Record<string, string> = {};
      got['GET /templates'] = outcome(await call(u, 'GET', '/templates'));
      want['GET /templates'] = expected(role, 'template.personal', {});
      got['POST /templates personal'] = outcome(await call(u, 'POST', '/templates', { scope: 'personal', channel: 'sms', name: `P ${randomUUID().slice(0, 5)}`, body: 'Hi' }));
      want['POST /templates personal'] = expected(role, 'template.personal', {});
      got['POST /templates team'] = outcome(await call(u, 'POST', '/templates', { scope: 'team', channel: 'sms', name: `T ${randomUUID().slice(0, 5)}`, body: 'Hi' }));
      want['POST /templates team'] = expected(role, 'template.team_manage', {});
      got['POST /bulk-actions tag'] = outcome(await call(u, 'POST', '/bulk-actions', { kind: 'tag', selection: { contactIds: [contactOf[role]] }, tagId, idempotencyKey: `m-${randomUUID()}` }));
      want['POST /bulk-actions tag'] = expected(role, 'bulk.run', { own: true });
      got['GET /bulk-actions'] = outcome(await call(u, 'GET', '/bulk-actions'));
      want['GET /bulk-actions'] = expected(role, 'bulk.run', { own: true });
      got['GET /settings/batch-text'] = outcome(await call(u, 'GET', '/batch-text'));
      want['GET /settings/batch-text'] = expected(role, 'settings.batch_text', { loosening: false });
      got['PUT /settings/batch-text off'] = outcome(await call(u, 'PUT', '/batch-text', { enabled: false }));
      want['PUT /settings/batch-text off'] = expected(role, 'settings.batch_text', { loosening: false });
      got['PUT /settings/batch-text on'] = outcome(await call(u, 'PUT', '/batch-text', { enabled: true, attestation: BATCH_TEXT_ATTESTATION }));
      want['PUT /settings/batch-text on'] = expected(role, 'settings.batch_text', { loosening: true, attested: true });
      if (got['PUT /settings/batch-text on'] === 'allowed') await call(u, 'PUT', '/batch-text', { enabled: false });
      expect(got).toEqual(want);
    });
  }
});
