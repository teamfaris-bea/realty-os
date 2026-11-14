// module 46 (R-PORTALWEB-8, E715): the portal's only hrefs built from data. `sms:` only from a validated E.164
// number and `mailto:` only from a single address with no separator, parameter, quote, angle bracket, whitespace or
// control character; anything else is null and the card falls back to words. Pure.
import { E164, SINGLE_EMAIL } from './parse.js';

export function smsHref(textTo: string | null | undefined): string | null {
  return typeof textTo === 'string' && E164.test(textTo) ? `sms:${textTo}` : null;
}

export function mailtoHref(emailTo: string | null | undefined): string | null {
  if (typeof emailTo !== 'string' || emailTo.length > 320 || !SINGLE_EMAIL.test(emailTo)) return null;
  // the address is one URL path segment: encode everything but the characters an address may carry
  return `mailto:${encodeURIComponent(emailTo).replace(/%40/g, '@')}`;
}
