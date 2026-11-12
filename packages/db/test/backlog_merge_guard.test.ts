// contacts_guard covers merged_into_contact_id (migration *_backlog_merge_guard; R-OWN-24, E546-E548). Before it, an
// app_user UPDATE of only that column passed contacts_guard as "nothing changed": a record looked merged away into any
// other record, with no ledger event and no merge of its points, tags, notes, sessions or roles, while the
// do-not-contact follow-merge trigger and every reader of the column trusted it. Every write here goes through app_user
// (RLS) and the ownership engine, except the widget connection (no application path at this layer) and the one
// superuser UPDATE that E547 proves still works; the superuser pool otherwise only reads back.
import { createHash } from 'node:crypto';
import type { Actor, ContactId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTx } from '../src/tenantTx.js';
import { BUY, cmd, createHarness, createWorld, drainFollowups, type Harness, intakeLead, pendingFollowups, selfCreated, suFixture, suRows, uuid, type World } from './world.js';

let h: Harness;
let w: World;
let connectionId: string;
let seq = 0;

const hmacHex = (addr: string) => createHash('sha256').update(`test-hmac:${addr}`).digest('hex');
const as = <T>(actor: Actor, fn: Parameters<typeof withTenantTx<T>>[1]) => withTenantTx(actor, fn, { db: h.app });

beforeAll(async () => {
  h = await createHarness(6);
  w = await createWorld(h.app, { agents: 1, teamLead: true, rule: 'round_robin' });
  connectionId = uuid();
  await suFixture(h.su, `
    INSERT INTO integration_connections (tenant_id, id, kind, display_name, lead_source_id, allowed_origins, widget_key_hash, status, connected_at)
      VALUES ($1, $2, 'web_chat_widget', 'Website chat', $3, ARRAY['https://www.team-site.test'], $4, 'connected', now());`,
    [w.tenantId, connectionId, w.leadSourceId, createHash('sha256').update(connectionId).digest()]);
}, 120_000);
afterAll(async () => {
  await h?.close();
});

interface Loser {
  id: ContactId;
  phone: string;
  tagId: string;
  note: string;
  sessionId: string;
  chatAddress: string;
  dealId: string;
  taskId: string;
  dncEventId: string;
}

