// What a caller's words may decide, and the extra voice lexicons (R-VOICE-5, R-VOICE-8, R-FH-3,
// R-CONSENT-8).
//
// The caller's words reach a decision ONLY through `callerTurnSignals`, which is the union of:
//   - classifyInbound(text, keywords, 'voice')       opt-outs: core's deterministic classifier, unchanged
//   - topicCategory (core/assistant's money/contract lexicon) and VOICE_SCOPE_LEXICON (price, legal,
//     lending questions, and spoken money amounts)
//   - detectAreaQuestion / areaQuestionPolicy (core/fairhousing)
//   - detectHumanQuestion ("am I talking to a real person?")
//   - the covered-language fact (the STT's language code against the content's languages)
// Everything runs on folded text (foldForDetection), so zero-width characters and look-alike
// letters cannot hide a term. The lexicons are product policy, exported as data with fixtures
// (./testing); counsel may review them with C2 (and C7 for lending and rate wording).
import { foldForDetection, topicCategory } from '../assistant/index.js';
import { type InboundClassification, type Keywords, classifyInbound } from '../compliance/index.js';
import { type AreaQuestionPolicy, areaQuestionPolicy } from '../fairhousing/index.js';
import type { MessageTopic } from './types.js';

export type VoiceScopeTopic = 'price' | 'legal' | 'lending';

export interface VoiceScopeTerm {
  topic: VoiceScopeTopic;
  label: string;
  re: RegExp;
}

const NUMBER_WORD = String.raw`(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|a)`;
const NOT_AREA = String.raw`(?!\s*(?:square|sq\b|sqft|feet|foot|ft\b|acres?|miles?|people|residents|homes|houses|units))`;

/** Spoken money amounts: "$450,000", "450k", "four hundred fifty thousand", "half a million" (R-VOICE-5). */
export const SPOKEN_MONEY_RE: readonly RegExp[] = [
  /\$\s?\d/u,
  /\b\d[\d,.]*\s*(?:k|grand|mil|million|billion|dollars?|bucks)\b/iu,
  new RegExp(String.raw`\b\d[\d,.]*\s*thousand\b${NOT_AREA}`, 'iu'),
  new RegExp(String.raw`\b${NUMBER_WORD}(?:[\s-]+${NUMBER_WORD})*[\s-]+(?:grand|million|billion|dollars?|bucks)\b`, 'iu'),
  new RegExp(String.raw`\b${NUMBER_WORD}(?:[\s-]+${NUMBER_WORD})*[\s-]+thousand\b${NOT_AREA}`, 'iu'),
  /\bhalf\s+a\s+mil(?:lion)?\b/iu,
  /\b(?:dollars?|bucks)\b/iu,
];

export function mentionsMoneyAmount(text: string): boolean {
  const t = foldForDetection(text);
  return SPOKEN_MONEY_RE.some((re) => re.test(t));
}

