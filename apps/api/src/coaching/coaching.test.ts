// api/coaching over real Postgres as app_user, with the deterministic fake model (module 36; R-COACH-1..6,
// R-INT-6, E104-E106). Every request goes through the real server; the review job and the reconcile run as
// the tenant's system actor, as the worker runs them.
import { randomUUID } from 'node:crypto';
import type { Instant } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { FAKE_BAD_REVIEW_QUOTE } from '../providers/fake/ai.js';
import { feedOf } from '../workspace/testing.js';
import { DAY_MS, actorOf, cardsOf, playableCall, call, coachingWorld, freshReauth, ownedContact, reconcile, recordedCall, review, scoringOn, setPackCleared, type CoachingWorld } from './testing.js';

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});
afterAll(async () => {
  await setPackCleared(h, false).catch(() => undefined);
  await h?.close();
});

/** A world with scoring on (pack cleared) and one contact of agent 0. */
async function readyWorld(o: { tl?: boolean } = {}): Promise<{ w: CoachingWorld; contactId: string }> {
  await setPackCleared(h, true);
  const w = await coachingWorld(h);
  await scoringOn(h, w.owner, { tl: o.tl ?? false });
  const c = await ownedContact(w.agents[0]!, { firstName: 'Lena' });
  return { w, contactId: c.id };
}

