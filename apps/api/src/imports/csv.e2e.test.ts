// api/imports CSV path (R-IMPORT-13, R-IMPORT-7, R-CONSENT-1, R-CONSENT-3; E39, E41, E45).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BatchView,
  type ImportWorld,
  type ImportsHarness,
  approve,
  batchOf,
  call,
  commitStage,
  csvBase64,
  csvOf,
  dryRunStage,
  importWorld,
  importsHarness,
  records,
  stageOf,
  verify,
} from './testing.js';

let ih: ImportsHarness;
let w: ImportWorld;
const q = async <T = Record<string, unknown>>(text: string, args: unknown[] = []) => (await ih.h.su.query(text, args)).rows as T[];

beforeAll(async () => {
  ih = await importsHarness();
  w = await importWorld(ih);
});
afterAll(async () => {
  await ih?.close();
});

async function upload(text: string, fileName = 'leads.csv'): Promise<BatchView> {
  const r = await call<{ batch: BatchView }>(w.admin, 'POST', '/imports', { source: 'csv', fileName, fileBase64: csvBase64(text) });
  if (r.status !== 201) throw new Error(`upload: ${r.status} ${JSON.stringify(r.body)}`);
  expect(r.body.batch.stages.map((s) => s.category)).toEqual(['contacts', 'consent']);
  expect((await call(w.admin, 'POST', `/imports/${r.body.batch.id}/snapshot`)).status).toBe(202);
  await ih.drain();
  return batchOf(w.admin, r.body.batch.id);
}

async function commitAll(b: BatchView, cat: 'contacts' | 'consent', decide: (r: { id: string; dryRunOutcome: string | null }) => 'import' | 'reject' | null = () => null): Promise<void> {
  const d = await dryRunStage(ih, w.admin, b.id, cat);
  for (const r of await records(w.admin, b.id, cat)) {
    const x = r.dryRunOutcome === 'needs_review' ? decide(r) : null;
    if (x) await call(w.admin, 'POST', `/imports/${b.id}/records/${r.id}/review`, { decision: x });
  }
  expect((await approve(w.admin, b.id, cat, d.dryRunSha256 as string)).status).toBe(200);
  await commitStage(ih, w.admin, b.id, cat);
  expect((await verify(w.admin, b.id, cat)).res.status).toBe(200);
}

