// Test fixtures for core/coaching (used only by *.test.ts; excluded from coverage).
import type { EvidenceRef } from '../../assistant/index.js';
import { type AssistantClaimId, type CallId, type Instant, type UserId, at, instant, localDate } from '../../foundation/index.js';
import type { CallReviewFacts, CallScore, CallTranscript, ClaimedStatus, ItemStatus, RubricClaim, ScoredCall } from '../types.js';
import { RUBRIC_V1 } from '../rubric.js';

export const CALL = '0190f5a0-0000-7000-8000-0000000c0001' as CallId;
export const ME = '0190f5a0-0000-7000-8000-00000000a001' as UserId;
export const T0: Instant = at('2026-11-02T15:00:00Z');
export const TODAY = localDate('2026-11-11');
export const KEYS = RUBRIC_V1.items.map((i) => i.key);

export const callId = (n: number): CallId => `0190f5a0-0000-7000-8000-${String(n).padStart(12, '0')}` as CallId;
export const claimId = (n: number): AssistantClaimId => `0190f5a0-0000-7000-8000-c1a1${String(n).padStart(8, '0')}` as AssistantClaimId;

/** A real-looking agent/lead call, one segment every 5 s. */
export const LINES: readonly [string, string][] = [
  ['agent', 'Hi, this is Dana Reyes with Harbor Realty, thanks for calling back.'],
  ['lead', 'Hi Dana, yes, we saw the house on Maple Street.'],
  ['agent', 'Great. When are you hoping to be moved in?'],
  ['lead', 'Probably by the end of March, before the school year ends.'],
  ['agent', 'Have you had a chance to talk with a lender yet?'],
  ['lead', 'Not yet, we were going to do that next week.'],
  ['agent', 'What has you thinking about a move right now?'],
  ['lead', 'We need another bedroom, the baby is due in May.'],
  ['agent', 'Would Tuesday at 5 or Wednesday at 6 work for a showing?'],
  ['lead', 'Tuesday at 5 works.'],
  ['agent', 'So to recap, Tuesday at 5 at Maple Street, and I will text you the address.'],
  ['lead', 'Perfect, thanks.'],
];

export function transcript(id: CallId = CALL, lines: readonly [string, string][] = LINES): CallTranscript {
  return {
    kind: 'transcript',
    sourceType: 'call',
    sourceId: id,
    startedAt: T0,
    segments: lines.map(([speaker, text], i) => ({ speaker, text, startMs: i * 5000, endMs: i * 5000 + 4500 })),
  };
}

/** A ref to segment `seg` of the call quoting `snippet`. */
export function ref(snippet: string, seg: number, id: CallId = CALL): EvidenceRef {
  return { sourceType: 'call', sourceId: id, locator: { kind: 'transcript_offset', startMs: seg * 5000, endMs: seg * 5000 + 4500 }, snippet };
}

export function claim(itemKey: string, status: ClaimedStatus, evidence: EvidenceRef[], n = 1): RubricClaim {
  return { itemKey, status, evidence, claimId: claimId(n) };
}

export function facts(over: Partial<CallReviewFacts> = {}): CallReviewFacts {
  return {
    handledBy: 'human',
    agentRole: 'agent',
    imported: false,
    recording: { source: 'provider', consentBasis: 'announced_all_parties' },
    hasTranscript: true,
    callScoringEnabled: true,
    coachingPackCleared: true,
    ...over,
  };
}

/** A CallScore built directly from statuses (keys default to RUBRIC_V1 order). */
export function scoreOf(statuses: Partial<Record<string, ItemStatus>>, quotes: Partial<Record<string, EvidenceRef[]>> = {}): CallScore {
  const items = KEYS.flatMap((key) => {
    const status = statuses[key];
    return status === undefined ? [] : [{ key, status, claimId: null, quotes: quotes[key] ?? [] }];
  });
  const metCount = items.filter((i) => i.status === 'met').length;
  const scoredCount = items.filter((i) => i.status === 'met' || i.status === 'missed').length;
  return { rubricVersion: 'rubric/1', items, metCount, scoredCount };
}

/** A scored call `daysAgo` days before TODAY's reference instant. */
export function scored(n: number, daysAgo: number, statuses: Partial<Record<string, ItemStatus>>, quotes: Partial<Record<string, EvidenceRef[]>> = {}): ScoredCall {
  return { callId: callId(n), occurredAt: instant(at('2026-11-11T12:00:00Z') - daysAgo * 86_400_000), score: scoreOf(statuses, quotes) };
}

/** Every RUBRIC_V1 item met except the given ones (missed). */
export function allMetExcept(...missed: string[]): Partial<Record<string, ItemStatus>> {
  return Object.fromEntries(KEYS.map((k) => [k, missed.includes(k) ? 'missed' : 'met']));
}
