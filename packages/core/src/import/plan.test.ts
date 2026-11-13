import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { type ContactId, DAY_MS, instant, sequentialIds } from '../foundation/index.js';
import {
  type Category,
  type ExistingIndexInput,
  type NormalizedContact,
  type NormalizedRecord,
  type RecordOutcome,
  type StageDryRun,
  buildExistingIndex,
  commitChunks,
  commitPlan,
  contactsStagePlan,
  dryRun,
  mapFub,
  normalizeCsv,
  parseCsv,
  planRevert,
  revertOrder,
  stageReconciles,
  suggestMapping,
} from './index.js';
import { AGENT_A, AGENT_B, BATCH, FUB_EXPORT, T0, USERS, csvBytes, emptyIndexInput, existingContact, simulateCommit, testKey } from './testing/fixtures.js';

const C1 = '00000000-0000-7000-8000-0000000c0001' as ContactId;
const C2 = '00000000-0000-7000-8000-0000000c0002' as ContactId;
const C3 = '00000000-0000-7000-8000-0000000c0003' as ContactId;

function csv(text: string): RecordOutcome<NormalizedContact>[] {
  const p = parseCsv(csvBytes(text), { maxRows: 50_000 });
  if ('error' in p) throw new Error(p.error.code);
  return normalizeCsv(p, suggestMapping(p.headers), { defaultCountry: 'US' }, 'f.csv');
}

function contactsRun(text: string, input: ExistingIndexInput): StageDryRun {
  return dryRun('contacts', csv(text), buildExistingIndex(input));
}

function only(d: StageDryRun) {
  expect(d.records).toHaveLength(1);
  return d.records[0] as StageDryRun['records'][number];
}

/** FUB raw objects per stage. */
const RAW: Record<Category, readonly unknown[]> = {
  contacts: FUB_EXPORT.people,
  ownership: FUB_EXPORT.people,
  notes: FUB_EXPORT.notes,
  messages: [...FUB_EXPORT.textMessages, ...FUB_EXPORT.emails],
  call_recordings: FUB_EXPORT.calls,
  consent: FUB_EXPORT.people,
};

/** The fixture mapping with the one unmapped FUB agent ("99") mapped too: a complete mapping. */
const FULL_USERS = { ...USERS, users: new Map([...USERS.users, ['99', 'unassigned' as const]]) };

function normalized(category: Category, users = USERS): RecordOutcome<NormalizedRecord>[] {
  return RAW[category].map((r) => mapFub(category, r, users));
}

const IMPORT_ALL = (d: StageDryRun) =>
  d.records.filter((r) => r.outcome === 'needs_review').map((r) => ({ sourceRef: r.sourceRef, decision: 'import' as const }));

/** Dry-run → (review everything as import) → commit, stage by stage, in commit order. */
function runAll(input: ExistingIndexInput, reviewAll = true): { input: ExistingIndexInput; dry: Record<Category, StageDryRun> } {
  const dry = {} as Record<Category, StageDryRun>;
  let cur = input;
  for (const c of ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent'] as const) {
    const idx = buildExistingIndex(cur);
    const d = dryRun(c, normalized(c, FULL_USERS), idx);
    dry[c] = d;
    if (d.blockers.length > 0) continue;
    const plan = commitPlan(d, reviewAll ? IMPORT_ALL(d) : [], d.snapshotSha256, idx);
    if (!plan.ok) throw new Error(plan.code);
    cur = simulateCommit(cur, plan.items);
  }
  return { input: cur, dry };
}

