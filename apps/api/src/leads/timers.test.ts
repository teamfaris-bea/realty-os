// api/leads timer handlers (BUILD_PLAN module 11: offer_expiry, first_touch_breach, auto_release,
// inactivity) run by a real worker against real Postgres. Deadlines are moved with the clock
// fixtures in testing.ts (contact column + ledger instant + job fence together).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { timerCommandId } from './handlers.js';
import {
  type LeadsWorld,
  call,
  command,
  contactState,
  intake,
  jobs,
  ledger,
  leadsWorker,
  leadsWorld,
  setOfferExpiry,
  setPeriodDeadlines,
  suFixture,
  zoneWithLocalHour,
} from './testing.js';

let h: ApiHarness;
let w: LeadsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await leadsWorld(h, { agents: 3, teamLead: true });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

async function ownedLead(wd: LeadsWorld = w): Promise<{ contactId: string; owner: TestClient }> {
  const r = await intake(h, wd);
  const st = await contactState(h, r.contactId);
  const owner = wd.agents.find((a) => a.userId === st.offered_to_user_id)!;
  const acc = await command(owner, r.contactId, 'accept', { offerId: st.offer_id });
  if (acc.status !== 200) throw new Error(`accept ${acc.status}`);
  return { contactId: r.contactId, owner };
}

describe('offer expiry (R-OWN-9, R-OWN-12, R-OWN-15)', () => {
  it('R-OWN-9 R-OWN-12: each expiry offers the next agent; after max_offers the lead goes to the pond (MAX_OFFERS_REACHED); three misses in a row auto-pause the agent (audited, agent + TL notified)', async () => {
    const t = await leadsWorld(h, { agents: 3, teamLead: true });
    const settings = (await call<{ settings: { version: number } }>(t.owner, 'GET', '/settings')).body.settings;
    expect((await call(t.owner, 'PATCH', '/settings', { version: settings.version, autoPauseAfterMisses: 3 })).status).toBe(200);
    const r = await intake(h, t);
    const offerees: string[] = [];
    for (let i = 0; i < 3; i++) {
      const st = await contactState(h, r.contactId);
      expect(st.ownership_state).toBe('offered');
      offerees.push(st.offered_to_user_id!);
      await setOfferExpiry(h, r.contactId, -1000);
      await leadsWorker(h).drain();
    }
    expect(new Set(offerees).size).toBe(3);
    const end = await contactState(h, r.contactId);
    expect([end.ownership_state, end.pond_id]).toEqual(['in_pond', t.defaultPondId]);
    expect((await ledger(h, r.contactId)).at(-1)).toMatchObject({ type: 'sent_to_pond', reason_code: 'MAX_OFFERS_REACHED', actor_kind: 'timer' });
    // one agent missing three offers in a row is auto-paused (the chain above was their first miss)
    const victim = t.agents[0]!;
    const misses = async () => Number((await h.su.query('SELECT consecutive_missed_offers AS n FROM memberships WHERE user_id = $1', [victim.userId])).rows[0].n);
    expect(await misses()).toBe(1);
    for (let i = 0; i < 2; i++) {
      let lead: string | null = null;
      for (let k = 0; k < 6 && lead === null; k++) {
        const x = await intake(h, t);
        if ((await contactState(h, x.contactId)).offered_to_user_id === victim.userId) lead = x.contactId;
      }
      expect(lead).not.toBeNull();
      await setOfferExpiry(h, lead!, -1000);
      await leadsWorker(h).drain();
    }
    const m = (await h.su.query('SELECT accepting_leads, auto_paused_at IS NOT NULL AS paused FROM memberships WHERE user_id = $1', [victim.userId])).rows[0];
    expect(m).toEqual({ accepting_leads: false, paused: true });
    expect((await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'member.auto_paused' AND tenant_id = $1 AND reason = 'AUTO_PAUSED'", [t.tenantId])).rows[0].n).toBe(1);
    const notified = (await h.su.query<{ user_id: string }>("SELECT DISTINCT user_id FROM notifications WHERE dedupe_key LIKE 'auto_paused:%' AND tenant_id = $1", [t.tenantId])).rows.map((x) => x.user_id).sort();
    expect(notified).toEqual([victim.userId, t.teamLead!.userId].sort());
  });

  it('R-OWN-15 E6: a stale or duplicate offer timer is a no-op (fence), and an early wake reschedules the job to the stored deadline instead of acting', async () => {
    const r = await intake(h, w);
    const st = await contactState(h, r.contactId);
    // early wake: the job runs now, the offer is not due yet
    await h.su.query("UPDATE jobs SET run_at = now() WHERE kind = 'ownership.offer_expiry' AND payload->>'contactId' = $1", [r.contactId]);
    await leadsWorker(h).drain();
    const j = (await jobs(h, w.tenantId, 'ownership.offer_expiry')).filter((x) => x.payload.contactId === r.contactId && x.status === 'pending');
    expect(j).toHaveLength(1);
    expect(j[0]!.dedupe_key).toMatch(/:early:/);
    expect(Math.abs(j[0]!.run_at.getTime() - st.offer_expires_at!.getTime())).toBeLessThan(1000);
    expect((await ledger(h, r.contactId)).map((e) => e.type)).toEqual(['created', 'offered']);
    // accepted: the old offer's timer (if it still ran) is fenced out
    const owner = w.agents.find((a) => a.userId === st.offered_to_user_id)!;
    expect((await command(owner, r.contactId, 'accept', { offerId: st.offer_id })).status).toBe(200);
    await suFixture(h, [
      {
        text: `INSERT INTO jobs (tenant_id, queue, kind, payload, run_at) VALUES ($1, 'realtime', 'ownership.offer_expiry', $2::jsonb, now())`,
        values: [w.tenantId, JSON.stringify({ contactId: r.contactId, deadline: 'offer_expiry', offerId: st.offer_id })],
      },
    ]);
    const before = (await ledger(h, r.contactId)).length;
    await leadsWorker(h).drain();
    expect((await ledger(h, r.contactId)).length).toBe(before);
    expect((await contactState(h, r.contactId)).ownership_state).toBe('owned');
  });

  it('R-OWN-15 E10: changing the tenant time zone with an offer open leaves its stored deadline alone; the next offer uses the new calendar', async () => {
    const t = await leadsWorld(h, { agents: 2 });
    const r = await intake(h, t);
    const st = await contactState(h, r.contactId);
    const night = zoneWithLocalHour(1, 4);
    const s = (await call<{ settings: { version: number } }>(t.owner, 'GET', '/settings')).body.settings;
    expect((await call(t.owner, 'PATCH', '/settings', { version: s.version, defaultTimezone: night })).status).toBe(200);
    expect((await contactState(h, r.contactId)).offer_expires_at!.getTime()).toBe(st.offer_expires_at!.getTime());
    await setOfferExpiry(h, r.contactId, -1000);
    await leadsWorker(h).drain();
    const next = await contactState(h, r.contactId);
    expect(next.ownership_state).toBe('offered');
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: night, hour: '2-digit', minute: '2-digit', hour12: false }).format(next.offer_expires_at!);
    expect(local).toBe('08:05'); // the new zone's routing hours: night now, so the window counts from 08:00
  });
});

