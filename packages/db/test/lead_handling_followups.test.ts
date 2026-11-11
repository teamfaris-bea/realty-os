// The lead-handling follow-up migration (0037 when written) at the database: the address delete grant and its RESTRICTIVE policy,
// erasure / purge of a merge survivor (R-DATA-4, R-DATA-5), and the person-level do-not-contact that must be in the
// consent ledger on every address of the person before any record of them is deleted (D1, §2b). Every write goes
// through app_user (RLS) and the ownership engine; the superuser pool only reads, moves purge_after (a clock
// fixture), and builds the one corrupt state no application path can reach (a merge cycle) to show the merge tree
// still ends.
import { createHash, randomUUID } from 'node:crypto';
import type { Channel, ConsentEventSpec, ConsentSource } from '@realty/core/compliance';
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
  h = await createHarness(4);
  w = await createWorld(h.app, { agents: 1 });
  agent = w.agents[0]!;
}, 120_000);
afterAll(async () => {
  await h?.close();
});

const as = <T>(actor: Actor, fn: Parameters<typeof withTenantTx<T>>[1]) => withTenantTx(actor, fn, { db: h.app });
const exists = async (id: string) => (await suRows(h.su, 'SELECT 1 FROM contacts WHERE id = $1', [id])).length === 1;

async function merge(survivor: ContactId, loser: ContactId): Promise<void> {
  const r = await cmd(h.app, w.owner.actor, survivor, { kind: 'merge', survivorId: survivor, loserId: loser, ownerChoice: null });
  expect(r.outcome.ok).toBe(true);
}

describe('lead-handling follow-ups: address delete (module 57)', () => {
  it('app_user may DELETE contact_addresses, and only through the RESTRICTIVE contact_addresses_delete policy (detail visible, a user actor in an editing role)', async () => {
    expect((await suRows<{ ok: boolean }>(h.su, "SELECT has_table_privilege('app_user', 'public.contact_addresses', 'DELETE') AS ok"))[0]!.ok).toBe(true);
    const pol = await suRows<{ permissive: string; cmd: string; qual: string }>(h.su, `
      SELECT permissive, cmd, qual FROM pg_policies WHERE tablename = 'contact_addresses' AND policyname = 'contact_addresses_delete'`);
    expect(pol).toHaveLength(1);
    expect(pol[0]).toMatchObject({ permissive: 'RESTRICTIVE', cmd: 'DELETE' });
    expect(pol[0]!.qual).toMatch(/contact_detail_visible/);
    expect(pol[0]!.qual).toMatch(/actor_kind\(\).*'user'/s);
    expect(pol[0]!.qual).toMatch(/'owner'.*'admin'.*'team_lead'.*'agent'.*'isa'/s);
    expect(pol[0]!.qual).not.toMatch(/'tc'/);
  });

  it('the owning agent deletes an address of their own person; the system actor deletes none', async () => {
    const c = await selfCreated(h.app, w, agent, 'Ada Dress');
    const id = uuid();
    await as(agent.actor, (tx) => sql`INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, city) VALUES (app.tenant_id(), ${id}, ${c}, 'home', 'Reno')`.execute(tx));
    const del = (actor: Actor) => as(actor, async (tx) => Number((await sql`DELETE FROM contact_addresses WHERE id = ${id}::uuid`.execute(tx)).numAffectedRows ?? 0));
    expect(await del({ kind: 'system', tenantId: w.tenantId, via: 'worker' } as Actor)).toBe(0);
    expect(await del(agent.actor)).toBe(1);
  });
});

