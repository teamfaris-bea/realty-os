// The 30-minute auto-release and a covered source, on the timer path (b19 team-queue lane, step 2; owner decision 3,
// 2026-11-19; DATA_MODEL R-TEAMQ-13, E843 to E845): the real `ownership.auto_release` and
// `ownership.first_touch_breach` jobs, run by a real worker against Postgres, with the deadlines moved by the clock
// fixtures of testing.ts. The tenant setting is unchanged and still decides for every uncovered source.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { ownershipFollowupHandler } from '../worker/handlers/followup.js';
import { silentLogger } from '../worker/observability.js';
import { HandlerRegistry } from '../worker/registry.js';
import { createSweeper } from '../worker/sweeper.js';
import type { JobHandler } from '../worker/types.js';
import { leadsHandlers } from './handlers.js';
import { RELEASE_RECHECK_JOB } from './releaseRecheck.js';
import { type LeadsWorld, call, command, contactState, freshReauth, intake, jobs, ledger, leadsWorker, leadsWorld, setPeriodDeadlines, suFixture } from './testing.js';

let h: ApiHarness;
let w: LeadsWorld;
let otherSource: { id: string; token: string };

beforeAll(async () => {
  h = await createApiHarness();
  w = await leadsWorld(h, { agents: 2, teamLead: true });
  const s = await call<{ source: { id: string }; ingestToken: string }>(w.owner, 'POST', '/lead-sources', { name: 'Uncovered portal (auto-release test)', kind: 'portal' });
  otherSource = { id: s.body.source.id, token: s.body.ingestToken };
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const cover = (sourceId: string, o: { owner: string | null; backup: string | null; covered: boolean }) =>
  call(w.owner, 'PUT', `/lead-sources/${sourceId}/coverage`, { ownerUserId: o.owner, backupUserId: o.backup, highIntent: false, covered: o.covered });

/** A lead from `token`'s source, accepted by the agent it was offered to. */
async function ownedLead(token = w.token): Promise<{ contactId: string; owner: TestClient }> {
  const r = await intake(h, { ...w, token });
  const st = await contactState(h, r.contactId);
  const owner = w.agents.find((a) => a.userId === st.offered_to_user_id)!;
  const acc = await command(owner, r.contactId, 'accept', { offerId: st.offer_id });
  if (acc.status !== 200) throw new Error(`accept ${acc.status}`);
  return { contactId: r.contactId, owner };
}
const notesOf = async (contactId: string) =>
  (await h.su.query<{ user_id: string; kind: string; priority: string }>('SELECT user_id, kind, priority FROM notifications WHERE tenant_id = $1 AND subject_id = $2 ORDER BY kind, user_id', [w.tenantId, contactId])).rows;

describe('R-TEAMQ-13 auto-release and a covered source (the timer path)', () => {
  it('R-TEAMQ-13 E843: a lead of a COVERED source is not released at the release deadline: it stays with its owner, the release deadline is cleared in the ledger, the breach alert still reaches the owner and the Team Lead, and nobody hears about a pond', async () => {
    const [a, b] = w.agents as [TestClient, TestClient];
    expect((await cover(w.sourceId, { owner: a.userId, backup: b.userId, covered: true })).status).toBe(200);
    const { contactId, owner } = await ownedLead();
    const before = await contactState(h, contactId);
    expect(before.release_due_at).not.toBeNull(); // the tenant setting still schedules it: coverage is read when it fires
    await setPeriodDeadlines(h, contactId, -2000, -1000);
    await leadsWorker(h).drain();
    const st = await contactState(h, contactId);
    expect([st.ownership_state, st.owner_user_id, st.pond_id, st.release_due_at]).toEqual(['owned', owner.userId, null, null]);
    expect(st.ownership_period_seq).toBe(before.ownership_period_seq);
    const types = (await ledger(h, contactId)).map((e) => `${e.type}:${e.reason_code}`);
    expect(types).toContain('first_touch_breached:FIRST_TOUCH_BREACHED');
    expect(types).toContain('sla_waived:AUTO_RELEASE_OFF_COVERED_SOURCE');
    expect(types.some((t) => t.startsWith('auto_released'))).toBe(false);
    // the existing breach alert: the owner (critical) and their Team Lead (high); no pond alert, no "went back to the pond"
    expect(await notesOf(contactId)).toEqual(
      [
        { user_id: owner.userId, kind: 'first_touch_due', priority: 'critical' },
        { user_id: w.teamLead!.userId, kind: 'first_touch_escalation', priority: 'high' },
        // the offer itself, from before
        { user_id: owner.userId, kind: 'lead_offer', priority: 'critical' },
      ].sort((x, y) => (x.kind + x.user_id < y.kind + y.user_id ? -1 : 1)),
    );
    // the sweeper has nothing left to ask for this lead: no stored release deadline, no live release job
    expect((await jobs(h, w.tenantId, 'ownership.auto_release')).filter((j) => j.payload.contactId === contactId && j.status === 'pending')).toEqual([]);
    const due = await h.su.query(`SELECT 1 FROM contacts WHERE id = $1 AND ownership_state = 'owned' AND first_touch_at IS NULL AND release_due_at <= now()`, [contactId]);
    expect(due.rows).toEqual([]);
    // no first touch was invented: the owner can still make it, on the same period
    expect((await h.su.query<{ t: Date | null }>('SELECT first_touch_at AS t FROM contacts WHERE id = $1', [contactId])).rows[0]!.t).toBeNull();
  });

  it('R-TEAMQ-13 E844: the tenant setting is unchanged for an uncovered source: its untouched lead is released to the pond as before', async () => {
    const settings = (await call<{ settings: { firstTouchReleaseSeconds: number | null } }>(w.owner, 'GET', '/settings')).body.settings;
    expect(settings.firstTouchReleaseSeconds).toBe(1800);
    const { contactId, owner } = await ownedLead(otherSource.token);
    await setPeriodDeadlines(h, contactId, -2000, -1000);
    await leadsWorker(h).drain();
    const st = await contactState(h, contactId);
    expect([st.ownership_state, st.owner_user_id, st.pond_id]).toEqual(['in_pond', null, w.defaultPondId]);
    expect((await ledger(h, contactId)).at(-1)).toMatchObject({ type: 'auto_released', reason_code: 'FIRST_TOUCH_MISSED' });
    expect((await notesOf(contactId)).some((n) => n.user_id === owner.userId && n.kind === 'reassigned_away')).toBe(true);
  });

  it('R-TEAMQ-13 E844: a source whose coverage is switched off, or whose backup is suspended, is not covered when the timer fires: the lead is released as before', async () => {
    const [a, b] = w.agents as [TestClient, TestClient];
    // switched off after the lead was accepted
    expect((await cover(w.sourceId, { owner: a.userId, backup: b.userId, covered: true })).status).toBe(200);
    const first = await ownedLead();
    expect((await cover(w.sourceId, { owner: a.userId, backup: b.userId, covered: false })).status).toBe(200);
    await setPeriodDeadlines(h, first.contactId, -2000, -1000);
    await leadsWorker(h).drain();
    expect((await contactState(h, first.contactId)).ownership_state).toBe('in_pond');
    // the switch is on, but the named backup (the Team Lead here) is suspended: flagged, not covered
    expect((await cover(w.sourceId, { owner: a.userId, backup: w.teamLead!.userId, covered: true })).status).toBe(200);
    const second = await ownedLead();
    await freshReauth(h, w.owner);
    const members = await call<{ members: { userId: string; version: number }[] }>(w.owner, 'GET', '/members');
    const version = members.body.members.find((m) => m.userId === w.teamLead!.userId)!.version;
    expect((await call(w.owner, 'PATCH', `/members/${w.teamLead!.userId}`, { status: 'suspended', version })).status).toBe(200);
    await setPeriodDeadlines(h, second.contactId, -2000, -1000);
    await leadsWorker(h).drain();
    const st = await contactState(h, second.contactId);
    expect([st.ownership_state, st.pond_id]).toEqual(['in_pond', w.defaultPondId]);
    expect((await h.su.query<{ covered: boolean }>('SELECT covered FROM lead_sources WHERE id = $1', [w.sourceId])).rows[0]!.covered).toBe(true);
  });
});

describe('R-TEAMQ-20 the waiver needs the LEAD\'s owner to be active, and is re-evaluated (review fix M1)', () => {
  interface World {
    world: LeadsWorld;
    src: { id: string; token: string };
  }
  /**
   * A covered source of a team of its own (a suspension ends a member's sessions, so no case shares its members with
   * another), whose named owner and backup are two agents outside the rotation: they never hold its leads.
   */
  async function coveredSource(name: string, o: { teamLead?: boolean; agents?: number } = {}): Promise<World & { people: [TestClient, TestClient] }> {
    const world = await leadsWorld(h, { agents: o.agents ?? 2, teamLead: o.teamLead ?? true });
    const people: [TestClient, TestClient] = [await h.invite(world.owner, 'agent'), await h.invite(world.owner, 'agent')];
    await freshReauth(h, world.owner);
    const s = await call<{ source: { id: string }; ingestToken: string }>(world.owner, 'POST', '/lead-sources', { name, kind: 'website' });
    expect(s.status).toBe(201);
    const c = await call(world.owner, 'PUT', `/lead-sources/${s.body.source.id}/coverage`, { ownerUserId: people[0].userId, backupUserId: people[1].userId, highIntent: false, covered: true });
    expect(c.status).toBe(200);
    return { world, src: { id: s.body.source.id, token: s.body.ingestToken }, people };
  }
  async function leadOf(x: World): Promise<{ contactId: string; owner: TestClient }> {
    const r = await intake(h, { ...x.world, token: x.src.token });
    const st = await contactState(h, r.contactId);
    const owner = x.world.agents.find((a) => a.userId === st.offered_to_user_id)!;
    const acc = await command(owner, r.contactId, 'accept', { offerId: st.offer_id });
    if (acc.status !== 200) throw new Error(`accept ${acc.status}`);
    return { contactId: r.contactId, owner };
  }
  async function setStatus(world: LeadsWorld, c: TestClient, status: 'suspended' | 'active'): Promise<void> {
    await freshReauth(h, world.owner);
    const members = await call<{ members: { userId: string; version: number }[] }>(world.owner, 'GET', '/members');
    const version = members.body.members.find((m) => m.userId === c.userId)!.version;
    const r = await call(world.owner, 'PATCH', `/members/${c.userId}`, { status, version });
    if (r.status !== 200) throw new Error(`member status: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const typesOf = async (contactId: string) => (await ledger(h, contactId)).map((e) => `${e.type}:${e.reason_code}`);
  const notes = async (tenantId: string, contactId: string) =>
    (await h.su.query<{ user_id: string; kind: string; priority: string }>('SELECT user_id, kind, priority FROM notifications WHERE tenant_id = $1 AND subject_id = $2 ORDER BY kind, user_id', [tenantId, contactId])).rows;
  /** The lead's release is waived at its deadline (the source is covered and its owner active then). */
  async function waived(x: World): Promise<{ contactId: string; owner: TestClient }> {
    const lead = await leadOf(x);
    await setPeriodDeadlines(h, lead.contactId, -2000, -1000);
    await leadsWorker(h).drain();
    const st = await contactState(h, lead.contactId);
    expect([st.ownership_state, st.owner_user_id, st.release_due_at]).toEqual(['owned', lead.owner.userId, null]);
    expect(await typesOf(lead.contactId)).toContain('sla_waived:AUTO_RELEASE_OFF_COVERED_SOURCE');
    return lead;
  }
  const releaseJobs = async (tenantId: string, contactId: string) => (await jobs(h, tenantId, 'ownership.auto_release')).filter((j) => j.payload.contactId === contactId && j.status === 'pending');
  /** clock fixture: the RESTORED release deadline moves into the past: the contact column, the `sla_restored` event that stores it, and its timer job together */
  async function restoredDeadlinePasses(contactId: string): Promise<void> {
    const t = (await h.su.query<{ at: Date }>(`SELECT clock_timestamp() - interval '1 second' AS at`)).rows[0]!.at;
    await suFixture(h, [
      { text: 'UPDATE contacts SET release_due_at = $2 WHERE id = $1', values: [contactId, t] },
      { text: `UPDATE lead_ownership_events e SET payload = jsonb_set(e.payload, '{releaseDueAt}', to_jsonb($2::bigint)) WHERE e.contact_id = $1 AND e.type = 'sla_restored' AND e.seq = (SELECT max(seq) FROM lead_ownership_events WHERE contact_id = $1 AND type = 'sla_restored')`, values: [contactId, t.getTime()] },
      { text: `UPDATE jobs SET run_at = to_timestamp($2::bigint / 1000.0), payload = jsonb_set(payload, '{dueAt}', to_jsonb($2::bigint)) WHERE kind = 'ownership.auto_release' AND payload->>'contactId' = $1::text AND status = 'pending'`, values: [contactId, t.getTime()] },
    ]);
  }

  it('R-TEAMQ-20 E874: the lead\'s owner is SUSPENDED before the release time: the source is covered, but the release is not waived: the lead goes to the default pond as on an uncovered source, and the team lead is told', async () => {
    const x = await coveredSource('Covered, owner suspended before (M1 test)');
    const w = x.world;
    const lead = await leadOf(x);
    await setStatus(w, lead.owner, 'suspended');
    await setPeriodDeadlines(h, lead.contactId, -2000, -1000);
    await leadsWorker(h).drain();
    const st = await contactState(h, lead.contactId);
    expect([st.ownership_state, st.owner_user_id, st.pond_id]).toEqual(['in_pond', null, w.defaultPondId]);
    const types = await typesOf(lead.contactId);
    expect(types).toContain('auto_released:FIRST_TOUCH_MISSED');
    expect(types.some((t) => t.startsWith('sla_waived'))).toBe(false);
    // the source itself is still covered: its switch is on and both named members are active
    const cov = await call<{ coverage: { covered: boolean } }>(w.owner, 'GET', `/lead-sources/${x.src.id}/coverage`);
    expect(cov.body.coverage.covered).toBe(true);
    // somebody other than the suspended owner hears that the lead is in the pond: their Team Lead
    const told = (await notes(w.tenantId, lead.contactId)).filter((n) => n.user_id !== lead.owner.userId);
    expect(told).toContainEqual({ user_id: w.teamLead!.userId, kind: 'first_touch_escalation', priority: 'high' });
  });

  it('R-TEAMQ-20 E874: an owner with NO team lead, suspended: the lead is released and the pond arrival tells the Owner (a team with no Team Lead alerts its Owners and Admins), never nobody', async () => {
    const x = await coveredSource('Covered, no team lead (M1 test)', { agents: 1, teamLead: false });
    const solo = x.world;
    const lead = await leadOf(x);
    await setStatus(solo, lead.owner, 'suspended');
    await setPeriodDeadlines(h, lead.contactId, -2000, -1000);
    await leadsWorker(h).drain();
    const st = await contactState(h, lead.contactId);
    expect([st.ownership_state, st.pond_id]).toEqual(['in_pond', solo.defaultPondId]);
    const told = (await notes(solo.tenantId, lead.contactId)).filter((n) => n.user_id !== lead.owner.userId);
    expect(told).toEqual([{ user_id: solo.owner.userId, kind: 'pond_new', priority: 'high' }]);
  });

  it('R-TEAMQ-20 E876: the owner is suspended AFTER a waiver: the release applies again from that moment (a ledgered `sla_restored` with a new deadline and its timer); the sweeper re-issues a lost timer from the stored deadline; at the deadline the lead goes to the pond', async () => {
    const x = await coveredSource('Covered, owner suspended after (M1 test)');
    const w = x.world;
    const lead = await waived(x);
    const bystander = await waived(x); // another agent's waived lead of the same source: its waiver still holds
    expect(bystander.owner.userId).not.toBe(lead.owner.userId);
    const before = Date.now();
    await setStatus(w, lead.owner, 'suspended');
    {
      // the status change queued ONE re-check for the team, in its own transaction
      expect((await jobs(h, w.tenantId, RELEASE_RECHECK_JOB.kind)).filter((j) => j.status === 'pending')).toHaveLength(1);
      await leadsWorker(h).drain();
      const st = await contactState(h, lead.contactId);
      // nothing moved: same owner, same period; the release deadline is stored again, the tenant's 30 minutes of staffed time from that moment
      expect([st.ownership_state, st.owner_user_id]).toEqual(['owned', lead.owner.userId]);
      expect(st.release_due_at).not.toBeNull();
      expect(st.release_due_at!.getTime()).toBeGreaterThanOrEqual(before + 1800_000 - 5_000);
      expect((await ledger(h, lead.contactId)).at(-1)).toMatchObject({ type: 'sla_restored', reason_code: 'AUTO_RELEASE_BACK_ON', actor_kind: 'system', owner_user_id: lead.owner.userId });
      const pending = await releaseJobs(w.tenantId, lead.contactId);
      expect(pending.map((j) => j.payload.dueAt)).toEqual([st.release_due_at!.getTime()]);
      // the other agent's lead is untouched by the re-check: still waived, no new event
      expect((await contactState(h, bystander.contactId)).release_due_at).toBeNull();
      expect((await typesOf(bystander.contactId)).some((t) => t.startsWith('sla_restored'))).toBe(false);

      // the timer job is LOST; the restored deadline passes; the sweeper re-issues it from the stored deadline
      await h.su.query(`DELETE FROM jobs WHERE kind = 'ownership.auto_release' AND payload->>'contactId' = $1`, [lead.contactId]);
      await restoredDeadlinePasses(lead.contactId);
      const registry = new HandlerRegistry().registerAll([...leadsHandlers, ownershipFollowupHandler() as unknown as JobHandler<unknown>]);
      const swept = await createSweeper({ db: h.database, registry, log: silentLogger }).sweepOnce();
      expect(swept.byKind['ownership.auto_release']).toBeGreaterThanOrEqual(1);
      expect(await releaseJobs(w.tenantId, lead.contactId)).toHaveLength(1);
      await leadsWorker(h).drain();
      const after = await contactState(h, lead.contactId);
      expect([after.ownership_state, after.owner_user_id, after.pond_id]).toEqual(['in_pond', null, w.defaultPondId]);
      expect((await ledger(h, lead.contactId)).at(-1)).toMatchObject({ type: 'auto_released', reason_code: 'FIRST_TOUCH_MISSED' });
      expect((await notes(w.tenantId, lead.contactId)).filter((n) => n.user_id === w.teamLead!.userId).map((n) => n.kind)).toContain('first_touch_escalation');
      expect((await contactState(h, bystander.contactId)).ownership_state).toBe('owned');
    }
  });

  it('R-TEAMQ-20 E877: coverage is switched OFF after a waiver: the release applies again from that moment and releases the lead at its new deadline; switched back on before then, it is waived again', async () => {
    const x = await coveredSource('Covered, switched off after (M1 test)');
    const w = x.world;
    const named = x.people;
    const lead = await waived(x);
    const off = await call(w.owner, 'PUT', `/lead-sources/${x.src.id}/coverage`, { ownerUserId: named[0].userId, backupUserId: named[1].userId, highIntent: false, covered: false });
    expect(off.status).toBe(200);
    await leadsWorker(h).drain();
    const st = await contactState(h, lead.contactId);
    expect([st.ownership_state, st.owner_user_id]).toEqual(['owned', lead.owner.userId]);
    expect(st.release_due_at).not.toBeNull();
    expect(st.release_due_at!.getTime()).toBeGreaterThan(Date.now() + 1700_000);
    expect((await ledger(h, lead.contactId)).at(-1)).toMatchObject({ type: 'sla_restored', reason_code: 'AUTO_RELEASE_BACK_ON' });
    await restoredDeadlinePasses(lead.contactId);
    await leadsWorker(h).drain();
    const after = await contactState(h, lead.contactId);
    expect([after.ownership_state, after.pond_id]).toEqual(['in_pond', w.defaultPondId]);

    // a second lead: off, then ON again before the restored deadline: the timer finds it covered and waives it again
    const on = () => call(w.owner, 'PUT', `/lead-sources/${x.src.id}/coverage`, { ownerUserId: named[0].userId, backupUserId: named[1].userId, highIntent: false, covered: true });
    expect((await on()).status).toBe(200);
    const kept = await waived(x);
    expect((await call(w.owner, 'PUT', `/lead-sources/${x.src.id}/coverage`, { ownerUserId: named[0].userId, backupUserId: named[1].userId, highIntent: false, covered: false })).status).toBe(200);
    await leadsWorker(h).drain();
    expect((await contactState(h, kept.contactId)).release_due_at).not.toBeNull();
    expect((await on()).status).toBe(200);
    await restoredDeadlinePasses(kept.contactId);
    await leadsWorker(h).drain();
    const k = await contactState(h, kept.contactId);
    expect([k.ownership_state, k.owner_user_id, k.release_due_at]).toEqual(['owned', kept.owner.userId, null]);
    expect((await typesOf(kept.contactId)).filter((t) => t.startsWith('sla_')).map((t) => t.split(':')[0])).toEqual(['sla_waived', 'sla_restored', 'sla_waived']);
  });
});
