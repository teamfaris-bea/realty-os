// Content rules the gate needs as facts (R-GATE-7, R-GATE-12, R-CONSENT-5 purpose, R-CONSENT-18).
//
// - Payment / wire instructions (routing or account numbers, "wire to", IBAN, SWIFT/BIC) are
//   never sent by text or email from here, by any initiator (R-GATE-7).
// - Every outbound marketing message renders the brokerage legal name (R-GATE-12, A7f).
// - Marketing email carries an unsubscribe link; SMS opt-out hints are detected for the
//   assistant's content guard.
// - A human free-form message is informational when the contact wrote in during the last 30 days
//   or it is sent from a deal/appointment context; otherwise marketing (R-CONSENT-5).
// VERIFY WITH COUNSEL: the payment lexicon, brokerage-name placement and the 30-day rule.
import { DAY_MS, type Instant } from '../foundation/index.js';
import type { Channel, Purpose } from './types.js';

export const PAYMENT_BLOCK_SENTENCE = "For safety, wiring details can't be sent by text or email from here.";

/** The 30-day "wrote in recently" window for purpose classification (R-CONSENT-5). */
export const INFORMATIONAL_REPLY_WINDOW_MS = 30 * DAY_MS;

// ---- names --------------------------------------------------------------------------------------

/** Lower-case word tokens with punctuation removed: "Acme Realty, LLC" → ['acme','realty','llc']. */
export function nameTokens(s: string): string[] {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((t) => t !== '');
}

/** Whether `name` appears in `text` as a whole, contiguous run of words. */
export function containsName(text: string, name: string): boolean {
  const hay = nameTokens(text);
  const needle = nameTokens(name);
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((t, j) => hay[i + j] === t)) return true;
  }
  return false;
}

// ---- payment instructions -----------------------------------------------------------------------

const PAYMENT_PATTERNS: readonly RegExp[] = [
  /\b(?:routing|aba|rtn)\s*(?:number|num|no\b|#)/iu,
  // "routing 021000021", "ABA: 021000021", "RTN# 021000021": a routing word next to nine digits
  /\b(?:routing|aba|rtn)\b\.?\s*(?:number|num|no\.?|#)?\s*[:#-]?\s*\d{9}(?!\d)/iu,
  // "Account No. 12345678", "Acct. 000123456789", "account number: 1234 5678"
  /\b(?:account|acct)\b\.?\s*(?:number|num|no\.?|#)?\s*(?:is\b|:|-)?\s*#?\s*\d[\d -]{2,}\d/iu,
  /\bwire\s+(?:the\s+|your\s+|my\s+|our\s+)?(?:funds\s+|money\s+|deposit\s+|earnest\s+money\s+|emd\s+|payment\s+|down\s+payment\s+|it\s+|them\s+)?(?:to|into)\b/iu,
  /\bwire\s+(?:transfer|instructions|details|info)/iu,
  /\bwiring\s+(?:instructions|details|info)/iu,
  /\biban\b/iu,
  /\bswift\s*(?:code|#|:|\/\s*bic)|\bbic\s*(?:code|#|:)/iu,
  /\b[Ss][Ww][Ii][Ff][Tt]\s+[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/u,
];

function ibanValid(raw: string): boolean {
  // `raw` already has the IBAN shape (the caller's regex); only the checksum is left to check.
  const s = raw.replace(/\s+/g, '');
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

function abaValid(d: string): boolean {
  const n = [...d].map(Number) as number[];
  const sum = 3 * (n[0]! + n[3]! + n[6]!) + 7 * (n[1]! + n[4]! + n[7]!) + (n[2]! + n[5]! + n[8]!);
  return sum % 10 === 0;
}

/**
 * Deterministic payment-instruction detector (R-GATE-7). It errs towards blocking: a false
 * positive costs one rephrased message; a false negative can cost a client their deposit.
 */
export function detectPaymentInstructions(text: string): boolean {
  const t = text.normalize('NFKC');
  if (PAYMENT_PATTERNS.some((re) => re.test(t))) return true;
  for (const m of t.matchAll(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){11,30}\b/gu)) if (ibanValid(m[0])) return true;
  if (/\b(?:bank|wire|wiring|transfer|routing|aba|rtn|account|acct)\b/iu.test(t)) {
    for (const m of t.matchAll(/(?<![\d-])\d{9}(?![\d-])/gu)) if (abaValid(m[0])) return true;
  }
  return false;
}

// ---- rendered facts -----------------------------------------------------------------------------

const SMS_OPT_OUT_HINT = /\b(?:reply|text|send)\s+["'“]?stop\b|\bstop\s+to\s+(?:opt\s*-?\s*out|unsubscribe|end|cancel|quit)\b/iu;
const EMAIL_UNSUBSCRIBE = /\bunsubscribe\b/iu;

export function containsOptOutHint(text: string, channel: Channel): boolean {
  if (channel === 'sms') return SMS_OPT_OUT_HINT.test(text);
  if (channel === 'email') return EMAIL_UNSUBSCRIBE.test(text);
  return false;
}

/** `GateInput.rendered` for a fully rendered body (template + footer, exactly as it will be sent). */
export function renderedFacts(text: string, i: { channel: Channel; brokerageLegalName: string | null }): {
  containsBrokerageName: boolean;
  containsOptOutHint: boolean;
  paymentInstructions: boolean;
} {
  return {
    containsBrokerageName: i.brokerageLegalName !== null && containsName(text, i.brokerageLegalName),
    containsOptOutHint: containsOptOutHint(text, i.channel),
    paymentInstructions: detectPaymentInstructions(text),
  };
}

// ---- purpose ------------------------------------------------------------------------------------

/** R-CONSENT-5 purpose classification of a human free-form message. */
export function classifyHumanPurpose(i: { lastInboundAt: Instant | null; dealOrAppointmentContext: boolean; now: Instant }): Purpose {
  if (i.dealOrAppointmentContext) return 'informational';
  if (i.lastInboundAt !== null && i.lastInboundAt <= i.now && i.now - i.lastInboundAt <= INFORMATIONAL_REPLY_WINDOW_MS) return 'informational';
  return 'marketing';
}
