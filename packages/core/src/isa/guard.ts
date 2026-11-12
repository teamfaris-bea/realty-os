// The ISA output guard (R-ISA-7; E506, E509; docs/AI_ISA.md §7.3). Applied to model text (a reply, the summary)
// and, for the identity check, to every composed message. In order:
//   1. screenModelDraft: every flag blocks (UNSOURCED_* too, even when the number appears in the inbound);
//   2. contentGuard (fair housing included) and guardAssistantOutput: any issue, hard or soft, blocks;
//   3. the ISA checks: NUMBER_IN_MODEL_TEXT (digits, number words, "a grand", currency, %), VALUATION_TERM,
//      MARKET_CLAIM, COMPARATIVE_CLAIM, COMMITMENT_TERM, LINK_IN_MODEL_TEXT, AREA_DESCRIPTOR, IDENTITY;
//      AI_IDENTITY_MISSING on a composed message without the platform disclosure (first message) or sign-off.
// On a block the turn sends the class's fixed line (pricing, the area line, or the holding line) or nothing; two
// blocks in a row escalate `uncertain` (the machine counts). Lexicons are data with fixtures. VERIFY WITH COUNSEL.
import { contentGuard, foldForDetection, type IdentityFacts, linkHosts, screenModelDraft, type SourceText } from '../assistant/index.js';
import { DEFAULT_FAIR_HOUSING_PACK, type FairHousingPack, guardAssistantOutput } from '../fairhousing/index.js';
import { SPOKEN_MONEY_RE } from '../voice/lexicon.js';
import { ISA_OUTPUT_LIMITS } from './constants.js';
import { disclosureLine, type LineIdentity, signOffLine } from './lines.js';
import { lowerFold } from './ownText.js';

export const ISA_GUARD_CODES = [
  'SCREEN_FLAG',
  'CONTENT_GUARD',
  'FAIR_HOUSING',
  'NUMBER_IN_MODEL_TEXT',
  'VALUATION_TERM',
  'MARKET_CLAIM',
  'COMPARATIVE_CLAIM',
  'COMMITMENT_TERM',
  'LINK_IN_MODEL_TEXT',
  'AREA_DESCRIPTOR',
  'IDENTITY',
  'AI_IDENTITY_MISSING',
  'TOO_LONG',
  'EMPTY',
] as const;
export type IsaGuardCode = (typeof ISA_GUARD_CODES)[number];

const NUMBER_WORDS =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|dozens?|half|quarter|grand|k)\b/u;

