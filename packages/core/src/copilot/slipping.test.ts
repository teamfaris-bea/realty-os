import { describe, expect, it } from 'vitest';
import { at, instant, localDate } from '../foundation/index.js';
import { computeSlipFlags, rankSlipping, type RankEntry } from './slipping.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, NOW, POLICY, act, before, call, cue, drip, input, lead, note, reply } from './testing/index.js';
import type { SlipCode } from './types.js';

const codes = (i: Parameters<typeof computeSlipFlags>[0], now = NOW): SlipCode[] => computeSlipFlags(i, POLICY, now).map((f) => f.code);
const flag = (i: Parameters<typeof computeSlipFlags>[0], code: SlipCode, now = NOW) => computeSlipFlags(i, POLICY, now).find((f) => f.code === code);

describe('CP-5 speed to lead (speed-to-lead-playbook timing targets)', () => {
  it('a new lead inside its 5-minute business-hours target is a watch item due at arrival + 5 min', () => {
    const f = flag(input({ lead: lead({ createdAt: before(2 * MINUTE_MS) }) }), 'SPEED_TO_LEAD_OPEN');
    expect(f?.severity).toBe('watch');
    expect(f?.dueBy).toBe(before(2 * MINUTE_MS) + 5 * MINUTE_MS);
  });

  it('past 5 minutes in business hours it is missed (at risk), past 30 minutes it escalates to the sales manager and chief of staff', () => {
    expect(flag(input({ lead: lead({ createdAt: before(10 * MINUTE_MS) }) }), 'SPEED_TO_LEAD_MISSED')).toMatchObject({ severity: 'at_risk', escalateTo: [] });
    expect(flag(input({ lead: lead({ createdAt: before(31 * MINUTE_MS) }) }), 'SPEED_TO_LEAD_MISSED')).toMatchObject({ severity: 'escalate', escalateTo: ['sales_manager', 'chief_of_staff'] });
  });

  it('after hours the target is 15 minutes, and a miss at night is due at the next opening (8am)', () => {
    const night = at('2026-11-23T03:00:00Z'); // 22:00 ET Sunday
    const created = instant(night - 10 * MINUTE_MS);
    expect(codes(input({ lead: lead({ createdAt: created }) }), night)).toContain('SPEED_TO_LEAD_OPEN');
    const later = instant(night + 10 * MINUTE_MS);
    const f = flag(input({ lead: lead({ createdAt: created }) }), 'SPEED_TO_LEAD_MISSED', later);
    expect(f?.dueBy).toBe(at('2026-11-23T13:00:00Z'));
    expect(f?.nextAction).toMatch(/morning/);
  });

  it('automations and notes are not a first response; a human call is', () => {
    const created = before(HOUR_MS);
    const i = input({ lead: lead({ createdAt: created }), activities: [drip(before(59 * MINUTE_MS)), note(before(50 * MINUTE_MS), 'parcel looked up')] });
    expect(codes(i)).toContain('SPEED_TO_LEAD_MISSED');
    expect(codes({ ...i, activities: [...i.activities, call(before(40 * MINUTE_MS))] })).not.toContain('SPEED_TO_LEAD_MISSED');
  });

  it('imported lists are not new inbound leads: no speed-to-lead flag, but untouched 48 business hours is flagged', () => {
    const i = input({ lead: lead({ source: 'import', createdAt: before(10 * DAY_MS) }) });
    expect(codes(i)).not.toContain('SPEED_TO_LEAD_MISSED');
    expect(codes(i)).toContain('NO_ACTIVITY_48H');
  });
});

