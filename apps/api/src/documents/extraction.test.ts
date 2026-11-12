// Contract-date extraction and the claim decisions through module 31, on real Postgres with the fake scanner and PDF
// reader (R-DOC-2, R-DOC-10, R-TXN-1, R-AST-1, R-AST-19, R-AST-21; E131, E159, E412-E418). Synthetic contracts only.
import { formatEvidence } from '@realty/core/assistant';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { freshReauth } from '../admin/testing.js';
import { putTemplates, template } from '../transactions/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { COPY } from './copy.js';
import { extractDocument, writeProposalInTx } from './extract.js';
import { EXTRACTOR_NOT_SET_UP, UnconfiguredTextExtractor } from './provider.js';
import { DOCUMENT_JOBS } from './types.js';
import { type DocWorld, call, docDeps, docWorld, jobsOf, jpegBytes, makeDeal, pdfBytes, runScan, upload } from './testing.js';

let h: ApiHarness;
let w: DocWorld;

const CONTRACT_PAGES = [
  { page: 1, text: 'RESIDENTIAL PURCHASE AGREEMENT (synthetic test form)\nEffective Date: 01/05/2027\nThe Buyer and the Seller agree as follows.' },
  { page: 2, text: 'Inspection Period: 10 days after the Effective Date.\nAppraisal deadline: January 20, 2027\nLoan Commitment: 2027-01-25' },
  { page: 3, text: 'Closing Date: 2/12/27 or sooner by agreement.\nPossession: at closing.' },
];

