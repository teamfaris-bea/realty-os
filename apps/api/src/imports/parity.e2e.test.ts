// api/import-parity (PARITY_PLAN module 65; R-PAR-46, R-PAR-10, R-PAR-6, R-PAR-8, R-PAR-17, R-PAR-18, E190, E191,
// E41) end to end on the fake FUB API: the stage map, keep-stage-as-tag, the tag catalog, typed custom fields
// of every type, fill-empty, the per-category report, a DNC-looking tag becoming a real opt-out, and a revert
// that removes exactly what the import wrote.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FubDataset } from './fub.js';
import {
  type BatchView,
  type ImportWorld,
  type ImportsHarness,
  approve,
  batchOf,
  call,
  commitStage,
  fubFixture,
  importWorld,
  importsHarness,
  mapUnmappedStages,
  records,
  stageOf,
  verify,
} from './testing.js';

let ih: ImportsHarness;
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await ih.h.su.query(sql, args)).rows as T[];

beforeAll(async () => {
  ih = await importsHarness();
}, 120_000);
afterAll(async () => {
  await ih?.close();
});

interface ParityBody {
  options: { stageMap: Record<string, string>; keepStageAsTag: boolean; fields: Record<string, unknown> };
  stages: { label: string; people: number; suggested: string | null; mapped: string | null }[];
  tags: { distinct: number; existing: number; toCreate: number; overLimit: number; sourceLinks: number; links: number; protectedNew: number; optOutTagged: number };
  fields: { sourceKey: string; label: string; people: number; suggestedType: string; protected: boolean; fit: number; misfit: number; options: { id: string; label: string }[] }[];
  blockers: string[];
  lines: string[];
  report: { category: string; source: number; imported: number; needsReview: number; rejected: number; duplicate: number }[];
}

let seq = 0;
/** People with custom fields of each type, a protected-looking field, FUB stages, tags and a DNC-looking tag. */
function parityFixture(): FubDataset {
  const p = 5000 + ++seq * 100;
  const ph = (n: number) => `(415) 56${seq % 10}-${String(1000 + n).slice(-4)}`;
  return {
    users: [{ id: 11, name: 'Alex Agent' }],
    people: [
      {
        id: p + 1, created: '2023-01-01T00:00:00Z', firstName: 'Ana', lastName: 'Lead', stage: 'Hot Prospect', tags: ['Buyer', 'Relocating'],
        phones: [{ value: ph(1), type: 'mobile', status: 'Valid' }],
        customLeadScore: '87', customClosingDate: '2026-12-15', customTimeline: '0-3 months', customInterests: 'Pool, Garage', customNotesField: 'Prefers mornings', customMilitaryStatus: 'Active duty',
      },
      {
        id: p + 2, created: '2023-01-02T00:00:00Z', firstName: 'Ben', lastName: 'Lead', stage: 'Waiting On Lender', tags: ['buyer'],
        phones: [{ value: ph(2), type: 'mobile', status: 'Valid' }],
        customLeadScore: 'high', customClosingDate: '12/31/2026', customTimeline: '0-3 months', customInterests: 'Garage', customMilitaryStatus: 'Veteran',
      },
      {
        id: p + 3, created: '2023-01-03T00:00:00Z', firstName: 'Cal', lastName: 'Lead', stage: 'Waiting On Lender', tags: ['DNC'],
        phones: [{ value: ph(3), type: 'mobile', status: 'Valid' }],
        customTimeline: '3-6 months', customLeadScore: '40',
      },
      { id: p + 4, created: '2023-01-04T00:00:00Z', firstName: 'Dee', lastName: 'Lead', phones: [{ value: ph(4), type: 'mobile', status: 'Valid' }], customTimeline: '3-6 months' },
    ],
  };
}

