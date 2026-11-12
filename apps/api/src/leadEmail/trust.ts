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
//   PERSONAL_MAILBOX    (checked right after FROM_INVALID) the From domain is a consumer mailbox (gmail.com,
//                       outlook.com, ...): a lead forwarded by hand (R-LEM-11). Such a domain is never an allowlist
//                       entry, and an older saved entry is ignored.
//   SENDER_NOT_ALLOWED  an aligned pass, but the domain is not on the inbox's allowlist
// FORWARDING_CONFIRMATION (R-LEM-12) is decided before this rule (isForwardingConfirmation): Gmail's own request to
// confirm forwarding is held as such and never parsed into an inquiry.
// A DKIM-Signature header, an Authentication-Results header the sender wrote, or any other content of the message
// is never evidence: verdicts come from the provider adapter only (formats.ts).

export type HoldCode = 'FROM_INVALID' | 'PERSONAL_MAILBOX' | 'DKIM_MISSING' | 'DKIM_FAILED' | 'DKIM_UNALIGNED' | 'SENDER_NOT_ALLOWED';

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
 * Consumer mailbox domains (R-LEM-11). VERIFY: a fixed list, not a registry; extend it from real Needs review items.
 * Mail from these is a person's own mailbox (a lead forwarded by hand looks like this), never a portal: such a domain
 * is never allowlisted, its address is a lead's own (extract.ts keeps it), and its mail is held PERSONAL_MAILBOX.
 */
export const CONSUMER_MAILBOX_DOMAINS: readonly string[] = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'comcast.net', 'att.net', 'verizon.net',
];

/** `d` is a consumer mailbox domain or a subdomain of one. */
export function isConsumerMailboxDomain(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string') return false;
  const d = normalizeDomain(raw);
  return CONSUMER_MAILBOX_DOMAINS.some((base) => isUnder(d, base));
}

export type PortalId = 'zillow' | 'realtor' | 'redfin' | 'homes' | 'trulia' | 'opcity';

/**
 * The portal catalog shown when an Owner/Admin sets up an inbox. VERIFY with each portal which domain DKIM-signs its
 * lead notifications (a portal may sign with an email vendor's domain, which would then be unaligned and held).
 * The label is the portal's name only, because an Owner reads it: the page marks each chip "suggested" and says
 * the suggested domains are unconfirmed until a test lead from each portal becomes a lead automatically (one that
 * arrives but is held, e.g. DKIM_UNALIGNED, confirms nothing). VERIFY is for engineers and counsel and never
 * appears in what the API sends (leadEmail.test.ts). Only Zillow and Realtor.com are pre-ticked; the others have
 * no vendor parser (they wait for real samples and counsel) and are read only when labelled (generic) or when they
 * carry lead metadata.
 */
export const PORTAL_CATALOG: readonly { portal: PortalId; domain: string; label: string; preTicked: boolean }[] = [
  { portal: 'zillow', domain: 'zillow.com', label: 'Zillow', preTicked: true }, // VERIFY
  { portal: 'realtor', domain: 'realtor.com', label: 'Realtor.com', preTicked: true }, // VERIFY
  { portal: 'redfin', domain: 'redfin.com', label: 'Redfin', preTicked: false }, // VERIFY
  { portal: 'homes', domain: 'homes.com', label: 'Homes.com', preTicked: false }, // VERIFY
  { portal: 'homes', domain: 'homesnap.com', label: 'Homes.com', preTicked: false }, // VERIFY
  { portal: 'trulia', domain: 'trulia.com', label: 'Trulia', preTicked: false }, // VERIFY
  // VERIFY: Opcity (a Realtor.com company) may send from a realtor.com domain instead
  { portal: 'opcity', domain: 'opcity.com', label: 'Opcity', preTicked: false },
];

/** The pre-ticked suggestions (the existing API field suggestedSenderDomains). */
export const SUGGESTED_SENDER_DOMAINS: readonly { domain: string; label: string }[] = PORTAL_CATALOG.filter((p) => p.preTicked).map(({ domain, label }) => ({ domain, label }));

export function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/\.$/, '');
}

/** Why a domain cannot be an allowlist entry, or null when it can. */
export function senderDomainProblem(raw: string): 'invalid' | 'consumer_mailbox' | null {
  const d = normalizeDomain(raw);
  if (!DOMAIN_RE.test(d) || PUBLIC_SUFFIXES.has(d)) return 'invalid';
  return isConsumerMailboxDomain(d) ? 'consumer_mailbox' : null;
}

/**
 * An allowlist entry: a syntactically valid domain that is not a bare public suffix, carries no wildcard and is not a
 * consumer mailbox domain (anyone can send from gmail.com with gmail.com's DKIM pass).
 */
export function isAllowableSenderDomain(raw: string): boolean {
  return senderDomainProblem(raw) === null;
}

