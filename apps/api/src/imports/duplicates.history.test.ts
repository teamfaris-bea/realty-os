// B6 (R-IMPORT-4): history of a person whose contacts record was skipped as a duplicate, end to end through the
// real server and Postgres with the fake Follow Up Boss (found by the FUB migration journeys lane, M6).
//
// A skipped duplicate writes nothing at the contacts commit, not even an external_ref, so its notes, texts and
// calls used to be planned `will_import` by the dry run and then fail at commit (COMMIT_FAILED / PARENT_NOT_FOUND).
// Now the dry run puts them on the contact the skip points at, the earlier row's contact for an in-file duplicate
// or the existing contact for an exact match with nothing new to fill, names it, and the commit does exactly that.
// Undo stays exact and a re-run writes nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Category } from '@realty/core/import';
import type { FubDataset } from './fub.js';
import { command } from '../leads/testing.js';
import { type ImportWorld, type ImportsHarness, type StageView, approve, batchOf, call, commitStage, dryRunStage, fullStage, importWorld, importsHarness, records, stageOf, startFub, verify } from './testing.js';

let ih: ImportsHarness;
let w: ImportWorld;
const q = async <T = Record<string, unknown>>(text: string, args: unknown[] = []) => (await ih.h.su.query(text, args)).rows as T[];

beforeAll(async () => {
  ih = await importsHarness();
  w = await importWorld(ih);
}, 180_000);
afterAll(async () => {
  await ih?.close();
});

const valid = (value: string, type = 'mobile') => ({ value, type, status: 'Valid' });
const contactOfRef = async (ref: string) => (await q<{ entity_id: string }>("SELECT entity_id FROM external_refs WHERE tenant_id = $1 AND system = 'fub' AND entity_type = 'contact' AND external_id = $2", [w.tenantId, ref]))[0]?.entity_id ?? null;
const failedOf = (stageId: string) => q<{ source_ref: string; detail: string }>(`SELECT r.source_ref, i->>'detail' AS detail FROM import_records r, jsonb_array_elements(r.issues) i WHERE r.stage_id = $1 AND i->>'code' = 'COMMIT_FAILED'`, [stageId]);

/** A new batch of `key`: contacts dry run → approve → commit → verify, then the ownership stage skipped. */
async function contactsCommitted(key: string): Promise<{ batchId: string; contacts: StageView }> {
  const b = await startFub(ih, w.admin, key);
  const contacts = await fullStage(ih, w.admin, b.id, 'contacts');
  expect((await call(w.admin, 'POST', `/imports/${b.id}/stages/ownership/skip`)).status).toBe(200);
  return { batchId: b.id, contacts };
}

/** One history stage: the dry run the Admin approves (its counts and records), then the commit and the verification. */
async function history(batchId: string, cat: Category) {
  const planned = await dryRunStage(ih, w.admin, batchId, cat);
  const recs = await records(w.admin, batchId, cat);
  expect((await approve(w.admin, batchId, cat, planned.dryRunSha256 as string)).status).toBe(200);
  const committed = await commitStage(ih, w.admin, batchId, cat);
  const verified = await verify(w.admin, batchId, cat);
  return { planned, recs, committed, failed: await failedOf(committed.id), verified: verified.res.status };
}

const CHAIN_PHONE = '(415) 820-0501';
const CHAIN: FubDataset = {
  users: [],
  people: [
    { id: 501, firstName: 'Cara', lastName: 'One', phones: [valid(CHAIN_PHONE)], emails: [valid('cara.one@example.com', 'home')] },
    { id: 502, firstName: 'Cara', lastName: 'Again', phones: [valid(CHAIN_PHONE)] }, // IN_FILE_DUPLICATE of 501
    // IN_FILE_DUPLICATE of 501 too, and this row says the shared phone opted out and carries a DNC tag
    { id: 503, firstName: 'Cara', lastName: 'Third', phones: [{ value: CHAIN_PHONE, type: 'mobile', status: 'Opted Out' }], tags: ['DNC'] },
  ],
  notes: [
    { id: 9501, personId: 501, body: 'Note on the first row', created: '2025-01-15T16:00:00Z' },
    { id: 9502, personId: 502, body: 'Note on the second row', created: '2025-01-15T16:05:00Z' },
    { id: 9503, personId: 503, body: 'Note on the third row', created: '2025-01-15T16:10:00Z' },
  ],
  textMessages: [{ id: 8502, personId: 502, created: '2025-03-01T18:00:00Z', isIncoming: true, message: 'Is the Elm St house still available?', status: 'Received' }],
  emails: [],
  calls: [{ id: 7503, personId: 503, created: '2025-04-04T15:00:00Z', isIncoming: false, duration: 90, outcome: 'Interested' }],
  recordings: {},
};

