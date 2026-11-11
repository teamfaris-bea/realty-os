// Screening model output before anything is stored or shown (lane prompt-injection; R-AST-3, R-AST-11,
// R-AST-14, R-GATE-7; E35, E64).
//
// Threat model: the model can be fully manipulated by the content it reads (inbound texts and emails,
// call transcripts, imported notes, listing data, lead-source payloads). So its output is attacker
// controlled, and nothing it says is trusted:
//   - the RECIPIENT is never in the output: drafts are bound to the one contact the prompt was built
//     for, and the CHANNEL is chosen by the server (the channel the client last wrote on), never by
//     the model (`channel` in the output is ignored and reported as CHANNEL_OVERRIDE);
//   - wiring / routing / account details make the whole draft unusable (PAYMENT_INSTRUCTIONS,
//     `blocked`): it is never stored as something a tap could send (R-GATE-7);
//   - human claims, links, phone numbers and email addresses that appear in no source, hidden
//     characters, and money / contract topics are FLAGS: the draft still waits for the agent's tap
//     and the card says, in the server's words, what to check (the model's own explanation is dropped
//     whenever a flag is raised, so the model cannot talk the agent past its own red flags);
//   - an oversized body is refused, never silently truncated (a cut draft can lose its meaning);
//   - an oversized raw output, or one that is not the JSON contract, yields nothing at all.
// Pure: no I/O, no clock.
import { detectPaymentInstructions } from '../compliance/index.js';
import type { SourceText } from './evidence.js';
import { findHumanClaim, foldForDetection, hostAllowed, isObfuscated, lexiconHits, linkHosts } from './guard.js';
import type { IdentityFacts } from './types.js';

/** Largest raw model output the API stores or parses (bytes of UTF-16 text). Anything bigger is refused. */
export const MODEL_OUTPUT_MAX_CHARS = 32_000;
/** Largest draft body per channel. Longer drafts are refused (TOO_LONG), never truncated. */
export const DRAFT_BODY_MAX: Readonly<Record<'sms' | 'email', number>> = { sms: 1_600, email: 8_000 };
export const DRAFT_SUBJECT_MAX = 200;
/** Largest model explanation shown on a card (assistant_actions.explanation CHECK is 300). */
export const MODEL_EXPLANATION_MAX = 300;

export type DraftScreenCode =
  | 'PAYMENT_INSTRUCTIONS'
  | 'HUMAN_CLAIM'
  | 'UNSOURCED_LINK'
  | 'UNSOURCED_PHONE'
  | 'UNSOURCED_EMAIL'
  | 'OBFUSCATED_TEXT'
  | 'MONEY_TOPIC'
  | 'CONTRACT_TOPIC'
  | 'CHANNEL_OVERRIDE'
  | 'TOO_LONG'
  | 'EMPTY';

export interface DraftScreenIssue {
  code: DraftScreenCode;
  /** A short, non-PII detail (a host, a lexicon label, a limit). Never a phone number or address. */
  detail?: string;
}

export interface DraftScreen {
  /** The draft cannot be offered at all (wiring details, empty, too long). */
  blocked: boolean;
  /** Something the agent must check before tapping send. */
  flagged: boolean;
  issues: DraftScreenIssue[];
  /** The server-chosen channel the draft is for (never the model's choice). */
  channel: 'sms' | 'email';
  /** The cleaned draft (null when blocked). The body is the model's text, unchanged apart from trimming. */
  draft: { channel: 'sms' | 'email'; subject: string | null; body: string } | null;
  /** The agent-facing sentence for the card when flagged or blocked (server-written, never the model's). */
  explanation: string | null;
}