beforeAll(async () => {
  h = await createApiHarness();
  w = await docWorld(h);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

interface ExtractionBody {
  action: { id: string; status: string; outcome: string | null; text: string | null } | null;
  claims: { id: string; text: string; milestone: { kind: string; label: string; dueOn: string } | null; page: number | null; needsReview: boolean; reviewNote: string | null; reviewStatus: string; evidence: { snippet: string | null; verified: boolean; line: string | null; locator: { page: number; start: number; end: number } }[]; liveDates: { dateId: string; dueOn: string; source: string }[]; appliedDateId: string | null; appliedNote: string | null }[];
  relativeDeadlineText: string | null;
  document: { extraction: { status: string; text: string | null } };
  dateId?: string | null;
  error?: { code: string };
}

const rows = async (q: string, v: unknown[] = []) => (await h.su.query(q, v)).rows;
const sys = () => systemActor(w.tenantId, 'worker');
const runExtract = (id: string, deps = docDeps(h)) => extractDocument(deps, sys(), (fn) => withTenantTx(sys(), fn, { db: deps.db }), id);

/** A clean contract uploaded by `by` to the deal, read by the fake PDF reader. */
async function contract(by = w.tc, dealId?: string, pages = CONTRACT_PAGES): Promise<{ dealId: string; documentId: string }> {
  const d = dealId ?? (await makeDeal(w, w.agents[0]!)).dealId;
  const bytes = pdfBytes();
  h.providers.textExtractor.register(bytes, pages);
  const r = await upload(by, `/deals/${d}/documents`, { bytes });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await runScan(h, w.tenantId, r.body.document.id);
  return { dealId: d, documentId: r.body.document.id };
}
const extraction = (c: Parameters<typeof call>[0], id: string) => call<ExtractionBody>(c, 'GET', `/documents/${id}/extraction`);
const confirm = (c: Parameters<typeof call>[0], id: string, claimId: string, target: unknown = { kind: 'new' }, commandId = randomUUID()) =>
  call<ExtractionBody>(c, 'POST', `/documents/${id}/extraction/claims/${claimId}/confirm`, { commandId, target });
const reject = (c: Parameters<typeof call>[0], id: string, claimId: string) => call<ExtractionBody>(c, 'POST', `/documents/${id}/extraction/claims/${claimId}/reject`, { commandId: randomUUID() });

describe('the accept path (PHASE2_3_PLAN §5.4 #42)', () => {
  it('R-DOC-2 R-TXN-1 R-DOC-10: a TC uploads a text-layer contract; it scans clean in one job; each date shows its page and quote; the TC confirms them one by one; each date is a document date confirmed by the TC citing its claim; nothing else changed and nothing was sent', async () => {
    const { dealId, documentId } = await contract();
    expect((await jobsOf(h, w.tenantId, DOCUMENT_JOBS.extract)).filter((j) => j.payload.documentId === documentId)).toHaveLength(1);
    const before = await rows('SELECT (SELECT row_to_json(d) FROM deals d WHERE id = $1)::text AS deal, (SELECT count(*)::int FROM messages WHERE tenant_id = $2) AS msgs', [dealId, w.tenantId]);
    expect(await runExtract(documentId)).toEqual({ result: 'proposed', outcome: 'dates', claims: 4 });
    const v = await extraction(w.tc, documentId);
    expect(v.status).toBe(200);
    expect(v.body.action).toMatchObject({ status: 'proposed', outcome: 'dates', text: COPY.extractionExplanation });
    expect(v.body.relativeDeadlineText).toBe(COPY.relativeDeadline);
    expect(v.body.claims.map((c) => [c.milestone?.kind, c.milestone?.dueOn, c.page, c.needsReview])).toEqual([
      ['acceptance', '2027-01-05', 1, false],
      ['appraisal', '2027-01-20', 2, false],
      ['financing', '2027-01-25', 2, false],
      ['closing', '2027-02-12', 3, false],
    ]);
    for (const c of v.body.claims) {
      const e = c.evidence[0]!;
      const pageText = CONTRACT_PAGES.find((p) => p.page === c.page)!.text;
      expect(e.snippet).toBe(pageText.slice(e.locator.start, e.locator.end));
      expect(e.verified).toBe(true);
      expect(e.line).toBe(`“${e.snippet}” in the document`);
    }
    for (const c of v.body.claims) {
      const r = await confirm(w.tc, documentId, c.id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const dates = await rows('SELECT kind, due_on::text AS due_on, source, status, confirmed_by_user_id, evidence_claim_id, basis FROM deal_dates WHERE deal_id = $1 ORDER BY due_on', [dealId]);
    expect(dates.map((d) => [d.kind, d.due_on, d.source, d.status, d.confirmed_by_user_id])).toEqual([
      ['acceptance', '2027-01-05', 'document', 'confirmed', w.tc.userId],
      ['appraisal', '2027-01-20', 'document', 'confirmed', w.tc.userId],
      ['financing', '2027-01-25', 'document', 'confirmed', w.tc.userId],
      ['closing', '2027-02-12', 'document', 'confirmed', w.tc.userId],
    ]);
    expect(dates.map((d) => d.evidence_claim_id).sort()).toEqual(v.body.claims.map((c) => c.id).sort());
    expect(dates.every((d) => d.basis.kind === 'document' && v.body.claims.some((c) => c.id === d.basis.claimId))).toBe(true);
    const after = await extraction(w.tc, documentId);
    expect(after.body.action!.status).toBe('executed');
    expect(after.body.claims.every((c) => c.reviewStatus === 'confirmed' && c.appliedDateId !== null)).toBe(true);
    const now = await rows('SELECT (SELECT row_to_json(d) FROM deals d WHERE id = $1)::text AS deal, (SELECT count(*)::int FROM messages WHERE tenant_id = $2) AS msgs', [dealId, w.tenantId]);
    expect(now).toEqual(before);
    expect(h.providers.email.sent ?? []).toEqual([]);
  });

  it('E159 R-DOC-2: an image-only PDF says "No text found in this PDF; enter the dates by hand" and proposes nothing', async () => {
    const { documentId } = await contract(w.tc, undefined, [{ page: 1, text: '   ' }]);
    expect(await runExtract(documentId)).toEqual({ result: 'proposed', outcome: 'no_text', claims: 0 });
    const v = await extraction(w.tc, documentId);
    expect(v.body.action).toMatchObject({ outcome: 'no_text', text: 'No text found in this PDF; enter the dates by hand' });
    expect(v.body.claims).toEqual([]);
    // an unregistered PDF is the fake's no_text too
    const d = await makeDeal(w, w.agents[0]!);
    const r = await upload(w.tc, `/deals/${d.dealId}/documents`);
    await runScan(h, w.tenantId, r.body.document.id);
    expect(await runExtract(r.body.document.id)).toMatchObject({ outcome: 'no_text' });
  });

  it('R-DOC-2: no dates next to the labels, and an unreadable PDF, say so and propose nothing', async () => {
    const a = await contract(w.tc, undefined, [{ page: 1, text: 'This synthetic page names no milestones.' }]);
    expect(await runExtract(a.documentId)).toMatchObject({ outcome: 'no_dates', claims: 0 });
    expect((await extraction(w.tc, a.documentId)).body.action!.text).toBe(COPY.noDates);
    const d = await makeDeal(w, w.agents[0]!);
    const bytes = pdfBytes();
    h.providers.textExtractor.register(bytes, { status: 'unreadable' });
    const r = await upload(w.tc, `/deals/${d.dealId}/documents`, { bytes });
    await runScan(h, w.tenantId, r.body.document.id);
    expect(await runExtract(r.body.document.id)).toMatchObject({ outcome: 'unreadable' });
    expect((await extraction(w.tc, r.body.document.id)).body.action!.text).toBe(COPY.unreadable);
  });

  it('E418 R-DOC-2: a photo is never read, and with no PDF reader nothing is written; the view says why', async () => {
    const d = await makeDeal(w, w.agents[0]!);
    const photo = await upload(w.tc, `/deals/${d.dealId}/documents`, { bytes: jpegBytes(), type: 'image/jpeg', filename: 'scan.jpg' });
    await runScan(h, w.tenantId, photo.body.document.id);
    expect((await jobsOf(h, w.tenantId, DOCUMENT_JOBS.extract)).some((j) => j.payload.documentId === photo.body.document.id)).toBe(false);
    expect(await runExtract(photo.body.document.id)).toEqual({ result: 'not_eligible' });
    expect((await extraction(w.tc, photo.body.document.id)).body.document.extraction).toMatchObject({ status: 'photo', text: COPY.photo });
    const p = h.app.platform.providers as unknown as { textExtractor: unknown };
    const saved = p.textExtractor;
    p.textExtractor = new UnconfiguredTextExtractor();
    try {
      const r = await upload(w.tc, `/deals/${d.dealId}/documents`);
      const deps = { ...docDeps(h), providers: p as never };
      await runScan(h, w.tenantId, r.body.document.id, deps);
      expect((await jobsOf(h, w.tenantId, DOCUMENT_JOBS.extract)).some((j) => j.payload.documentId === r.body.document.id)).toBe(false);
      expect(await runExtract(r.body.document.id, deps)).toEqual({ result: 'not_configured' });
      const v = await extraction(w.tc, r.body.document.id);
      expect(v.body).toMatchObject({ action: null, claims: [], document: { extraction: { status: 'not_set_up', text: EXTRACTOR_NOT_SET_UP } } });
      expect(await rows("SELECT 1 FROM assistant_actions WHERE dedupe_key = $1", [`contract_extraction:${r.body.document.id}`])).toEqual([]);
    } finally {
      p.textExtractor = saved;
    }
    // a listing document is never read either
    expect(await runExtract(randomUUID())).toEqual({ result: 'not_eligible' });
  });

  it('R-AST-19: the action is a requires-approval contract proposal owned by the uploader, with no contact, ids-only trigger_ref and the finder version', async () => {
    const { dealId, documentId } = await contract();
    await runExtract(documentId);
    const a = (await rows("SELECT kind, action_category, autonomy, status, owner_user_id, contact_id, trigger_ref, payload, dedupe_key FROM assistant_actions WHERE dedupe_key = $1", [`contract_extraction:${documentId}`]))[0]!;
    expect(a).toMatchObject({ kind: 'contract_extraction', action_category: 'contract', autonomy: 'requires_approval', status: 'proposed', owner_user_id: w.tc.userId, contact_id: null, trigger_ref: { documentId, dealId } });
    expect(a.payload).toMatchObject({ documentId, dealId, outcome: 'dates', pageCount: 3, finder: 'labels/1', extractor: { version: 'fake-extractor/1' } });
    const claims = await rows('SELECT text, structured FROM assistant_claims c JOIN assistant_actions a ON a.id = c.action_id WHERE a.dedupe_key = $1', [`contract_extraction:${documentId}`]);
    for (const c of claims) {
      expect(c.text.length).toBeLessThanOrEqual(300);
      expect(Object.keys(c.structured).sort()).toEqual(['milestone', 'page']);
    }
  });
});

describe('claim decisions (deliverable 7)', () => {
  it('E131 E417 R-AST-1 R-DOC-10: an injected candidate whose quote is not in the PDF, or whose date differs, is needs_review: confirm is refused, nothing is written, and raw SQL hits DEAL_DATE_EVIDENCE_INVALID', async () => {
    const d = await makeDeal(w, w.agents[0]!);
    const r = await upload(w.tc, `/deals/${d.dealId}/documents`);
    const documentId = r.body.document.id;
    await runScan(h, w.tenantId, documentId);
    const deps = docDeps(h);
    const page = 'Closing Date: 03/01/2027';
    await withTenantTx(sys(), (tx) =>
      writeProposalInTx(tx, deps, { tenantId: w.tenantId, documentId, dealId: d.dealId, uploaderId: w.tc.userId!, uploadedAt: Date.now() as never }, { status: 'text', pages: [{ page: 1, text: page }] }, { engine: 'fake', version: 'fake/1' }, () => [
        { kind: 'closing', label: 'Closing', dueOn: '2027-04-01', page: 1, start: 0, end: 24, snippet: 'Closing Date: 04/01/2027' }, // E131: not in the PDF
        { kind: 'closing', label: 'Closing', dueOn: '2027-03-02', page: 1, start: 0, end: 24, snippet: page }, // E417: the quote's date is another
      ]),
    { db: h.database });
    const v = await extraction(w.tc, documentId);
    expect(v.body.claims.map((c) => [c.needsReview, c.reviewNote])).toEqual([[true, COPY.needsReview], [true, COPY.needsReview]]);
    for (const c of v.body.claims) expect((await confirm(w.tc, documentId, c.id)).code).toBe('EXTRACTION_CLAIM_NEEDS_REVIEW');
    expect(await rows('SELECT 1 FROM deal_dates WHERE deal_id = $1', [d.dealId])).toEqual([]);
    const raw = withTenantTx(w.tc.actor(), (tx) => sql`INSERT INTO deal_dates (tenant_id, id, deal_id, kind, due_on, source, status, confirmed_by_user_id, confirmed_at, evidence_claim_id)
        VALUES (app.tenant_id(), ${randomUUID()}, ${d.dealId}, 'closing', '2027-04-01', 'document', 'confirmed', app.user_id(), now(), ${v.body.claims[0]!.id})`.execute(tx), { db: h.database });
    await expect(raw).rejects.toThrow(/DEAL_DATE_EVIDENCE_INVALID/);
    // a needs_review claim may be dismissed; once every claim is reviewed with nothing confirmed, the proposal is rejected
    for (const c of v.body.claims) expect((await reject(w.tc, documentId, c.id)).status).toBe(200);
    expect((await extraction(w.tc, documentId)).body.action!.status).toBe('rejected');
  });

  it('E412 E413 R-TXN-1: confirming onto an existing date of the same kind moves it as the person\'s own move; the view lists the deal\'s dates of that kind and reads the applied date from evidence_claim_id; a later move by hand is said so', async () => {
    const d = await makeDeal(w, w.agents[0]!);
    const manual = await call<{ date: { id: string } }>(w.agents[0]!, 'POST', `/deals/${d.dealId}/dates`, { kind: 'closing', dueOn: '2027-02-28' });
    expect(manual.status).toBe(201);
    const { documentId } = await contract(w.tc, d.dealId);
    await runExtract(documentId);
    const v = await extraction(w.tc, documentId);
    const closing = v.body.claims.find((c) => c.milestone?.kind === 'closing')!;
    expect(closing.liveDates).toEqual([{ dateId: manual.body.date.id, label: null, dueOn: '2027-02-28', status: 'confirmed', source: 'manual' }]);
    const appraisal = v.body.claims.find((c) => c.milestone?.kind === 'appraisal')!;
    expect((await confirm(w.tc, documentId, appraisal.id, { kind: 'existing', dateId: manual.body.date.id })).code).toBe('EXTRACTION_TARGET_KIND');
    const r = await confirm(w.tc, documentId, closing.id, { kind: 'existing', dateId: manual.body.date.id });
    expect([r.status, r.body.dateId]).toEqual([200, manual.body.date.id]);
    const row = (await rows('SELECT due_on::text AS due_on, source, confirmed_by_user_id, due_version, evidence_claim_id FROM deal_dates WHERE id = $1', [manual.body.date.id]))[0]!;
    expect(row).toEqual({ due_on: '2027-02-12', source: 'document', confirmed_by_user_id: w.tc.userId, due_version: 2, evidence_claim_id: closing.id });
    expect((await rows("SELECT 1 FROM jobs WHERE kind = 'milestones.date_changed' AND payload->>'dealDateId' = $1", [manual.body.date.id])).length).toBe(1);
    expect((await extraction(w.tc, documentId)).body.claims.find((c) => c.id === closing.id)).toMatchObject({ appliedDateId: manual.body.date.id, appliedNote: null });
    expect((await call(w.agents[0]!, 'PATCH', `/deal-dates/${manual.body.date.id}`, { dueOn: '2027-02-19' })).status).toBe(200);
    expect((await extraction(w.tc, documentId)).body.claims.find((c) => c.id === closing.id)).toMatchObject({ appliedDateId: manual.body.date.id, appliedNote: COPY.movedByPerson });
    // a completed date is not moved by a contract (core DATE_COMPLETED); another deal's date is NOT_FOUND
    const fin = v.body.claims.find((c) => c.milestone?.kind === 'financing')!;
    const done = await call<{ date: { id: string } }>(w.agents[0]!, 'POST', `/deals/${d.dealId}/dates`, { kind: 'financing', dueOn: '2027-01-26' });
    expect((await call(w.agents[0]!, 'PATCH', `/deal-dates/${done.body.date.id}`, { completed: true })).status).toBe(200);
    expect((await confirm(w.tc, documentId, fin.id, { kind: 'existing', dateId: done.body.date.id })).code).toBe('DATE_COMPLETED');
    const other = await makeDeal(w, w.agents[0]!);
    const foreign = await call<{ date: { id: string } }>(w.agents[0]!, 'POST', `/deals/${other.dealId}/dates`, { kind: 'financing', dueOn: '2027-01-26' });
    expect((await confirm(w.tc, documentId, fin.id, { kind: 'existing', dateId: foreign.body.date.id })).status).toBe(404);
  });

  it('E414 R-DOC-10: a replayed confirm returns the same date and writes nothing new', async () => {
    const { dealId, documentId } = await contract();
    await runExtract(documentId);
    const c = (await extraction(w.tc, documentId)).body.claims[0]!;
    const cmd = randomUUID();
    const a = await confirm(w.tc, documentId, c.id, { kind: 'new' }, cmd);
    const b = await confirm(w.tc, documentId, c.id, { kind: 'new' }, cmd);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body.dateId).toBe(a.body.dateId);
    expect(await rows('SELECT id FROM deal_dates WHERE deal_id = $1', [dealId])).toHaveLength(1);
  });

  it('E415 R-DOC-2: a new version that scans clean supersedes the old version\'s open extraction; its claims are closed', async () => {
    const { dealId, documentId } = await contract();
    await runExtract(documentId);
    const c = (await extraction(w.tc, documentId)).body.claims[0]!;
    const v2bytes = pdfBytes();
    h.providers.textExtractor.register(v2bytes, CONTRACT_PAGES);
    const v2 = await upload(w.tc, `/documents/${documentId}/versions`, { bytes: v2bytes });
    // still pending: the old proposal is open
    expect((await extraction(w.tc, documentId)).body.action!.status).toBe('proposed');
    await runScan(h, w.tenantId, v2.body.document.id);
    expect((await extraction(w.tc, documentId)).body.action!.status).toBe('superseded');
    expect((await confirm(w.tc, documentId, c.id)).code).toBe('EXTRACTION_CLOSED');
    expect(await rows('SELECT 1 FROM deal_dates WHERE deal_id = $1', [dealId])).toEqual([]);
    expect(await runExtract(v2.body.document.id)).toMatchObject({ result: 'proposed' });
  });

  it('R-DOC-10: a non-uploader member gets 404 on the extraction but sees the confirmed date on the deal', async () => {
    const { dealId, documentId } = await contract(w.tc);
    await runExtract(documentId);
    const c = (await extraction(w.tc, documentId)).body.claims[0]!;
    expect((await confirm(w.tc, documentId, c.id)).status).toBe(200);
    for (const m of [w.agents[0]!, w.isa]) {
      expect((await extraction(m, documentId)).status, m.role ?? '').toBe(404);
      expect((await confirm(m, documentId, c.id)).status).toBe(404);
    }
    const ms = await call<{ dates: { source: string; dueOn: string }[] }>(w.agents[0]!, 'GET', `/deals/${dealId}/milestones`);
    expect(ms.status).toBe(200);
    expect(JSON.stringify(ms.body)).toContain(c.milestone!.dueOn);
    // the Owner (tenant-wide) reads it
    expect((await extraction(w.owner, documentId)).status).toBe(200);
  });

  it('R-AST-21: the generic approve only acknowledges a contract extraction (no date); its claims stay decidable; status transitions follow the claims', async () => {
    const { dealId, documentId } = await contract();
    await runExtract(documentId);
    const v = await extraction(w.tc, documentId);
    const ap = await call<{ status: string; result: string }>(w.tc, 'POST', `/assistant/actions/${v.body.action!.id}/approve`, { commandId: randomUUID() });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(ap.body).toMatchObject({ status: 'approved', result: 'acknowledged' });
    expect(await rows('SELECT 1 FROM deal_dates WHERE deal_id = $1', [dealId])).toEqual([]);
    const [c1, c2, ...rest] = v.body.claims;
    expect((await confirm(w.tc, documentId, c1!.id)).status).toBe(200);
    expect((await extraction(w.tc, documentId)).body.action!.status).toBe('approved');
    expect((await reject(w.tc, documentId, c2!.id)).status).toBe(200);
    expect((await confirm(w.tc, documentId, c2!.id)).code).toBe('EXTRACTION_CLAIM_DECIDED');
    for (const c of rest) await reject(w.tc, documentId, c.id);
    expect((await extraction(w.tc, documentId)).body.action!.status).toBe('executed');
    expect((await confirm(w.tc, documentId, c1!.id)).status).toBe(200); // a replay of the confirmed one
  });

  it('R-AST-21: proposed → approved on the first confirm; proposed → rejected when every verified claim is rejected', async () => {
    const a = await contract();
    await runExtract(a.documentId);
    const va = await extraction(w.tc, a.documentId);
    await confirm(w.tc, a.documentId, va.body.claims[0]!.id);
    const s = (await rows('SELECT status, decided_by_user_id, decided_by_role FROM assistant_actions WHERE id = $1', [va.body.action!.id]))[0]!;
    expect(s).toEqual({ status: 'approved', decided_by_user_id: w.tc.userId, decided_by_role: 'tc' });
    const b = await contract();
    await runExtract(b.documentId);
    const vb = await extraction(w.tc, b.documentId);
    for (const c of vb.body.claims) await reject(w.tc, b.documentId, c.id);
    expect((await rows('SELECT status, decided_by_user_id FROM assistant_actions WHERE id = $1', [vb.body.action!.id]))[0]).toEqual({ status: 'rejected', decided_by_user_id: w.tc.userId });
    expect((await confirm(w.tc, b.documentId, vb.body.claims[0]!.id)).code).toBe('EXTRACTION_CLAIM_DECIDED');
  });

  it('R-DOC-2: POST /extraction/run reads a clean contract once (uploader or tenant-wide), then EXTRACTION_EXISTS; others get 404', async () => {
    const { documentId } = await contract(w.tc);
    expect((await call(w.agents[0]!, 'POST', `/documents/${documentId}/extraction/run`)).status).toBe(404);
    const r = await call<ExtractionBody>(w.tc, 'POST', `/documents/${documentId}/extraction/run`);
    expect([r.status, r.body.action?.outcome]).toEqual([200, 'dates']);
    expect((await call(w.tc, 'POST', `/documents/${documentId}/extraction/run`)).code).toBe('EXTRACTION_EXISTS');
    expect(await runExtract(documentId)).toEqual({ result: 'exists' });
  });

  it('R-TXN-1 R-DOC-10 (module 31 fromDocument): a template proposal confirmed from the contract becomes a document date and loses its template basis', async () => {
    await freshReauth(h, w.owner);
    expect((await putTemplates(w.owner, [template()])).status).toBe(200);
    const d = await makeDeal(w, w.agents[0]!);
    const plan = await call(w.agents[0]!, 'POST', `/deals/${d.dealId}/milestones/plan`, { acceptanceDate: '2027-01-05', templateId: 'purchase-test', templateVersion: 1 });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    const proposed = (await rows("SELECT id, basis FROM deal_dates WHERE deal_id = $1 AND kind = 'closing'", [d.dealId]))[0]!;
    expect(proposed.basis.kind).toBe('template');
    const { documentId } = await contract(w.tc, d.dealId);
    await runExtract(documentId);
    const closing = (await extraction(w.tc, documentId)).body.claims.find((c) => c.milestone?.kind === 'closing')!;
    expect((await confirm(w.tc, documentId, closing.id, { kind: 'existing', dateId: proposed.id })).status).toBe(200);
    const row = (await rows('SELECT source, status, basis, evidence_claim_id, due_on::text AS due_on FROM deal_dates WHERE id = $1', [proposed.id]))[0]!;
    expect(row).toMatchObject({ source: 'document', status: 'confirmed', evidence_claim_id: closing.id, due_on: '2027-02-12' });
    expect(row.basis).toMatchObject({ kind: 'document', claimId: closing.id, dueRule: 'end_of_local_day' });
    expect(Object.keys(row.basis)).not.toContain('templateId');
  });

  it('R-AST-2: the generic evidence line names the document', () => {
    expect(formatEvidence({ sourceType: 'document', sourceId: randomUUID(), locator: { kind: 'char_range', start: 0, end: 5 }, snippet: 'Closing Date: 2/12/27' })).toBe('“Closing Date: 2/12/27” in the document');
  });
});