/** The switch forced on behind the platform's back (a fixture: the guard is a trigger, off in replica mode). */
async function forceScoringOn(tenantId: string): Promise<void> {
  const c = await h.su.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query('UPDATE tenant_settings SET call_scoring_enabled = true WHERE tenant_id = $1', [tenantId]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}

const scoreRow = async (callId: string) => (await h.su.query('SELECT items, met_count, scored_count, agent_user_id FROM call_scores WHERE call_id = $1', [callId])).rows[0];

describe('the call review job', () => {
  it('R-COACH-1 R-COACH-2: a human-handled call recorded on a lawful basis is reviewed against the rubric; every met/missed item cites a verified quote', async () => {
    const { w, contactId } = await readyWorld();
    const a = w.agents[0]!;
    const callId = await recordedCall(h, w, contactId, a.userId, { skip: ['asked_financing'] });
    const r = await review(h, w.tenantId, callId);
    expect(r).toMatchObject({ kind: 'reviewed', callId });
    const row = await scoreRow(callId);
    expect(row.agent_user_id).toBe(a.userId);
    const items = row.items as { key: string; status: string; claim_id: string | null }[];
    expect(items.find((i) => i.key === 'asked_financing')?.status).toBe('missed');
    expect(items.find((i) => i.key === 'asked_timeline')?.status).toBe('met');
    // every decided item's claim has a verbatim-verified quote of THIS call
    for (const it of items.filter((i) => i.status === 'met' || i.status === 'missed')) {
      const ev = await h.su.query('SELECT verbatim_verified, source_id, snippet, snippet_enc IS NOT NULL AS enc FROM evidence_refs WHERE claim_id = $1', [it.claim_id]);
      expect(ev.rows.some((e) => e.verbatim_verified && e.source_id === callId && e.enc && e.snippet === null)).toBe(true);
    }
    // the action is internal and executed: never an approval card
    const act = await h.su.query("SELECT kind, autonomy, status, owner_user_id FROM assistant_actions WHERE dedupe_key = $1", [`call_review:${callId}`]);
    expect(act.rows[0]).toMatchObject({ kind: 'call_review', autonomy: 'internal', status: 'executed', owner_user_id: a.userId });
    const inbox = await call<{ items: unknown[] }>(a, 'GET', '/approvals');
    expect(JSON.stringify(inbox.body)).not.toContain('call_review');
    // idempotent: a second run writes nothing new
    expect(await review(h, w.tenantId, callId)).toEqual({ kind: 'skipped', reason: 'ALREADY_REVIEWED' });
  });

  it('E105 R-COACH-2: a rubric quote that fails verification leaves the item needs_review and out of the denominator', async () => {
    const { w, contactId } = await readyWorld();
    const callId = await recordedCall(h, w, contactId, w.agents[0]!.userId, { skip: ['recapped_call'] });
    expect(await review(h, w.tenantId, callId)).toMatchObject({ kind: 'reviewed', needsReview: 1 });
    const row = await scoreRow(callId);
    const items = row.items as { key: string; status: string; claim_id: string }[];
    const recap = items.find((i) => i.key === 'recapped_call')!;
    expect(recap.status).toBe('needs_review');
    const ev = await h.su.query('SELECT verbatim_verified FROM evidence_refs WHERE claim_id = $1', [recap.claim_id]);
    expect(ev.rows).toEqual([{ verbatim_verified: false }]);
    // 7 decided items, all met: "7 of 7 checks", the unverified one is not counted either way
    expect({ met: row.met_count, scored: row.scored_count }).toEqual({ met: 7, scored: 7 });
    expect(FAKE_BAD_REVIEW_QUOTE).not.toBe('');
  });

  it('E104 R-COACH-1: an imported FUB recording is never reviewed (job), and the DB refuses a review of it', async () => {
    const { w, contactId } = await readyWorld();
    const callId = await recordedCall(h, w, contactId, w.agents[0]!.userId, { variant: 'import_fub' });
    expect(await review(h, w.tenantId, callId)).toEqual({ kind: 'skipped', reason: 'imported_recording' });
    expect(await scoreRow(callId)).toBeUndefined();
    expect((await h.su.query("SELECT count(*)::int AS n FROM ai_runs WHERE purpose = 'call_review' AND input_refs -> 'callIds' ? $1", [callId])).rows[0].n).toBe(0);
  });

  it('R-COACH-1: an imported call, a shredded recording and a call with no recording are never reviewed; a one-party-policy recording is', async () => {
    const { w, contactId } = await readyWorld();
    const a = w.agents[0]!.userId;
    expect(await review(h, w.tenantId, await recordedCall(h, w, contactId, a, { variant: 'imported_call' }))).toEqual({ kind: 'skipped', reason: 'imported_call' });
    expect(await review(h, w.tenantId, await recordedCall(h, w, contactId, a, { variant: 'shredded' }))).toEqual({ kind: 'skipped', reason: 'no_recording' });
    expect(await review(h, w.tenantId, await recordedCall(h, w, contactId, a, { variant: 'no_recording' }))).toEqual({ kind: 'skipped', reason: 'no_recording' });
    expect(await review(h, w.tenantId, await recordedCall(h, w, contactId, a, { variant: 'one_party' }))).toMatchObject({ kind: 'reviewed' });
  });

  it('R-COACH-3: the job reviews human-handled calls only: an AI-handled call and a voicemail are skipped before any model run', async () => {
    const { w, contactId } = await readyWorld();
    const a = w.agents[0]!.userId;
    const before = h.providers.ai.calls.length;
    expect(await review(h, w.tenantId, await recordedCall(h, w, contactId, a, { variant: 'ai_handled' }))).toEqual({ kind: 'skipped', reason: 'not_human_handled' });
    expect(await review(h, w.tenantId, await recordedCall(h, w, contactId, a, { variant: 'voicemail' }))).toEqual({ kind: 'skipped', reason: 'not_human_handled' });
    expect(h.providers.ai.calls.length).toBe(before);
  });

  it('R-INT-6 R-COACH-1: scoring stays off until platform:coaching is cleared: the Owner cannot turn it on (API and DB), and neither the scan nor the job reviews anything', async () => {
    await setPackCleared(h, false);
    const w = await coachingWorld(h);
    const c = await ownedContact(w.agents[0]!);
    await freshReauth(h, w.owner);
    const put = await call<{ error: { code: string } }>(w.owner, 'PUT', '/admin/coaching', { scoringEnabled: true, tlSeesCallScores: false, disabledKeys: [] });
    expect(put.status).toBe(409);
    expect(put.body.error.code).toBe('COACHING_NOT_CLEARED');
    const callId = await recordedCall(h, w, c.id, w.agents[0]!.userId);
    expect(await review(h, w.tenantId, callId)).toEqual({ kind: 'skipped', reason: 'pack_not_cleared' });
    // even with the switch forced on behind the platform's back, an uncleared pack stops the job
    await forceScoringOn(w.tenantId);
    expect(await review(h, w.tenantId, callId)).toEqual({ kind: 'skipped', reason: 'pack_not_cleared' });
    const { callsAwaitingReview } = await import('./repos/coaching.js');
    const { withTenantTx } = await import('@realty/db');
    const { systemActor } = await import('../worker/systemActor.js');
    expect(await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => callsAwaitingReview(tx, now), { db: h.database })).toEqual([]);
  });

  it('R-INT-6: a pack that becomes unreviewed again turns reviews and tips off: the job skips and the reconcile closes open tips', async () => {
    const { w, contactId } = await readyWorld();
    const a = w.agents[0]!;
    for (let i = 0; i < 3; i++) await review(h, w.tenantId, await recordedCall(h, w, contactId, a.userId, { skip: ['asked_financing'], startedAt: new Date(Date.now() - (i + 2) * 3_600_000) }));
    await reconcile(h, w.tenantId);
    expect((await cardsOf(h, a.userId)).filter((c) => c.state === 'open')).toHaveLength(1);
    await setPackCleared(h, false);
    expect(await review(h, w.tenantId, await recordedCall(h, w, contactId, a.userId))).toEqual({ kind: 'skipped', reason: 'pack_not_cleared' });
    expect(await reconcile(h, w.tenantId)).toMatchObject({ off: true, closed: 1 });
    expect((await cardsOf(h, a.userId)).filter((c) => c.state === 'open')).toHaveLength(0);
    const today = await call<{ coaching: { state: string; fix: unknown } }>(a, 'GET', '/coaching/today');
    expect(today.body.coaching).toMatchObject({ state: 'not_cleared', fix: null });
  });

  it('R-AST-18: with the AI switched off no call is sent to the model', async () => {
    const { w, contactId } = await readyWorld();
    await h.su.query('UPDATE tenant_settings SET ai_enabled = false WHERE tenant_id = $1', [w.tenantId]);
    const before = h.providers.ai.calls.length;
    expect(await review(h, w.tenantId, await recordedCall(h, w, contactId, w.agents[0]!.userId))).toEqual({ kind: 'skipped', reason: 'AI_DISABLED' });
    expect(h.providers.ai.calls.length).toBe(before);
  });
});

