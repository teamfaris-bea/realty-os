// Security review sweep (not a product test): every mutating parity route, called by each non-tenant-wide
// role on resources it should not be able to write, never answers 2xx where core.can() denies, and never 500.
import { randomUUID } from 'node:crypto';
import { type Role } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from './auth/testHarness.js';
import { call, commsWorld, randomPhone } from './comms/testing.js';
import { freshReauth } from './admin/testing.js';

let h: ApiHarness;
const U = {} as Record<Role | 'agent2' | 'outsider', TestClient>;
let fieldId: string;
let annualFieldId: string;
let tagId: string;
let teamListId: string;

beforeAll(async () => {
  h = await createApiHarness();
  const w = await commsWorld(h, { agents: 2, teamLead: true, others: ['admin', 'isa', 'tc'] });
  U.owner = w.owner;
  [U.agent, U.agent2] = w.agents as [TestClient, TestClient];
  U.team_lead = w.teamLead!;
  [U.admin, U.isa, U.tc] = w.others as [TestClient, TestClient, TestClient];
  U.outsider = await h.invite(w.owner, 'agent'); // an agent NOT on the TL's team
  await freshReauth(h, w.owner);
  fieldId = (await call<{ field: { id: string } }>(w.owner, 'POST', '/custom-fields', { label: 'Sweep field', fieldType: 'text' })).body.field.id;
  annualFieldId = (await call<{ field: { id: string } }>(w.owner, 'POST', '/custom-fields', { label: 'Sweep date', fieldType: 'date', annual: true })).body.field.id;
  tagId = (await call<{ tag: { id: string } }>(w.owner, 'POST', '/tags', { name: `Sweep ${randomUUID().slice(0, 6)}` })).body.tag.id;
  teamListId = (await call<{ list: { id: string } }>(w.owner, 'POST', '/smart-lists', { scope: 'team', name: 'Team list', definition: { v: 1 } })).body.list.id;
}, 300_000);
afterAll(async () => {
  await h?.close();
});

interface Fx {
  contactId: string;
  otherContactId: string;
  pointId: string;
  addressId: string;
  relationshipId: string;
  noteId: string;
  listId: string;
  templateId: string;
}

/** Resources owned by `by` (contact, its point/address/relationship/note, a personal list and template). */
async function fixture(by: TestClient): Promise<Fx> {
  const mk = async (first: string) => (await call<{ contact: { id: string } }>(by, 'POST', '/contacts', { commandId: randomUUID(), firstName: first, lastName: 'Sweep', phones: [randomPhone()] })).body.contact.id;
  const contactId = await mk('Sue');
  const otherContactId = await mk('Sam');
  const pts = await call<{ points: { id: string }[] }>(by, 'GET', `/contacts/${contactId}/points`);
  const addr = await call<{ address: { id: string } }>(by, 'POST', `/contacts/${contactId}/addresses`, { kind: 'home', city: 'Reno' });
  const rel = await call<{ relationship: { id: string } }>(by, 'POST', `/contacts/${contactId}/relationships`, { relatedContactId: otherContactId, kind: 'family' });
  const note = await call<{ note: { id: string } }>(by, 'POST', `/contacts/${contactId}/notes`, { body: 'owner note' });
  await call(by, 'POST', `/contacts/${contactId}/tags`, { tagIds: [tagId] });
  await call(by, 'PUT', `/contacts/${contactId}/fields/${fieldId}`, { value: 'v1' });
  const list = await call<{ list: { id: string } }>(by, 'POST', '/smart-lists', { scope: 'personal', name: `Mine ${randomUUID().slice(0, 6)}`, definition: { v: 1 } });
  const tpl = await call<{ template: { id: string } }>(by, 'POST', '/templates', { scope: 'personal', channel: 'sms', name: `Mine ${randomUUID().slice(0, 6)}`, body: 'Hi there' });
  if (!tpl.body.template) console.log('TPL', tpl.status, JSON.stringify(tpl.body));
  return { contactId, otherContactId, pointId: pts.body.points[0]!.id, addressId: addr.body.address?.id, relationshipId: rel.body.relationship?.id, noteId: note.body.note?.id, listId: list.body.list?.id, templateId: tpl.body.template?.id };
}

