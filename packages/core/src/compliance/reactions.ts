// Texting reactions (owner decision D5b; R-REACT-1, R-REACT-2, R-REACT-3, R-REACT-6; E300–E308).
//
// VERIFY WITH COUNSEL (R-CONSENT-8, R-CONSENT-11, R-CHAN-3, D5b): when a phone reacts to a text from a sender that is
// not on iMessage/RCS, it sends a text such as `Loved “See you at 3”`. The quoted words are the TEAM's text, not the
// person's. A reaction is recognised only when (1) the WHOLE normalised body is exactly one quote form of the template
// table below, with nothing before or after (R-REACT-1), and (2) the quote equals, under the classifier's
// normalisation, the whole body of a text the team sent that same phone (R-REACT-2; the candidates are the API's, and
// the DB guard re-checks the same bounds). Only then is the text classified by its OWN words (the template words and
// the emoji); every other text is classified exactly as before D5 (R-REACT-3, property-tested). An opt-out written
// outside the quotes therefore always counts.
//
// Normalisation is NFC (never NFKC: it turns ‼️ into "!!" and ℹ️ into "i"), the deletion of U+200B, U+200C, U+2060 and
// U+FEFF, and every whitespace run (U+200A included) collapsed to one space, then trimmed. Nothing else is parsed:
// media reactions (`Loved an image`), en-GB spellings, Spanish iPhone emoji/sticker forms, `Removed a <emoji> from`,
// photomoji and iOS 27 sender-named forms return null and are classified exactly as today. Vendor formats: VERIFY
// items 1–9 and 13 of the D5b lane brief.
import type { Channel, Keywords } from './types.js';
import { type InboundClassification, classifyInbound, lowerText } from './inbound.js';

/** A reaction's target must have been created at most this many days before the reaction (R-REACT-2). */
export const REACTION_WINDOW_DAYS = 30;
/** At most this many candidate texts are compared, newest first (R-REACT-2). */
export const REACTION_MAX_CANDIDATES = 100;

export type ReactionName = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question' | 'sticker' | 'emoji';
export const REACTION_NAMES: readonly ReactionName[] = ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'sticker', 'emoji'];
export type ReactionAction = 'add' | 'remove';

export interface ParsedReaction {
  action: ReactionAction;
  reaction: ReactionName;
  /** The emoji as received (only for `emoji`), else null. */
  emoji: string | null;
  /** The quoted words (the team's text, if it links). */
  quote: string;
  /** The body without the quote and its marks: "Loved", "Reacted 👍 to", "👍 to", "Se ha quitado 👍 de". */
  ownWords: string;
}