/** The loser's person data: a phone, a tag, a note, a chat session, a deal role, an open task and a do-not-contact. */
async function seedLoser(id: ContactId): Promise<Loser> {
  const n = ++seq;
  const phone = `+1555010${String(1000 + n).slice(-4)}`;
  const tagId = uuid();
  const note = `Wants a yard ${n}`;
  const dealId = uuid();
  const taskId = uuid();
  const dncEventId = uuid();
  await as(w.owner.actor, async (tx) => {
    await sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
              VALUES (app.tenant_id(), ${uuid()}, ${id}, 'phone', ${phone}, decode(${hmacHex(phone)}, 'hex'))`.execute(tx);
    await sql`INSERT INTO tags (tenant_id, id, name, created_by_kind, created_by_user_id) VALUES (app.tenant_id(), ${tagId}, ${`Buyer ${n}`}, 'user', ${w.owner.id})`.execute(tx);
    await sql`INSERT INTO contact_tags (tenant_id, contact_id, tag_id, added_by_kind, added_by_user_id) VALUES (app.tenant_id(), ${id}, ${tagId}, 'user', ${w.owner.id})`.execute(tx);
    await sql`INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body) VALUES (app.tenant_id(), ${uuid()}, ${id}, ${w.owner.id}, ${note})`.execute(tx);
    await sql`INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id)
              VALUES (app.tenant_id(), ${dealId}, 'Purchase', 'buy', 'active', now(), ${id}, ${w.agents[0]!.id})`.execute(tx);
    await sql`INSERT INTO deal_contacts (tenant_id, deal_id, contact_id, role) VALUES (app.tenant_id(), ${dealId}, ${id}, 'buyer')`.execute(tx);
    await sql`INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, created_by_kind, created_by_user_id)
              VALUES (app.tenant_id(), ${taskId}, ${w.agents[0]!.id}, ${id}, 'follow_up', 'Call back about the yard', 'user', ${w.owner.id})`.execute(tx);
    await sql`INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose, event_type, consent_level,
                source, occurred_at, actor_kind, actor_user_id, contact_id)
              VALUES (app.tenant_id(), ${dncEventId}, 'email', decode(${hmacHex(`old-${dncEventId}@optout.test`)}, 'hex'), '•••', 'email', 'all', 'revoke',
                'none', 'agent_revoke', now(), 'user', ${w.owner.id}, ${id})`.execute(tx);
    await sql`UPDATE contacts SET do_not_contact_at = now(), do_not_contact_event_id = ${dncEventId} WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  });
  // the open web chat (system actor: a person never writes webchat_sessions)
  const chatAddress = `wc:${uuid().replace(/-/g, '')}`;
  const pointId = uuid();
  const sessionId = uuid();
  await as(w.system('provider'), async (tx) => {
    await sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, label)
              VALUES (app.tenant_id(), ${pointId}, ${id}, 'web_chat', ${chatAddress}, decode(md5(${chatAddress}) || md5(${chatAddress}), 'hex'), 'other')`.execute(tx);
    await sql`INSERT INTO webchat_sessions (tenant_id, id, connection_id, token_hash, origin, started_at, last_seen_at, contact_id, contact_point_id)
              VALUES (app.tenant_id(), ${sessionId}, ${connectionId}, decode(md5(${sessionId}) || md5(${sessionId}), 'hex'), 'https://www.team-site.test',
                      now(), now(), ${id}, ${pointId})`.execute(tx);
  });
  return { id, phone, tagId, note, sessionId, chatAddress, dealId, taskId, dncEventId };
}

const one = async <T extends Record<string, unknown>>(text: string, values: unknown[]) => (await suRows<T>(h.su, text, values))[0]!;

/** Where the loser's person data is now: counts on the survivor `s` and on the loser. */
async function placement(s: ContactId, l: Loser) {
  return {
    phoneOnSurvivor: (await one<{ n: number }>(`SELECT count(*)::int AS n FROM contact_points WHERE contact_id = $1 AND kind = 'phone' AND address = $2`, [s, l.phone])).n,
    chatPointOnSurvivor: (await one<{ n: number }>(`SELECT count(*)::int AS n FROM contact_points WHERE contact_id = $1 AND kind = 'web_chat' AND address = $2`, [s, l.chatAddress])).n,
    tag: await suRows(h.su, 'SELECT contact_id FROM contact_tags WHERE tag_id = $1 ORDER BY contact_id', [l.tagId]),
    note: await suRows(h.su, 'SELECT contact_id FROM notes WHERE body = $1', [l.note]),
    session: (await one<{ contact_id: string }>('SELECT contact_id FROM webchat_sessions WHERE id = $1', [l.sessionId])).contact_id,
    roles: await suRows(h.su, 'SELECT contact_id, role FROM deal_contacts WHERE deal_id = $1 ORDER BY contact_id', [l.dealId]),
    primary: (await one<{ primary_contact_id: string }>('SELECT primary_contact_id FROM deals WHERE id = $1', [l.dealId])).primary_contact_id,
    survivorDnc: (await one<{ do_not_contact_event_id: string | null }>('SELECT do_not_contact_event_id FROM contacts WHERE id = $1', [s])).do_not_contact_event_id,
    mergedAway: (await one<{ n: number }>(`SELECT count(*)::int AS n FROM lead_ownership_events WHERE contact_id = $1 AND type = 'merged_away'`, [l.id])).n,
    loser: await one('SELECT merged_into_contact_id, closed_reason FROM contacts WHERE id = $1', [l.id]),
  };
}

/** Every merge trigger acted exactly once: one copy of each point, each row moved once, the do-not-contact carried. */
async function expectMergedOnce(s: ContactId, l: Loser): Promise<void> {
  expect(await placement(s, l)).toEqual({
    phoneOnSurvivor: 1,
    chatPointOnSurvivor: 1,
    tag: [{ contact_id: s }],
    note: [{ contact_id: s }],
    session: s,
    roles: [{ contact_id: s, role: 'buyer' }],
    primary: s,
    survivorDnc: l.dncEventId,
    mergedAway: 1,
    loser: { merged_into_contact_id: s, closed_reason: 'merged' },
  });
}

/** Nothing of the loser moved and it is not marked merged. */
async function expectNothingMoved(s: ContactId, l: Loser): Promise<void> {
  expect(await placement(s, l)).toEqual({
    phoneOnSurvivor: 0,
    chatPointOnSurvivor: 0,
    tag: [{ contact_id: l.id }],
    note: [{ contact_id: l.id }],
    session: l.id,
    roles: [{ contact_id: l.id, role: 'buyer' }],
    primary: l.id,
    survivorDnc: null,
    mergedAway: 0,
    loser: { merged_into_contact_id: null, closed_reason: null },
  });
  expect((await one<{ contact_id: string }>('SELECT contact_id FROM tasks WHERE id = $1', [l.taskId])).contact_id).toBe(l.id);
}

const bareUpdate = (actor: Actor, loser: string, survivor: string, extra = sql``, commandId?: string) =>
  withTenantTx(actor, (tx) => sql`UPDATE contacts SET merged_into_contact_id = ${survivor} ${extra} WHERE tenant_id = app.tenant_id() AND id = ${loser}`.execute(tx),
    { db: h.app, ...(commandId ? { ownershipCommand: commandId } : {}) });

async function engineMerge(actor: Actor, survivor: string, loser: string, commandId = uuid()) {
  const r = await cmd(h.app, actor, survivor as ContactId, { kind: 'merge', survivorId: survivor as ContactId, loserId: loser as ContactId, ownerChoice: null }, { commandId });
  expect(r.outcome.ok, JSON.stringify(r.outcome)).toBe(true);
  return commandId;
}

describe('R-OWN-24 contacts_guard covers merged_into_contact_id', () => {
  it('R-OWN-24 E546: an Owner\'s bare UPDATE of merged_into_contact_id is MERGE_UNAUDITED; no point, tag, note, webchat session, deal role, task or do-not-contact moved', async () => {
    const s = await selfCreated(h.app, w, w.agents[0]!, 'Jane Buyer');
    const l = await seedLoser(await selfCreated(h.app, w, w.agents[0]!, 'Jane B.'));
    await expect(bareUpdate(w.owner.actor, l.id, s)).rejects.toThrow(/MERGE_UNAUDITED/);
    // nor with the rest of a merge forged around it: closed as merged, under an ownership command that has no
    // merged_away event for this record (the guard refuses before any other rule)
    const forged = uuid();
    await expect(bareUpdate(w.owner.actor, l.id, s, sql`, ownership_state = 'closed', closed_reason = 'merged', ownership_command_id = ${forged}`, forged))
      .rejects.toThrow(/MERGE_UNAUDITED/);
    // a Team Lead and the agent who owns both are refused the same way
    await expect(bareUpdate(w.tl!.actor, l.id, s)).rejects.toThrow(/MERGE_UNAUDITED/);
    await expect(bareUpdate(w.agents[0]!.actor, l.id, s)).rejects.toThrow(/MERGE_UNAUDITED/);
    await expectNothingMoved(s, l);
    // the error is insufficient_privilege (42501)
    const code = await bareUpdate(w.owner.actor, l.id, s).then(() => null, (e: { code?: string }) => e.code ?? null);
    expect(code).toBe('42501');
  });

  it('R-OWN-24 E547: re-pointing and INSERT with merged_into are refused; a superuser UPDATE with no tenant context still works', async () => {
    const s = await selfCreated(h.app, w, w.agents[0]!, 'Ann Root');
    const other = await selfCreated(h.app, w, w.agents[0]!, 'Ann Other');
    const l = await selfCreated(h.app, w, w.agents[0]!, 'Ann Dup');
    const mergeCmd = await engineMerge(w.owner.actor, s, l);
    // re-pointing a merged-away record, even inside the very ownership command that merged it
    await expect(bareUpdate(w.owner.actor, l, other)).rejects.toThrow(/MERGE_UNAUDITED/);
    await expect(bareUpdate(w.owner.actor, l, other, sql``, mergeCmd)).rejects.toThrow(/MERGE_UNAUDITED/);
    expect(await one('SELECT merged_into_contact_id FROM contacts WHERE id = $1', [l])).toEqual({ merged_into_contact_id: s });
    // an unchanged value is not a merge (a later write of the row, e.g. its do-not-contact, still works)
    await expect(bareUpdate(w.owner.actor, l, s)).resolves.toBeDefined();
    // a record is never created merged away, whoever inserts it
    for (const actor of [w.owner.actor, w.system('provider')]) {
      await expect(as(actor, (tx) => sql`INSERT INTO contacts (tenant_id, id, display_name, merged_into_contact_id, ownership_state, closed_reason)
        VALUES (app.tenant_id(), ${uuid()}, 'Born Merged', ${s}, 'closed', 'merged')`.execute(tx))).rejects.toThrow(/MERGE_UNAUDITED/);
    }
    // platform maintenance: a superuser with no tenant context is not checked (only it, or a BYPASSRLS role, reaches
    // the row then); the follow-merge do-not-contact trigger still runs
    const ls = await seedLoser(await selfCreated(h.app, w, w.agents[0]!, 'Ann Fixture'));
    const r = await h.su.query('UPDATE contacts SET merged_into_contact_id = $1 WHERE id = $2', [other, ls.id]);
    expect(r.rowCount).toBe(1);
    expect(await one('SELECT merged_into_contact_id, do_not_contact_event_id FROM contacts WHERE id = $1', [ls.id])).toEqual({ merged_into_contact_id: other, do_not_contact_event_id: ls.dncEventId });
    expect((await one<{ do_not_contact_event_id: string }>('SELECT do_not_contact_event_id FROM contacts WHERE id = $1', [other])).do_not_contact_event_id).toBe(ls.dncEventId);
    // and the FK's ON DELETE SET NULL path (a clear) is never checked: a person clearing it is not a merge either
    await expect(withTenantTx(w.owner.actor, (tx) => sql`UPDATE contacts SET merged_into_contact_id = NULL WHERE tenant_id = app.tenant_id() AND id = ${ls.id}`.execute(tx), { db: h.app }))
      .resolves.toBeDefined();
  });

  it('R-OWN-24 E548 (guard): engine merges by the Owner, a Team Lead (follow-up pending, loser on offer) and the system, one with an upper-case survivor id: every merge trigger acts once', async () => {
    // the Owner (tenant-wide: communication moves in the merge transaction)
    const s1 = await selfCreated(h.app, w, w.agents[0]!, 'Ola Survivor');
    const l1 = await seedLoser(await selfCreated(h.app, w, w.agents[0]!, 'Ola Dup'));
    await engineMerge(w.owner.actor, s1, l1.id);
    await expectMergedOnce(s1, l1);

    // a Team Lead, the loser a lead still on offer to the agent; the communication move waits for the follow-up
    const s2 = await selfCreated(h.app, w, w.agents[0]!, 'Tia Survivor');
    const offered = await intakeLead(h.app, w, BUY, 'Tia Inquiry');
    expect((await one<{ ownership_state: string }>('SELECT ownership_state FROM contacts WHERE id = $1', [offered.contactId])).ownership_state).toBe('offered');
    const l2 = await seedLoser(offered.contactId);
    await engineMerge(w.tl!.actor, s2, l2.id);
    expect((await pendingFollowups(h.su, w.tenantId)).length).toBeGreaterThan(0);
    await expectMergedOnce(s2, l2);
    expect(await drainFollowups(h, w)).toBeGreaterThan(0);
    await expectMergedOnce(s2, l2);

    // the system (worker), handed the survivor id in upper case: the ledger keeps it as given, the column is a uuid
    const s3 = await selfCreated(h.app, w, w.agents[0]!, 'Sys Survivor');
    const l3 = await seedLoser(await selfCreated(h.app, w, w.agents[0]!, 'Sys Dup'));
    const upper = s3.toUpperCase();
    expect(upper).not.toBe(s3);
    await engineMerge(w.system('worker'), upper, l3.id);
    expect((await one<{ s: string }>(`SELECT payload->>'survivorId' AS s FROM lead_ownership_events WHERE contact_id = $1 AND type = 'merged_away'`, [l3.id])).s).toBe(upper);
    await expectMergedOnce(s3, l3);
    await drainFollowups(h, w);
    await expectMergedOnce(s3, l3);
  });
});