/** Saved allowlist entries the rule ignores (consumer mailbox domains saved before R-LEM-11), for the settings page. */
export function ignoredSenderDomains(saved: readonly string[]): string[] {
  return [...new Set(saved.map(normalizeDomain).filter(isConsumerMailboxDomain))];
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
  if (isConsumerMailboxDomain(fromDomain)) return { trusted: false, code: 'PERSONAL_MAILBOX', fromDomain };
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

// ---- Gmail forwarding confirmations (R-LEM-12) ---------------------------------------------------------------

/** VERIFY: Gmail sends the confirmation from forwarding-noreply@google.com. */
export const GMAIL_FORWARDING_DOMAIN = 'google.com';
/** VERIFY 4: e.g. "(#123456789) Gmail Forwarding Confirmation - Receive Mail from someone@example.com". */
export const GMAIL_FORWARDING_SUBJECT_RE = /Gmail Forwarding Confirmation/i;

/**
 * Gmail's request to confirm forwarding to this inbox: From google.com (or a subdomain), a DKIM pass the receiving
 * provider reported for google.com (or a subdomain) that is aligned with the From domain, and the subject. A copy
 * without that aligned pass is not one (it gets whatever hold decideTrust gives it).
 */
export function isForwardingConfirmation(fromAddress: string | null, verdicts: readonly DkimVerdict[], subject: string | null): boolean {
  const fromDomain = domainOf(fromAddress);
  if (!fromDomain || !isUnder(fromDomain, GMAIL_FORWARDING_DOMAIN)) return false;
  if (typeof subject !== 'string' || !GMAIL_FORWARDING_SUBJECT_RE.test(subject.slice(0, 998))) return false;
  return verdicts.some((v) => {
    if (v.result.toLowerCase() !== 'pass') return false;
    const d = normalizeDomain(v.domain);
    return DOMAIN_RE.test(d) && isUnder(d, GMAIL_FORWARDING_DOMAIN) && (isUnder(fromDomain, d) || isUnder(d, fromDomain));
  });
}

/** The address that asked Gmail to forward here, read from the confirmation's subject (VERIFY 4), or null. */
export function forwardingRequester(subject: string | null): string | null {
  if (typeof subject !== 'string') return null;
  const m = /\bfrom\s+<?([^\s<>()"',;]{1,254}@[^\s<>()"',;]{1,253}?)>?\s*$/i.exec(subject.slice(0, 998).trim());
  if (!m) return null;
  const a = m[1]!.toLowerCase();
  return domainOf(a) && /^[a-z0-9.!#$%&*+/=?^_`{|}~-]{1,64}@/.test(a) ? a : null;
}

/** The FORWARDING_CONFIRMATION sentence naming the requester (the review view fills <address> from the subject). */
export const FORWARDING_SENTENCE_TEMPLATE =
  "<address> asked Gmail to forward its mail here. If you don't know that address, discard this. If you do, give that person the confirmation code in the email below, then discard this email.";

/** Why an email was held, in words (the Needs review list; never a raw code in the UI). */
export const HOLD_SENTENCES: Record<string, string> = {
  FROM_INVALID: 'The sender address is missing or malformed, so the email cannot be verified.',
  PERSONAL_MAILBOX:
    "This email came from a personal mailbox (a lead forwarded by hand looks like this), so we can't confirm the portal sent it. Check it before accepting, or set up automatic forwarding.",
  // without a requester in the subject; with one, FORWARDING_SENTENCE_TEMPLATE (holdSentence)
  FORWARDING_CONFIRMATION:
    "Someone asked Gmail to forward their mail here. If you don't know who, discard this. If you do, give that person the confirmation code in the email below, then discard this email.",
  DKIM_MISSING: 'The email carries no DKIM signature result, so we cannot tell who sent it.',
  DKIM_FAILED: 'The DKIM signature did not verify, so the email may be forged.',
  DKIM_UNALIGNED: 'The email was signed by a different domain than the one in its From address (a spoofed sender looks like this).',
  SENDER_NOT_ALLOWED: 'The sender domain is not on this lead source’s allowed sender list.',
  UNKNOWN_FORMAT: 'The email is verified, but its format is not one we can read.',
  PARTIAL_FORMAT: 'The email is verified, but its format has changed and could not be read completely.',
  NO_CONTACT_POINT: 'No phone number or email address of the person was found in it.',
};

/** The sentence for a held email; a forwarding confirmation names the requester when its subject does. */
export function holdSentence(code: string | null, subject: string | null): string {
  const c = code ?? 'UNKNOWN_FORMAT';
  if (c === 'FORWARDING_CONFIRMATION') {
    const who = forwardingRequester(subject);
    if (who) return FORWARDING_SENTENCE_TEMPLATE.replace('<address>', who);
  }
  return HOLD_SENTENCES[c] ?? HOLD_SENTENCES.UNKNOWN_FORMAT!;
}

/** The lead source page's sentence on what we read (for the web). */
export const READABLE_FORMATS_SENTENCE = "We read emails that label the name, email and phone. If a portal's emails wait in Needs review, send us one so we can read that portal.";
