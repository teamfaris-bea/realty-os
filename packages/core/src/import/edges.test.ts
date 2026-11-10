// Edge cases of the dry run, commit plan, revert and report that the scenario tests do not reach.
import { describe, expect, it } from 'vitest';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import type { ContactId } from '../foundation/index.js';
import { sequentialIds } from '../foundation/index.js';
import {
  type ColumnMapping,
  type NormalizedConsent,
  type NormalizedRecord,
  type RecordOutcome,
  buildExistingIndex,
  commitChunks,
  commitPlan,
  contactsStagePlan,
  csvConsentRecords,
  decodeText,
  dryRun,
  mapFub,
  mapImportedConsent,
  normalizeCsv,
  normalizeCsvRow,
  optOutPreview,
  parseCsv,
  reportLines,
  suggestMapping,
} from './index.js';
import { FUB_EXPORT, T0, USERS, csvBytes, emptyIndexInput, existingContact, testKey } from './testing/fixtures.js';

const C1 = '00000000-0000-7000-8000-0000000c0001' as ContactId;
const C2 = '00000000-0000-7000-8000-0000000c0002' as ContactId;
const C3 = '00000000-0000-7000-8000-0000000c0003' as ContactId;
const US = { defaultCountry: 'US' } as const;

function csv(text: string) {
  const p = parseCsv(csvBytes(text), { maxRows: 1000 });
  if ('error' in p) throw new Error(p.error.code);
  return normalizeCsv(p, suggestMapping(p.headers), US, 'f.csv');
}

function consentRecord(fields: NormalizedConsent['fields'], issues: RecordOutcome<NormalizedRecord>['issues'] = [], status: 'valid' | 'needs_review' = 'valid'): RecordOutcome<NormalizedRecord> {
  return { sourceRef: 'c#1', status, issues, record: { category: 'consent', sourceRef: 'c#1', personRef: 'p1', fields, provenance: {} } };
}

describe('decoding and parsing edges', () => {
  it('decodes multi-byte UTF-8 (2, 3 and 4 bytes) and a BOM followed by invalid UTF-8 falls back to Windows-1252', () => {
    expect(decodeText(utf8ToBytes('é€😀'))).toEqual({ text: 'é€😀', encoding: 'utf-8' });
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0xff])).encoding).toBe('windows-1252');
    expect(decodeText(new Uint8Array([0xe2, 0x82])).encoding).toBe('windows-1252'); // truncated sequence
  });

  it('a quoted header with a comma does not fool delimiter detection; a lone CR inside quotes counts as a line', () => {
    const p = parseCsv(csvBytes('"Name, full";Phone\n"a;b";1\n'), { maxRows: 10 });
    expect('error' in p ? p.error : p.delimiter).toBe(';');
    expect(parseCsv(csvBytes('Name,Notes\nA,"x\ry\n"\nB,"unterminated'), { maxRows: 10 })).toEqual({ error: { code: 'CSV_UNTERMINATED_QUOTE', line: 5 } });
  });

  it('an oversized unquoted field, a limit hit on a final row without newline, and a delimiter-only file are refused', () => {
    expect(parseCsv(csvBytes(`Name\n${'x'.repeat(40_000)}\n`), { maxRows: 10 })).toMatchObject({ error: { code: 'CSV_FIELD_TOO_LARGE', line: 2 } });
    expect(parseCsv(csvBytes('Name\nA\nB'), { maxRows: 1 })).toMatchObject({ error: { code: 'CSV_TOO_MANY_ROWS' } });
    expect(parseCsv(csvBytes(',,,\n , ,\n'), { maxRows: 10 })).toEqual({ error: { code: 'CSV_NO_HEADER' } });
  });
});

