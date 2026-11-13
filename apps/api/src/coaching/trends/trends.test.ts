// Coaching trends through the API (module 54): real Postgres, app.coaching_trends under the caller's own session.
// Scored calls are fixtures written by the superuser with triggers off (the call review job's own tests live in
// module 36); everything the trends read goes through the definer. DATA_MODEL R-COACH-7, R-COACH-8; E472, E473.
import { randomUUID } from 'node:crypto';
import { TREND_MIN_SCORED } from '@realty/core/coaching';
import { withTenantTx } from '@realty/db';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../../auth/testHarness.js';
import { type CoachingWorld, actorOf, call, coachingWorld, scoringOn, setPackCleared } from '../testing.js';
import { TREND_FLOOR, type WindowedScore, compareRows, mirror } from './aggregate.js';
import { trendRows } from './repos/trends.js';
import * as S from './schemas.js';

let h: ApiHarness;
let w: CoachingWorld;
let A: TestClient;
let B: TestClient;
let tl: TestClient;
const fixtures: WindowedScore[] = [];

type St = 'met' | 'missed' | 'needs_review' | 'not_applicable';

async function replica(text: string, values: unknown[]): Promise<void> {
  const c = await h.su.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query(text, values);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** Monday (YYYY-MM-DD) and a Tuesday instant of the local week `weeksAgo` weeks before this one, in the tenant's zone. */
async function week(weeksAgo: number): Promise<{ monday: string; at: string }> {
  const r = await h.su.query<{ monday: string; at: Date }>(
    `SELECT to_char(date_trunc('week', now() AT TIME ZONE s.default_timezone) - make_interval(weeks => $2), 'YYYY-MM-DD') AS monday,
            ((date_trunc('week', now() AT TIME ZONE s.default_timezone) - make_interval(weeks => $2) + interval '1 day 10 hours') AT TIME ZONE s.default_timezone) AS at
       FROM tenant_settings s WHERE s.tenant_id = $1`, [w.tenantId, weeksAgo]);
  return { monday: r.rows[0]!.monday, at: r.rows[0]!.at.toISOString() };
}

/** One scored call of `agent` in the week `weeksAgo` (call, recording, score), remembered for the mirror. */
async function scored(agent: string, weeksAgo: 1 | 2, items: Record<string, St>): Promise<void> {
  const { monday, at } = await week(weeksAgo);
  const callId = randomUUID();
  const contactId = randomUUID();
  const list = Object.entries(items).map(([key, status]) => ({ key, status, claim_id: null }));
  await replica(`INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, agent_user_id, client_address, initiator, status, started_at, recording_mode, recording_decision)
                 VALUES ($1, $2, $3, $4, 'outbound', $5, '+15550100', 'human', 'completed', $6, 'announced_all_parties', '{}')`, [w.tenantId, callId, randomUUID(), contactId, agent, at]);
  await replica(`INSERT INTO recordings (tenant_id, id, call_id, contact_id, agent_user_id, object_id, source, consent_basis, status, retain_until)
                 VALUES ($1, $2, $3, $4, $5, $6, 'provider', 'announced_all_parties', 'stored', now() + interval '1 year')`, [w.tenantId, randomUUID(), callId, contactId, agent, randomUUID()]);
  await replica(`INSERT INTO call_scores (tenant_id, call_id, rubric_version, agent_user_id, contact_id, items, met_count, scored_count) VALUES ($1, $2, 'rubric/1', $3, $4, $5::jsonb, 0, 0)`,
    [w.tenantId, callId, agent, contactId, JSON.stringify(list)]);
  fixtures.push({ agentUserId: agent, callId, windowKind: weeksAgo === 1 ? 'after' : 'before', week: monday, items: list });
}

const own = (c: TestClient, weeks = 1) => call<z.infer<typeof S.OwnTrendsResponse>>(c, 'GET', `/coaching/trends?weeks=${weeks}`);
const team = (c: TestClient, weeks = 1) => call<z.infer<typeof S.TeamTrendsResponse>>(c, 'GET', `/coaching/trends/team?weeks=${weeks}`);
const item = (items: { key: string }[], key: string) => items.find((i) => i.key === key) as z.infer<typeof S.TrendItem>;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await coachingWorld(h);
  [A, B] = [w.agents[0]!, w.agents[1]!];
  tl = w.teamLead!;
  // A: asked_timeline 5 of 8 two weeks ago, 9 of 10 last week; recapped_call 3 scored last week
  for (let i = 0; i < 8; i++) await scored(A.userId!, 2, { asked_timeline: i < 5 ? 'met' : 'missed', introduced_self: 'met' });
  for (let i = 0; i < 10; i++) await scored(A.userId!, 1, { asked_timeline: i < 9 ? 'met' : 'missed', introduced_self: 'met', recapped_call: i < 3 ? 'met' : 'needs_review' });
  // B: a small week (3 scored) last week, 6 two weeks ago
  for (let i = 0; i < 3; i++) await scored(B.userId!, 1, { asked_timeline: 'met' });
  for (let i = 0; i < 6; i++) await scored(B.userId!, 2, { asked_timeline: 'missed' });
}, 240_000);
afterAll(async () => {
  await setPackCleared(h, false).catch(() => undefined);
  await h?.close();
});

