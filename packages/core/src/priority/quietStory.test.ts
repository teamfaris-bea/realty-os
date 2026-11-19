// b19 Today fix 1 (M5; R-TODAY-14): ONE instant, two consistent lines. The Due line of a quiet person and the Last line
// under it are decided from the same facts (quietStory), so they cannot disagree. The truth table, stage by evidence.
import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, at } from '../foundation/index.js';
import { type FollowUpTodayEntry, type LastAttempt, type QuietStory, TOUCH_SLACK_MS, followUpTodayReasons, quietStory } from './followUp.js';

const NOW = at('2026-11-19T15:00:00Z');
const ago = (ms: number) => (NOW - ms) as typeof NOW;
const D9 = ago(9 * DAY_MS + HOUR_MS);
const undelivered = (when: typeof NOW, kind: LastAttempt['kind'] = 'text'): LastAttempt => ({ kind, at: when, what: 'undelivered' });
const failedDial = (when: typeof NOW): LastAttempt => ({ kind: 'call', at: when, what: 'failed_dial' });
const NONE = { lastContactAt: null, touchAt: null, importedAt: null, attempt: null };

const warm = (over: Partial<FollowUpTodayEntry> = {}): FollowUpTodayEntry => ({ contactId: 'c1', reason: 'warm', dueAt: ago(2 * DAY_MS), taskIds: [], quietDays: 9, neverContacted: false, ...over });
const due = (story: QuietStory, stageLabel = 'Connected') => followUpTodayReasons(warm(), { now: NOW, stageLabel, story })[0]!;

describe('R-TODAY-14: quietStory, the evidence at the instant both lines are worded from', () => {
  // evidence → what the read found → the basis and its instant
  const TABLE: [string, Parameters<typeof quietStory>[0], QuietStory][] = [
    ['none', NONE, { basis: 'never', at: null, attempt: null }],
    // (an automated or bulk message is never a candidate for any of these instants: the caller passes none of them)
    ['automated only', NONE, { basis: 'never', at: null, attempt: null }],
    ['bulk only', NONE, { basis: 'never', at: null, attempt: null }],
    ['an undelivered attempt the system had counted as a touch', { ...NONE, touchAt: D9, attempt: undelivered(D9) }, { basis: 'undelivered', at: D9, attempt: undelivered(D9) }],
    ['an undelivered attempt the system never counted', { ...NONE, attempt: undelivered(D9, 'email') }, { basis: 'undelivered', at: D9, attempt: undelivered(D9, 'email') }],
    ['a failed dial (the dial was counted as a touch)', { ...NONE, touchAt: D9, attempt: failedDial(D9) }, { basis: 'failed_dial', at: D9, attempt: failedDial(D9) }],
    ['a logged outside call (the system counted nothing)', { ...NONE, lastContactAt: D9 }, { basis: 'contact', at: D9, attempt: null }],
    ['a verified call (the touch and the call are the same moment)', { ...NONE, lastContactAt: D9, touchAt: (D9 - 20_000) as typeof NOW }, { basis: 'contact', at: D9, attempt: null }],
    ['their reply after our text', { ...NONE, lastContactAt: ago(8 * DAY_MS), touchAt: D9 }, { basis: 'contact', at: ago(8 * DAY_MS), attempt: null }],
    ['imported only', { ...NONE, importedAt: ago(40 * DAY_MS) }, { basis: 'imported', at: ago(40 * DAY_MS), attempt: null }],
    ['a touch on record with nothing readable behind it', { ...NONE, touchAt: D9 }, { basis: 'touch_only', at: D9, attempt: null }],
    ['a conversation, then a text that was not delivered', { ...NONE, lastContactAt: ago(20 * DAY_MS), touchAt: D9, attempt: undelivered(D9) }, { basis: 'undelivered', at: D9, attempt: undelivered(D9) }],
    ['an undelivered text OLDER than the last conversation is not the story', { ...NONE, lastContactAt: D9, touchAt: D9, attempt: undelivered(ago(20 * DAY_MS)) }, { basis: 'contact', at: D9, attempt: null }],
    ['a conversation, then a touch on record with nothing readable', { ...NONE, lastContactAt: ago(20 * DAY_MS), touchAt: D9 }, { basis: 'touch_only', at: D9, attempt: null }],
    ['imported history and a later conversation: the conversation', { ...NONE, lastContactAt: D9, importedAt: ago(40 * DAY_MS) }, { basis: 'contact', at: D9, attempt: null }],
    ['imported history older than a touch with nothing readable: the touch', { ...NONE, touchAt: D9, importedAt: ago(40 * DAY_MS) }, { basis: 'touch_only', at: D9, attempt: null }],
  ];
  it.each(TABLE)('%s', (_n, input, want) => {
    expect(quietStory(input)).toEqual(want);
  });

  it('a touch within the slack of a readable contact is that contact (5 minutes); beyond it, it is its own event', () => {
    expect(TOUCH_SLACK_MS).toBe(5 * 60_000);
    expect(quietStory({ ...NONE, lastContactAt: D9, touchAt: (D9 + TOUCH_SLACK_MS) as typeof NOW }).basis).toBe('contact');
    expect(quietStory({ ...NONE, lastContactAt: D9, touchAt: (D9 + TOUCH_SLACK_MS + 1) as typeof NOW }).basis).toBe('touch_only');
  });
});

