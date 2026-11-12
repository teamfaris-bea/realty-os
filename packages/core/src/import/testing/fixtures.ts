// Test fixtures for core/import (used only by *.test.ts; excluded from coverage).
//
// FUB_EXPORT is the golden Follow Up Boss snapshot: one object per FUB collection shape the importer
// reads, covering every category and the edge cases BUILD_PLAN module 6 names (unsubscribed, DNC,
// tags, custom fields → imported_fields, HTML notes, emails, calls with a recording, unassigned and
// pond-assigned people, an unmapped agent, malformed rows).
//
// `simulateCommit` is a deliberately small in-memory stand-in for api/imports' commit: it applies a
// commit plan to an `ExistingIndexInput` the way the real commit must (create / attach / update,
// external_refs for every written entity, imported consent keys), so re-run idempotency (R-IMPORT-9)
// can be proven in core. It is not the commit implementation.
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256Hex } from '../../compliance/index.js';
import { type ContactId, type Instant, type PondId, type UserId, at, sequentialIds } from '../../foundation/index.js';
import { importedConsentKey } from '../consent.js';
import { personRefOf } from '../csv.js';
import type { CommitItem, ExistingIndexInput } from '../plan.js';
import type { ExistingContact, ImportTarget, UserMapping } from '../types.js';

export const T0 = at('2026-11-10T15:00:00Z');
export const BATCH = '00000000-0000-7000-8000-00000000b001';
export const AGENT_A = '00000000-0000-7000-8000-0000000000a1' as UserId;
export const AGENT_B = '00000000-0000-7000-8000-0000000000b2' as UserId;
export const POND = '00000000-0000-7000-8000-0000000000d1' as PondId;

/** Test address key: deterministic, injective, 64 hex chars like the real tenant HMAC. */
export function testKey(kind: 'phone' | 'email', normalized: string): string {
  return sha256Hex(`${kind}:${normalized}`);
}

export const USERS: UserMapping = {
  users: new Map<string, ImportTarget>([
    ['11', { userId: AGENT_A }],
    ['12', { userId: AGENT_B }],
    ['13', 'unassigned'],
  ]),
  ponds: new Map<string, ImportTarget>([['3', { pondId: POND }]]),
};