type Probe = { name: string; run: (c: TestClient, f: Fx) => Promise<{ status: number; code: string | null; body: unknown }> };
const PROBES: Probe[] = [
  { name: 'PATCH /contacts/:id', run: (c, f) => call(c, 'PATCH', `/contacts/${f.contactId}`, { firstName: 'X' }) },
  { name: 'POST /contacts/:id/stage', run: (c, f) => call(c, 'POST', `/contacts/${f.contactId}/stage`, { stage: 'nurture' }) },
  { name: 'POST /contacts/:id/do-not-contact', run: (c, f) => call(c, 'POST', `/contacts/${f.contactId}/do-not-contact`, {}) },
  { name: 'POST /contacts/:id/points', run: (c, f) => call(c, 'POST', `/contacts/${f.contactId}/points`, { kind: 'phone', address: randomPhone() }) },
  { name: 'POST point replace', run: (c, f) => call(c, 'POST', `/contacts/${f.contactId}/points/${f.pointId}/replace`, { address: randomPhone() }) },
  { name: 'POST point remove', run: (c, f) => call(c, 'POST', `/contacts/${f.contactId}/points/${f.pointId}/remove`, { reason: 'old' }) },
  { name: 'POST point primary', run: (c, f) => call(c, 'POST', `/contacts/${f.contactId}/points/${f.pointId}/primary`, {}) },
  { name: 'PATCH point label', run: (c, f) => call(c, 'PATCH', `/contacts/${f.contactId}/points/${f.pointId}`, { label: 'work' }) },
  { name: 'POST address', run: (c, f) => call(c, 'POST', `/contacts/${f.contactId}/addresses`, { kind: 'home', city: 'Elko' }) },
  { name: 'PATCH address', run: (c, f) => call(c, 'PATCH', `/contacts/${f.contactId}/addresses/${f.addressId}`, { kind: 'home', city: 'Elko' }) },
  { name: 'POST relationship', run: (c, f) => call(c, 'POST', `/contacts/${f.contactId}/relationships`, { relatedContactId: f.otherContactId, kind: 'co_buyer' }) },
  { name: 'DELETE relationship', run: (c, f) => call(c, 'DELETE', `/contacts/${f.contactId}/relationships/${f.relationshipId}`) },
  { name: 'POST collaborator', run: (c, f) => call(c, 'POST', `/contacts/${f.contactId}/collaborators`, { userId: c.userId }) },
  { name: 'POST note', run: (c, f) => call(c, 'POST', `/contacts/${f.contactId}/notes`, { body: 'x' }) },
  { name: 'PATCH note', run: (c, f) => call(c, 'PATCH', `/notes/${f.noteId}`, { body: 'edited' }) },
  { name: 'POST note pin', run: (c, f) => call(c, 'POST', `/notes/${f.noteId}/pin`, { pinned: true }) },
  { name: 'DELETE note', run: (c, f) => call(c, 'DELETE', `/notes/${f.noteId}`) },
  { name: 'POST activity', run: (c, f) => call(c, 'POST', `/contacts/${f.contactId}/activities`, { kind: 'call', at: new Date().toISOString() }) },
  { name: 'POST contact tags', run: (c, f) => call(c, 'POST', `/contacts/${f.contactId}/tags`, { tagIds: [tagId] }) },
  { name: 'DELETE contact tag', run: (c, f) => call(c, 'DELETE', `/contacts/${f.contactId}/tags/${tagId}`) },
  { name: 'PUT field value', run: (c, f) => call(c, 'PUT', `/contacts/${f.contactId}/fields/${fieldId}`, { value: 'v2' }) },
  { name: 'PUT annual value', run: (c, f) => call(c, 'PUT', `/contacts/${f.contactId}/fields/${annualFieldId}`, { value: '1990-01-01' }) },
  { name: 'PATCH smart list (other user)', run: (c, f) => call(c, 'PATCH', `/smart-lists/${f.listId}`, { name: 'hijack' }) },
  { name: 'DELETE smart list (other user)', run: (c, f) => call(c, 'DELETE', `/smart-lists/${f.listId}`) },
  { name: 'PATCH team smart list', run: (c) => call(c, 'PATCH', `/smart-lists/${teamListId}`, { name: `team ${randomUUID().slice(0, 4)}` }) },
  { name: 'PATCH template (other user)', run: (c, f) => call(c, 'PATCH', `/templates/${f.templateId}`, { version: 1, name: 'hijack' }) },
  { name: 'POST template archive (other user)', run: (c, f) => call(c, 'POST', `/templates/${f.templateId}/archive`, {}) },
  { name: 'POST template render', run: (c, f) => call(c, 'POST', `/templates/${f.templateId}/render`, { contactId: f.contactId }) },
  { name: 'POST bulk tag', run: (c, f) => call(c, 'POST', '/bulk-actions', { kind: 'tag', selection: { contactIds: [f.contactId] }, tagId, idempotencyKey: `s-${randomUUID()}` }) },
];