describe('row normalization edges', () => {
  it('numbered phone/email headers map; unknown type and intent are flagged and kept', () => {
    expect(suggestMapping(['Phone 7', 'Email 4', 'Home Phone'])).toEqual([{ field: 'phone' }, { field: 'email' }, { field: 'phone_home' }]);
    const [r] = csv('Name,Email,Type,Intent,Home Phone\nA,a@example.com,Martian,Maybe later,415-555-0132\n');
    expect(r?.issues.map((i) => i.code)).toEqual(['TYPE_UNMAPPED', 'INTENT_UNMAPPED']);
    expect(r?.record).toMatchObject({ contactType: 'lead', intent: null, importedFields: { 'Original type': 'Martian', 'Original intent': 'Maybe later' } });
    expect(r?.record?.phones[0]?.label).toBe('home');
    const [s] = csv('Name,Email,Type,Intent\nB,b@example.com,Vendor,Investor\n');
    expect(s?.record).toMatchObject({ contactType: 'vendor', intent: 'investor' });
  });

  it('ZIP+4 (with a dropped leading zero) and countries normalize', () => {
    const [a] = csv('Name,Email,Zip,Country\nA,a@example.com,2134-1234,USA\n');
    expect(a?.record?.addresses[0]).toMatchObject({ postalCode: '02134-1234', country: 'US' });
    const [b] = csv('Name,Email,Zip,Country\nB,b@example.com,94110 1234,ca\n');
    expect(b?.record?.addresses[0]).toMatchObject({ postalCode: '94110-1234', country: 'CA' });
    const [c] = csv('Name,Email,City,Country\nC,c@example.com,Cair Paravel,Narnia\n');
    expect(c?.record?.addresses[0]).toMatchObject({ country: 'US' });
  });

  it('caps: at most 10 phones/emails, 100 tags, 200 imported fields; duplicate custom keys and control-only values are dropped', () => {
    const phones = Array.from({ length: 12 }, (_, i) => `415-555-${String(100 + i).padStart(4, '0')}`).join(';');
    const emails = Array.from({ length: 12 }, (_, i) => `e${i}@example.com`).join(';');
    const tags = Array.from({ length: 105 }, (_, i) => `t${i}`).join(',');
    const m: ColumnMapping = [{ field: 'full_name' }, { field: 'phone' }, { field: 'email' }, { field: 'tags' }, ...Array.from({ length: 205 }, (_, i) => ({ field: 'custom' as const, key: `k${i % 203}` })), { field: 'custom', key: 'ctl' }];
    const r = normalizeCsvRow(['A', phones, emails, tags, ...Array.from({ length: 205 }, () => 'v'), '\u0001\u0002'], m, US);
    expect(r.record?.phones).toHaveLength(10);
    expect(r.record?.emails).toHaveLength(10);
    expect(r.record?.tags).toHaveLength(100);
    expect(Object.keys(r.record?.importedFields ?? {})).toHaveLength(200);
    expect(r.record?.importedFields['ctl']).toBeUndefined();
    expect(r.issues.filter((i) => i.code === 'TOO_MANY_VALUES').map((i) => i.field).sort()).toEqual(['email', 'email', ...Array(4).fill('imported_fields'), 'phone', 'phone', 'tags']);
    const small = normalizeCsvRow(['A', '\u0001\u0002', 'x', 'y'], [{ field: 'full_name' }, { field: 'custom', key: 'ctl' }, { field: 'custom', key: 'dup' }, { field: 'custom', key: 'dup' }], US);
    expect(small.record?.importedFields).toEqual({ dup: 'x' });
  });

  it('with a hand-edited mapping, a repeated single-valued field keeps the first value; long names are truncated', () => {
    const r = normalizeCsvRow(['Ann', 'Bea', 'x'.repeat(300)], [{ field: 'first_name' }, { field: 'first_name' }, { field: 'last_name' }], US);
    expect(r.record?.firstName).toBe('Ann');
    expect(r.record?.lastName).toHaveLength(200);
    expect(r.issues).toContainEqual({ code: 'VALUE_TRUNCATED', severity: 'info', field: 'last_name' });
  });

  it('flag columns: opted_out/unsubscribed/DNC read yes as set, no as clear, anything else as unrecognized; explicit revoke words revoke', () => {
    const rows = csv(
      'Name,Phone,Email,Opted Out,Unsubscribed,DNC,Text Consent\n' +
        'A,415-555-0101,a@example.com,no,yes,,\n' +
        'B,415-555-0102,,perhaps,,,\n' +
        'C,415-555-0103,,,,,stop\n',
    );
    const consent = csvConsentRecords(rows);
    expect(consent[0]?.record?.fields.addresses).toEqual([{ kind: 'email', address: 'a@example.com', grants: [], revokes: ['email'], doNotContact: false }]);
    expect(consent[1]).toMatchObject({ status: 'needs_review', issues: [{ code: 'CONSENT_VALUE_UNRECOGNIZED', field: 'opted_out' }, { code: 'NO_CONSENT_DATA' }] });
    expect(consent[2]?.record?.fields.addresses).toEqual([{ kind: 'phone', address: '+14155550103', grants: [], revokes: ['sms'], doNotContact: false }]);
    // A row whose consent columns are all empty produces no consent-stage record.
    expect(csvConsentRecords(csv('Name,Phone,DNC\nA,415-555-0101,\n'))).toEqual([]);
  });
});

