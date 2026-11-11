// Human actions on exceptions over real Postgres (BUILD_PLAN module 15; R-ACC-1, R-ACC-3, R-OWN-18,
// R-AUDIT-5, R-PERM-5). Every action goes through the real server as the caller; the DB guards are proven
// by writing as app_user under RLS.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditRows } from '../admin/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { eventIdFor } from './exceptions.js';
import {
  type AccWorld,
  accWorld,
  acceptedLead,
  act,
  asUser,
  call,
  contactState,
  eventRows,
  humanTouch,
  itemRow,
  keyPath,
  ledger,
  queue,
  recompute,
  setPeriodDeadlines,
  type ItemT,
} from './testing.js';

let h: ApiHarness;
let w: AccWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await accWorld(h);
});
afterAll(async () => {
  await h?.close();
});

async function missedLead() {
  const lead = await acceptedLead(h, w);
  await setPeriodDeadlines(h, lead.contactId, -60_000, 86_400_000);
  await recompute(h, w.tenantId, { contactId: lead.contactId });
  const key = `untouched:${lead.contactId}:${lead.periodSeq}`;
  if (!(await itemRow(h, key))) throw new Error('no item');
  return { ...lead, key, other: w.agents.find((a) => a.userId !== lead.owner.userId)! };
}

const liveKeys = async (c: Parameters<typeof queue>[0]) => (await queue(c)).items.map((i) => i.dedupeKey);

describe('resolve and reopen', () => {
  it('R-ACC-3 R-AUDIT-5: an agent resolves their own item with a note (audited, the note redacted); it leaves the live queue; reopen puts it back', async () => {
    const lead = await missedLead();
    const noNote = await act(lead.owner, lead.key, 'resolve', {});
    expect([noNote.status, noNote.code]).toEqual([422, 'VALIDATION_FAILED']);
    const blank = await act(lead.owner, lead.key, 'resolve', { note: '   ' });
    expect(blank.status).toBe(422);

    const r = await act(lead.owner, lead.key, 'resolve', { note: 'Called Pat at 555-0101, she was at work' });
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ live: false, latestEvent: { action: 'resolved', actor: { userId: lead.owner.userId } }, actions: { resolve: false, reopen: true, verify: false, reassign: false } });
    expect(r.body.events.map((e) => e.action)).toEqual(['resolved']);
    expect(await liveKeys(lead.owner)).not.toContain(lead.key);
    expect(await liveKeys(w.teamLead!)).not.toContain(lead.key);
    expect(await eventRows(h, lead.key)).toEqual([{ action: 'resolved', actor_user_id: lead.owner.userId, actor_role: 'agent', ownership_command_id: null, note: 'Called Pat at 555-0101, she was at work' }]);
    const itemId = (await itemRow(h, lead.key))!.id;
    const a = (await auditRows(h, w.tenantId, 'exception.')).filter((x) => x.entity_id === itemId);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'exception.resolved', actor_user_id: lead.owner.userId });
    expect(a[0]!.changes).toMatchObject({ note: { changed: true } });
    expect(JSON.stringify(a[0])).not.toContain('555-0101');

    // resolving again is a state conflict, not a second event
    const again = await act(lead.owner, lead.key, 'resolve', { note: 'again' });
    expect([again.status, again.code]).toEqual([409, 'EXCEPTION_STATE_CONFLICT']);

    const re = await act(lead.owner, lead.key, 'reopen', {});
    expect([re.status, re.body.item?.live]).toEqual([200, true]);
    expect(await liveKeys(lead.owner)).toContain(lead.key);
    expect((await auditRows(h, w.tenantId, 'exception.reopened')).length).toBeGreaterThanOrEqual(1);
    const reopenAgain = await act(lead.owner, lead.key, 'reopen', {});
    expect([reopenAgain.status, reopenAgain.code]).toEqual([409, 'EXCEPTION_STATE_CONFLICT']);
  });

  it('R-ACC-1: recompute keeps the human events; a handled item whose condition changes later stays handled with its history', async () => {
    const lead = await missedLead();
    expect((await act(w.teamLead!, lead.key, 'resolve', { note: 'Coached on response time' })).status).toBe(200);
    await humanTouch(h, lead.owner, lead.contactId); // fixed late, after the resolution
    await recompute(h, w.tenantId);
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    expect((await itemRow(h, lead.key))!.condition_cleared_at).not.toBeNull();
    expect((await eventRows(h, lead.key)).map((e) => e.action)).toEqual(['resolved']);
    expect(await liveKeys(w.teamLead!)).not.toContain(lead.key);
    const detail = await call<{ item: { live: boolean }; events: { action: string }[] }>(w.teamLead!, 'GET', keyPath(lead.key));
    expect([detail.body.item.live, detail.body.events.map((e) => e.action)]).toEqual([false, ['resolved']]);
  });
});

