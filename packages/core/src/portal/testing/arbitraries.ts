// fast-check arbitraries for core/portal: small id pools so that sources and grants collide often.
import fc from 'fast-check';
import { instant, type ContactId, type DealId, type ListingId, type LocalDate } from '../../foundation/index.js';
import { PORTAL_KINDS, type GrantBinding, type PortalSource, type SourceFacts } from '../types.js';
import { ZONE } from './fixtures.js';

const u = (n: number): string => `00000044-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const DEALS = [u(0xd1), u(0xd2)] as DealId[];
export const LISTINGS = [u(0x11), u(0x12), u(0x13)] as ListingId[];
export const CONTACTS = [u(0xc1), u(0xc2)] as ContactId[];

const deal = fc.constantFrom(...DEALS);
const listing = fc.constantFrom(...LISTINGS);
const contact = fc.constantFrom(...CONTACTS);
const orNull = <T>(a: fc.Arbitrary<T>): fc.Arbitrary<T | null> => fc.option(a, { nil: null });
const freshId = fc.integer({ min: 0x1000, max: 0xffff }).map(u);
const at = fc.integer({ min: 0, max: 4_102_444_800_000 }).map(instant);

/** Any text, lone surrogates and controls included. */
export const anyText = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 200 }),
  fc.string({ unit: fc.integer({ min: 0, max: 0xffff }).map((n) => String.fromCharCode(n)), maxLength: 200 }),
  fc.string({ unit: fc.constantFrom('a', ' ', '\t', '\n', '\u00A0', '\u3000', '\u200B', '\u202E', '\u0000', '😀', '<', '&'), maxLength: 300 }),
  fc.integer({ min: 3990, max: 4010 }).map((n) => 'x'.repeat(n)),
);

export const grantArb: fc.Arbitrary<GrantBinding> = fc.oneof(
  fc.record({ dealId: deal, listingId: fc.constant(null), dealListingId: orNull(listing) }),
  fc.record({ dealId: fc.constant(null), listingId: listing, dealListingId: fc.constant(null) }),
).chain((scope) => fc.record({
  dealId: fc.constant(scope.dealId), listingId: fc.constant(scope.listingId), dealListingId: fc.constant(scope.dealListingId),
  clientContactId: contact, clientIsSellerSide: fc.boolean(), revoked: fc.boolean(), lapsed: fc.boolean(), accountDisabled: fc.boolean(),
})) as fc.Arbitrary<GrantBinding>;

export const sourceArb = (text: fc.Arbitrary<string> = fc.string({ maxLength: 40 })): fc.Arbitrary<PortalSource> => fc.oneof(
  fc.record({ type: fc.constant('deal_date'), id: freshId, dealId: deal, kind: fc.constantFrom('acceptance', 'inspection', 'closing', 'custom'), label: orNull(text),
    dueOn: fc.constantFrom('2026-12-01', '2027-02-28') as fc.Arbitrary<LocalDate>, status: fc.constantFrom('proposed', 'confirmed', 'waived'), dueVersion: fc.integer({ min: 1, max: 9 }) }),
  fc.oneof(
    fc.record({ dealId: deal, listingId: fc.constant(null), contactId: fc.constant(null) }),
    fc.record({ dealId: fc.constant(null), listingId: listing, contactId: fc.constant(null) }),
    fc.record({ dealId: fc.constant(null), listingId: fc.constant(null), contactId: contact }),
  ).chain((scope) => fc.record({ type: fc.constant('document'), id: freshId, ...Object.fromEntries(Object.entries(scope).map(([k, v]) => [k, fc.constant(v)])),
    objectId: freshId, kind: fc.constantFrom('inspection', 'other', 'disclosure'), displayName: text, versionNo: fc.integer({ min: 1, max: 9 }),
    sharedToPortal: fc.boolean(), scanStatus: fc.constantFrom('pending', 'clean', 'infected') })),
  fc.record({ type: fc.constant('showing'), listingId: listing, buyerContactId: orNull(contact),
    showing: fc.record({ id: freshId, startsAt: at, status: fc.constantFrom('scheduled', 'completed', 'canceled', 'no_show'), source: fc.constant('manual'), buyerAgentName: orNull(text), buyerAgentBrokerage: orNull(text) }) }),
  fc.record({ type: fc.constant('showing_feedback'), listingId: listing, buyerContactId: orNull(contact),
    feedback: fc.record({ id: freshId, showingId: freshId, rating: orNull(fc.integer({ min: 1, max: 5 })), comments: orNull(text), source: fc.constant('manual'), receivedAt: at }) }),
  fc.record({ type: fc.constant('assistant_action'), id: freshId, kind: fc.constantFrom('seller_update_draft', 'message_draft'), status: fc.constantFrom('approved', 'executed', 'pending', 'rejected'),
    triggerListingId: orNull(listing), text }),
  fc.record({ type: fc.constant('task'), id: freshId, dealId: orNull(deal), listingId: orNull(listing), title: text, dueAt: orNull(at), status: fc.constantFrom('open', 'done'), notes: orNull(text) }),
) as fc.Arbitrary<PortalSource>;

export const factsArb = (text?: fc.Arbitrary<string>): fc.Arbitrary<SourceFacts> =>
  fc.record({ source: sourceArb(text), grant: grantArb, publisher: fc.constantFrom('user', 'system'), zone: fc.constant(ZONE) }) as fc.Arbitrary<SourceFacts>;

export const kindArb = fc.constantFrom(...PORTAL_KINDS);