describe('contacts matching (R-IMPORT-7, R-OWN-25)', () => {
  it('R-IMPORT-7 R-OWN-25 an exact phone match attaches; an exact email match attaches', () => {
    const input = emptyIndexInput({ contacts: [existingContact({ contactId: C1, displayName: 'J. Doe', phones: ['+14155550132'] }), existingContact({ contactId: C2, displayName: 'Other', emails: ['x@example.com'] })] });
    expect(only(contactsRun('Name,Phone\nJane Doe,415-555-0132\n', input))).toMatchObject({ outcome: 'will_import', action: { kind: 'attach_contact', contactId: C1 }, matchContactId: C1 });
    expect(only(contactsRun('Name,Email\nSomeone,X@Example.com\n', input))).toMatchObject({ outcome: 'will_import', action: { kind: 'attach_contact', contactId: C2 } });
  });

  it('R-IMPORT-7 property: a name-only match is never auto-merged; it becomes a duplicate candidate of a new contact', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Z][a-z]{1,8} [A-Z][a-z]{1,10}$/), fc.integer({ min: 0, max: 9999 }), (name, n) => {
        const input = emptyIndexInput({ contacts: [existingContact({ contactId: C1, displayName: name, phones: ['+12065550100'] })] });
        const phone = `415-555-${String(n).padStart(4, '0')}`;
        const r = only(contactsRun(`Name,Phone\n${name.toUpperCase()},${phone}\n`, input));
        expect(r.action?.kind).toBe('create_contact');
        expect(r.matchContactId).toBeNull();
        expect(r.action).toMatchObject({ duplicateCandidates: [{ contactId: C1, reason: 'import' }] });
        expect(r.issues).toContainEqual({ code: 'NAME_ONLY_MATCH', severity: 'info' });
      }),
      { numRuns: 100 },
    );
  });

  it('R-OWN-25 phone and email matching different contacts attach to the earliest and suggest the other as a split duplicate', () => {
    const input = emptyIndexInput({
      contacts: [
        existingContact({ contactId: C2, createdAt: instant(T0 - DAY_MS), phones: ['+14155550132'] }),
        existingContact({ contactId: C1, createdAt: instant(T0 - 9 * DAY_MS), emails: ['jane@example.com'] }),
      ],
    });
    const r = only(contactsRun('Name,Phone,Email\nJane,415-555-0132,jane@example.com\n', input));
    expect(r.action).toMatchObject({ kind: 'attach_contact', contactId: C1, duplicateCandidates: [{ contactId: C2, reason: 'phone_email_split' }] });
    expect(r.issues).toContainEqual({ code: 'MATCH_MULTIPLE', severity: 'info' });
  });

  it('E41 R-IMPORT-7 a match owned by another agent: flagged for review, fields filled only where empty, ownership never changes', () => {
    const input = emptyIndexInput({
      contacts: [existingContact({ contactId: C1, displayName: 'Jane D', firstName: 'Janet', lastName: null, ownershipState: 'owned', ownerUserId: AGENT_B, phones: ['+14155550132'], tags: ['vip'] })],
    });
    const d = contactsRun('First Name,Last Name,Phone,Email,Tags,Intent\nJane,Doe,415-555-0132,jane@example.com,"VIP,Investor",Buyer\n', input);
    const r = only(d);
    expect(r.outcome).toBe('needs_review');
    expect(r.issues).toContainEqual({ code: 'MATCH_OWNED_CONTACT', severity: 'review' });
    expect(r.action).toEqual({
      kind: 'attach_contact',
      contactId: C1,
      duplicateCandidates: [],
      fill: {
        lastName: 'Doe', // firstName "Janet" is kept
        intent: 'buyer',
        addPhones: [],
        addEmails: [{ email: 'jane@example.com', label: 'other', status: 'active', isPrimary: true }],
        addAddresses: [],
        addTags: ['Investor'],
        addImportedFields: {},
      },
    });
    // No plan action can carry an owner: the contacts stage only attaches.
    expect(JSON.stringify(r.action)).not.toContain(AGENT_A);
    // Once reviewed and committed, the ownership stage for that person keeps the agent.
    const idx = buildExistingIndex(input);
    const plan = commitPlan(d, [{ sourceRef: r.sourceRef, decision: 'import' }], d.snapshotSha256, idx);
    expect(plan.ok && plan.items.map((i) => i.action.kind)).toEqual(['attach_contact']);
  });

  // Import part of R-OWN-21 (an import re-run never changes ownership of already-linked records).
  it('E41 the ownership stage never re-assigns a contact the import attached to, or one it created that has moved on', () => {
    const own = mapFub('ownership', FUB_EXPORT.people[0], USERS);
    const attached = buildExistingIndex(emptyIndexInput({ contactsStage: new Map([['1001', 'attach']]) }));
    expect(only(dryRun('ownership', [own], attached))).toMatchObject({ outcome: 'duplicate', issues: [{ code: 'OWNER_KEPT', severity: 'info' }] });
    const preExisting = buildExistingIndex(
      emptyIndexInput({ contacts: [existingContact({ contactId: C1, ownershipState: 'owned', ownerUserId: AGENT_B })], externalRefs: [{ entityType: 'contact', externalId: '1001', entityId: C1 }] }),
    );
    expect(only(dryRun('ownership', [own], preExisting))).toMatchObject({ outcome: 'duplicate', issues: [{ code: 'OWNER_KEPT', severity: 'info' }] });
    const createdThenClaimed = buildExistingIndex(
      emptyIndexInput({ contacts: [existingContact({ contactId: C1, importBatchId: BATCH, ownershipState: 'owned', ownerUserId: AGENT_B })], externalRefs: [{ entityType: 'contact', externalId: '1001', entityId: C1 }] }),
    );
    expect(only(dryRun('ownership', [own], createdThenClaimed))).toMatchObject({ outcome: 'duplicate', issues: [{ code: 'OWNER_KEPT', severity: 'info' }] });
    const createdHere = buildExistingIndex(
      emptyIndexInput({ contacts: [existingContact({ contactId: C1, importBatchId: BATCH })], externalRefs: [{ entityType: 'contact', externalId: '1001', entityId: C1 }] }),
    );
    expect(only(dryRun('ownership', [own], createdHere))).toMatchObject({ outcome: 'will_import', action: { kind: 'assign', contact: { contactId: C1 }, target: { userId: AGENT_A } } });
  });

  // Batch 6 review ownership-sla/F3: the planner planned an assignment for every contact this batch created that was
  // `unassigned`, but the engine takes import_assign only in the import's creation state (unassigned, seq 1, never
  // routed). A person merged (or changed by someone) after the contacts stage left it, so the commit made nothing,
  // called it OWNER_KEPT ("already has an owner": false) and the recount never matched.
  it('E230 E231 E41 the ownership dry run plans what the engine will do with a person this import created who left its creation state: kept when someone gave them an owner, "came in unassigned" (merged, or changed) when nobody holds them', () => {
    const own = mapFub('ownership', FUB_EXPORT.people[0], USERS);
    const plan = (c: Parameters<typeof existingContact>[0], extra: Parameters<typeof existingContact>[0][] = [], refTo: ContactId = C1) =>
      only(dryRun('ownership', [own], buildExistingIndex(emptyIndexInput({ contacts: [existingContact({ importBatchId: BATCH, ...c }), ...extra.map((x) => existingContact(x))], externalRefs: [{ entityType: 'contact', externalId: '1001', entityId: refTo }] }))));
    // still in its creation state: the mapped assignment, as before
    expect(plan({ contactId: C1, ownershipSeq: 1, routeDueAt: null })).toMatchObject({ outcome: 'will_import', action: { kind: 'assign' } });
    // another imported person was merged into it: unassigned at seq 2, so the engine would make nothing
    expect(plan({ contactId: C1, ownershipSeq: 2, routeDueAt: null, mergedIn: true })).toMatchObject({
      outcome: 'rejected', action: null, matchContactId: C1, issues: [{ code: 'PERSON_MERGED', severity: 'info' }],
    });
    // it was merged into another person this import created: the record follows the merge, and says so
    expect(plan({ contactId: C2, ownershipSeq: 2, routeDueAt: null, mergedIn: true }, [{ contactId: C1, importBatchId: BATCH, ownershipState: 'closed', closedReason: 'merged', mergedIntoContactId: C2, ownershipSeq: 2 }])).toMatchObject({
      outcome: 'rejected', matchContactId: C2, issues: [{ code: 'PERSON_MERGED', severity: 'info' }],
    });
    // closed, released to a pond, or re-opened and routed by someone since: nobody holds them, the import leaves it
    for (const c of [{ ownershipState: 'closed' as const, closedReason: 'spam', ownershipSeq: 2 }, { ownershipState: 'in_pond' as const, ownershipSeq: 3 }, { ownershipState: 'unassigned' as const, ownershipSeq: 4, routeDueAt: T0 }]) {
      expect(plan({ contactId: C1, routeDueAt: null, ...c })).toMatchObject({ outcome: 'rejected', matchContactId: C1, issues: [{ code: 'PERSON_CHANGED', severity: 'info' }] });
    }
    // given an owner by someone: kept (true: they have one), as before
    expect(plan({ contactId: C1, ownershipState: 'owned', ownerUserId: AGENT_B, ownershipSeq: 2 })).toMatchObject({ outcome: 'duplicate', issues: [{ code: 'OWNER_KEPT', severity: 'info' }] });
  });

  // Review of that fix (R4): a person FUB holds unassigned (no agent, no pond) never had an assignment planned, so a
  // person who closed, released, routed or merged them since changed nothing the import would have done. They are no
  // documented "came in unassigned" outcome (PERSON_CHANGED, not imported, listed in the B4 report): the import has no
  // owner to give, so the record is already imported, as the commit says too.
  it('E231 E41 a person FUB holds unassigned whom someone closed, released, routed or merged since the contacts stage is already imported, never "came in unassigned"', () => {
    const own = mapFub('ownership', { ...FUB_EXPORT.people[0]!, assignedUserId: null, assignedPondId: null }, USERS);
    expect(own).toMatchObject({ record: { target: 'unassigned' } });
    const plan = (c: Parameters<typeof existingContact>[0], extra: Parameters<typeof existingContact>[0][] = []) =>
      only(dryRun('ownership', [own], buildExistingIndex(emptyIndexInput({ contacts: [existingContact({ importBatchId: BATCH, ...c }), ...extra.map((x) => existingContact(x))], externalRefs: [{ entityType: 'contact', externalId: '1001', entityId: C1 }] }))));
    const cases: Parameters<typeof existingContact>[0][] = [
      { contactId: C1, ownershipState: 'unassigned', ownershipSeq: 1, routeDueAt: null },
      { contactId: C1, ownershipState: 'closed', closedReason: 'spam', ownershipSeq: 2, routeDueAt: null },
      { contactId: C1, ownershipState: 'in_pond', ownershipSeq: 3, routeDueAt: null },
      { contactId: C1, ownershipState: 'offered', ownershipSeq: 3, routeDueAt: null },
      { contactId: C1, ownershipState: 'unassigned', ownershipSeq: 4, routeDueAt: T0 },
      { contactId: C1, ownershipState: 'unassigned', ownershipSeq: 2, routeDueAt: null, mergedIn: true },
    ];
    for (const c of cases) {
      const r = plan(c);
      expect({ state: c.ownershipState, seq: c.ownershipSeq, r }).toMatchObject({ state: c.ownershipState, seq: c.ownershipSeq, r: { outcome: 'duplicate', action: { kind: 'skip', existingId: C1 }, matchContactId: C1, issues: [{ code: 'ALREADY_IMPORTED', severity: 'info' }] } });
    }
    // merged into another person this import created, who is in a pond now: the same
    expect(plan({ contactId: C2, ownershipState: 'in_pond', ownershipSeq: 3, routeDueAt: null, mergedIn: true }, [{ contactId: C1, importBatchId: BATCH, ownershipState: 'closed', closedReason: 'merged', mergedIntoContactId: C2, ownershipSeq: 2 }])).toMatchObject({
      outcome: 'duplicate', matchContactId: C2, issues: [{ code: 'ALREADY_IMPORTED', severity: 'info' }],
    });
    // given an owner by someone since: kept (true: they have one)
    expect(plan({ contactId: C1, ownershipState: 'owned', ownerUserId: AGENT_B, ownershipSeq: 2 })).toMatchObject({ outcome: 'duplicate', issues: [{ code: 'OWNER_KEPT', severity: 'info' }] });
  });

  it('E39 a deleted contact re-imported from an old CSV becomes a new contact, and the preview says it stays opted out', () => {
    const input = emptyIndexInput({
      contacts: [existingContact({ contactId: C1, ownershipState: 'closed', closedReason: 'deleted', phones: ['+14155550132'] })],
      optedOut: [{ key: testKey('phone', '+14155550132'), channel: 'sms' }],
    });
    const r = only(contactsRun('Name,Phone,SMS Consent\nJane,415-555-0132,yes\n', input));
    expect(r).toMatchObject({ outcome: 'will_import', action: { kind: 'create_contact' }, matchContactId: null, staysOptedOut: ['sms'] });
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['ADDRESS_OPTED_OUT', 'MATCH_DELETED_CONTACT']));
  });

  it('merged-away contacts redirect to the survivor', () => {
    const input = emptyIndexInput({
      contacts: [
        existingContact({ contactId: C1, ownershipState: 'closed', closedReason: 'merged', mergedIntoContactId: C2, phones: ['+14155550132'] }),
        existingContact({ contactId: C2, phones: [] }),
      ],
    });
    expect(only(contactsRun('Name,Phone\nJane,415-555-0132\n', input)).action).toMatchObject({ kind: 'attach_contact', contactId: C2 });
  });

  it('rows of one file sharing an external id, phone or email: the later ones are in-file duplicates', () => {
    const d = contactsRun('ID,Name,Phone,Email\n7,Jane,415-555-0132,\n8,Jane Again,(415) 555-0132,\n7,Other,,o@example.com\n9,Bob,,b@example.com\n10,Bobby,,B@example.com\n', emptyIndexInput());
    expect(d.records.map((r) => r.outcome)).toEqual(['will_import', 'duplicate', 'duplicate', 'will_import', 'duplicate']);
    expect(d.records[1]?.action).toEqual({ kind: 'skip', existingId: 'f.csv#row=2' });
  });

  it('the same source ref twice is rejected SOURCE_REF_DUPLICATE (import_records is unique per stage)', () => {
    const [a] = csv('Name\nJane\n');
    const d = dryRun('contacts', [a as RecordOutcome<NormalizedRecord>, a as RecordOutcome<NormalizedRecord>], buildExistingIndex(emptyIndexInput()));
    expect(d.records.map((r) => r.outcome)).toEqual(['will_import', 'rejected']);
    expect(d.records[1]?.issues).toContainEqual({ code: 'SOURCE_REF_DUPLICATE', severity: 'error' });
  });

  it('a record of another category in a stage is rejected, not imported', () => {
    const d = dryRun('notes', [mapFub('contacts', FUB_EXPORT.people[3], USERS)], buildExistingIndex(emptyIndexInput()));
    expect(only(d)).toMatchObject({ outcome: 'rejected', normalized: null });
  });
});

