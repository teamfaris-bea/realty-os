import { describe, expect, it } from 'vitest';
import { GUARD_LEXICON, contentGuard, findHumanClaim, hostAllowed, lexiconHits, linkHosts, topicCategory } from './guard.js';
import { LEXICON_NEGATIVES, LEXICON_POSITIVES, agentIdentity, teamIdentity } from './testing/fixtures.js';

const team = teamIdentity();
const smsStep = { channel: 'sms' as const, purpose: 'informational' as const, maxLength: 320 };
const SIGN = '— the Smith Team assistant';
const ok = (body: string) => `${body}\n${SIGN}`;

describe('content guard lexicon (R-AST-3, E35)', () => {
  it.each(LEXICON_POSITIVES.map((p) => [p.text, p.category] as const))('R-AST-3 zero false negatives: %j ⇒ %s', (text, category) => {
    expect(topicCategory(text)).toBe(category);
    const g = contentGuard(ok(text), smsStep, team);
    expect(g.pass).toBe(false);
    expect(g.category).toBe(category);
    expect(g.issues.some((i) => i.code === (category === 'money' ? 'MONEY_TOPIC' : 'CONTRACT_TOPIC') || i.code === 'PAYMENT_INSTRUCTIONS')).toBe(true);
  });

  it('R-AST-3 every lexicon term is exercised by at least one positive fixture', () => {
    const covered = new Set(LEXICON_POSITIVES.flatMap((p) => lexiconHits(p.text).map((h) => h.label)));
    for (const t of GUARD_LEXICON) expect(covered, t.label).toContain(t.label);
  });

  it.each(LEXICON_NEGATIVES)('ordinary copy is not flagged as money/contract: %j', (text) => {
    expect(topicCategory(text)).toBeNull();
    expect(lexiconHits(text)).toEqual([]);
  });

  it('R-GATE-7 payment instructions are a hard block for every initiator, and money', () => {
    const g = contentGuard(ok('Wire funds to account 12345678, routing 021000021.'), smsStep, team);
    expect(g.hardBlock).toBe(true);
    expect(g.category).toBe('money');
    expect(g.issues.map((i) => i.code)).toContain('PAYMENT_INSTRUCTIONS');
    expect(topicCategory('IBAN: DE89 3704 0044 0532 0130 00')).toBe('money');
  });

  it('money wins over contract when both appear', () => {
    expect(topicCategory('Your offer is in the contract.')).toBe('money');
    expect(contentGuard(ok('Your offer is in the contract.'), smsStep, team).category).toBe('money');
  });
});

describe('human claims (R-AST-11)', () => {
  it.each([
    'Hi Jane, this is Sarah! Got a minute?',
    'Hey, it’s Sarah from the Smith Team.',
    "I'm Sarah and I'd love to help.",
    'My name is Sarah Smith.',
    'Hi Jane, Sarah here. Quick question.',
    'Sarah here! Quick question.',
    'Talk soon — Sarah',
    'Thanks, Sarah',
    'I am a real person, promise.',
    "Don't worry, I'm not a bot.",
    "I'm human!",
    "You're talking to Mike.",
  ])('R-AST-11 rejects the first-person human claim %j', (text) => {
    expect(findHumanClaim(text, agentIdentity())).not.toBeNull();
    expect(contentGuard(ok(text), smsStep, team).issues.map((i) => i.code)).toContain('HUMAN_CLAIM');
  });

  it.each([
    "Hi Jane, this is Sarah's assistant.",
    'Hi Jane, it’s Sarah’s assistant here.',
    'This is the Smith Team assistant.',
    "This is Sarah, well, Sarah's virtual assistant.".replace("Sarah, well, Sarah's", "Sarah's"),
    'This is Acme Realty LLC.',
    'This is Smith Team calling about your search.',
    'It’s Thursday, so here are new homes.',
    "I'm happy to help!",
    'Click here to see photos.',
    'Hi Jane, Sarah here — Sarah’s assistant, that is.',
    '— Sarah’s assistant',
    'Sarah asked me to check in. — Sarah’s assistant',
  ])('R-AST-11 allows %j', (text) => {
    expect(findHumanClaim(text, agentIdentity())).toBeNull();
  });
});

