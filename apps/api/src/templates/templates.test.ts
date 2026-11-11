// Parity module 63: templates CRUD under RLS, render-for-one, the email signature (R-PAR-23..R-PAR-26).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { auditRows } from '../admin/testing.js';
import { type CommsWorld, call, commsWorld, ownedContact } from '../comms/testing.js';
import { marketingReady } from '../bulk/testing.js';
import { RESPONSE_SCHEMAS } from './schemas.js';

let h: ApiHarness;
let w: CommsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, teamLead: true });
  await marketingReady(h, w);
});
afterAll(async () => {
  await h?.close();
});

type T = { id: string; scope: string; version: number; name: string; body: string; subject: string | null; editable: boolean; mine: boolean; mergeFields: string[] };
const create = (c: CommsWorld['owner'], body: Record<string, unknown>) => call<{ template: T }>(c, 'POST', '/templates', body);

describe('R-PAR-23 team and personal templates', () => {
  it('R-PAR-23 Owner/Admin write team templates; members read them; an agent or TL cannot create or edit one', async () => {
    const team = await create(w.owner, { scope: 'team', channel: 'sms', name: `Intro ${randomUUID().slice(0, 4)}`, body: 'Hi {{contact.first_name|there}}, {{agent.first_name}} here.' });
    expect(team.status).toBe(201);
    expect(team.body.template).toMatchObject({ scope: 'team', version: 1, editable: true, mergeFields: ['agent.first_name', 'contact.first_name'] });
    const agent = w.agents[0]!;
    const list = await call<{ templates: T[] }>(agent, 'GET', '/templates');
    expect(list.body.templates.find((t) => t.id === team.body.template.id)).toMatchObject({ editable: false, mine: false });
    expect((await create(agent, { scope: 'team', channel: 'sms', name: 'Mine as team', body: 'x' })).status).toBe(404);
    expect((await call(agent, 'PATCH', `/templates/${team.body.template.id}`, { version: 1, body: 'changed' })).status).toBe(404);
    expect((await call(w.teamLead!, 'PATCH', `/templates/${team.body.template.id}`, { version: 1, body: 'changed' })).status).toBe(404);
    expect((await call(w.teamLead!, 'POST', `/templates/${team.body.template.id}/archive`)).status).toBe(404);
  });

  it('R-PAR-23 Q-PAR-4 a Team Lead copies a team template to personal and edits the copy', async () => {
    const team = await create(w.owner, { scope: 'team', channel: 'email', name: `Check-in ${randomUUID().slice(0, 4)}`, subject: 'Checking in', body: 'Hello {{contact.first_name|there}}' });
    const copy = await call<{ template: T }>(w.teamLead!, 'POST', `/templates/${team.body.template.id}/copy`);
    expect(copy.status).toBe(201);
    expect(copy.body.template).toMatchObject({ scope: 'personal', mine: true, editable: true, name: team.body.template.name });
    const edited = await call<{ template: T }>(w.teamLead!, 'PATCH', `/templates/${copy.body.template.id}`, { version: 1, body: 'Hello {{contact.first_name|there}}, new text' });
    expect(edited.body.template.version).toBe(2);
    // the team original is untouched
    expect((await call<{ template: T }>(w.owner, 'GET', `/templates/${team.body.template.id}`)).body.template.body).toBe('Hello {{contact.first_name|there}}');
    // copying again does not collide on the name
    expect((await call(w.teamLead!, 'POST', `/templates/${team.body.template.id}/copy`)).status).toBe(201);
  });

  it('R-PAR-23 a personal template is its owner\'s alone: the Owner and other agents do not see it', async () => {
    const agent = w.agents[0]!;
    const mine = await create(agent, { scope: 'personal', channel: 'sms', name: `Mine ${randomUUID().slice(0, 4)}`, body: 'Private wording' });
    expect(mine.status).toBe(201);
    for (const other of [w.owner, w.agents[1]!, w.teamLead!]) {
      expect((await call(other, 'GET', `/templates/${mine.body.template.id}`)).status, String(other.role)).toBe(404);
      const list = await call<{ templates: T[] }>(other, 'GET', '/templates');
      expect(list.body.templates.some((t) => t.id === mine.body.template.id)).toBe(false);
      expect((await call(other, 'PATCH', `/templates/${mine.body.template.id}`, { version: 1, body: 'x' })).status).toBe(404);
      expect((await call(other, 'POST', `/templates/${mine.body.template.id}/copy`)).status).toBe(404);
    }
    // names are unique per scope/owner/channel among live templates
    expect((await create(agent, { scope: 'personal', channel: 'sms', name: mine.body.template.name.toUpperCase(), body: 'x' })).body).toMatchObject({ error: { code: 'TEMPLATE_NAME_TAKEN' } });
    expect((await create(w.agents[1]!, { scope: 'personal', channel: 'sms', name: mine.body.template.name, body: 'x' })).status).toBe(201);
  });
});