describe('FUB vocabulary', () => {
  const call = (outcome: string | null, duration: number | string | null = 10) =>
    mapFub('call_recordings', { id: 1, personId: 1, created: '2026-01-01T00:00:00Z', outcome, duration }, USERS).record;

  it('call outcomes and durations map conservatively', () => {
    expect(call('Wrong Number')).toMatchObject({ status: 'completed', outcome: 'wrong_number' });
    expect(call('Bad number / disconnected')).toMatchObject({ status: 'failed', outcome: 'bad_number' });
    expect(call('Busy')).toMatchObject({ status: 'busy', outcome: null });
    expect(call('Asked: do not call')).toMatchObject({ outcome: 'do_not_call_request' });
    expect(call('Call back Tuesday')).toMatchObject({ outcome: 'callback_requested' });
    expect(call('Something else', '42')).toMatchObject({ status: 'completed', outcome: null, durationS: 42, note: 'FUB outcome: Something else' });
    expect(call(null, null)).toMatchObject({ status: 'no_answer', durationS: null, note: null });
    expect(call(null, 'abc')).toMatchObject({ durationS: null });
  });

  it('message statuses, HTML emails and timestamps', () => {
    const t = (status: string | null) => mapFub('messages', { id: 1, personId: 1, created: '2026-01-01T00:00:00Z', isIncoming: 'false', message: 'hi', status }, USERS).record;
    expect(t('Undelivered')).toMatchObject({ status: 'undelivered', direction: 'outbound' });
    expect(t('Bounced')).toMatchObject({ status: 'bounced' });
    expect(t(null)).toMatchObject({ status: 'sent' });
    const html = mapFub('messages', { id: 2, personId: 1, created: '2026-01-01T00:00:00Z', isIncoming: 1, subject: null, body: '<div>Hello</div>', isHtml: true }, USERS);
    expect(html.record).toMatchObject({ channel: 'email', direction: 'inbound', status: 'received', body: 'Hello', subject: null });
    expect(mapFub('messages', { id: 3, personId: 1, created: 'yesterday', message: 'x' }, USERS)).toMatchObject({ status: 'rejected' });
    expect(mapFub('messages', { id: 4, personId: 1, created: '2026-01-01T00:00:00Z', body: 7 }, USERS)).toMatchObject({ status: 'rejected' });
    expect(mapFub('notes', { id: 5, personId: 1, created: 'nope', body: 'b' }, USERS)).toMatchObject({ status: 'rejected', issues: [{ code: 'TIMESTAMP_INVALID' }, { code: 'RECORD_MALFORMED' }] });
  });

  it('a note over 20,000 characters is truncated and flagged for review', () => {
    const r = mapFub('notes', { id: 6, personId: 1, created: '2026-01-01T00:00:00Z', body: 'y'.repeat(25_000) }, USERS);
    expect(r.status).toBe('needs_review');
    expect(r.record).toMatchObject({ body: 'y'.repeat(20_000) });
  });

  it('person details: point statuses, address kinds, ZIPs, name-only people, extra fields', () => {
    const r = mapFub(
      'contacts',
      {
        id: 7,
        name: 'Cher',
        type: 'Buyer',
        background: 'Met at open house',
        price: 450000,
        customTags: [{ nested: true }],
        customNote: { a: 1 },
        phones: [
          { value: '415-555-0101', status: 'Not Valid', type: 'office' },
          { value: '415-555-0102', status: 'Wrong number', type: null },
        ],
        emails: [{ value: 'cher@example.com' }],
        addresses: [
          { type: 'Mailing', street: '1 A St', code: '2134', country: 'ca', state: 'Ontario' },
          { type: 'Investment Property', city: 'X', code: 'ABC' },
          { type: 'home' },
        ],
      },
      USERS,
    );
    expect(r.record).toMatchObject({
      firstName: 'Cher',
      lastName: null,
      displayName: 'Cher',
      importedFields: { 'FUB type': 'Buyer', 'FUB background': 'Met at open house', 'FUB price': '450000' },
      phones: [
        { e164: '+14155550101', status: 'invalid', label: 'work' },
        { e164: '+14155550102', status: 'wrong_number', label: 'other' },
      ],
    });
    if (r.record?.category !== 'contacts') throw new Error('category');
    expect(r.record.addresses.map((a) => [a.kind, a.postalCode, a.country, a.region])).toEqual([
      ['mailing', '02134', 'CA', 'Ontario'],
      ['property', null, 'US', null],
    ]);
    expect(r.issues).toContainEqual({ code: 'POSTAL_INVALID', severity: 'error', field: 'addresses' });
    expect(Object.keys(r.record.importedFields)).not.toContain('customNote');
    const noName = mapFub('contacts', { id: 8, emails: [{ value: 'z@example.com' }] }, USERS);
    expect(noName.issues).toContainEqual({ code: 'NAME_MISSING', severity: 'info' });
    expect(mapFub('contacts', { id: 9, name: 'Mary Ann Smith' }, USERS).record).toMatchObject({ firstName: 'Mary', lastName: 'Ann Smith' });
  });

  it('consent flags: string truthiness, doNotCall, duplicate points and a pond nobody mapped', () => {
    const r = mapFub(
      'consent',
      {
        id: 10,
        callOptIn: 'yes',
        smsOptIn: 'no',
        doNotCall: 1,
        phones: [{ value: '415-555-0101' }, { value: '(415) 555-0101' }, { value: 'bad' }],
        emails: [{ value: 'a@example.com' }, { value: 'A@example.com' }, { value: 'nope' }],
      },
      USERS,
    );
    if (r.record?.category !== 'consent') throw new Error('category');
    expect(r.record.fields.addresses).toEqual([{ kind: 'phone', address: '+14155550101', grants: [], revokes: ['voice'], doNotContact: false }]);
    expect(r.issues).toContainEqual({ code: 'CONSENT_CONFLICT', severity: 'info' });
    const tagOptOut = mapFub('consent', { id: 11, tags: ['Opted Out'], phones: [{ value: '415-555-0101' }], emails: [{ value: 'a@example.com' }], emailOptIn: true }, USERS);
    if (tagOptOut.record?.category !== 'consent') throw new Error('category');
    expect(tagOptOut.record.fields.addresses.map((a) => a.revokes)).toEqual([['sms', 'voice'], ['email']]);
    expect(mapFub('ownership', { id: 12, assignedPondId: 77 }, USERS)).toMatchObject({ status: 'rejected', issues: [{ code: 'USER_UNMAPPED' }] });
  });
});

