// Every word the CMA surface shows (module 72, web/cma; D9 V2-A, R-CMA-9, R-AVM-1). An estimate, never an appraisal;
// the source is "MLS sales"; no confidence, score, probability or accuracy word anywhere (words.test.ts reads this file
// and every component of the surface). Server sentences (blockers, the share's message, the as-of and area lines) are
// shown as the server words them. VERIFY WITH COUNSEL: the disclosure labels and the estimate line.
import type { CmaInspection, CmaPropertyType, CmaPurpose, DisclosureField, FactSource, PreviewWhere, ReportRole } from './lib.js';

export const W = {
  pageTitle: 'CMA',
  titleFor: (street: string) => `CMA: ${street}`,
  loading: 'Loading the CMA',
  tryAgain: 'Try again',
  cantLoad: "Can't load this CMA",

  // range
  rangeHeading: 'Estimated range',
  rangeLine: (low: string, high: string) => `${low} to ${high}`,
  valueLine: (v: string) => `Middle of the range: ${v}`,
  estimate: 'This is an estimate, not an appraisal.',
  source: 'Source: MLS sales',
  noValueHeading: 'No value',
  valuedOn: (d: string) => `Valued on ${d}`,

  // comps
  compsHeading: 'Comparable sales',
  compsCount: (n: number, of: number) => `${n} of ${of} sales considered are used`,
  noComps: 'No sales are used in this CMA.',
  sold: (price: string, date: string) => `Sold ${price} on ${date}`,
  soldNoDate: (price: string) => `Sold ${price}`,
  teamSale: 'Team sale',
  mlsSale: 'MLS sale',
  why: 'Why it was chosen',
  showAdjustments: 'Show adjustments',
  hideAdjustments: 'Hide adjustments',
  adjustmentsHeading: 'Adjustments',
  noAdjustments: 'No adjustments: this sale is compared as it sold.',
  adjustedPrice: (p: string) => `Adjusted price: ${p}`,
  weight: (w: string) => `Counts for ${w} of the estimate`,
  remove: 'Remove',
  removeLabel: (address: string) => `Remove ${address} from the comparable sales`,
  includedByYou: 'Added by you',
  brokerage: (name: string) => `Listed by ${name}`,

  // not used
  notUsedHeading: 'Not used',
  notUsedCount: (shown: number, total: number) => `${shown} of ${total} sales not used are listed`,
  notUsedNone: 'Every sale considered is used.',
  use: 'Use',
  addLabel: (address: string) => `Use ${address} as a comparable sale`,

  // context
  contextHeading: 'For context; not used in the value',
  listPrice: (p: string) => `Listed at ${p}`,

  // where the data stands
  dataHeading: 'Where the data stands',
  backtestHeading: 'How this method did on recent sales (for you; not in the report)',

  // subject
  subjectHeading: 'The home',
  editFacts: "Edit the home's facts",
  saveFacts: 'Save and re-run',
  cancel: 'Cancel',
  factSource: { mls: "from the home's MLS record", team: "from the team's listing", agent: 'entered by you', none: 'not known' } satisfies Record<'mls' | 'team' | 'agent' | 'none', string>,
  notKnown: 'not known',
  yes: 'Yes',
  no: 'No',
  mapKnown: 'Map location known',
  mapUnknown: 'Map location not known: distances are not measured',
  saleHistoryHeading: "This home's own MLS records",
  saleHistoryLine: (status: string, price: string, date: string) => `${status}: ${price}, ${date}`,
  sizeHint: 'Square feet of living area, from 100 to 100,000.',
  typeLabel: 'Property type',
  sqftLabel: 'Square feet',
  numberInvalid: 'Enter a whole number in range, or leave it empty.',

  // near matches
  nearHeading: 'Is this a live listing of this home?',
  nearIntro: 'A listing at a near-identical address is live. Confirm it is a different home before this CMA can be shown to a client.',
  nearDifferent: "It's a different home",
  nearDifferentLabel: (address: string) => `${address}: it's a different home`,
  nearDismissed: 'You confirmed this is a different home.',

  // purpose
  purposeHeading: 'Purpose',
  purposeGroup: 'What this CMA is for',
  inspectionLabel: 'Inspection',
  inspectedOnLabel: 'Inspected on',
  notesLabel: 'Your notes for the report',
  notesHint: 'Shown to the client in the report. Facts about the home only.',
  sopIntro: 'For any other purpose, the report has to say these five things.',
  savePurpose: 'Save',
  neededBeforeSharing: 'Needed before sharing.',
  saved: 'Saved.',

  // read-only and status
  preparedBySomeoneElse: 'Prepared by someone else. You can read it but not change it.',
  sharedOn: (d: string) => `Shared on ${d}.`,
  superseded: 'Superseded: a newer CMA of this home replaced it. It is kept as it was.',
  cantChange: 'This CMA can’t be changed now. Prepare a new one from the seller’s page to work on it.',
  feedStaleHeading: 'The MLS feed is out of date',
  pdfLink: 'Download the PDF (to print or hand over)',
  noShareHere: 'To share, prepare it from the seller’s page.',
  shareHeading: 'Share with the client',
  shareStatusHeading: 'The email',

  // share panel
  previewLoading: 'Checking the report and who can receive it',
  to: 'To',
  chooseRecipient: 'Who receives it',
  chooseEmail: 'Email address',
  emailTo: (first: string) => `Email to ${first}`,
  emailOff: 'Email',
  reasonsBelow: (n: number) => `${n === 1 ? 'The reason is' : `The ${n} reasons are`} listed under “Share with the client”.`,
  sending: 'Sending',
  sent: 'Sent',
  sendCheck: 'The send-time check',
  sendCheckAllows: 'The send-time check allows this email now.',
  reportHeading: 'The report as it will be emailed',
  subjectLine: (s: string) => `Subject: ${s}`,
  wontPrint: (where: string) => `Won't print as written: ${where}. Edit that text so every character prints.`,
  checkWording: (where: string) => `Check this wording: ${where}.`,
  fhHard: 'Edit the notes: this can’t be sent.',
  fhHardLine: (label: string, where: string) => `${label} (in ${where})`,
  fhSoft: (label: string, where: string) => `Check this: ${label} (in ${where}).`,
  missingHeading: 'Fill in before sharing',
  tooLong: (where: string, chars: number) => `${where}: ${chars.toLocaleString('en-US')} characters`,
  staleRetap: 'The report changed since you looked; check it again.',
  dataOld: 'Prepare it again to use the latest sales.',
  homeValueHeading: 'Home value (CMA)',

  // home value section (contact page)
  prepare: 'Prepare CMA',
  preparing: 'Preparing',
  noCmas: 'No CMA for this contact yet.',
  listLabel: 'CMAs of this contact',
  open: (address: string) => `Open the CMA of ${address}`,
  someHome: 'The home',
  fromMerged: 'From a merged record',
  byOther: 'Prepared by someone else',
  noValueShort: 'No value',
  addAddress: 'Add the home’s address (a property or home address) to prepare a CMA.',
  goToDetails: 'Go to Details',
  factsIntro: 'Enter what the MLS history does not say, then prepare it again.',
  prepareWithFacts: 'Prepare CMA with these facts',
  chooseType: 'Choose the property type.',
} as const;

