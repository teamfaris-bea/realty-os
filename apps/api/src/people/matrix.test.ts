// api/people authorization: the route × role matrix (R-PERM-1, R-PERM-5) checked against core.can() for
// every api/people route on an agent-owned contact; the route table (every route declares and carries its
// authorization; no input accepts a tenant id: R-TEN-3); response schemas without confidence* or tenant id
// fields (R-AST-13, R-TEN-3). Support sessions are read-only at the database (support_read_only trigger on
// every table, R-PERM-11); api/people adds no support route.
import { randomUUID } from 'node:crypto';
import { type Action, ROLES, type ResourceFacts, type Role, can } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { call, leadsWorld, randomPhone } from '../leads/testing.js';
import { PEOPLE_RESPONSE_SCHEMAS } from './schemas.js';

let h: ApiHarness;
const users = {} as Record<Role, TestClient>;

beforeAll(async () => {
  h = await createApiHarness();
  const w = await leadsWorld(h, { agents: 1, rule: false, teamLead: true, others: ['admin', 'isa', 'tc'] });
  users.owner = w.owner;
  users.agent = w.agents[0]!;
  users.team_lead = w.teamLead!;
  [users.admin, users.isa, users.tc] = w.others as [TestClient, TestClient, TestClient];
}, 180_000);
afterAll(async () => {
  await h?.close();
});

/** The relation each role has to the agent-owned contact (agent owns it; the TL leads the agent's team). */
const FACTS: Record<Role, ResourceFacts> = { owner: {}, admin: {}, team_lead: { team: true }, agent: { own: true }, isa: {}, tc: {} };
const AUTH_DENIALS = new Set([401, 403, 404]);

function expected(role: Role, action: Action, facts: ResourceFacts): string {
  const c = users[role];
  const r = can({ kind: 'user', userId: c.userId!, tenantId: c.tenantId!, role, sessionId: 'x' }, action, facts);
  return r.ok ? 'allowed' : r.code;
}
function outcome(r: { status: number; code: string | null }): string {
  return AUTH_DENIALS.has(r.status) && r.code !== null && r.code !== 'NOTE_AUTHOR_ONLY' ? r.code : 'allowed';
}

