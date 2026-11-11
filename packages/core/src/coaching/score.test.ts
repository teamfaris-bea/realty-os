import { describe, expect, it } from 'vitest';
import { RUBRIC_V1, callScoreItemsJson, scoreFromClaims, scoreSummaryText, type Rubric, type RubricItem } from './index.js';
import { CALL, callId, claim, claimId, ref, transcript } from './testing/fixtures.js';

const TX = transcript();
const INTRO = ref('this is Dana Reyes with Harbor Realty', 0);
const TIMELINE = ref('When are you hoping to be moved in?', 2);
const LENDER = ref('Have you had a chance to talk with a lender yet?', 4);
const RECAP = ref('So to recap, Tuesday at 5 at Maple Street', 10);

const FIRST = RUBRIC_V1.items[0] as RubricItem;
const item = (s: ReturnType<typeof scoreFromClaims>, key: string) => s.items.find((i) => i.key === key);

describe('R-COACH-2 scoring from verified claims', () => {
  it('R-COACH-2: a met item with a verified transcript quote is met and carries that quote', () => {
    const s = scoreFromClaims([claim('introduced_self', 'met', [INTRO], 1)], RUBRIC_V1, TX);
    expect(item(s, 'introduced_self')).toEqual({ key: 'introduced_self', status: 'met', claimId: claimId(1), quotes: [INTRO] });
    expect(s.metCount).toBe(1);
    expect(s.scoredCount).toBe(1);
  });

  it('R-COACH-2: whitespace, case and smart quotes do not matter; words not said do', () => {
    const fancy = ref('  “WHEN are you   hoping to be moved in”  ', 2);
    const s = scoreFromClaims([claim('asked_timeline', 'met', [fancy])], RUBRIC_V1, TX);
    expect(item(s, 'asked_timeline')?.status).toBe('met');
    const made = ref('When are you hoping to close?', 2);
    expect(item(scoreFromClaims([claim('asked_timeline', 'met', [made])], RUBRIC_V1, TX), 'asked_timeline')?.status).toBe('needs_review');
  });

  it('R-COACH-2 E105: an item whose quote fails verification is needs_review and leaves the denominator', () => {
    const s = scoreFromClaims(
      [claim('introduced_self', 'met', [INTRO], 1), claim('asked_financing', 'missed', [ref('Are you pre-approved?', 4)], 2), claim('asked_timeline', 'met', [TIMELINE], 3)],
      RUBRIC_V1,
      TX,
    );
    expect(item(s, 'asked_financing')).toEqual({ key: 'asked_financing', status: 'needs_review', claimId: claimId(2), quotes: [] });
    expect(s.metCount).toBe(2);
    expect(s.scoredCount).toBe(2);
    expect(scoreSummaryText(s)).toBe('2 of 2 checks');
  });

  it('R-COACH-2 E105: a quote said elsewhere in the call (out of the cited range) does not verify', () => {
    const misplaced = ref('this is Dana Reyes with Harbor Realty', 10);
    expect(item(scoreFromClaims([claim('introduced_self', 'met', [misplaced])], RUBRIC_V1, TX), 'introduced_self')?.status).toBe('needs_review');
  });

  it('R-COACH-2 E105: a quote from another call does not verify', () => {
    const other = ref('this is Dana Reyes with Harbor Realty', 0, callId(99));
    expect(item(scoreFromClaims([claim('introduced_self', 'met', [other])], RUBRIC_V1, TX), 'introduced_self')?.status).toBe('needs_review');
  });

  it('R-COACH-2: a missed item needs a verified quote too; with one it is in the denominator', () => {
    const noLender = ref('Not yet, we were going to do that next week', 5);
    const s = scoreFromClaims([claim('asked_financing', 'missed', [noLender]), claim('asked_motivation', 'missed', [])], RUBRIC_V1, TX);
    expect(item(s, 'asked_financing')?.status).toBe('missed');
    expect(item(s, 'asked_motivation')?.status).toBe('needs_review');
    expect([s.metCount, s.scoredCount]).toEqual([0, 1]);
    expect(scoreSummaryText(s)).toBe('0 of 1 check');
  });

  it('R-COACH-2: only the verified refs of a claim are kept as quotes', () => {
    const bad = ref('we discussed my commission', 0);
    const s = scoreFromClaims([claim('introduced_self', 'met', [bad, INTRO])], RUBRIC_V1, TX);
    expect(item(s, 'introduced_self')?.quotes).toEqual([INTRO]);
  });

  it('R-COACH-2: not_applicable leaves the denominator; items with no claim are needs_review', () => {
    const s = scoreFromClaims([claim('introduced_self', 'met', [INTRO]), claim('asked_financing', 'not_applicable', [])], RUBRIC_V1, TX);
    expect(item(s, 'asked_financing')?.status).toBe('not_applicable');
    expect(item(s, 'recapped_call')).toEqual({ key: 'recapped_call', status: 'needs_review', claimId: null, quotes: [] });
    expect([s.metCount, s.scoredCount]).toEqual([1, 1]);
  });

  it('R-COACH-2: items follow rubric order; unknown keys are ignored', () => {
    const s = scoreFromClaims([claim('recapped_call', 'met', [RECAP]), claim('voice_warmth', 'met', [INTRO])], RUBRIC_V1, TX);
    expect(s.items.map((i) => i.key)).toEqual(RUBRIC_V1.items.map((i) => i.key));
    expect(s.rubricVersion).toBe('rubric/1');
  });

  it('R-COACH-2: disabled items (tenant_settings.coaching_rubric_disabled) are omitted', () => {
    const s = scoreFromClaims([claim('introduced_self', 'met', [INTRO])], RUBRIC_V1, TX, { disabledKeys: ['introduced_self', 'asked_motivation', 'not_a_key'] });
    expect(s.items.map((i) => i.key)).not.toContain('introduced_self');
    expect(s.items).toHaveLength(RUBRIC_V1.items.length - 2);
    expect([s.metCount, s.scoredCount]).toEqual([0, 0]);
    expect(scoreSummaryText(s)).toBe('No checks scored yet');
  });

  describe('R-COACH-2: duplicate claims for one item', () => {
    it('agreeing verified claims: the first usable one supplies the claim id and quotes', () => {
      const s = scoreFromClaims([claim('asked_timeline', 'met', [ref('nope', 2)], 1), claim('asked_timeline', 'met', [TIMELINE], 2), claim('asked_timeline', 'met', [TIMELINE], 3)], RUBRIC_V1, TX);
      expect(item(s, 'asked_timeline')).toEqual({ key: 'asked_timeline', status: 'met', claimId: claimId(2), quotes: [TIMELINE] });
    });

    it('verified met and verified missed for one key conflict: needs_review (first claim id)', () => {
      const s = scoreFromClaims([claim('asked_financing', 'met', [LENDER], 1), claim('asked_financing', 'missed', [ref('Not yet', 5)], 2)], RUBRIC_V1, TX);
      expect(item(s, 'asked_financing')).toEqual({ key: 'asked_financing', status: 'needs_review', claimId: claimId(1), quotes: [] });
      expect(s.scoredCount).toBe(0);
    });

    it('verified met and not_applicable conflict: needs_review; an unverified claim never conflicts', () => {
      const s1 = scoreFromClaims([claim('asked_financing', 'met', [LENDER], 1), claim('asked_financing', 'not_applicable', [], 2)], RUBRIC_V1, TX);
      expect(item(s1, 'asked_financing')?.status).toBe('needs_review');
      const s2 = scoreFromClaims([claim('asked_financing', 'missed', [ref('made up', 4)], 1), claim('asked_financing', 'met', [LENDER], 2)], RUBRIC_V1, TX);
      expect(item(s2, 'asked_financing')).toEqual({ key: 'asked_financing', status: 'met', claimId: claimId(2), quotes: [LENDER] });
    });
  });

  it('call_scores row: rubric_version format, items jsonb [{key,status,claim_id}], met_count <= scored_count', () => {
    const s = scoreFromClaims([claim('introduced_self', 'met', [INTRO], 1)], RUBRIC_V1, TX);
    expect(s.rubricVersion).toMatch(/^rubric\/[0-9]+$/);
    const json = callScoreItemsJson(s);
    expect(json[0]).toEqual({ key: 'introduced_self', status: 'met', claim_id: claimId(1) });
    expect(json.every((j) => ['met', 'missed', 'not_applicable', 'needs_review'].includes(j.status))).toBe(true);
    expect(s.metCount).toBeLessThanOrEqual(s.scoredCount);
  });

  it('rejects a rubric with a bad version or duplicate keys', () => {
    const bad = { version: 'v1', items: [] } as unknown as Rubric;
    expect(() => scoreFromClaims([], bad, TX)).toThrow(RangeError);
    const dup: Rubric = { version: 'rubric/9', items: [FIRST, FIRST] };
    expect(() => scoreFromClaims([], dup, TX)).toThrow(/duplicate/);
  });

  it('the transcript fixture is the call the refs point at', () => {
    expect(TX.sourceId).toBe(CALL);
  });
});