describe('dry-run edges', () => {
  it('index tolerates repeated points, punctuation-only names and repeated opt-out rows', () => {
    const idx = buildExistingIndex(
      emptyIndexInput({
        contacts: [existingContact({ contactId: C1, displayName: '!!!', phones: ['+14155550132', '+14155550132'] })],
        optedOut: [
          { key: testKey('phone', '+14155550132'), channel: 'sms' },
          { key: testKey('phone', '+14155550132'), channel: 'sms' },
        ],
      }),
    );
    expect(idx.byAddress.get(testKey('phone', '+14155550132'))).toEqual([C1]);
    expect(idx.byName.size).toBe(0);
    expect(idx.optedOut.get(testKey('phone', '+14155550132'))).toEqual(['sms']);
  });

  it('merge redirect cycles and dangling redirects are treated as no match', () => {
    const idx = buildExistingIndex(
      emptyIndexInput({
        contacts: [
          existingContact({ contactId: C1, mergedIntoContactId: C2, phones: ['+14155550132'] }),
          existingContact({ contactId: C2, mergedIntoContactId: C1 }),
          existingContact({ contactId: C3, mergedIntoContactId: '00000000-0000-7000-8000-0000000c0099' as ContactId, emails: ['x@example.com'] }),
        ],
      }),
    );
    const d = dryRun('contacts', csv('Name,Phone\nA,415-555-0132\nB,\n').concat(csv('Name,Email\nC,x@example.com\n').map((r) => ({ ...r, sourceRef: 'g#2' }))), idx);
    expect(d.records.map((r) => r.action?.kind)).toEqual(['create_contact', 'create_contact', 'create_contact']);
  });

  it('a re-run whose linked contact was deleted goes to review instead of silently re-creating it', () => {
    const idx = buildExistingIndex(
      emptyIndexInput({ contacts: [existingContact({ contactId: C1, ownershipState: 'closed', closedReason: 'deleted' })], externalRefs: [{ entityType: 'contact', externalId: '1004', entityId: C1 }] }),
    );
    const d = dryRun('contacts', [mapFub('contacts', FUB_EXPORT.people[3], USERS)], idx);
    expect(d.records[0]).toMatchObject({ outcome: 'needs_review', action: { kind: 'create_contact' }, issues: expect.arrayContaining([{ code: 'MATCH_DELETED_CONTACT', severity: 'review' }]) });
    // History for a deleted contact has no parent.
    const notes = dryRun('notes', [mapFub('notes', { id: 1, personId: 1004, created: '2026-01-01T00:00:00Z', body: 'x' }, USERS)], idx);
    expect(notes.records[0]?.issues).toContainEqual({ code: 'PARENT_NOT_FOUND', severity: 'error' });
  });

  it('an exact match with nothing new is a duplicate; an agent-owned one is still noted', () => {
    const idx = buildExistingIndex(emptyIndexInput({ contacts: [existingContact({ contactId: C1, firstName: 'A', ownershipState: 'owned', ownerUserId: 'u' as never, phones: ['+14155550132'] })] }));
    const d = dryRun('contacts', csv('First Name,Phone\nA,415-555-0132\n'), idx);
    expect(d.records[0]).toMatchObject({ outcome: 'duplicate', action: { kind: 'skip', existingId: C1 }, issues: [{ code: 'MATCH_OWNED_CONTACT', severity: 'info' }] });
  });

  it('E41 a contact on offer to an agent right now is flagged for review like an owned one', () => {
    const idx = buildExistingIndex(emptyIndexInput({ contacts: [existingContact({ contactId: C1, ownershipState: 'offered', phones: ['+14155550132'] })] }));
    const d = dryRun('contacts', csv('First Name,Phone,Email\nA,415-555-0132,a@example.com\n'), idx);
    expect(d.records[0]).toMatchObject({ outcome: 'needs_review', action: { kind: 'attach_contact', contactId: C1 }, issues: [{ code: 'MATCH_OWNED_CONTACT', severity: 'review' }] });
  });

  it('a display name with no letters or digits never name-matches', () => {
    const idx = buildExistingIndex(emptyIndexInput({ contacts: [existingContact({ contactId: C1, displayName: 'Ann' })] }));
    expect(dryRun('contacts', csv('Name\n???\n'), idx).records[0]?.action).toEqual({ kind: 'create_contact', duplicateCandidates: [] });
  });

  it('a record carrying a record-level error is rejected in every stage whatever its status says', () => {
    const idx = buildExistingIndex(emptyIndexInput({ contactsStage: new Map([['1001', 'create']]) }));
    const bad = { code: 'RECORD_MALFORMED' as const, severity: 'error' as const };
    for (const c of ['contacts', 'ownership', 'notes', 'consent'] as const) {
      const raw = c === 'notes' ? FUB_EXPORT.notes[0] : FUB_EXPORT.people[0];
      const r = mapFub(c, raw, USERS);
      const d = dryRun(c, [{ ...r, status: 'valid', issues: [bad] } as RecordOutcome<NormalizedRecord>], idx);
      expect(d.records[0]?.outcome, c).toBe('rejected');
    }
    expect(contactsStagePlan(dryRun('contacts', [{ ...mapFub('contacts', FUB_EXPORT.people[3], USERS), status: 'valid', issues: [bad] } as RecordOutcome<NormalizedRecord>], idx))).toEqual(new Map([['1004', 'rejected']]));
  });

  it('contactsStagePlan: CSV refs, attach plans, and other stages are ignored', () => {
    const idx = buildExistingIndex(emptyIndexInput({ contacts: [existingContact({ contactId: C1, emails: ['b@example.com'] })] }));
    const d = dryRun('contacts', csv('Name,Email\n,not-an-email\nB,b@example.com\n'), idx);
    expect(contactsStagePlan(d)).toEqual(new Map([['f.csv#row=2', 'rejected'], ['f.csv#row=3', 'attach']]));
    expect(contactsStagePlan(dryRun('notes', [mapFub('notes', FUB_EXPORT.notes[1], USERS)], idx)).size).toBe(0);
  });

  it('consent: preview of an already opted-out address, nothing to record, unreadable values go to review, review import of a no-op is a no-op', () => {
    const idx = buildExistingIndex(emptyIndexInput({ optedOut: [{ key: testKey('phone', '+14155550132'), channel: 'sms' }] }));
    const grant = dryRun('consent', [consentRecord({ addresses: [{ kind: 'phone', address: '+14155550132', grants: ['sms'], revokes: [], doNotContact: false }], occurredAt: null })], idx);
    expect(grant.records[0]).toMatchObject({ outcome: 'will_import', staysOptedOut: ['sms'], issues: [{ code: 'ADDRESS_OPTED_OUT', severity: 'info' }] });
    expect(optOutPreview(['sms'])).toBe('Opted out of texts. Will stay opted out.');
    const empty = dryRun('consent', [consentRecord({ addresses: [], occurredAt: null })], idx);
    expect(empty.records[0]).toMatchObject({ outcome: 'duplicate', issues: [{ code: 'NO_CONSENT_DATA', severity: 'info' }] });
    const unreadable = dryRun('consent', [consentRecord({ addresses: [], occurredAt: null }, [{ code: 'CONSENT_VALUE_UNRECOGNIZED', severity: 'review', field: 'consent_sms' }], 'needs_review')], idx);
    expect(unreadable.records[0]?.outcome).toBe('needs_review');
    const p = commitPlan(unreadable, [{ sourceRef: 'c#1', decision: 'import' }], unreadable.snapshotSha256, idx);
    expect(p).toMatchObject({ ok: true, items: [], expected: { source: 1, imported: 0, needs_review: 0, rejected: 0, duplicate: 1 } });
  });

  it('a merge may target a duplicate candidate of an attach plan', () => {
    const idx = buildExistingIndex(
      emptyIndexInput({
        contacts: [existingContact({ contactId: C1, createdAt: 1 as never, phones: ['+14155550132'] }), existingContact({ contactId: C2, createdAt: 2 as never, phones: ['+14155550132'] })],
      }),
    );
    const d = dryRun('contacts', csv('Name,Phone\nA,415-555-0132\n'), idx);
    const r = d.records[0];
    expect(r?.action).toMatchObject({ kind: 'attach_contact', contactId: C1, duplicateCandidates: [{ contactId: C2, reason: 'shared_phone' }] });
    const flagged = { ...d, records: [{ ...(r as NonNullable<typeof r>), outcome: 'needs_review' as const }] };
    const p = commitPlan(flagged, [{ sourceRef: 'f.csv#row=2', decision: 'merge', mergeIntoContactId: C2 }], d.snapshotSha256, idx);
    expect(p.ok && p.items[0]?.action).toMatchObject({ kind: 'attach_contact', contactId: C2 });
  });

  it('commitChunks with an unknown resume ref starts from the beginning', () => {
    expect(commitChunks([{ sourceRef: 'a' }, { sourceRef: 'b' }], { resumeAfter: 'zzz', size: 1 })).toEqual([[{ sourceRef: 'a' }], [{ sourceRef: 'b' }]]);
    expect(commitChunks([{ sourceRef: 'a' }], { resumeAfter: null })).toEqual([[{ sourceRef: 'a' }]]);
  });
});