describe('R-PAR-26 versions', () => {
  it('R-PAR-26 every content change bumps the version by one; a rename does not; a stale editor is refused', async () => {
    const t = await create(w.owner, { scope: 'team', channel: 'email', name: `V ${randomUUID().slice(0, 4)}`, subject: 'S', body: 'B1' });
    const id = t.body.template.id;
    const renamed = await call<{ template: T }>(w.owner, 'PATCH', `/templates/${id}`, { version: 1, name: `${t.body.template.name} x` });
    expect(renamed.body.template.version).toBe(1);
    expect((await call<{ template: T }>(w.owner, 'PATCH', `/templates/${id}`, { version: 1, subject: 'S2' })).body.template.version).toBe(2);
    expect((await call<{ template: T }>(w.owner, 'PATCH', `/templates/${id}`, { version: 2, body: 'B2' })).body.template.version).toBe(3);
    expect((await call(w.owner, 'PATCH', `/templates/${id}`, { version: 2, body: 'B3' })).body).toMatchObject({ error: { code: 'TEMPLATE_STALE', details: { version: 3 } } });
    const archived = await call<{ template: { archived: boolean } }>(w.owner, 'POST', `/templates/${id}/archive`);
    expect(archived.body.template.archived).toBe(true);
    expect((await call(w.owner, 'PATCH', `/templates/${id}`, { version: 3, body: 'B4' })).body).toMatchObject({ error: { code: 'TEMPLATE_ARCHIVED' } });
    const rows = await auditRows(h, w.tenantId, 'template.');
    expect(rows.filter((r) => r.entity_id === id).map((r) => r.action).sort()).toEqual(['template.archived', 'template.created', 'template.updated', 'template.updated', 'template.updated']);
    // the audit never carries the template text (R-AUDIT-4)
    expect(JSON.stringify(rows.filter((r) => r.entity_id === id))).not.toContain('B2');
  });

  it('R-PAR-24 a template that names a field outside the closed set, or an unknown custom field, is refused at save', async () => {
    for (const body of ['Call {{contact.phone}}', 'Hi {{field.not_a_field}}', 'Hi {{contact.first_name', 'Hi {{agent.first_name|}}']) {
      const r = await create(w.owner, { scope: 'team', channel: 'sms', name: `Bad ${randomUUID().slice(0, 4)}`, body });
      expect(r.status, body).toBe(422);
      expect(r.body).toMatchObject({ error: { code: expect.stringMatching(/^MERGE_FIELD_/) } });
    }
    expect((await create(w.owner, { scope: 'team', channel: 'email', name: `S ${randomUUID().slice(0, 4)}`, subject: 'a\nb', body: 'x' })).body).toMatchObject({ error: { code: 'TEMPLATE_SUBJECT_INVALID' } });
  });
});