const PHONE_G = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const EMAIL_G = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** An email address that is not the userinfo of a URL ("https://team.com@evil.com" is a link to evil.com). */
const STANDALONE_EMAIL_G = /(?<!\/\/\S*)[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

function digits(s: string): string {
  const d = s.replace(/\D/g, '');
  // compare on the national number: "+1 512-555-0100" and "(512) 555-0100" are the same phone
  return d.length > 10 ? d.slice(-10) : d;
}

function sourceCorpus(sources: readonly SourceText[]): string {
  const parts: string[] = [];
  for (const s of sources) {
    if (s.kind === 'text') parts.push(s.text);
    else if (s.kind === 'transcript') for (const seg of s.segments) parts.push(seg.text);
    else for (const v of Object.values(s.fields)) if (v !== null && v !== undefined) parts.push(String(v));
  }
  return foldForDetection(parts.join('\n'));
}

const SENTENCE: Record<DraftScreenCode, string> = {
  PAYMENT_INSTRUCTIONS: 'contained wiring or account details',
  HUMAN_CLAIM: 'signs or speaks as a person',
  UNSOURCED_LINK: 'has a link that is not in the conversation',
  UNSOURCED_PHONE: 'has a phone number that is not in the conversation',
  UNSOURCED_EMAIL: 'has an email address that is not in the conversation',
  OBFUSCATED_TEXT: 'has hidden or look-alike characters',
  MONEY_TOPIC: 'touches price or money',
  CONTRACT_TOPIC: 'touches a contract or agreement',
  CHANNEL_OVERRIDE: 'asked for a different channel',
  TOO_LONG: 'was too long',
  EMPTY: 'was empty',
};

/** The card sentence for a screened draft, in the server's words. */
export function screenExplanation(blocked: boolean, issues: readonly DraftScreenIssue[]): string | null {
  const shown = issues.filter((i) => i.code !== 'CHANNEL_OVERRIDE');
  if (shown.length === 0) return null;
  const what = [...new Set(shown.map((i) => SENTENCE[i.code]))];
  const list = what.length === 1 ? what[0]! : `${what.slice(0, -1).join(', ')} and ${what[what.length - 1]!}`;
  return blocked
    ? `The assistant's suggested reply ${list}, so it was discarded. Nothing was sent.`.slice(0, MODEL_EXPLANATION_MAX)
    : `Check this before sending: the suggested reply ${list}.`.slice(0, MODEL_EXPLANATION_MAX);
}

/**
 * Screens a model draft for the one contact the prompt was built about. `boundChannel` is the channel
 * the server picked; `sources` are the prompt's own sources (what the model was shown).
 */
export function screenModelDraft(i: {
  draft: { channel?: string | undefined; subject?: string | undefined; body: string };
  boundChannel: 'sms' | 'email';
  identity: IdentityFacts;
  sources: readonly SourceText[];
}): DraftScreen {
  const issues: DraftScreenIssue[] = [];
  const add = (code: DraftScreenCode, detail?: string): void => {
    if (!issues.some((x) => x.code === code && x.detail === detail)) issues.push(detail === undefined ? { code } : { code, detail });
  };
  const channel = i.boundChannel;
  const body = i.draft.body.trim();
  if (i.draft.channel !== undefined && i.draft.channel !== channel) add('CHANNEL_OVERRIDE', String(i.draft.channel).slice(0, 16));
  if (body === '') add('EMPTY');
  if (body.length > DRAFT_BODY_MAX[channel]) add('TOO_LONG', String(DRAFT_BODY_MAX[channel]));
  const subjectRaw = channel === 'email' ? (i.draft.subject ?? '').replace(/\s+/g, ' ').trim() : '';
  if (subjectRaw.length > DRAFT_SUBJECT_MAX) add('TOO_LONG', `subject:${DRAFT_SUBJECT_MAX}`);
  const whole = `${subjectRaw}\n${body}`;
  const folded = foldForDetection(whole);
  if (detectPaymentInstructions(whole) || detectPaymentInstructions(folded)) add('PAYMENT_INSTRUCTIONS');
  if (findHumanClaim(whole, i.identity) !== null) add('HUMAN_CLAIM');
  if (isObfuscated(whole)) add('OBFUSCATED_TEXT');
  const corpus = sourceCorpus(i.sources);
  const corpusDigits = new Set([...corpus.matchAll(PHONE_G)].map((m) => digits(m[0])));
  const corpusHosts = new Set(linkHosts(corpus));
  const corpusEmails = new Set([...corpus.matchAll(EMAIL_G)].map((m) => m[0].toLowerCase()));
  // emails first, so the host of an email address is not also reported as a link
  const emails = [...folded.matchAll(STANDALONE_EMAIL_G)].map((m) => m[0].toLowerCase());
  for (const e of emails) if (!corpusEmails.has(e)) add('UNSOURCED_EMAIL');
  const withoutEmails = folded.replace(STANDALONE_EMAIL_G, ' ');
  for (const host of linkHosts(withoutEmails)) {
    if (hostAllowed(host, i.identity.allowedLinkHosts) || corpusHosts.has(host)) continue;
    add('UNSOURCED_LINK', host.replace(/[/?#:].*$/, '').slice(0, 80));
  }
  for (const m of withoutEmails.matchAll(PHONE_G)) if (!corpusDigits.has(digits(m[0]))) add('UNSOURCED_PHONE');
  for (const h of lexiconHits(whole)) add(h.topic === 'money' ? 'MONEY_TOPIC' : 'CONTRACT_TOPIC', h.label);

  const blocked = issues.some((x) => x.code === 'PAYMENT_INSTRUCTIONS' || x.code === 'EMPTY' || x.code === 'TOO_LONG');
  const flagged = !blocked && issues.some((x) => x.code !== 'CHANNEL_OVERRIDE');
  return {
    blocked,
    flagged,
    issues,
    channel,
    draft: blocked ? null : { channel, subject: subjectRaw === '' ? null : subjectRaw, body },
    explanation: screenExplanation(blocked, issues),
  };
}

/**
 * A model explanation as it may appear on a card: one line, no control or format characters, bounded.
 * Returns null when nothing is left. It is shown as plain text (never as a link or markup).
 */
export function cleanModelExplanation(s: string | undefined | null): string | null {
  if (typeof s !== 'string') return null;
  const t = s
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t === '') return null;
  return t.length <= MODEL_EXPLANATION_MAX ? t : `${t.slice(0, MODEL_EXPLANATION_MAX - 1)}…`;
}