describe('the daily fix', () => {
  async function threeMisses(w: CoachingWorld, contactId: string, userId: string | null, skip: string[] = ['asked_financing'], n = 3): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = await recordedCall(h, w, contactId, userId, { skip, startedAt: new Date(Date.now() - (i + 2) * 3_600_000) });
      await review(h, w.tenantId, id);
      ids.push(id);
    }
    return ids;
  }

  it('R-COACH-4: one fix a day with two tap-to-play quotes, linked from the feed card; deduped per user and local date', async () => {
    const { w, contactId } = await readyWorld();
    const a = w.agents[0]!;
    const calls = await threeMisses(w, contactId, a.userId);
    expect(await reconcile(h, w.tenantId)).toMatchObject({ written: 1 });
    expect(await reconcile(h, w.tenantId)).toMatchObject({ written: 0 });
    const cards = await cardsOf(h, a.userId);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.dedupe_key).toMatch(new RegExp(`^coaching_fix:${a.userId}:\\d{4}-\\d{2}-\\d{2}$`));
    expect(cards[0]!.reasons[0]!.fix!.item).toBe('asked_financing');
    // the feed card links to the daily fix page
    const feed = await feedOf(a);
    const card = feed.all.find((x) => x.itemType === 'coaching_fix');
    expect(card).toMatchObject({ primaryAction: { kind: 'open_coaching_fix', label: 'See the tip' } });
    // the page: the tip, why, and two quotes of the two most recent misses, playable
    const today = await call<{ coaching: { state: string; fix: { itemKey: string; tip: string; why: string; quotes: { callId: string; recordingId: string | null; snippet: string | null; startMs: number; endMs: number }[] } } }>(a, 'GET', '/coaching/today');
    expect(today.status).toBe(200);
    const fix = today.body.coaching.fix;
    expect(fix.itemKey).toBe('asked_financing');
    expect(fix.why).toBe('Asked about financing: missed in 3 of the last 3 calls');
    expect(fix.quotes).toHaveLength(2);
    expect(fix.quotes.map((q) => q.callId)).toEqual([calls[0], calls[1]]);
    for (const q of fix.quotes) {
      expect(q.recordingId).toMatch(/^[0-9a-f-]{36}$/);
      expect(q.snippet).toBe('Thanks so much, talk soon.');
      expect(q.endMs).toBeGreaterThan(q.startMs);
    }
    // the next day: a new card, yesterday's is closed by the condition (never two open)
    const tomorrow = (Date.now() + DAY_MS) as Instant;
    expect(await reconcile(h, w.tenantId, tomorrow)).toMatchObject({ written: 1, closed: 1 });
    const after = await cardsOf(h, a.userId);
    expect(after.filter((c) => c.state === 'open')).toHaveLength(1);
    expect(after.find((c) => c.id === cards[0]!.id)).toMatchObject({ state: 'done', resolved_by: 'condition' });
  });

  it('R-COACH-4: each quote of the tip is playable: the agent gets a single-use stream token for its recording, and the play is audited', async () => {
    const { w } = await readyWorld();
    const a = w.agents[0]!;
    const c = await ownedContact(a, { firstName: 'Ravi' });
    for (let i = 0; i < 3; i++) expect(await review(h, w.tenantId, await playableCall(h, w, a, c.id, { skip: ['asked_financing'] }))).toMatchObject({ kind: 'reviewed' });
    const today = await call<{ coaching: { fix: { quotes: { recordingId: string; startMs: number }[] } } }>(a, 'GET', '/coaching/today');
    const q = today.body.coaching.fix.quotes[0]!;
    const tok = await call<{ url: string }>(a, 'POST', `/recordings/${q.recordingId}/stream-token`, { purpose: 'play' });
    expect(tok.status).toBe(200);
    const stream = await a.request('GET', `/api${tok.body.url.replace(/^\/api/, '')}`);
    expect(stream.statusCode).toBe(200);
    expect((await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'recording.play' AND entity_id = $2", [w.tenantId, q.recordingId])).rows[0].n).toBe(1);
  });

  it('E106 R-COACH-4: an agent with two scored calls gets no daily fix ("Not enough calls yet")', async () => {
    const { w, contactId } = await readyWorld();
    const a = w.agents[0]!;
    await threeMisses(w, contactId, a.userId, ['asked_financing'], 2);
    await reconcile(h, w.tenantId);
    expect(await cardsOf(h, a.userId)).toEqual([]);
    const today = await call<{ coaching: { fix: unknown; noFix: { reason: string; text: string } } }>(a, 'GET', '/coaching/today');
    expect(today.body.coaching).toMatchObject({ fix: null, noFix: { reason: 'not_enough_calls', text: 'Not enough calls yet' } });
    expect(await cardsOf(h, a.userId)).toEqual([]);
  });

  it('R-COACH-4: a dismissed fix is not replaced today and its item is not suggested again for 7 days', async () => {
    const { w, contactId } = await readyWorld();
    const a = w.agents[0]!;
    // financing missed in 3 calls, motivation in 2 of them
    await threeMisses(w, contactId, a.userId, ['asked_financing', 'asked_motivation'], 2);
    await threeMisses(w, contactId, a.userId, ['asked_financing'], 1);
    const first = await call<{ coaching: { fix: { itemKey: string }; cardId: string } }>(a, 'GET', '/coaching/today');
    expect(first.body.coaching.fix.itemKey).toBe('asked_financing');
    const d = await call<{ coaching: { fix: unknown; noFix: { reason: string } } }>(a, 'POST', '/coaching/today/dismiss');
    expect(d.status).toBe(200);
    expect(d.body.coaching).toMatchObject({ fix: null, noFix: { reason: 'dismissed_today' } });
    await reconcile(h, w.tenantId);
    expect((await cardsOf(h, a.userId)).filter((c) => c.state === 'open')).toHaveLength(0);
    // tomorrow and for the rest of the 7 days: the next item, never the dismissed one
    for (const days of [1, 6]) {
      await reconcile(h, w.tenantId, (Date.now() + days * DAY_MS) as Instant);
      const open = (await cardsOf(h, a.userId)).filter((c) => c.state === 'open');
      expect(open).toHaveLength(1);
      expect(open[0]!.reasons[0]!.fix!.item).toBe('asked_motivation');
    }
    // after 7 days the dismissed item may come back
    await reconcile(h, w.tenantId, (Date.now() + 8 * DAY_MS) as Instant);
    const open = (await cardsOf(h, a.userId)).filter((c) => c.state === 'open');
    expect(open[0]!.reasons[0]!.fix!.item).toBe('asked_financing');
  });

  it('R-COACH-4: dismissing the card on the feed counts the same as on the page', async () => {
    const { w, contactId } = await readyWorld();
    const a = w.agents[0]!;
    await threeMisses(w, contactId, a.userId, ['asked_financing', 'asked_motivation'], 3);
    await reconcile(h, w.tenantId);
    const card = (await feedOf(a)).all.find((x) => x.itemType === 'coaching_fix')!;
    const r = await call(a, 'POST', `/feed/${card.id}/dismiss`);
    expect(r.status).toBeLessThan(300);
    await reconcile(h, w.tenantId, (Date.now() + DAY_MS) as Instant);
    const open = (await cardsOf(h, a.userId)).filter((c) => c.state === 'open');
    expect(open[0]!.reasons[0]!.fix!.item).toBe('asked_motivation');
  });

  it('R-COACH-4: turning scoring off closes every open tip at once; the page says scoring is off', async () => {
    const { w, contactId } = await readyWorld();
    const a = w.agents[0]!;
    await threeMisses(w, contactId, a.userId);
    await reconcile(h, w.tenantId);
    const off = await call(w.owner, 'PUT', '/admin/coaching', { scoringEnabled: false, tlSeesCallScores: false, disabledKeys: [] });
    expect(off.status).toBe(200);
    expect((await cardsOf(h, a.userId)).filter((c) => c.state === 'open')).toHaveLength(0);
    const today = await call<{ coaching: { state: string } }>(a, 'GET', '/coaching/today');
    expect(today.body.coaching.state).toBe('scoring_off');
    // review fix: the team view returns no tip or quote either, to anyone, while scoring is off
    const team = await call<{ team: { state: string; members: unknown[] } }>(w.owner, 'GET', '/coaching/team');
    expect(team.body.team).toMatchObject({ state: 'scoring_off', members: [] });
    await setPackCleared(h, false);
    await h.su.query('UPDATE tenant_settings SET call_scoring_enabled = false WHERE tenant_id = $1', [w.tenantId]).catch(() => undefined);
    expect((await call<{ team: { members: unknown[] } }>(w.owner, 'GET', '/coaching/team')).body.team.members).toEqual([]);
  });

  it('R-COACH-4: scoring turned off and on again the same day brings today\'s tip back; it never reads as set aside by the agent', async () => {
    const { w, contactId } = await readyWorld();
    const a = w.agents[0]!;
    await threeMisses(w, contactId, a.userId);
    await reconcile(h, w.tenantId);
    expect((await call(w.owner, 'PUT', '/admin/coaching', { scoringEnabled: false, tlSeesCallScores: false, disabledKeys: [] })).status).toBe(200);
    await scoringOn(h, w.owner);
    const today = await call<{ coaching: { fix: { itemKey: string } | null; noFix: unknown } }>(a, 'GET', '/coaching/today');
    expect(today.body.coaching.noFix).toBeNull();
    expect(today.body.coaching.fix?.itemKey).toBe('asked_financing');
    expect((await cardsOf(h, a.userId)).filter((c) => c.state === 'open')).toHaveLength(1);
  });

  it('R-COACH-4: a member whose reviews are gone (or who left) keeps no open tip after the next pass', async () => {
    const { w, contactId } = await readyWorld();
    const a = w.agents[0]!;
    await threeMisses(w, contactId, a.userId);
    await reconcile(h, w.tenantId);
    await h.su.query('DELETE FROM call_scores WHERE agent_user_id = $1', [a.userId]);
    await reconcile(h, w.tenantId);
    expect((await cardsOf(h, a.userId)).filter((c) => c.state === 'open')).toHaveLength(0);
  });

  it('R-COACH-4: a rubric item the Owner turned off is never the fix', async () => {
    const { w, contactId } = await readyWorld();
    const a = w.agents[0]!;
    await threeMisses(w, contactId, a.userId, ['asked_financing', 'asked_motivation'], 3);
    const put = await call(w.owner, 'PUT', '/admin/coaching', { scoringEnabled: true, tlSeesCallScores: false, disabledKeys: ['asked_financing'] });
    expect(put.status).toBe(200);
    const today = await call<{ coaching: { fix: { itemKey: string } } }>(a, 'GET', '/coaching/today');
    expect(today.body.coaching.fix.itemKey).toBe('asked_motivation');
  });
});

