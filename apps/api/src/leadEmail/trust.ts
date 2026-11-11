// The lead-email trust rule (ARCHITECTURE §21 "Webhooks"; DATA_MODEL R-INBOX-9, R-LEM-3). Pure.
//
// A lead email creates a lead automatically ONLY when the RECEIVING provider (never the message itself) reports a
// DKIM signature that passed, whose signing domain (d=) and the message's From domain both sit under ONE of the
// inbox's allowlisted sender domains. That is DMARC-style relaxed alignment, made conservative: without a public
// suffix list we never compute an "organizational domain"; the allowlisted entry IS the organizational domain, and
// an entry that is a bare public suffix is refused when it is saved (isAllowableSenderDomain).
//
// Everything else is held for review with the reason:
//   FROM_INVALID        no single, syntactically valid From address
//   DKIM_MISSING        the provider reported no DKIM result at all
//   DKIM_FAILED         no DKIM result is a pass
//   DKIM_UNALIGNED      a signature passed, but for a domain unrelated to the From domain (a spoofed From, or a
//                       relay that signs with its own domain)
//   SENDER_NOT_ALLOWED  an aligned pass, but the domain is not on the inbox's allowlist
// A DKIM-Signature header, an Authentication-Results header the sender wrote, or any other content of the message
// is never evidence: verdicts come from the provider adapter only (formats.ts).

export type HoldCode = 'FROM_INVALID' | 'DKIM_MISSING' | 'DKIM_FAILED' | 'DKIM_UNALIGNED' | 'SENDER_NOT_ALLOWED';

/** One DKIM result as the receiving provider reported it. */
export interface DkimVerdict {
  /** the signing domain (d=), lowercased */
  domain: string;
  result: string;
}

export type TrustDecision = { trusted: true; domain: string; fromDomain: string } | { trusted: false; code: HoldCode; fromDomain: string | null };

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN_RE = new RegExp(`^(?=.{4,253}$)(?:${LABEL}\\.)+[a-z][a-z0-9-]{1,62}$`);

/**
 * Public suffixes that must never be an allowlist entry (an entry is the organizational domain). Not a full public
 * suffix list: the common generic and US-relevant ones plus a few multi-label ones. VERIFY before adding countries.
 */
export const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'io', 'co', 'us', 'biz', 'info', 'app', 'dev', 'email', 'online', 'site',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'com.br', 'com.mx', 'co.jp', 'co.in',
  'ca', 'uk', 'au', 'de', 'fr', 'eu', 'me', 'tv', 'ai', 'xyz',
]);

/**
 * Seed suggestions shown when an Owner/Admin sets up an inbox. VERIFY with each portal which domain DKIM-signs its
 * lead notifications (a portal may sign with an email vendor's domain, which would then be unaligned and held).
 * The label is the portal's name only, because an Owner reads it: the page marks each chip "suggested" and says
 * the suggested domains are unconfirmed until a test lead from each portal arrives. VERIFY is for engineers and
 * counsel and never appears in what the API sends (leadEmail.test.ts).
 */
export const SUGGESTED_SENDER_DOMAINS: readonly { domain: string; label: string }[] = [
  { domain: 'zillow.com', label: 'Zillow' },
  { domain: 'realtor.com', label: 'Realtor.com' },
];

export function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/\.$/, '');
}

/** An allowlist entry: a syntactically valid domain that is not a bare public suffix and carries no wildcard. */
export function isAllowableSenderDomain(raw: string): boolean {
  const d = normalizeDomain(raw);
  return DOMAIN_RE.test(d) && !PUBLIC_SUFFIXES.has(d);
}

/** `d` equals `base` or is a subdomain of it (label-wise: `evilzillow.com` is NOT under `zillow.com`). */
export function isUnder(d: string, base: string): boolean {
  return d === base || d.endsWith(`.${base}`);
}

/** The domain of a bare address `local@domain`, lowercased; null if not exactly one valid address. */
export function domainOf(address: string | null): string | null {
  if (!address) return null;
  const a = address.trim();
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point of this check
  if (/[\s<>,;"\\\u0000-\u001f\u007f]/.test(a)) return null;
  const at = a.lastIndexOf('@');
  if (at <= 0 || a.indexOf('@') !== at) return null;
  const d = normalizeDomain(a.slice(at + 1));
  return DOMAIN_RE.test(d) ? d : null;
}

export function decideTrust(fromAddress: string | null, verdicts: readonly DkimVerdict[], allowed: readonly string[]): TrustDecision {
  const fromDomain = domainOf(fromAddress);
  if (!fromDomain) return { trusted: false, code: 'FROM_INVALID', fromDomain: null };
  if (verdicts.length === 0) return { trusted: false, code: 'DKIM_MISSING', fromDomain };
  const passing = verdicts.filter((v) => v.result.toLowerCase() === 'pass').map((v) => normalizeDomain(v.domain)).filter((d) => DOMAIN_RE.test(d));
  if (passing.length === 0) return { trusted: false, code: 'DKIM_FAILED', fromDomain };
  const allow = allowed.map(normalizeDomain).filter(isAllowableSenderDomain);
  let aligned = false;
  for (const d of passing) {
    // relaxed alignment, conservatively: both under one allowlisted entry, or one under the other
    if (!(isUnder(fromDomain, d) || isUnder(d, fromDomain))) continue;
    aligned = true;
    const entry = allow.find((base) => isUnder(fromDomain, base) && isUnder(d, base));
    if (entry) return { trusted: true, domain: entry, fromDomain };
  }
  return { trusted: false, code: aligned ? 'SENDER_NOT_ALLOWED' : 'DKIM_UNALIGNED', fromDomain };
}

/** Why an email was held, in words (the Needs review list; never a raw code in the UI). */
export const HOLD_SENTENCES: Record<string, string> = {
  FROM_INVALID: 'The sender address is missing or malformed, so the email cannot be verified.',
  DKIM_MISSING: 'The email carries no DKIM signature result, so we cannot tell who sent it.',
  DKIM_FAILED: 'The DKIM signature did not verify, so the email may be forged.',
  DKIM_UNALIGNED: 'The email was signed by a different domain than the one in its From address (a spoofed sender looks like this).',
  SENDER_NOT_ALLOWED: 'The sender domain is not on this lead source’s allowed sender list.',
  UNKNOWN_FORMAT: 'The email is verified, but its format is not one we can read.',
  PARTIAL_FORMAT: 'The email is verified, but its format has changed and could not be read completely.',
  NO_CONTACT_POINT: 'No phone number or email address of the person was found in it.',
};