describe('identity, links and length (R-AST-11, R-GATE-12)', () => {
  it('R-AST-11 a missing sign-off is flagged; the dash style does not matter', () => {
    expect(contentGuard('Hi Jane!', smsStep, team).issues.map((i) => i.code)).toEqual(['MISSING_SIGN_OFF']);
    expect(contentGuard('Hi Jane!\n- the Smith Team assistant', smsStep, team).pass).toBe(true);
    expect(contentGuard('Hi Jane!\n— Sarah’s assistant', smsStep, agentIdentity()).pass).toBe(true);
    expect(contentGuard('Hi Jane!', smsStep, team, { firstInThread: false, requireSignOff: false }).pass).toBe(true);
  });

  it('R-AST-11 the first SMS in a thread needs the STOP hint and the brokerage name', () => {
    const codes = contentGuard(ok('Hi Jane!'), smsStep, team, { firstInThread: true }).issues.map((i) => i.code);
    expect(codes).toEqual(['MISSING_OPT_OUT_HINT', 'MISSING_BROKERAGE_NAME']);
    expect(contentGuard(`${ok('Hi Jane!')}\nAcme Realty LLC · Reply STOP to opt out`, smsStep, team, { firstInThread: true }).pass).toBe(true);
    // email has no SMS STOP hint requirement, but still the brokerage name
    expect(contentGuard(ok('Hi Jane!'), { ...smsStep, channel: 'email' }, team, { firstInThread: true }).issues.map((i) => i.code)).toEqual(['MISSING_BROKERAGE_NAME']);
  });

  it('R-GATE-12 every marketing message must render the brokerage legal name', () => {
    const mk = { ...smsStep, purpose: 'marketing' as const };
    expect(contentGuard(ok('New homes for you!'), mk, team).issues.map((i) => i.code)).toEqual(['MISSING_BROKERAGE_NAME']);
    expect(contentGuard(`${ok('New homes for you!')}\nAcme Realty LLC`, mk, team).pass).toBe(true);
  });

  it('flags links to unknown hosts and allows the team’s own', () => {
    expect(contentGuard(ok('See https://smithteam.com/homes/12'), smsStep, team).pass).toBe(true);
    expect(contentGuard(ok('See www.smithteam.com'), smsStep, team).pass).toBe(true);
    expect(contentGuard(ok('See https://listings.smithteam.com/x'), smsStep, team).pass).toBe(true);
    const bad = contentGuard(ok('See bit.ly/abc and https://evil.example.org/x?y=1 or zillow.com'), smsStep, team);
    expect(bad.issues.filter((i) => i.code === 'UNKNOWN_LINK').map((i) => i.detail)).toEqual(['bit.ly', 'evil.example.org', 'zillow.com']);
    expect(linkHosts('mail jane@acme.com, e.g. tomorrow')).toEqual([]);
    expect(hostAllowed('notsmithteam.com', ['smithteam.com'])).toBe(false);
    expect(hostAllowed('x.com', [''])).toBe(false);
  });

  it('flags empty text, over-long text and unfilled slots', () => {
    expect(contentGuard('  ', smsStep, team, { firstInThread: false, requireSignOff: false }).issues.map((i) => i.code)).toEqual(['EMPTY']);
    expect(contentGuard(ok('x'.repeat(400)), smsStep, team).issues).toEqual([{ code: 'TOO_LONG', detail: '320' }]);
    expect(contentGuard(ok('Hi {{first_name}}'), smsStep, team).issues.map((i) => i.code)).toEqual(['UNFILLED_SLOT']);
  });

  it('a clean autonomous message passes', () => {
    const g = contentGuard(ok('Hi Jane! Are you still thinking about a move this spring?'), smsStep, team);
    expect(g).toEqual({ pass: true, issues: [], hardBlock: false, category: null, checkThis: false });
  });
});

describe('guard edge cases', () => {
  it('11-digit numbers starting with 1 are phone numbers; other long digit runs are account numbers', () => {
    expect(topicCategory('Call 15125550100 anytime')).toBeNull();
    expect(topicCategory('Ref 25125550100')).toBe('money');
  });

  it('without an agent first name only the generic human-claim checks apply; duplicate issues are reported once', () => {
    expect(findHumanClaim('Talk soon — Sarah', teamIdentity({ agentFirstName: null }))).toBeNull();
    const g = contentGuard(ok('See bit.ly/a and bit.ly/a'), smsStep, team);
    expect(g.issues).toEqual([{ code: 'UNKNOWN_LINK', detail: 'bit.ly' }]);
  });
});