describe('who sees reviews and tips', () => {
  async function reviewedThrice(w: CoachingWorld, contactId: string): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await recordedCall(h, w, contactId, w.agents[0]!.userId, { skip: ['asked_financing'], startedAt: new Date(Date.now() - (i + 2) * 3_600_000) });
      await review(h, w.tenantId, id);
      ids.push(id);
    }
    return ids;
  }

  it('R-COACH-3 D-COACH: a Team Lead reads no review, claim or quote of a team member while the Owner\'s setting is off (DB), and the team page says so', async () => {
    const { w, contactId } = await readyWorld();
    const ids = await reviewedThrice(w, contactId);
    const tl = w.teamLead!;
    const team = await call<{ team: { visible: boolean; members: unknown[]; sentence: string } }>(tl, 'GET', '/coaching/team');
    expect(team.status).toBe(200);
    expect(team.body.team).toMatchObject({ visible: false, members: [] });
    // the database itself: as the Team Lead (RLS), no review rows and no call_review action or claims
    const { withTenantTx } = await import('@realty/db');
    const { sql } = await import('kysely');
    const seen = await withTenantTx(actorOf(tl), async (tx) => {
      const s = await sql<{ n: number }>`SELECT count(*)::int AS n FROM call_scores WHERE call_id = ANY (${ids}::uuid[])`.execute(tx);
      const a = await sql<{ n: number }>`SELECT count(*)::int AS n FROM assistant_actions WHERE kind = 'call_review'`.execute(tx);
      const c = await sql<{ n: number }>`SELECT count(*)::int AS n FROM assistant_claims cl JOIN assistant_actions x ON x.tenant_id = cl.tenant_id AND x.id = cl.action_id WHERE x.kind = 'call_review'`.execute(tx);
      const v = await sql<{ n: number }>`SELECT count(*)::int AS n FROM contacts WHERE id = ${contactId}`.execute(tx);
      return { scores: s.rows[0]!.n, actions: a.rows[0]!.n, claims: c.rows[0]!.n, contact: v.rows[0]!.n };
    }, { db: h.database });
    expect(seen).toEqual({ scores: 0, actions: 0, claims: 0, contact: 1 });
  });

  it('R-COACH-3: with the Owner\'s setting on, the Team Lead sees their team\'s tips (from reviews they may read) and nothing of agents outside the team', async () => {
    const { w, contactId } = await readyWorld({ tl: true });
    await reviewedThrice(w, contactId);
    const tl = w.teamLead!;
    const team = await call<{ team: { visible: boolean; members: { userId: string; fix: { itemKey: string; quotes: unknown[] } | null }[] } }>(tl, 'GET', '/coaching/team');
    expect(team.body.team.visible).toBe(true);
    const m = team.body.team.members.find((x) => x.userId === w.agents[0]!.userId);
    expect(m?.fix?.itemKey).toBe('asked_financing');
    expect(team.body.team.members.map((x) => x.userId)).not.toContain(w.owner.userId);
  });

  it('R-COACH-3: another agent sees none of an agent\'s reviews, and an agent never sees the team page', async () => {
    const { w, contactId } = await readyWorld();
    await reviewedThrice(w, contactId);
    const other = w.agents[1]!;
    const today = await call<{ coaching: { fix: unknown; noFix: { reason: string } } }>(other, 'GET', '/coaching/today');
    expect(today.body.coaching).toMatchObject({ fix: null, noFix: { reason: 'not_enough_calls' } });
    expect((await call(other, 'GET', '/coaching/team')).status).toBe(404);
  });

  it('R-TEN-1: cross-tenant isolation: another tenant\'s Owner and agents read none of this tenant\'s reviews or tips', async () => {
    const { w, contactId } = await readyWorld({ tl: true });
    const ids = await reviewedThrice(w, contactId);
    await reconcile(h, w.tenantId);
    const other = await coachingWorld(h);
    await scoringOn(h, other.owner, { tl: true });
    const team = await call<{ team: { members: { userId: string; fix: unknown }[] } }>(other.owner, 'GET', '/coaching/team');
    expect(team.body.team.members.map((m) => m.userId)).not.toContain(w.agents[0]!.userId);
    expect(team.body.team.members.every((m) => m.fix === null)).toBe(true);
    const { withTenantTx } = await import('@realty/db');
    const { sql } = await import('kysely');
    const n = await withTenantTx(actorOf(other.owner), async (tx) => (await sql<{ n: number }>`SELECT (SELECT count(*) FROM call_scores WHERE call_id = ANY (${ids}::uuid[])) + (SELECT count(*) FROM priority_feed_items WHERE item_type = 'coaching_fix')::int AS n`.execute(tx)).rows[0]!.n, { db: h.database });
    expect(Number(n)).toBe(0);
  });
});