describe('lead-handling follow-ups: erasure and purge take the person with every record merged into it (R-DATA-4, R-DATA-5)', () => {
  it('R-DATA-4: app.erase_contact of a survivor erases its merged records (along a chain), writes one contact.erase row per record, and refuses CONTACT_ON_DEAL when a merged record is on a deal', async () => {
    const [a, b, c] = [await selfCreated(h.app, w, agent, 'A'), await selfCreated(h.app, w, agent, 'B'), await selfCreated(h.app, w, agent, 'C')];
    await merge(b, a);
    await merge(c, b);
    const tree = await suRows<{ contact_id: string; depth: number }>(h.su, 'SELECT contact_id, depth FROM app.contact_merge_tree($1, $2) ORDER BY depth', [w.tenantId, c]);
    expect(tree).toEqual([{ contact_id: c, depth: 0 }, { contact_id: b, depth: 1 }, { contact_id: a, depth: 2 }]);
    const audit = randomUUID();
    await as(w.owner.actor, (tx) => sql`SELECT app.erase_contact(${c}::uuid, ${audit}::uuid, 'PRIVACY_REQUEST')`.execute(tx));
    expect([await exists(a), await exists(b), await exists(c)]).toEqual([false, false, false]);
    const rows = await suRows<{ entity_id: string; changes: Record<string, unknown> }>(h.su, "SELECT entity_id, changes FROM audit_log WHERE action = 'contact.erase' AND entity_id = ANY ($1::uuid[]) ORDER BY seq", [[a, b, c]]);
    expect(rows).toEqual([
      { entity_id: c, changes: { erased: true } },
      { entity_id: b, changes: { erased: true, erased_with_contact_id: c } },
      { entity_id: a, changes: { erased: true, erased_with_contact_id: c } },
    ]);

    const [s, l] = [await selfCreated(h.app, w, agent, 'S'), await selfCreated(h.app, w, agent, 'L')];
    const deal = uuid();
    await as(w.owner.actor, (tx) => sql`INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id)
      VALUES (app.tenant_id(), ${deal}, 'Purchase', 'buy', 'active', now(), ${l}, ${agent.id})`.execute(tx));
    await merge(s, l);
    await expect(as(w.owner.actor, (tx) => sql`SELECT app.erase_contact(${s}::uuid, ${randomUUID()}::uuid, 'PRIVACY_REQUEST')`.execute(tx))).rejects.toThrow(/CONTACT_ON_DEAL/);
    expect([await exists(s), await exists(l)]).toEqual([true, true]);
  });

  it('R-DATA-5: the retention sweep purges a soft-deleted survivor with its merged record instead of failing on the contacts CHECK', async () => {
    const [s, l] = [await selfCreated(h.app, w, agent, 'Sweep S'), await selfCreated(h.app, w, agent, 'Sweep L')];
    await merge(s, l);
    const del = await cmd(h.app, w.owner.actor, s, { kind: 'soft_delete' });
    expect(del.outcome.ok).toBe(true);
    await suFixture(h.su, "UPDATE contacts SET purge_after = now() - interval '1 minute' WHERE id = $1", [s]);
    // as the worker calls it: app_user, no tenant context (the definer runs as app_retention)
    const swept = await withPreTenant(async (tx) => (await sql<{ r: Record<string, number> }>`SELECT app.retention_sweep(now()) AS r`.execute(tx)).rows[0]!.r, { db: h.app });
    expect(swept.contacts_purged).toBeGreaterThanOrEqual(1);
    expect([await exists(s), await exists(l)]).toEqual([false, false]);
  });

  it('the merge tree ends even on a merge cycle no application path can make (CYCLE clause)', async () => {
    const [x, y] = [await selfCreated(h.app, w, agent, 'Cycle X'), await selfCreated(h.app, w, agent, 'Cycle Y')];
    // corrupt state, superuser with triggers off: X merged into Y and Y merged into X
    await suFixture(h.su, `UPDATE contacts SET ownership_state = 'closed', closed_reason = 'merged', owner_user_id = NULL, owned_at = NULL, ownership_period_seq = NULL,
                                  first_touch_due_at = NULL, release_due_at = NULL, inactivity_warn_at = NULL, inactivity_release_at = NULL,
                                  merged_into_contact_id = CASE WHEN id = $1::uuid THEN $2::uuid ELSE $1::uuid END
                            WHERE id IN ($1::uuid, $2::uuid)`, [x, y]);
    const tree = await suRows<{ contact_id: string }>(h.su, 'SELECT contact_id FROM app.contact_merge_tree($1, $2)', [w.tenantId, x]);
    expect(tree.map((t) => t.contact_id).sort()).toEqual([x, y].sort());
  });
});

