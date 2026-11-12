// @realty/core/homeowner — public interface of module 77 (owner decision D10; R-HOME-1..R-HOME-10): recognition,
// subjects, county routing and links, the strict parser, the entity-owner filter, years owned and the panel view.
// Pure: callers pass `today`. Nothing here sends, scores or estimates anything.
export * from './types.js';
export { MAX_OWNERS, cleanDate, cleanText, parseHomeownerRecord } from './parse.js';
export { ENTITY_OWNER_WORDS, isEntityOwner, personOwnerNames } from './owners.js';
export {
  BEAUFORT_ZIPS,
  COUNTIES,
  JASPER_ZIPS,
  SHARED_BEAUFORT_JASPER_ZIPS,
  canonicalRegion,
  connectorCountyOf,
  connectorZips,
  countyOf,
  isSouthCarolina,
  zip5,
  type CountyInfo,
  type CountyKey,
  type CountyLink,
  type CountyRoute,
} from './counties.js';
export { MAX_SUBJECTS, completeAddress, reasonsFrom, subjectsFor, type CandidateAddress, type RecognitionFacts } from './recognize.js';
export { TEAM_CLOSING_SOURCE, yearsOwned, type YearsOwned } from './years.js';
export {
  D9_ROWS,
  homeownerView,
  mailingDiffers,
  type CheckState,
  type HomeOutcome,
  type HomeView,
  type HomeownerView,
  type RowKey,
  type RowWhy,
  type ViewHome,
  type ViewInput,
  type ViewProfile,
  type ViewRow,
} from './view.js';
