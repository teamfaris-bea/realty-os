// @realty/core/texting — outbound texting helpers: SMS segment counting (R-MMS-9) and outbound MMS media
// checks and metadata stripping (R-MMS-3, R-MMS-4). Pure: no I/O, no clock, no dependency.
export {
  SMS_TEXT_MAX_UNITS,
  type SmsEncoding,
  type SmsSender,
  type SmsSegments,
  type SmsOptions,
  type GraphemeClass,
  smsSegments,
  splitParts,
  smsGraphemes,
  classifyGraphemes,
  gsm7Cost,
  isGsm7Char,
} from './segments.js';
export {
  OUTBOUND_MEDIA_TYPES,
  MMS_LIMITS,
  MP4_BRANDS,
  QUICKTIME_BRANDS,
  type OutboundMediaType,
  type OutboundMediaRefusal,
  type OutboundMediaCheck,
  type StripFailure,
  type StripResult,
  checkOutboundMedia,
  stripMediaMetadata,
} from './outboundMedia.js';