async function freshWorld(dataset: FubDataset): Promise<{ w: ImportWorld; key: string; b: BatchView }> {
  const w = await importWorld(ih);
  const key = `fub-par-${randomUUID().slice(0, 8)}`;
  ih.fub.add(key, dataset);
  const r = await call<{ batch: BatchView }>(w.admin, 'POST', '/imports', { source: 'fub_api', apiKey: key });
  expect(r.status).toBe(201);
  expect((await call(w.admin, 'POST', `/imports/${r.body.batch.id}/snapshot`)).status).toBe(202);
  await ih.drain();
  return { w, key, b: await batchOf(w.admin, r.body.batch.id) };
}

const parity = (w: ImportWorld, id: string) => call<ParityBody>(w.admin, 'GET', `/imports/${id}/parity`);
const putParity = (w: ImportWorld, id: string, body: Record<string, unknown>) => call<ParityBody>(w.admin, 'PUT', `/imports/${id}/parity`, body);

async function dryRunContacts(w: ImportWorld, id: string) {
  expect((await call(w.admin, 'POST', `/imports/${id}/stages/contacts/dry-run`)).status).toBe(202);
  await ih.drain();
  return stageOf(await batchOf(w.admin, id), 'contacts');
}

const FIELDS = {
  customLeadScore: { action: 'create', type: 'number', label: 'Lead score' },
  customClosingDate: { action: 'create', type: 'date', label: 'Closing date' },
  customTimeline: { action: 'create', type: 'single_select', label: 'Timeline' },
  customInterests: { action: 'create', type: 'multi_select', label: 'Interests' },
  customNotesField: { action: 'create', type: 'text', label: 'Notes field' },
};

async function commitContacts(w: ImportWorld, id: string, stageMap: Record<string, string>, fields: Record<string, unknown> = FIELDS, review: { sourceRef: string; decision: 'import' | 'merge'; mergeIntoContactId?: string }[] = []) {
  const put = await putParity(w, id, { stageMap, keepStageAsTag: true, fields });
  expect(put.status).toBe(200);
  const d = await dryRunContacts(w, id);
  for (const rv of review) {
    const rec = (await records(w.admin, id, 'contacts')).find((r) => r.sourceRef === rv.sourceRef)!;
    const rr = await call(w.admin, 'POST', `/imports/${id}/records/${rec.id}/review`, { decision: rv.decision, ...(rv.mergeIntoContactId ? { mergeIntoContactId: rv.mergeIntoContactId } : {}) });
    expect(rr.status).toBe(200);
  }
  const a = await approve(w.admin, id, 'contacts', d.dryRunSha256 as string);
  expect(a.status).toBe(200);
  return commitStage(ih, w.admin, id, 'contacts');
}

const contactId = async (tenantId: string, first: string) =>
  (await q<{ id: string }>(`SELECT id FROM contacts WHERE tenant_id = $1 AND first_name = $2 AND deleted_at IS NULL`, [tenantId, first]))[0]!.id;
const tagNames = async (cid: string) =>
  (await q<{ name: string }>(`SELECT t.name FROM contact_tags ct JOIN tags t ON t.tenant_id = ct.tenant_id AND t.id = ct.tag_id WHERE ct.contact_id = $1 ORDER BY t.name`, [cid])).map((r) => r.name);

