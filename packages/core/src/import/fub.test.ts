import { describe, expect, it } from 'vitest';
import { FUB_COUNT_ONLY_COLLECTIONS, fubConnectionCounts, fubNotImportedCounts, connectionTestLines, htmlToText, mapFub, notImportedLines, userMappingGaps, type Category, type RecordOutcome, type NormalizedRecord } from './index.js';
import { AGENT_A, AGENT_B, FUB_EXPORT, POND, USERS } from './testing/fixtures.js';

const people = FUB_EXPORT.people as readonly unknown[];

function mapAll(category: Category, raws: readonly unknown[]): RecordOutcome<NormalizedRecord>[] {
  return raws.map((r) => mapFub(category, r, USERS));
}

function byRef<T extends { sourceRef: string }>(xs: readonly T[], ref: string): T {
  const x = xs.find((y) => y.sourceRef === ref);
  if (!x) throw new Error(`missing ${ref}`);
  return x;
}

describe('golden FUB export: every category normalizes to the pinned output', () => {
  it('contacts golden', () => expect(mapAll('contacts', people)).toMatchSnapshot());
  it('ownership golden', () => expect(mapAll('ownership', people)).toMatchSnapshot());
  it('notes golden', () => expect(mapAll('notes', FUB_EXPORT.notes)).toMatchSnapshot());
  it('messages golden', () => expect(mapAll('messages', [...FUB_EXPORT.textMessages, ...FUB_EXPORT.emails])).toMatchSnapshot());
  it('call_recordings golden', () => expect(mapAll('call_recordings', FUB_EXPORT.calls)).toMatchSnapshot());
  it('consent golden', () => expect(mapAll('consent', people)).toMatchSnapshot());
});

describe('FUB contacts', () => {
  const out = mapAll('contacts', people);

  it('custom fields, original stage, source and assignee label go to imported_fields (display-only), tags are de-duplicated', () => {
    const jane = byRef(out, 'fub:people/1001');
    expect(jane.status).toBe('needs_review'); // the second phone "555-0100" is rejected PHONE_INVALID
    expect(jane.record).toMatchObject({
      externalId: '1001',
      displayName: 'Jane Doe',
      stage: 'active',
      contactType: 'lead',
      tags: ['Buyer', 'Pre-approved'],
      leadSourceLabel: 'Zillow',
      importedFields: {
        'FUB stage': 'Hot Prospect',
        'FUB source': 'Zillow',
        'FUB source URL': 'https://example.com/listing/1',
        'FUB assigned to': 'Alex Agent',
        customBirthday: '1980-05-01',
        customPreApproved: 'true',
        customFavoriteNeighborhoods: 'Downtown, Riverside',
      },
    });
    expect(jane.issues).toContainEqual({ code: 'PHONE_INVALID', severity: 'error', field: 'phones' });
    if (jane.record?.category !== 'contacts') throw new Error('category');
    expect(jane.record.phones).toEqual([{ e164: '+14155550132', label: 'mobile', status: 'active', isPrimary: true }]);
    expect(jane.record.emails).toEqual([{ email: 'jane.doe@example.com', label: 'home', status: 'active', isPrimary: true }]);
    expect(jane.record.addresses[0]).toMatchObject({ region: 'IL', postalCode: '62701' });
  });

  it('point statuses carry over (bounced email → bouncing); a name-only person keeps a split name', () => {
    const carla = byRef(out, 'fub:people/1003');
    if (carla.record?.category !== 'contacts') throw new Error('category');
    expect(carla.record.emails[0]?.status).toBe('bouncing');
    expect(carla.record.contactType).toBe('sphere');
    const bob = byRef(out, 'fub:people/1002');
    if (bob.record?.category !== 'contacts') throw new Error('category');
    expect([bob.record.firstName, bob.record.lastName, bob.record.displayName]).toEqual(['Bob', 'Unsub', 'Bob Unsub']);
  });

  it('an unmapped FUB stage is flagged and kept as "FUB stage"', () => {
    const dan = byRef(out, 'fub:people/1004');
    expect(dan.issues).toContainEqual({ code: 'STAGE_UNMAPPED', severity: 'info', field: 'stage' });
    expect(dan.record).toMatchObject({ stage: 'new', importedFields: { 'FUB stage': 'Waiting On Lender' } });
  });

  it('a person with nothing usable is rejected NO_IDENTITY; a malformed object RECORD_MALFORMED', () => {
    expect(byRef(out, 'fub:people/1006')).toMatchObject({ status: 'rejected', record: null });
    expect(byRef(out, 'fub:people/unknown')).toMatchObject({ status: 'rejected', issues: [{ code: 'RECORD_MALFORMED', severity: 'error' }] });
  });

  it('never throws on arbitrary input', () => {
    for (const raw of [null, undefined, 42, 'x', [], { id: {} }, { id: 1, phones: 'nope' }, { id: 1, emails: [{ value: 7 }] }]) {
      for (const c of ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent'] as const) {
        expect(() => mapFub(c, raw, USERS)).not.toThrow();
        expect(mapFub(c, raw, USERS).status).toBe('rejected');
      }
    }
  });
});

