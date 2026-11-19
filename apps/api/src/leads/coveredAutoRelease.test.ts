// The 30-minute auto-release and a covered source, on the timer path (b19 team-queue lane, step 2; owner decision 3,
// 2026-11-19; DATA_MODEL R-TEAMQ-13, E843 to E845): the real `ownership.auto_release` and
// `ownership.first_touch_breach` jobs, run by a real worker against Postgres, with the deadlines moved by the clock
// fixtures of testing.ts. The tenant setting is unchanged and still decides for every uncovered source.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type LeadsWorld, call, command, contactState, freshReauth, intake, jobs, ledger, leadsWorker, leadsWorld, setPeriodDeadlines } from './testing.js';

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
