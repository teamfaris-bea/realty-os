// The timing-cue hook alone (no database). Invented sentences only.
import { at } from '@realty/core/foundation';
import { describe, expect, it } from 'vitest';
import { timingCueHook, timingCueRecord } from './transcriptHooks.js';
import type { TranscriptReady } from './types.js';

const ready = (segments: TranscriptReady['segments']): TranscriptReady => ({
  tenantId: '01900000-0000-7000-8000-000000000001',
  transcriptId: '01900000-0000-7000-8000-000000000002',
  recordingId: '01900000-0000-7000-8000-000000000003',
  callId: '01900000-0000-7000-8000-000000000004',
  contactId: '01900000-0000-7000-8000-000000000005',
  callAt: at('2026-11-21T15:00:00Z'),
  language: 'en',
  segments,
});

describe('timing-cue hook', () => {
  it('a mono call with a buy window gives an actionable record with ranges and no words', () => {
    const r = timingCueRecord(ready([{ startMs: 0, endMs: 5000, speaker: null, text: 'We want to buy a house in about two months.' }]));
    expect(r.actionable).toEqual({ intent: 'buy', horizonMonths: 2, startMs: 0, endMs: 5000 });
    expect(JSON.stringify(r)).not.toContain('house');
  });

  it('only calls with a cue reach the sink', async () => {
    const got: unknown[] = [];
    const hook = timingCueHook(async (r) => {
      got.push(r);
    });
    await hook(ready([{ startMs: 0, endMs: 1000, speaker: null, text: 'Thanks, talk soon.' }]));
    expect(got).toHaveLength(0);
    await hook(ready([{ startMs: 0, endMs: 1000, speaker: null, text: 'We might sell in two years.' }]));
    expect(got).toHaveLength(1);
  });
});