const EXACT_PHONE = '(415) 820-0601';
const EXACT_NEW_PHONE = '(415) 820-0602';
const EXACT_EMAIL = 'dee.one@example.com';
/** an earlier batch created Dee One */
const EARLIER: FubDataset = { users: [], people: [{ id: 601, firstName: 'Dee', lastName: 'One', phones: [valid(EXACT_PHONE)], emails: [valid(EXACT_EMAIL, 'home')] }], notes: [], textMessages: [], emails: [], calls: [], recordings: {} };
/** a second account: 701 is Dee One with nothing new (skipped), 702 matches her by email and adds a phone (attached) */
const LATER: FubDataset = {
  users: [],
  people: [
    { id: 701, firstName: 'Dee', lastName: 'One', phones: [valid(EXACT_PHONE)] },
    { id: 702, firstName: 'Dee', lastName: 'One', emails: [valid(EXACT_EMAIL, 'home')], phones: [valid(EXACT_NEW_PHONE, 'home')] },
  ],
  notes: [
    { id: 9701, personId: 701, body: 'Note on the skipped duplicate', created: '2025-02-01T16:00:00Z' },
    { id: 9702, personId: 702, body: 'Note on the attached record', created: '2025-02-01T16:05:00Z' },
  ],
  textMessages: [],
  emails: [],
  calls: [],
  recordings: {},
};

/** Everything an import can write for this tenant, counted. */
const footprint = async () =>
  (
    await q(
      `SELECT (SELECT count(*)::int FROM contacts WHERE tenant_id = $1) AS contacts,
              (SELECT count(*)::int FROM contact_points WHERE tenant_id = $1) AS points,
              (SELECT count(*)::int FROM notes WHERE tenant_id = $1) AS notes,
              (SELECT count(*)::int FROM messages WHERE tenant_id = $1) AS messages,
              (SELECT count(*)::int FROM calls WHERE tenant_id = $1) AS calls,
              (SELECT count(*)::int FROM consent_events WHERE tenant_id = $1) AS consent_events,
              (SELECT count(*)::int FROM suppressions WHERE tenant_id = $1) AS suppressions,
              (SELECT count(*)::int FROM external_refs WHERE tenant_id = $1) AS refs`,
      [w.tenantId],
    )
  )[0];

