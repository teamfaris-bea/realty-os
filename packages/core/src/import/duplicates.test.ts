// B6 (R-IMPORT-4, R-IMPORT-7): the history of a person whose contacts record was skipped as a duplicate goes on the
// contact the skip points at, and the dry run says so, so the commit does what the reviewed dry run said.
//
// A skip writes no external_ref for its person (nothing is committed for it), so a later stage that treated that
// person as a pending 'attach' planned `will_import` and the commit then failed it PARENT_NOT_FOUND. The contacts
// plan now says what the skip points at: the earlier row of this import (an in-file duplicate: same id, phone or
// email) or the existing contact it matched with nothing new to fill (R-IMPORT-7 "exact matches attach"). Pure.
import { describe, expect, it } from 'vitest';
import type { ContactId } from '../foundation/index.js';
import { type ContactsStagePlan, type ExistingIndexInput, type NormalizedRecord, type RecordOutcome, buildExistingIndex, commitPlan, contactsStagePlan, dryRun, mapFub } from './index.js';
import { USERS, emptyIndexInput, existingContact, simulateCommit } from './testing/fixtures.js';

const C9 = '00000000-0000-7000-8000-0000000c0009' as ContactId;
const PHONE = '(415) 820-0001';
const OTHER_PHONE = '(415) 820-0002';

function person(id: number, last: string, extra: Record<string, unknown> = {}): RecordOutcome<NormalizedRecord> {
  return mapFub('contacts', { id, firstName: 'Ann', lastName: last, phones: [{ value: PHONE, type: 'mobile', status: 'Valid' }], assignedUserId: 11, ...extra }, USERS);
}
const note = (id: number, personId: number) => mapFub('notes', { id, personId, body: `Note ${id}`, created: '2025-01-15T16:00:00Z' }, USERS);
const text = (id: number, personId: number) => mapFub('messages', { id, personId, created: '2025-03-01T18:00:00Z', isIncoming: true, message: `Text ${id}`, status: 'Received' }, USERS);
const callOf = (id: number, personId: number) => mapFub('call_recordings', { id, personId, created: '2025-04-04T15:00:00Z', isIncoming: false, duration: 60, outcome: 'Interested', userId: 11 }, USERS);
const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

/** The contacts dry run, then what a later stage sees before and after the contacts commit (as the API builds it). */
function contactsThen(input: ExistingIndexInput, people: RecordOutcome<NormalizedRecord>[]) {
  const contacts = dryRun('contacts', people, buildExistingIndex(input));
  const plan = contactsStagePlan(contacts);
  const before = buildExistingIndex({ ...input, contactsStage: plan });
  const cp = commitPlan(contacts, [], contacts.snapshotSha256, before);
  if (!cp.ok) throw new Error(cp.code);
  const committed = simulateCommit(input, cp.items);
  // the API's contactsStageMap after the commit: committed people are in external_refs; a skip is never committed
  const after = buildExistingIndex({ ...committed, contactsStage: new Map([...plan].filter(([, p]) => typeof p === 'object')) });
  const idOf = (ref: string) => committed.externalRefs!.find((r) => r.entityType === 'contact' && r.externalId === ref)?.entityId;
  return { contacts, plan, before, after, committed, idOf };
}

