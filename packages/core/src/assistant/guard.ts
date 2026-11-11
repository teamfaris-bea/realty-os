// The content guard (R-AST-3, R-AST-11, R-GATE-7, R-GATE-12; E35, E64).
//
// Every assistant-produced text passes here before it can go out on its own: playbook steps at
// send time, the 60-second first response, and drafts (where the result decides whether a human
// tap is needed and how the card explains it). It is deterministic and errs towards a human tap:
// a false positive costs the agent one tap; a false negative can put words in their mouth about
// money or a contract.
//
//   PAYMENT_INSTRUCTIONS   wire/routing/account/IBAN/SWIFT details: hard-blocked for everyone (R-GATE-7)
//   MONEY_TOPIC            price negotiation, offers/counters, commission, earnest money, wires,
//                          account numbers  ⇒ category `money`, never autonomous (R-AST-3)
//   CONTRACT_TOPIC         contracts, addenda, agreements, contingencies, signatures ⇒ `contract`
//   HUMAN_CLAIM            "this is Sarah", "Sarah here", "— Sarah", "I'm a real person" unless the
//                          words go on to say it is the assistant (R-AST-11)
//   MISSING_SIGN_OFF       no "— the {Team} assistant" / "— {Agent}'s assistant" (R-AST-11)
//   MISSING_OPT_OUT_HINT   first SMS in a thread without "Reply STOP to opt out" (R-AST-11)
//   MISSING_BROKERAGE_NAME first message in a thread, or any marketing message, without the
//                          brokerage legal name (R-AST-11, R-GATE-12)
//   UNKNOWN_LINK           a link to a host that is not one of the team's own (userinfo and ports
//                          are stripped, so "https://team.com@evil.com" is evil.com)
//   OBFUSCATED_TEXT        invisible format characters or look-alike letters mixed into Latin
//                          words: the text is never sent unseen, and every check above runs on the
//                          folded text so "of\u200Bfer" or a Cyrillic "о" cannot hide a term
//   FAIR_HOUSING           a hard or soft match of the fair-housing pack (core/fairhousing): never
//                          autonomous; the draft is flagged "Check this" (R-FH-2, module 25)
//   TOO_LONG / EMPTY / UNFILLED_SLOT
//
// The lexicon below is product policy, exported as data so it can be reviewed and tested; the
// fixture set in ./testing proves zero false negatives on it.
import { type ActionCategory, type Channel, type Purpose, containsName, containsOptOutHint, detectPaymentInstructions } from '../compliance/index.js';
import { DEFAULT_FAIR_HOUSING_PACK, type FairHousingPack, guardAssistantOutput } from '../fairhousing/index.js';
import { normalizeForQuote } from './evidence.js';
import { signOffFor } from './render.js';
import type { IdentityFacts } from './types.js';

export type GuardIssueCode =
  | 'EMPTY'
  | 'PAYMENT_INSTRUCTIONS'
  | 'MONEY_TOPIC'
  | 'CONTRACT_TOPIC'
  | 'HUMAN_CLAIM'
  | 'MISSING_SIGN_OFF'
  | 'MISSING_OPT_OUT_HINT'
  | 'MISSING_BROKERAGE_NAME'
  | 'UNKNOWN_LINK'
  | 'TOO_LONG'
  | 'UNFILLED_SLOT'
  | 'OBFUSCATED_TEXT'
  | 'FAIR_HOUSING';

export interface GuardIssue {
  code: GuardIssueCode;
  /** The matched term, link host or limit (ids and policy terms only; never PII). */
  detail?: string;
}

export interface GuardResult {
  /** True when the text may go out without a human tap. */
  pass: boolean;
  issues: GuardIssue[];
  /** PAYMENT_INSTRUCTIONS: nobody may send it from here, with or without a tap. */
  hardBlock: boolean;
  /** The always-human category the text belongs to, when the lexicon says so. */
  category: Extract<ActionCategory, 'money' | 'contract'> | null;
  /** A fair-housing match: the draft card says "Check this" (R-FH-2). */
  checkThis: boolean;
}

