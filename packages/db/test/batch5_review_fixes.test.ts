// Batch 5 review fixes (migration 0041) at the database. Every application write goes through app_user (RLS); the
// superuser pool only reads back, moves purge_after (a clock fixture) and watches pg_stat_activity to know when a
// session is waiting on another one.
//
//   F1-ERASE-DNC-TOCTOU  app.purge_contact_internal checked app.person_optout_uncarried on its statement snapshot and
//                        deleted later: a point added to the person by a transaction still open at the check was
//                        cascade-deleted with no revoke carried (D1). The purge now locks every record of the person
//                        first (FOR UPDATE conflicts with the FOR KEY SHARE every point insert's FK check holds), so the
//                        check sees the point and refuses.
//   F2-ERASE-HELD-LEAD-EMAIL  held lead emails carry their parsed addresses' HMACs (point_hmacs); erasure purges the
//                        person's held emails, and the retention sweep expires held content after 30 days. Only the
//                        retention role may make those transitions (guard).
//   F4-ERASE-POND-PHANTOM-COUNT  a contact delete marks every member holding a feed group of it, so the member's
//                        stored count (GET /feed's total) is re-scored.
//   F1 (bulk stage)      a stage change written by the bulk runner records its bulk action (app.bulk_action_id, checked
//                        by the definer), so the stage automation can refuse to start a plan for a protected audience.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Channel, ConsentEventSpec } from '@realty/core/compliance';
import type { Actor, ContactId, Instant } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordConsentEvent } from '../src/consent.js';
import { withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { cmd, createHarness, createWorld, type Harness, type Member, selfCreated, suFixture, suRows, uuid, type World } from './world.js';

let h: Harness;
let w: World;
let agent: Member;

beforeAll(async () => {
  h = await createHarness(6);
  w = await createWorld(h.app, { agents: 1 });
  agent = w.agents[0]!;
}, 120_000);
afterAll(async () => {
  await h?.close();
});

const as = <T>(actor: Actor, fn: Parameters<typeof withTenantTx<T>>[1]) => withTenantTx(actor, fn, { db: h.app });
const exists = async (id: string) => (await suRows(h.su, 'SELECT 1 FROM contacts WHERE id = $1', [id])).length === 1;
let seq = 0;
const hmacHex = (addr: string) => createHash('sha256').update(`test-hmac:${addr}`).digest('hex');
const phone = () => `+1555018${String(1000 + ++seq).slice(-4)}`;

async function point(by: Actor, contactId: string, address: string, kind: 'phone' | 'email' = 'phone'): Promise<string> {
  const id = uuid();
  await as(by, (tx) => sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
    VALUES (app.tenant_id(), ${id}, ${contactId}, ${kind}, ${address}, decode(${hmacHex(address)}, 'hex'))`.execute(tx));
  return id;
}
/** One agent_revoke for every purpose on (address, channel), through recordConsentEvent (ledger + projection). */
async function revoke(by: Actor, kind: 'phone' | 'email', address: string, channel: Channel): Promise<string> {
  const id = uuid();
  const spec: ConsentEventSpec = {
    id, addressKind: kind, addressHmac: hmacHex(address), addressHint: '•••', channel, purpose: 'all', eventType: 'revoke', level: 'none', source: 'agent_revoke',
    occurredAt: Date.now() as Instant, contactId: null, actor: by.kind === 'user' ? { kind: 'user', userId: by.userId } : { kind: 'system' },
    disclosureId: null, evidenceObjectId: null, evidenceMessageId: null, evidenceCallId: null, evidenceCallOffsetMs: null,
    evidence: {}, imported: false, importRecordId: null, originalProvenance: null, revertsEventId: null, expiresAt: null, needsReview: false,
  };
  await as(by, (tx) => recordConsentEvent(tx, spec));
  return id;
}
/**
 * A person who asked not to be contacted, whose do-not-contact is already on every address they have (what
 * POST /contacts/:id/do-not-contact leaves): nothing is left to carry, so an erasure takes no address lock.
 */
async function askedAndCarried(name: string): Promise<{ id: ContactId; phone: string }> {
  const id = await selfCreated(h.app, w, agent, name);
  const x = phone();
  await point(agent.actor, id, x);
  const ev = await revoke(agent.actor, 'phone', x, 'sms');
  await revoke(agent.actor, 'phone', x, 'voice');
  await as(agent.actor, (tx) => sql`UPDATE contacts SET do_not_contact_at = now(), do_not_contact_event_id = ${ev}::uuid WHERE id = ${id}::uuid`.execute(tx));
  expect(await suRows(h.su, 'SELECT 1 FROM app.person_optout_uncarried($1, $2)', [w.tenantId, id])).toEqual([]);
  return { id, phone: x };
}

/**
 * Runs `write` in a transaction as `by` and keeps it open (uncommitted) until the returned `commit()`: the in-flight
 * writer of the finding (an intake that attached a phone, a point route, an import fill).
 */
async function openWriter(by: Actor, write: (tx: Parameters<Parameters<typeof withTenantTx>[1]>[0]) => Promise<unknown>): Promise<{ pid: number; commit(): Promise<void> }> {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let ready!: (pid: number) => void;
  let failed!: (e: unknown) => void;
  const started = new Promise<number>((res, rej) => {
    ready = res;
    failed = rej;
  });
  const done = as(by, async (tx) => {
    await write(tx);
    ready((await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx)).rows[0]!.pid);
    await held;
  }).catch((e) => {
    failed(e);
    throw e;
  });
  const pid = await started;
  return {
    pid,
    async commit() {
      release();
      await done;
    },
  };
}

/** Waits until some session is blocked (lock wait) by backend `pid`. */
async function waitBlockedBy(pid: number, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await suRows<{ n: number }>(h.su, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND $1 = ANY (pg_blocking_pids(pid))`, [pid]);
    if (r[0]!.n > 0) return;
    if (Date.now() > until) throw new Error(`nobody waited on backend ${pid}`);
    await new Promise((res) => setTimeout(res, 10));
  }
}

