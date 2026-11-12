// Deterministic inbound signals and the escalation taxonomy (R-ISA-6; E500–E507, E529, E530; docs/AI_ISA.md §4.4).
//
// Signals run on each inbound's CLIENT OWN TEXT (./ownText.ts) before any model call. Every lexicon goes through the
// shared negation window ("please don't call me" is not a human_request; "not working with a realtor yet" is not
// other_agent). Classes 15 (pricing_negotiation) and 16 (financial) fire ONLY on request or question frames: a topic
// term in a statement ("our budget is around 450k", "we're preapproved", "50k for a down payment") is qualification
// input, never an escalation. A model `escalate` may add a class, never remove one (the machine unions them).
//
// Precedence: rows 1–9 are stop classes; the slot choice (row 10) runs after them and before every other class.
// The lexicons are product policy exported as data with fixtures (./testing/fixtures.ts). VERIFY WITH COUNSEL
// (C-ISA-6, C-ISA-12) every list.
import { type InboundClassification } from '../compliance/index.js';
import { foldForDetection, lexiconHits } from '../assistant/index.js';
import { DEFAULT_FAIR_HOUSING_PACK, type FairHousingPack, check as fairHousingCheck, detectAreaQuestion } from '../fairhousing/index.js';
import { HUMAN_QUESTION_RE } from '../voice/lexicon.js';
import type { IsaLineId } from './lines.js';
import { lowerFold, negatedBefore } from './ownText.js';
import { ESCALATION_CLASSES, type EscalationClass, type EscalationPriority, type EscalationType } from './types.js';

export interface EscalationRow {
  type: EscalationType;
  priority: EscalationPriority;
  /** The fixed client line, sent only when the send checks pass now; null = nothing is sent. */
  line: IsaLineId | null;
  /** Whether the end sets a person block (§5.1). */
  block: boolean;
}

/** The §4.4 table: one row per class. */
export const ESCALATION_TABLE: Readonly<Record<EscalationClass, EscalationRow>> = Object.freeze({
  opt_out: { type: 'terminal', priority: 'normal', line: null, block: true },
  wrong_number: { type: 'terminal', priority: 'normal', line: null, block: true },
  possible_opt_out: { type: 'terminal', priority: 'critical', line: null, block: true },
  safety: { type: 'terminal', priority: 'critical', line: 'safety', block: false },
  fraud_risk: { type: 'terminal', priority: 'critical', line: 'fraud_risk', block: false },
  consent_dispute: { type: 'terminal', priority: 'critical', line: null, block: true },
  privacy_request: { type: 'terminal', priority: 'high', line: 'privacy_request', block: false },
  ai_declined: { type: 'terminal', priority: 'normal', line: 'ai_declined', block: true },
  complaint: { type: 'terminal', priority: 'critical', line: 'complaint', block: true },
  human_request: { type: 'terminal', priority: 'critical', line: 'human_request', block: false },
  fair_housing: { type: 'terminal', priority: 'high', line: 'fair_housing', block: false },
  legal_contract: { type: 'terminal', priority: 'high', line: 'legal_contract', block: false },
  third_party: { type: 'terminal', priority: 'high', line: 'third_party', block: false },
  other_agent: { type: 'check_this', priority: 'high', line: null, block: false },
  pricing_negotiation: { type: 'hold_topic', priority: 'high', line: 'pricing', block: false },
  financial: { type: 'hold_topic', priority: 'high', line: 'financial', block: false },
  sensitive_personal: { type: 'terminal', priority: 'high', line: 'sensitive_personal', block: false },
  language: { type: 'terminal', priority: 'normal', line: 'language', block: false },
  data_unavailable: { type: 'hold_topic', priority: 'normal', line: 'data_unavailable', block: false },
  booking_unavailable: { type: 'hold_topic', priority: 'high', line: 'booking_unavailable', block: false },
  uncertain: { type: 'terminal', priority: 'normal', line: 'uncertain', block: false },
  limit: { type: 'terminal', priority: 'low', line: null, block: false },
  flood: { type: 'terminal', priority: 'low', line: null, block: false },
});

/** Rows 1–9: the stop classes, which win over a slot choice. */
export const STOP_CLASSES: ReadonlySet<EscalationClass> = new Set<EscalationClass>(ESCALATION_CLASSES.slice(0, ESCALATION_CLASSES.indexOf('human_request') + 1));

