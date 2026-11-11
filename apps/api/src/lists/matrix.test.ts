// api/lists authorization: the route × role matrix checked against core.can() (R-PERM-1, R-PERM-5),
// the route table (every lists route declares and carries its authorization; no input accepts a
// tenant id: R-TEN-3), and response schemas without confidence* or tenant id fields (R-AST-13).
import { randomUUID } from 'node:crypto';
import { type Action, ROLES, type ResourceFacts, type Role, can } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { LISTS_RESPONSE_SCHEMAS } from './schemas.js';
import { call, listsWorld, type ListsWorld, makeTag, users } from './testing.js';

let h: ApiHarness;
let w: ListsWorld;
let U: ReturnType<typeof users>;
let fieldId: string;

beforeAll(async () => {
  h = await createApiHarness();
  w = await listsWorld(h, { perAgent: 1 });
  U = users(w);
  fieldId = (await call<{ field: { id: string } }>(w.owner, 'POST', '/custom-fields', { label: 'Matrix field', fieldType: 'text' })).body.field.id;
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const AUTH = new Set([401, 403, 404]);
const outcome = (r: { status: number; code: string | null }) => (AUTH.has(r.status) && r.code !== null && r.code !== 'TAG_PROTECTION_OWNER_ONLY' ? r.code : 'allowed');
function expected(role: Role, action: Action, facts: ResourceFacts): string {
  const c = U[role];
  const now = 2_000_000_000_000 as never;
  const r = can({ kind: 'user', userId: c.userId!, tenantId: c.tenantId!, role, sessionId: 'x' }, action, { ...facts, reauth: { reauthenticatedAt: now, now } });
  return r.ok ? 'allowed' : r.code;
}
/** each role's relation to agent A's contact (A owns it; the TL leads A's team) */
const OWNED: Record<Role, ResourceFacts> = { owner: {}, admin: {}, team_lead: { team: true }, agent: { own: true }, isa: {}, tc: {} };

describe('R-PERM-1 route × role matrix (lists routes)', () => {
  it('R-PERM-1 R-PAR-9: tag.create / tag.manage routes', async () => {
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const role of ROLES) {
      const c = U[role];
      got[`${role} POST /tags`] = outcome(await call(c, 'POST', '/tags', { name: `M ${role} ${randomUUID().slice(0, 6)}` }));
      want[`${role} POST /tags`] = expected(role, 'tag.create', {});
      const t = await makeTag(w.owner, `Managed ${role} ${randomUUID().slice(0, 6)}`);
      got[`${role} PATCH /tags/:id`] = outcome(await call(c, 'PATCH', `/tags/${t.id}`, { color: 'blue' }));
      got[`${role} POST /tags/:id/protect`] = outcome(await call(c, 'POST', `/tags/${t.id}/protect`, { protected: true }));
      const into = await makeTag(w.owner, `Into ${role} ${randomUUID().slice(0, 6)}`);
      got[`${role} POST /tags/:id/merge`] = outcome(await call(c, 'POST', `/tags/${t.id}/merge`, { intoTagId: into.id }));
      got[`${role} DELETE /tags/:id`] = outcome(await call(c, 'DELETE', `/tags/${into.id}`));
      for (const k of ['PATCH /tags/:id', 'POST /tags/:id/protect', 'POST /tags/:id/merge', 'DELETE /tags/:id']) want[`${role} ${k}`] = expected(role, 'tag.manage', {});
    }
    expect(got).toEqual(want);
  });

  it('R-PERM-1 R-PAR-7 R-PAR-19: contact.view_detail / contact.edit on a person (tags and values)', async () => {
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    const tag = await makeTag(w.owner, 'Matrix tag');
    const id = w.aContacts[0]!;
    for (const role of ROLES) {
      const c = U[role];
      got[`${role} GET tags`] = outcome(await call(c, 'GET', `/contacts/${id}/tags`));
      got[`${role} GET fields`] = outcome(await call(c, 'GET', `/contacts/${id}/fields`));
      want[`${role} GET tags`] = want[`${role} GET fields`] = expected(role, 'contact.view_detail', OWNED[role]);
      got[`${role} POST tags`] = outcome(await call(c, 'POST', `/contacts/${id}/tags`, { tagIds: [tag.id] }));
      got[`${role} DELETE tag`] = outcome(await call(c, 'DELETE', `/contacts/${id}/tags/${tag.id}`));
      got[`${role} PUT field`] = outcome(await call(c, 'PUT', `/contacts/${id}/fields/${fieldId}`, { value: role }));
      want[`${role} POST tags`] = want[`${role} DELETE tag`] = want[`${role} PUT field`] = expected(role, 'contact.edit', OWNED[role]);
    }
    expect(got).toEqual(want);
  });

  it('R-PERM-1 R-PAR-17 R-PAR-27: custom_field.manage and smart_list.* routes', async () => {
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const role of ROLES) {
      const c = U[role];
      got[`${role} POST /custom-fields`] = outcome(await call(c, 'POST', '/custom-fields', { label: `F ${role}`, fieldType: 'number' }));
      want[`${role} POST /custom-fields`] = expected(role, 'custom_field.manage', {});
      got[`${role} POST personal list`] = outcome(await call(c, 'POST', '/smart-lists', { scope: 'personal', name: 'p', definition: { v: 1 } }));
      want[`${role} POST personal list`] = expected(role, 'smart_list.personal', {});
      got[`${role} POST team list`] = outcome(await call(c, 'POST', '/smart-lists', { scope: 'team', name: `t ${role}`, definition: { v: 1 } }));
      want[`${role} POST team list`] = expected(role, 'smart_list.team_manage', {});
      got[`${role} GET /people`] = outcome(await call(c, 'GET', '/people'));
      got[`${role} POST /people/count`] = outcome(await call(c, 'POST', '/people/count', { definition: { v: 1 } }));
      want[`${role} GET /people`] = want[`${role} POST /people/count`] = expected(role, 'smart_list.personal', {});
      got[`${role} GET /tags`] = outcome(await call(c, 'GET', '/tags'));
      got[`${role} GET /custom-fields`] = outcome(await call(c, 'GET', '/custom-fields'));
      got[`${role} GET /smart-lists`] = outcome(await call(c, 'GET', '/smart-lists'));
      want[`${role} GET /tags`] = want[`${role} GET /custom-fields`] = want[`${role} GET /smart-lists`] = 'allowed';
    }
    expect(got).toEqual(want);
  });

  it('R-PERM-1: every lists route declares its authorization, and an Action route carries authorize(<that action>)', () => {
    const rows = h.app.platform.routeTable.filter((r) => r.method !== 'HEAD' && /^\/api\/(tags|custom-fields|smart-lists|people)|^\/api\/contacts\/:id\/(tags|fields)/.test(r.url));
    expect(rows.length).toBe(23);
    for (const r of rows) {
      expect(r.auth, `${r.method} ${r.url}`).toBeDefined();
      if (r.auth !== 'self') expect(r.authorizes, `${r.method} ${r.url}`).toBe(r.auth);
      expect(r.inputKeys.filter((k) => /tenant/i.test(k)), `${r.method} ${r.url}`).toEqual([]);
    }
  });

  it('R-TEN-3: no lists input accepts a tenant id (strict bodies refuse it)', async () => {
    const r = await call(w.agentA, 'POST', '/tags', { name: 'x', tenantId: randomUUID() });
    expect([r.status, r.code]).toEqual([422, 'VALIDATION_FAILED']);
    expect((await call(w.agentA, 'POST', '/people/query', { definition: { v: 1 }, tenant_id: randomUUID() })).code).toBe('VALIDATION_FAILED');
    expect((await call(w.agentA, 'GET', `/people?tenantId=${randomUUID()}`)).code).toBe('VALIDATION_FAILED');
  });

  it('R-AST-13 R-TEN-3: lists response schemas have no confidence* fields and no tenant id fields (snapshot)', () => {
    const shapes: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(LISTS_RESPONSE_SCHEMAS)) {
      const json = z.toJSONSchema(schema);
      const text = JSON.stringify(json);
      expect(text).not.toMatch(/confidence/i);
      expect(text).not.toMatch(/"tenant_id"|"tenantId"/);
      shapes[name] = json;
    }
    expect(shapes).toMatchSnapshot();
  });
});