describe('re-runs (R-IMPORT-9, E44)', () => {
  it('R-IMPORT-9 E44 a FUB import run twice updates or skips, never duplicates: the second run plans nothing new in any stage', () => {
    const first = runAll(emptyIndexInput());
    expect(first.dry.contacts.counts).toEqual({ source: 7, will_import: 4, needs_review: 1, rejected: 2, duplicate: 0 });
    const second = runAll(first.input);
    for (const c of ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent'] as const) {
      const d = second.dry[c];
      expect(d.blockers, c).toEqual([]);
      expect(d.counts.will_import + d.counts.needs_review, c).toBe(0);
      expect(d.counts.rejected, c).toBe(first.dry[c].counts.rejected);
      expect(d.counts.duplicate, c).toBe(d.counts.source - d.counts.rejected);
      expect(d.records.filter((r) => r.outcome !== 'rejected').every((r) => r.action?.kind === 'skip'), c).toBe(true);
    }
    // Contacts were created exactly once each.
    expect(second.input.contacts).toHaveLength(first.input.contacts.length);
  });

  it('E44 a re-run with changed FUB data only fills what is new (a new tag, a new opt-out) and still creates nothing', () => {
    const first = runAll(emptyIndexInput());
    const people = JSON.parse(JSON.stringify(FUB_EXPORT.people)) as Record<string, unknown>[];
    (people[0] as { tags: string[] }).tags.push('Relocating');
    (people[0] as { phones: { status: string }[] }).phones[0]!.status = 'Opted Out';
    const idx = buildExistingIndex(first.input);
    const contacts = dryRun('contacts', people.map((p) => mapFub('contacts', p, USERS)), idx);
    const jane = contacts.records.find((r) => r.sourceRef === 'fub:people/1001');
    expect(jane?.action).toMatchObject({ kind: 'update_contact', fill: { addTags: ['Relocating'], addPhones: [], addEmails: [] } });
    expect(contacts.records.filter((r) => r.action?.kind === 'create_contact')).toHaveLength(0);
    const consent = dryRun('consent', people.map((p) => mapFub('consent', p, USERS)), idx);
    const janeConsent = consent.records.find((r) => r.sourceRef === 'fub:people/1001');
    expect(janeConsent).toMatchObject({ outcome: 'will_import', action: { kind: 'record_consent', revokes: 1, grants: 0 } });
  });
});

