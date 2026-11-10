// Routing-rule editor helpers: the form ↔ the API body (R-OWN-10 rule shape as the server stores it)
// and the plain description. The server re-validates everything (api/admin routing.test.ts).
import { describe, expect, it } from 'vitest';
import { centsToDollars, dollarsToCents, formatDuration, parseZips } from './format.js';
import { describeMatch, describeStrategy, emptyRuleForm, formOf, formProblems, matchOf, membersBody, moved, ruleBody } from './routing.js';
import type { RoutingRule } from './types.js';

const rule: RoutingRule = {
  id: 'r1',
  position: 1,
  name: 'Zillow buyers',
  match: { sources: ['s1'], lead_types: ['buy'], zips: ['94110', '94112'], price_min: 50_000_000, price_max: 90_000_000 },
  strategy: 'weighted',
  directUserId: null,
  targetPondId: null,
  fallbackPondId: 'p1',
  offerWindowSeconds: 300,
  maxOffers: 2,
  enabled: true,
  archived: false,
  version: 4,
  members: [
    { userId: 'u1', weight: 3 },
    { userId: 'u2', weight: 1 },
  ],
};

describe('routing rule form', () => {
  it('round-trips a stored rule: snake_case match, prices in cents, offer window in seconds', () => {
    const f = formOf(rule);
    expect(f.priceMin).toBe('500000');
    expect(f.offerWindowMinutes).toBe('5');
    expect(matchOf(f)).toEqual(rule.match);
    expect(ruleBody(f)).toEqual({ name: 'Zillow buyers', match: rule.match, strategy: 'weighted', directUserId: null, targetPondId: null, fallbackPondId: 'p1', offerWindowSeconds: 300, maxOffers: 2, enabled: true });
    expect(membersBody(f)).toEqual(rule.members);
  });

  it('empty filters mean "every lead" and are left out of match; only the chosen strategy carries its target', () => {
    const f = { ...emptyRuleForm(), name: 'All', strategy: 'direct' as const, directUserId: 'u1', targetPondId: 'p9' };
    expect(ruleBody(f)).toMatchObject({ match: {}, directUserId: 'u1', targetPondId: null, offerWindowSeconds: null, maxOffers: null });
    expect(membersBody(f)).toEqual([]);
    expect(membersBody({ ...f, strategy: 'round_robin', members: new Map([['u1', 7]]) })).toEqual([{ userId: 'u1', weight: 1 }]);
  });

  it('says what is missing or malformed before sending', () => {
    expect(formProblems(emptyRuleForm())).toEqual(['Give the rule a name.', 'Pick at least one person to offer leads to.']);
    expect(formProblems({ ...emptyRuleForm(), name: 'x', strategy: 'pond' })).toEqual(['Pick the pond these leads go to.']);
    expect(formProblems({ ...emptyRuleForm(), name: 'x', strategy: 'direct' })).toEqual(['Pick the person who gets these leads.']);
    const bad = { ...emptyRuleForm(), name: 'x', members: new Map([['u', 1]]), zips: '9411, 94110', priceMin: '900000', priceMax: '100000', offerWindowMinutes: '0', maxOffers: '11' };
    expect(formProblems(bad)).toEqual(['ZIP codes must be 5 digits (or ZIP+4).', 'The lowest price must not be above the highest.', 'The offer window must be 1 to 1440 minutes.', 'Offers before falling back must be 1 to 10.']);
    expect(formProblems({ ...emptyRuleForm(), name: 'x', members: new Map([['u', 1]]), priceMin: 'abc' })).toEqual(['Prices must be whole dollar amounts.']);
  });

  it('describes a rule in plain words', () => {
    const names = (id: string) => ({ u1: 'Ava', u2: 'Ben', s1: 'Zillow', p1: 'Team pond' })[id] ?? id;
    expect(describeMatch(rule.match, names)).toBe('Buyers from Zillow in 94110, 94112 between $500,000 and $900,000');
    expect(describeMatch({}, names)).toBe('Every lead');
    expect(describeMatch({ zips: ['1', '2', '3', '4', '5'], price_max: 100 }, names)).toBe('Every lead in 5 ZIP codes up to $1');
    expect(describeStrategy(rule, names, names)).toBe('Weighted among Ava (3), Ben (1) · offers last 5 min · up to 2 offers · then Team pond');
    expect(describeStrategy({ ...rule, strategy: 'pond', targetPondId: 'p1', members: [], fallbackPondId: null, offerWindowSeconds: null, maxOffers: null }, names, names)).toBe('Goes to Team pond');
  });

  it('a move produces the complete new order (sent in one request); the ends do not move', () => {
    expect(moved(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b']);
    expect(moved(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moved(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
    expect(moved(['a', 'b', 'c'], 'zz', 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('format helpers', () => {
  it('converts dollars, zips and durations', () => {
    expect(dollarsToCents('$650,000')).toBe(65_000_000);
    expect(dollarsToCents('')).toBeNull();
    expect(dollarsToCents('-5')).toBeNull();
    expect(centsToDollars(65_000_000)).toBe('650000');
    expect(centsToDollars(undefined)).toBe('');
    expect(parseZips('94110, 94112 94110;94114')).toEqual(['94110', '94112', '94114']);
    expect([45, 300, 5400, 7200, 172_800, 86_400].map(formatDuration)).toEqual(['45 sec', '5 min', '1 h 30 min', '2 h', '2 days', '1 day']);
    expect(formatDuration(null)).toBe('—');
  });
});