/** Caller questions outside the assistant's scope that the money/contract lexicon does not already cover. */
export const VOICE_SCOPE_LEXICON: readonly VoiceScopeTerm[] = [
  // price questions (E114): any price talk becomes a message for the agent
  { topic: 'price', label: 'price', re: /\b(?:price[sd]?|pricing|priced)\b/iu },
  { topic: 'price', label: 'how much', re: /\bhow\s+much\b/iu },
  { topic: 'price', label: 'cost', re: /\bcost(?:s|ing)?\b/iu },
  { topic: 'price', label: 'asking', re: /\basking\s+(?:price|for\s+it)\b|\bwhat\s+(?:are|is|['’]?re)?\s*(?:they|the\s+sellers?|the\s+owners?|you)\s+asking\b/iu },
  { topic: 'price', label: 'worth', re: /\bwhat(?:['’]s|\s+is|\s+would\s+be)?\s+(?:it|this|that|the\s+[\p{L}-]+|my\s+[\p{L}-]+|our\s+[\p{L}-]+)\s+worth\b|\bhow\s+much\s+[\p{L}\s]{0,30}worth\b/iu },
  { topic: 'price', label: 'value', re: /\b(?:home|house|property|market)\s+value\b|\bvaluation\b|\bapprais\w*/iu },
  { topic: 'price', label: 'seller would take', re: /\bwhat\s+(?:would|will|might|could)\s+(?:the\s+)?(?:sellers?|owners?|they|he|she)\s+(?:take|accept|settle\s+for|go\s+down\s+to)\b/iu },
  { topic: 'price', label: 'seller would take', re: /\b(?:sellers?|owners?)\s+(?:would|will|might)\s+(?:take|accept|settle)\b/iu },
  { topic: 'price', label: 'deal', re: /\b(?:a\s+)?(?:good|better|best)\s+deal\b/iu },
  // legal
  { topic: 'legal', label: 'lawyer', re: /\b(?:lawyers?|attorneys?|legal(?:ly)?|lawsuits?|liabilit(?:y|ies)|liable)\b/iu },
  { topic: 'legal', label: 'title and liens', re: /\b(?:liens?|easements?|encroachments?|deeds?|probate|title\s+(?:issue|problem|search|insurance|defect)s?)\b/iu },
  { topic: 'legal', label: 'zoning', re: /\b(?:zoning|zoned|variance|permits?\s+(?:issue|problem)s?)\b/iu },
  { topic: 'legal', label: 'tax', re: /\b(?:taxes|tax|taxed|capital\s+gains)\b/iu },
  { topic: 'legal', label: 'tenancy law', re: /\b(?:evict(?:ion|ed|ing)?|tenant(?:'|’)?s?\s+rights|landlord\s+law)\b/iu },
  { topic: 'legal', label: 'disclosure law', re: /\b(?:required|legally)\s+to\s+disclose\b|\bdisclosure\s+laws?\b/iu },
  // lending (C7)
  { topic: 'lending', label: 'mortgage', re: /\b(?:mortgages?|loans?|lenders?|lending|financing|financed|refinanc\w*|refi)\b/iu },
  { topic: 'lending', label: 'pre-approval', re: /\bpre[\s-]?(?:approv\w*|qualif\w*)\b/iu },
  { topic: 'lending', label: 'rates', re: /\b(?:interest|mortgage|current|today(?:'|’)?s|loan|fixed|variable|adjustable)\s+rates?\b|\bAPR\b|\brate\s+lock\b/iu },
  { topic: 'lending', label: 'down payment', re: /\bdown\s+payments?\b|\bdown\s+(?:\d+|five|ten|twenty|three(?:\s+point\s+five)?)\s*(?:%|percent)\b/iu },
  { topic: 'lending', label: 'credit', re: /\bcredit\s+(?:score|check|history|report)s?\b/iu },
  { topic: 'lending', label: 'loan programs', re: /\b(?:FHA|VA\s+loans?|USDA|jumbo|conventional\s+loans?|PMI|points\s+on\s+the\s+loan)\b/iu },
  { topic: 'lending', label: 'monthly payment', re: /\bmonthly\s+payments?\b|\bafford\b|\baffordab\w*/iu },
];

/** "Am I talking to a real person / a robot?" and "you're a person" (E113, R-VOICE-8). */
export const HUMAN_QUESTION_RE: readonly RegExp[] = [
  /\b(?:are|r)\s+(?:you|u|ya)\s+(?:a\s+|an\s+)?(?:real|actual|live|actually\s+a|really\s+a)?\s*(?:person|human|people|robot|bot|machine|computer|ai|a\.i\.|recording|automated|automatic|real|for\s+real|alive)\b/iu,
  /\b(?:am\s+i|i\s+am|i['’]?m)\s+(?:talking|speaking|chatting)\s+(?:to|with)\s+(?:a\s+|an\s+)?(?:real|actual|live)?\s*(?:person|human|robot|bot|machine|computer|ai|recording|someone\s+real|somebody\s+real)\b/iu,
  /\bis\s+(?:this|that|it)\s+(?:a\s+|an\s+)?(?:real\s+person|human|robot|bot|machine|recording|automated|computer|ai)\b/iu,
  /\byou(?:['’]re|\s+are|r)\s+(?:a\s+|an\s+)?(?:real\s+|actual\s+)?(?:person|human|woman|man|guy|lady)\b/iu,
  /\b(?:pretend|act\s+like)\s+(?:you(?:['’]re|\s+are)\s+)?(?:a\s+)?(?:person|human)\b/iu,
  /\b(?:real|live)\s+(?:person|human)\b/iu,
];

export function detectHumanQuestion(text: string): boolean {
  const t = foldForDetection(text);
  return HUMAN_QUESTION_RE.some((re) => re.test(t));
}

export function voiceScopeTopics(text: string): VoiceScopeTopic[] {
  const t = foldForDetection(text);
  const out = new Set<VoiceScopeTopic>();
  for (const term of VOICE_SCOPE_LEXICON) if (term.re.test(t)) out.add(term.topic);
  if (mentionsMoneyAmount(text)) out.add('price');
  return [...out].sort();
}

/** The handback category of an out-of-scope question (E114: price ⇒ money). */
export type ScopeCategory = 'money' | 'contract' | 'legal' | 'lending';

/**
 * Every classifier output a caller turn produces. Two strings with equal signals are
 * indistinguishable to every core/voice decision (the property test proves it).
 */
export interface CallerTurnSignals {
  optOut: InboundClassification;
  /** Uncovered language: the STT's code (when it reports one) is not in the covered set. */
  uncoveredLanguage: boolean;
  humanQuestion: boolean;
  area: AreaQuestionPolicy;
  /** Out-of-scope categories, most specific first (money, contract, legal, lending). */
  scope: ScopeCategory[];
}

export function callerTurnSignals(text: string, i: { keywords: Keywords; language: string | null; coveredLanguages: readonly string[] }): CallerTurnSignals {
  const folded = foldForDetection(text);
  const scope = new Set<ScopeCategory>();
  const lex = topicCategory(text);
  const voice = voiceScopeTopics(text);
  if (lex === 'money' || voice.includes('price')) scope.add('money');
  if (lex === 'contract') scope.add('contract');
  if (voice.includes('legal')) scope.add('legal');
  if (voice.includes('lending')) scope.add('lending');
  const order: readonly ScopeCategory[] = ['money', 'contract', 'legal', 'lending'];
  return {
    optOut: classifyInbound(text, i.keywords, 'voice'),
    uncoveredLanguage: i.language !== null && !i.coveredLanguages.some((l) => languageMatches(l, i.language as string)),
    humanQuestion: detectHumanQuestion(text),
    area: areaQuestionPolicy(folded),
    scope: order.filter((c) => scope.has(c)),
  };
}

/** 'en' covers 'en-US'; comparison is case-insensitive. */
export function languageMatches(covered: string, reported: string): boolean {
  const c = covered.trim().toLowerCase();
  const r = reported.trim().toLowerCase();
  return c !== '' && (r === c || r.startsWith(`${c}-`));
}

/** The message topic recorded for an out-of-scope category. */
export const SCOPE_TOPIC: Readonly<Record<ScopeCategory, MessageTopic>> = { money: 'PRICE', contract: 'CONTRACT', legal: 'LEGAL', lending: 'LENDING' };
