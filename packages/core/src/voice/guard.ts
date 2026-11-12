// The voice turn guard (R-VOICE-5, R-VOICE-8, R-AST-3, R-AST-11, R-FH-2).
//
// Every model turn passes here before it is spoken; a turn that fails is never spoken (the policy
// machine says VOICE_LINES.replacement instead). It is core/assistant's content guard minus the
// text-only checks (sign-off, STOP hint, brokerage name, links, length, slots), plus spoken money
// amounts and the voice legal/lending lexicon:
//   PAYMENT_INSTRUCTIONS   hard block (R-GATE-7)
//   MONEY_TOPIC            the money lexicon, a spoken amount ("four fifty k"), or a lending term
//                          (detail `lending:<label>`) ⇒ category money (R-VOICE-5)
//   CONTRACT_TOPIC         the contract lexicon, or a legal term (detail `legal:<label>`) ⇒ contract
//   HUMAN_CLAIM            findHumanClaim with the tenant's identity (R-AST-11, R-VOICE-8)
//   OBFUSCATED_TEXT        invisible characters or look-alike letters (every check runs folded)
//   FAIR_HOUSING           a hard or soft match of the pack in force (R-FH-2)
//   EMPTY
// GuardIssueCode is module 25's closed union, so legal and lending reuse the two topic codes with a
// prefixed detail rather than adding codes to a file this lane does not own.
import { type GuardIssue, type GuardIssueCode, type GuardResult, type IdentityFacts, findHumanClaim, foldForDetection, isObfuscated, lexiconHits } from '../assistant/index.js';
import { detectPaymentInstructions } from '../compliance/index.js';
import { DEFAULT_FAIR_HOUSING_PACK, type FairHousingPack, guardAssistantOutput } from '../fairhousing/index.js';
import { VOICE_SCOPE_LEXICON, mentionsMoneyAmount } from './lexicon.js';

export function voiceTurnGuard(text: string, identity: IdentityFacts, fairHousing: FairHousingPack = DEFAULT_FAIR_HOUSING_PACK): GuardResult {
  const issues: GuardIssue[] = [];
  const add = (code: GuardIssueCode, detail?: string): void => {
    if (!issues.some((i) => i.code === code && i.detail === detail)) issues.push(detail === undefined ? { code } : { code, detail });
  };
  const folded = foldForDetection(text);
  if (folded.trim() === '') add('EMPTY');
  const payment = detectPaymentInstructions(text) || detectPaymentInstructions(folded);
  if (payment) add('PAYMENT_INSTRUCTIONS');
  for (const h of lexiconHits(text)) add(h.topic === 'money' ? 'MONEY_TOPIC' : 'CONTRACT_TOPIC', h.label);
  if (mentionsMoneyAmount(text)) add('MONEY_TOPIC', 'spoken amount');
  for (const term of VOICE_SCOPE_LEXICON) {
    if (!term.re.test(folded)) continue;
    if (term.topic === 'legal') add('CONTRACT_TOPIC', `legal:${term.label}`);
    else add('MONEY_TOPIC', `${term.topic}:${term.label}`);
  }
  const human = findHumanClaim(text, identity);
  if (human !== null) add('HUMAN_CLAIM', human);
  if (isObfuscated(text)) add('OBFUSCATED_TEXT');
  const fh = guardAssistantOutput(text, fairHousing);
  for (const m of [...fh.hard, ...fh.soft]) add('FAIR_HOUSING', m.termId);
  const money = payment || issues.some((i) => i.code === 'MONEY_TOPIC');
  const contract = issues.some((i) => i.code === 'CONTRACT_TOPIC');
  return { pass: issues.length === 0, issues, hardBlock: payment, category: money ? 'money' : contract ? 'contract' : null, checkThis: fh.checkThis };
}