describe('R-PAR-46 stages', () => {
  it('R-PAR-46: the dry run lists the distinct FUB stages with counts; an unmapped label blocks the approval (STAGE_MAP_INCOMPLETE), never silently `new`', async () => {
    const { w, b } = await freshWorld(parityFixture());
    const g = await parity(w, b.id);
    expect(g.status).toBe(200);
    expect(g.body.stages).toEqual([
      { label: 'Waiting On Lender', people: 2, suggested: null, mapped: null },
      { label: 'Hot Prospect', people: 1, suggested: 'active', mapped: 'active' },
    ]);
    expect(g.body.blockers).toContain('STAGE_MAP_INCOMPLETE');
    expect(g.body.lines[0]).toBe('2 stages in Follow Up Boss. 1 still needs a stage before you can approve.');
    const d = await dryRunContacts(w, b.id);
    const a = await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string);
    expect([a.status, a.code]).toEqual([409, 'IMPORT_STAGE_BLOCKED']);
    expect(JSON.stringify(a.body)).toContain('STAGE_MAP_INCOMPLETE');
  });

  it('R-PAR-46 E191: the Admin maps each label; changing the map resets the dry run; the mapped stage lands and each FUB stage is kept as the tag "FUB stage: <label>"', async () => {
    const { w, b } = await freshWorld(parityFixture());
    await putParity(w, b.id, { stageMap: { 'Waiting On Lender': 'nurture' }, keepStageAsTag: true, fields: {} });
    const d1 = await dryRunContacts(w, b.id);
    expect(d1.status).toBe('dry_run_ready');
    // a change resets the stage: the old dry run (and any approval on it) is gone
    await putParity(w, b.id, { stageMap: { 'Waiting On Lender': 'under_contract', 'Hot Prospect': 'nurture' }, keepStageAsTag: true, fields: {} });
    expect(stageOf(await batchOf(w.admin, b.id), 'contacts').status).toBe('pending');
    expect((await approve(w.admin, b.id, 'contacts', d1.dryRunSha256 as string)).status).toBe(409);
    await commitContacts(w, b.id, { 'Waiting On Lender': 'under_contract', 'Hot Prospect': 'nurture' }, {});
    const stages = await q<{ first_name: string; stage: string }>(`SELECT first_name, stage FROM contacts WHERE tenant_id = $1 ORDER BY first_name`, [w.tenantId]);
    expect(stages).toEqual([
      { first_name: 'Ana', stage: 'nurture' },
      { first_name: 'Ben', stage: 'under_contract' },
      { first_name: 'Cal', stage: 'under_contract' },
      { first_name: 'Dee', stage: 'new' },
    ]);
    expect(await tagNames(await contactId(w.tenantId, 'Ana'))).toContain('FUB stage: Hot Prospect');
    expect(await tagNames(await contactId(w.tenantId, 'Ben'))).toContain('FUB stage: Waiting On Lender');
    // the stage history shows no human actor for an import
    expect(await q(`SELECT 1 FROM playbook_enrollments WHERE tenant_id = $1`, [w.tenantId])).toEqual([]);
  });

  it('R-PAR-46: keepStageAsTag off adds no stage tags', async () => {
    const { w, b } = await freshWorld(parityFixture());
    await putParity(w, b.id, { stageMap: { 'Waiting On Lender': 'nurture' }, keepStageAsTag: false, fields: {} });
    const d = await dryRunContacts(w, b.id);
    expect((await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string)).status).toBe(200);
    await commitStage(ih, w.admin, b.id, 'contacts');
    expect((await q(`SELECT 1 FROM tags WHERE tenant_id = $1 AND name LIKE 'FUB stage:%'`, [w.tenantId])).length).toBe(0);
  });
});