/** The parts of a playbook step the guard needs (PlaybookStep satisfies it). */
export interface GuardStep {
  channel: Extract<Channel, 'sms' | 'email'> | 'inbound_channel' | 'web_chat';
  purpose: Purpose;
  maxLength: number;
}

export interface GuardContext {
  /** Whether this is the first assistant message in the thread (R-AST-11). */
  firstInThread: boolean;
  /** Autonomous messages must carry the sign-off. Default true. */
  requireSignOff?: boolean;
  /** The fair-housing pack in force (default: the built-in, unreviewed `fh/1`). Never switched off. */
  fairHousing?: FairHousingPack;
}

// ---- folding (anti-obfuscation) -------------------------------------------------------------------

/** Look-alike Cyrillic/Greek letters → the Latin letter they imitate (detection only). */
const CONFUSABLES: Readonly<Record<string, string>> = {
  '\u0430': 'a', '\u0432': 'b', '\u0435': 'e', '\u0451': 'e', '\u0456': 'i', '\u0457': 'i', '\u0458': 'j', '\u043A': 'k', '\u043C': 'm', '\u043D': 'h', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0442': 't', '\u0443': 'y', '\u0445': 'x', '\u0455': 's', '\u0501': 'd', '\u04CF': 'l', '\u051B': 'q', '\u051D': 'w', '\u04BB': 'h',
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041A': 'K', '\u041C': 'M', '\u041D': 'H', '\u041E': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T', '\u0425': 'X', '\u0423': 'Y', '\u0406': 'I', '\u0408': 'J', '\u0405': 'S',
  '\u03B1': 'a', '\u03BF': 'o', '\u03B5': 'e', '\u03B9': 'i', '\u03BA': 'k', '\u03BD': 'v', '\u03C1': 'p', '\u03C4': 't', '\u03C5': 'u', '\u03C7': 'x',
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H', '\u0399': 'I', '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O', '\u03A1': 'P', '\u03A4': 'T', '\u03A5': 'Y', '\u03A7': 'X',
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'gu');
const INVISIBLE_RE = /\p{Default_Ignorable_Code_Point}/gu;
/** Invisible characters that ordinary emoji use (ZWJ sequences, variation selectors). */
function isEmojiJoiner(ch: string): boolean {
  const cp = ch.codePointAt(0) as number;
  return cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f);
}

/**
 * The text every guard check runs on: NFKC, invisible format characters removed, look-alike
 * letters mapped to Latin. Detection only; the stored text is never rewritten.
 */
export function foldForDetection(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE_RE, '').replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] as string);
}

/** Invisible format characters (other than emoji joiners) or a word mixing Latin with look-alikes. */
export function isObfuscated(text: string): boolean {
  const t = text.normalize('NFKC');
  for (const m of t.matchAll(INVISIBLE_RE)) if (!isEmojiJoiner(m[0])) return true;
  for (const m of t.matchAll(/[\p{L}\p{M}]+/gu)) {
    const w = m[0];
    if (/\p{Script=Latin}/u.test(w) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(w)) return true;
  }
  return false;
}

// ---- lexicon ------------------------------------------------------------------------------------

export interface LexiconTerm {
  topic: 'money' | 'contract';
  label: string;
  re: RegExp;
}