/** The precedence rank (lower wins). */
export function precedence(c: EscalationClass): number {
  return ESCALATION_CLASSES.indexOf(c);
}

/** The winning class of a set, or null. */
export function topClass(classes: Iterable<EscalationClass>): EscalationClass | null {
  let best: EscalationClass | null = null;
  for (const c of classes) if (best === null || precedence(c) < precedence(best)) best = c;
  return best;
}

/** Limit and flood go high when an inbound is unanswered (§4.4 row 22). */
export function escalationPriority(c: EscalationClass, inboundUnanswered: boolean): EscalationPriority {
  if ((c === 'limit' || c === 'flood') && inboundUnanswered) return 'high';
  return ESCALATION_TABLE[c].priority;
}

// ---- lexicons -------------------------------------------------------------------------------------------------

export interface SignalTerm {
  re: RegExp;
  /** Whether a negation before the match cancels it. False when the pattern itself carries the negation. */
  negatable: boolean;
}

const t = (re: RegExp, negatable = true): SignalTerm => ({ re, negatable });

/** Lexicon-driven classes (the rest come from the classification, the machine or the model). VERIFY WITH COUNSEL. */
export const SIGNAL_LEXICON: Readonly<Partial<Record<EscalationClass, readonly SignalTerm[]>>> = Object.freeze({
  possible_opt_out: [
    t(/\btoo\s+many\s+(?:texts?|messages?|emails?)\b/u),
    t(/\b(?:text|message|email)(?:s|ing)?\s+(?:me\s+)?(?:way\s+)?too\s+(?:much|often)\b/u),
    t(/\bunsubscrib\w*/u),
    t(/\b(?:stop|quit)\s+(?:texting|messaging|emailing|contacting|bugging|bothering|spamming)\b/u),
    t(/\bleave\s+me\s+alone\b/u),
    t(/\b(?:this\s+is\s+)?spam(?:ming)?\b/u),
    t(/\bhow\s+do\s+i\s+(?:stop\s+(?:this|these|them)|opt\s*out)\b/u),
    t(/\btake\s+me\s+off\b/u),
  ],
  safety: [
    t(/\b(?:kill|hurt|harm)\s+(?:myself|me|you|him|her|them|someone|somebody)\b/u),
    t(/\bsuicid\w*/u, false),
    t(/\bwant\s+to\s+die\b/u),
    t(/\bend\s+(?:my\s+life|it\s+all)\b/u),
    t(/\b(?:i'?ll|i\s+will|gonna|going\s+to)\s+(?:kill|shoot|stab|hurt)\b/u),
    t(/\b(?:someone|somebody)\s+(?:is\s+)?(?:breaking|broke)\s+in\b/u),
    t(/\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+in\s+danger\b/u),
    t(/\bnot\s+safe\s+at\s+home\b/u, false),
  ],
  fraud_risk: [
    t(/\bwir(?:e|es|ed|ing)\b/u, false),
    t(/\bsend\s+(?:the\s+|my\s+|our\s+)?(?:deposit|earnest\s+money|down\s+payment|funds|money|payment)\s+to\b/u, false),
    t(/\b(?:new|different|updated|changed)\s+(?:bank\s+)?(?:account|routing|wiring\s+instructions|payment\s+instructions)\b/u, false),
    t(/\b(?:account|acct|routing|aba)\s*(?:number|num|no\.?|#)/u, false),
    t(/\b(?:zelle|venmo|cash\s*app|gift\s+cards?|bitcoin|crypto)\b/u, false),
  ],
  consent_dispute: [
    t(/\bhow\s+did\s+you\s+get\s+(?:my|this)\s+(?:number|email|e-mail|info|information|contact|details)\b/u, false),
    t(/\bwhere\s+did\s+you\s+get\s+(?:my|this)\b/u, false),
    t(/\bwho\s+gave\s+you\s+(?:my|this)\b/u, false),
    t(/\bi\s+(?:never|didn'?t|did\s+not)\s+(?:sign\s+up|signed\s+up|give\s+you|gave\s+you|agree|agreed|opt\s+in|opted\s+in|ask|asked|request|requested|fill\s+out|filled\s+out)\b/u, false),
  ],
  privacy_request: [
    t(/\b(?:delete|erase|remove|purge)\s+(?:all\s+)?(?:of\s+)?(?:my|our)\s+(?:data|info|information|details|records?|account|personal\s+\w+)\b/u),
    t(/\bwhat\s+(?:info|information|data|details)\s+do\s+you\s+have\s+(?:on|about)\s+(?:me|us)\b/u),
    t(/\bwhat\s+do\s+you\s+(?:have|know)\s+(?:on|about)\s+me\b/u),
    t(/\b(?:ccpa|cpra|gdpr|right\s+to\s+(?:delete|know|be\s+forgotten))\b/u, false),
    t(/\bdo\s+not\s+sell\s+my\b/u, false),
  ],
  ai_declined: [
    t(/\b(?:don'?t|do\s+not)\s+want\s+to\s+(?:text|talk|chat|speak|deal|message)\s+(?:with|to)\s+(?:a\s+|an\s+|the\s+|your\s+)?(?:bot|robot|ai|a\.i\.|machine|computer|automated\s+\w+|assistant)\b/u, false),
    t(/\bno\s+(?:more\s+)?(?:bots?|robots?|ai)\b/u, false),
    t(/\bnot\s+(?:talking|texting|chatting)\s+(?:to|with)\s+(?:a\s+|an\s+)?(?:bot|robot|ai|machine)\b/u, false),
    t(/\b(?:i\s+)?(?:hate|refuse\s+to\s+talk\s+to)\s+(?:bots?|robots?|ai)\b/u),
    t(/\b(?:stop|quit)\s+(?:the\s+)?(?:bot|robot|ai)\b/u, false),
  ],
  complaint: [
    t(/\b(?:complain\w*|complaint)\b/u),
    t(/\b(?:bad|terrible|awful|horrible|negative|one[\s-]star|1[\s-]star)\s+review\b/u),
    t(/\b(?:leave|write|post|give)\s+(?:you\s+)?(?:a\s+)?(?:bad\s+|negative\s+|terrible\s+)?review\b/u),
    t(/\breport\s+(?:you|this|your)\b/u),
    t(/\b(?:better\s+business\s+bureau|bbb|real\s+estate\s+commission|licensing\s+board)\b/u),
    t(/\b(?:unprofessional|harass\w*)\b/u),
  ],
  human_request: [
    t(/\b(?:talk|speak|chat)\s+(?:to|with)\s+(?:a\s+|an\s+|the\s+)?(?:real|actual|live)?\s*(?:person|human|agent|realtor|someone|somebody|man|woman)\b/u),
    t(/\b(?:want|need|would\s+like|'d\s+like|get\s+me|give\s+me)\s+(?:a\s+|an\s+)?(?:real|actual|live)\s+(?:person|human|agent)\b/u),
    t(/\bhave\s+[\p{L}'-]+\s+(?:call|text|phone|email|contact)\s+(?:me|us)\b/u),
    t(/\b(?:please\s+)?(?:call|phone)\s+(?:me|us)\b/u),
    t(/\b(?:can|could|will|would)\s+(?:[\p{L}'-]+\s+){0,2}(?:call|reach|phone)\s+(?:me|us)\b/u),
    t(/^\s*agent\s*[.!]*\s*$/u, false),
  ],
  legal_contract: [
    t(/\b(?:listing|buyer(?:'?s)?|representation|purchase|sales?)\s+agreements?\b/u),
    t(/\bdisclosures?\b/u),
    t(/\binspect(?:ion|ions|or)\b/u),
    t(/\btitle\b/u),
    t(/\b(?:attorneys?|lawyers?|legal(?:ly)?)\b/u),
    t(/\bcontracts?\b/u),
  ],
  third_party: [
    t(/\b(?:this\s+is|i'?m|i\s+am)\s+(?:his|her|their)\s+(?:husband|wife|spouse|partner|son|daughter|mother|father|mom|dad|brother|sister|assistant|friend|caretaker|caregiver|neighbor)\b/u, false),
    t(/\b(?:replying|responding|texting|writing|answering)\s+(?:for|on\s+behalf\s+of)\s+(?:my|his|her|their)\b/u, false),
    t(/\bon\s+behalf\s+of\s+(?:my|his|her|their)\b/u, false),
    t(/\b(?:he|she)\s+(?:asked|wanted)\s+me\s+to\s+(?:reply|respond|text|answer)\b/u, false),
  ],
  other_agent: [
    t(/\b(?:my|our)\s+(?:own\s+)?(?:agent|realtor|broker|listing\s+agent|buyer'?s\s+agent)\b/u),
    t(/\balready\s+(?:listed|working|signed)\s+with\b/u),
    t(/\b(?:working|signed|going)\s+with\s+(?:a|an|another|our|my|a\s+different)\s+(?:agent|realtor|broker|brokerage)\b/u),
    t(/\b(?:we|i)\s+(?:have|got)\s+(?:an?\s+)?(?:agent|realtor)\b/u),
    t(/\blisted\s+(?:it\s+)?with\s+(?:another|a\s+different|an?)\b/u),
  ],
  sensitive_personal: [
    t(/\b(?:divorc\w*|separat(?:ed|ion|ing))\b/u, false),
    t(/\b(?:passed\s+away|died|death|funeral|widow\w*|estate\s+of\s+my)\b/u, false),
    t(/\bforeclos\w*/u, false),
    t(/\bbankrupt\w*/u, false),
    t(/\b(?:cancer|chemo\w*|terminal(?:ly)?\s+ill|diagnos\w*|hospital\w*|surgery|illness)\b/u, false),
    t(/\b(?:disab\w*|wheelchair)\b/u, false),
    t(/\b(?:immigra\w*|green\s+card|deport\w*|citizenship|work\s+visa)\b/u, false),
    t(/\b(?:military\s+orders|pcs\s+orders|deploy(?:ed|ment|ing)|stationed)\b/u, false),
    t(/\bpregnan\w*/u, false),
    t(/\b(?:lost\s+(?:my|our)\s+job|laid\s+off|unemploy\w*)\b/u, false),
  ],
});

/**
 * Topic terms of the request-frame classes. A term alone is a statement (qualification input); only a request or
 * question frame (`REQUEST_FRAMES`, or a question clause holding the term) escalates.
 */
export const TOPIC_TERMS: Readonly<Record<'pricing_negotiation' | 'financial', RegExp>> = Object.freeze({
  pricing_negotiation:
    /\b(?:worth|valu(?:e|ed|ation)|list(?:ing)?\s+(?:price|at|it\s+at|for)|asking\s+price|price[ds]?|pricing|take\s+(?:less|lower)|accept\s+(?:less|lower)|negotiat\w*|commissions?|fees?|zestimate|apprais\w*|sell\s+(?:it\s+)?for|(?:make|put\s+in|submit)\s+an?\s+offer|offer\s+(?:on|for|under|over|below|above|price|amount)|counter\w*)\b/u,
  financial:
    /\b(?:rates?|interest|afford\w*|down\s*payments?|down\b|lenders?|loans?|mortgages?|earnest\s+money|closing\s+costs?|credit\s+scores?|pre[\s-]?approv\w*|pre[\s-]?qualif\w*|fha|va\s+loans?|pmi|monthly\s+payments?)\b/u,
});

/** Explicit request frames (§4.4), on folded lower-case own text. */
export const REQUEST_FRAMES: Readonly<Record<'pricing_negotiation' | 'financial', readonly RegExp[]>> = Object.freeze({
  pricing_negotiation: [
    /\bwhat(?:'s|\s+is|\s+would\s+be)?\s+(?:it|my\s+(?:home|house|place)|our\s+(?:home|house|place)|the\s+(?:home|house))\s+worth\b/u,
    /\bwhat\s+(?:should|would|could)\s+(?:i|we)\s+(?:list|price|sell)\b/u,
    /\bwould\s+(?:they|the\s+sellers?|the\s+owners?)\s+(?:take|accept|go)\b/u,
    /\bshould\s+(?:i|we)\s+(?:offer|counter|make\s+an?\s+offer|put\s+in\s+an?\s+offer|negotiate|go\s+(?:lower|higher))\b/u,
    /\bhow\s+much\s+(?:is|are|would|could|can|will|should)\s+(?:it|my|our|the|this|that|we|i)\b[^.?!]{0,40}\b(?:worth|sell|get|list|offer|go\s+for)\b/u,
    /\b(?:can|could|will)\s+(?:you|they)\s+(?:get|negotiate)\s+(?:them|the\s+sellers?|a\s+(?:lower|better)\s+price)\b/u,
    /\bwhat(?:'s|\s+is|\s+are)\s+(?:your|the)\s+(?:commission|fees?|rate)\b/u,
  ],
  financial: [
    /\bhow\s+much\s+(?:house\s+)?can\s+(?:we|i)\s+afford\b/u,
    /\bwhat(?:'s|\s+is|\s+are)\s+(?:the|a|current|today'?s)\s+(?:interest\s+|mortgage\s+)?rates?\b/u,
    /\b(?:can|could)\s+you\s+(?:get|find|recommend|refer)\s+(?:me|us)\s+(?:to\s+)?an?\s+(?:lender|loan\s+officer|mortgage\s+broker)\b/u,
    /\bhow\s+much\s+(?:down|should\s+(?:we|i)\s+put\s+down|do\s+(?:we|i)\s+need\s+(?:to\s+put\s+)?down)\b/u,
    /\bdo\s+you\s+know\s+(?:a|any)\s+(?:good\s+)?(?:lenders?|loan\s+officers?)\b/u,
    /\bwhat\s+(?:would|will)\s+(?:my|our|the)\s+(?:monthly\s+)?payments?\s+be\b/u,
  ],
});

/** Clauses of a text that are questions: split on sentence ends and commas, keep those ending in "?". */
export function questionClauses(text: string): string[] {
  const out: string[] = [];
  for (const sentence of lowerFold(text).split(/(?<=[.!?])\s+|\n+/u)) {
    if (!sentence.trim().endsWith('?')) continue;
    const parts = sentence.split(/,|;|\band\b|\bbut\b|\bso\b/u);
    const last = parts.pop() ?? '';
    out.push(last.trim());
  }
  return out;
}

/** A request or question frame on one of the two frame-only classes (E504: statements never escalate). */
export function requestFrame(text: string, cls: 'pricing_negotiation' | 'financial'): boolean {
  const t = lowerFold(text);
  if (REQUEST_FRAMES[cls].some((re) => re.test(t))) return true;
  return questionClauses(text).some((q) => TOPIC_TERMS[cls].test(q));
}

const ASK_FRAME = /\b(?:can|could|should|do|does|did|will|would|is|are)\s+(?:you|we|i|they|it|there)\b|\b(?:help\s+(?:me|us)|explain|tell\s+(?:me|us)|look\s+(?:at|over)|review|send\s+(?:me|us))\b/u;

/**
 * Row 12: a contract or legal topic (core/assistant's CONTRACT_TOPIC plus agreements, disclosures, inspections,
 * title and attorneys) inside a sentence that is a question or an ask. "We had the inspection" is not one.
 */
export function legalRequest(text: string): boolean {
  for (const sentence of lowerFold(text).split(/(?<=[.!?])\s+|\n+/u)) {
    const topic = lexiconHits(sentence).some((h) => h.topic === 'contract') || lexiconMatches(sentence, 'legal_contract');
    if (topic && (sentence.trim().endsWith('?') || ASK_FRAME.test(sentence))) return true;
  }
  return false;
}

/** Whether a term matches anywhere it is not negated. */
function termHit(text: string, term: SignalTerm): boolean {
  const g = new RegExp(term.re.source, `${term.re.flags.replace('g', '')}g`);
  for (const m of text.matchAll(g)) {
    if (!term.negatable || !negatedBefore(text.slice(0, m.index))) return true;
  }
  return false;
}

/** Whether any term of `cls` matches the own text. */
export function lexiconMatches(text: string, cls: EscalationClass): boolean {
  const terms = SIGNAL_LEXICON[cls];
  if (terms === undefined) return false;
  const t = lowerFold(text);
  return terms.some((term) => termHit(t, term));
}

// ---- language -------------------------------------------------------------------------------------------------

/** Common function words of languages the AI does not cover (VERIFY). A message dominated by them is `language`. */
const OTHER_LANGUAGE_WORDS = new Set(
  [
    'hola', 'gracias', 'quiero', 'busco', 'casa', 'estoy', 'para', 'pero', 'porque', 'usted', 'necesito', 'cuando', 'donde', 'tengo', 'puedo', 'vender', 'comprar', 'buenos', 'dias', 'señor', 'señora', 'favor', 'muy', 'bien', 'sí', 'como',
    'bonjour', 'merci', 'maison', 'vendre', 'acheter', 'je', 'nous', 'vous', 'avec', 'pour', 'oui',
    'obrigado', 'obrigada', 'quero', 'comprar', 'você', 'não',
  ].map((w) => w.normalize('NFKC')),
);

/**
 * An uncovered language (§4.2: English only). True when most letters are in a non-Latin script, or at least two
 * words and at least half of the words are from the uncovered-language list. Conservative: a name or a single
 * borrowed word ("casa") is not a language switch.
 */
export function uncoveredLanguage(text: string): boolean {
  const letters = [...text.normalize('NFKC')].filter((c) => /\p{L}/u.test(c));
  if (letters.length >= 4) {
    const nonLatin = letters.filter((c) => !/\p{Script=Latin}/u.test(c)).length;
    if (nonLatin / letters.length > 0.5) return true;
  }
  const ws = lowerFold(text).split(/[^\p{L}]+/u).filter((w) => w.length > 1);
  if (ws.length === 0) return false;
  const other = ws.filter((w) => OTHER_LANGUAGE_WORDS.has(w)).length;
  return other >= 2 && other * 2 >= ws.length;
}

// ---- the signals of one inbound ---------------------------------------------------------------------------------

export interface InboundSignals {
  /** Every escalation class the own text raises (sorted by precedence). */
  classes: EscalationClass[];
  /** "Is this a real person?" (care continues with the truthful line). Never set when human_request is. */
  botQuestion: boolean;
  /** A short acknowledgement ("thanks", "ok", a reaction) that does not cancel a post-handoff message (§4.7). */
  acknowledgementOnly: boolean;
  /** The verbatim own-text span that raised the top class, when a lexicon did (for the handoff quote). */
  trigger: 'classification' | 'lexicon' | 'frame' | 'area' | 'fair_housing' | 'language' | null;
}

const ACK_RE = /^\s*(?:thanks?(?:\s+you)?|thank\s+u|thx|ty|ok(?:ay)?|k|kk|great|perfect|sounds\s+good|got\s+it|cool|awesome|will\s+do|see\s+you\s+then|👍|🙏|😊|🙂|❤️|yes\s+thanks?)[\s.!]*(?:👍|🙏|😊|🙂)?\s*$/u;

export function isAcknowledgementOnly(ownText: string, reaction: boolean): boolean {
  return reaction || ACK_RE.test(lowerFold(ownText));
}

/**
 * Every signal of one inbound's own text (R-ISA-6). `classification` is compliance's `classifyInbound` of the
 * same message (STOP, opt-out language, wrong number); its opt-outs are row 1.
 */
export function inboundSignals(i: { ownText: string; classification: InboundClassification; reaction?: boolean; fairHousing?: FairHousingPack }): InboundSignals {
  const own = foldForDetection(i.ownText);
  const classes = new Set<EscalationClass>();
  let trigger: InboundSignals['trigger'] = null;
  const kind = i.classification.kind;
  if (kind === 'stop' || kind === 'opt_out_language') classes.add('opt_out');
  if (kind === 'wrong_number') classes.add('wrong_number');
  if (classes.size > 0) trigger = 'classification';
  for (const cls of ESCALATION_CLASSES) {
    if (cls === 'legal_contract') continue; // frame-only below
    if (lexiconMatches(own, cls)) classes.add(cls);
  }
  // legal and contract topics escalate only in a request frame (a question or an ask)
  if (legalRequest(own)) classes.add('legal_contract');
  if (requestFrame(own, 'pricing_negotiation')) classes.add('pricing_negotiation');
  if (requestFrame(own, 'financial')) classes.add('financial');
  if (detectAreaQuestion(own) !== null || fairHousingCheck(own, i.fairHousing ?? DEFAULT_FAIR_HOUSING_PACK).hard.length > 0) classes.add('fair_housing');
  if (uncoveredLanguage(i.ownText)) classes.add('language');
  const sorted = [...classes].sort((a, b) => precedence(a) - precedence(b));
  if (trigger === null && sorted.length > 0) {
    const top = sorted[0] as EscalationClass;
    trigger = top === 'pricing_negotiation' || top === 'financial' ? 'frame' : top === 'fair_housing' ? 'fair_housing' : top === 'language' ? 'language' : 'lexicon';
  }
  const humanQ = HUMAN_QUESTION_RE.some((re) => re.test(own));
  return {
    classes: sorted,
    botQuestion: humanQ && !classes.has('human_request'),
    acknowledgementOnly: isAcknowledgementOnly(i.ownText, i.reaction === true),
    trigger,
  };
}