describe('R-PAR-46 R-PAR-10 tags', () => {
  it('R-PAR-10 R-PAR-6 E165: tags land in the catalog and contact_tags (provenance import + batch), first spelling wins against an existing tag, contacts.tags is gone', async () => {
    const { w, b } = await freshWorld(parityFixture());
    // an existing "BUYER" tag in the catalog: the import reuses it (case-insensitive name key)
    const pre = randomUUID();
    await ih.h.su.query(`INSERT INTO tags (tenant_id, id, name, created_by_kind, created_by_user_id) VALUES ($1, $2, 'BUYER', 'user', $3)`, [w.tenantId, pre, w.owner.userId]);
    const g = await parity(w, b.id);
    expect(g.body.tags).toMatchObject({ existing: 1, toCreate: 4, overLimit: 0, optOutTagged: 1 }); // Relocating, DNC, 2 stage tags
    await commitContacts(w, b.id, { 'Waiting On Lender': 'nurture' }, {});
    const ana = await contactId(w.tenantId, 'Ana');
    expect(await tagNames(ana)).toEqual(['BUYER', 'FUB stage: Hot Prospect', 'Relocating']);
    const links = await q<{ added_by_kind: string; import_batch_id: string }>(`SELECT added_by_kind, import_batch_id FROM contact_tags WHERE contact_id = $1`, [ana]);
    expect(links.every((l) => l.added_by_kind === 'import' && l.import_batch_id === b.id)).toBe(true);
    expect(await q(`SELECT 1 FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'tags'`)).toEqual([]);
    // the contact API reads tags from the catalog
    const c = await call<{ contact: { tags: string[] } }>(w.owner, 'GET', `/contacts/${ana}`);
    expect(c.body.contact.tags).toEqual(['BUYER', 'FUB stage: Hot Prospect', 'Relocating']);
  });

  it('R-PAR-46 E190: 1,400 distinct FUB tags: the dry run reports TAG_LIMIT and blocks the approval; the raw tags stay in imported_fields', async () => {
    const d = parityFixture();
    (d.people as { tags?: string[] }[])[3]!.tags = Array.from({ length: 1400 }, (_, i) => `t${i}`);
    const { w, b } = await freshWorld(d);
    await putParity(w, b.id, { stageMap: { 'Waiting On Lender': 'nurture' }, keepStageAsTag: false, fields: {} });
    const g = await parity(w, b.id);
    // core collectTags keeps at most 100 per person: 100 of them reach the catalog plan, all under the limit
    expect(g.body.tags.overLimit).toBe(0);
    // a tenant already near the limit: 950 catalog tags + the import's new ones pass 1,000
    await ih.h.su.query(`INSERT INTO tags (tenant_id, id, name, created_by_kind) SELECT $1, gen_random_uuid(), 'pre' || g, 'import' FROM generate_series(1, 950) g`, [w.tenantId]);
    const g2 = await parity(w, b.id);
    expect(g2.body.tags.overLimit).toBeGreaterThan(0);
    expect(g2.body.blockers).toContain('TAG_LIMIT');
    const dr = await dryRunContacts(w, b.id);
    const a = await approve(w.admin, b.id, 'contacts', dr.dryRunSha256 as string);
    expect([a.status, a.code]).toEqual([409, 'IMPORT_STAGE_BLOCKED']);
    expect(g2.body.report.find((r) => r.category === 'tags')).toMatchObject({ rejected: expect.any(Number) });
  }, 60_000);

  it('R-PAR-7 R-CONSENT-3 D1: a DNC-looking FUB tag stays a tag AND becomes a real opt-out: texting that person is refused', async () => {
    const { w, b } = await freshWorld(parityFixture());
    await commitContacts(w, b.id, { 'Waiting On Lender': 'nurture' }, {});
    const cal = await contactId(w.tenantId, 'Cal');
    expect(await tagNames(cal)).toContain('DNC');
    // the contacts commit applied the opt-out (consent ledger revoke / import_dnc suppression) for Cal's phone
    const hm = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM contact_points p WHERE p.contact_id = $1 AND (
         EXISTS (SELECT 1 FROM suppressions s WHERE s.tenant_id = p.tenant_id AND s.address_hmac = p.address_hmac AND s.lifted_at IS NULL)
         OR EXISTS (SELECT 1 FROM consent_events e WHERE e.tenant_id = p.tenant_id AND e.address_hmac = p.address_hmac AND e.event_type = 'revoke'))`, [cal]);
    expect(hm[0]!.n).toBeGreaterThan(0);
    // removing the tag never lifts anything (R-PAR-7)
    await ih.h.su.query(`DELETE FROM contact_tags WHERE contact_id = $1`, [cal]);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM suppressions s JOIN contact_points p ON p.tenant_id = s.tenant_id AND p.address_hmac = s.address_hmac WHERE p.contact_id = $1 AND s.lifted_at IS NULL`, [cal]))[0]!.n
      + (await q<{ n: number }>(`SELECT count(*)::int AS n FROM consent_events e JOIN contact_points p ON p.tenant_id = e.tenant_id AND p.address_hmac = e.address_hmac WHERE p.contact_id = $1 AND e.event_type = 'revoke'`, [cal]))[0]!.n).toBeGreaterThan(0);
  });
});