describe('R-TODAY-14: the Due line of a quiet person, stage by evidence', () => {
  const S = (basis: QuietStory['basis'], when: typeof NOW | null, attempt: LastAttempt | null = null): QuietStory => ({ basis, at: when, attempt });
  const TABLE: [string, QuietStory, string, string][] = [
    ['none / automated only / bulk only', S('never', null), 'WARM_NEVER_CONTACTED', 'Connected: no conversation yet'],
    ['undelivered text', S('undelivered', D9, undelivered(D9)), 'WARM_NOT_DELIVERED', 'Connected, but the last text was not delivered'],
    ['undelivered email', S('undelivered', D9, undelivered(D9, 'email')), 'WARM_NOT_DELIVERED', 'Connected, but the last email was not delivered'],
    ['failed dial', S('failed_dial', D9, failedDial(D9)), 'WARM_CALL_FAILED', 'Connected, but the last call did not connect'],
    ['logged outside call / verified call / their reply', S('contact', D9), 'WARM_NO_CONTACT', 'Connected: no conversation for 9 days'],
    ['a touch on record', S('touch_only', D9), 'WARM_NO_CONTACT', 'Connected: no conversation for 9 days'],
    ['imported only', S('imported', ago(40 * DAY_MS)), 'WARM_IMPORTED_ONLY', 'Connected: only imported history, the latest 40 days ago'],
  ];
  it.each(TABLE)('Connected × %s', (_n, story, code, label) => {
    expect(due(story)).toEqual({ code, label });
  });
  it.each(TABLE)('Long-term follow-up × %s: the team’s own stage label leads every one', (_n, story, code, label) => {
    expect(due(story, 'Long-term follow-up')).toEqual({ code, label: label.replace('Connected', 'Long-term follow-up') });
  });
  it('one day is "1 day"; the day count is the story’s own instant, never another clock', () => {
    expect(due(S('contact', ago(DAY_MS + HOUR_MS))).label).toBe('Connected: no conversation for 1 day');
    // the entry was computed from a later imported date (33 days); the line counts from the conversation it names
    expect(followUpTodayReasons(warm({ quietDays: 33 }), { now: NOW, stageLabel: 'Connected', story: S('contact', ago(60 * DAY_MS)) })[0]!.label).toBe('Connected: no conversation for 60 days');
  });
  it('no pair of the table can read "no conversation for N days" beside "no conversation yet": the never line carries no day count, and only it says "yet"', () => {
    for (const [, story, , label] of TABLE) {
      if (story.basis === 'never') expect(label).not.toMatch(/\d+ days?/);
      else expect(label).not.toMatch(/yet/);
    }
  });
  it('without a story (an older caller) the entry’s own facts word it as before', () => {
    expect(followUpTodayReasons(warm(), { now: NOW, stageLabel: 'Connected' })[0]).toEqual({ code: 'WARM_NO_CONTACT', label: 'Connected: no conversation for 9 days' });
    expect(followUpTodayReasons(warm({ neverContacted: true, quietDays: 90 }), { now: NOW, stageLabel: 'Connected' })[0]).toEqual({ code: 'WARM_NEVER_CONTACTED', label: 'Connected: no conversation yet' });
  });
});