describe('the Owner\'s coaching settings', () => {
  it('R-COACH-3 D-COACH: the Owner and Admins open the settings, Team Leads and agents do not; Team Lead visibility defaults off; widening needs re-auth; every change is audited with values only', async () => {
    await setPackCleared(h, true);
    const w = await coachingWorld(h);
    const admin = await h.invite(w.owner, 'admin');
    for (const c of [w.teamLead!, w.agents[0]!]) {
      expect((await call(c, 'GET', '/admin/coaching')).status).toBe(404);
      expect((await call(c, 'PUT', '/admin/coaching', { scoringEnabled: false, tlSeesCallScores: false, disabledKeys: [] })).status).toBe(404);
    }
    expect((await call(admin, 'GET', '/admin/coaching')).status).toBe(200);
    const g = await call<{ settings: { scoringEnabled: boolean; tlSeesCallScores: boolean; pack: { cleared: boolean } } }>(w.owner, 'GET', '/admin/coaching');
    expect(g.body.settings).toMatchObject({ scoringEnabled: false, tlSeesCallScores: false, pack: { cleared: true } });
    // a stale re-auth: turning on is refused, turning off is not
    await h.su.query("UPDATE sessions SET reauthenticated_at = now() - interval '1 hour' WHERE user_id = $1", [w.owner.userId]);
    const stale = await call<{ error: { code: string } }>(w.owner, 'PUT', '/admin/coaching', { scoringEnabled: true, tlSeesCallScores: false, disabledKeys: [] });
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe('REAUTH_REQUIRED');
    expect((await call(w.owner, 'PUT', '/admin/coaching', { scoringEnabled: false, tlSeesCallScores: false, disabledKeys: ['recapped_call'] })).status).toBe(200);
    await scoringOn(h, w.owner, { tl: true });
    const audits = (await h.su.query("SELECT changes, actor_user_id FROM audit_log WHERE tenant_id = $1 AND action = 'coaching.settings_changed' ORDER BY seq", [w.tenantId])).rows;
    expect(audits).toHaveLength(2);
    // values for the switch; the Team Lead column is redacted by api/platform's fail-closed classifier (still audited)
    expect(audits[1].changes).toMatchObject({ call_scoring_enabled: { from: false, to: true }, tl_sees_call_scores: { changed: true } });
    expect(audits.every((a) => a.actor_user_id === w.owner.userId)).toBe(true);
  });

  it('R-COACH-3 E283: the DB refuses an Admin every coaching setting but turning call reviews off, the rubric items included', async () => {
    await setPackCleared(h, true);
    const w = await coachingWorld(h);
    const admin = await h.invite(w.owner, 'admin');
    const { withTenantTx } = await import('@realty/db');
    const { sql } = await import('kysely');
    for (const stmt of [sql`UPDATE tenant_settings SET tl_sees_call_scores = true`, sql`UPDATE tenant_settings SET call_scoring_enabled = true`, sql`UPDATE tenant_settings SET coaching_rubric_disabled = '{recapped_call}'`]) {
      await expect(withTenantTx(actorOf(admin), (tx) => stmt.execute(tx), { db: h.database })).rejects.toThrow(/OWNER_ONLY_SETTING/);
    }
  });

  it('R-COACH-3: an unknown rubric item, or turning every item off, is refused', async () => {
    await setPackCleared(h, true);
    const w = await coachingWorld(h);
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'PUT', '/admin/coaching', { scoringEnabled: false, tlSeesCallScores: false, disabledKeys: ['tone_of_voice'] })).status).toBe(422);
    const all = ['introduced_self', 'asked_timeline', 'asked_financing', 'asked_motivation', 'confirmed_contact_preference', 'proposed_next_step', 'set_follow_up', 'recapped_call'];
    expect((await call(w.owner, 'PUT', '/admin/coaching', { scoringEnabled: false, tlSeesCallScores: false, disabledKeys: all })).status).toBe(422);
    void randomUUID;
  });
});