describe('consent and report edges', () => {
  it('mapImportedConsent refuses a non-import source: building a non-imported event from an import is a programming error', () => {
    expect(() =>
      mapImportedConsent({ addresses: [{ kind: 'phone', address: '+14155550132', grants: ['sms'], revokes: [], doNotContact: false }], occurredAt: null }, {}, {
        ids: sequentialIds(),
        now: T0,
        hmac: testKey,
        source: 'web_form' as never,
        contactId: null,
        importRecordId: 'r',
      }),
    ).toThrow(/invalid consent event/);
  });

  it('consent copy only mentions what happened: no texting line at zero, singular opt-out', () => {
    const lines = reportLines('consent', 'dry_run', { source: 1, imported: 1, needs_review: 0, rejected: 0, duplicate: 0 }, 'your file', { textingPermission: 0, emailPermission: 0, optedOut: 1, doNotContact: 0 });
    expect(lines.slice(2)).toEqual(['1 contact had opted out. That stays opted out.']);
    expect(reportLines('consent', 'dry_run', { source: 0, imported: 0, needs_review: 0, rejected: 0, duplicate: 0 }, 'your file', { textingPermission: 0, emailPermission: 0, optedOut: 0, doNotContact: 0 })).toHaveLength(2);
    expect(reportLines('call_recordings', 'committed', { source: 1, imported: 0, needs_review: 0, rejected: 1, duplicate: 0 }, 'Follow Up Boss')).toHaveLength(2);
  });
});

