// Display rules per audience (R-MLS-2, R-MLS-4; E86). VERIFY WITH COUNSEL / MLS: every branch below.
//
// - agent: back-office view. Always shown, every field, labelled "MLS" with the listing brokerage
//   and `isTeamListing: false` (R-MLS-4). The pack's attribution/disclaimer ride along when present.
//   VERIFY WITH COUNSEL / MLS: that back-office display to licensed agents is covered by the licence,
//   including the street address of a listing whose broker withheld it from internet display.
// - client / public (R-MLS-2): null (not shown) unless ALL hold:
//     1. the connection's licence pack is counsel-reviewed;
//     2. the listing broker allows internet display (`display_allowed`; E86);
//     3. the pack has both an attribution and a disclaimer (every rendering carries them);
//     4. the listing brokerage is known, unless the pack waives that;
//     5. the pack allows the listing's status for that audience.
//   Then only the fields the pack allows for the audience are kept; the street address also needs
//   InternetAddressDisplayYN. Nothing is allowed by default (licence.ts parses `{}` to "nothing"). The sold
//   fields (closePrice, closeDate, yearBuilt, lotSize, subdivision; D9) follow the same rule: a stored pack that
//   does not list them shows none of them.
// - Photos are URL references unless the pack allows re-hosting (R-MLS-4).
// - The team's own listings are not MLS data: the pack does not govern them, and they are shown in
//   full with the "Team" label. VERIFY WITH COUNSEL: a seller's own opt-out of internet display for
//   a team listing is enforced where team listings are published (marketing), not here.
// - `marketingEligible`: only team listings get marketing pieces (R-MLS-4; the DB trigger on
//   marketing pieces enforces the same).
import type { Audience, AudienceRules, DisplayField, DisplayListing, LicensePack, ListingFacts, PhotoRef } from './types.js';
import { DISPLAY_FIELDS } from './types.js';
import { packReviewed } from './licence.js';

/** R-MLS-4: an MLS listing never gets marketing pieces; it is never the team's own. */
export function marketingEligible(l: ListingFacts): boolean {
  return l.source === 'team';
}

function photos(l: ListingFacts, mode: PhotoRef['mode']): PhotoRef[] {
  return l.photoUrls.map((url) => ({ url, mode }));
}

/** Every field, for the agent view and for team listings. */
function full(l: ListingFacts, audience: Audience, photoMode: PhotoRef['mode']) {
  return {
    audience,
    id: l.id,
    source: l.source,
    mlsNumber: l.mlsNumber,
    status: l.status,
    listPriceCents: l.listPriceCents,
    beds: l.beds,
    bathsX10: l.bathsX10,
    sqft: l.sqft,
    propertyType: l.propertyType,
    description: l.description,
    listDate: l.listDate,
    address: { line1: l.addressLine1, line2: l.addressLine2 },
    locality: { city: l.city, region: l.region, postalCode: l.postalCode },
    photos: photos(l, photoMode),
    closePriceCents: l.valuation.closePriceCents,
    closeDate: l.valuation.closeDate,
    yearBuilt: l.valuation.yearBuilt,
    lotSqft: l.valuation.lotSqft,
    subdivisionName: l.valuation.subdivisionName,
    addressHidden: false,
    omittedFields: [] as DisplayField[],
  };
}

/** Whether a client/public rendering is refused outright (R-MLS-2). */
function refused(l: ListingFacts, pack: LicensePack, rules: AudienceRules): boolean {
  if (!packReviewed(pack)) return true;
  if (!l.displayAllowed) return true; // E86
  if (pack.attributionText === null || pack.disclaimerText === null) return true;
  if (pack.requireListingBrokerage && l.listingBrokerageName === null) return true;
  return !rules.statuses.includes(l.status);
}

/**
 * The listing as `audience` may see it, or null when it must not be shown to that audience.
 * Every client-facing or public rendering of an MLS listing goes through here (R-MLS-2).
 */
export function applyDisplayRules(l: ListingFacts, pack: LicensePack, audience: Audience): DisplayListing | null {
  if (l.source === 'team') {
    return { ...full(l, audience, 'rehost_allowed'), sourceLabel: 'Team', isTeamListing: true, listingBrokerageName: l.listingBrokerageName, attribution: null, disclaimer: null };
  }
  const photoMode: PhotoRef['mode'] = pack.allowRehostPhotos ? 'rehost_allowed' : 'reference';
  const mlsLabel = { sourceLabel: 'MLS', isTeamListing: false, listingBrokerageName: l.listingBrokerageName } as const;

  if (audience === 'agent') {
    return { ...full(l, audience, photoMode), ...mlsLabel, attribution: pack.attributionText, disclaimer: pack.disclaimerText };
  }

  const rules = pack.audiences[audience];
  if (refused(l, pack, rules)) return null;

  const allowed = new Set(rules.fields);
  const addressShown = allowed.has('address') && l.addressDisplayAllowed;
  const shown = (f: DisplayField): boolean => (f === 'address' ? addressShown : allowed.has(f));
  const all = full(l, audience, photoMode);
  return {
    audience,
    id: l.id,
    source: l.source,
    ...mlsLabel,
    attribution: pack.attributionText,
    disclaimer: pack.disclaimerText,
    addressHidden: !addressShown,
    omittedFields: DISPLAY_FIELDS.filter((f) => !shown(f)),
    ...(shown('mlsNumber') && { mlsNumber: all.mlsNumber }),
    ...(shown('status') && { status: all.status }),
    ...(shown('listPrice') && { listPriceCents: all.listPriceCents }),
    ...(shown('beds') && { beds: all.beds }),
    ...(shown('baths') && { bathsX10: all.bathsX10 }),
    ...(shown('sqft') && { sqft: all.sqft }),
    ...(shown('propertyType') && { propertyType: all.propertyType }),
    ...(shown('description') && { description: all.description }),
    ...(shown('listDate') && { listDate: all.listDate }),
    ...(shown('address') && { address: all.address }),
    ...(shown('locality') && { locality: all.locality }),
    ...(shown('photos') && { photos: all.photos }),
    ...(shown('closePrice') && { closePriceCents: all.closePriceCents }),
    ...(shown('closeDate') && { closeDate: all.closeDate }),
    ...(shown('yearBuilt') && { yearBuilt: all.yearBuilt }),
    ...(shown('lotSize') && { lotSqft: all.lotSqft }),
    ...(shown('subdivision') && { subdivisionName: all.subdivisionName }),
  };
}
