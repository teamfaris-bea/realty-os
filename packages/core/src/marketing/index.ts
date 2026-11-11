// @realty/core/marketing — public interface of PHASE2_3_PLAN module 27: piece prose schemas, live
// rendering of bound facts from the team listing (R-MKT-3, E90), the guard result the approval CHECK
// reads (R-MKT-1, R-FH-1; `guardResult` is its only producer), jurisdiction advertising packs as data
// (E92; VERIFY WITH COUNSEL), exports that never claim posting (R-MKT-6, R-MKT-9) and seller-update
// assembly where every section says where its data stands (R-SELL-2, R-SELL-3; E85, E87, E89, E94).
// Pure: no I/O, no clock, no randomness. Modules 28 and 29 import only from here.
import type { MarketingRefusalCode } from './types.js';
export * from './types.js';
export { PieceSchemas, PieceKindSchema, AdvertisingPackSchema, advertisingPackFrom, STRICTEST_ADVERTISING_PACK, GuardResultSchema, parseGuardResult } from './schemas.js';
export { resolveAdvertisingRules } from './packs.js';
export { renderPiece, formatOpenHouse, TEMPLATES, DEFAULT_TEMPLATE, OFF_MARKET_STATUSES, type Template, type TemplateSlot } from './render.js';
export { numeralIssues, foldNumerals, type NumeralHit } from './numerals.js';
export { guardResult, guardResultMatches, guardPasses, guardReasons, needsFairHousingCheck, liveRecheck, MARKETING_DRAFT_ACTION, SHA256_HEX_RE } from './guard.js';
export * from './export.js';
export * from './sellerUpdate.js';

/** Codes core/marketing returns as `{ ok: false, code }` (CONVENTIONS §7). */
export type MarketingErrorCode = MarketingRefusalCode | 'MARKETING_METRIC_NOT_SHOWN';
