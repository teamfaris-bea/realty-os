// Adversarial verification of db/client: each test reproduces a defect found by trying to break the
// module (idempotency under duplicate delivery, existence disclosure, consent projection, PII in job
// payloads, handback re-homing). Real Postgres per test file, app_user (RLS) for every application
// path; the superuser pool only seeds fixtures that have no application path and reads back state.
import { randomBytes } from 'node:crypto';
import type { ConsentEventSpec } from '@realty/core/compliance';
import { type ContactId, instant } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConsentLedgerNotVisibleError, recordConsentEvent } from '../src/consent.js';
import { JobPayloadError, assertNoPiiInPayload } from '../src/jobs.js';
import { applyOwnershipCommand } from '../src/ownership/apply.js';
import { runOwnershipFollowup } from '../src/ownership/followup.js';
import { withTenantTx } from '../src/tenantTx.js';
import {
  cmd,
  contactRow,
  createHarness,
  createWorld,
  drainFollowups,
  type Harness,
  holdContactLocks,
  intakeLead,
  ledger,
  type Member,
  pendingFollowups,
  selfCreated,
  suFixture,
  suRows,
  userActor,
  uuid,
  waitForWaiters,
  type World,
} from './world.js';

let h: Harness;
let w: World;
beforeAll(async () => {
  h = await createHarness(8);
  w = await createWorld(h.app, { agents: 3, teamLead: true });
});
afterAll(async () => {
  await h?.close();
});

const code = (o: { ok: boolean }) => (o as { code?: string }).code;

/** Loser Y: a paused conversation (inbound_seq 3) with one inbound message and a paused enrollment; survivor X: a conversation (inbound_seq 2) and an active enrollment. */
async function seedPair(owner: Member) {
  const x = await selfCreated(h.app, w, owner, 'Jane Buyer');
  const y = await selfCreated(h.app, w, owner, 'Jane B.');
  const ids = { pb: uuid(), pv: uuid(), cx: uuid(), cy: uuid(), msg: uuid(), ex: uuid(), ey: uuid() };
  await suFixture(h.su, `
    INSERT INTO playbooks (tenant_id, id, kind, scope, owner_user_id, name) VALUES ($1, $2, 'nurture', 'agent', $3, 'Nurture');
    INSERT INTO playbook_versions (tenant_id, id, playbook_id, version_no, steps, content_sha256, status, created_by_user_id)
      VALUES ($1, $4, $2, 1, '[]', repeat('ab', 32), 'approved', $3);
    INSERT INTO conversations (tenant_id, id, contact_id, inbound_seq) VALUES ($1, $5, $6, 2);
    INSERT INTO conversations (tenant_id, id, contact_id, automation_paused_at, automation_pause_reason, automation_paused_by_message_id, inbound_seq)
      VALUES ($1, $7, $8, now() - interval '1 hour', 'client_reply', $9, 3);
    INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body, status, initiator, occurred_at)
      VALUES ($1, $9, $7, $8, 'sms', 'inbound', '+15555550111', '+15555559999', 'Still available?', 'received', 'client', now() - interval '1 hour');
    INSERT INTO playbook_enrollments (tenant_id, id, playbook_id, playbook_version_id, contact_id, enrolled_by, enrolled_by_user_id, state)
      VALUES ($1, $10, $2, $4, $6, 'user', $3, 'active');
    INSERT INTO playbook_enrollments (tenant_id, id, playbook_id, playbook_version_id, contact_id, enrolled_by, enrolled_by_user_id, state,
                                      pause_reason, paused_at, paused_by_message_id)
      VALUES ($1, $11, $2, $4, $8, 'user', $3, 'paused', 'client_reply', now() - interval '1 hour', $9);`,
    [w.tenantId, ids.pb, owner.id, ids.pv, ids.cx, x, ids.cy, y, ids.msg, ids.ex, ids.ey]);
  return { x, y, ...ids };
}

