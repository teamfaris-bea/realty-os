// api/leads authorization: the route × role matrix (R-PERM-1, R-PERM-5) checked against core.can()
// for every leads route; the route table (every route declares and carries its authorization, no
// route input accepts a tenant id: R-TEN-3); response schemas without confidence* or tenant id
// fields (R-AST-13, R-TEN-3).
import { randomUUID } from 'node:crypto';
import { type Action, ROLES, type ResourceFacts, type Role, can } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { LEADS_RESPONSE_SCHEMAS } from './schemas.js';
import { call, command, contactState, freshReauth, intake, leadsWorld, randomPhone, registerPush } from './testing.js';

let h: ApiHarness;
const users = {} as Record<Role, TestClient>;
let other: TestClient; // a second agent in the TL's team (reassign target)
let ownedId: string; // owned by users.agent
let pondLeadId: string;
let pondId: string;

beforeAll(async () => {
  h = await createApiHarness();
  const w = await leadsWorld(h, { agents: 2, rule: false, teamLead: true, others: ['admin', 'isa', 'tc'] });
  users.owner = w.owner;
  users.agent = w.agents[0]!;
  other = w.agents[1]!;
  users.team_lead = w.teamLead!;
  [users.admin, users.isa, users.tc] = w.others as [TestClient, TestClient, TestClient];
  await registerPush(users.isa);
  const c = await call<{ contact: { id: string } }>(users.agent, 'POST', '/contacts', { commandId: randomUUID(), displayName: 'Matrix Owned', phones: [randomPhone()] });
  ownedId = c.body.contact.id;
  pondLeadId = (await intake(h, w)).contactId;
  pondId = w.defaultPondId;
  expect((await contactState(h, pondLeadId)).ownership_state).toBe('in_pond');
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const AUTH_DENIALS = new Set([401, 403, 404]);

function expected(role: Role, action: Action, facts: ResourceFacts): string {
  const c = users[role];
  const now = 2_000_000_000_000 as never;
  const r = can({ kind: 'user', userId: c.userId!, tenantId: c.tenantId!, role, sessionId: 'x' }, action, { ...facts, reauth: { reauthenticatedAt: now, now } });
  return r.ok ? 'allowed' : r.code;
}

/** 'allowed' when the request passed authorization (any non-auth outcome, e.g. a stale-seq 409), else the code. */
function outcome(r: { status: number; code: string | null }): string {
  return AUTH_DENIALS.has(r.status) && r.code !== null ? r.code : 'allowed';
}

/** The relation each role has to the agent-owned contact (agent owns it; the TL leads the agent's team). */
const OWNED_FACTS: Record<Role, ResourceFacts> = { owner: {}, admin: {}, team_lead: { team: true }, agent: { own: true }, isa: {}, tc: {} };
/** Pond card relation: the default pond is open to agents, TLs and ISAs (TLs see every pond). */
const POND_FACTS: Record<Role, ResourceFacts> = { owner: { pond: true }, admin: { pond: true }, team_lead: { pond: true }, agent: { pond: true }, isa: { pond: true }, tc: {} };

describe('R-PERM-1 route × role matrix (leads routes)', () => {
  it('R-PERM-1 R-PERM-4 R-PERM-5: contact.view / contact.view_detail / contact.create rows', async () => {
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const role of ROLES) {
      const c = users[role];
      got[`${role} view`] = outcome(await call(c, 'GET', `/contacts/${ownedId}`));
      want[`${role} view`] = expected(role, 'contact.view', OWNED_FACTS[role]);
      got[`${role} timeline`] = outcome(await call(c, 'GET', `/contacts/${ownedId}/timeline`));
      want[`${role} timeline`] = expected(role, 'contact.view_detail', OWNED_FACTS[role]);
      got[`${role} create`] = outcome(await call(c, 'POST', '/contacts', { commandId: randomUUID(), displayName: `By ${role}` }));
      want[`${role} create`] = expected(role, 'contact.create', {});
      got[`${role} pond cards`] = outcome(await call(c, 'GET', `/ponds/${pondId}/cards`));
      want[`${role} pond cards`] = expected(role, 'contact.view', POND_FACTS[role]);
    }
    expect(got).toEqual(want);
    expect(want).toMatchObject({ 'agent view': 'allowed', 'isa view': 'NOT_FOUND', 'tc create': 'NOT_FOUND', 'tc pond cards': 'NOT_FOUND' });
  });

  it('R-PERM-1 R-PERM-15: lead.claim / lead.release / lead.reassign rows (a stale expectedSeq makes an authorized command a harmless 409)', async () => {
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const role of ROLES) {
      const c = users[role];
      got[`${role} claim`] = outcome(await command(c, pondLeadId, 'claim', { expectedSeq: 999 }));
      want[`${role} claim`] = expected(role, 'lead.claim', POND_FACTS[role]);
      got[`${role} release`] = outcome(await command(c, ownedId, 'release', { reason: 'not_a_fit', expectedSeq: 999 }));
      want[`${role} release`] = expected(role, 'lead.release', OWNED_FACTS[role]);
      got[`${role} reassign`] = outcome(await command(c, ownedId, 'reassign', { toUserId: other.userId, expectedSeq: 999 }));
      want[`${role} reassign`] = expected(role, 'lead.reassign', { ...OWNED_FACTS[role], target: { role: 'agent', inMyTeam: role === 'team_lead' } });
    }
    expect(got).toEqual(want);
    expect(want).toMatchObject({ 'owner claim': 'NOT_FOUND', 'agent claim': 'allowed', 'tc claim': 'NOT_FOUND', 'agent release': 'allowed', 'team_lead reassign': 'allowed', 'agent reassign': 'NOT_FOUND' });
    // nothing moved
    expect((await contactState(h, ownedId)).owner_user_id).toBe(users.agent.userId);
  });

  it('R-PERM-1 R-PERM-13: member.remove (deactivation) and settings.routing (lead sources) rows', async () => {
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const role of ROLES) {
      const c = users[role];
      await freshReauth(h, c);
      got[`${role} deactivate`] = outcome(await call(c, 'POST', `/members/${other.userId}/deactivate`, { mode: 'preview' }));
      want[`${role} deactivate`] = expected(role, 'member.remove', { target: { role: 'agent' } });
      got[`${role} sources`] = outcome(await call(c, 'GET', '/lead-sources'));
      want[`${role} sources`] = expected(role, 'settings.routing', {});
    }
    expect(got).toEqual(want);
    expect(want).toMatchObject({ 'owner deactivate': 'allowed', 'admin deactivate': 'allowed', 'team_lead deactivate': 'NOT_FOUND' });
  });
});