describe('CP-5 slipping-lead-recovery rules', () => {
  it('no human touch for 48 business-day hours: weekends do not count', () => {
    // last call Friday 10:00 ET; Monday 10:00 ET is only 24 business hours later
    const fri = at('2026-11-20T15:00:00Z');
    expect(codes(input({ lead: lead({ stage: 'active', nextStep: { dueAt: null, text: 'x' } }), activities: [call(fri)] }))).not.toContain('NO_ACTIVITY_48H');
    const wed = at('2026-11-18T15:00:00Z');
    expect(codes(input({ lead: lead({ stage: 'active', nextStep: { dueAt: null, text: 'x' } }), activities: [call(wed)] }))).toContain('NO_ACTIVITY_48H');
  });

  it('a working buyer or seller with no next step, or an overdue one', () => {
    expect(codes(input({ lead: lead({ stage: 'active' }), activities: [call(before(HOUR_MS))] }))).toContain('NO_NEXT_STEP');
    const f = flag(input({ lead: lead({ stage: 'active', nextStep: { dueAt: before(2 * DAY_MS), text: 'send listings' } }), activities: [call(before(HOUR_MS))] }), 'NEXT_STEP_OVERDUE');
    expect(f?.severity).toBe('at_risk');
  });

  it('a reply with no re-contact is watched, then at risk at 24 hours', () => {
    const base = { lead: lead({ stage: 'active', nextStep: { dueAt: null, text: 'x' } }) };
    expect(flag(input({ ...base, activities: [call(before(2 * DAY_MS)), reply(before(3 * HOUR_MS))] }), 'REPLY_NOT_RECONTACTED')?.severity).toBe('watch');
    expect(flag(input({ ...base, activities: [call(before(3 * DAY_MS)), reply(before(25 * HOUR_MS))] }), 'REPLY_NOT_RECONTACTED')?.severity).toBe('at_risk');
    expect(codes(input({ ...base, activities: [reply(before(25 * HOUR_MS)), call(before(HOUR_MS))] }))).not.toContain('REPLY_NOT_RECONTACTED');
  });

  it('a past client who visited the site this week, untouched since, is a dormant signal', () => {
    const i = input({ lead: lead({ stage: 'past_client' }), activities: [call(before(200 * DAY_MS)), act({ kind: 'web_visit', at: before(DAY_MS) })] });
    expect(flag(i, 'DORMANT_SIGNAL')).toMatchObject({ severity: 'at_risk', label: 'CONFIRMED' });
  });

  it('a new timing cue from a quiet lead is a dormant signal labelled UNVERIFIED (model-extracted)', () => {
    const i = input({ lead: lead({ stage: 'nurture' }), activities: [call(before(90 * DAY_MS))], timingCues: [cue({ statedAt: before(2 * DAY_MS), windowStart: localDate('2027-06-01'), windowEnd: null })] });
    expect(flag(i, 'DORMANT_SIGNAL')?.label).toBe('UNVERIFIED');
  });

  it('hot or appointment set without confirmation or follow-up', () => {
    const appt = { at: instant(NOW + DAY_MS), confirmed: false };
    expect(codes(input({ lead: lead({ stage: 'appointment', appointment: appt, nextStep: { dueAt: null, text: 'x' } }), activities: [call(before(2 * DAY_MS))] }))).toContain('HOT_NOT_CONFIRMED');
    expect(codes(input({ lead: lead({ stage: 'appointment', appointment: { ...appt, confirmed: true }, nextStep: { dueAt: null, text: 'x' } }), activities: [call(before(2 * DAY_MS))] }))).not.toContain('HOT_NOT_CONFIRMED');
    const past = { at: before(2 * DAY_MS), confirmed: true };
    expect(flag(input({ lead: lead({ stage: 'appointment', appointment: past, nextStep: { dueAt: null, text: 'x' } }), activities: [call(before(3 * DAY_MS))] }), 'HOT_NOT_CONFIRMED')?.why).toMatch(/follow-up after/);
  });

  it('a stated move window that is open now, with no touch in a week, is flagged (UNVERIFIED); excluded cues never are', () => {
    const base = { lead: lead({ stage: 'nurture' }), activities: [call(before(10 * DAY_MS))] };
    expect(flag(input({ ...base, timingCues: [cue()] }), 'TIMING_WINDOW_OPEN')).toMatchObject({ severity: 'at_risk', label: 'UNVERIFIED' });
    expect(codes(input({ ...base, timingCues: [cue({ excluded: 'rental_intent' })] }))).not.toContain('TIMING_WINDOW_OPEN');
    expect(codes(input({ ...base, timingCues: [cue({ windowStart: localDate('2026-01-01'), windowEnd: localDate('2026-04-30') })] }))).not.toContain('TIMING_WINDOW_OPEN');
  });

  it('unassigned and unreachable leads are flagged; no-reach is a DATA GAP', () => {
    expect(codes(input({ lead: lead({ assignedAgent: null }) }))).toContain('NO_ASSIGNED_AGENT');
    expect(flag(input({ lead: lead({ reachable: { sms: false, email: false } }) }), 'NO_CONTACT_CHANNEL')?.label).toBe('DATA_GAP');
  });

  it('closed, trashed and do-not-contact leads get no flags', () => {
    for (const l of [lead({ stage: 'closed' }), lead({ stage: 'trash' }), lead({ doNotContact: true })]) expect(codes(input({ lead: l }))).toEqual([]);
  });
});

describe('CP-6 re-surface rule', () => {
  it('a flag still open 48 hours after it was first flagged comes back AT RISK; a younger one does not', () => {
    const i = input({ lead: lead({ stage: 'active' }), activities: [call(before(HOUR_MS))] });
    expect(flag({ ...i, priorFlags: [{ code: 'NO_NEXT_STEP', firstFlaggedAt: before(49 * HOUR_MS) }] }, 'NO_NEXT_STEP')).toMatchObject({ resurfaced: true, severity: 'at_risk' });
    expect(flag({ ...i, priorFlags: [{ code: 'NO_NEXT_STEP', firstFlaggedAt: before(47 * HOUR_MS) }] }, 'NO_NEXT_STEP')).toMatchObject({ resurfaced: false, severity: 'watch' });
  });

  it('re-surfacing never lowers an escalation', () => {
    const i = input({ lead: lead({ createdAt: before(2 * HOUR_MS) }), priorFlags: [{ code: 'SPEED_TO_LEAD_MISSED', firstFlaggedAt: before(3 * DAY_MS) }] });
    expect(flag(i, 'SPEED_TO_LEAD_MISSED')?.severity).toBe('escalate');
  });
});

describe('CP-7 daily ranking', () => {
  const f = computeSlipFlags(input({ lead: lead({ stage: 'active' }), activities: [call(before(HOUR_MS))] }), POLICY, NOW);
  const e = (over: Partial<RankEntry>): RankEntry => ({ leadId: 'x', flags: f, source: 'website', lastLeadActivityAt: null, lastHumanTouchAt: null, estimatedValue: null, ...over });
  it('recent lead activity > source quality > days since last contact > estimated value; no flags, no row', () => {
    const r = rankSlipping([
      e({ leadId: 'value', estimatedValue: 900, lastHumanTouchAt: before(DAY_MS) }),
      e({ leadId: 'stale-contact', lastHumanTouchAt: before(9 * DAY_MS) }),
      e({ leadId: 'referral', source: 'referral', lastHumanTouchAt: before(DAY_MS) }),
      e({ leadId: 'active', lastLeadActivityAt: before(HOUR_MS) }),
      e({ leadId: 'clean', flags: [] }),
    ]).map((x) => x.leadId);
    expect(r).toEqual(['active', 'referral', 'stale-contact', 'value']);
  });
});