describe('CSV import', () => {
  it('R-IMPORT-13: a CSV file holds at most 50,000 rows (refused at upload, nothing stored)', async () => {
    const big = csvOf(50_001);
    const r = await call(w.admin, 'POST', '/imports', { source: 'csv', fileName: 'big.csv', fileBase64: csvBase64(big) });
    expect([r.status, r.code]).toEqual([422, 'IMPORT_FILE_INVALID']);
    expect((r.body as { error: { details: { reason: string; limit: number } } }).error.details).toMatchObject({ reason: 'CSV_TOO_MANY_ROWS', limit: 50_000 });
    expect(await q('SELECT 1 FROM import_batches WHERE tenant_id = $1', [w.tenantId])).toHaveLength(0);
    const empty = await call(w.admin, 'POST', '/imports', { source: 'csv', fileName: 'empty.csv', fileBase64: csvBase64('   \n') });
    expect([empty.status, empty.code]).toEqual([422, 'IMPORT_FILE_INVALID']);
  }, 60_000);

  it('R-IMPORT-13 E45: phones normalize with the tenant default country; "555-0100" is rejected PHONE_INVALID with its reason in the review list', async () => {
    const b = await upload('First Name,Last Name,Mobile Phone,Email\nAnn,One,(415) 301-0001,\nBen,Two,555-0100,ben.two@example.com\n,,555-0100,\n', 'e45.csv');
    expect(b.connectionTest[0]).toBe('3 contacts found in your file.');
    const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
    expect(d.counts).toMatchObject({ source: 3, willImport: 1, needsReview: 1, rejected: 1 });
    const recs = await records(w.admin, b.id, 'contacts');
    const ann = recs.find((r) => r.sourceRef === 'e45.csv#row=2')!;
    expect(ann.record).toMatchObject({ phones: ['+14153010001'] });
    const ben = recs.find((r) => r.sourceRef === 'e45.csv#row=3')!;
    expect(ben.issues.find((i) => i.code === 'PHONE_INVALID')!.sentence).toMatch(/area code/);
    const cal = recs.find((r) => r.sourceRef === 'e45.csv#row=4')!;
    expect(cal.dryRunOutcome).toBe('rejected');
    expect(cal.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['PHONE_INVALID', 'NO_IDENTITY']));
    const rej = await records(w.admin, b.id, 'contacts', 'rejected');
    expect(rej.map((r) => r.sourceRef)).toEqual(['e45.csv#row=4']);
  });

  it('R-IMPORT-13 R-CONSENT-3: a CSV consent column yields only imported_unverified grants or revocations, with row-level provenance', async () => {
    const b = await upload('First Name,Last Name,Mobile Phone,Email,SMS Opt In,Unsubscribed\nDee,Four,(415) 302-0001,dee@example.com,yes,\nEve,Five,(415) 302-0002,eve@example.com,,yes\n', 'consent.csv');
    await commitAll(b, 'contacts');
    await commitAll(b, 'consent');
    const ev = await q<{ event_type: string; consent_level: string; channel: string; source: string; original_provenance: { sourceRef: string } }>(
      'SELECT event_type, consent_level, channel, source, original_provenance FROM consent_events WHERE tenant_id = $1 ORDER BY event_type, channel',
      [w.tenantId],
    );
    expect(ev).toEqual([
      { event_type: 'grant', consent_level: 'imported_unverified', channel: 'sms', source: 'import_csv', original_provenance: expect.objectContaining({ sourceRef: 'consent.csv#row=2' }) },
      { event_type: 'revoke', consent_level: 'none', channel: 'email', source: 'import_csv', original_provenance: expect.objectContaining({ sourceRef: 'consent.csv#row=3' }) },
    ]);
    const rep = await call<{ categories: { category: string; lines: string[] }[] }>(w.admin, 'GET', `/imports/${b.id}/report`);
    expect(rep.body.categories.find((c) => c.category === 'consent')!.lines.join(' ')).toMatch(/1 contact had texting permission in your file\./);
  });

  it('E39 R-CONSENT-1: a contact deleted then re-imported from an old CSV stays opted out ("will stay opted out")', async () => {
    const c = await call<{ contact: { id: string } }>(w.agents[0]!, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Fay', lastName: 'Six', phones: ['+14153030001'] });
    expect([200, 201]).toContain(c.status);
    const pid = (await q<{ id: string }>("SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [c.body.contact.id]))[0]!.id;
    const rv = await call(w.agents[0]!, 'POST', `/contacts/${c.body.contact.id}/consent`, { kind: 'revoke', pointId: pid, channel: 'sms', purpose: 'all', evidence: { note: 'asked us to stop texting' } });
    expect(rv.status).toBe(200);
    const del = await call(w.agents[0]!, 'POST', `/leads/${c.body.contact.id}/delete`, { commandId: randomUUID() });
    expect(del.status).toBe(200);
    const b = await upload('First Name,Last Name,Mobile Phone,SMS Opt In\nFay,Six,(415) 303-0001,yes\n', 'old.csv');
    await dryRunStage(ih, w.admin, b.id, 'contacts');
    const r = (await records(w.admin, b.id, 'contacts'))[0]!;
    expect(r.planned).toBe('create'); // a deleted contact never absorbs an import
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['ADDRESS_OPTED_OUT', 'MATCH_DELETED_CONTACT']));
    expect(r.optOutNote).toBe('Opted out of texts. Will stay opted out.');
    await commitAll(b, 'contacts');
    await dryRunStage(ih, w.admin, b.id, 'consent');
    const cr = (await records(w.admin, b.id, 'consent'))[0]!;
    expect(cr.optOutNote).toBe('Opted out of texts. Will stay opted out.');
    await commitAll(b, 'consent');
    const hmac = (await q<{ h: Buffer }>("SELECT address_hmac AS h FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [c.body.contact.id]))[0]!.h;
    const state = await q<{ status: string }>("SELECT status FROM consent_state WHERE tenant_id = $1 AND address_hmac = $2 AND channel = 'sms'", [w.tenantId, hmac]);
    expect(state.length).toBeGreaterThan(0);
    for (const s of state) expect(s.status).toBe('revoked');
  });

  it('R-IMPORT-7 E41 R-OWN-21: name-only matches are never merged (a duplicate candidate); an exact email match attaches, fills only empty fields and keeps the owner', async () => {
    // a pond contact (no owner) with an email, and an agent's contact with a name
    const pond = await call<{ contact: { id: string } }>(w.agents[1]!, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Gus', emails: ['gus@example.com'] });
    const seq = (await q<{ ownership_seq: string }>('SELECT ownership_seq FROM contacts WHERE id = $1', [pond.body.contact.id]))[0]!.ownership_seq;
    const rel = await call(w.agents[1]!, 'POST', `/leads/${pond.body.contact.id}/release`, { commandId: randomUUID(), reason: 'not_a_fit', expectedSeq: Number(seq) });
    expect(rel.status).toBe(200);
    const named = await call<{ contact: { id: string } }>(w.agents[0]!, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Hal', lastName: 'Eight', phones: ['+14153040009'] });
    expect([200, 201]).toContain(named.status);
    const b = await upload('First Name,Last Name,Mobile Phone,Email\nGus,Seven,(415) 304-0001,gus@example.com\nHal,Eight,(415) 304-0002,\n', 'match.csv');
    const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
    expect(d.counts).toMatchObject({ willImport: 2, needsReview: 0 });
    const recs = await records(w.admin, b.id, 'contacts');
    const gus = recs.find((r) => r.sourceRef === 'match.csv#row=2')!;
    expect([gus.planned, gus.matchContactId]).toEqual(['attach', pond.body.contact.id]);
    const hal = recs.find((r) => r.sourceRef === 'match.csv#row=3')!;
    expect(hal.planned).toBe('create');
    expect(hal.duplicateCandidates.map((x) => x.contactId)).toEqual([named.body.contact.id]);
    expect((await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string)).status).toBe(200);
    await commitStage(ih, w.admin, b.id, 'contacts');
    const g = (await q<{ last_name: string | null; first_name: string; ownership_state: string; phones: string[] }>(
      "SELECT last_name, first_name, ownership_state, (SELECT array_agg(address) FROM contact_points p WHERE p.contact_id = c.id AND p.kind = 'phone') AS phones FROM contacts c WHERE id = $1",
      [pond.body.contact.id],
    ))[0]!;
    expect(g).toEqual({ first_name: 'Gus', last_name: 'Seven', ownership_state: 'in_pond', phones: ['+14153040001'] });
    const hals = await q<{ id: string }>("SELECT id FROM contacts WHERE tenant_id = $1 AND first_name = 'Hal' AND last_name = 'Eight'", [w.tenantId]);
    expect(hals).toHaveLength(2); // never merged
    const dup = await q<{ match_reason: string; status: string }>('SELECT match_reason, status FROM contact_duplicate_candidates WHERE tenant_id = $1 AND (contact_a_id = $2 OR contact_b_id = $2)', [w.tenantId, named.body.contact.id]);
    expect(dup).toEqual([{ match_reason: 'import', status: 'open' }]);
  });

  it('a new column mapping resets the uncommitted CSV dry runs', async () => {
    const b = await upload('Name,Phone\nIvy Nine,(415) 305-0001\n', 'map.csv');
    const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
    expect(d.status).toBe('dry_run_ready');
    const r = await call<{ batch: BatchView }>(w.admin, 'PUT', `/imports/${b.id}/csv-mapping`, { mapping: [{ field: 'full_name' }, { field: 'ignore' }] });
    expect(r.status).toBe(200);
    expect(stageOf(r.body.batch, 'contacts').status).toBe('pending');
    const again = await dryRunStage(ih, w.admin, b.id, 'contacts');
    expect((await records(w.admin, b.id, 'contacts'))[0]!.record).toMatchObject({ phones: [] });
    expect(again.dryRunSha256).not.toBe(d.dryRunSha256);
  });
});