describe('R-PAR-24 render for one person, under the sender\'s RLS', () => {
  it('R-PAR-24 E179 renders the person\'s values, the sender\'s own name, literally; a missing field is reported', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { firstName: '{{agent.email}}' });
    const t = await create(agent, { scope: 'personal', channel: 'email', name: `R ${randomUUID().slice(0, 4)}`, subject: 'For {{contact.first_name}}', body: 'Hi {{contact.first_name}} {{contact.last_name}}, from {{agent.first_name}} at {{brokerage.name}}' });
    const r = await call<{ rendered: { subject: string; body: string; preview: string; missing: string[] } }>(agent, 'POST', `/templates/${t.body.template.id}/render`, { contactId: c.id });
    expect(r.status).toBe(200);
    expect(r.body.rendered.body).toBe('Hi {{agent.email}} Doe, from Member at Harbor Realty LLC');
    expect(r.body.rendered.subject).toBe('For {{agent.email}}');
    expect(r.body.rendered.missing).toEqual([]);
    // the email preview carries the brokerage footer the send path adds (R-PAR-25)
    expect(r.body.rendered.preview).toContain('\n\n--\nHarbor Realty LLC');
    const t2 = await create(agent, { scope: 'personal', channel: 'sms', name: `R2 ${randomUUID().slice(0, 4)}`, body: 'Budget {{field.budget_max}}?' });
    expect(t2.body).toMatchObject({ error: { code: 'MERGE_FIELD_UNKNOWN' } });
  });

  it('R-PAR-24 a person the sender cannot see is 404 (never another agent\'s lead), and so is an unreadable template', async () => {
    const other = await ownedContact(w.agents[1]!);
    const t = await create(w.agents[0]!, { scope: 'personal', channel: 'sms', name: `X ${randomUUID().slice(0, 4)}`, body: 'Hi {{contact.first_name}}' });
    expect((await call(w.agents[0]!, 'POST', `/templates/${t.body.template.id}/render`, { contactId: other.id })).status).toBe(404);
    const mine = await ownedContact(w.agents[1]!);
    expect((await call(w.agents[1]!, 'POST', `/templates/${t.body.template.id}/render`, { contactId: mine.id })).status).toBe(404);
  });
});

describe('R-PAR-25 the email signature and the footer', () => {
  it('R-PAR-25 a plain-text signature is self-editable and appended above the brokerage footer of a sent email, never parsed as markup', async () => {
    const agent = w.agents[0]!;
    expect((await call(agent, 'GET', '/email-signature')).body).toEqual({ signature: null });
    expect((await call(agent, 'PUT', '/email-signature', { signature: 'a\u0007b' })).body).toMatchObject({ error: { code: 'SIGNATURE_INVALID' } });
    expect((await call(agent, 'PUT', '/email-signature', { signature: 'x'.repeat(1001) })).body).toMatchObject({ error: { code: 'SIGNATURE_INVALID' } });
    const put = await call(agent, 'PUT', '/email-signature', { signature: '  Sam Agent\r\n<b>Harbor</b> · 555-0100  ' });
    expect(put.body).toEqual({ signature: 'Sam Agent\n<b>Harbor</b> · 555-0100' });
    expect((await call(w.agents[1]!, 'GET', '/email-signature')).body).toEqual({ signature: null });
    const c = await ownedContact(agent);
    const sent = await call<{ message: { body: string }; result: string }>(agent, 'POST', `/contacts/${c.id}/messages`, { channel: 'email', subject: 'Hello', body: 'The listing you asked about.', idempotencyKey: `k-${randomUUID()}` });
    expect(sent.body.result).toBe('sent');
    const body = sent.body.message.body;
    expect(body.indexOf('Sam Agent\n<b>Harbor</b>')).toBeGreaterThan(0);
    expect(body.indexOf('Sam Agent')).toBeLessThan(body.indexOf('\n--\nHarbor Realty LLC'));
    const email = h.providers.email.sent.find((m) => m.to === c.email)!;
    expect(email.text).toContain('<b>Harbor</b>'); // text/plain: printed, never interpreted
    // a text never carries the email signature
    const text = await call<{ message: { body: string } }>(agent, 'POST', `/contacts/${c.id}/messages`, { channel: 'sms', body: 'Quick question', idempotencyKey: `k-${randomUUID()}` });
    expect(text.body.message.body).not.toContain('Sam Agent');
    expect((await call(agent, 'PUT', '/email-signature', { signature: null })).body).toEqual({ signature: null });
    expect((await auditRows(h, w.tenantId, 'member.signature_changed')).length).toBe(2);
  });
});

describe('R-TEN-3 R-AST-13 response schemas', () => {
  it('no tenant ids or confidence fields in any templates response schema', () => {
    const shapes = JSON.stringify(Object.fromEntries(Object.entries(RESPONSE_SCHEMAS).map(([k, s]) => [k, s.toJSONSchema()])));
    expect(shapes).not.toMatch(/tenant_?id|confidence/i);
  });
});
