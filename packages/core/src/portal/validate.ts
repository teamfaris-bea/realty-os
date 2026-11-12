// Shape checks for SourceFacts. Module 45 builds SourceFacts from rows, so a malformed value is a bug
// or a forged request: publishable() refuses it (PORTAL_SOURCE_INVALID) and renderPortalItem() throws.
// Ids must be canonical lower-case UUIDs, as Postgres prints them: an id that differs by case or
// whitespace is refused rather than compared loosely (stricter than the DB's uuid equality).
import { ianaZone } from '../foundation/index.js';
import { DOCUMENT_KINDS, type SourceFacts } from './types.js';
import { MILESTONE_KINDS } from '../transactions/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INT4_MAX = 2_147_483_647;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const id = (v: unknown): boolean => typeof v === 'string' && UUID.test(v);
const idOrNull = (v: unknown): boolean => v === null || id(v);
const bool = (v: unknown): boolean => typeof v === 'boolean';
const instantOk = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v);
const version = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= INT4_MAX;
const str = (v: unknown): boolean => typeof v === 'string';
const oneOf = (v: unknown, xs: readonly string[]): boolean => typeof v === 'string' && xs.includes(v);

function sourceOk(s: unknown): boolean {
  if (!isObj(s)) return false;
  switch (s.type) {
    case 'deal_date':
      return id(s.id) && id(s.dealId) && oneOf(s.kind, MILESTONE_KINDS) && (s.label === null || str(s.label))
        && typeof s.dueOn === 'string' && LOCAL_DATE.test(s.dueOn) && oneOf(s.status, ['proposed', 'confirmed', 'waived']) && version(s.dueVersion);
    case 'document':
      return id(s.id) && idOrNull(s.dealId) && idOrNull(s.listingId) && idOrNull(s.contactId)
        && [s.dealId, s.listingId, s.contactId].filter((x) => x !== null).length === 1
        && id(s.objectId) && oneOf(s.kind, DOCUMENT_KINDS) && str(s.displayName) && version(s.versionNo)
        && bool(s.sharedToPortal) && oneOf(s.scanStatus, ['pending', 'clean', 'infected']);
    case 'showing': {
      const sh = s.showing;
      return isObj(sh) && id(sh.id) && instantOk(sh.startsAt) && oneOf(sh.status, ['scheduled', 'completed', 'canceled', 'no_show'])
        && id(s.listingId) && idOrNull(s.buyerContactId);
    }
    case 'showing_feedback': {
      const f = s.feedback;
      return isObj(f) && id(f.id) && id(f.showingId) && instantOk(f.receivedAt)
        && (f.rating === null || (typeof f.rating === 'number' && Number.isInteger(f.rating) && f.rating >= 1 && f.rating <= 5))
        && (f.comments === null || str(f.comments)) && id(s.listingId) && idOrNull(s.buyerContactId);
    }
    case 'assistant_action':
      return id(s.id) && str(s.kind) && str(s.status) && (s.triggerListingId === null || str(s.triggerListingId)) && str(s.text);
    case 'task':
      return id(s.id) && idOrNull(s.dealId) && idOrNull(s.listingId) && str(s.title)
        && (s.dueAt === null || instantOk(s.dueAt)) && oneOf(s.status, ['open', 'done', 'canceled']);
    default:
      return false;
  }
}

function grantOk(g: unknown): boolean {
  if (!isObj(g)) return false;
  const deal = g.dealId !== null;
  return idOrNull(g.dealId) && idOrNull(g.listingId) && deal !== (g.listingId !== null)
    && idOrNull(g.dealListingId) && (deal || g.dealListingId === null)
    && id(g.clientContactId) && bool(g.clientIsSellerSide) && bool(g.revoked) && bool(g.lapsed) && bool(g.accountDisabled);
}

export function isSourceFacts(f: unknown): f is SourceFacts {
  return isObj(f) && sourceOk(f.source) && grantOk(f.grant) && oneOf(f.publisher, ['user', 'system'])
    && typeof f.zone === 'string' && ianaZone(f.zone) !== null;
}
