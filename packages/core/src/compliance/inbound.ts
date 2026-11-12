// Inbound keywords and opt-out language (R-CONSENT-7, R-CONSENT-8, R-CONSENT-10, R-CONSENT-11; E24, E25).
//
// Exact keywords (STOP, START, HELP lists from the resolved policy) match after trimming,
// case-folding, punctuation/emoji stripping and repeat-collapsing:
//   "stop."  "Stop 🙏"  "STOP STOP"  "stopp"  →  STOP
// Anything longer is not a keyword; it may still be opt-out LANGUAGE, which is a deterministic
// regex set with negation handling ("Stop by at 5?" and "Don't stop sending listings!" are not
// opt-outs; "please stop texting me" and "do not call" are). Opt-out language and wrong-number
// replies revoke immediately and carry needs_review; the agent may mark "not an opt-out"
// (consent.ts `planNotAnOptOut`). The LLM never revokes or reinstates.
//
// `planInboundEffects` turns a classification into the consent events and side effects the
// inbound transaction must apply (ARCHITECTURE §10 step 5). VERIFY WITH COUNSEL: keyword lists,
// language patterns, confirmation and HELP behaviour.
import type { IdGenerator, Instant } from '../foundation/index.js';
import type { ConsentEventSpec } from './consent.js';
import type { ResolvedPolicy } from './policy.js';
import { type PointKind, CHANNELS, type Channel, type Keywords, channelsOfKind, pointKindOf } from './types.js';
import { RESUBSCRIBE_CHANNELS } from './consent.js';

export type InboundKind = 'stop' | 'start' | 'help' | 'wrong_number' | 'opt_out_language' | 'none';

export interface InboundClassification {
  kind: InboundKind;
  matched?: string;
  needsReview: boolean;
  /**
   * core-compliance/3.0.0: what the opt-out reaches. `person` (opt-out language on any channel,
   * D-OPTOUT-LANG, R-CHAN-3) sets the person-level do-not-contact; `channel` (an exact keyword) revokes
   * that channel on the contact's points of its kind (R-CONSENT-7); `address` (wrong number)
   * the sending address only. Absent for START/HELP/none.
   */
  scope?: 'person' | 'channel' | 'address';
}

/**
 * Invisible format characters and combining marks (zero-width space/joiner, soft hyphen, variation
 * selectors, combining underlines) are removed outright rather than turned into word breaks, so
 * "S\u200BTOP" or a pasted "ST\u00ADOP" is still STOP.
 */
const INVISIBLE = /[\p{Cf}\p{Mn}\p{Me}]/gu;