describe('B6 R-IMPORT-4: history of a person whose contacts record was a skipped duplicate', () => {
  let chainBatch: string;
  let c501: string;

  it('an in-file duplicate chain (three rows sharing a phone): the dry run puts the later rows’ notes, texts and calls on the first row’s contact and says so; the commit does exactly that; the duplicates’ opt-outs carry through the consent stage', async () => {
    ih.fub.add('b6-chain-key-0001', CHAIN);
    const { batchId, contacts } = await contactsCommitted('b6-chain-key-0001');
    chainBatch = batchId;
    expect(contacts.counts).toMatchObject({ source: 3, imported: 1, duplicate: 2 });
    c501 = (await contactOfRef('501')) as string;
    expect(c501).not.toBeNull();
    // a skipped duplicate gets no external_ref of its own: nothing of it is committed
    expect([await contactOfRef('502'), await contactOfRef('503')]).toEqual([null, null]);

    for (const [cat, n] of [['notes', 3], ['messages', 1], ['call_recordings', 1]] as const) {
      const r = await history(batchId, cat);
      expect({ cat, planned: r.planned.counts }).toMatchObject({ cat, planned: { source: n, willImport: n, rejected: 0 } });
      // the dry run names the contact and says why (the record's person was a duplicate of the first row)
      for (const x of r.recs) {
        const dup = !x.sourceRef.endsWith('/9501');
        expect({ ref: x.sourceRef, match: x.matchContactId, dup: x.issues.some((i) => i.code === 'PARENT_DUPLICATE') }).toEqual({ ref: x.sourceRef, match: c501, dup });
      }
      // the commit did exactly what the dry run said (R-IMPORT-4), and the recount verified
      expect({ cat, failed: r.failed, committed: r.committed.counts, verified: r.verified }).toMatchObject({ cat, failed: [], committed: { imported: n, rejected: 0 }, verified: 200 });
    }
    expect(await q("SELECT body FROM notes WHERE tenant_id = $1 AND contact_id = $2 AND imported ORDER BY body", [w.tenantId, c501])).toEqual([{ body: 'Note on the first row' }, { body: 'Note on the second row' }, { body: 'Note on the third row' }]);
    expect(await q("SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND imported", [c501])).toEqual([{ n: 1 }]);
    expect(await q("SELECT count(*)::int AS n FROM calls WHERE contact_id = $1 AND imported", [c501])).toEqual([{ n: 1 }]);

    // R-CONSENT-3 / R-PAR-46: the third row's opted-out phone and DNC tag carry (keyed by the address), on the same contact
    const consent = await fullStage(ih, w.admin, batchId, 'consent');
    expect(consent.counts).toMatchObject({ rejected: 0 });
    const hmac = (await q<{ h: string }>("SELECT encode(address_hmac, 'hex') AS h FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [c501]))[0]!.h;
    expect(await q("SELECT channel, purpose FROM consent_state WHERE tenant_id = $1 AND address_hmac = decode($2, 'hex') AND status = 'revoked' ORDER BY 1, 2", [w.tenantId, hmac])).toEqual(
      expect.arrayContaining([{ channel: 'sms', purpose: 'informational' }, { channel: 'sms', purpose: 'marketing' }]),
    );
    expect(await q("SELECT reason FROM suppressions WHERE tenant_id = $1 AND address_hmac = decode($2, 'hex') AND lifted_at IS NULL", [w.tenantId, hmac])).toEqual([{ reason: 'import_dnc' }]);
    expect((await q<{ contact_id: string | null }>("SELECT DISTINCT contact_id FROM consent_events WHERE tenant_id = $1 AND address_hmac = decode($2, 'hex') AND imported", [w.tenantId, hmac])).map((x) => x.contact_id)).toEqual([c501]);
  });

  let laterBatch: string;
  let c601: string;

  it('an exact match to a contact an earlier batch created, nothing new to fill: its note goes on that contact; undoing the later batch removes the notes, never the contact (PRE_EXISTING_CONTACT), and leaves no ref of the skipped duplicate', async () => {
    ih.fub.add('b6-earlier-key-0001', EARLIER);
    await contactsCommitted('b6-earlier-key-0001');
    c601 = (await contactOfRef('601')) as string;
    ih.fub.add('b6-later-key-0001', LATER);
    const { batchId, contacts } = await contactsCommitted('b6-later-key-0001');
    laterBatch = batchId;
    expect(contacts.counts).toMatchObject({ source: 2, imported: 1, duplicate: 1 });
    const crec = await records(w.admin, batchId, 'contacts');
    expect(crec.map((r) => [r.sourceRef, r.dryRunOutcome, r.planned, r.matchContactId])).toEqual([
      ['fub:people/701', 'duplicate', 'skip', c601],
      ['fub:people/702', 'will_import', 'attach', c601],
    ]);
    const r = await history(batchId, 'notes');
    expect(r.planned.counts).toMatchObject({ source: 2, willImport: 2, rejected: 0 });
    expect(r.recs.map((x) => [x.sourceRef, x.matchContactId, x.issues.map((i) => i.code)])).toEqual([
      ['fub:notes/9701', c601, ['PARENT_DUPLICATE']],
      ['fub:notes/9702', c601, []],
    ]);
    expect({ failed: r.failed, committed: r.committed.counts, verified: r.verified }).toMatchObject({ failed: [], committed: { imported: 2, rejected: 0 }, verified: 200 });
    expect(await q("SELECT count(*)::int AS n FROM notes WHERE contact_id = $1 AND imported", [c601])).toEqual([{ n: 2 }]);
    expect(await contactOfRef('701')).toBeNull();

    // undo the whole later batch (notes first, then contacts)
    expect((await call(w.admin, 'POST', `/imports/${batchId}/revert`, {})).status).toBe(202);
    await ih.drain();
    const b = await batchOf(w.admin, batchId);
    expect(b.status).toBe('reverted');
    expect(stageOf(b, 'notes').revert).toMatchObject({ removed: 2, needsDecision: 0 });
    expect(await q("SELECT count(*)::int AS n FROM notes WHERE contact_id = $1 AND imported", [c601])).toEqual([{ n: 0 }]);
    // the contact an earlier batch created is never deleted: only what this batch added to it goes
    expect(await q('SELECT deleted_at FROM contacts WHERE id = $1', [c601])).toEqual([{ deleted_at: null }]);
    expect((stageOf(b, 'contacts').revert as { manual: { sourceRef: string; reason: string }[] }).manual).toEqual([expect.objectContaining({ sourceRef: 'fub:people/702', reason: 'PRE_EXISTING_CONTACT' })]);
    expect((await q<{ address: string }>("SELECT address FROM contact_points WHERE contact_id = $1 AND kind = 'phone' ORDER BY address", [c601])).map((x) => x.address)).toEqual(['+14158200601']);
    expect(await contactOfRef('701')).toBeNull();
  });

  it('R-IMPORT-10 then R-IMPORT-9: undo then redo: the same export imported again puts both notes back on the same contact, exactly as its dry run said', async () => {
    expect(laterBatch).toBeDefined();
    const { batchId, contacts } = await contactsCommitted('b6-later-key-0001');
    expect(contacts.counts).toMatchObject({ source: 2, imported: 1, duplicate: 1 }); // 702 adds its phone back; 701 is still a duplicate
    const r = await history(batchId, 'notes');
    expect(r.planned.counts).toMatchObject({ source: 2, willImport: 2 });
    expect(r.recs.map((x) => x.matchContactId)).toEqual([c601, c601]);
    expect({ failed: r.failed, committed: r.committed.counts, verified: r.verified }).toMatchObject({ failed: [], committed: { imported: 2, rejected: 0 }, verified: 200 });
    expect(await q("SELECT body FROM notes WHERE contact_id = $1 AND imported ORDER BY body", [c601])).toEqual([{ body: 'Note on the attached record' }, { body: 'Note on the skipped duplicate' }]);
  });

  it('R-IMPORT-9 R-IMPORT-7: a re-run of the same exports writes nothing (the duplicates stay duplicates, their history is already imported)', async () => {
    expect(chainBatch).toBeDefined();
    const before = await footprint();
    for (const key of ['b6-chain-key-0001', 'b6-later-key-0001']) {
      const b = await startFub(ih, w.admin, key);
      for (const cat of ['contacts', 'notes', 'messages', 'call_recordings', 'consent'] as const) {
        if (cat === 'notes') expect((await call(w.admin, 'POST', `/imports/${b.id}/stages/ownership/skip`)).status).toBe(200);
        const d = await dryRunStage(ih, w.admin, b.id, cat);
        expect({ key, cat, willImport: d.counts?.willImport, needsReview: d.counts?.needsReview }).toEqual({ key, cat, willImport: 0, needsReview: 0 });
        expect((await approve(w.admin, b.id, cat, d.dryRunSha256 as string)).status).toBe(200);
        expect((await commitStage(ih, w.admin, b.id, cat)).status).toBe('committed');
        expect((await verify(w.admin, b.id, cat)).res.status).toBe(200);
      }
    }
    expect(await footprint()).toEqual(before);
    expect([await contactOfRef('502'), await contactOfRef('503'), await contactOfRef('701')]).toEqual([null, null, null]);
  });
});

// Review of B6, R1 (R-IMPORT-10): the undo of history that went on a pre-existing contact through a skipped duplicate.
// The revert's "touched since import" baseline came only from this batch's contacts-stage rows for the contact; a skip
// writes none, so the baseline fell back to the start of the contact's ledger and every human event from BEFORE the
// import (an assignment) counted as a touch: the rows were left for a human decision (TOUCHED) and never removed.
describe('B6 review R1 R-IMPORT-10: undoing history put on a pre-existing contact through a skipped duplicate', () => {
  const R1_PHONE = '(415) 820-1601';
  const counts = async (contactId: string) =>
    (
      await q<{ notes: number; messages: number; calls: number }>(
        `SELECT (SELECT count(*)::int FROM notes WHERE contact_id = $1 AND imported) AS notes,
                (SELECT count(*)::int FROM messages WHERE contact_id = $1 AND imported) AS messages,
                (SELECT count(*)::int FROM calls WHERE contact_id = $1 AND imported) AS calls`,
        [contactId],
      )
    )[0];

  it('B6 R-IMPORT-10: an exact-match skip only (no sibling record attaches) on a contact a person assigned before the import: undoing the batch removes every history row it put there (none left as TOUCHED), and the contact stays as it was', async () => {
    ih.fub.add('b6r1-earlier-key-0001', { users: [], people: [{ id: 1601, firstName: 'Ray', lastName: 'Assigned', phones: [valid(R1_PHONE)] }], notes: [], textMessages: [], emails: [], calls: [], recordings: {} });
    await contactsCommitted('b6r1-earlier-key-0001');
    const c = (await contactOfRef('1601')) as string;
    // a person assigns the contact before the later import: a ledger event that is not the import's
    const re = await command(w.owner, c, 'reassign', { toUserId: w.agents[0]!.userId });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    const ledgerBefore = await q('SELECT seq, type, actor_kind FROM lead_ownership_events WHERE contact_id = $1 ORDER BY seq', [c]);
    expect(ledgerBefore.map((e) => (e as { actor_kind: string }).actor_kind)).toEqual(['import', 'user']);

    ih.fub.add('b6r1-later-key-0001', {
      users: [],
      people: [{ id: 1701, firstName: 'Ray', lastName: 'Assigned', phones: [valid(R1_PHONE)] }],
      notes: [{ id: 19701, personId: 1701, body: 'Note through the skipped duplicate', created: '2025-05-01T16:00:00Z' }],
      textMessages: [{ id: 18701, personId: 1701, created: '2025-05-02T18:00:00Z', isIncoming: true, message: 'Still looking in Elm Park', status: 'Received' }],
      emails: [],
      calls: [{ id: 17701, personId: 1701, created: '2025-05-03T15:00:00Z', isIncoming: false, duration: 60, outcome: 'Interested' }],
      recordings: {},
    });
    const { batchId, contacts } = await contactsCommitted('b6r1-later-key-0001');
    expect(contacts.counts).toMatchObject({ source: 1, imported: 0, duplicate: 1 });
    for (const cat of ['notes', 'messages', 'call_recordings'] as const) {
      const r = await history(batchId, cat);
      expect({ cat, match: r.recs.map((x) => x.matchContactId), failed: r.failed, committed: r.committed.counts, verified: r.verified }).toMatchObject({ cat, match: [c], failed: [], committed: { imported: 1 }, verified: 200 });
    }
    expect(await counts(c)).toEqual({ notes: 1, messages: 1, calls: 1 });

    expect((await call(w.admin, 'POST', `/imports/${batchId}/revert`, {})).status).toBe(202);
    await ih.drain();
    const b = await batchOf(w.admin, batchId);
    expect(b.status).toBe('reverted');
    for (const cat of ['notes', 'messages', 'call_recordings'] as const) expect({ cat, revert: stageOf(b, cat).revert }).toMatchObject({ cat, revert: { removed: 1, needsDecision: 0 } });
    expect(await counts(c)).toEqual({ notes: 0, messages: 0, calls: 0 });
    // the contact an earlier batch created stays, with its owner and its ledger
    expect(await q('SELECT deleted_at, owner_user_id FROM contacts WHERE id = $1', [c])).toEqual([{ deleted_at: null, owner_user_id: w.agents[0]!.userId }]);
    expect(await q('SELECT seq, type, actor_kind FROM lead_ownership_events WHERE contact_id = $1 ORDER BY seq', [c])).toEqual(ledgerBefore);
  });
});

// Review of B6, R3 and R4 (R-IMPORT-4): a later stage is planned only against a contacts plan that can still happen.
// R3: the contacts stage dry-run and then skipped kept its records, and contactsStageMap believed them, so history went
// `will_import` against people (and, through a skipped duplicate, an existing contact) the skipped stage never wrote,
// failed at commit and could not verify. R4: a record left undecided when the contacts stage committed can never be
// decided, yet its history said PARENT_NOT_LINKED (needs review), and an Admin's "import" always failed at commit.
describe('B6 review R3 R4 R-IMPORT-4: later stages are planned against a contacts plan that can still happen', () => {
  const none = { users: [], textMessages: [], emails: [], calls: [], recordings: {} };
  const noteOf = (id: number, personId: number) => ({ id, personId, body: `Note ${id}`, created: '2025-06-01T16:00:00Z' });

  /** An earlier batch creates these people; the Owner then assigns each to the first agent (an owned contact). */
  async function earlier(key: string, people: { id: number; firstName: string; lastName: string; phones: unknown[] }[]): Promise<Record<string, string>> {
    ih.fub.add(key, { ...none, people, notes: [] });
    await contactsCommitted(key);
    const out: Record<string, string> = {};
    for (const p of people) {
      const c = (await contactOfRef(String(p.id))) as string;
      expect((await command(w.owner, c, 'reassign', { toUserId: w.agents[0]!.userId })).status).toBe(200);
      out[String(p.id)] = c;
    }
    return out;
  }

  it('B6 R3: the contacts stage dry-run, then skipped: the notes dry run plans every note as the commit will find it (PARENT_NOT_FOUND: nothing of this batch was written, and no exact match is followed), the commit agrees and verifies, and nothing lands on the existing contact; a notes dry run made before the skip is no longer current and must be run again', async () => {
    const ex = await earlier('b6r3-earlier-key-0001', [{ id: 2801, firstName: 'Eve', lastName: 'Exists', phones: [valid('(415) 820-2801')] }]);
    ih.fub.add('b6r3-later-key-0001', {
      ...none,
      people: [
        { id: 2901, firstName: 'Neil', lastName: 'New', phones: [valid('(415) 820-2901')] },
        { id: 2902, firstName: 'Neil', lastName: 'Again', phones: [valid('(415) 820-2901')] }, // in-file duplicate of 2901
        { id: 2903, firstName: 'Eve', lastName: 'Exists', phones: [valid('(415) 820-2801')] }, // exact match, nothing new
      ],
      notes: [noteOf(29001, 2901), noteOf(29002, 2902), noteOf(29003, 2903)],
    });
    const b = await startFub(ih, w.admin, 'b6r3-later-key-0001');
    const cd = await dryRunStage(ih, w.admin, b.id, 'contacts');
    expect(cd.counts).toMatchObject({ source: 3, willImport: 1, duplicate: 2 });
    // a notes dry run while the contacts plan was still current
    const early = await dryRunStage(ih, w.admin, b.id, 'notes');
    expect(early.counts).toMatchObject({ willImport: 3 });
    expect((await call(w.admin, 'POST', `/imports/${b.id}/stages/contacts/skip`)).status).toBe(200);
    expect((await call(w.admin, 'POST', `/imports/${b.id}/stages/ownership/skip`)).status).toBe(200);
    // the skip discarded the plan that dry run was made against: it is no longer current, and cannot be approved
    const reset = stageOf(await batchOf(w.admin, b.id), 'notes');
    expect(reset.status).toBe('pending');
    expect((await approve(w.admin, b.id, 'notes', early.dryRunSha256 as string)).status).toBe(409);

    const r = await history(b.id, 'notes');
    expect(r.planned.counts).toMatchObject({ source: 3, willImport: 0, rejected: 3 });
    expect(r.recs.map((x) => [x.sourceRef, x.dryRunOutcome, x.issues.map((i) => i.code)])).toEqual([
      ['fub:notes/29001', 'rejected', ['PARENT_NOT_FOUND']],
      ['fub:notes/29002', 'rejected', ['PARENT_NOT_FOUND']],
      ['fub:notes/29003', 'rejected', ['PARENT_NOT_FOUND']],
    ]);
    expect({ failed: r.failed, committed: r.committed.counts, verified: r.verified }).toMatchObject({ failed: [], committed: { imported: 0, rejected: 3 }, verified: 200 });
    expect(await q('SELECT count(*)::int AS n FROM notes WHERE contact_id = $1 AND imported', [ex['2801']])).toEqual([{ n: 0 }]);
  });

  it('B6 R4: a contacts record left undecided when its stage committed is final: its notes, and its in-file duplicate’s, are planned rejected (PARENT_REJECTED, never PARENT_NOT_LINKED, so no "import" can fail at commit); the stage commits, verifies, and the next stage can commit after it', async () => {
    const ex = await earlier('b6r4-earlier-key-0001', [
      { id: 3101, firstName: 'Olga', lastName: 'Owned', phones: [valid('(415) 820-3101')] },
      { id: 3102, firstName: 'Omar', lastName: 'Owned', phones: [valid('(415) 820-3102')] },
    ]);
    ih.fub.add('b6r4-later-key-0001', {
      ...none,
      people: [
        { id: 3201, firstName: 'Olga', lastName: 'Owned', phones: [valid('(415) 820-3101')], emails: [valid('olga.new@example.com', 'home')] }, // owned match + a new email: needs review, left undecided
        { id: 3202, firstName: 'Olga', lastName: 'Again', phones: [valid('(415) 820-3101')] }, // in-file duplicate of 3201
        { id: 3301, firstName: 'Omar', lastName: 'Owned', phones: [valid('(415) 820-3102')], emails: [valid('omar.new@example.com', 'home')] }, // needs review, rejected by the Admin
        { id: 3302, firstName: 'Omar', lastName: 'Again', phones: [valid('(415) 820-3102')] }, // in-file duplicate of 3301
      ],
      notes: [noteOf(33201, 3201), noteOf(33202, 3202), noteOf(33301, 3301), noteOf(33302, 3302)],
    });
    const b = await startFub(ih, w.admin, 'b6r4-later-key-0001');
    const cd = await dryRunStage(ih, w.admin, b.id, 'contacts');
    const crecs = await records(w.admin, b.id, 'contacts');
    expect(crecs.map((x) => [x.sourceRef, x.dryRunOutcome])).toEqual([
      ['fub:people/3201', 'needs_review'],
      ['fub:people/3202', 'duplicate'],
      ['fub:people/3301', 'needs_review'],
      ['fub:people/3302', 'duplicate'],
    ]);
    const omar = crecs.find((x) => x.sourceRef === 'fub:people/3301')!;
    expect((await call(w.admin, 'POST', `/imports/${b.id}/records/${omar.id}/review`, { decision: 'reject' })).status).toBe(200);
    expect((await approve(w.admin, b.id, 'contacts', cd.dryRunSha256 as string)).status).toBe(200);
    expect((await commitStage(ih, w.admin, b.id, 'contacts')).status).toBe('committed');
    expect((await verify(w.admin, b.id, 'contacts')).res.status).toBe(200);
    expect((await call(w.admin, 'POST', `/imports/${b.id}/stages/ownership/skip`)).status).toBe(200);

    const r = await history(b.id, 'notes');
    expect(r.recs.map((x) => [x.sourceRef, x.dryRunOutcome, x.issues.map((i) => i.code).sort()])).toEqual([
      ['fub:notes/33201', 'rejected', ['PARENT_REJECTED']],
      ['fub:notes/33202', 'rejected', ['PARENT_DUPLICATE', 'PARENT_REJECTED']],
      ['fub:notes/33301', 'rejected', ['PARENT_REJECTED']],
      ['fub:notes/33302', 'rejected', ['PARENT_DUPLICATE', 'PARENT_REJECTED']],
    ]);
    expect({ failed: r.failed, committed: r.committed.counts, verified: r.verified }).toMatchObject({ failed: [], committed: { imported: 0, rejected: 4 }, verified: 200 });
    // the batch moves on: the next stage commits (and verifies) after it
    const m = await fullStage(ih, w.admin, b.id, 'messages');
    expect(m.status).toBe('committed');
    expect(stageOf(await batchOf(w.admin, b.id), 'messages').status).toBe('verified');
    for (const c of Object.values(ex)) expect(await q('SELECT count(*)::int AS n FROM notes WHERE contact_id = $1 AND imported', [c])).toEqual([{ n: 0 }]);
  });
});