describe('R-PAR-46 R-PAR-17 R-PAR-18 custom fields', () => {
  it('R-PAR-46 R-PAR-17: FUB custom fields of every type map to typed definitions; a value that does not fit is reported and stays as text in imported_fields', async () => {
    const { w, b } = await freshWorld(parityFixture());
    const g = await parity(w, b.id);
    const byKey = Object.fromEntries(g.body.fields.map((f) => [f.sourceKey, f]));
    expect(byKey.customLeadScore).toMatchObject({ label: 'Lead Score', people: 3 });
    expect(byKey.customTimeline!.options.map((o) => o.label)).toEqual(['0-3 months', '3-6 months']);
    await commitContacts(w, b.id, { 'Waiting On Lender': 'nurture' });
    const defs = await q<{ key: string; field_type: string; origin: string }>(`SELECT key, field_type, origin FROM custom_field_defs WHERE tenant_id = $1 ORDER BY key`, [w.tenantId]);
    expect(defs).toEqual([
      { key: 'fub_closing_date', field_type: 'date', origin: 'fub_import' },
      { key: 'fub_interests', field_type: 'multi_select', origin: 'fub_import' },
      { key: 'fub_lead_score', field_type: 'number', origin: 'fub_import' },
      { key: 'fub_notes_field', field_type: 'text', origin: 'fub_import' },
      { key: 'fub_timeline', field_type: 'single_select', origin: 'fub_import' },
    ]);
    const ana = await contactId(w.tenantId, 'Ana');
    const vals = await q<{ key: string; value_text: string | null; value_number: string | null; value_date: string | null; value_options: string[] | null; updated_by_kind: string }>(
      `SELECT d.key, v.value_text, v.value_number::text, v.value_date::text, v.value_options, v.updated_by_kind FROM contact_field_values v JOIN custom_field_defs d ON d.tenant_id = v.tenant_id AND d.id = v.field_id WHERE v.contact_id = $1 ORDER BY d.key`, [ana]);
    expect(vals.map((v) => [v.key, v.value_text ?? v.value_number ?? v.value_date ?? v.value_options])).toEqual([
      ['fub_closing_date', '2026-12-15'],
      ['fub_interests', ['pool', 'garage']],
      ['fub_lead_score', '87'],
      ['fub_notes_field', 'Prefers mornings'],
      ['fub_timeline', ['0_3_months']],
    ]);
    expect(vals.every((v) => v.updated_by_kind === 'import')).toBe(true);
    // Ben's "high" is not a number: no value, and the raw text stays in imported_fields
    const ben = await contactId(w.tenantId, 'Ben');
    expect(await q(`SELECT 1 FROM contact_field_values v JOIN custom_field_defs d ON d.id = v.field_id AND d.tenant_id = v.tenant_id WHERE v.contact_id = $1 AND d.key = 'fub_lead_score'`, [ben])).toEqual([]);
    expect((await q<{ f: Record<string, string> }>(`SELECT imported_fields AS f FROM contacts WHERE id = $1`, [ben]))[0]!.f.customLeadScore).toBe('high');
    // MM/DD/YYYY dates are read
    expect((await q<{ d: string }>(`SELECT v.value_date::text AS d FROM contact_field_values v JOIN custom_field_defs f ON f.tenant_id = v.tenant_id AND f.id = v.field_id WHERE v.contact_id = $1 AND f.key = 'fub_closing_date'`, [ben]))[0]!.d).toBe('2026-12-31');
    // the report covers custom fields and reconciles
    const rep = await call<{ parity: { phase: string; rows: { category: string; source: number; imported: number; needsReview: number; rejected: number; duplicate: number }[]; lines: string[] } }>(w.admin, 'GET', `/imports/${b.id}/report`);
    expect(rep.body.parity!.phase).toBe('committed');
    for (const r of rep.body.parity!.rows) expect(r.source).toBe(r.imported + r.needsReview + r.rejected + r.duplicate);
    expect(rep.body.parity!.rows.find((r) => r.category === 'custom_fields')).toMatchObject({ rejected: 1 });
  });

  it('R-PAR-18 E175: a field that reads like a protected attribute (military status) is never created; naming one in a mapping is refused CUSTOM_FIELD_PROTECTED; its text stays in imported_fields', async () => {
    const { w, b } = await freshWorld(parityFixture());
    const g = await parity(w, b.id);
    expect(g.body.fields.find((f) => f.sourceKey === 'customMilitaryStatus')).toMatchObject({ protected: true });
    const r = await putParity(w, b.id, { stageMap: {}, keepStageAsTag: true, fields: { customMilitaryStatus: { action: 'create', type: 'text', label: 'Military status' } } });
    expect([r.status, r.code]).toEqual([422, 'CUSTOM_FIELD_PROTECTED']);
    const r2 = await putParity(w, b.id, { stageMap: {}, keepStageAsTag: true, fields: { customMilitaryStatus: { action: 'create', type: 'text', label: 'Service' } } });
    expect([r2.status, r2.code]).toEqual([422, 'CUSTOM_FIELD_PROTECTED']); // the source key itself reads as protected
    await commitContacts(w, b.id, { 'Waiting On Lender': 'nurture' });
    expect(await q(`SELECT 1 FROM custom_field_defs WHERE tenant_id = $1 AND (key LIKE '%military%' OR label ILIKE '%military%')`, [w.tenantId])).toEqual([]);
    expect((await q<{ f: Record<string, string> }>(`SELECT imported_fields AS f FROM contacts WHERE id = $1`, [await contactId(w.tenantId, 'Ana')]))[0]!.f.customMilitaryStatus).toBe('Active duty');
  });

  it('R-PAR-46 E41: fill-empty never overwrites a value an agent set; the existing contact keeps its stage', async () => {
    const d = parityFixture();
    const { w, b } = await freshWorld(d);
    // the team already has Ana (same phone), with an agent-set Timeline value and a stage
    const fieldId = randomUUID();
    await ih.h.su.query(`INSERT INTO custom_field_defs (tenant_id, id, key, label, field_type, options, created_by_user_id) VALUES ($1, $2, 'timeline', 'Timeline', 'single_select', '[{"id":"later","label":"Later"},{"id":"0_3_months","label":"0-3 months"}]', $3)`, [w.tenantId, fieldId, w.owner.userId]);
    const phone = ((d.people as { phones: { value: string }[] }[])[0]!.phones[0]!.value);
    const made = await call<{ contact: { id: string } }>(w.agents[0]!, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Ana', lastName: 'Existing', phones: [phone] });
    const ana = made.body.contact.id;
    await ih.h.su.query(`INSERT INTO contact_field_values (tenant_id, contact_id, field_id, value_options, updated_by_kind, updated_by_user_id) VALUES ($1, $2, $3, '{later}', 'user', $4)`, [w.tenantId, ana, fieldId, w.agents[0]!.userId]);
    const anaRef = `fub:people/${(d.people as { id: number }[])[0]!.id}`;
    await commitContacts(w, b.id, { 'Waiting On Lender': 'nurture' }, { ...FIELDS, customTimeline: { action: 'existing', fieldId } }, [{ sourceRef: anaRef, decision: 'merge', mergeIntoContactId: ana }]);
    expect((await q<{ value_options: string[]; updated_by_kind: string }>(`SELECT value_options, updated_by_kind FROM contact_field_values WHERE contact_id = $1 AND field_id = $2`, [ana, fieldId]))[0]).toEqual({ value_options: ['later'], updated_by_kind: 'user' });
    expect((await q<{ stage: string }>(`SELECT stage FROM contacts WHERE id = $1`, [ana]))[0]!.stage).toBe('new'); // not "active" from FUB
    // the import's other values were added where empty
    expect((await q(`SELECT 1 FROM contact_field_values v JOIN custom_field_defs f ON f.tenant_id = v.tenant_id AND f.id = v.field_id WHERE v.contact_id = $1 AND f.key = 'fub_lead_score'`, [ana])).length).toBe(1);
    const rep = await call<{ parity: { rows: { category: string; duplicate: number }[] } }>(w.admin, 'GET', `/imports/${b.id}/report`);
    expect(rep.body.parity!.rows.find((r) => r.category === 'custom_fields')!.duplicate).toBe(1);
    expect(rep.body.parity!.rows.find((r) => r.category === 'stages')!.duplicate).toBe(1);
  });
});

describe('R-PAR-46 R-IMPORT-10 revert', () => {
  it('R-PAR-46 R-IMPORT-10: revert removes exactly the batch\'s tag links, values, unused created tags and fields; a tag a human added and a value an agent edited stay', async () => {
    const { w, b } = await freshWorld(parityFixture());
    const pre = randomUUID();
    await ih.h.su.query(`INSERT INTO tags (tenant_id, id, name, created_by_kind, created_by_user_id) VALUES ($1, $2, 'Buyer', 'user', $3)`, [w.tenantId, pre, w.owner.userId]);
    await commitContacts(w, b.id, { 'Waiting On Lender': 'nurture' });
    const v = await verify(w.admin, b.id, 'contacts');
    expect(v.res.status).toBe(200);
    // after the import a human tags Dee with a new tag, and an agent edits Ana's lead score (now their value)
    const dee = await contactId(w.tenantId, 'Dee');
    const ana = await contactId(w.tenantId, 'Ana');
    const human = randomUUID();
    await ih.h.su.query(`INSERT INTO tags (tenant_id, id, name, created_by_kind, created_by_user_id) VALUES ($1, $2, 'Met at open house', 'user', $3)`, [w.tenantId, human, w.owner.userId]);
    await ih.h.su.query(`INSERT INTO contact_tags (tenant_id, contact_id, tag_id, added_by_kind, added_by_user_id) VALUES ($1, $2, $3, 'user', $4)`, [w.tenantId, dee, human, w.owner.userId]);
    const score = (await q<{ id: string }>(`SELECT id FROM custom_field_defs WHERE tenant_id = $1 AND key = 'fub_lead_score'`, [w.tenantId]))[0]!.id;
    await ih.h.su.query(`UPDATE contact_field_values SET value_number = 90, updated_by_kind = 'user', updated_by_user_id = $3, import_batch_id = NULL WHERE contact_id = $1 AND field_id = $2`, [ana, score, w.owner.userId]);
    const before = await q<{ n: number }>(`SELECT count(*)::int AS n FROM contact_tags WHERE import_batch_id = $1`, [b.id]);
    expect(before[0]!.n).toBeGreaterThan(0);
    expect((await call(w.admin, 'POST', `/imports/${b.id}/revert`, {})).status).toBe(202);
    await ih.drain();
    expect(await q(`SELECT 1 FROM contact_tags WHERE import_batch_id = $1 AND contact_id <> ALL ($2::uuid[])`, [b.id, [dee, ana]])).toEqual([]);
    // Dee and Ana were touched after the import: kept for a human, with the human's tag / value
    expect(await tagNames(dee)).toContain('Met at open house');
    expect((await q<{ v: string }>(`SELECT value_number::text AS v FROM contact_field_values WHERE contact_id = $1 AND field_id = $2`, [ana, score]))[0]!.v).toBe('90');
    // the import's own values on untouched people are gone
    const ben = await contactId(w.tenantId, 'Ben').catch(() => null);
    if (ben) expect(await q(`SELECT 1 FROM contact_field_values WHERE contact_id = $1 AND import_batch_id = $2`, [ben, b.id])).toEqual([]);
    // the pre-existing catalog tag and the human's tag stay; created tags nobody uses are removed
    expect((await q(`SELECT 1 FROM tags WHERE id = ANY ($1::uuid[])`, [[pre, human]])).length).toBe(2);
    // Relocating stays: it is on Ana, who was touched and kept for a human; DNC and the Waiting On Lender stage
    // tag were only on untouched people, so the catalog entries the import made for them are gone
    expect((await q(`SELECT name FROM tags WHERE tenant_id = $1 AND name = 'Relocating'`, [w.tenantId])).length).toBe(1);
    expect(await q(`SELECT name FROM tags WHERE tenant_id = $1 AND name IN ('DNC', 'FUB stage: Waiting On Lender')`, [w.tenantId])).toEqual([]);
    // fields still holding a value (Ana's edited score) stay live; the rest are archived, never deleted
    const defs = await q<{ key: string; archived: boolean }>(`SELECT key, archived_at IS NOT NULL AS archived FROM custom_field_defs WHERE tenant_id = $1 ORDER BY key`, [w.tenantId]);
    expect(defs.find((d) => d.key === 'fub_lead_score')!.archived).toBe(false);
    const rep = await call<{ parity: { phase: string; lines: string[] } }>(w.admin, 'GET', `/imports/${b.id}/report`);
    expect(rep.body.parity!.lines.join(' ')).toMatch(/Revert removed \d+ tag links?/);
  }, 60_000);

  it('R-IMPORT-9: re-running the same FUB import writes no second tag link or value (idempotent through the catalog and external refs)', async () => {
    const d = parityFixture();
    const { w, b } = await freshWorld(d);
    await commitContacts(w, b.id, { 'Waiting On Lender': 'nurture' });
    const links = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM contact_tags ct JOIN contacts c ON c.id = ct.contact_id WHERE c.tenant_id = $1`, [w.tenantId]))[0]!.n;
    const values = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM contact_field_values WHERE tenant_id = $1`, [w.tenantId]))[0]!.n;
    const key2 = `fub-par-${randomUUID().slice(0, 8)}`;
    ih.fub.add(key2, d);
    const r = await call<{ batch: BatchView }>(w.admin, 'POST', '/imports', { source: 'fub_api', apiKey: key2 });
    await call(w.admin, 'POST', `/imports/${r.body.batch.id}/snapshot`);
    await ih.drain();
    await mapUnmappedStages(w.admin, r.body.batch.id, 'nurture', { fields: FIELDS });
    const dr = await dryRunContacts(w, r.body.batch.id);
    expect((await approve(w.admin, r.body.batch.id, 'contacts', dr.dryRunSha256 as string)).status).toBe(200);
    await commitStage(ih, w.admin, r.body.batch.id, 'contacts');
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM contact_tags ct JOIN contacts c ON c.id = ct.contact_id WHERE c.tenant_id = $1`, [w.tenantId]))[0]!.n).toBe(links);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM contact_field_values WHERE tenant_id = $1`, [w.tenantId]))[0]!.n).toBe(values);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM custom_field_defs WHERE tenant_id = $1`, [w.tenantId]))[0]!.n).toBe(5);
  }, 60_000);

  it('the golden fixture still imports with its tags in the catalog (R-PAR-10 regression)', async () => {
    const { w, b } = await freshWorld(fubFixture({ prefix: 7700, phoneSeed: 7 }));
    await commitContacts(w, b.id, { 'Waiting On Lender': 'new' }, {}, [{ sourceRef: 'fub:people/7701', decision: 'import' }]);
    const jane = await contactId(w.tenantId, 'Jane');
    expect(await tagNames(jane)).toEqual(['Buyer', 'FUB stage: Hot Prospect', 'Pre-approved']);
  });
});