describe('states in words, no numbers while off (R-COACH-7, R-INT-6)', () => {
  it('E474 R-COACH-7: with platform:coaching uncleared or call scoring off, every caller gets the state in words and no numbers', async () => {
    for (const c of [A, w.owner]) {
      expect((await own(c)).body.trends).toMatchObject({ state: 'not_cleared', sentence: 'Call reviews are off until counsel reviews them.', items: [] });
    }
    expect((await team(w.owner)).body.trends).toMatchObject({ state: 'not_cleared', team: [], members: [] });
    await setPackCleared(h, true);
    expect((await own(A)).body.trends).toMatchObject({ state: 'scoring_off', sentence: 'Call scoring is off.', items: [] });
  });
});

describe('ready (R-COACH-7, R-COACH-8)', () => {
  beforeAll(async () => {
    await setPackCleared(h, true);
    await scoringOn(h, w.owner);
  });

  it('R-COACH-7: an agent sees their own weekly trend: every number with its n, the direction from core\'s rule, counts only', async () => {
    const r = await own(A);
    expect(r.status).toBe(200);
    const t = r.body.trends;
    expect(t.state).toBe('ready');
    expect(t.windows.after.from > t.windows.before.from).toBe(true);
    expect(item(t.items, 'asked_timeline')).toEqual({ key: 'asked_timeline', label: expect.any(String), before: { calls: 8, scored: 8, met: 5 }, after: { calls: 10, scored: 10, met: 9 }, direction: 'improving', sentence: 'Improving: met in 5 of 8, then 9 of 10' });
    expect(item(t.items, 'introduced_self')).toMatchObject({ direction: 'steady', sentence: 'Steady: met in 8 of 8, then 10 of 10' });
    expect(item(t.items, 'recapped_call')).toMatchObject({ before: { scored: 0, met: null }, after: { scored: 3, met: null }, direction: 'not_enough_data', sentence: 'Not enough reviewed calls yet (3 last week)' });
    // two weeks against two weeks: the before window holds no reviews
    expect(item((await own(A, 2)).body.trends.items, 'asked_timeline')).toMatchObject({ before: { scored: 0 }, after: { scored: 18, met: 14 }, direction: 'not_enough_data' });
  });

  it('E473 R-COACH-8: the agent\'s own small week is shown at 5 or more; in anyone else\'s view a member\'s small week withholds met, and the team total too', async () => {
    // B: 3 last week (below 5 even for themselves)
    expect(item((await own(B)).body.trends.items, 'asked_timeline')).toMatchObject({ after: { scored: 3, met: null }, direction: 'not_enough_data' });
    const t = (await team(w.owner)).body.trends;
    expect(t.state).toBe('ready');
    const a = t.members.find((m) => m.userId === A.userId)!;
    const b = t.members.find((m) => m.userId === B.userId)!;
    expect(item(a.items, 'asked_timeline')).toMatchObject({ before: { met: 5 }, after: { met: 9 }, direction: 'improving' });
    expect(item(b.items, 'asked_timeline')).toMatchObject({ before: { scored: 6, met: 0 }, after: { scored: 3, met: null }, direction: 'not_enough_data' });
    // the team's last week holds B's 3: withheld, so the team minus A says nothing about B
    expect(item(t.team, 'asked_timeline')).toMatchObject({ after: { calls: 13, scored: 13, met: null }, direction: 'not_enough_data', sentence: 'Not enough reviewed calls yet (13 last week)' });
    expect(item(t.team, 'asked_timeline').before).toEqual({ calls: 14, scored: 14, met: 5 });
    // members who take reviews only, the Owner and Team Lead included
    expect(t.members.map((m) => m.userId).sort()).toEqual([w.owner.userId, A.userId, B.userId, tl.userId].sort());
  });

  it('E472 R-COACH-8: a Team Lead sees the team\'s trends only while the Owner\'s switch is on; otherwise the state says so and nothing is read', async () => {
    const off = (await team(tl)).body.trends;
    expect(off).toMatchObject({ state: 'tl_not_allowed', sentence: 'The Owner has not turned on Team Lead access to call reviews, so trends are private to each person.', team: [], members: [] });
    // their own trend stays theirs
    expect((await own(tl)).body.trends.state).toBe('ready');
    await scoringOn(h, w.owner, { tl: true });
    try {
      const on = (await team(tl)).body.trends;
      expect(on.state).toBe('ready');
      const teamIds = (await h.su.query<{ user_id: string }>('SELECT tm.user_id FROM team_members tm WHERE tm.tenant_id = $1 AND tm.team_id = $2', [w.tenantId, w.teamId])).rows.map((r) => r.user_id);
      expect(on.members.length).toBeGreaterThan(0);
      for (const m of on.members) expect([...teamIds, tl.userId]).toContain(m.userId);
    } finally {
      await scoringOn(h, w.owner, { tl: false });
    }
  });

  it('R-COACH-8: an agent and a TC never read the team\'s trends (404); bad weeks are refused (422)', async () => {
    expect((await team(A)).status).toBe(404);
    for (const q of ['weeks=0', 'weeks=5', 'weeks=x', 'weeks=1&userId=1']) expect((await call(A, 'GET', `/coaching/trends?${q}`)).status, q).toBe(422);
    const tc = await h.invite(w.owner, 'tc');
    expect((await own(tc)).status).toBe(404);
    expect((await team(tc)).status).toBe(404);
  });

  it('R-COACH-7 R-COACH-8: the definer\'s rows equal the pure mirror on the same fixtures, floor included (5 = core\'s minimum)', async () => {
    expect(TREND_FLOOR).toBe(TREND_MIN_SCORED);
    const cases: [TestClient, string[]][] = [[A, [A.userId!]], [B, [B.userId!]], [w.owner, [A.userId!]], [w.owner, [B.userId!]], [w.owner, [A.userId!, B.userId!]], [w.owner, [A.userId!, B.userId!, tl.userId!]]];
    for (const [c, ids] of cases) {
      const db = await withTenantTx(actorOf(c), (tx) => trendRows(tx, ids, 1, 'rubric/1'), { db: h.database });
      expect([...db].sort(compareRows), `${c.role} ${ids.length}`).toEqual(mirror(fixtures, ids, c.userId!));
    }
  });

  it('R-COACH-6 R-COACH-7: responses carry counts only: no score, grade, rank, percentage, metRate, quote, call, contact or tenant id, no confidence', async () => {
    const FORBIDDEN = /score"|grade|rank|percent|metRate|quote|callId|contactId|tenantId|confidence|"rate"/i;
    expect(JSON.stringify(z.toJSONSchema(S.OwnTrendsResponse))).not.toMatch(FORBIDDEN);
    expect(JSON.stringify(z.toJSONSchema(S.TeamTrendsResponse))).not.toMatch(FORBIDDEN);
    const body = JSON.stringify([(await own(A)).body, (await team(w.owner)).body]);
    expect(body).not.toMatch(FORBIDDEN);
    expect(body).not.toMatch(/%/);
    expect(z.toJSONSchema(S.TeamTrendsResponse)).toMatchSnapshot();
    expect(z.toJSONSchema(S.OwnTrendsResponse)).toMatchSnapshot();
  });
});