describe('verify', () => {
  it('R-ACC-3 R-AUDIT-5: verify is Team Lead/Admin/Owner only — an agent gets 404 from the API, and the DB refuses an agent verified event (CHECK) and a forged role (RLS)', async () => {
    const lead = await missedLead();
    const byAgent = await act(lead.owner, lead.key, 'verify', {});
    expect([byAgent.status, byAgent.code]).toEqual([404, 'NOT_FOUND']);
    const insert = (role: string) =>
      asUser(h, lead.owner, `INSERT INTO exception_events (tenant_id, id, exception_dedupe_key, action, actor_user_id, actor_role, occurred_at)
        VALUES (app.tenant_id(), gen_random_uuid(), '${lead.key}', 'verified', '${lead.owner.userId}', '${role}', now())`);
    expect(await insert('agent')).toMatchObject({ ok: false, code: '23514' });
    expect(await insert('team_lead')).toMatchObject({ ok: false, code: '42501' });
    expect(await eventRows(h, lead.key)).toEqual([]);

    const ok = await act(w.teamLead!, lead.key, 'verify', { note: 'Checked the call log' });
    expect(ok.status).toBe(200);
    expect(ok.body.item).toMatchObject({ live: false, latestEvent: { action: 'verified' } });
    expect((await eventRows(h, lead.key))[0]).toMatchObject({ action: 'verified', actor_role: 'team_lead' });
    expect((await auditRows(h, w.tenantId, 'exception.verified')).some((x) => x.actor_user_id === w.teamLead!.userId)).toBe(true);
    // a TL can verify an item an agent already resolved; a verified item cannot be verified twice
    const lead2 = await missedLead();
    expect((await act(lead2.owner, lead2.key, 'resolve', { note: 'Done' })).status).toBe(200);
    expect((await act(w.teamLead!, lead2.key, 'verify', {})).status).toBe(200);
    expect((await act(w.owner, lead2.key, 'verify', {})).code).toBe('EXCEPTION_STATE_CONFLICT');
  });
});