const erase = (id: string) => as(w.owner.actor, (tx) => sql`SELECT app.erase_contact(${id}::uuid, ${randomUUID()}::uuid, 'PRIVACY_REQUEST')`.execute(tx));
const sweep = () => withPreTenant(async (tx) => (await sql<{ r: Record<string, number> }>`SELECT app.retention_sweep(now()) AS r`.execute(tx)).rows[0]!.r, { db: h.app });

describe('F1-ERASE-DNC-TOCTOU: the purge locks the person before its do-not-contact check (D1, R-DATA-4, R-DATA-5)', () => {
  it('D1 R-DATA-4: an erasure that overlaps an uncommitted point write to the person waits for it, then refuses PERSON_DO_NOT_CONTACT_UNCARRIED and deletes nothing (before: it deleted the new point with no revoke)', async () => {
    const p = await askedAndCarried('Dana Overlap');
    const later = phone();
    const writer = await openWriter(agent.actor, (tx) => sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
      VALUES (app.tenant_id(), ${uuid()}, ${p.id}, 'phone', ${later}, decode(${hmacHex(later)}, 'hex'))`.execute(tx));
    const erasing = erase(p.id).then(() => 'erased', (e: Error) => e.message);
    await waitBlockedBy(writer.pid);
    await writer.commit();
    expect(await erasing).toMatch(/^PERSON_DO_NOT_CONTACT_UNCARRIED/);
    expect(await exists(p.id)).toBe(true);
    expect((await suRows<{ address: string }>(h.su, 'SELECT address FROM contact_points WHERE contact_id = $1 ORDER BY address', [p.id])).map((r) => r.address)).toEqual([p.phone, later].sort());
    // carried now, the same erasure goes through and the later phone keeps the revoke (HMAC-keyed, it outlives the person)
    await revoke(w.owner.actor, 'phone', later, 'sms');
    await revoke(w.owner.actor, 'phone', later, 'voice');
    await erase(p.id);
    expect(await exists(p.id)).toBe(false);
    const kept = await suRows<{ k: string }>(h.su, `SELECT channel || ':' || purpose AS k FROM consent_state WHERE tenant_id = $1 AND status = 'revoked' AND address_hmac = decode($2, 'hex') ORDER BY 1`, [w.tenantId, hmacHex(later)]);
    expect(kept.map((r) => r.k)).toEqual(['sms:informational', 'sms:marketing', 'voice:informational', 'voice:marketing']);
  });

  it('D1 R-DATA-4: a point write that starts after the erasure locked the person waits, then fails on the deleted person (never a point left on nobody, never an uncarried one)', async () => {
    const p = await askedAndCarried('Eli After');
    // a superuser session holds the erase transaction open after the purge took its row locks
    const c = await h.su.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_kind', 'user', true), set_config('app.principal_type', 'staff', true)`, [w.tenantId, w.owner.id]);
      await c.query('SELECT app.purge_contact_internal($1, $2)', [w.tenantId, p.id]);
      const pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const late = point(agent.actor, p.id, phone()).then(() => 'inserted', (e: Error & { code?: string }) => e.code ?? e.message);
      await waitBlockedBy(pid);
      await c.query('COMMIT');
      expect(await late).toBe('23503'); // foreign_key_violation: the person is gone
    } finally {
      c.release();
    }
    expect(await exists(p.id)).toBe(false);
  });

  it('D1 R-DATA-5: the retention sweep that overlaps an uncommitted point write to a due person waits for it, then skips that person (contacts_skipped) instead of purging the new point with no revoke', async () => {
    const p = await askedAndCarried('Fay Sweep');
    expect((await cmd(h.app, w.owner.actor, p.id, { kind: 'soft_delete' })).outcome.ok).toBe(true);
    await suFixture(h.su, "UPDATE contacts SET purge_after = now() - interval '1 minute' WHERE id = $1", [p.id]);
    const later = phone();
    // the Owner (tenant-wide) still sees a soft-deleted person; an agent does not
    const writer = await openWriter(w.owner.actor, (tx) => sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
      VALUES (app.tenant_id(), ${uuid()}, ${p.id}, 'phone', ${later}, decode(${hmacHex(later)}, 'hex'))`.execute(tx));
    const sweeping = sweep();
    await waitBlockedBy(writer.pid);
    await writer.commit();
    const r = await sweeping;
    expect(await exists(p.id)).toBe(true);
    expect(r.contacts_skipped).toBeGreaterThanOrEqual(1);
    expect(await suRows(h.su, 'SELECT 1 FROM app.retention_optout_carry_due(now(), 500) WHERE contact_id = $1', [p.id])).toHaveLength(1);
  });
});

// ---- F2: held lead emails ---------------------------------------------------------------------------------------
describe('F2-ERASE-HELD-LEAD-EMAIL: held lead emails go with the person, and expire (R-DATA-4, R-DATA-3, R-LEM-5)', () => {
  let connectionId = '';
  beforeAll(async () => {
    connectionId = uuid();
    await as(w.system('provider'), async (tx) => {
      await sql`INSERT INTO integration_connections (tenant_id, id, kind, display_name, lead_source_id) VALUES (app.tenant_id(), ${connectionId}, 'lead_email', 'Lead email: Website', ${w.leadSourceId})`.execute(tx);
      await sql`UPDATE integration_connections SET status = 'connected', connected_at = clock_timestamp() WHERE tenant_id = app.tenant_id() AND id = ${connectionId} AND status = 'not_configured'`.execute(tx);
    });
  });
  /** A held row as the webhook writes it (system actor), with the parsed addresses' HMACs. */
  async function held(o: { hmacs: string[]; senderDomain?: string }): Promise<string> {
    const id = uuid();
    await as(w.system('provider'), (tx) => sql`
      INSERT INTO lead_email_messages (tenant_id, id, connection_id, lead_source_id, message_key_sha256, provider_format, received_at, status, hold_code,
                                       sender_domain, dkim_pass_domains, content_enc, parsed_enc, point_hmacs)
      VALUES (app.tenant_id(), ${id}, ${connectionId}, ${w.leadSourceId}, ${randomBytes(32)}, 'generic', clock_timestamp(), 'needs_review', 'SENDER_NOT_ALLOWED',
              ${o.senderDomain ?? 'janedoe-family.test'}, ARRAY['janedoe-family.test'], '\\x01'::bytea, '\\x02'::bytea,
              ${o.hmacs.map((x) => Buffer.from(x, 'hex'))}::bytea[])`.execute(tx));
    return id;
  }
  const row = async (id: string) =>
    (await suRows<{ status: string; content: boolean; parsed: boolean; hmacs: number; sender_domain: string | null; dkim: string[]; key: boolean }>(h.su, `
      SELECT status, content_enc IS NOT NULL AS content, parsed_enc IS NOT NULL AS parsed, cardinality(point_hmacs) AS hmacs, sender_domain,
             dkim_pass_domains AS dkim, octet_length(message_key_sha256) = 32 AS key
        FROM lead_email_messages WHERE id = $1`, [id]))[0]!;

  it('R-LEM-5: only the retention role ends a held email as erased or expired; the system actor (the webhook, a reviewer\'s decision) cannot, nor can it drop the trust facts', async () => {
    const id = await held({ hmacs: [hmacHex(phone())] });
    for (const status of ['erased', 'expired']) {
      await expect(as(w.system('provider'), (tx) => sql`UPDATE lead_email_messages SET status = ${status}, content_enc = NULL, parsed_enc = NULL, point_hmacs = '{}', sender_domain = NULL, dkim_pass_domains = '{}'
        WHERE id = ${id}::uuid`.execute(tx))).rejects.toThrow(/LEAD_EMAIL_(TRANSITION|IMMUTABLE)/);
    }
    await expect(as(w.system('provider'), (tx) => sql`UPDATE lead_email_messages SET sender_domain = NULL WHERE id = ${id}::uuid`.execute(tx))).rejects.toThrow(/LEAD_EMAIL_IMMUTABLE/);
    expect(await row(id)).toMatchObject({ status: 'needs_review', content: true, parsed: true, hmacs: 1 });
  });

  it('R-DATA-4: erasing a person (and a duplicate merged into them) purges every held email naming one of their addresses, live or removed: content, parse, address keys and sender domain gone, the message key kept as a replay tombstone; a stranger\'s held email stays', async () => {
    const s = await selfCreated(h.app, w, agent, 'Hal Survivor');
    const l = await selfCreated(h.app, w, agent, 'Hal Duplicate');
    const [a, b, c] = [phone(), phone(), phone()];
    await point(agent.actor, s, a);
    const old = await point(agent.actor, s, b);
    await as(agent.actor, (tx) => sql`UPDATE contact_points SET status = 'removed', removed_at = now(), removed_reason = 'old' WHERE id = ${old}::uuid`.execute(tx));
    await point(agent.actor, l, c);
    expect((await cmd(h.app, w.owner.actor, s, { kind: 'merge', survivorId: s, loserId: l, ownerChoice: null })).outcome.ok).toBe(true);
    const viaLive = await held({ hmacs: [hmacHex(a)] });
    const viaRemoved = await held({ hmacs: [hmacHex(phone()), hmacHex(b)] });
    const viaMerged = await held({ hmacs: [hmacHex(c)] });
    const stranger = await held({ hmacs: [hmacHex(phone())] });
    await erase(s);
    expect([await exists(s), await exists(l)]).toEqual([false, false]);
    for (const id of [viaLive, viaRemoved, viaMerged]) {
      expect(await row(id), id).toEqual({ status: 'erased', content: false, parsed: false, hmacs: 0, sender_domain: null, dkim: [], key: true });
    }
    expect(await row(stranger)).toMatchObject({ status: 'needs_review', content: true, parsed: true, hmacs: 1, sender_domain: 'janedoe-family.test' });
  });

  it('R-DATA-3: the retention sweep expires held content 30 days after receipt (status expired, content, parse, keys and sender domain gone); a newer held email stays', async () => {
    const oldOne = await held({ hmacs: [hmacHex(phone())] });
    const fresh = await held({ hmacs: [hmacHex(phone())] });
    await suFixture(h.su, "UPDATE lead_email_messages SET received_at = now() - interval '31 days' WHERE id = $1", [oldOne]);
    const r = await sweep();
    expect(r.lead_emails_expired).toBeGreaterThanOrEqual(1);
    expect(await row(oldOne)).toEqual({ status: 'expired', content: false, parsed: false, hmacs: 0, sender_domain: null, dkim: [], key: true });
    expect(await row(fresh)).toMatchObject({ status: 'needs_review', content: true, parsed: true });
  });
});

// ---- F4: feed counts of a deleted contact -----------------------------------------------------------------------
describe('F4-ERASE-POND-PHANTOM-COUNT: a contact delete marks every member holding its feed group (feed_incremental)', () => {
  it('erasing a person marks each member that holds a feed group of any of their records (the survivor and a merged duplicate), and nobody else', async () => {
    const s = await selfCreated(h.app, w, agent, 'Ivy Feed');
    const l = await selfCreated(h.app, w, agent, 'Ivy Feed Duplicate');
    expect((await cmd(h.app, w.owner.actor, s, { kind: 'merge', survivorId: s, loserId: l, ownerChoice: null })).outcome.ok).toBe(true);
    // the materializer's stored counts (each member writes only their own group rows)
    for (const [m, g] of [[agent, `c:${s}`], [agent, `c:${l}`], [w.owner, `c:${s}`]] as const) {
      await as(m.actor, (tx) => sql`INSERT INTO feed_groups (tenant_id, user_id, group_key, check_at, n_open) VALUES (app.tenant_id(), app.user_id(), ${g}, now() + interval '1 day', 1)`.execute(tx));
    }
    await suRows(h.su, 'DELETE FROM feed_dirty WHERE tenant_id = $1', [w.tenantId]);
    await erase(s);
    const marks = await suRows<{ user_id: string; group_key: string }>(h.su, 'SELECT DISTINCT user_id, group_key FROM feed_dirty WHERE tenant_id = $1 ORDER BY 1, 2', [w.tenantId]);
    expect(marks).toEqual([
      { user_id: agent.id, group_key: `c:${s}` },
      { user_id: agent.id, group_key: `c:${l}` },
      { user_id: w.owner.id, group_key: `c:${s}` },
    ].sort((x, y) => (x.user_id + x.group_key < y.user_id + y.group_key ? -1 : 1)));
  });
});

// ---- F1 (bulk stage): the stage history names the bulk action -----------------------------------------------------
describe('F1 bulk stage: a stage change made by the bulk runner records its bulk action (R-PAR-8, R-PAR-16)', () => {
  async function stageDraft(by: Member, status: 'draft' | 'running' = 'running', kind = 'stage'): Promise<string> {
    const id = uuid();
    await as(by.actor, (tx) => sql`INSERT INTO bulk_actions (tenant_id, id, kind, status, created_by_user_id, created_by_role, source, params, idempotency_key)
      VALUES (app.tenant_id(), ${id}, ${kind}, 'draft', app.user_id(), ${by.role}, 'selection', ${JSON.stringify(kind === 'stage' ? { stage: 'nurture' } : { tagId: uuid() })}::jsonb, ${`k-${id}`})`.execute(tx));
    if (status === 'running') await suFixture(h.su, `UPDATE bulk_actions SET status = 'running', confirmed_at = now(), started_at = now(), target_count = 1 WHERE id = $1`, [id]);
    return id;
  }
  async function stageAs(by: Member, contactId: string, stage: string, bulkActionId: string | null): Promise<string | null> {
    return as(by.actor, async (tx) => {
      if (bulkActionId !== null) await sql`SELECT set_config('app.bulk_action_id', ${bulkActionId}, true)`.execute(tx);
      await sql`UPDATE contacts SET stage = ${stage} WHERE id = ${contactId}::uuid`.execute(tx);
      const r = await sql<{ b: string | null }>`SELECT bulk_action_id AS b FROM contact_stage_events WHERE contact_id = ${contactId}::uuid ORDER BY occurred_at DESC, id DESC LIMIT 1`.execute(tx);
      return r.rows[0]!.b;
    });
  }

  it('R-PAR-16: the history names the running stage action of the same creator; any other value (none, garbage, another person\'s action, a draft, another kind) records NULL', async () => {
    const c = await selfCreated(h.app, w, agent, 'Jo Stage');
    const mine = await stageDraft(agent);
    expect(await stageAs(agent, c, 'attempting', mine)).toBe(mine);
    expect(await stageAs(agent, c, 'connected', null)).toBeNull();
    expect(await stageAs(agent, c, 'nurture', 'not-a-uuid')).toBeNull();
    expect(await stageAs(agent, c, 'active', await stageDraft(w.owner))).toBeNull();
    expect(await stageAs(agent, c, 'nurture', await stageDraft(agent, 'draft'))).toBeNull();
    expect(await stageAs(agent, c, 'connected', await stageDraft(agent, 'running', 'tag'))).toBeNull();
  });

  it('R-PAR-16: a decision may be recorded as skipped for a protected audience (protected_audience)', async () => {
    const r = await suRows<{ ok: boolean }>(h.su, `SELECT pg_get_constraintdef(oid) ~ 'protected_audience' AS ok FROM pg_constraint
      WHERE conrelid = 'public.stage_automation_decisions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ~ 'not_a_person_change'`);
    expect(r).toEqual([{ ok: true }]);
  });
});