describe('route table and schemas', () => {
  // leads' own routes only: /contacts/:id/{messages,calls,consent,automation} are api/comms', /contacts/:id/{drafts,enrollments,saved-searches} api/assistant's
  // FUB parity: /contacts/:id/{details,stage,points,addresses,collaborators,relationships,notes,mention-candidates,activities,do-not-contact} are api/people's
  const leadsUrls = /^\/api\/(intake|lead-sources|contacts(?!\/:id\/(messages|automation|calls|consent|drafts|enrollments|saved-searches|erasure|erase|deals|details|stage|points|addresses|collaborators|relationships|notes|mention-candidates|activities|do-not-contact))|leads|ponds\/:id\/cards|members\/:userId\/deactivate)/;

  it('every leads route declares its authorization and carries authorize(<that action>) (snapshot); intake is a signed webhook', () => {
    const rows = h.app.platform.routeTable.filter((r) => leadsUrls.test(r.url) && !(r.method === 'PATCH' && r.url === '/api/contacts/:id'));
    for (const r of rows) {
      if (r.auth === 'webhook') expect(r.url).toBe('/api/intake/:sourceToken');
      else expect(r.authorizes).toBe(r.auth);
    }
    expect(rows.map((r) => `${r.method} ${r.url} → ${r.auth}`)).toMatchSnapshot();
  });

  it('R-TEN-3 E51: no leads route input accepts a tenant id; strict bodies refuse an extra tenant_id', async () => {
    for (const r of h.app.platform.routeTable.filter((x) => leadsUrls.test(x.url))) {
      for (const k of r.inputKeys) expect(k.toLowerCase().replace(/[^a-z]/g, '')).not.toMatch(/tenantid|^tenant$/);
    }
    const r = await call(users.agent, 'POST', '/contacts', { commandId: randomUUID(), displayName: 'x', tenant_id: randomUUID() });
    expect([r.status, r.code]).toEqual([422, 'VALIDATION_FAILED']);
    const c = await command(users.agent, ownedId, 'release', { reason: 'not_a_fit', tenantId: randomUUID() });
    expect([c.status, c.code]).toEqual([422, 'VALIDATION_FAILED']);
  });

  it('R-AST-13 R-TEN-3: leads response schemas have no confidence* fields and no tenant id fields (snapshot)', () => {
    const shapes: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(LEADS_RESPONSE_SCHEMAS)) {
      const json = z.toJSONSchema(schema);
      const text = JSON.stringify(json);
      expect(text).not.toMatch(/confidence/i);
      expect(text).not.toMatch(/"tenant_id"|"tenantId"/);
      shapes[name] = json;
    }
    expect(shapes).toMatchSnapshot();
  });
});