describe('R-PAR-32 logged activities as context', () => {
  const logged = (i: ItemT) => i.evidence.filter((e) => e.sourceType === 'note');

  it('R-PAR-32: the untouched-lead card shows what the agent logged in that period as context ("Logged by …", at the time it happened); it never clears, delays or satisfies the miss', async () => {
    const lead = await acceptedLead(h, w);
    const before = await call(lead.owner, 'POST', `/contacts/${lead.contactId}/activities`, { kind: 'call', direction: 'outbound', at: new Date(Date.now() - 3 * 3_600_000).toISOString(), outcome: 'no_answer' });
    expect(before.status, JSON.stringify(before.body)).toBe(201);
    // logged as the log sheet does: to the minute, here the minute the lead became theirs (seconds before the accept)
    const ownedAt = (await h.su.query<{ owned_at: Date }>('SELECT owned_at FROM contacts WHERE id = $1', [lead.contactId])).rows[0]!.owned_at.getTime();
    const minute = new Date(Math.floor(ownedAt / 60_000) * 60_000).toISOString();
    const inPeriod = await call<{ note: { id: string } }>(lead.owner, 'POST', `/contacts/${lead.contactId}/activities`, { kind: 'call', direction: 'outbound', at: minute, outcome: 'connected', body: 'Called from my cell' });
    expect(inPeriod.status, JSON.stringify(inPeriod.body)).toBe(201);
    await setPeriodDeadlines(h, lead.contactId, -60_000, 86_400_000);
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    const key = `untouched:${lead.contactId}:${lead.periodSeq}`;
    const item = (await queue(w.teamLead!)).items.find((i) => i.dedupeKey === key)!;
    expect(item).toBeDefined();
    // only the activity inside the period, said as context with who logged it and when it happened
    expect(logged(item)).toEqual([
      expect.objectContaining({ sourceId: inPeriod.body.note.id, explanation: expect.stringMatching(/^Logged by .+: outgoing call, talked \(context only; not a first contact\)$/), link: expect.objectContaining({ kind: 'contact', id: lead.contactId }) }),
    ]);
    expect(logged(item)[0]!.at).not.toBeNull();
    // never a touch: the item is open, nothing cleared it, the ledger has no first touch, and the stored item has no note
    expect(item).toMatchObject({ live: true, conditionClearedAt: null, period: { current: true } });
    expect((await ledger(h, lead.contactId)).map((e) => e.type)).not.toContain('first_touch_recorded');
    expect(JSON.stringify((await itemRow(h, key))!.evidence)).not.toContain(inPeriod.body.note.id);
    // the agent sees the same context on their own item
    expect(logged((await queue(lead.owner)).items.find((i) => i.dedupeKey === key)!)).toHaveLength(1);
  });

  it('R-PAR-32 R-PERM-7: after a reassignment the card says the period is no longer current; the Team Lead keeps the context, the agent who lost the lead sees none of its notes', async () => {
    const lead = await missedLead();
    expect((await call(lead.owner, 'POST', `/contacts/${lead.contactId}/activities`, { kind: 'text', direction: 'outbound', at: new Date().toISOString() })).status).toBe(201);
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    expect(logged((await queue(w.teamLead!)).items.find((i) => i.dedupeKey === lead.key)!)).toHaveLength(1);
    expect((await act(w.teamLead!, lead.key, 'reassign', { toUserId: lead.other.userId, commandId: randomUUID() })).status).toBe(200);
    // a text the new owner logs belongs to their period, not the missed one
    expect((await call(lead.other, 'POST', `/contacts/${lead.contactId}/activities`, { kind: 'email', direction: 'outbound', at: new Date(Date.now() + 1_000).toISOString() })).status).toBe(201);
    const tl = (await queue(w.teamLead!)).items.find((i) => i.dedupeKey === lead.key)!;
    expect(tl.period).toEqual({ current: false });
    expect(logged(tl).map((e) => e.explanation)).toEqual([expect.stringMatching(/^Logged by .+: outgoing text \(context only; not a first contact\)$/)]);
    const own = (await queue(lead.owner)).items.find((i) => i.dedupeKey === lead.key)!;
    expect(own.period).toEqual({ current: false });
    expect(logged(own)).toEqual([]);
  });
});