const OK = (s: number) => s >= 200 && s < 300;

describe('secreview role sweep: an agent-owned person, every non-owner role', () => {
  it('no mutating parity route answers 500, for any role', async () => {
    const rows: string[] = [];
    const fivehundreds: string[] = [];
    for (const who of ['team_lead', 'agent2', 'outsider', 'isa', 'tc'] as const) {
      for (const p of PROBES) {
        // owner of the resource: the outsider's own agent for the TL-out-of-team case, else agent (in the TL's team)
        const f = await fixture(U.agent);
        const r = await p.run(U[who], f);
        rows.push(`${who.padEnd(10)} ${p.name.padEnd(36)} ${r.status} ${r.code ?? ''}`);
        if (r.status >= 500) fivehundreds.push(`${who} ${p.name} ${r.status} ${JSON.stringify(r.body)}`);
      }
    }
    // the TL on a person outside their team
    for (const p of PROBES) {
      const f = await fixture(U.outsider);
      const r = await p.run(U.team_lead, f);
      rows.push(`TL-out     ${p.name.padEnd(36)} ${r.status} ${r.code ?? ''}`);
      if (r.status >= 500) fivehundreds.push(`TL-out ${p.name} ${r.status} ${JSON.stringify(r.body)}`);
    }
    console.log(rows.join('\n'));
    expect(fivehundreds).toEqual([]);
  }, 600_000);
});


describe('secreview role sweep: collaborators and pond people', () => {
  it('no mutating parity route answers 500 for a collaborator (agent/isa/tc) or on a pond person', async () => {
    const rows: string[] = [];
    const bad: string[] = [];
    const seqOf = async (id: string) => Number((await h.su.query<{ ownership_seq: string }>('SELECT ownership_seq FROM contacts WHERE id = $1', [id])).rows[0]!.ownership_seq);
    for (const [who, role] of [['agent2', 'co_agent'], ['isa', 'isa'], ['tc', 'tc']] as const) {
      for (const p of PROBES) {
        const f = await fixture(U.agent);
        const add = await call(U.agent, 'POST', `/contacts/${f.contactId}/collaborators`, { userId: U[who].userId, role });
        if (add.status !== 200) throw new Error(`collab ${who}: ${add.status} ${JSON.stringify(add.body)}`);
        const r = await p.run(U[who], f);
        rows.push(`collab-${who.padEnd(7)} ${p.name.padEnd(36)} ${r.status} ${r.code ?? ''}`);
        if (r.status >= 500) bad.push(`collab-${who} ${p.name} ${r.status} ${JSON.stringify(r.body)}`);
      }
    }
    for (const who of ['team_lead', 'agent2', 'isa', 'tc'] as const) {
      for (const p of PROBES) {
        const f = await fixture(U.agent);
        const rel = await call(U.agent, 'POST', `/leads/${f.contactId}/release`, { commandId: randomUUID(), expectedSeq: await seqOf(f.contactId), reason: 'not_a_fit' });
        if (rel.status !== 200) throw new Error(`release: ${rel.status} ${JSON.stringify(rel.body)}`);
        const r = await p.run(U[who], f);
        rows.push(`pond-${who.padEnd(9)} ${p.name.padEnd(36)} ${r.status} ${r.code ?? ''}`);
        if (r.status >= 500) bad.push(`pond-${who} ${p.name} ${r.status} ${JSON.stringify(r.body)}`);
      }
    }
    console.log(rows.join('\n'));
    expect(bad).toEqual([]);
  }, 900_000);
});

export { OK };