/** Exactly one emoji of 1–16 code points (flags, keycaps, tag flags, ZWJ sequences, modifiers, VS16). */
const EMOJI =
  /^(?:\p{RI}\p{RI}|[#*0-9]\u{FE0F}?\u{20E3}|\p{Extended_Pictographic}\u{FE0F}?\p{Emoji_Modifier}?(?:[\u{E0020}-\u{E007E}]+\u{E007F})?(?:\u{200D}\p{Extended_Pictographic}\u{FE0F}?\p{Emoji_Modifier}?)*)$/u;

export function isSingleEmoji(s: string): boolean {
  const n = [...s].length;
  return n >= 1 && n <= 16 && EMOJI.test(s);
}

/** NFC; U+200B, U+200C, U+2060, U+FEFF removed; whitespace (U+200A included) collapsed to one space; trimmed. */
export function normalizeReactionBody(body: string): string {
  return body.normalize('NFC').replace(/[​‌⁠﻿]/gu, '').replace(/\s+/gu, ' ').trim();
}

const TAPBACKS: readonly ReactionName[] = ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'];

interface FixedForm {
  words: string;
  action: ReactionAction;
  reaction: ReactionName;
}

const fixed = (action: ReactionAction, words: readonly string[], names: readonly ReactionName[] = TAPBACKS): FixedForm[] =>
  words.map((w, i) => ({ words: w, action, reaction: names[i]! }));

/** Template words without an emoji, matched case-insensitively and followed by one space and the quote. */
const FIXED_FORMS: readonly FixedForm[] = [
  // iPhone en-US tapbacks
  ...fixed('add', ['Loved', 'Liked', 'Disliked', 'Laughed at', 'Emphasized', 'Questioned']),
  ...fixed('remove', ['Removed a heart from', 'Removed a like from', 'Removed a dislike from', 'Removed a laugh from', 'Removed an exclamation from', 'Removed a question mark from']),
  // iPhone 18–26 stickers
  { words: 'Reacted with a sticker to', action: 'add', reaction: 'sticker' },
  { words: 'Removed a sticker from', action: 'remove', reaction: 'sticker' },
  // iPhone es-419 tapbacks (same order as en-US)
  ...fixed('add', ['Le encantó', 'Le gustó', 'No le gustó', 'Le dio risa', 'Exclamó por', 'Dudó sobre']),
  ...fixed('remove', ['Dejó de encantarle', 'Dejó de gustarle', 'Dejó de no gustarle', 'Dejó de darle risa', 'Dejó de exclamar por', 'Dejó de dudar sobre']),
];

interface EmojiForm {
  before: string;
  after: string;
  action: ReactionAction;
}

/** Template words around one emoji E: `${before}E${after}` then one space and the quote. */
const EMOJI_FORMS: readonly EmojiForm[] = [
  { before: 'Reacted ', after: ' to', action: 'add' }, // iPhone 18+
  { before: 'Removed ', after: ' from', action: 'remove' }, // iPhone 18+, Google en
  { before: 'Se quitó ', after: ' de', action: 'remove' }, // Google es-US table
  { before: 'Se ha quitado ', after: ' de', action: 'remove' }, // Google es table
  { before: '', after: ' to', action: 'add' }, // Google en
  { before: '', after: ' a', action: 'add' }, // Google es
];

const CLOSE: Readonly<Record<string, string>> = { '“': '”', '"': '"' };

function startsWithCI(s: string, prefix: string): boolean {
  if (s.length < prefix.length) return false;
  const head = s.slice(0, prefix.length);
  return head === prefix || head.toLowerCase() === prefix.toLowerCase();
}

/** `rest` must be exactly a quote: “…” or "…", one space just inside each mark dropped, non-empty. */
function quoteOf(rest: string): string | null {
  const open = rest[0];
  if (open === undefined) return null;
  const close = CLOSE[open];
  if (close === undefined || rest.length < 2 || !rest.endsWith(close)) return null;
  let q = rest.slice(1, -1);
  if (q.startsWith(' ')) q = q.slice(1);
  if (q.endsWith(' ')) q = q.slice(0, -1);
  return q === '' ? null : q;
}

/**
 * R-REACT-1: the reaction a whole text is, or null. Anchored: the normalised body is exactly template words, one
 * space and a quote that runs to the end of the body.
 */
export function parseReaction(body: string): ParsedReaction | null {
  const n = normalizeReactionBody(body);
  for (const f of FIXED_FORMS) {
    if (!startsWithCI(n, `${f.words} `)) continue;
    const quote = quoteOf(n.slice(f.words.length + 1));
    if (quote === null) continue;
    return { action: f.action, reaction: f.reaction, emoji: null, quote, ownWords: n.slice(0, f.words.length) };
  }
  for (const f of EMOJI_FORMS) {
    if (!startsWithCI(n, f.before)) continue;
    const afterBefore = n.slice(f.before.length);
    const sp = afterBefore.indexOf(' ');
    if (sp <= 0) continue;
    const emoji = afterBefore.slice(0, sp);
    const tail = afterBefore.slice(sp);
    if (!startsWithCI(tail, `${f.after} `)) continue;
    if (!isSingleEmoji(emoji)) continue;
    const quote = quoteOf(tail.slice(f.after.length + 1));
    if (quote === null) continue;
    const ownLen = f.before.length + sp + f.after.length;
    return { action: f.action, reaction: 'emoji', emoji, quote, ownWords: n.slice(0, ownLen) };
  }
  return null;
}

/** R-REACT-2 link key: the classifier's normalisation (case, spacing, apostrophes), double quotes folded, trimmed. */
export function reactionLinkKey(s: string): string {
  return lowerText(s).replace(/[“”„‟«»]/g, '"').trim();
}

export interface ReactionCandidate {
  id: string;
  body: string;
}

export interface ReactionReading {
  /** What the inbound pipeline acts on. */
  classification: InboundClassification;
  /** classifyInbound of the whole body (kept for review: `whole_text_reading`). */
  wholeText: InboundClassification;
  reaction: (ParsedReaction & { targetMessageId: string }) | null;
}

/**
 * R-REACT-2, R-REACT-3: classify one inbound text. `sent` are the candidate team texts, newest first (the API loads
 * them with the guard's bounds). A reaction exists only on SMS, when the parse succeeds and the quote equals the whole
 * body of a candidate (the newest when several are equal). Otherwise `classification` IS the whole-text reading.
 */
export function classifyWithReaction(body: string, keywords: Keywords, channel: Channel, sent: readonly ReactionCandidate[]): ReactionReading {
  const wholeText = classifyInbound(body, keywords, channel);
  if (channel !== 'sms') return { classification: wholeText, wholeText, reaction: null };
  const parsed = parseReaction(body);
  if (parsed === null) return { classification: wholeText, wholeText, reaction: null };
  const key = reactionLinkKey(parsed.quote);
  const target = sent.slice(0, REACTION_MAX_CANDIDATES).find((c) => reactionLinkKey(c.body) === key);
  if (target === undefined) return { classification: wholeText, wholeText, reaction: null };
  return { classification: classifyInbound(parsed.ownWords, keywords, 'sms'), wholeText, reaction: { ...parsed, targetMessageId: target.id } };
}

export interface ReactionEvent {
  action: ReactionAction;
  reaction: ReactionName;
  emoji: string | null;
}

const bareEmoji = (e: string | null): string | null => (e === null ? null : e.replace(/\u{FE0F}/gu, ''));

function sameReaction(a: ReactionEvent, b: ReactionEvent): boolean {
  if (a.reaction !== b.reaction) return false;
  return a.reaction !== 'emoji' || bareEmoji(a.emoji) === bareEmoji(b.emoji);
}

/**
 * R-REACT-6: the reaction in force on one text, from its reaction events in time order. The latest add wins; a
 * removal clears only a matching reaction (the same name; for emoji, equal with only U+FE0F removed).
 */
export function foldReactions<T extends ReactionEvent>(events: readonly T[]): T | null {
  let current: T | null = null;
  for (const ev of events) {
    if (ev.action === 'add') current = ev;
    else if (current !== null && sameReaction(current, ev)) current = null;
  }
  return current;
}

const ADD_PHRASE: Readonly<Record<Exclude<ReactionName, 'emoji'>, string>> = {
  love: 'loved',
  like: 'liked',
  dislike: 'disliked',
  laugh: 'laughed at',
  emphasize: 'emphasized',
  question: 'questioned',
  sticker: 'reacted with a sticker to',
};

const REMOVE_PHRASE: Readonly<Record<Exclude<ReactionName, 'emoji'>, string>> = {
  love: 'removed a heart from',
  like: 'removed a like from',
  dislike: 'removed a dislike from',
  laugh: 'removed a laugh from',
  emphasize: 'removed an exclamation from',
  question: 'removed a question mark from',
  sticker: 'removed a sticker from',
};

/** The copy the API and the web share: "loved", "reacted 👍 to", "removed a heart from", "removed 👍 from". */
export function reactionPhrase(r: ReactionEvent): string {
  if (r.reaction === 'emoji') return r.action === 'add' ? `reacted ${r.emoji ?? ''} to` : `removed ${r.emoji ?? ''} from`;
  return r.action === 'add' ? ADD_PHRASE[r.reaction] : REMOVE_PHRASE[r.reaction];
}