describe('normalizer leftovers', () => {
  it('finish(): a built record with a record-level error is rejected; a consent column that says nothing makes no record', async () => {
    const { finish } = await import('./csv.js');
    expect(finish('r', { x: 1 }, [{ code: 'NO_IDENTITY', severity: 'error' }])).toEqual({ sourceRef: 'r', status: 'rejected', record: null, issues: [{ code: 'NO_IDENTITY', severity: 'error' }] });
    expect(finish('r', { x: 1 }, [{ code: 'NAME_MISSING', severity: 'info' }]).status).toBe('valid');
    expect(csvConsentRecords(csv('Name,Phone,Opted Out\nA,415-555-0101,no\n'))).toEqual([]);
  });

  it('a note with only a subject, an address without a type, and a connection test missing one message collection', async () => {
    expect(mapFub('notes', { id: 1, personId: 1, created: '2026-01-01T00:00:00Z', subject: 'Only a subject' }, USERS).record).toMatchObject({ body: 'Only a subject' });
    const r = mapFub('contacts', { id: 2, name: 'Z', addresses: [{ city: 'Y' }] }, USERS);
    expect(r.record?.category === 'contacts' && r.record.addresses[0]?.kind).toBe('home');
    const { fubConnectionCounts } = await import('./index.js');
    expect(fubConnectionCounts({ textMessages: { _metadata: { total: 3 } } }).categories.messages).toBeNull();
  });
});

describe('stage vocabulary', () => {
  // Supports R-IMPORT-3 (the commit-order guard itself is a DB trigger, tested by db/client / api/imports).
  it('stage seq is fixed by category (contacts 1 … consent 6), matching the import_stages CHECK', async () => {
    const { CATEGORIES, categorySeq, isCategory } = await import('./index.js');
    expect(CATEGORIES.map(categorySeq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(CATEGORIES).toEqual(['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent']);
    expect([isCategory('notes'), isCategory('deals')]).toEqual([true, false]);
  });
});