describe('ownership and history stages', () => {
  it('an unmapped agent blocks the ownership stage (USER_MAPPING_INCOMPLETE) and the commit refuses STAGE_BLOCKED', () => {
    const idx = buildExistingIndex(emptyIndexInput({ contactsStage: contactsStagePlan(dryRun('contacts', normalized('contacts'), buildExistingIndex(emptyIndexInput()))) }));
    const d = dryRun('ownership', normalized('ownership'), idx);
    expect(d.blockers).toEqual([{ code: 'USER_MAPPING_INCOMPLETE', severity: 'error' }]);
    expect(commitPlan(d, [], d.snapshotSha256, idx)).toEqual({ ok: false, code: 'STAGE_BLOCKED', sourceRefs: [] });
    // Later stages may be dry-run before the contacts commit: they point at the pending person.
    expect(d.records.find((r) => r.sourceRef === 'fub:people/1002')?.action).toEqual({ kind: 'assign', contact: { pendingPersonRef: '1002' }, target: { userId: AGENT_B } });
  });

  it('history needs its contact: orphan → PARENT_NOT_FOUND, rejected contact → PARENT_REJECTED, contact under review → PARENT_NOT_LINKED', () => {
    const plan = contactsStagePlan(dryRun('contacts', normalized('contacts'), buildExistingIndex(emptyIndexInput())));
    expect(Object.fromEntries(plan)).toEqual({ '1001': 'needs_review', '1002': 'create', '1003': 'create', '1004': 'create', '1005': 'create', '1006': 'rejected', unknown: 'rejected' });
    const idx = buildExistingIndex(emptyIndexInput({ contactsStage: plan }));
    const notes = dryRun('notes', normalized('notes'), idx);
    expect(notes.records.map((r) => [r.sourceRef, r.outcome, r.issues.map((i) => i.code)])).toEqual([
      ['fub:notes/501', 'needs_review', ['PARENT_NOT_LINKED']],
      ['fub:notes/502', 'will_import', []],
      ['fub:notes/503', 'rejected', ['PARENT_NOT_FOUND']],
      ['fub:notes/504', 'rejected', ['BODY_EMPTY']],
    ]);
    const calls = dryRun('call_recordings', [mapFub('call_recordings', { ...FUB_EXPORT.calls[1], personId: 1006 }, USERS)], idx);
    expect(only(calls).issues.map((i) => i.code)).toEqual(['PARENT_REJECTED']);
  });

  // Import part of R-CONSENT-1: consent is keyed by address, never by contact.
  it('consent is keyed by address: an opt-out is recorded even when no contact exists for the person', () => {
    const bob = mapFub('consent', FUB_EXPORT.people[1], USERS);
    const r = only(dryRun('consent', [bob], buildExistingIndex(emptyIndexInput())));
    expect(r).toMatchObject({ outcome: 'will_import', action: { kind: 'record_consent', contact: null, revokes: 2, grants: 0 } });
  });

  it('consent dry run summarizes texting permission, opt-outs and DNC over the people it would record', () => {
    const d = dryRun('consent', normalized('consent'), buildExistingIndex(emptyIndexInput()));
    expect(d.consentSummary).toEqual({ textingPermission: 1, emailPermission: 1, optedOut: 1, doNotContact: 1 });
    expect(d.records.filter((r) => r.outcome === 'duplicate').map((r) => r.sourceRef)).toEqual(['fub:people/1004', 'fub:people/1005', 'fub:people/1006']);
  });
});