describe('lead-handling follow-ups: a person-level do-not-contact outlives the person (D1, §2b)', () => {
  let seq = 0;
  const hmacHex = (addr: string) => createHash('sha256').update(`test-hmac:${addr}`).digest('hex');
  const phone = () => `+1555017${String(1000 + ++seq).slice(-4)}`;
  const email = () => `dnc-${++seq}-${randomUUID().slice(0, 6)}@example.test`;
  type Kind = 'phone' | 'email';

  async function point(contactId: string, kind: Kind, address: string): Promise<string> {
    const id = uuid();
    await as(agent.actor, (tx) => sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
      VALUES (app.tenant_id(), ${id}, ${contactId}, ${kind}, ${address}, decode(${hmacHex(address)}, 'hex'))`.execute(tx));
    return id;
  }
  /** One revoke for every purpose, recorded as `actor` through recordConsentEvent (the ledger + its projection). */
  async function revoke(actor: Actor, kind: Kind, address: string, channel: Channel, source: ConsentSource = 'agent_revoke'): Promise<string> {
    const id = uuid();
    const spec: ConsentEventSpec = {
      id, addressKind: kind, addressHmac: hmacHex(address), addressHint: '•••', channel, purpose: 'all', eventType: 'revoke', level: 'none', source,
      occurredAt: Date.now() as Instant, contactId: null, actor: actor.kind === 'user' ? { kind: 'user', userId: actor.userId } : { kind: 'system' },
      disclosureId: null, evidenceObjectId: null, evidenceMessageId: source.startsWith('inbound_') ? uuid() : null, evidenceCallId: null, evidenceCallOffsetMs: null,
      evidence: {}, imported: false, importRecordId: null, originalProvenance: null, revertsEventId: null, expiresAt: null, needsReview: source === 'inbound_language',
    };
    await as(actor, (tx) => recordConsentEvent(tx, spec));
    return id;
  }
  /** The person-level do-not-contact, citing a revoke (any writer of the contact may set it, 0018). */
  const doNotContact = (contactId: string, eventId: string) =>
    as(agent.actor, (tx) => sql`UPDATE contacts SET do_not_contact_at = now(), do_not_contact_event_id = ${eventId}::uuid WHERE id = ${contactId}::uuid`.execute(tx));
  const remove = (pointId: string, reason: 'old' | 'wrong_number') =>
    as(agent.actor, (tx) => sql`UPDATE contact_points SET status = 'removed', removed_at = now(), removed_reason = ${reason} WHERE id = ${pointId}::uuid`.execute(tx));
  /** (address, channel) pairs still to carry, as the superuser sees them (the definers' view). */
  const uncarried = async (contactId: string) =>
    (await suRows<{ k: string }>(h.su, `SELECT DISTINCT address || ' ' || channel AS k FROM app.person_optout_uncarried($1, $2) ORDER BY 1`, [w.tenantId, contactId])).map((r) => r.k);
  /** Carries what is listed, as the erase route and the worker do (agent_revoke, every purpose). */
  async function carry(actor: Actor, contactId: string): Promise<void> {
    const rows = await suRows<{ kind: Kind; address: string; channel: Channel }>(h.su, 'SELECT DISTINCT kind, address, channel FROM app.person_optout_uncarried($1, $2)', [w.tenantId, contactId]);
    for (const r of rows) await revoke(actor, r.kind, r.address, r.channel);
  }
  const sweep = (at = sql`now()`) => withPreTenant(async (tx) => (await sql<{ r: Record<string, number> }>`SELECT app.retention_sweep(${at}) AS r`.execute(tx)).rows[0]!.r, { db: h.app });
  async function softDeletedAndDue(id: ContactId): Promise<void> {
    expect((await cmd(h.app, w.owner.actor, id, { kind: 'soft_delete' })).outcome.ok).toBe(true);
    await suFixture(h.su, "UPDATE contacts SET purge_after = now() - interval '1 minute' WHERE id = $1", [id]);
  }
  const due = (actor?: Actor) => {
    const q = (tx: Parameters<Parameters<typeof withPreTenant>[0]>[0]) =>
      sql<{ contact_id: string }>`SELECT contact_id FROM app.retention_optout_carry_due(now(), 500)`.execute(tx).then((r) => r.rows.map((x) => x.contact_id));
    return actor ? as(actor, q) : withPreTenant(q, { db: h.app });
  };

  it('D1: app.person_optout_uncarried lists, once any record of the person carries a do-not-contact, each (address, channel) of the contact and of the records merged into it, live or removed, without a revoke only the person can lift: a keyword STOP or opt-out language does not count, a confirmed wrong number is left out; RLS bounds what app_user sees', async () => {
    const p = await selfCreated(h.app, w, agent, 'Dee Carry');
    const [a, b, c, d, e, g] = [phone(), phone(), phone(), phone(), phone(), phone()];
    const f = email();
    await point(p, 'phone', a);
    const asked = await revoke(agent.actor, 'phone', a, 'sms');
    await revoke(agent.actor, 'phone', a, 'voice');
    await point(p, 'phone', b);
    await revoke(w.system('provider'), 'phone', b, 'sms', 'inbound_keyword'); // STOP: the person's START would pop it
    await point(p, 'phone', c);
    await revoke(w.system('provider'), 'phone', c, 'sms', 'inbound_language'); // a reviewer may mark it "not an opt-out"
    await revoke(w.system('provider'), 'phone', c, 'voice', 'inbound_language');
    await remove(await point(p, 'phone', d), 'old');
    const wrong = await point(p, 'phone', e);
    await revoke(agent.actor, 'phone', e, 'sms', 'wrong_number');
    await remove(wrong, 'wrong_number'); // reaches someone else: not the person's to carry
    await point(p, 'email', f);
    const l = await selfCreated(h.app, w, agent, 'Dee Duplicate');
    await point(l, 'phone', g);
    expect(await uncarried(p)).toEqual([]); // no do-not-contact: nothing to carry
    await doNotContact(p, asked);
    await merge(p, l);
    const expected = [`${b} sms`, `${b} voice`, `${c} sms`, `${c} voice`, `${d} sms`, `${d} voice`, `${f} email`, `${g} sms`, `${g} voice`].sort();
    expect(await uncarried(p)).toEqual(expected);
    expect(await uncarried(l)).toEqual([]); // L alone (its own tree) has no do-not-contact of its own: the flag went to P
    // as app_user the function reads through the caller's RLS: the Owner (tenant-wide) sees the same; another tenant nothing
    const asOwner = await as(w.owner.actor, async (tx) => (await sql<{ k: string }>`SELECT DISTINCT address || ' ' || channel AS k FROM app.person_optout_uncarried(app.tenant_id(), ${p}::uuid) ORDER BY 1`.execute(tx)).rows.map((r) => r.k));
    expect(asOwner).toEqual(expected);
    const other = await createWorld(h.app, { agents: 1 });
    const fromOther = await withTenantTx(other.owner.actor, async (tx) => (await sql`SELECT 1 FROM app.person_optout_uncarried(${w.tenantId}::uuid, ${p}::uuid)`.execute(tx)).rows, { db: h.app });
    expect(fromOther).toEqual([]);
    // carried: an agent_revoke on each listed pair (also on top of the STOP and the language revokes)
    await carry(w.owner.actor, p);
    expect(await uncarried(p)).toEqual([]);
  });

  it('D1 R-DATA-4: app.erase_contact refuses PERSON_DO_NOT_CONTACT_UNCARRIED while an address of the person lacks the revoke, deleting nothing, and erases once each one carries it', async () => {
    const q = await selfCreated(h.app, w, agent, 'Quinn Asked');
    const [x, y] = [phone(), email()];
    await point(q, 'phone', x);
    await point(q, 'email', y);
    await doNotContact(q, await revoke(agent.actor, 'phone', x, 'sms'));
    expect(await uncarried(q)).toEqual([`${x} voice`, `${y} email`]);
    await expect(as(w.owner.actor, (tx) => sql`SELECT app.erase_contact(${q}::uuid, ${randomUUID()}::uuid, 'PRIVACY_REQUEST')`.execute(tx))).rejects.toThrow(/PERSON_DO_NOT_CONTACT_UNCARRIED/);
    expect(await exists(q)).toBe(true);
    await carry(w.owner.actor, q);
    await as(w.owner.actor, (tx) => sql`SELECT app.erase_contact(${q}::uuid, ${randomUUID()}::uuid, 'PRIVACY_REQUEST')`.execute(tx));
    expect(await exists(q)).toBe(false);
    // the ledger outlives the person: every channel of both addresses stays revoked (HMAC, no PII)
    const kept = await suRows<{ k: string }>(h.su, `SELECT channel || ':' || purpose AS k FROM consent_state WHERE tenant_id = $1 AND status = 'revoked'
      AND address_hmac IN (decode($2, 'hex'), decode($3, 'hex')) ORDER BY 1`, [w.tenantId, hmacHex(x), hmacHex(y)]);
    expect(kept.map((r) => r.k)).toEqual(['email:informational', 'email:marketing', 'sms:informational', 'sms:marketing', 'voice:informational', 'voice:marketing']);
  });

  it('D1 R-DATA-5: the sweep skips a due person whose do-not-contact is not carried and still purges the others; app.retention_optout_carry_due lists that person only without tenant and user context; carried by the system, the next sweep purges them', async () => {
    const r = await selfCreated(h.app, w, agent, 'Rae Sweep');
    const z = phone();
    await point(r, 'phone', z);
    const lone = phone();
    await point(r, 'phone', lone);
    await doNotContact(r, await revoke(agent.actor, 'phone', z, 'sms'));
    await softDeletedAndDue(r);
    const t = await selfCreated(h.app, w, agent, 'Tad Plain');
    await softDeletedAndDue(t);
    const first = await sweep();
    expect(first.contacts_purged).toBeGreaterThanOrEqual(1);
    expect([await exists(r), await exists(t)]).toEqual([true, false]);
    expect(await due()).toContain(r);
    // ids only, and only to the context-free worker: a tenant session (even the system's) gets nothing
    expect(await due(w.system('worker'))).toEqual([]);
    expect(await due(w.owner.actor)).toEqual([]);
    await carry(w.system('worker'), r);
    expect(await due()).not.toContain(r);
    await sweep();
    expect(await exists(r)).toBe(false);
  });

  it('R-DATA-5: a purge that refuses inside the sweep after the candidate scan (here a document retained past the scan instant) skips that person and is counted; the sweep completes', async () => {
    const u = await selfCreated(h.app, w, agent, 'Uma Held');
    const obj = uuid();
    // a retention period is set by an Owner or Admin (documents_guard)
    await as(w.owner.actor, async (tx) => {
      await sql`INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, key_version, dek_wrapped, created_by_user_id)
        VALUES (app.tenant_id(), ${obj}, 'document', ${`tenants/${w.tenantId}/doc/${obj}`}, 'application/pdf', 10, digest(${obj}, 'sha256'), 1, '\\x01', ${w.owner.id})`.execute(tx);
      await sql`INSERT INTO documents (tenant_id, id, contact_id, object_id, kind, display_name, uploaded_by_user_id, retention_until)
        VALUES (app.tenant_id(), ${uuid()}, ${u}, ${obj}, 'other', 'ID.pdf', ${w.owner.id}, now() + interval '1 day')`.execute(tx);
    });
    await softDeletedAndDue(u);
    // scanned "two days from now", the document no longer looks retained; the purge checks it against the real clock
    const r = await sweep(sql`now() + interval '2 days'`);
    expect(r.contacts_skipped).toBeGreaterThanOrEqual(1);
    expect(await exists(u)).toBe(true);
  });
});