export const GUARD_LEXICON: readonly LexiconTerm[] = [
  // price negotiation
  { topic: 'money', label: 'negotiation', re: /\bnegotiat\w*/iu },
  { topic: 'money', label: 'price change request', re: /\b(?:lower|drop|reduce|cut|come\s+down\s+on|bring\s+down|knock\s+(?:down|off))\s+(?:the\s+|your\s+|their\s+|our\s+|its\s+)?(?:list(?:ing)?\s+|asking\s+|sale\s+|sales\s+)?(?:price|asking)\b/iu },
  { topic: 'money', label: 'negotiable', re: /\b(?:price|asking)\s+(?:is\s+)?(?:negotiable|firm|flexible)\b/iu },
  { topic: 'money', label: 'asking-price position', re: /\b(?:below|under|over|above|at|full)\s+(?:the\s+)?asking\b/iu },
  { topic: 'money', label: 'best and final', re: /\b(?:highest\s+and\s+best|best\s+and\s+final|best\s+price|bottom\s+line|lowest\s+(?:they|you|she|he)(?:'|’)?(?:d|ll)?\s+(?:take|go|accept))\b/iu },
  { topic: 'money', label: 'take less', re: /\b(?:willing|open)\s+to\s+(?:take|accept|go)\s+(?:less|lower|down)\b|\baccept\s+less\b/iu },
  { topic: 'money', label: 'price reduction', re: /\bprice\s+(?:reduction|cut|negotiation)s?\b/iu },
  // a number proposed as a price ("would they take 450k?", "accept $450,000", "come down to 440")
  {
    topic: 'money',
    label: 'price proposal',
    re: /\b(?:accept|take|settle\s+for|go\s+(?:as\s+low\s+as|as\s+high\s+as|down\s+to|up\s+to)|come\s+(?:down|up)\s+to|pay|do)\s+(?:(?:only|just|about|around|maybe|like|roughly)\s+)?(?:\$\s?\d[\d,.]*|\d[\d,.]*\s*(?:k|mm?|thousand|million|grand)\b|\d{3,}(?:,\d{3})*\b)/iu,
  },
  // offers and counters
  { topic: 'money', label: 'offer', re: /\boffers?\b|\boffered\b|\boffering\b/iu },
  { topic: 'money', label: 'counter', re: /\bcounter(?:[- ]?offers?|ed|ing)?\b/iu },
  { topic: 'money', label: 'bid', re: /\bbid(?:s|ding)?\b/iu },
  { topic: 'money', label: 'escalation', re: /\bescalation\s+clause\b/iu },
  // commission and compensation
  { topic: 'money', label: 'commission', re: /\bcommissions?\b/iu },
  { topic: 'money', label: 'agent compensation', re: /\b(?:buyer(?:'|’)?s?\s+agent|agent|broker|brokerage|listing)\s+(?:fee|fees|compensation|split)\b|\bcompensation\b/iu },
  { topic: 'money', label: 'concession', re: /\bconcessions?\b|\b(?:closing[- ]cost|seller)\s+credits?\b|\brebates?\b/iu },
  // earnest money and deposits
  { topic: 'money', label: 'earnest money', re: /\bearnest\s+money\b|\bEMD\b|\b(?:escrow|good[- ]faith)\s+deposit\b|\boption\s+(?:fee|money)\b/iu },
  // wires and accounts
  { topic: 'money', label: 'wire', re: /\bwir(?:e|es|ed|ing)\b/iu },
  { topic: 'money', label: 'account details', re: /\b(?:account|acct|routing|aba)\s*(?:number|num|no\.?|#)/iu },
  { topic: 'money', label: 'account number', re: /(?<![\d-])\d{8,17}(?![\d-])/u },
  // contracts
  { topic: 'contract', label: 'contract', re: /\bcontract(?:s|ed|ual)?\b/iu },
  { topic: 'contract', label: 'addendum', re: /\baddend(?:um|a|ums)\b|\bamendments?\b/iu },
  { topic: 'contract', label: 'agreement', re: /\b(?:purchase|sales?|listing|buyer(?:'|’)?s?(?:\s+(?:representation|broker(?:age)?|agency))?|representation|exclusive\s+right(?:\s+to\s+sell)?)\s+agreements?\b/iu },
  { topic: 'contract', label: 'contingency', re: /\bcontingen(?:cy|cies|t)\b/iu },
  { topic: 'contract', label: 'signature', re: /\b(?:docusign|dotloop|e-?sign(?:ature)?|sign(?:ing)?\s+(?:the\s+)?(?:papers|paperwork|documents|docs|agreement|offer|disclosures?))\b/iu },
  { topic: 'contract', label: 'termination', re: /\bterminat(?:e|ion|ing)\b|\bbreach\b|\bcancel(?:l?ing|l?ation)?\s+(?:the\s+)?(?:deal|sale|purchase)\b/iu },
  { topic: 'contract', label: 'option period', re: /\boption\s+period\b|\binspection\s+(?:response|objection|amendment)\b/iu },
];

/** Phone numbers are not account numbers: 10 digits, or 11 starting with 1. */
function isPhoneDigits(d: string): boolean {
  return d.length === 10 || (d.length === 11 && d.startsWith('1'));
}

export interface LexiconHit {
  topic: 'money' | 'contract';
  label: string;
}

/** Every lexicon term the text mentions. */
export function lexiconHits(text: string): LexiconHit[] {
  const t = foldForDetection(text);
  const hits: LexiconHit[] = [];
  for (const term of GUARD_LEXICON) {
    if (term.label === 'account number') {
      const re = new RegExp(term.re.source, 'gu');
      if ([...t.matchAll(re)].some((m) => !isPhoneDigits(m[0]))) hits.push({ topic: term.topic, label: term.label });
      continue;
    }
    if (term.re.test(t)) hits.push({ topic: term.topic, label: term.label });
  }
  return hits;
}

/**
 * The always-human category a text falls in (E35: a client asking about price or an offer makes
 * the reply a `money` draft). Money wins over contract when both appear (both always need a tap).
 */
export function topicCategory(text: string): 'money' | 'contract' | null {
  const hits = lexiconHits(text);
  if (detectPaymentInstructions(foldForDetection(text)) || hits.some((h) => h.topic === 'money')) return 'money';
  if (hits.some((h) => h.topic === 'contract')) return 'contract';
  return null;
}

// ---- human claims -------------------------------------------------------------------------------

const NOT_A_PERSON = new Set(
  [
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
    'a', 'an', 'the', 'here', 'there', 'just', 'so', 'not', 'also', 'still', 'really', 'very', 'happy', 'glad', 'sorry',
    'great', 'good', 'ok', 'okay', 'quick', 'your', 'our', 'my', 'all', 'about', 'back', 'available', 'free', 'done',
  ].map((w) => w.toLowerCase()),
);
const HERE_NOT_A_NAME = new Set(['click', 'tap', 'look', 'right', 'over', 'out', 'start', 'sign', 'reply', 'text', 'info', 'details', 'more', 'everything', 'listing', 'photos', 'link', 'go', 'see', 'come', 'stop', 'help']);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionsAssistantRightAfter(rest: string): boolean {
  return /^\s*(?:['’]s)?(?:\s*,)?\s+(?:[\p{L}'’-]+\s+){0,4}assistant\b/iu.test(rest);
}

function startsWithIdentityName(name: string, id: IdentityFacts): boolean {
  const n = name.toLowerCase();
  return [id.teamName, id.brokerageLegalName].some((x) => x.trim() !== '' && (n.startsWith(x.toLowerCase()) || x.toLowerCase().startsWith(n)));
}

/** First-person human claims (R-AST-11). Returns the offending phrase kind, or null. */
export function findHumanClaim(text: string, id: IdentityFacts): string | null {
  const t = foldForDetection(text);
  if (/\b(?:i\s+am|i['’]m)\s+(?:a\s+|an\s+)?(?:real|actual|live)\s+(?:person|human|agent)\b/iu.test(t)) return 'real person';
  if (/\b(?:i\s+am|i['’]m)\s+(?:a\s+)?human\b/iu.test(t)) return 'human';
  if (/\bnot\s+(?:a\s+|an\s+)?(?:bot|robot|machine|computer|ai|automated|automatic)\b/iu.test(t)) return 'not a bot';

  const intro = /(?:\b(?:[Tt]his\s+is|[Ii]t['’]?s|[Ii]t\s+is|I['’]m|I\s+am|[Mm]y\s+name\s+is|[Yy]ou['’]re\s+(?:talking|chatting)\s+(?:to|with)))\s+((?:\p{Lu}[\p{L}'’.-]*)(?:\s+\p{Lu}[\p{L}'’.-]*){0,2})/gu;
  for (const m of t.matchAll(intro)) {
    const name = m[1] as string;
    const first = (name.split(/\s+/)[0] as string).replace(/['’]s$/u, '').toLowerCase();
    if (NOT_A_PERSON.has(first)) continue;
    if (startsWithIdentityName(name, id)) continue;
    const rest = t.slice((m.index as number) + m[0].length);
    const possessive = /['’]s$/u.test(name);
    if (possessive ? /^\s+(?:[\p{L}'’-]+\s+){0,4}assistant\b/iu.test(rest) : mentionsAssistantRightAfter(rest)) continue;
    return 'introduces as a person';
  }

  const here = /(?:^|[.!?,;]\s+|\n\s*|(?:hi|hey|hello)\s+[\p{L}'’-]+[,!]?\s+)(\p{Lu}[\p{L}'’-]+)\s+here\b/gu;
  for (const m of t.matchAll(here)) {
    const w = (m[1] as string).toLowerCase();
    if (HERE_NOT_A_NAME.has(w) || NOT_A_PERSON.has(w)) continue;
    const rest = t.slice((m.index as number) + m[0].length);
    if (/^\s*(?:[,—–-]\s*)?(?:[\p{L}'’-]+\s+){0,4}assistant\b/iu.test(rest)) continue;
    return 'name here';
  }

  if (id.agentFirstName !== null && id.agentFirstName.trim() !== '') {
    const n = escapeRe(id.agentFirstName.trim());
    const signedAsAgent = new RegExp(`(?:^|\\s)(?:[—–~]|-{1,2})\\s*${n}\\b(?!['’]s\\s+(?:[\\p{L}'’-]+\\s+){0,3}assistant)`, 'iu');
    const closing = new RegExp(`\\b(?:thanks|thank\\s+you|best|cheers|regards|talk\\s+soon|xo|sincerely)[,!.]?\\s+${n}\\s*[.!]?\\s*(?:$|\\n)`, 'iu');
    // the agent's name alone on a line ("Talk then!\nSarah")
    const bareLine = new RegExp(`(?:^|\\n)[ \\t]*${n}[ \\t]*[.!]?[ \\t]*(?:\\n|$)`, 'iu');
    if (signedAsAgent.test(t) || closing.test(t) || bareLine.test(t)) return 'signed as the agent';
    // the agent's name in any letter case after an intro ("hey its sarah", "i'm sarah")
    const lowerIntro = new RegExp(
      `\\b(?:this\\s+is|it['’]?s|it\\s+is|i['’]?m|i\\s+am|my\\s+name\\s+is|you['’]re\\s+(?:talking|chatting)\\s+(?:to|with))\\s+${n}\\b(?!['’]s)`,
      'giu',
    );
    for (const m of t.matchAll(lowerIntro)) {
      if (!mentionsAssistantRightAfter(t.slice((m.index as number) + m[0].length))) return 'introduces as a person';
    }
    // "sarah here", "Hi Jane, Sarah from the Smith Team"
    const lowerHere = new RegExp(`\\b${n}\\s+here\\b`, 'giu');
    for (const m of t.matchAll(lowerHere)) {
      if (!/^\s*(?:[,—–-]\s*)?(?:[\p{L}'’-]+\s+){0,4}assistant\b/iu.test(t.slice((m.index as number) + m[0].length))) return 'name here';
    }
    const fromTeam = new RegExp(`(?:^|[.!?;]\\s+|\\n\\s*|\\b(?:hi|hey|hello)\\b[^.!?\\n]{0,40}?[,!]\\s*)${n}\\s+(?:from|with|at)\\s+`, 'iu');
    if (fromTeam.test(t)) return 'introduces as a person';
  }
  return null;
}

// ---- links --------------------------------------------------------------------------------------

/** A URL with a scheme; group 1 is the authority (userinfo, host and port). */
const SCHEME_URL_RE = /\b[a-z][a-z0-9+.-]{1,15}:\/\/([^\s/?#\\<>"'’)\]]*)/giu;
/**
 * A bare host ("evil.shop/x", "www.team.com", "bit.ly"): dot-separated labels ending in a 2–24
 * letter TLD, not part of an email address. Any TLD counts: phones auto-link far more than a
 * fixed list, and a false positive only costs a tap.
 */
const BARE_HOST_RE = /(?<![@\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?![\w-]|@|\.[a-z0-9])/giu;

function hostOfAuthority(authority: string): string {
  const afterUser = authority.slice(authority.lastIndexOf('@') + 1);
  return afterUser.replace(/:\d*$/, '').replace(/[.,!?;:]+$/, '').toLowerCase();
}

/**
 * Hosts of every link-like token in the text (lower-cased, without scheme, userinfo or port), in
 * order of appearance. Runs on the folded text, so look-alike letters cannot hide a host.
 */
export function linkHosts(text: string): string[] {
  const t = foldForDetection(text);
  const found: { at: number; host: string }[] = [];
  let rest = t;
  for (const m of t.matchAll(SCHEME_URL_RE)) {
    const host = hostOfAuthority(m[1] as string);
    found.push({ at: m.index as number, host: host === '' ? '(no host)' : host });
    const i = m.index as number;
    rest = rest.slice(0, i) + ' '.repeat(m[0].length) + rest.slice(i + m[0].length);
  }
  for (const m of rest.matchAll(BARE_HOST_RE)) found.push({ at: m.index as number, host: m[0].toLowerCase() });
  return found.sort((a, b) => a.at - b.at).map((f) => f.host);
}

export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.replace(/^www\./, '');
  return allowed.some((a) => {
    const x = a.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    return x !== '' && (h === x || h.endsWith(`.${x}`));
  });
}

// ---- the guard ----------------------------------------------------------------------------------

export function contentGuard(text: string, step: GuardStep, tenant: IdentityFacts, ctx: GuardContext = { firstInThread: false }): GuardResult {
  const issues: GuardIssue[] = [];
  const add = (code: GuardIssueCode, detail?: string): void => {
    if (!issues.some((i) => i.code === code && i.detail === detail)) issues.push(detail === undefined ? { code } : { code, detail });
  };
  if (text.trim() === '') add('EMPTY');
  const payment = detectPaymentInstructions(text) || detectPaymentInstructions(foldForDetection(text));
  if (payment) add('PAYMENT_INSTRUCTIONS');
  const hits = lexiconHits(text);
  for (const h of hits) add(h.topic === 'money' ? 'MONEY_TOPIC' : 'CONTRACT_TOPIC', h.label);
  const human = findHumanClaim(text, tenant);
  if (human !== null) add('HUMAN_CLAIM', human);
  if (ctx.requireSignOff ?? true) {
    const signOff = normalizeForQuote(signOffFor(tenant)).text.replace(/^-\s*/, '');
    if (!normalizeForQuote(text).text.includes(signOff)) add('MISSING_SIGN_OFF');
  }
  if (step.channel === 'sms' && ctx.firstInThread && !containsOptOutHint(text, 'sms')) add('MISSING_OPT_OUT_HINT');
  if ((ctx.firstInThread || step.purpose === 'marketing') && !containsName(text, tenant.brokerageLegalName)) add('MISSING_BROKERAGE_NAME');
  for (const host of linkHosts(text)) if (!hostAllowed(host, tenant.allowedLinkHosts)) add('UNKNOWN_LINK', host.replace(/[/?#:].*$/, ''));
  if (text.length > step.maxLength) add('TOO_LONG', String(step.maxLength));
  if (/\{\{[^}]*\}\}/.test(text)) add('UNFILLED_SLOT');
  if (isObfuscated(text)) add('OBFUSCATED_TEXT');
  const fh = guardAssistantOutput(text, ctx.fairHousing ?? DEFAULT_FAIR_HOUSING_PACK);
  for (const m of [...fh.hard, ...fh.soft]) add('FAIR_HOUSING', m.termId);
  const category = payment || hits.some((h) => h.topic === 'money') ? 'money' : hits.some((h) => h.topic === 'contract') ? 'contract' : null;
  return { pass: issues.length === 0, issues, hardBlock: payment, category, checkThis: fh.checkThis };
}