export const STATUS_WORDS: Record<string, string> = { draft: 'Draft', shared: 'Shared', superseded: 'Superseded' };

export const PURPOSE_WORDS: Record<CmaPurpose, string> = { listing_price: 'Listing price', buyer_offer: "Buyer's offer", other: 'Other' };

export const INSPECTION_WORDS: Record<CmaInspection, string> = { none: 'Not inspected', exterior: 'Exterior only', interior_and_exterior: 'Interior and exterior' };

export const PROPERTY_TYPE_WORDS: Record<CmaPropertyType, string> = {
  single_family: 'Single-family home',
  condo: 'Condo',
  townhouse: 'Townhouse',
  multi_family: 'Multi-family',
  land: 'Land',
  manufactured: 'Manufactured home',
  other: 'Other',
};

export const DISCLOSURE_WORDS: Record<DisclosureField, { label: string; hint: string }> = {
  intendedUsers: { label: 'Who the report is for', hint: 'The people who may rely on it.' },
  agentInterest: { label: 'Your interest in the home', hint: 'Any interest you or your brokerage has in it, or "none".' },
  conflicts: { label: 'Conflicts', hint: 'Any conflict of interest, or "none".' },
  valueDefinition: { label: 'What "value" means here', hint: 'For example, the price it could sell for in today’s market.' },
  limitingConditions: { label: 'Limiting conditions', hint: 'What the estimate does not cover.' },
};