describe('adversarial: duplicate delivery of merges', () => {
  it('R-OWN-7: a merge delivered twice concurrently commits once; the duplicate returns the stored events and moves nothing again', async () => {
    const o = w.agents[0]!;
    const s = await seedPair(o);
    const commandId = uuid();
    const lock = await holdContactLocks(h, w.tenantId, [s.x, s.y]);
    const run = () => applyOwnershipCommand(w.owner.actor, s.x, { kind: 'merge', survivorId: s.x, loserId: s.y, ownerChoice: null }, { commandId, db: h.app });
    const p1 = run();
    await waitForWaiters(h.su, lock.pid, 1);
    const p2 = run();
    await waitForWaiters(h.su, lock.pid, 2);
    await lock.release();
    const results = await Promise.all([p1, p2]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    const first = results.find((r) => !r.replayed)!;
    const dup = results.find((r) => r.replayed)!;
    expect(first.outcome.ok && dup.outcome.ok).toBe(true);
    if (!first.outcome.ok || !dup.outcome.ok) return;
    // the stored outcome: the same ledger events (both contacts), nothing re-decided
    expect(dup.outcome.events.map((e) => e.eventId).sort()).toEqual(first.outcome.events.map((e) => e.eventId).sort());
    expect(dup.projection).toEqual(first.projection);
    expect(await suRows(h.su, 'SELECT count(*)::int AS n FROM ownership_command_rejections WHERE command_id = $1', [commandId])).toEqual([{ n: 0 }]);
    expect((await ledger(h.su, s.y)).filter((e) => e.command_id === commandId)).toHaveLength(1);
    // the communication move ran once: the loser's inbound_seq (3) was folded into the survivor's (2) once
    expect(await suRows(h.su, 'SELECT inbound_seq::int AS n FROM conversations WHERE id = $1', [s.cx])).toEqual([{ n: 5 }]);
    expect(await suRows(h.su, `SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'ownership.merge'`, [s.x])).toEqual([{ n: 1 }]);
  });

  it('R-OWN-24 E69: re-running a Team Lead merge follow-up is a no-op (counters folded once; a survivor enrollment resumed in between stays resumed)', async () => {
    const o = w.agents[1]!;
    const s = await seedPair(o);
    const r = await applyOwnershipCommand(w.tl!.actor, s.x, { kind: 'merge', survivorId: s.x, loserId: s.y, ownerChoice: null }, { commandId: uuid(), db: h.app });
    expect(r.outcome.ok).toBe(true);
    const jobs = await pendingFollowups(h.su, w.tenantId);
    const mergeJobs = jobs.filter((j) => j.payload.contactId === s.y || j.payload.contactId === s.x);
    expect(mergeJobs.length).toBeGreaterThan(0);
    for (const j of mergeJobs) await runOwnershipFollowup(w.system(), j.payload, { db: h.app });
    expect(await suRows(h.su, 'SELECT inbound_seq::int AS n FROM conversations WHERE id = $1', [s.cx])).toEqual([{ n: 5 }]);
    expect(await suRows(h.su, 'SELECT state FROM playbook_enrollments WHERE id = $1', [s.ex])).toEqual([{ state: 'paused' }]);
    // a human resumes the survivor's automation (module 13 path; fixture here), then the job is delivered again
    await suFixture(h.su, `UPDATE playbook_enrollments SET state = 'active', pause_reason = NULL, paused_at = NULL, paused_by_message_id = NULL WHERE id = $1`, [s.ex]);
    for (const j of mergeJobs) await runOwnershipFollowup(w.system(), j.payload, { db: h.app });
    expect(await suRows(h.su, 'SELECT inbound_seq::int AS n FROM conversations WHERE id = $1', [s.cx])).toEqual([{ n: 5 }]);
    expect(await suRows(h.su, 'SELECT state FROM playbook_enrollments WHERE id = $1', [s.ex])).toEqual([{ state: 'active' }]);
    expect(await suRows(h.su, 'SELECT contact_id, conversation_id FROM messages WHERE id = $1', [s.msg])).toEqual([{ contact_id: s.x, conversation_id: s.cx }]);
    expect(await suRows(h.su, 'SELECT state, stop_reason FROM playbook_enrollments WHERE id = $1', [s.ey])).toEqual([{ state: 'stopped', stop_reason: 'merged' }]);
  });
});

describe('adversarial: authority comes from the database, not the session', () => {
  it('R-OWN-24: a merge by a Team Lead whose session still claims admin still moves the loser\'s messages (in the follow-up as system)', async () => {
    const o = w.agents[0]!;
    const s = await seedPair(o);
    const stale = userActor(w.tenantId, w.tl!.id, 'admin');
    const r = await applyOwnershipCommand(stale, s.x, { kind: 'merge', survivorId: s.x, loserId: s.y, ownerChoice: null }, { commandId: uuid(), db: h.app });
    expect(r.outcome.ok).toBe(true);
    await drainFollowups(h, w);
    expect(await suRows(h.su, 'SELECT contact_id, conversation_id FROM messages WHERE id = $1', [s.msg])).toEqual([{ contact_id: s.x, conversation_id: s.cx }]);
    expect(await suRows(h.su, 'SELECT state, stop_reason FROM playbook_enrollments WHERE id = $1', [s.ey])).toEqual([{ state: 'stopped', stop_reason: 'merged' }]);
  });
});

describe('adversarial: existence disclosure', () => {
  it('R-PERM-5 E52: commands on a contact the agent never had sight of are NOT_FOUND, exactly like an id that does not exist', async () => {
    const [a, b] = w.agents as [Member, Member];
    const hidden = await selfCreated(h.app, w, b, 'Private Client');
    const ghost = uuid() as ContactId;
    for (const c of [
      { kind: 'claim', pondId: w.pondId },
      { kind: 'accept', offerId: uuid() },
      { kind: 'decline', offerId: uuid() },
    ] as const) {
      const onHidden = await cmd(h.app, a.actor, hidden, c);
      const onGhost = await cmd(h.app, a.actor, ghost, c);
      expect([c.kind, code(onHidden.outcome), onHidden.projection]).toEqual([c.kind, 'NOT_FOUND', null]);
      expect([c.kind, code(onGhost.outcome)]).toEqual([c.kind, 'NOT_FOUND']);
    }
    // the definer itself answers nothing for that id, and still answers the owner and tenant-wide callers
    const head = (actor: Member['actor']) =>
      withTenantTx(actor, async (tx) => (await sql<{ ownership_state: string }>`SELECT * FROM app.ownership_head(${hidden}::uuid)`.execute(tx)).rows, { db: h.app });
    expect(await head(a.actor)).toEqual([]);
    expect((await head(b.actor)).map((r) => r.ownership_state)).toEqual(['owned']);
    expect((await head(w.owner.actor)).map((r) => r.ownership_state)).toEqual(['owned']);
  });

  it('R-OWN-5 E1: an agent who saw the lead in the pond still learns LEAD_ALREADY_CLAIMED after another agent claimed it', async () => {
    const [a, b] = w.agents as [Member, Member];
    const { contactId } = await intakeLead(h.app, w);
    expect((await cmd(h.app, b.actor, contactId, { kind: 'claim', pondId: w.pondId })).outcome.ok).toBe(true);
    const late = await cmd(h.app, a.actor, contactId, { kind: 'claim', pondId: w.pondId });
    expect(code(late.outcome)).toBe('LEAD_ALREADY_CLAIMED');
    expect(late.projection).toBeNull();
    const [rej] = await suRows<{ code: string; observed_seq: string }>(h.su, 'SELECT code, observed_seq FROM ownership_command_rejections WHERE command_id = $1', [
      (late.outcome as { rejection: { commandId: string } }).rejection.commandId,
    ]);
    expect(rej!.code).toBe('LEAD_ALREADY_CLAIMED');
    expect(Number(rej!.observed_seq)).toBe(Number((await contactRow(h.su, contactId)).ownership_seq));
  });
});

describe('adversarial: consent projection', () => {
  function revokeSpec(actor: Member['actor'], hmac: string): ConsentEventSpec {
    return {
      id: uuid(), addressKind: 'phone', addressHmac: hmac, addressHint: '•••-•••-4821', channel: 'sms', purpose: 'all', eventType: 'revoke',
      level: 'none', source: 'agent_revoke', occurredAt: instant(Date.now()), contactId: null, actor, disclosureId: null,
      evidenceObjectId: null, evidenceMessageId: null, evidenceCallId: null, evidenceCallOffsetMs: null, evidence: {}, imported: false,
      importRecordId: null, originalProvenance: null, revertsEventId: null, expiresAt: null, needsReview: false,
    } as ConsentEventSpec;
  }

  it('R-CONSENT-6: an event whose address ledger the actor cannot read is refused, never stored without its consent_state', async () => {
    const a = w.agents[0]!;
    const hmac = randomBytes(32).toString('hex');
    await expect(withTenantTx(a.actor, (tx) => recordConsentEvent(tx, revokeSpec(a.actor, hmac)), { db: h.app })).rejects.toBeInstanceOf(ConsentLedgerNotVisibleError);
    const key = Buffer.from(hmac, 'hex');
    expect(await suRows(h.su, 'SELECT count(*)::int AS n FROM consent_events WHERE address_hmac = $1', [key])).toEqual([{ n: 0 }]);
    // the same event recorded by a tenant-wide actor stores the ledger row and both purpose projections
    const rows = await withTenantTx(w.owner.actor, (tx) => recordConsentEvent(tx, revokeSpec(w.owner.actor, hmac)), { db: h.app });
    expect(rows.map((r) => [r.purpose, r.status]).sort()).toEqual([['informational', 'revoked'], ['marketing', 'revoked']]);
    expect(await suRows(h.su, 'SELECT purpose, status, ledger_event_count FROM consent_state WHERE address_hmac = $1 ORDER BY purpose', [key])).toEqual([
      { purpose: 'informational', status: 'revoked', ledger_event_count: 1 },
      { purpose: 'marketing', status: 'revoked', ledger_event_count: 1 },
    ]);
  });
});

describe('adversarial: job payload PII', () => {
  it('R-TEN-7: a payload KEY that looks like an email address or a phone number is refused, like a value', () => {
    expect(() => assertNoPiiInPayload({ 'jane@example.com': 1 })).toThrow(JobPayloadError);
    expect(() => assertNoPiiInPayload({ seen: { '+15555550100': true } })).toThrow(JobPayloadError);
    expect(() => assertNoPiiInPayload({ [uuid()]: { offerId: uuid() }, 'ownership.offer_expiry:1731229138000': 1 })).not.toThrow();
  });
});

describe('adversarial: handback re-homing after a release', () => {
  it("ARCHITECTURE §10: an agent releases a lead with an open handback; the follow-up re-homes it to the previous owner's Team Lead", async () => {
    const a = w.agents[2]!;
    // agent `a` sits only in a second team whose lead is the TL (the Owner leads the default team)
    const team2 = uuid();
    await withTenantTx(w.owner.actor, async (tx) => {
      await sql`INSERT INTO teams (tenant_id, id, name) VALUES (${w.tenantId}, ${team2}, 'East')`.execute(tx);
      await sql`INSERT INTO team_members (tenant_id, team_id, user_id, is_lead) VALUES (${w.tenantId}, ${team2}, ${w.tl!.id}, true), (${w.tenantId}, ${team2}, ${a.id}, false)`.execute(tx);
    }, { db: h.app });
    await suFixture(h.su, 'DELETE FROM team_members WHERE tenant_id = $1 AND team_id = $2 AND user_id = $3', [w.tenantId, w.teamId, a.id]);
    const { contactId } = await intakeLead(h.app, w);
    expect((await cmd(h.app, a.actor, contactId, { kind: 'claim', pondId: w.pondId })).outcome.ok).toBe(true);
    const hb = uuid();
    await suFixture(h.su, `
      INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload)
        VALUES ($1, $2, $3, 'handback', 'novel_message', 'requires_approval', 'proposed', $4, 'The client replied', '{}');
      INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, assistant_action_id, reasons, dedupe_key)
        VALUES ($1, gen_random_uuid(), $4, 'handback', 'pinned', $3, 'assistant_action', $2, $2, '["CLIENT_REPLIED"]', 'handback:' || $2::text);`,
      [w.tenantId, hb, contactId, a.id]);
    expect((await cmd(h.app, a.actor, contactId, { kind: 'release', reason: 'not_a_fit' })).outcome.ok).toBe(true);
    await drainFollowups(h, w);
    expect(await suRows(h.su, 'SELECT owner_user_id FROM assistant_actions WHERE id = $1', [hb])).toEqual([{ owner_user_id: w.tl!.id }]);
    expect(await suRows(h.su, `SELECT user_id FROM priority_feed_items WHERE assistant_action_id = $1 AND state = 'open'`, [hb])).toEqual([{ user_id: w.tl!.id }]);
  });
});