describe('commit plan (R-IMPORT-4, E42)', () => {
  const text = 'Name,Phone,Email,Stage\nA,415-555-0101,,\nB,555-0100,b@example.com,\nC,,c@example.com,\nD,415-555-0104,,\n,=cmd,,\n';
  const idx = buildExistingIndex(emptyIndexInput({ contacts: [existingContact({ contactId: C3, emails: ['c@example.com'], displayName: 'C', firstName: 'C' })] }));
  const d = dryRun('contacts', csv(text), idx);

  it('R-IMPORT-4 a commit applies exactly the reviewed snapshot records: will_import plus needs_review decided import, minus rejects', () => {
    expect(d.records.map((r) => r.outcome)).toEqual(['will_import', 'needs_review', 'duplicate', 'will_import', 'rejected']);
    const p = commitPlan(d, [{ sourceRef: 'f.csv#row=3', decision: 'import' }, { sourceRef: 'f.csv#row=5', decision: 'reject' }], d.snapshotSha256, idx);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.items.map((i) => [i.sourceRef, i.reviewed])).toEqual([
      ['f.csv#row=2', false],
      ['f.csv#row=3', true],
    ]);
    expect(p.expected).toEqual({ source: 5, imported: 2, needs_review: 0, rejected: 2, duplicate: 1 });
    const unreviewed = commitPlan(d, [], d.snapshotSha256, idx);
    expect(unreviewed.ok && unreviewed.expected).toEqual({ source: 5, imported: 2, needs_review: 1, rejected: 1, duplicate: 1 });
  });

  it('R-IMPORT-4 E42 when FUB data changed after the dry run the commit refuses SNAPSHOT_CHANGED; a delta needs a new snapshot and dry run', () => {
    const changed = csv(text.replace('A,415', 'A2,415'));
    const delta = dryRun('contacts', changed, idx);
    expect(delta.snapshotSha256).not.toBe(d.snapshotSha256);
    expect(commitPlan(d, [], delta.snapshotSha256, idx)).toEqual({ ok: false, code: 'SNAPSHOT_CHANGED', sourceRefs: [] });
    // Same snapshot ⇒ same digest (order-independent of anything but the records).
    expect(dryRun('contacts', csv(text), idx).snapshotSha256).toBe(d.snapshotSha256);
  });

  it('reviews are validated: unknown refs, decisions on duplicates/rejected, and merges into a non-candidate are refused', () => {
    expect(commitPlan(d, [{ sourceRef: 'nope', decision: 'import' }], d.snapshotSha256, idx)).toEqual({ ok: false, code: 'UNKNOWN_RECORD', sourceRefs: ['nope'] });
    expect(commitPlan(d, [{ sourceRef: 'f.csv#row=4', decision: 'import' }], d.snapshotSha256, idx)).toEqual({ ok: false, code: 'REVIEW_NOT_ALLOWED', sourceRefs: ['f.csv#row=4'] });
    expect(commitPlan(d, [{ sourceRef: 'f.csv#row=6', decision: 'import' }], d.snapshotSha256, idx)).toMatchObject({ ok: false, code: 'REVIEW_NOT_ALLOWED' });
    expect(commitPlan(d, [{ sourceRef: 'f.csv#row=3', decision: 'merge', mergeIntoContactId: C1 }], d.snapshotSha256, idx)).toMatchObject({ ok: false, code: 'REVIEW_NOT_ALLOWED' });
  });

  it('a merge decision attaches a name-only candidate to the chosen contact (only a human merges)', () => {
    const named = buildExistingIndex(emptyIndexInput({ contacts: [existingContact({ contactId: C1, displayName: 'Jane Roe' })] }));
    const nd = dryRun('contacts', csv('Name,Email\nJane Roe,jr@example.com\n'), named);
    const r = only(nd);
    expect(r.action?.kind).toBe('create_contact');
    // will_import cannot be merged without review; once it is flagged needs_review it could. Here a reviewer rejects or the dry run stands.
    expect(commitPlan(nd, [{ sourceRef: r.sourceRef, decision: 'merge', mergeIntoContactId: C1 }], nd.snapshotSha256, named)).toMatchObject({ ok: false, code: 'REVIEW_NOT_ALLOWED' });
    const flagged: StageDryRun = { ...nd, records: [{ ...r, outcome: 'needs_review' }] };
    const p = commitPlan(flagged, [{ sourceRef: r.sourceRef, decision: 'merge', mergeIntoContactId: C1 }], nd.snapshotSha256, named);
    expect(p.ok && p.items[0]?.action).toMatchObject({ kind: 'attach_contact', contactId: C1, fill: { firstName: 'Jane', lastName: 'Roe' } });
  });

  it('R-IMPORT-4 commits run 1,000 records per transaction and resume after the last committed record', () => {
    const items = Array.from({ length: 2_500 }, (_, i) => ({ sourceRef: `r${i}` }));
    expect(commitChunks(items).map((c) => c.length)).toEqual([1000, 1000, 500]);
    expect(commitChunks(items, { size: 5000 }).map((c) => c.length)).toEqual([1000, 1000, 500]);
    const resumed = commitChunks(items, { resumeAfter: 'r999' });
    expect(resumed.map((c) => c.length)).toEqual([1000, 500]);
    expect(resumed[0]?.[0]?.sourceRef).toBe('r1000');
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_499 }), fc.integer({ min: 1, max: 1500 }), (k, size) => {
        const flat = commitChunks(items, { resumeAfter: `r${k}`, size }).flat();
        expect(flat.map((x) => x.sourceRef)).toEqual(items.slice(k + 1).map((x) => x.sourceRef));
      }),
      { numRuns: 50 },
    );
  });

  it('every dry run reconciles exactly: source = will_import + needs_review + rejected + duplicate', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom('Jane', 'Bob', '', '=x', 'Ann Lee'), fc.constantFrom('415-555-0101', '555-0100', '', '415-555-0102'), fc.constantFrom('a@example.com', 'bad', '')), { maxLength: 40 }),
        (rows) => {
          const t = `Name,Phone,Email\n${rows.map((r) => r.map((x) => `"${x}"`).join(',')).join('\n')}\n`;
          const out = dryRun('contacts', csv(t), idx);
          expect(stageReconciles(out.counts)).toBe(true);
          expect(out.counts.source).toBe(csv(t).length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('revert (R-IMPORT-10, E43)', () => {
  const ids = () => ({ ids: sequentialIds({ prefix: 3 }), now: T0 });

  it('R-IMPORT-10 E43 untouched imported contacts are removed; touched ones are listed for a human and never auto-deleted; pre-existing contacts are never removed', () => {
    const plan = planRevert(
      'contacts',
      [
        { table: 'contacts', id: 'c-untouched', action: 'create' },
        { table: 'contacts', id: 'c-messaged', action: 'create' },
        { table: 'contacts', id: 'c-attached', action: 'attach' },
        { table: 'contact_points', id: 'p-1', contactId: 'c-untouched' },
        { table: 'contact_points', id: 'p-2', contactId: 'c-messaged' },
        { table: 'contact_points', id: 'p-3', contactId: 'c-attached' },
        { table: 'notes', id: 'n-wrong-stage', contactId: 'c-untouched' },
      ],
      new Set(['c-messaged']),
      ids(),
    );
    expect(plan.delete).toEqual(['c-untouched', 'p-1', 'p-3']);
    expect(plan.manual).toEqual(['c-messaged', 'c-attached', 'p-2', 'n-wrong-stage']);
    expect(plan.reasons).toEqual({ 'c-messaged': 'TOUCHED', 'c-attached': 'PRE_EXISTING_CONTACT', 'p-2': 'TOUCHED', 'n-wrong-stage': 'NOT_IN_STAGE' });
    expect(plan.compensate).toEqual([]);
  });

  it('R-IMPORT-10 history rows: untouched deleted, rows of a touched contact listed; ownership ledger rows are append-only history', () => {
    const notes = planRevert('notes', [{ table: 'notes', id: 'n1', contactId: 'c1' }, { table: 'notes', id: 'n2', contactId: 'c2' }], new Set(['c2']), ids());
    expect([notes.delete, notes.manual]).toEqual([['n1'], ['n2']]);
    const calls = planRevert('call_recordings', [{ table: 'calls', id: 'k1', contactId: 'c1' }, { table: 'recordings', id: 'r1', contactId: 'c1' }], new Set(['r1']), ids());
    expect([calls.delete, calls.manual]).toEqual([['k1'], ['r1']]);
    const own = planRevert('ownership', [{ table: 'lead_ownership_events', id: 'e1', contactId: 'c1' }, { table: 'lead_ownership_events', id: 'e2', contactId: 'c2' }], new Set(['c2']), ids());
    // ownership-1: the untouched assignment is compensated (import_unassign), never left in force
    expect([own.delete, own.kept, own.manual, own.unassign]).toEqual([[], [], ['e2'], [{ eventId: 'e1', contactId: 'c1' }]]);
  });

  it("R-IMPORT-10: a call's note (written by the calls stage as a notes row) goes with the call; a touched contact keeps both", () => {
    const rows = [
      { table: 'calls', id: 'k1', contactId: 'c1' },
      { table: 'notes', id: 'kn1', contactId: 'c1' },
      { table: 'calls', id: 'k2', contactId: 'c2' },
      { table: 'notes', id: 'kn2', contactId: 'c2' },
    ] as const;
    const plan = planRevert('call_recordings', rows, new Set(['c2']), ids());
    expect([plan.delete, plan.manual]).toEqual([['k1', 'kn1'], ['k2', 'kn2']]);
    expect(plan.reasons).toEqual({ k2: 'TOUCHED', kn2: 'TOUCHED' });
  });

  it('R-IMPORT-10 E43 D9 (b10 review ownership-data/F2): a person with a CMA, or an address a CMA cites, is listed for a human as CMA_PREPARED, never removed; a CMA outranks TOUCHED', () => {
    const plan = planRevert(
      'contacts',
      [
        { table: 'contacts', id: 'c-cma', action: 'create' },
        { table: 'contacts', id: 'c-both', action: 'create' },
        { table: 'contacts', id: 'c-attached', action: 'attach' },
        { table: 'contacts', id: 'c-plain', action: 'create' },
        { table: 'contact_addresses', id: 'a-1', contactId: 'c-cma' },
        { table: 'contact_addresses', id: 'a-cited', contactId: 'c-attached' },
        { table: 'contact_addresses', id: 'a-2', contactId: 'c-attached' },
        { table: 'contact_points', id: 'p-1', contactId: 'c-plain' },
      ],
      new Set(['c-both']),
      ids(),
      new Set(['c-cma', 'c-both', 'a-cited']),
    );
    expect(plan.delete).toEqual(['c-plain', 'a-2', 'p-1']);
    expect(plan.reasons).toEqual({ 'c-cma': 'CMA_PREPARED', 'c-both': 'CMA_PREPARED', 'c-attached': 'PRE_EXISTING_CONTACT', 'a-1': 'CMA_PREPARED', 'a-cited': 'CMA_PREPARED' });
    const own = planRevert('ownership', [{ table: 'lead_ownership_events', id: 'e1', contactId: 'c-cma' }], new Set(), ids(), new Set(['c-cma']));
    expect([own.manual, own.unassign, own.reasons]).toEqual([['e1'], [], { e1: 'CMA_PREPARED' }]);
  });

  it('R-IMPORT-10 stages revert in reverse commit order', () => {
    expect(revertOrder(['contacts', 'consent', 'notes', 'ownership', 'call_recordings', 'messages'])).toEqual(['consent', 'call_recordings', 'messages', 'notes', 'ownership', 'contacts']);
  });
});
