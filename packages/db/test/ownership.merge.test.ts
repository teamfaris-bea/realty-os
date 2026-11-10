// R-OWN-24 / E69: merges lock both contacts and move communication + automation with them.
import type { ContactId } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cmd, contactRow, createHarness, createWorld, drainFollowups, type Harness, ledger, type Member, selfCreated, suFixture, suRows, uuid, type World } from './world.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

/**
 * Fixture (superuser, triggers off: the playbook approval and inbound paths belong to modules 12/13):
 * X has an active nurture enrollment and an unpaused conversation; Y is paused by a client reply,
 * has one inbound message, an open handback (+ feed item) and a pending draft.
 */
async function seedMergePair(w: World, owner: Member) {
  const x = await selfCreated(h.app, w, owner, 'Jane Buyer');
  const y = await selfCreated(h.app, w, owner, 'Jane B.');
  const pb = uuid();
  const pv = uuid();
  const cx = uuid();
  const cy = uuid();
  const msg = uuid();
  const hb = uuid();
  const draft = uuid();
  await suFixture(h.su, `
    INSERT INTO playbooks (tenant_id, id, kind, scope, owner_user_id, name) VALUES ($1, $2, 'nurture', 'agent', $3, 'Nurture');
    INSERT INTO playbook_versions (tenant_id, id, playbook_id, version_no, steps, content_sha256, status, created_by_user_id)
      VALUES ($1, $4, $2, 1, '[]', repeat('ab', 32), 'approved', $3);
    INSERT INTO playbook_enrollments (tenant_id, id, playbook_id, playbook_version_id, contact_id, enrolled_by, enrolled_by_user_id, state)
      VALUES ($1, gen_random_uuid(), $2, $4, $5, 'user', $3, 'active');
    INSERT INTO playbook_enrollments (tenant_id, id, playbook_id, playbook_version_id, contact_id, enrolled_by, enrolled_by_user_id, state,
                                      pause_reason, paused_at, paused_by_message_id)
      VALUES ($1, gen_random_uuid(), $2, $4, $6, 'user', $3, 'paused', 'client_reply', now() - interval '1 hour', $9);
    INSERT INTO conversations (tenant_id, id, contact_id) VALUES ($1, $7, $5);
    INSERT INTO conversations (tenant_id, id, contact_id, automation_paused_at, automation_pause_reason, automation_paused_by_message_id, inbound_seq)
      VALUES ($1, $8, $6, now() - interval '1 hour', 'client_reply', $9, 1);
    INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body, status, initiator, occurred_at)
      VALUES ($1, $9, $8, $6, 'sms', 'inbound', '+15555550111', '+15555559999', 'Is it still available?', 'received', 'client', now() - interval '1 hour');
    INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, bound_ownership_seq)
      VALUES ($1, $10, $6, 'handback', 'novel_message', 'requires_approval', 'proposed', $3, 'Jane replied', '{}', 1),
             ($1, $11, $6, 'message_draft', 'novel_message', 'requires_approval', 'proposed', $3, 'Draft reply', '{}', 1);
    INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, assistant_action_id, reasons, dedupe_key)
      VALUES ($1, gen_random_uuid(), $3, 'handback', 'pinned', $6, 'assistant_action', $10, $10, '["CLIENT_REPLIED"]', 'handback:' || $10::text);`,
    [w.tenantId, pb, owner.id, pv, x, y, cx, cy, msg, hb, draft]);
  return { x, y, cx, cy, msg, hb, draft };
}