/** The ISA lexicons (§7.3), on folded lower-case text. VERIFY WITH COUNSEL. */
export const ISA_GUARD_LEXICON: Readonly<Record<'VALUATION_TERM' | 'MARKET_CLAIM' | 'COMPARATIVE_CLAIM' | 'COMMITMENT_TERM' | 'AREA_DESCRIPTOR', readonly RegExp[]>> = Object.freeze({
  VALUATION_TERM: [
    /\bworth\b/u,
    /\bvalu(?:e|ed|es|ation|ations)\b/u,
    /\bapprais\w*/u,
    /\bzestimate\b/u,
    /\bcomps?\b|\bcomparables?\b/u,
    /\bprice\s+opinion\b/u,
    /\b(?:will|would|could|should)\s+sell\s+for\b/u,
    /\blist\s+(?:it\s+)?at\b/u,
    /\btop\s+dollar\b/u,
    /\bequity\b/u,
    /\bestimate[sd]?\b/u,
  ],
  MARKET_CLAIM: [
    /\bselling\s+(?:fast|quickly|like\s+hotcakes)\b/u,
    /\bhot\b/u,
    /\bcool(?:ing|ed)\b/u,
    /\bprices\s+(?:are\s+|have\s+been\s+)?(?:rising|falling|going\s+(?:up|down)|dropping|climbing|increasing|decreasing|up|down)\b/u,
    /\bbuyer'?s\s+market\b|\bseller'?s\s+market\b/u,
    /\bgood\s+time\s+to\s+(?:sell|buy|list)\b/u,
    /\bmarket\s+is\s+\w+/u,
    /\binventory\s+is\b/u,
    /\b(?:high|low|strong|weak)\s+demand\b/u,
    // sold-event paraphrases (§6.3: a sale reaches a seller only through the server's comps email, never the model)
    /\b(?:just\s+|recently\s+)?sold\b|\bsales?\s+prices?\b|\bclosed\s+(?:for|at)\b/u,
    /\b(?:more|less)\s+than\s+(?:the\s+)?(?:asking|list(?:ing)?\s+price)\b|\b(?:above|over|under|below)\s+(?:the\s+)?(?:asking|list)\b/u,
  ],
  COMPARATIVE_CLAIM: [
    /\bmore\s+than\s+yours\b/u,
    /\byour\s+(?:home|house|place)\s+(?:would|could|will)\b/u,
    /\b(?:better|best|great|good)\s+value\b/u,
    /\b(?:cheaper|pricier|bigger|smaller|nicer|newer)\s+than\s+(?:yours|your\s+\w+)\b/u,
    /\bcompared\s+(?:to|with)\s+(?:yours|your)\b/u,
    /\b(?:under|over)priced\b/u,
    /\ba\s+steal\b|\bgreat\s+deal\b|\bgood\s+deal\b/u,
  ],
  COMMITMENT_TERM: [
    /\byou(?:'re|\s+are)\s+(?:all\s+)?(?:booked|set|confirmed|scheduled)\b/u,
    /\bi'?ll\s+make\s+sure\b|\bi\s+will\s+make\s+sure\b/u,
    /\bguarantee\w*/u,
    /\bpromis\w*/u,
    /\bwe\s+(?:will|'ll)\s+get\b|\bi\s+(?:will|'ll)\s+get\s+you\b/u,
    /\bconfirmed\s+for\b/u,
    /\b(?:will|'ll)\s+(?:call|text|email)\s+you\s+(?:today|tomorrow|tonight|at|by|in)\b/u,
  ],
  AREA_DESCRIPTOR: [
    /\bsafe(?:ty|st|r)?\b/u,
    /\bfamily[\s-]friendly\b/u,
    /\b(?:good|great|top|best|bad)\s+schools?\b|\bschool\s+district\b/u,
    /\bcrime\b/u,
    /\b(?:type|kind|sort)\s+of\s+(?:people|neighbors|crowd)\b/u,
    /\b(?:good|great|nice|quiet|rough|bad)\s+(?:neighborhood|area|part\s+of\s+town)\b/u,
    /\bup[\s-]and[\s-]coming\b|\bdiverse\b|\bexclusive\b/u,
  ],
});

export interface IsaGuardContext {
  channel: 'sms' | 'email';
  identity: IdentityFacts;
  /** The prompt's own sources (what the model was shown). */
  sources: readonly SourceText[];
  fairHousing?: FairHousingPack;
  /** The summary has its own bound (300). */
  maxLength?: number;
}

export interface IsaGuardResult {
  pass: boolean;
  codes: IsaGuardCode[];
  /** The fixed line a blocked turn may send instead: pricing, the area line, or the holding line. */
  fallback: 'pricing' | 'fair_housing' | 'holding';
}

/** NUMBER_IN_MODEL_TEXT: any digit, number word, "a" amount, currency sign or percent. */
export function hasNumber(text: string): boolean {
  const f = foldForDetection(text);
  const t = lowerFold(text);
  return /\p{Nd}/u.test(f) || /[$€£¥%]|\bpercent\b|\bdollars?\b|\bbucks\b/u.test(t) || NUMBER_WORDS.test(t) || SPOKEN_MONEY_RE.some((re) => re.test(f));
}

/** The ISA guard on model text (R-ISA-7). */
export function isaGuard(text: string, ctx: IsaGuardContext): IsaGuardResult {
  const codes = new Set<IsaGuardCode>();
  const max = ctx.maxLength ?? ISA_OUTPUT_LIMITS.replyMax[ctx.channel];
  const body = text.trim();
  if (body === '') codes.add('EMPTY');
  if (body.length > max) codes.add('TOO_LONG');
  const screen = screenModelDraft({ draft: { body }, boundChannel: ctx.channel, identity: ctx.identity, sources: ctx.sources });
  if (screen.issues.some((i) => i.code !== 'CHANNEL_OVERRIDE')) codes.add('SCREEN_FLAG');
  if (screen.issues.some((i) => i.code === 'HUMAN_CLAIM')) codes.add('IDENTITY');
  const g = contentGuard(body, { channel: ctx.channel, purpose: 'informational', maxLength: max }, ctx.identity, { firstInThread: false, requireSignOff: false, ...(ctx.fairHousing ? { fairHousing: ctx.fairHousing } : {}) });
  for (const i of g.issues) {
    if (i.code === 'FAIR_HOUSING') codes.add('FAIR_HOUSING');
    else if (i.code === 'HUMAN_CLAIM') codes.add('IDENTITY');
    else if (i.code === 'UNKNOWN_LINK') codes.add('LINK_IN_MODEL_TEXT');
    else if (i.code !== 'TOO_LONG' && i.code !== 'EMPTY') codes.add('CONTENT_GUARD');
  }
  const fh = guardAssistantOutput(body, ctx.fairHousing ?? DEFAULT_FAIR_HOUSING_PACK);
  if (fh.hard.length > 0 || fh.soft.length > 0) codes.add('FAIR_HOUSING');
  if (hasNumber(body)) codes.add('NUMBER_IN_MODEL_TEXT');
  const t = lowerFold(foldForDetection(body));
  for (const [code, res] of Object.entries(ISA_GUARD_LEXICON) as [IsaGuardCode, readonly RegExp[]][]) {
    if (res.some((re) => re.test(t))) codes.add(code);
  }
  if (linkHosts(body).length > 0 || /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u.test(t)) codes.add('LINK_IN_MODEL_TEXT');
  const list = [...codes].sort();
  const pricing = list.some((c) => c === 'VALUATION_TERM' || c === 'MARKET_CLAIM' || c === 'COMPARATIVE_CLAIM') || g.category === 'money';
  const area = list.includes('FAIR_HOUSING') || list.includes('AREA_DESCRIPTOR');
  return { pass: list.length === 0, codes: list, fallback: area ? 'fair_housing' : pricing ? 'pricing' : 'holding' };
}

/**
 * AI_IDENTITY_MISSING (R-ISA-7): a composed message must carry the platform sign-off, and the disclosure when it is
 * the first AI message of the thread; both say "AI assistant".
 */
export function aiIdentityMissing(composed: string, who: LineIdentity, firstInThread: boolean): boolean {
  const c = composed.normalize('NFKC');
  if (!c.includes(signOffLine(who))) return true;
  if (firstInThread && !c.includes(disclosureLine(who))) return true;
  return !/\bAI assistant\b/u.test(c);
}