async function fresh(): Promise<{ id: string; noteId: string; pointId: string }> {
  const c = await call<{ contact: { id: string } }>(users.agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Mat', lastName: 'Rix', phones: [randomPhone()] });
  const id = c.body.contact.id;
  const n = await call<{ note: { id: string } }>(users.agent, 'POST', `/contacts/${id}/notes`, { body: 'agent note' });
  const p = await call<{ points: { id: string }[] }>(users.agent, 'GET', `/contacts/${id}/points`);
  return { id, noteId: n.body.note.id, pointId: p.body.points[0]!.id };
}

type Probe = { name: string; action: Action; facts?: (role: Role) => ResourceFacts; run: (c: TestClient, t: { id: string; noteId: string; pointId: string }) => Promise<{ status: number; code: string | null }> };

const PROBES: Probe[] = [
  { name: 'GET details', action: 'contact.view_detail', run: (c, t) => call(c, 'GET', `/contacts/${t.id}/details`) },
  { name: 'PATCH contact', action: 'contact.edit', run: (c, t) => call(c, 'PATCH', `/contacts/${t.id}`, { rowVersion: 999, firstName: 'X' }) },
  { name: 'POST stage', action: 'contact.edit', run: (c, t) => call(c, 'POST', `/contacts/${t.id}/stage`, { stage: 'nurture' }) },
  { name: 'POST point', action: 'contact.edit', run: (c, t) => call(c, 'POST', `/contacts/${t.id}/points`, { kind: 'phone', address: randomPhone() }) },
  { name: 'PATCH point label', action: 'contact.edit', run: (c, t) => call(c, 'PATCH', `/contacts/${t.id}/points/${t.pointId}`, { label: 'work' }) },
  { name: 'POST address', action: 'contact.edit', run: (c, t) => call(c, 'POST', `/contacts/${t.id}/addresses`, { kind: 'home', city: 'Reno' }) },
  {
    name: 'DELETE address',
    action: 'contact.edit',
    run: async (c, t) => {
      const a = await call<{ address: { id: string } }>(users.agent, 'POST', `/contacts/${t.id}/addresses`, { kind: 'home', city: 'Reno' });
      return call(c, 'DELETE', `/contacts/${t.id}/addresses/${a.body.address.id}`);
    },
  },
  {
    // the Undo is the remover's own (the token is sealed to them): each role restores what it deleted, and a role that
    // may not delete tries the owning agent's token, which contact.edit refuses before the token is read
    name: 'POST address restore',
    action: 'contact.edit',
    run: async (c, t) => {
      const a = await call<{ address: { id: string } }>(users.agent, 'POST', `/contacts/${t.id}/addresses`, { kind: 'home', city: 'Reno' });
      const own = await call<{ restoreToken?: string }>(c, 'DELETE', `/contacts/${t.id}/addresses/${a.body.address.id}`);
      const token = own.body.restoreToken ?? (await call<{ restoreToken: string }>(users.agent, 'DELETE', `/contacts/${t.id}/addresses/${a.body.address.id}`)).body.restoreToken;
      return call(c, 'POST', `/contacts/${t.id}/addresses/${a.body.address.id}/restore`, { restoreToken: token });
    },
  },
  { name: 'GET relationships', action: 'contact.view_detail', run: (c, t) => call(c, 'GET', `/contacts/${t.id}/relationships`) },
  { name: 'GET collaborators', action: 'contact.view_detail', run: (c, t) => call(c, 'GET', `/contacts/${t.id}/collaborators`) },
  { name: 'POST collaborator', action: 'collaborator.manage', run: (c, t) => call(c, 'POST', `/contacts/${t.id}/collaborators`, { userId: users.tc.userId }) },
  { name: 'GET notes', action: 'contact.view_detail', run: (c, t) => call(c, 'GET', `/contacts/${t.id}/notes`) },
  { name: 'POST note', action: 'note.write', run: (c, t) => call(c, 'POST', `/contacts/${t.id}/notes`, { body: 'hi' }) },
  { name: 'GET mention candidates', action: 'note.write', run: (c, t) => call(c, 'GET', `/contacts/${t.id}/mention-candidates`) },
  { name: 'PATCH note (others: author-only after authz)', action: 'note.write', run: (c, t) => call(c, 'PATCH', `/notes/${t.noteId}`, { body: 'edit' }) },
  { name: 'DELETE note', action: 'note.delete', facts: (role) => (role === 'agent' ? { own: true } : {}), run: (c, t) => call(c, 'DELETE', `/notes/${t.noteId}`) },
  { name: 'POST activity', action: 'activity.log', run: (c, t) => call(c, 'POST', `/contacts/${t.id}/activities`, { kind: 'call', at: new Date().toISOString() }) },
  { name: 'POST do-not-contact', action: 'contact.edit', run: (c, t) => call(c, 'POST', `/contacts/${t.id}/do-not-contact`, {}) },
];

describe('R-PERM-1 route × role matrix (api/people routes)', () => {
  for (const p of PROBES) {
    it(`R-PERM-1 R-PERM-5 R-PAR-43 ${p.name} (${p.action}) answers exactly what core.can() decides for each role`, async () => {
      const got: Record<string, string> = {};
      const want: Record<string, string> = {};
      for (const role of ROLES) {
        const t = await fresh();
        want[role] = expected(role, p.action, p.facts ? p.facts(role) : FACTS[role]);
        got[role] = outcome(await p.run(users[role], t));
      }
      expect(got).toEqual(want);
    }, 120_000);
  }

  it('R-PAR-13 settings.stage_labels: Owner and Admin only', async () => {
    for (const role of ROLES) {
      const r = await call(users[role], 'PUT', '/stage-labels', { labels: {} });
      expect(outcome(r), role).toBe(expected(role, 'settings.stage_labels', {}));
    }
  });
});

describe('route table and schemas', () => {
  const peopleRoute = (r: { method: string; url: string }) =>
    /^\/api\/(contacts\/:id\/(details|stage|points|addresses|collaborators|relationships|notes|mention-candidates|activities|do-not-contact)|notes\/:id|stage-labels)/.test(r.url) || (r.method === 'PATCH' && r.url === '/api/contacts/:id');

  it('every api/people route declares its authorization and carries authorize(<that action>) (snapshot)', () => {
    const rows = h.app.platform.routeTable.filter(peopleRoute);
    for (const r of rows) if (r.auth !== 'self') expect(r.authorizes).toBe(r.auth);
    expect(rows.map((r) => `${r.method} ${r.url} → ${r.auth}`)).toMatchSnapshot();
  });

  it('R-TEN-3 E51: no api/people route input accepts a tenant id', () => {
    for (const r of h.app.platform.routeTable.filter(peopleRoute)) {
      for (const k of r.inputKeys) expect(k.toLowerCase().replace(/[^a-z]/g, '')).not.toMatch(/tenantid|^tenant$/);
    }
  });

  it('R-AST-13 R-TEN-3: api/people response schemas have no confidence* fields and no tenant id fields (snapshot)', () => {
    const shapes: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(PEOPLE_RESPONSE_SCHEMAS)) {
      const json = z.toJSONSchema(schema);
      const text = JSON.stringify(json);
      expect(text).not.toMatch(/confidence/i);
      expect(text).not.toMatch(/"tenant_id"|"tenantId"/);
      shapes[name] = json;
    }
    expect(shapes).toMatchSnapshot();
  });
});