describe('an Admin may only turn call reviews off (E283, owner decision 2026-11-11, the Gmail sync rule)', () => {
  type Body = { scoringEnabled: boolean; tlSeesCallScores: boolean; disabledKeys: string[] };
  const row = async (tenantId: string) =>
    (await h.su.query('SELECT call_scoring_enabled AS scoring, tl_sees_call_scores AS tl, coaching_rubric_disabled AS "off" FROM tenant_settings WHERE tenant_id = $1', [tenantId])).rows[0];
  const auditRows = async (tenantId: string) =>
    (await h.su.query("SELECT action, entity_type, entity_id, actor_kind, actor_user_id, actor_role, changes FROM audit_log WHERE tenant_id = $1 AND action = 'coaching.settings_changed' ORDER BY seq", [tenantId])).rows;
  const put = async (c: Parameters<typeof call>[0], body: Body) => {
    const r = await call<{ error?: { code: string } }>(c, 'PUT', '/admin/coaching', body);
    return `${r.status} ${r.body.error?.code ?? 'ok'}`;
  };
  /** the database guard off for the duration of `fn`: then only the API stands between the Admin and the row */
  async function withoutGuard(fn: () => Promise<void>): Promise<void> {
    await h.su.query('ALTER TABLE tenant_settings DISABLE TRIGGER tenant_settings_p23_guard');
    try {
      await fn();
    } finally {
      await h.su.query('ALTER TABLE tenant_settings ENABLE TRIGGER tenant_settings_p23_guard');
    }
  }

  it('E283 R-COACH-1 R-COACH-4: an Admin turns call reviews off with no re-auth: today\'s open tips close at once, and the change is audited like the Owner\'s (values only, the Admin as the actor)', async () => {
    const { w, contactId } = await readyWorld();
    const a = w.agents[0]!;
    for (let i = 0; i < 3; i++) await review(h, w.tenantId, await recordedCall(h, w, contactId, a.userId, { skip: ['asked_financing'], startedAt: new Date(Date.now() - (i + 2) * 3_600_000) }));
    await reconcile(h, w.tenantId);
    expect((await cardsOf(h, a.userId)).filter((c) => c.state === 'open')).toHaveLength(1);
    const admin = await h.invite(w.owner, 'admin');
    // the Admin's last re-auth is an hour old: turning call reviews off only tightens, so none is asked for
    await h.su.query("UPDATE sessions SET reauthenticated_at = now() - interval '1 hour' WHERE user_id = $1", [admin.userId]);
    const g = await call<{ settings: { scoringEnabled: boolean; tlSeesCallScores: boolean } }>(admin, 'GET', '/admin/coaching');
    expect(g.status).toBe(200);
    expect(g.body.settings).toMatchObject({ scoringEnabled: true, tlSeesCallScores: false });
    const off = await call<{ settings: { scoringEnabled: boolean; scoringSentence: string } }>(admin, 'PUT', '/admin/coaching', { scoringEnabled: false, tlSeesCallScores: false, disabledKeys: [] });
    expect(off.status).toBe(200);
    expect(off.body.settings).toMatchObject({ scoringEnabled: false, scoringSentence: 'Call scoring is off. No call is reviewed and no tips are shown.' });
    expect(await row(w.tenantId)).toEqual({ scoring: false, tl: false, off: [] });
    expect((await cardsOf(h, a.userId)).filter((c) => c.state === 'open')).toHaveLength(0);
    expect((await call<{ coaching: { state: string } }>(a, 'GET', '/coaching/today')).body.coaching.state).toBe('scoring_off');
    const [byOwner, byAdmin, ...more] = await auditRows(w.tenantId);
    expect(more).toEqual([]);
    expect(byOwner).toMatchObject({ actor_user_id: w.owner.userId, actor_role: 'owner', changes: { call_scoring_enabled: { from: false, to: true } } });
    expect(byAdmin).toEqual({ ...byOwner, actor_user_id: admin.userId, actor_role: 'admin', changes: { call_scoring_enabled: { from: true, to: false } } });
    // asking again for what is already so changes nothing and writes no audit row
    expect(await put(admin, { scoringEnabled: false, tlSeesCallScores: false, disabledKeys: [] })).toBe('200 ok');
    expect(await auditRows(w.tenantId)).toHaveLength(2);
  });

  it('E283 R-INT-6: an Admin turns paused call reviews off (the switch on, platform:coaching no longer cleared)', async () => {
    const { w } = await readyWorld();
    await setPackCleared(h, false);
    const admin = await h.invite(w.owner, 'admin');
    expect(await put(admin, { scoringEnabled: false, tlSeesCallScores: false, disabledKeys: [] })).toBe('200 ok');
    expect(await row(w.tenantId)).toEqual({ scoring: false, tl: false, off: [] });
  });

  it('E283 R-COACH-1 R-COACH-3: an Admin\'s request to turn call reviews on, or to change Team Lead visibility or the checklist (alone or with turning reviews off), is refused with OWNER_REQUIRED before the database: with the guard switched off nothing changes either, and nothing is audited', async () => {
    await setPackCleared(h, true);
    const w = await coachingWorld(h);
    const admin = await h.invite(w.owner, 'admin');
    await freshReauth(h, admin); // a fresh re-auth makes no difference
    await withoutGuard(async () => {
      for (const body of [
        { scoringEnabled: true, tlSeesCallScores: false, disabledKeys: [] },
        { scoringEnabled: false, tlSeesCallScores: true, disabledKeys: [] },
        { scoringEnabled: false, tlSeesCallScores: false, disabledKeys: ['recapped_call'] },
      ]) {
        expect({ body, got: await put(admin, body) }).toEqual({ body, got: '403 OWNER_REQUIRED' });
      }
      expect(await row(w.tenantId)).toEqual({ scoring: false, tl: false, off: [] });
    });
    await scoringOn(h, w.owner, { tl: true, disabledKeys: ['recapped_call'] });
    const audited = (await auditRows(w.tenantId)).length;
    await withoutGuard(async () => {
      for (const body of [
        { scoringEnabled: true, tlSeesCallScores: false, disabledKeys: ['recapped_call'] },
        { scoringEnabled: true, tlSeesCallScores: true, disabledKeys: [] },
        { scoringEnabled: true, tlSeesCallScores: true, disabledKeys: ['recapped_call', 'asked_timeline'] },
        { scoringEnabled: false, tlSeesCallScores: false, disabledKeys: ['recapped_call'] },
        { scoringEnabled: false, tlSeesCallScores: true, disabledKeys: [] },
        { scoringEnabled: false, tlSeesCallScores: false, disabledKeys: [] },
      ]) {
        expect({ body, got: await put(admin, body) }).toEqual({ body, got: '403 OWNER_REQUIRED' });
      }
      expect(await row(w.tenantId)).toEqual({ scoring: true, tl: true, off: ['recapped_call'] });
    });
    expect(await auditRows(w.tenantId)).toHaveLength(audited);
    // the Owner's own requests are unaffected
    await freshReauth(h, w.owner);
    expect(await put(w.owner, { scoringEnabled: true, tlSeesCallScores: false, disabledKeys: [] })).toBe('200 ok');
  });

  it('E283 R-COACH-3: the guard is the backstop: a service fooled into the Owner\'s path (a forged role on the Admin\'s session) is still refused by the database (OWNER_ONLY_SETTING, answered OWNER_REQUIRED), except for turning call reviews off alone', async () => {
    await setPackCleared(h, true);
    const w = await coachingWorld(h);
    const admin = await h.invite(w.owner, 'admin');
    await scoringOn(h, w.owner, { tl: true });
    const { withTenantTx } = await import('@realty/db');
    const { saveCoachingSettings } = await import('./settings.js');
    const { mapAdminDbError } = await import('../admin/common.js');
    // the actor claims Owner; the database reads the membership (app.my_role()), which says Admin
    const forged = { ...actorOf(admin), role: 'owner' as const };
    const save = (body: Body) => withTenantTx(forged, (tx, now) => saveCoachingSettings(tx, forged, body, now), { db: h.database }).then(() => null, (e: unknown) => e);
    for (const body of [
      { scoringEnabled: true, tlSeesCallScores: false, disabledKeys: [] },
      { scoringEnabled: true, tlSeesCallScores: true, disabledKeys: ['recapped_call'] },
      { scoringEnabled: false, tlSeesCallScores: false, disabledKeys: [] },
    ]) {
      const err = await save(body);
      expect(String((err as Error | null)?.message)).toMatch(/^OWNER_ONLY_SETTING/);
      expect(mapAdminDbError(err)?.code).toBe('OWNER_REQUIRED');
    }
    expect(await row(w.tenantId)).toEqual({ scoring: true, tl: true, off: [] });
    expect(await save({ scoringEnabled: false, tlSeesCallScores: true, disabledKeys: [] })).toBeNull();
    expect(await row(w.tenantId)).toEqual({ scoring: false, tl: true, off: [] });
    await setPackCleared(h, true);
    expect(String(((await save({ scoringEnabled: true, tlSeesCallScores: true, disabledKeys: [] })) as Error | null)?.message)).toMatch(/^OWNER_ONLY_SETTING/);
    expect(await row(w.tenantId)).toEqual({ scoring: false, tl: true, off: [] });
  });
});