describe('FUB ownership (R-IMPORT-8 core part: the user mapping decides the target)', () => {
  const out = mapAll('ownership', people);
  it('mapped user, pond, unassigned and FUB user mapped to "unassigned"', () => {
    expect(byRef(out, 'fub:people/1001').record).toMatchObject({ target: { userId: AGENT_A }, personRef: '1001' });
    expect(byRef(out, 'fub:people/1002').record).toMatchObject({ target: { userId: AGENT_B } });
    expect(byRef(out, 'fub:people/1003').record).toMatchObject({ target: { pondId: POND } });
    expect(byRef(out, 'fub:people/1004').record).toMatchObject({ target: 'unassigned' });
  });
  it('an unmapped agent is rejected USER_UNMAPPED and listed as a mapping gap', () => {
    expect(byRef(out, 'fub:people/1005')).toMatchObject({ status: 'rejected', issues: [{ code: 'USER_UNMAPPED', severity: 'error' }] });
    expect(userMappingGaps(people, USERS)).toEqual({ users: ['99'], ponds: [] });
    expect(userMappingGaps(people, { users: new Map() })).toEqual({ users: ['11', '12', '99'], ponds: ['3'] });
  });
});

describe('FUB history (notes, messages, calls)', () => {
  it('HTML notes become plain text with subject; authors map through the user mapping; empty bodies are rejected', () => {
    const out = mapAll('notes', FUB_EXPORT.notes);
    expect(byRef(out, 'fub:notes/501').record).toMatchObject({ body: 'Call recap\n\nWants 3 beds & a yard.\n\nBudget 500k', authorUserId: AGENT_A, personRef: '1001' });
    expect(byRef(out, 'fub:notes/502').record).toMatchObject({ authorUserId: null });
    expect(byRef(out, 'fub:notes/504')).toMatchObject({ status: 'rejected', issues: [{ code: 'BODY_EMPTY', severity: 'error' }] });
    expect(htmlToText('a<br/>b &lt;c&gt; &amp;amp;')).toBe('a\nb <c> &amp;');
  });

  it('messages: inbound is always received; outbound status maps; emails keep their subject', () => {
    const out = mapAll('messages', [...FUB_EXPORT.textMessages, ...FUB_EXPORT.emails]);
    expect(byRef(out, 'fub:textMessages/701').record).toMatchObject({ channel: 'sms', direction: 'inbound', status: 'received', externalId: 'textMessages/701' });
    expect(byRef(out, 'fub:textMessages/702').record).toMatchObject({ direction: 'outbound', status: 'delivered', userId: AGENT_A });
    expect(byRef(out, 'fub:textMessages/703').record).toMatchObject({ status: 'failed' });
    expect(byRef(out, 'fub:emails/801').record).toMatchObject({ channel: 'email', subject: 'Listings for you', status: 'sent', externalId: 'emails/801' });
  });

  it('calls: outcomes map; a recording is labelled "recording notice unknown", not transcribed, and its URL is not copied', () => {
    const out = mapAll('call_recordings', FUB_EXPORT.calls);
    const c901 = byRef(out, 'fub:calls/901');
    expect(c901.record).toMatchObject({
      status: 'completed',
      outcome: 'connected',
      durationS: 312,
      agentUserId: AGENT_A,
      recording: { consentBasis: 'unknown_imported', label: 'recording notice unknown', transcribe: false },
    });
    expect(JSON.stringify(c901.record)).not.toContain('token=secret');
    expect(c901.issues).toContainEqual({ code: 'RECORDING_NOTICE_UNKNOWN', severity: 'info' });
    expect(byRef(out, 'fub:calls/902').record).toMatchObject({ status: 'no_answer', outcome: 'no_answer', recording: null });
    expect(byRef(out, 'fub:calls/903').record).toMatchObject({ direction: 'inbound', status: 'voicemail', outcome: 'left_voicemail' });
    expect(byRef(out, 'fub:calls/904')).toMatchObject({ status: 'rejected' });
  });
});