describe('reassign', () => {
  it('R-ACC-3 R-OWN-18: a Team Lead reassigns through the ownership engine in one transaction: the ledger command, the event citing it, the audit row; both owners notified', async () => {
    const lead = await missedLead();
    const commandId = randomUUID();
    const r = await act(w.teamLead!, lead.key, 'reassign', { toUserId: lead.other.userId, commandId, note: 'Pat needs a fast reply today' });
    expect(r.status).toBe(200);
    const st = await contactState(h, lead.contactId);
    expect([st.ownership_state, st.owner_user_id]).toEqual(['owned', lead.other.userId]);
    const led = (await ledger(h, lead.contactId)).at(-1)!;
    expect(led).toMatchObject({ type: 'reassigned', reason_code: 'EXCEPTION_REASSIGN', actor_kind: 'user', actor_user_id: w.teamLead!.userId, owner_user_id: lead.other.userId });
    const cmd = (await h.su.query('SELECT command_id FROM lead_ownership_events WHERE contact_id = $1 ORDER BY seq DESC LIMIT 1', [lead.contactId])).rows[0].command_id;
    expect(cmd).toBe(commandId);
    expect(await eventRows(h, lead.key)).toEqual([{ action: 'reassigned', actor_user_id: w.teamLead!.userId, actor_role: 'team_lead', ownership_command_id: commandId, note: 'Pat needs a fast reply today' }]);
    expect((await auditRows(h, w.tenantId, 'exception.reassigned')).length).toBeGreaterThanOrEqual(1);
    // the ownership engine's own audit mirror of the human command (written once, not by this module)
    expect((await h.su.query(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 AND action LIKE 'ownership.%'`, [w.tenantId, lead.contactId])).rows[0].n).toBeGreaterThanOrEqual(1);
    const notified = (await h.su.query(`SELECT DISTINCT user_id FROM notifications WHERE tenant_id = $1 AND subject_id = $2 AND created_at > now() - interval '1 minute'`, [w.tenantId, lead.contactId])).rows.map((x) => x.user_id);
    expect(notified).toEqual(expect.arrayContaining([lead.owner.userId, lead.other.userId]));
    // still live (a reassignment is not a resolution); the missed period stays with the agent who missed it
    expect(r.body.item).toMatchObject({ live: true, owner: { userId: lead.owner.userId }, latestEvent: { action: 'reassigned' } });

    // a retried tap (same command id) is a replay: one ledger command, one event
    const replay = await act(w.teamLead!, lead.key, 'reassign', { toUserId: lead.other.userId, commandId });
    expect(replay.status).toBe(200);
    expect(await eventRows(h, lead.key)).toHaveLength(1);
    expect((await h.su.query('SELECT count(*)::int AS n FROM lead_ownership_events WHERE command_id = $1', [commandId])).rows[0].n).toBe(1);
  });

  it('R-OWN-18 R-ACC-3: a Team Lead cannot reassign to someone outside their team; agents cannot reassign at all; nothing is written either way', async () => {
    const lead = await missedLead();
    const seq0 = (await contactState(h, lead.contactId)).ownership_seq;
    const outside = await act(w.teamLead!, lead.key, 'reassign', { toUserId: w.outsider.userId, commandId: randomUUID() });
    expect([outside.status, outside.code]).toEqual([403, 'TARGET_NOT_ELIGIBLE']);
    const byAgent = await act(lead.owner, lead.key, 'reassign', { toUserId: lead.other.userId, commandId: randomUUID() });
    expect([byAgent.status, byAgent.code]).toEqual([404, 'NOT_FOUND']);
    const noCommand = await act(w.teamLead!, lead.key, 'reassign', { toUserId: lead.other.userId });
    expect(noCommand.status).toBe(422);
    expect((await contactState(h, lead.contactId)).ownership_seq).toBe(seq0);
    expect(await eventRows(h, lead.key)).toEqual([]);
    // the Owner may reassign anywhere, including to the agent outside the team
    expect((await act(w.owner, lead.key, 'reassign', { toUserId: w.outsider.userId, commandId: randomUUID() })).status).toBe(200);
    expect((await contactState(h, lead.contactId)).owner_user_id).toBe(w.outsider.userId);
  });

  it('R-ACC-3 ownership-2: once the lead moved to someone who is working it, the stale item offers no reassign and refuses one (LEAD_STATE_CHANGED); nothing moves', async () => {
    const lead = await missedLead();
    expect((await act(w.teamLead!, lead.key, 'reassign', { toUserId: lead.other.userId, commandId: randomUUID() })).status).toBe(200);
    await humanTouch(h, lead.other, lead.contactId);
    const before = await contactState(h, lead.contactId);
    expect(before.owner_user_id).toBe(lead.other.userId);
    const view = (await queue(w.owner)).items.find((i) => i.dedupeKey === lead.key)!;
    expect(view.live).toBe(true);
    expect(view.actions.reassign).toBe(false);
    const again = await act(w.owner, lead.key, 'reassign', { toUserId: w.outsider.userId, commandId: randomUUID() });
    expect([again.status, again.code]).toEqual([409, 'LEAD_STATE_CHANGED']);
    const after = await contactState(h, lead.contactId);
    expect([after.owner_user_id, after.ownership_seq]).toEqual([lead.other.userId, before.ownership_seq]);
    expect((await ledger(h, lead.contactId)).filter((e: { reason_code: string }) => e.reason_code === 'EXCEPTION_REASSIGN')).toHaveLength(1);
  });

  it('R-ACC-3 ownership-2: the queue carries the ledger head and a reassign sent with an older one is refused (stale-UI fence)', async () => {
    const lead = await missedLead();
    const view = (await queue(w.teamLead!)).items.find((i) => i.dedupeKey === lead.key)!;
    expect(view.contactOwnershipSeq).toBe(Number((await contactState(h, lead.contactId)).ownership_seq));
    const stale = await act(w.teamLead!, lead.key, 'reassign', { toUserId: lead.other.userId, commandId: randomUUID(), expectedSeq: view.contactOwnershipSeq! - 1 });
    expect([stale.status, stale.code]).toEqual([409, 'LEAD_STATE_CHANGED']);
    expect((await act(w.teamLead!, lead.key, 'reassign', { toUserId: lead.other.userId, commandId: randomUUID(), expectedSeq: view.contactOwnershipSeq! })).status).toBe(200);
  });

  it('R-ACC-3: a reassigned event without a matching ledger command is rejected by the DB (F7 trigger), even from a Team Lead acting as themselves', async () => {
    const lead = await missedLead();
    const forged = await asUser(h, w.teamLead!, `INSERT INTO exception_events (tenant_id, id, exception_dedupe_key, action, actor_user_id, actor_role, ownership_command_id, occurred_at)
      VALUES (app.tenant_id(), gen_random_uuid(), '${lead.key}', 'reassigned', '${w.teamLead!.userId}', 'team_lead', '${randomUUID()}', now())`);
    expect(forged).toMatchObject({ ok: false, code: '23514' });
    expect((forged as { message: string }).message).toMatch(/EXCEPTION_REASSIGN_UNPROVEN/);
    // a real command by ANOTHER actor cannot be cited either
    const commandId = randomUUID();
    expect((await act(w.owner, lead.key, 'reassign', { toUserId: lead.other.userId, commandId })).status).toBe(200);
    const borrowed = await asUser(h, w.teamLead!, `INSERT INTO exception_events (tenant_id, id, exception_dedupe_key, action, actor_user_id, actor_role, ownership_command_id, occurred_at)
      VALUES (app.tenant_id(), gen_random_uuid(), '${lead.key}', 'reassigned', '${w.teamLead!.userId}', 'team_lead', '${commandId}', now())`);
    expect(borrowed).toMatchObject({ ok: false, code: '23514' });
    // a resolved event needs a note (DB CHECK), and the ledger of events is append-only
    expect(await asUser(h, w.teamLead!, `INSERT INTO exception_events (tenant_id, id, exception_dedupe_key, action, actor_user_id, actor_role, occurred_at)
      VALUES (app.tenant_id(), gen_random_uuid(), '${lead.key}', 'resolved', '${w.teamLead!.userId}', 'team_lead', now())`)).toMatchObject({ ok: false, code: '23514' });
    const upd = await asUser(h, w.owner, `UPDATE exception_events SET note = 'x' WHERE exception_dedupe_key = '${lead.key}'`);
    expect(upd.ok).toBe(false);
    expect((await eventRows(h, lead.key)).map((e) => e.note)).toEqual([null]);
  });
});

describe('visibility, idempotency and concurrency', () => {
  it('R-PERM-5: an item outside the caller\'s scope is 404 for the detail and every action (the other agent, an outsider, a TC)', async () => {
    const lead = await missedLead();
    const tc = await h.invite(w.owner, 'tc');
    for (const c of [lead.other, w.outsider, tc]) {
      expect((await call(c, 'GET', keyPath(lead.key))).code).toBe('NOT_FOUND');
      expect((await act(c, lead.key, 'resolve', { note: 'not mine' })).code).toBe('NOT_FOUND');
      expect((await act(c, lead.key, 'reopen', {})).code).toBe('NOT_FOUND');
    }
    expect((await call(tc, 'GET', '/team/exceptions')).code).toBe('NOT_FOUND');
    expect((await call(w.owner, 'GET', keyPath(`promise:${randomUUID()}`))).code).toBe('NOT_FOUND');
    expect((await call(w.owner, 'GET', '/team/exceptions/not-a-key')).status).toBe(422);
    expect(await eventRows(h, lead.key)).toEqual([]);
  });

  it('a retried command id is a replay (one event); the same command id on another item is refused (COMMAND_ID_REUSED)', async () => {
    const a = await missedLead();
    const b = await missedLead();
    const commandId = randomUUID();
    expect((await act(a.owner, a.key, 'resolve', { note: 'Handled', commandId })).status).toBe(200);
    const retry = await act(a.owner, a.key, 'resolve', { note: 'Handled', commandId });
    expect([retry.status, retry.body.events.length]).toEqual([200, 1]);
    expect((await eventRows(h, a.key))[0]).toBeDefined();
    expect((await h.su.query('SELECT id FROM exception_events WHERE exception_dedupe_key = $1', [a.key])).rows[0].id).toBe(eventIdFor('resolve', commandId));
    const elsewhere = await act(w.owner, b.key, 'resolve', { note: 'x', commandId });
    expect([elsewhere.status, elsewhere.code]).toEqual([422, 'COMMAND_ID_REUSED']);
    expect(await eventRows(h, b.key)).toEqual([]);
  });

  it('R-ACC-3: two people resolving the same item at the same moment produce exactly one event; the other gets EXCEPTION_STATE_CONFLICT', async () => {
    const lead = await missedLead();
    const results = await Promise.all([
      act(w.teamLead!, lead.key, 'resolve', { note: 'TL handled it' }),
      act(w.owner, lead.key, 'resolve', { note: 'Owner handled it' }),
      act(lead.owner, lead.key, 'resolve', { note: 'Agent handled it' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(results.filter((r) => r.status === 409).every((r) => r.code === 'EXCEPTION_STATE_CONFLICT')).toBe(true);
    expect((await eventRows(h, lead.key)).map((e) => e.action)).toEqual(['resolved']);
  });

  it('R-ACC-3 R-OWN-18: a reassign racing a resolve serializes on the item: either the reassignment is recorded and the resolve follows, or the resolve wins and the reassign is refused with no ledger change', async () => {
    const lead = await missedLead();
    const seq0 = Number((await contactState(h, lead.contactId)).ownership_seq);
    const [re, res] = await Promise.all([
      act(w.teamLead!, lead.key, 'reassign', { toUserId: lead.other.userId, commandId: randomUUID() }),
      act(lead.owner, lead.key, 'resolve', { note: 'Called her just now' }),
    ]);
    const events = (await eventRows(h, lead.key)).map((e) => e.action);
    const seq1 = Number((await contactState(h, lead.contactId)).ownership_seq);
    if (re.status === 200) {
      expect(seq1).toBeGreaterThan(seq0);
      expect(events[0]).toBe('reassigned');
      expect(res.status === 200 ? events : events.slice(0, 1)).toEqual(res.status === 200 ? ['reassigned', 'resolved'] : ['reassigned']);
    } else {
      expect([re.code, res.status, seq1, events]).toEqual(['EXCEPTION_STATE_CONFLICT', 200, seq0, ['resolved']]);
    }
  });
});
