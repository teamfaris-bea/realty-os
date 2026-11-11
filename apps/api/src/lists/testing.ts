// Test helpers for the api/lists integration tests (imported by *.test.ts only). Everything the
// application does goes through the real server as app_user; the superuser pool only reads back.
import { randomUUID } from 'node:crypto';
import type { Role } from '@realty/core/foundation';
import { type ApiHarness, type TestClient } from '../auth/testHarness.js';
import { call, freshReauth, intake, leadsWorld, randomPhone } from '../leads/testing.js';

export { call, freshReauth, randomPhone };

export interface ListsWorld {
  h: ApiHarness;
  tenantId: string;
  owner: TestClient;
  admin: TestClient;
  lead: TestClient;
  agentA: TestClient;
  agentB: TestClient;
  isa: TestClient;
  tc: TestClient;
  /** contacts owned by agent A / agent B (team members of `lead`) */
  aContacts: string[];
  bContacts: string[];
  /** a contact waiting in the default pond (a pond card for agents) */
  pondContact: string;
}

export const users = (w: ListsWorld): Record<Role, TestClient> => ({ owner: w.owner, admin: w.admin, team_lead: w.lead, agent: w.agentA, isa: w.isa, tc: w.tc });

export async function createContact(c: TestClient, name: string): Promise<string> {
  const r = await call<{ contact: { id: string } }>(c, 'POST', '/contacts', { commandId: randomUUID(), displayName: name, phones: [randomPhone()] });
  if (r.status !== 201) throw new Error(`create contact: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.contact.id;
}

/** A tenant with Owner, Admin, a Team Lead leading agents A and B, an ISA and a TC; A and B own contacts; one pond lead. */
export async function listsWorld(h: ApiHarness, o: { perAgent?: number } = {}): Promise<ListsWorld> {
  const w = await leadsWorld(h, { agents: 2, rule: false, teamLead: true, others: ['admin', 'isa', 'tc'], push: false });
  const [admin, isa, tc] = w.others as [TestClient, TestClient, TestClient];
  const [agentA, agentB] = w.agents as [TestClient, TestClient];
  await freshReauth(h, admin);
  const aContacts: string[] = [];
  const bContacts: string[] = [];
  for (let i = 0; i < (o.perAgent ?? 3); i++) aContacts.push(await createContact(agentA, `Alice Able ${i}`));
  for (let i = 0; i < (o.perAgent ?? 3); i++) bContacts.push(await createContact(agentB, `Bob Baker ${i}`));
  const pond = await intake(h, w, { fullName: 'Pat Pond' });
  return { h, tenantId: w.tenantId, owner: w.owner, admin, lead: w.teamLead!, agentA, agentB, isa, tc, aContacts, bContacts, pondContact: pond.contactId };
}

export async function makeTag(c: TestClient, name: string): Promise<{ id: string; name: string; protected: boolean }> {
  const r = await call<{ tag: { id: string; name: string; protected: boolean } }>(c, 'POST', '/tags', { name });
  if (r.status !== 201 && r.status !== 200) throw new Error(`tag: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.tag;
}

export async function tagContact(c: TestClient, contactId: string, tagIds: string[]) {
  return call<{ tags: { id: string; name: string }[]; added: string[]; optOutLike: string[] }>(c, 'POST', `/contacts/${contactId}/tags`, { tagIds });
}

export async function run(c: TestClient, definition: unknown, o: { sort?: string; cursor?: string } = {}) {
  return call<{ people: { id: string; displayName: string; tags: { id: string }[] }[]; nextCursor: string | null; scope: string; audienceProtected: boolean }>(c, 'POST', '/people/query', { definition, ...o });
}

export async function runAll(c: TestClient, definition: unknown, sort?: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const r = await run(c, definition, { ...(sort ? { sort } : {}), ...(cursor ? { cursor } : {}) });
    if (r.status !== 200) throw new Error(`run: ${r.status} ${JSON.stringify(r.body)}`);
    out.push(...r.body.people.map((p) => p.id));
    if (!r.body.nextCursor) return out;
    cursor = r.body.nextCursor;
  }
  throw new Error('too many pages');
}

export async function auditRows(h: ApiHarness, tenantId: string, action: string) {
  return (await h.su.query<{ action: string; entity_id: string; changes: Record<string, unknown>; actor_role: string }>('SELECT action, entity_id, changes, actor_role FROM audit_log WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at', [tenantId, action])).rows;
}