describe('B6: history of a person whose contacts record was skipped as a duplicate', () => {
  it('an in-file duplicate chain (three rows sharing a phone): the contacts plan points the two later rows at the first; their notes, texts and calls go on its contact, before and after the contacts commit', () => {
    const r = contactsThen(emptyIndexInput(), [person(301, 'One'), person(302, 'Again'), person(303, 'Third')]);
    expect(r.contacts.records.map((x) => [x.sourceRef, x.outcome, x.action?.kind, codes(x)])).toEqual([
      ['fub:people/301', 'will_import', 'create_contact', []],
      ['fub:people/302', 'duplicate', 'skip', ['IN_FILE_DUPLICATE']],
      ['fub:people/303', 'duplicate', 'skip', ['IN_FILE_DUPLICATE']],
    ]);
    expect(Object.fromEntries(r.plan)).toEqual({ '301': 'create', '302': { sameAs: { pendingPersonRef: '301' } }, '303': { sameAs: { pendingPersonRef: '301' } } });
    const history = (idx: ReturnType<typeof buildExistingIndex>) => [dryRun('notes', [note(9302, 302), note(9303, 303), note(9301, 301)], idx), dryRun('messages', [text(8302, 302)], idx), dryRun('call_recordings', [callOf(7303, 303)], idx)].flatMap((d) => d.records);
    // before the contacts commit: the pending person of the first row, and the record says why
    for (const x of history(r.before)) {
      expect({ ref: x.sourceRef, outcome: x.outcome, action: x.action }).toEqual({ ref: x.sourceRef, outcome: 'will_import', action: { kind: 'insert_history', contact: { pendingPersonRef: '301' } } });
      expect(codes(x)).toEqual(x.sourceRef === 'fub:notes/9301' ? [] : ['PARENT_DUPLICATE']);
    }
    // after it: the first row's contact, named in the plan and as the record's match
    const c301 = r.idOf('301') as ContactId;
    expect(c301).toBeDefined();
    for (const x of history(r.after)) {
      expect({ ref: x.sourceRef, outcome: x.outcome, action: x.action, match: x.matchContactId }).toEqual({ ref: x.sourceRef, outcome: 'will_import', action: { kind: 'insert_history', contact: { contactId: c301 } }, match: c301 });
    }
  });

  it('an exact match to a contact an earlier batch created, with nothing new to fill: its notes go on that contact', () => {
    const first = contactsThen(emptyIndexInput(), [person(301, 'One')]);
    const c301 = first.idOf('301') as ContactId;
    const second = contactsThen({ ...first.committed, batchId: '00000000-0000-7000-8000-00000000b002', contactsStage: new Map() }, [person(401, 'One')]);
    expect(second.contacts.records.map((x) => [x.outcome, x.action, x.matchContactId])).toEqual([['duplicate', { kind: 'skip', existingId: c301 }, c301]]);
    expect(Object.fromEntries(second.plan)).toEqual({ '401': { sameAs: { contactId: c301 } } });
    for (const idx of [second.before, second.after]) {
      const n = dryRun('notes', [note(9401, 401)], idx).records[0]!;
      expect({ outcome: n.outcome, action: n.action, match: n.matchContactId, issues: codes(n) }).toEqual({ outcome: 'will_import', action: { kind: 'insert_history', contact: { contactId: c301 } }, match: c301, issues: ['PARENT_DUPLICATE'] });
    }
  });

  it('a duplicate of a row that itself matched an existing contact with nothing new: the chain ends at that contact', () => {
    const first = contactsThen(emptyIndexInput(), [person(301, 'One')]);
    const c301 = first.idOf('301') as ContactId;
    const r = contactsThen({ ...first.committed, batchId: '00000000-0000-7000-8000-00000000b002', contactsStage: new Map() }, [person(401, 'One'), person(402, 'Again', { phones: [{ value: PHONE, type: 'mobile', status: 'Valid' }, { value: OTHER_PHONE, type: 'home', status: 'Valid' }] })]);
    expect(Object.fromEntries(r.plan)).toEqual({ '401': { sameAs: { contactId: c301 } }, '402': { sameAs: { pendingPersonRef: '401' } } });
    for (const idx of [r.before, r.after]) {
      const n = dryRun('notes', [note(9402, 402)], idx).records[0]!;
      expect([n.outcome, n.action, n.matchContactId, codes(n)]).toEqual(['will_import', { kind: 'insert_history', contact: { contactId: c301 } }, c301, ['PARENT_DUPLICATE']]);
    }
  });

  it('the duplicate follows the earlier row: under review → PARENT_NOT_LINKED, rejected → PARENT_REJECTED, gone → PARENT_NOT_FOUND (the dry run never promises what the commit cannot do)', () => {
    const sameAs301: ContactsStagePlan = { sameAs: { pendingPersonRef: '301' } };
    const cases: [ContactsStagePlan | undefined, string, string[]][] = [
      ['needs_review', 'needs_review', ['PARENT_DUPLICATE', 'PARENT_NOT_LINKED']],
      ['rejected', 'rejected', ['PARENT_DUPLICATE', 'PARENT_REJECTED']],
      [undefined, 'rejected', ['PARENT_DUPLICATE', 'PARENT_NOT_FOUND']],
    ];
    for (const [target, outcome, issues] of cases) {
      const stage = new Map<string, ContactsStagePlan>([['302', sameAs301], ...(target === undefined ? [] : ([['301', target]] as [string, ContactsStagePlan][]))]);
      const n = dryRun('notes', [note(9302, 302)], buildExistingIndex(emptyIndexInput({ contactsStage: stage }))).records[0]!;
      expect({ target, outcome: n.outcome, issues: [...codes(n)].sort() }).toEqual({ target, outcome, issues });
    }
    // an existing contact that was deleted or merged away since: followed like any match (merge → survivor; deleted → not found)
    const gone = existingContact({ contactId: C9, ownershipState: 'closed', closedReason: 'deleted' });
    const n = dryRun('notes', [note(9401, 401)], buildExistingIndex(emptyIndexInput({ contacts: [gone], contactsStage: new Map([['401', { sameAs: { contactId: C9 } }]]) }))).records[0]!;
    expect([n.outcome, codes(n).sort()]).toEqual(['rejected', ['PARENT_DUPLICATE', 'PARENT_NOT_FOUND']]);
  });

  it('R-IMPORT-7 R-OWN-21: a skipped duplicate never assigns its person (the earlier row or the existing contact keeps its owner); its consent goes on the same contact', () => {
    const r = contactsThen(emptyIndexInput(), [person(301, 'One'), person(302, 'Again', { assignedUserId: 12 })]);
    for (const idx of [r.before, r.after]) {
      const own = dryRun('ownership', [mapFub('ownership', { id: 302, firstName: 'Ann', lastName: 'Again', assignedUserId: 12 }, USERS)], idx).records[0]!;
      expect([own.outcome, own.action, codes(own)]).toEqual(['duplicate', { kind: 'skip', existingId: '302' }, ['OWNER_KEPT']]);
    }
    const consent = mapFub('consent', { id: 302, firstName: 'Ann', lastName: 'Again', phones: [{ value: PHONE, type: 'mobile', status: 'Opted Out' }] }, USERS);
    const before = dryRun('consent', [consent], r.before).records[0]!;
    expect([before.outcome, before.action?.kind === 'record_consent' ? before.action.contact : null]).toEqual(['will_import', { pendingPersonRef: '301' }]);
    const after = dryRun('consent', [consent], r.after).records[0]!;
    expect([after.outcome, after.action?.kind === 'record_consent' ? [after.action.contact, after.action.revokes] : null]).toEqual(['will_import', [{ contactId: r.idOf('301') }, 1]]);
  });
});