export const FUB_EXPORT = {
  people: [
    {
      id: 1001,
      created: '2023-03-01T14:00:00Z',
      updated: '2026-10-01T09:30:00Z',
      firstName: 'Jane',
      lastName: 'Doe',
      stage: 'Hot Prospect',
      source: 'Zillow',
      sourceUrl: 'https://example.com/listing/1',
      assignedUserId: 11,
      assignedTo: 'Alex Agent',
      tags: ['Buyer', 'buyer', 'Pre-approved'],
      emails: [{ value: 'Jane.Doe@Example.com', type: 'home', status: 'Valid', isPrimary: 1 }],
      phones: [
        { value: '(415) 555-0132', type: 'mobile', status: 'Valid', isPrimary: 1 },
        { value: '555-0100', type: 'home', status: 'Valid', isPrimary: 0 },
      ],
      addresses: [{ type: 'home', street: '1 Main St', city: 'Springfield', state: 'il', code: '62701', country: 'US' }],
      customBirthday: '1980-05-01',
      customPreApproved: true,
      customFavoriteNeighborhoods: ['Downtown', 'Riverside'],
      smsOptIn: true,
      emailOptIn: true,
    },
    {
      // Unsubscribed from email and opted out of texts (E40).
      id: 1002,
      created: '2022-01-05T10:00:00Z',
      updated: '2026-09-12T12:00:00Z',
      name: 'Bob Unsub',
      stage: 'Nurture',
      assignedUserId: 12,
      tags: [],
      emails: [{ value: 'bob@example.org', type: 'work', status: 'Unsubscribed', isPrimary: 1 }],
      phones: [{ value: '+1 312 555 0145', type: 'cell', status: 'Opted Out', isPrimary: 1 }],
      smsOptIn: true,
      emailOptIn: true,
    },
    {
      // Do-not-contact by tag, in a pond.
      id: 1003,
      created: '2021-07-07T07:07:07Z',
      firstName: 'Carla',
      lastName: 'Dnc',
      stage: 'Sphere',
      assignedPondId: 3,
      tags: ['DNC', 'Past Open House'],
      phones: [{ value: '646-555-0177', type: 'mobile', status: 'Valid' }],
      emails: [{ value: 'carla@example.net', type: 'home', status: 'Bounced' }],
    },
    {
      // Unassigned, unknown stage, no consent data.
      id: '1004',
      created: '2024-02-02T02:02:02Z',
      firstName: 'Dan',
      lastName: 'Nostage',
      stage: 'Waiting On Lender',
      emails: [{ value: 'dan@example.com', type: 'home', status: 'Valid' }],
    },
    {
      // Assigned to an agent nobody mapped (R-IMPORT-8 blocker).
      id: 1005,
      created: '2024-03-03T03:03:03Z',
      firstName: 'Erin',
      lastName: 'Unmapped',
      stage: 'Lead',
      assignedUserId: 99,
      phones: [{ value: '(206) 555-0199', type: 'mobile', status: 'Valid' }],
    },
    {
      // Nothing usable: no name, invalid phone.
      id: 1006,
      created: '2024-04-04T04:04:04Z',
      phones: [{ value: '555-0100', type: 'mobile', status: 'Valid' }],
    },
    // Malformed: no id.
    { firstName: 'Nobody' },
  ],
  notes: [
    { id: 501, personId: 1001, subject: 'Call recap', body: '<p>Wants <b>3 beds</b> &amp; a yard.</p><br>Budget 500k', isHtml: true, created: '2026-01-15T16:00:00Z', createdById: 11 },
    { id: 502, personId: 1002, body: 'Asked to stop texting.', created: '2026-02-01T10:00:00Z', createdById: 99 },
    { id: 503, personId: 4242, body: 'Orphan note', created: '2026-02-01T10:00:00Z' },
    { id: 504, personId: 1001, body: '   ', created: '2026-02-01T10:00:00Z' },
  ],
  textMessages: [
    { id: 701, personId: 1001, created: '2026-03-01T18:00:00Z', isIncoming: true, message: 'Is the Elm St house still available?', status: 'Received' },
    { id: 702, personId: 1001, created: '2026-03-01T18:05:00Z', isIncoming: false, message: 'Yes! Want to see it Saturday?', status: 'Delivered', userId: 11 },
    { id: 703, personId: 1002, created: '2026-03-02T09:00:00Z', isIncoming: false, message: 'Following up', status: 'Failed', userId: 12 },
  ],
  emails: [{ id: 801, personId: 1001, created: '2026-03-03T12:00:00Z', isIncoming: false, subject: 'Listings for you', body: 'Here are three homes.', status: 'Sent', userId: 11 }],
  calls: [
    { id: 901, personId: 1001, created: '2026-03-04T15:00:00Z', isIncoming: false, duration: 312, outcome: 'Interested', note: 'Talked about schools', userId: 11, recordingUrl: 'https://fub.example/rec/901?token=secret' },
    { id: 902, personId: 1002, created: '2026-03-05T15:00:00Z', isIncoming: false, duration: 0, outcome: 'No Answer', userId: 12 },
    { id: 903, personId: 1003, created: '2026-03-06T15:00:00Z', isIncoming: true, duration: 45, outcome: 'Left Message', userId: 12 },
    { id: 904, personId: 1001, created: 'not a date', duration: 10 },
  ],
} as const;