async function assertMerged(w: World, s: Awaited<ReturnType<typeof seedMergePair>>, survivorOwner: string) {
  const loser = await contactRow(h.su, s.y);
  expect([loser.ownership_state, loser.closed_reason, loser.merged_into_contact_id]).toEqual(['closed', 'merged', s.x]);
  expect((await ledger(h.su, s.y)).at(-1)?.type).toBe('merged_away');
  expect((await ledger(h.su, s.x)).at(-1)?.type).toBe('merged_in');
  // messages re-pointed to the survivor's conversation; the loser's empty conversation stays put
  expect(await suRows(h.su, 'SELECT contact_id, conversation_id FROM messages WHERE id = $1', [s.msg])).toEqual([{ contact_id: s.x, conversation_id: s.cx }]);
  expect(await suRows(h.su, 'SELECT count(*)::int AS n FROM conversations WHERE id = $1 AND contact_id = $2', [s.cy, s.y])).toEqual([{ n: 1 }]);
  // pause wins: the survivor conversation carries the loser's (earliest) pause and its message
  const [conv] = await suRows<{ automation_paused_at: Date | null; automation_paused_by_message_id: string }>(h.su,
    'SELECT automation_paused_at, automation_paused_by_message_id FROM conversations WHERE id = $1', [s.cx]);
  expect(conv!.automation_paused_at).not.toBeNull();
  expect(conv!.automation_paused_by_message_id).toBe(s.msg);
  // one live enrollment per contact: the loser's stopped 'merged', the survivor's paused
  const enr = await suRows<{ contact_id: string; state: string; stop_reason: string | null }>(h.su,
    'SELECT contact_id, state, stop_reason FROM playbook_enrollments WHERE contact_id = ANY ($1::uuid[]) ORDER BY contact_id = $2 DESC', [[s.x, s.y], s.x]);
  expect(enr).toEqual([{ contact_id: s.x, state: 'paused', stop_reason: null }, { contact_id: s.y, state: 'stopped', stop_reason: 'merged' }]);
  // the handback (and its feed item) moved to the survivor and its owner; the draft was invalidated
  expect(await suRows(h.su, 'SELECT contact_id, owner_user_id, status FROM assistant_actions WHERE id = $1', [s.hb])).toEqual([{ contact_id: s.x, owner_user_id: survivorOwner, status: 'proposed' }]);
  expect(await suRows(h.su, 'SELECT contact_id, status FROM assistant_actions WHERE id = $1', [s.draft])).toEqual([{ contact_id: s.x, status: 'invalidated' }]);
  expect(await suRows(h.su, `SELECT contact_id, user_id FROM priority_feed_items WHERE assistant_action_id = $1 AND state = 'open'`, [s.hb])).toEqual([{ contact_id: s.x, user_id: survivorOwner }]);
  const audit = await suRows<{ action: string }>(h.su, `SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'ownership.merge'`, [s.x]);
  expect(audit).toHaveLength(1);
}

describe('R-OWN-24 E69 merge', () => {
  it('R-OWN-24 E69: an Owner merges paused Y (open handback) into active X in ONE transaction: pause wins, enrollment stopped, handback moved', async () => {
    const w = await createWorld(h.app, { agents: 1 });
    const agent = w.agents[0]!;
    const s = await seedMergePair(w, agent);
    const r = await cmd(h.app, w.owner.actor, s.x as ContactId, { kind: 'merge', survivorId: s.x as ContactId, loserId: s.y as ContactId, ownerChoice: null });
    expect(r.outcome.ok).toBe(true);
    await assertMerged(w, s, agent.id);
  });

  it('R-OWN-24 E69: a Team Lead merge moves communication in the ownership.followup as the system actor', async () => {
    const w = await createWorld(h.app, { agents: 1, teamLead: true });
    const agent = w.agents[0]!;
    const s = await seedMergePair(w, agent);
    const r = await cmd(h.app, w.tl!.actor, s.x as ContactId, { kind: 'merge', survivorId: s.x as ContactId, loserId: s.y as ContactId, ownerChoice: null });
    expect(r.outcome.ok).toBe(true);
    // before the follow-up: ownership moved, communication not yet
    expect(await suRows(h.su, 'SELECT contact_id FROM messages WHERE id = $1', [s.msg])).toEqual([{ contact_id: s.y }]);
    expect(await drainFollowups(h, w)).toBeGreaterThanOrEqual(1);
    await assertMerged(w, s, agent.id);
  });

  it('R-OWN-24: different owners need a TL/Admin choice (MERGE_OWNER_REQUIRED); the chosen owner survives and the other is notified', async () => {
    const w = await createWorld(h.app, { agents: 2 });
    const [a, b] = w.agents as [Member, Member];
    const x = await selfCreated(h.app, w, a, 'Kim One');
    const y = await selfCreated(h.app, w, b, 'Kim Two');
    const r1 = await cmd(h.app, w.owner.actor, x, { kind: 'merge', survivorId: x, loserId: y, ownerChoice: null });
    expect(r1.outcome.ok ? null : r1.outcome.code).toBe('MERGE_OWNER_REQUIRED');
    const r2 = await cmd(h.app, w.owner.actor, x, { kind: 'merge', survivorId: x, loserId: y, ownerChoice: b.id });
    expect(r2.outcome.ok).toBe(true);
    expect((await contactRow(h.su, x)).owner_user_id).toBe(b.id);
    expect(await suRows(h.su, `SELECT user_id FROM notifications WHERE kind = 'reassigned_away' AND subject_id = $1`, [x])).toEqual([{ user_id: a.id }]);
  });
});
