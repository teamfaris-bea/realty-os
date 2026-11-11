// api/lists: custom field definitions and values (R-PAR-17..19; E173, E174, E175).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { freshReauth } from '../leads/testing.js';
import { auditRows, call, listsWorld, type ListsWorld } from './testing.js';

let h: ApiHarness;
let w: ListsWorld;

interface Field { id: string; key: string; label: string; fieldType: string; options: { id: string; label: string; archived: boolean }[]; annual: boolean; archived: boolean }
const define = (c: ListsWorld['owner'], body: Record<string, unknown>) => call<{ field: Field }>(c, 'POST', '/custom-fields', body);

beforeAll(async () => {
  h = await createApiHarness();
  w = await listsWorld(h);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('custom field definitions (R-PAR-17, R-PAR-18)', () => {
  it('R-PAR-17: only Owner/Admin define fields; typed, keyed from the label, audited', async () => {
    for (const c of [w.lead, w.agentA, w.isa, w.tc]) expect((await define(c, { label: 'Budget', fieldType: 'number' })).status).toBe(404);
    const r = await define(w.admin, { label: 'Budget', fieldType: 'number' });
    expect([r.status, r.body.field.key, r.body.field.fieldType]).toEqual([201, 'budget', 'number']);
    expect((await auditRows(h, w.tenantId, 'custom_field.created')).at(-1)).toMatchObject({ entity_id: r.body.field.id, changes: { field_type: { from: null, to: 'number' } } });
    const list = await call<{ fields: Field[]; liveCount: number; limit: number }>(w.agentA, 'GET', '/custom-fields');
    expect(list.body.fields.map((f) => f.key)).toContain('budget');
    expect(list.body.limit).toBe(50);
    expect((await define(w.admin, { label: 'budget', fieldType: 'text' })).code).toBe('CUSTOM_FIELD_LABEL_TAKEN');
  });

  it('R-PAR-18 E175: "Military status" is refused (CUSTOM_FIELD_PROTECTED, pointing at the self-reported details), and so is the built-in key', async () => {
    const r = await define(w.owner, { label: 'Military status', fieldType: 'single_select', options: [{ label: 'Active duty' }] });
    expect([r.status, r.code]).toEqual([422, 'CUSTOM_FIELD_PROTECTED']);
    expect((await define(w.owner, { label: 'Service branch notes', key: 'military_status', fieldType: 'text' })).code).toBe('CUSTOM_FIELD_PROTECTED');
    expect((await define(w.owner, { label: 'Loan', fieldType: 'single_select', options: [{ label: 'Conventional' }, { label: 'Section 8 voucher' }] })).code).toBe('CUSTOM_FIELD_PROTECTED');
    const fields = await call<{ fields: Field[] }>(w.owner, 'GET', '/custom-fields');
    expect(fields.body.fields.map((f) => f.label)).not.toContain('Military status');
  });

  it('R-PAR-17 E174: renaming option "Pre-approved" to "Preapproved" keeps its id, so every value still points at it; options are archived, never removed; key and type never change', async () => {
    const f = await define(w.admin, { label: 'Financing', fieldType: 'single_select', options: [{ label: 'Pre-approved' }, { label: 'Cash' }] });
    const pre = f.body.field.options[0]!;
    expect((await call(w.agentA, 'PUT', `/contacts/${w.aContacts[0]}/fields/${f.body.field.id}`, { value: pre.id })).status).toBe(200);
    const renamed = await call<{ field: Field }>(w.admin, 'PATCH', `/custom-fields/${f.body.field.id}`, { renameOptions: { [pre.id]: 'Preapproved' }, archiveOptions: ['cash'], addOptions: [{ label: 'FHA' }] });
    expect(renamed.status).toBe(200);
    expect(renamed.body.field.options).toEqual([{ id: pre.id, label: 'Preapproved', archived: false }, { id: 'cash', label: 'Cash', archived: true }, { id: 'fha', label: 'FHA', archived: false }]);
    const v = await call<{ values: { fieldId: string; optionIds: string[] }[] }>(w.agentA, 'GET', `/contacts/${w.aContacts[0]}/fields`);
    expect(v.body.values.find((x) => x.fieldId === f.body.field.id)?.optionIds).toEqual([pre.id]);
    expect((await call(w.agentA, 'PUT', `/contacts/${w.aContacts[1]}/fields/${f.body.field.id}`, { value: 'cash' })).code).toBe('CUSTOM_VALUE_OPTION');
    expect((await call(w.admin, 'PATCH', `/custom-fields/${f.body.field.id}`, { fieldType: 'text' })).status).toBe(422); // strict body: no type edits
    expect((await auditRows(h, w.tenantId, 'custom_field.changed')).at(-1)).toMatchObject({ entity_id: f.body.field.id, changes: { options: { changed: true } } });
  });

  it('R-PAR-17: an archived field is read-only (values kept, writes refused) until restored; audited', async () => {
    const f = await define(w.admin, { label: 'Lot size', fieldType: 'number' });
    expect((await call(w.agentA, 'PUT', `/contacts/${w.aContacts[0]}/fields/${f.body.field.id}`, { value: '0.25' })).status).toBe(200);
    expect((await call<{ field: Field }>(w.admin, 'POST', `/custom-fields/${f.body.field.id}/archive`, { archived: true })).body.field.archived).toBe(true);
    expect((await call(w.agentA, 'PUT', `/contacts/${w.aContacts[0]}/fields/${f.body.field.id}`, { value: 1 })).code).toBe('CUSTOM_FIELD_ARCHIVED');
    expect((await call(w.admin, 'PATCH', `/custom-fields/${f.body.field.id}`, { label: 'Lot' })).code).toBe('CUSTOM_FIELD_ARCHIVED');
    const v = await call<{ values: { fieldId: string; number: number }[] }>(w.agentA, 'GET', `/contacts/${w.aContacts[0]}/fields`);
    expect(v.body.values.find((x) => x.fieldId === f.body.field.id)?.number).toBe(0.25);
    expect((await call<{ field: Field }>(w.admin, 'POST', `/custom-fields/${f.body.field.id}/archive`, { archived: false })).body.field.archived).toBe(false);
    expect((await auditRows(h, w.tenantId, 'custom_field.archived')).length).toBe(2);
  });

  it('R-PAR-17 E173: two Admins adding the 50th and 51st field at once: one succeeds, the other gets CUSTOM_FIELD_LIMIT', async () => {
    const now = (await call<{ liveCount: number }>(w.owner, 'GET', '/custom-fields')).body.liveCount;
    for (let i = now; i < 49; i++) expect((await define(w.owner, { label: `Extra ${i}`, fieldType: 'text' })).status).toBe(201);
    await freshReauth(h, w.admin);
    const [a, b] = await Promise.all([define(w.owner, { label: 'Fiftieth', fieldType: 'text' }), define(w.admin, { label: 'Fifty-first', fieldType: 'text' })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a.code, b.code]).toContain('CUSTOM_FIELD_LIMIT');
    expect((await call<{ liveCount: number }>(w.owner, 'GET', '/custom-fields')).body.liveCount).toBe(50);
    // archiving one frees a slot; restoring past the limit is refused
    const all = (await call<{ fields: Field[] }>(w.owner, 'GET', '/custom-fields')).body.fields;
    const victim = all.find((f) => f.label === 'Extra 48')!;
    await call(w.owner, 'POST', `/custom-fields/${victim.id}/archive`, { archived: true });
    expect((await define(w.owner, { label: 'Replacement', fieldType: 'text' })).status).toBe(201);
    expect((await call(w.owner, 'POST', `/custom-fields/${victim.id}/archive`, { archived: false })).code).toBe('CUSTOM_FIELD_LIMIT');
  });
});

describe("a person's custom values (R-PAR-19)", () => {
  it('R-PAR-19: values are typed, visible and writable exactly when the person\'s detail is (never a pond card, never a TC, never another book); clearing deletes', async () => {
    const all = (await call<{ fields: Field[] }>(w.owner, 'GET', '/custom-fields')).body.fields;
    const budget = all.find((f) => f.key === 'budget')!;
    expect((await call<{ value: { number: number } }>(w.agentA, 'PUT', `/contacts/${w.aContacts[1]}/fields/${budget.id}`, { value: '450,000' })).body.value.number).toBe(450000);
    expect((await call(w.agentA, 'PUT', `/contacts/${w.aContacts[1]}/fields/${budget.id}`, { value: 'lots' })).code).toBe('CUSTOM_VALUE_TYPE');
    expect((await call(w.agentA, 'PUT', `/contacts/${w.bContacts[0]}/fields/${budget.id}`, { value: 1 })).status).toBe(404);
    expect((await call(w.agentA, 'GET', `/contacts/${w.bContacts[0]}/fields`)).status).toBe(404);
    expect((await call(w.agentA, 'GET', `/contacts/${w.pondContact}/fields`)).status).toBe(404);
    expect((await call(w.tc, 'PUT', `/contacts/${w.aContacts[1]}/fields/${budget.id}`, { value: 1 })).status).toBe(404);
    expect((await call(w.lead, 'PUT', `/contacts/${w.aContacts[1]}/fields/${budget.id}`, { value: 500000 })).status).toBe(200); // TL: team
    const cleared = await call<{ value: null; changed: boolean }>(w.agentA, 'PUT', `/contacts/${w.aContacts[1]}/fields/${budget.id}`, { value: null });
    expect([cleared.body.value, cleared.body.changed]).toEqual([null, true]);
    expect((await h.su.query('SELECT 1 FROM contact_field_values WHERE contact_id = $1 AND field_id = $2', [w.aContacts[1], budget.id])).rowCount).toBe(0);
    const row = await h.su.query('SELECT updated_by_kind, updated_by_user_id FROM contact_field_values WHERE contact_id = $1 AND field_id = $2', [w.aContacts[0], all.find((f) => f.label === 'Financing')!.id]);
    expect(row.rows[0]).toEqual({ updated_by_kind: 'user', updated_by_user_id: w.agentA.userId });
  });
});