/** Builds CSV bytes (UTF-8, optional BOM). */
export function csvBytes(text: string, opts: { bom?: boolean } = {}): Uint8Array {
  const body = utf8ToBytes(text);
  if (!opts.bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

export function existingContact(over: Partial<ExistingContact> & { contactId: string }): ExistingContact {
  return {
    createdAt: T0,
    ownershipState: 'unassigned',
    closedReason: null,
    ownerUserId: null,
    mergedIntoContactId: null,
    ownershipSeq: 1,
    routeDueAt: null,
    importBatchId: null,
    displayName: 'Someone',
    firstName: null,
    lastName: null,
    intent: null,
    phones: [],
    emails: [],
    tags: [],
    importedFieldKeys: [],
    hasAddress: false,
    ...over,
    contactId: over.contactId as ContactId,
  };
}

export function emptyIndexInput(over: Partial<ExistingIndexInput> = {}): ExistingIndexInput {
  return { batchId: BATCH, keyOf: testKey, contacts: [], ...over };
}

/**
 * Applies commit items to an index input like a correct commit would (see the header). Returns the
 * new input; ids come from a dedicated generator so they never collide with fixture ids.
 */
export function simulateCommit(input: ExistingIndexInput, items: readonly CommitItem[], now: Instant = T0): ExistingIndexInput {
  const ids = sequentialIds({ prefix: 0x5151 });
  const contacts = new Map(input.contacts.map((c) => [c.contactId as string, { ...c }]));
  const refs = [...(input.externalRefs ?? [])];
  const consent = new Set(input.importedConsent ?? []);
  const pendingToId = new Map<string, string>();
  for (const r of refs) if (r.entityType === 'contact') pendingToId.set(r.externalId, r.entityId);
  const resolve = (ref: { contactId: ContactId } | { pendingPersonRef: string }): string | undefined =>
    'contactId' in ref ? ref.contactId : pendingToId.get(ref.pendingPersonRef);

  for (const it of items) {
    const a = it.action;
    const rec = it.normalized;
    if (a.kind === 'create_contact' && rec.category === 'contacts') {
      const id = ids.next<'ContactId'>();
      contacts.set(id, existingContact({
        contactId: id,
        createdAt: now,
        importBatchId: input.batchId,
        displayName: rec.displayName,
        firstName: rec.firstName,
        lastName: rec.lastName,
        intent: rec.intent,
        phones: rec.phones.map((p) => p.e164),
        emails: rec.emails.map((e) => e.email),
        tags: rec.tags,
        importedFieldKeys: Object.keys(rec.importedFields),
        hasAddress: rec.addresses.length > 0,
      }));
      refs.push({ entityType: 'contact', externalId: personRefOf(rec), entityId: id });
      pendingToId.set(personRefOf(rec), id);
    } else if ((a.kind === 'attach_contact' || a.kind === 'update_contact') && rec.category === 'contacts') {
      const c = contacts.get(a.contactId);
      if (!c) throw new Error('simulateCommit: attach target missing');
      contacts.set(a.contactId, {
        ...c,
        firstName: c.firstName ?? a.fill.firstName ?? null,
        lastName: c.lastName ?? a.fill.lastName ?? null,
        intent: c.intent ?? a.fill.intent ?? null,
        phones: [...c.phones, ...a.fill.addPhones.map((p) => p.e164)],
        emails: [...c.emails, ...a.fill.addEmails.map((e) => e.email)],
        tags: [...c.tags, ...a.fill.addTags],
        importedFieldKeys: [...c.importedFieldKeys, ...Object.keys(a.fill.addImportedFields)],
        hasAddress: c.hasAddress || a.fill.addAddresses.length > 0,
      });
      if (!refs.some((r) => r.entityType === 'contact' && r.externalId === personRefOf(rec))) {
        refs.push({ entityType: 'contact', externalId: personRefOf(rec), entityId: a.contactId });
      }
      pendingToId.set(personRefOf(rec), a.contactId);
    } else if (a.kind === 'assign') {
      const id = resolve(a.contact);
      const c = id ? contacts.get(id) : undefined;
      if (!c) throw new Error('simulateCommit: assign target missing');
      const t = a.target;
      contacts.set(c.contactId, {
        ...c,
        ownershipState: t === 'unassigned' ? 'unassigned' : 'userId' in t ? 'owned' : 'in_pond',
        ownerUserId: t !== 'unassigned' && 'userId' in t ? t.userId : null,
        ownershipSeq: c.ownershipSeq + 1,
      });
    } else if (a.kind === 'insert_history' && 'externalId' in rec && rec.category !== 'contacts') {
      const entityType = rec.category === 'notes' ? 'note' : rec.category === 'messages' ? 'message' : 'call';
      refs.push({ entityType, externalId: rec.externalId, entityId: ids.next<'NoteId'>() });
    } else if (a.kind === 'record_consent') {
      for (const ad of a.fields.addresses) {
        const k = testKey(ad.kind, ad.address);
        for (const c of ad.grants) consent.add(importedConsentKey(k, c, 'grant'));
        for (const c of ad.revokes) consent.add(importedConsentKey(k, c, 'revoke'));
        if (ad.doNotContact) consent.add(importedConsentKey(k, ad.kind === 'email' ? 'email' : 'sms', 'dnc'));
      }
    }
  }
  return { ...input, contacts: [...contacts.values()], externalRefs: refs, importedConsent: [...consent], contactsStage: new Map() };
}