describe('first touch (R-OWN-13, R-OWN-15, E70)', () => {
  it('R-OWN-13 R-OWN-15 E70: at the due time first_touch_breached is written once (owner critical, TL high); the breach advances the seq but not the period, so auto-release still fires at T+30 (FIRST_TOUCH_MISSED → pond)', async () => {
    const { contactId, owner } = await ownedLead();
    const st0 = await contactState(h, contactId);
    await setPeriodDeadlines(h, contactId, -1000, 10 * 60_000);
    await leadsWorker(h).drain();
    const st1 = await contactState(h, contactId);
    expect([st1.ownership_state, st1.owner_user_id, st1.ownership_period_seq]).toEqual(['owned', owner.userId, st0.ownership_period_seq]);
    expect(Number(st1.ownership_seq)).toBe(Number(st0.ownership_seq) + 1);
    expect((await ledger(h, contactId)).at(-1)).toMatchObject({ type: 'first_touch_breached', actor_kind: 'timer' });
    const n = (await h.su.query<{ user_id: string; priority: string }>("SELECT user_id, priority FROM notifications WHERE subject_id = $1 AND dedupe_key LIKE 'first_touch_breach:%' ORDER BY priority", [contactId])).rows;
    expect(n).toEqual([
      { user_id: owner.userId, priority: 'critical' },
      { user_id: w.teamLead!.userId, priority: 'high' },
    ]);
    // a second wake of the breach timer never writes a second breach
    await suFixture(h, [
      {
        text: `INSERT INTO jobs (tenant_id, queue, kind, payload, run_at)
               SELECT tenant_id, queue, kind, payload, now() FROM jobs WHERE kind = 'ownership.first_touch_breach' AND payload->>'contactId' = $1 LIMIT 1`,
        values: [contactId],
      },
    ]);
    await leadsWorker(h).drain();
    expect((await ledger(h, contactId)).filter((e) => e.type === 'first_touch_breached')).toHaveLength(1);
    // auto-release on its own (unchanged) fence
    const due = st1.first_touch_due_at!.getTime() - Date.now();
    await setPeriodDeadlines(h, contactId, due, -500);
    await leadsWorker(h).drain();
    const st2 = await contactState(h, contactId);
    expect([st2.ownership_state, st2.pond_id]).toEqual(['in_pond', w.defaultPondId]);
    expect((await ledger(h, contactId)).at(-1)).toMatchObject({ type: 'auto_released', reason_code: 'FIRST_TOUCH_MISSED' });
    // R-ACC-2 input (the untouched_lead derivation itself is api/accountability's): the missed period
    // stays in v_speed_to_lead after the auto-release, owned by the agent of that period
    const stl = (await h.su.query('SELECT user_id, owned_seq::text, first_touch_at, within_sla FROM v_speed_to_lead WHERE contact_id = $1', [contactId])).rows;
    expect(stl).toEqual([{ user_id: owner.userId, owned_seq: st0.ownership_period_seq, first_touch_at: null, within_sla: false }]);
    // the previous owner now sees only the (masked) pond card, and is in cooldown for this lead
    const card = await call<{ contact: { view: string } }>(owner, 'GET', `/contacts/${contactId}`);
    expect([card.status, card.body.contact.view]).toEqual([200, 'card']);
    expect((await command(owner, contactId, 'claim')).code).toBe('CLAIM_COOLDOWN');
  });

  it('R-OWN-15: timer jobs carry ids and fences only, and a replayed timer command id returns the stored outcome', async () => {
    const { contactId } = await ownedLead();
    const j = (await jobs(h, w.tenantId)).filter((x) => x.payload.contactId === contactId && x.kind.startsWith('ownership.'));
    for (const x of j) expect(Object.keys(x.payload).sort()).toEqual(x.kind === 'ownership.offer_expiry' ? ['contactId', 'deadline', 'offerId'] : ['contactId', 'deadline', 'dueAt', 'periodSeq']);
    const breach = j.find((x) => x.kind === 'ownership.first_touch_breach')!;
    expect(timerCommandId(breach.payload as never)).toBe(timerCommandId({ ...(breach.payload as object) } as never));
  });
});