export const WHERE_WORDS: Record<PreviewWhere, string> = {
  notes: 'your notes',
  intendedUsers: DISCLOSURE_WORDS.intendedUsers.label,
  agentInterest: DISCLOSURE_WORDS.agentInterest.label,
  conflicts: DISCLOSURE_WORDS.conflicts.label,
  valueDefinition: DISCLOSURE_WORDS.valueDefinition.label,
  limitingConditions: DISCLOSURE_WORDS.limitingConditions.label,
  inspectedOn: 'the inspection date',
};

export const ROLE_WORDS: Record<ReportRole, string> = {
  title: 'the title',
  range: 'the range',
  estimate: 'the estimate line',
  provider: 'who prepared it',
  statement: 'the MLS statement',
  comp: 'a comparable sale',
  as_of: 'the data date',
  inspection: 'the inspection line',
  sop: 'the disclosure items',
  notes: 'your notes',
  attribution: 'the MLS attribution',
  disclaimer: 'the MLS disclaimer',
};

export const FACT_WORDS: Record<string, string> = {
  propertyType: 'Property type',
  sqft: 'Size',
  beds: 'Bedrooms',
  bathsX10: 'Bathrooms',
  yearBuilt: 'Year built',
  lotSqft: 'Lot size',
  garageSpacesX10: 'Garage spaces',
  storiesX10: 'Stories',
  poolPrivate: 'Private pool',
  subdivision: 'Subdivision',
};

/** An adjustment's feature in words; an unknown one is shown as the server names it, spaced. */
export const FEATURE_WORDS: Record<string, string> = {
  time: 'Market change since the sale',
  size: 'Size',
  beds: 'Bedrooms',
  baths: 'Bathrooms',
  garage: 'Garage',
  pool: 'Pool',
  year_built: 'Year built',
  lot: 'Lot size',
  stories: 'Stories',
  concessions: 'Seller concessions',
};
export const featureWords = (f: string) => FEATURE_WORDS[f] ?? f.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');

export const LISTING_STATUS_WORDS: Record<string, string> = { coming_soon: 'Coming soon', active: 'Active', pending: 'Pending', sold: 'Sold', withdrawn: 'Withdrawn', expired: 'Expired' };

export const sourceWords = (s: FactSource) => (s === null ? W.factSource.none : W.factSource[s]);

/**
 * Error code → sentence for every code the CMA routes send (apps/api/src/errors.ts, the api/cma sections; words.test.ts
 * checks each has one). Registered on the surface (index.ts), so the page table carries them to every page.
 * `details.sentence`, when the server sends one, is shown instead (lib.ts cmaMessage).
 */
export const CMA_ERROR_MESSAGES: Record<string, string> = {
  CMA_VALUATION_NOT_ALLOWED: 'Your MLS licence pack does not say MLS sold data may be used for valuations. An admin records it on the MLS page, under Valuation use.',
  CMA_NO_MLS_CONNECTION: 'No MLS feed is connected, so there are no sold homes to compare.',
  CMA_SUBJECT_INCOMPLETE: 'Some of the home’s facts are missing. Add them to prepare a CMA.',
  CMA_SUBJECT_TYPE_NOT_SUPPORTED: 'Land and other property types are not valued yet: CMAs cover homes only for now.',
  CMA_NOT_DRAFT: 'This CMA was shared or replaced, so it no longer changes. Prepare a new one from the seller’s page.',
  CMA_SUBJECT_ADDRESS_GONE: 'The home’s address was deleted from this contact, so this CMA can’t be re-run. Prepare a new CMA for the home.',
  CMA_NOT_SHAREABLE: 'This CMA can’t be shown to a client right now. Nothing was sent. Check the reasons listed with it.',
  CMA_DISCLOSURE_INCOMPLETE: 'Fill in the disclosure items before sharing. Nothing was sent.',
  CMA_STATEMENT_NOT_RENDERABLE: 'The MLS statement can’t be printed as written, so this CMA can’t be shared. Nothing was sent.',
  CMA_FAIR_HOUSING: 'Edit the notes: they contain wording that can’t be sent. Nothing was sent.',
  CMA_STALE: 'The report changed since you looked; check it again. Nothing was sent.',
  CMA_REPORT_TOO_LONG: 'The report is too long for one email. Shorten the notes or disclosure items. Nothing was sent.',
  CMA_RECIPIENT_BLOCKED: 'The send-time check would block this email now, so nothing was sent.',
  CMA_NO_RECIPIENT: 'To share, prepare it from the seller’s page. Nothing was sent.',
};