describe('FUB consent indicators', () => {
  const out = mapAll('consent', people);

  it('E40 R-CONSENT-3 an unsubscribed / opted-out FUB contact yields revocations, and its positive flags yield no grant on those channels', () => {
    const bob = byRef(out, 'fub:people/1002');
    if (bob.record?.category !== 'consent') throw new Error('category');
    expect(bob.record.fields.addresses).toEqual([
      { kind: 'phone', address: '+13125550145', grants: [], revokes: ['sms'], doNotContact: false },
      { kind: 'email', address: 'bob@example.org', grants: [], revokes: ['email'], doNotContact: false },
    ]);
    expect(bob.issues).toContainEqual({ code: 'CONSENT_CONFLICT', severity: 'info' });
    expect(bob.record.provenance).toMatchObject({ source: 'fub', personId: '1002', flags: { smsOptIn: true, emailOptIn: true } });
  });

  it('a "DNC" tag is read as do-not-contact on every address (strictest reading, flagged)', () => {
    const carla = byRef(out, 'fub:people/1003');
    if (carla.record?.category !== 'consent') throw new Error('category');
    expect(carla.record.fields.addresses.every((a) => a.doNotContact)).toBe(true);
    expect(carla.issues).toContainEqual({ code: 'TAG_READ_AS_OPT_OUT', severity: 'info', field: 'tags' });
  });

  it('positive flags become grants (capped later); a person without indicators has nothing to record', () => {
    const jane = byRef(out, 'fub:people/1001');
    if (jane.record?.category !== 'consent') throw new Error('category');
    expect(jane.record.fields.addresses).toEqual([
      { kind: 'phone', address: '+14155550132', grants: ['sms'], revokes: [], doNotContact: false },
      { kind: 'email', address: 'jane.doe@example.com', grants: ['email'], revokes: [], doNotContact: false },
    ]);
    const dan = byRef(out, 'fub:people/1004');
    expect(dan.issues).toContainEqual({ code: 'NO_CONSENT_DATA', severity: 'info' });
  });
});

describe('R-IMPORT-1 connection test reads counts only and promises nothing', () => {
  it('counts come from _metadata.total; unreadable collections are null, never guessed', () => {
    const r = fubConnectionCounts({
      people: { _metadata: { collection: 'people', offset: 0, limit: 1, total: 1204 }, people: [{ id: 1, firstName: 'ignored' }] },
      notes: { _metadata: { total: 5310 } },
      textMessages: { _metadata: { total: 20000 } },
      emails: { _metadata: { total: 812 } },
      calls: { error: 'forbidden' },
    });
    expect(r.categories).toEqual({ contacts: 1204, ownership: 1204, notes: 5310, messages: 20812, call_recordings: null, consent: 1204 });
    expect(r.collections.users).toBeNull();
    const lines = connectionTestLines(r.categories, 'Follow Up Boss');
    expect(lines).toEqual([
      '1,204 contacts found in Follow Up Boss.',
      '5,310 notes found in Follow Up Boss.',
      '20,812 messages found in Follow Up Boss.',
      'We could not count calls in Follow Up Boss.',
      'Nothing is imported yet. Each step shows you exactly what would change before anything is written.',
    ]);
    // Counts only: no record content reaches the result.
    expect(JSON.stringify(r)).not.toContain('ignored');
  });

  it('E233 owner decision B7: FUB tasks and appointments are counted the same way (one-record pages), never read; an unreadable count is null', () => {
    expect(FUB_COUNT_ONLY_COLLECTIONS).toEqual(['tasks', 'appointments']);
    const c = fubNotImportedCounts({ tasks: { _metadata: { total: 1240 }, tasks: [{ id: 1, name: 'ignored' }] }, appointments: { error: 'forbidden' } });
    expect(c).toEqual({ tasks: 1240, appointments: null });
    expect(JSON.stringify(c)).not.toContain('ignored');
    expect(fubNotImportedCounts({})).toEqual({ tasks: null, appointments: null });
    expect(notImportedLines(fubNotImportedCounts({ tasks: { _metadata: { total: 1240 } }, appointments: { _metadata: { total: 85 } } }), 'Follow Up Boss')).toEqual([
      "Follow Up Boss has 1,240 tasks and 85 appointments. Realty OS doesn't bring tasks or appointments over: finish or note the open ones in Follow Up Boss before you switch.",
    ]);
  });
});
