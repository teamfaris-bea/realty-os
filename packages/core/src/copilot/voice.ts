// The draft check (CP-3, CP-4): the owner's voice and the team's content rules, run on every copilot draft,
// model-written or template. Deterministic; a model draft with any issue is replaced by the playbook
// template (and the template itself must pass, which the tests prove for every purpose and channel).
//
// Voice: very short, lead with the answer, "Thank you" at the end, nothing after it (no sign-off, no name,
// no "Best,"). Under three sentences plus the "Thank you" (slipping-lead-recovery "Keep drafts under 3
// sentences"), with a specific next step and a time window.
//
// Rules: no rental wording anywhere; the brokerage name where the draft is marketing (SC advertising rule:
// first contact, and every email); no promises about price, availability or representation; no money or
// contract topics (agents handle those in their own words); no payment instructions; no links; no fair-
// housing hits; no unfilled [slots]; the agent sends it as themselves, so no "AI"/"assistant" wording.
import { foldForDetection, isObfuscated, linkHosts, topicCategory } from '../assistant/index.js';
import { detectPaymentInstructions } from '../compliance/index.js';
import { DEFAULT_FAIR_HOUSING_PACK, guardAssistantOutput } from '../fairhousing/index.js';
import type { DraftIssue } from './types.js';

export const SMS_MAX_CHARS = 320;
export const EMAIL_MAX_CHARS = 700;
export const SUBJECT_MAX_CHARS = 60;
/** sentences before the closing "Thank you" */
export const MAX_SENTENCES = 3;

/** Rental wording: never in any draft (team rule). Matched on folded text, word-bounded. */
export const RENTAL_TERMS: readonly RegExp[] = [
  /\brent(?:s|ed|er|ers|ing|al|als)?\b/iu,
  /\blease(?:s|d|holder)?\b/iu,
  /\bleasing\b/iu,
  /\blandlords?\b/iu,
  /\btenan(?:t|ts|cy)\b/iu,
  /\bproperty\s+manag\w*/iu,
  /\bsublet\w*/iu,
];

/** Promises the playbook forbids: pricing, availability, representation. */
export const PROMISE_TERMS: readonly RegExp[] = [
  /\bguarantee\w*/iu,
  /\bpromise\w*/iu,
  /\b(?:i|we)\s+(?:can|will)\s+(?:get|sell|find)\s+(?:you|it|your)\b/iu,
  /\b(?:still|is|are)\s+available\b/iu,
  /\bwill\s+(?:sell|appraise)\s+(?:for|at|fast|quickly)\b/iu,
  /\bworth\s+(?:at\s+least|over|about|around)?\s*\$?\d/iu,
  /\b(?:i|we)(?:'|’)?(?:ll| will)\s+represent\b/iu,
  /\bexclusive(?:ly)?\s+represent\w*/iu,
];

const SIGN_OFF_RE = /\b(?:best(?:\s+regards)?|kind\s+regards|regards|sincerely|cheers|warmly|talk\s+soon|thanks\s+again)\s*[,!.]?\s*$|^\s*[-—–]\s*\S/imu;
const THANK_YOU_END_RE = /thank\s+you[.!]?\s*$/iu;
const AI_WORDING_RE = /\b(?:as\s+an\s+ai|ai\s+assistant|language\s+model|chatbot|virtual\s+assistant|the\s+assistant)\b/iu;
const SLOT_RE = /\[[^\]\n]{1,40}\]|\{[^}\n]{1,40}\}|<[^>\n]{1,40}>/u;
const TIME_WINDOW_RE =
  /\b(?:today|tonight|tomorrow|this\s+(?:morning|afternoon|evening|week|weekend)|next\s+(?:week|\d+\s+minutes)|in\s+the\s+next\s+\d+\s+minutes|\d+\s+minutes|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this\s+month)\b/iu;

/** Sentences before the closing "Thank you" (abbreviations like "St." are rare in two-line texts). */
export function countSentences(body: string): number {
  const t = body.replace(THANK_YOU_END_RE, '').trim();
  if (t === '') return 0;
  return t.split(/(?<=[.!?])\s+/u).filter((s) => /\p{L}/u.test(s)).length;
}

export interface VoiceCheckInput {
  channel: 'sms' | 'email';
  text: string;
  subject: string | null;
  marketing: boolean;
  brokerageName: string;
}

export function checkDraft(d: VoiceCheckInput): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const add = (code: DraftIssue['code'], detail: string): void => {
    if (!issues.some((i) => i.code === code)) issues.push({ code, detail });
  };
  const raw = d.text.trim();
  if (raw === '') return [{ code: 'EMPTY', detail: 'no text' }];
  const all = `${d.subject ?? ''}\n${raw}`;
  if (isObfuscated(all)) add('OBFUSCATED_TEXT', 'invisible or look-alike characters');
  const t = foldForDetection(raw);
  const both = foldForDetection(all);

  const max = d.channel === 'sms' ? SMS_MAX_CHARS : EMAIL_MAX_CHARS;
  if (raw.length > max) add('TOO_LONG', `${raw.length} > ${max} characters`);
  if (d.subject !== null && d.subject.length > SUBJECT_MAX_CHARS) add('TOO_LONG', `subject over ${SUBJECT_MAX_CHARS} characters`);
  if (countSentences(t) > MAX_SENTENCES) add('TOO_MANY_SENTENCES', `more than ${MAX_SENTENCES} sentences`);
  if (!/thank\s+you/iu.test(t)) add('MISSING_THANK_YOU', 'no "Thank you"');
  else if (!THANK_YOU_END_RE.test(t)) add('SIGN_OFF_PRESENT', 'text after "Thank you"');
  if (SIGN_OFF_RE.test(t.replace(THANK_YOU_END_RE, '').trim())) add('SIGN_OFF_PRESENT', 'sign-off line');
  for (const re of RENTAL_TERMS) if (re.test(both)) add('RENTAL_WORDING', 'rental wording');
  if (d.marketing && !foldForDetection(all).toLowerCase().includes(foldForDetection(d.brokerageName).toLowerCase())) {
    add('MISSING_BROKERAGE_NAME', 'brokerage name required on marketing');
  }
  if (!TIME_WINDOW_RE.test(t)) add('MISSING_TIME_WINDOW', 'no next step with a time window');
  for (const re of PROMISE_TERMS) if (re.test(both)) add('PROMISE', 'pricing, availability or representation promise');
  if (topicCategory(both) !== null) add('MONEY_OR_CONTRACT', 'money or contract topic');
  if (detectPaymentInstructions(all)) add('PAYMENT_INSTRUCTIONS', 'payment instructions');
  if (linkHosts(all).length > 0 || /\bwww\.|https?:/iu.test(both)) add('LINK', 'links are added by the agent, not the copilot');
  if (SLOT_RE.test(all)) add('UNFILLED_SLOT', 'placeholder left in the text');
  if (AI_WORDING_RE.test(both)) add('AI_DISCLOSURE', 'the agent sends this as themselves');
  const fh = guardAssistantOutput(both, DEFAULT_FAIR_HOUSING_PACK);
  if (fh.checkThis) add('FAIR_HOUSING', 'fair-housing term');
  return issues;
}