/** Upper-cases, strips everything but letters/digits, collapses whitespace: "Opt-out!" → "OPT OUT". */
export function normalizeKeyword(s: string): string {
  return s
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Collapses runs of one letter ("STOPP" → "STOP") so stretched keywords still match. */
function squeeze(token: string): string {
  return token.replace(/(\p{L})\1+/gu, '$1');
}

function tokens(s: string): string[] {
  const n = normalizeKeyword(s);
  return n === '' ? [] : n.split(' ').map(squeeze);
}

/** The keyword the whole message is (once or repeated: "STOP STOP"), or null. */
function exactKeyword(body: readonly string[], list: readonly string[]): string | null {
  if (body.length === 0) return null;
  for (const kw of list) {
    const k = tokens(kw);
    if (k.length === 0 || body.length % k.length !== 0) continue;
    if (body.every((t, i) => t === k[i % k.length])) return normalizeKeyword(kw);
  }
  return null;
}

// ---- language -----------------------------------------------------------------------------------

const VERB = String.raw`(?:texting|texts?|txt|messaging|messages?|msgs?|calling|calls?|contacting|emailing|e-?mails?|sending|bothering)`;
/**
 * A negation right before a phrase ("don't", "do not", "never", "won't", "not", optionally then "please", "just", "ever",
 * "the"). Exported for core/isa's negation window (D12, docs/AI_ISA.md §4.3); test it on the text BEFORE a match.
 */
export const NEGATOR_BEFORE = /(?:\bdon'?t|\bdo not|\bnever|\bwon'?t|\bnot)\s+(?:please\s+|just\s+|ever\s+|the\s+)?$/;

interface LanguagePattern {
  re: RegExp;
  /** Whether a negation directly before the match cancels it ("don't stop sending"). */
  negatable: boolean;
}

const OPT_OUT_LANGUAGE: readonly LanguagePattern[] = [
  { re: new RegExp(String.raw`\b(?:stop|quit|cease)\s+(?:all\s+|the\s+|these\s+|your\s+)?${VERB}\b`, 'u'), negatable: true },
  { re: /\b(?:do not|don'?t|never)\s+(?:ever\s+)?(?:text|txt|message|msg|call|contact|e-?mail)\b/u, negatable: false },
  { re: /\b(?:remove|take)\s+me\s+(?:off|from)\b/u, negatable: true },
  { re: /\bremove\s+(?:me|my\s+number|this\s+number|my\s+e-?mail)\b/u, negatable: true },
  { re: /\b(?:unsubscribe\s+me|opt\s+me\s+out)\b/u, negatable: true },
  { re: /\blose\s+my\s+(?:number|e-?mail)\b/u, negatable: true },
  { re: /\bleave\s+me\s+alone\b/u, negatable: true },
  { re: /\bno\s+more\s+(?:texts?|messages?|calls?|e-?mails?)\b/u, negatable: false },
  {
    re: /\b(?:don'?t|do not|no longer)\s+want\s+(?:any\s+more\s+|anymore\s+|any\s+|more\s+|your\s+|these\s+|the\s+)*(?:texts?|messages?|calls?|e-?mails?)\b/u,
    negatable: false,
  },
];

const WRONG_NUMBER: readonly LanguagePattern[] = [
  { re: /\bwrong\s+(?:number|num|#|person|phone|e-?mail)/u, negatable: true },
  { re: /\b(?:is\s+not|isn't|not)\s+(?:the\s+)?(?:right|correct)\s+(?:number|person)\b/u, negatable: false },
];

export function lowerText(body: string): string {
  return body.normalize('NFKC').replace(INVISIBLE, '').toLowerCase().replace(/[‘’ʼ`]/g, "'").replace(/\s+/g, ' ');
}

/**
 * The first non-negated match of any pattern. EVERY occurrence of a pattern is checked: a negated
 * first phrase ("don't stop sending listings") must not hide a later real one ("but stop texting
 * me at night").
 */
function firstMatch(text: string, patterns: readonly LanguagePattern[]): string | null {
  for (const p of patterns) {
    // Patterns are declared without the `g` flag (no shared lastIndex); matchAll needs a global copy.
    for (const m of text.matchAll(new RegExp(p.re.source, `${p.re.flags}g`))) {
      if (p.negatable && NEGATOR_BEFORE.test(text.slice(0, m.index))) continue;
      return m[0];
    }
  }
  return null;
}

/**
 * Courtesy words that may surround an opt-out keyword ("Please stop", "STOP IT", "unsubscribe
 * please"). Such a message is not an EXACT keyword (R-CONSENT-7), but it is plainly opt-out
 * language (R-CONSENT-8): it revokes with needs_review. Words that change the meaning ("by", "at",
 * "the") are deliberately absent, so "Stop by at 5?" stays a normal message (E24).
 */
const COURTESY = new Set(
  ['PLEASE', 'PLS', 'PLZ', 'PLEEZ', 'NOW', 'IT', 'THANKS', 'THANK', 'YOU', 'THX', 'TY', 'OK', 'OKAY', 'JUST', 'ALREADY', 'SERIOUSLY'].map(squeeze),
);

function keywordWithCourtesy(body: readonly string[], list: readonly string[]): string | null {
  const core = body.filter((t) => !COURTESY.has(t));
  if (core.length === 0 || core.length === body.length) return null;
  return exactKeyword(core, list);
}

/**
 * Classifies an inbound message body. Precedence: STOP keywords, START, HELP, wrong number, opt-out
 * language. Only exact keywords skip review.
 */
export function classifyInbound(body: string, k: Keywords, channel: Channel = 'sms'): InboundClassification {
  const t = tokens(body);
  const stop = exactKeyword(t, k.optOut);
  // Website chat has no keyword protocol (no carrier, no START): a bare STOP typed into chat is the
  // visitor asking to stop, so it is opt-out language for the session's own contact (R-CHAN-3, E155).
  if (stop !== null && channel === 'web_chat') return { kind: 'opt_out_language', matched: stop.toLowerCase(), needsReview: true, scope: 'person' };
  if (stop !== null) return { kind: 'stop', matched: stop, needsReview: false, scope: 'channel' };
  const start = exactKeyword(t, k.resubscribe);
  if (start !== null && (RESUBSCRIBE_CHANNELS.has(channel) || channel === 'email')) return { kind: 'start', matched: start, needsReview: false };
  const help = exactKeyword(t, k.help);
  if (help !== null && channel !== 'web_chat') return { kind: 'help', matched: help, needsReview: false };
  const text = lowerText(body);
  const wrong = firstMatch(text, WRONG_NUMBER);
  if (wrong !== null) return { kind: 'wrong_number', matched: wrong, needsReview: true, scope: 'address' };
  const lang = firstMatch(text, OPT_OUT_LANGUAGE);
  if (lang !== null) return { kind: 'opt_out_language', matched: lang, needsReview: true, scope: 'person' };
  const polite = keywordWithCourtesy(t, k.optOut);
  if (polite !== null) return { kind: 'opt_out_language', matched: polite.toLowerCase(), needsReview: true, scope: 'person' };
  return { kind: 'none', needsReview: false };
}

/** Channels an opt-out phrase names ("do not call" → voice); none named → the inbound channel. */
export function channelsNamed(matched: string, inbound: Channel): Channel[] {
  const out: Channel[] = [];
  if (/\b(?:text|txt|messag|msg)/u.test(matched)) out.push('sms');
  if (/\bcall/u.test(matched)) out.push('voice');
  if (/\be-?mail/u.test(matched)) out.push('email');
  return out.length > 0 ? out : [inbound];
}

// ---- effects ------------------------------------------------------------------------------------

const CHANNEL_ORDER: readonly Channel[] = CHANNELS;

export interface InboundAddress {
  kind: PointKind;
  hmac: string;
  hint: string;
  /**
   * START only, the contact's OTHER phones: every SMS keyword revoke in force on this phone came from
   * the sender's own STOP (so the sender's START may lift it). Absent/false: the phone's own STOP (or
   * another number's) keeps it revoked until that number texts START (outbound-4).
   */
  keywordRevokedBySender?: boolean;
}

export interface InboundEffects {
  consentEvents: ConsentEventSpec[];
  /** Address HMACs whose queued/scheduled SMS must be cancelled in this transaction. */
  cancelQueuedSmsTo: string[];
  /** Mark the contact point `wrong_number` and stop (not just pause) its enrollments. */
  markWrongNumber: boolean;
  notifyOwner: boolean;
  /** The one system reply to send (consent-exempt), or none when the provider sends it. */
  reply: 'opt_out_confirmation' | 'help_reply' | 'none';
  /** core-compliance/3.0.0: queued/scheduled messages to cancel per channel and address (texts included). */
  cancelQueued: { channel: Channel; hmac: string }[];
  /**
   * Opt-out language on any channel (R-CHAN-3, D-OPTOUT-LANG): record the person-level do-not-contact
   * on the inbound contact (from web chat: the session's own contact) with needs_review, and fan out with
   * `optOutFanout(points, 'language', channel)`.
   */
  personDoNotContact: boolean;
}

/**
 * The consent side of one inbound message (R-CONSENT-7, -8, -10, -11). Every inbound message also
 * pauses automation (ARCHITECTURE §10 step 6); that is the ingestion pipeline's job and applies
 * whatever this returns.
 *
 * - STOP keyword (SMS): revoke SMS, all purposes, for the address AND the contact's other phones;
 *   cancel their queued SMS; notify the owner; exactly one confirmation if the platform (not the
 *   provider, the default) sends it.
 * - STOP on email: revoke email for that address.
 * - START (SMS): resubscribe the address, and the contact's other phones whose keyword revoke came from
 *   this address's own STOP (the fold restores only keyword revokes).
 * - HELP (SMS): one HELP reply if the platform sends it.
 * - Wrong number: revoke every channel of the address, mark the point, stop enrollments.
 * - Opt-out language: revoke the inbound channel plus any channel the phrase names ("do not call"
 *   → voice), SMS also for the contact's other phones; needs_review.
 */
export function planInboundEffects(i: {
  classification: InboundClassification;
  channel: Channel;
  address: InboundAddress;
  /**
   * The contact's other phones. A STOP or opt-out language fans out over the live ones. For a START the
   * API also passes the phones removed other than as a confirmed wrong number (they still block the
   * person at send time, R-PAR-12), each with `keywordRevokedBySender`.
   */
  otherPhones: readonly InboundAddress[];
  /** The contact's other email addresses: opt-out language naming email ("do not email me") reaches them. */
  otherEmails?: readonly InboundAddress[];
  /** Web chat: the contact's other chat identities (opt-out language reaches them). */
  otherPointsOfKind?: readonly InboundAddress[];
  occurredAt: Instant;
  contactId: string | null;
  messageId: string | null;
  policy: Pick<ResolvedPolicy, 'optOutConfirmationSender'>;
  ids: IdGenerator;
}): InboundEffects {
  const c = i.classification;
  const platform = i.policy.optOutConfirmationSender === 'platform';
  const fx: InboundEffects = { consentEvents: [], cancelQueuedSmsTo: [], markWrongNumber: false, notifyOwner: false, reply: 'none', cancelQueued: [], personDoNotContact: false };
  const event = (a: InboundAddress, channel: Channel, eventType: 'revoke' | 'resubscribe', source: ConsentEventSpec['source'], needsReview: boolean): ConsentEventSpec => ({
    id: i.ids.next<'ConsentEventId'>(),
    addressKind: a.kind,
    addressHmac: a.hmac,
    addressHint: a.hint,
    channel,
    purpose: 'all',
    eventType,
    level: 'none',
    source,
    occurredAt: i.occurredAt,
    contactId: i.contactId,
    actor: { kind: 'system' },
    disclosureId: null,
    evidenceObjectId: null,
    evidenceMessageId: i.messageId,
    evidenceCallId: null,
    evidenceCallOffsetMs: null,
    evidence: c.matched === undefined ? {} : { matched: c.matched },
    imported: false,
    importRecordId: null,
    originalProvenance: null,
    revertsEventId: null,
    expiresAt: null,
    needsReview,
  });
  const revokeSms = (source: ConsentEventSpec['source'], needsReview: boolean): void => {
    for (const a of [i.address, ...i.otherPhones.filter((p) => p.hmac !== i.address.hmac)].filter((p) => p.kind === 'phone')) {
      fx.consentEvents.push(event(a, 'sms', 'revoke', source, needsReview));
      fx.cancelQueuedSmsTo.push(a.hmac);
      fx.cancelQueued.push({ channel: 'sms', hmac: a.hmac });
    }
  };
  const channelsOf = (a: InboundAddress): Channel[] => channelsOfKind(a.kind);
  /** The inbound address (when of `kind`) plus the contact's other addresses of that kind, deduplicated. */
  const allOfKind = (kind: PointKind): InboundAddress[] => {
    const others = kind === 'phone' ? i.otherPhones : kind === 'email' ? (i.otherEmails ?? []) : (i.otherPointsOfKind ?? []);
    const out = new Map<string, InboundAddress>();
    for (const a of [i.address, ...others]) if (a.kind === kind && !out.has(a.hmac)) out.set(a.hmac, a);
    return [...out.values()];
  };

  switch (c.kind) {
    case 'stop':
      fx.notifyOwner = true;
      if (i.channel === 'sms') {
        revokeSms('inbound_keyword', false);
        fx.reply = platform ? 'opt_out_confirmation' : 'none';
      } else {
        fx.consentEvents.push(event(i.address, i.channel, 'revoke', 'inbound_keyword', false));
        fx.cancelQueued.push({ channel: i.channel, hmac: i.address.hmac });
      }
      break;
    case 'start':
      // START restores the pre-STOP state (R-CONSENT-10) of the number that sent it. A STOP revoked
      // this address AND the contact's other phones (R-CONSENT-7), so START also lifts the other
      // phones whose keyword revoke came from this number's own STOP; otherwise a two-phone contact
      // could never be texted again. A phone that texted STOP itself (or was revoked by a third
      // number's STOP) stays revoked until that number texts START (outbound-4: carriers, too, take
      // START only from the number that sent STOP). The fold undoes keyword revokes only, so an
      // opt-out-language, wrong-number or provider revoke stays in force either way.
      if (RESUBSCRIBE_CHANNELS.has(i.channel)) {
        for (const a of allOfKind(pointKindOf(i.channel))) {
          if (a.hmac === i.address.hmac || a.keywordRevokedBySender === true) fx.consentEvents.push(event(a, i.channel, 'resubscribe', 'inbound_keyword', false));
        }
      }
      break;
    case 'help':
      if (i.channel === 'sms' && platform) fx.reply = 'help_reply';
      break;
    case 'wrong_number':
      fx.notifyOwner = true;
      fx.markWrongNumber = true;
      for (const ch of channelsOf(i.address)) fx.consentEvents.push(event(i.address, ch, 'revoke', 'wrong_number', true));
      if (i.address.kind === 'phone') fx.cancelQueuedSmsTo.push(i.address.hmac);
      for (const ch of channelsOf(i.address)) fx.cancelQueued.push({ channel: ch, hmac: i.address.hmac });
      break;
    case 'opt_out_language': {
      fx.notifyOwner = true;
      fx.personDoNotContact = true;
      // The inbound channel is always revoked too (strictest); the agent can review it back.
      // A phrase naming another channel ("do not email me" sent by text, "stop calling" sent by
      // email) reaches that channel on the contact's addresses of that kind, not just the sender's.
      const named = new Set([i.channel, ...channelsNamed(c.matched ?? '', i.channel)]);
      for (const ch of CHANNEL_ORDER.filter((x) => named.has(x))) {
        if (ch === 'sms') revokeSms('inbound_language', true);
        else {
          for (const a of allOfKind(pointKindOf(ch))) {
            fx.consentEvents.push(event(a, ch, 'revoke', 'inbound_language', true));
            if (ch !== 'voice') fx.cancelQueued.push({ channel: ch, hmac: a.hmac });
          }
        }
      }
      break;
    }
    case 'none':
      break;
  }
  return fx;
}