describe('inactivity (R-OWN-23)', () => {
  it('R-OWN-23: the stored warning instant writes inactivity_warned (clears the warning, notifies, pins a feed item) and the stored release instant returns the lead to the pond', async () => {
    const { contactId, owner } = await ownedLead();
    const st = await contactState(h, contactId);
    expect(st.inactivity_warn_at).not.toBeNull();
    expect(st.inactivity_release_at).not.toBeNull();
    const shift = async (which: 'inactivity_warn' | 'inactivity_release', col: 'inactivity_warn_at' | 'inactivity_release_at') => {
      const at = (await h.su.query<{ t: Date }>("SELECT clock_timestamp() - interval '1 second' AS t")).rows[0]!.t;
      await suFixture(h, [
        { text: `UPDATE contacts SET ${col} = $2 WHERE id = $1`, values: [contactId, at] },
        {
          text: `UPDATE jobs SET run_at = now(), payload = jsonb_set(payload, '{dueAt}', to_jsonb($3::bigint))
                  WHERE kind = 'ownership.inactivity' AND payload->>'contactId' = $1 AND payload->>'deadline' = $2 AND status = 'pending'`,
          values: [contactId, which, at.getTime()],
        },
      ]);
    };
    await shift('inactivity_warn', 'inactivity_warn_at');
    await leadsWorker(h).drain();
    const warned = await contactState(h, contactId);
    expect([warned.ownership_state, warned.inactivity_warn_at]).toEqual(['owned', null]);
    expect((await ledger(h, contactId)).at(-1)).toMatchObject({ type: 'inactivity_warned', reason_code: 'INACTIVITY_WARNING' });
    expect((await h.su.query("SELECT count(*)::int AS n FROM priority_feed_items WHERE contact_id = $1 AND user_id = $2 AND item_type = 'inactivity_warning'", [contactId, owner.userId])).rows[0].n).toBe(1);
    await shift('inactivity_release', 'inactivity_release_at');
    await leadsWorker(h).drain();
    const released = await contactState(h, contactId);
    expect([released.ownership_state, released.pond_id]).toEqual(['in_pond', w.defaultPondId]);
    expect((await ledger(h, contactId)).at(-1)).toMatchObject({ type: 'inactivity_released', reason_code: 'INACTIVITY' });
  });
});
