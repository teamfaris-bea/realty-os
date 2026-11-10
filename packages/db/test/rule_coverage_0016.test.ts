// R-PERM-11 (support grants, read-only support), R-AUDIT-6 (who reads audit_log and the ownership
// ledger), R-AUDIT-9 (7-year audit retention, only the sweep deletes) and the database half of E59
// (a contact on a closed deal: erasure refused until the Owner removes the deal link). Migration 0016.
// Every property is asserted as app_user under RLS; the superuser pool only seeds fixtures that have no
// application path (old audit rows, the support user's account row) and reads state back.
import type { ContactId, SupportActor, TenantId, UserId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { cmd, createHarness, createWorld, type Harness, type Member, PH, selfCreated, suFixture, suRows, uuid, type World } from './world.js';

let h: Harness;
let w: World;
let admin: Member;
let other: Member; // an agent on a second team the Team Lead does not lead
let supportUserId: UserId;

beforeAll(async () => {
  h = await createHarness();
  w = await createWorld(h.app, { agents: 3, teamLead: true });
  // Owner promotes one agent to Admin (the real path: an Owner role change)
  const a = w.agents[2]!;
  await withTenantTx(w.owner.actor, (tx) => sql`UPDATE memberships SET role = 'admin', accepting_leads = false WHERE user_id = ${a.id}`.execute(tx), { db: h.app });
  admin = { id: a.id, role: 'admin', actor: { ...a.actor, role: 'admin' } };
  // a second team: the Owner moves agent 1 out of the Team Lead's team
  other = w.agents[1]!;
  const teamB = uuid();
  await withTenantTx(w.owner.actor, async (tx) => {
    await sql`INSERT INTO teams (tenant_id, id, name) VALUES (${w.tenantId}, ${teamB}, 'Team B')`.execute(tx);
    await sql`DELETE FROM team_members WHERE team_id = ${w.teamId} AND user_id = ${other.id}`.execute(tx);
    await sql`INSERT INTO team_members (tenant_id, team_id, user_id, is_lead) VALUES (${w.tenantId}, ${teamB}, ${other.id}, false)`.execute(tx);
  }, { db: h.app });
  // the platform support person: a user account with no membership in this tenant (signup path)
  supportUserId = uuid() as UserId;
  await withPreTenant((tx) => sql`INSERT INTO users (id, email, display_name, password_hash) VALUES (${supportUserId}, ${`support-${uuid()}@platform.test`}, 'Platform Support', ${PH})`.execute(tx), { userId: supportUserId, db: h.app });
});
afterAll(async () => {
  await h?.close();
});

const asOwner = <T>(fn: Parameters<typeof withTenantTx<T>>[1]) => withTenantTx(w.owner.actor, fn, { db: h.app });
const grant = (hours: number, by: Member = w.owner, id = uuid()) =>
  withTenantTx(by.actor, (tx) => sql`INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, expires_at)
    VALUES (${w.tenantId}, ${id}, ${supportUserId}, ${by.id}, 'ticket 4821', now() + make_interval(hours => ${hours}))`.execute(tx), { db: h.app }).then(() => id);
const support = (grantId: string): SupportActor => ({ kind: 'support', userId: supportUserId, tenantId: w.tenantId as TenantId, grantId });
const asSupport = <T>(grantId: string, fn: Parameters<typeof withTenantTx<T>>[1]) => withTenantTx(support(grantId), fn, { db: h.app });
const count = async (actor: Parameters<typeof withTenantTx>[0], table: string) =>
  withTenantTx(actor, async (tx) => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(tx)).rows[0]!.n), { db: h.app });

describe('R-PERM-11 support grants (0016)', () => {
  it('R-PERM-11: an Owner issues a grant of at most 72 h; 73 h is refused', async () => {
    const id = await grant(72);
    const [g] = await suRows<{ hours: number; by: string }>(h.su, `SELECT round(extract(epoch FROM expires_at - created_at) / 3600)::int AS hours, granted_by_user_id AS by FROM support_access_grants WHERE id = $1`, [id]);
    expect(g).toEqual({ hours: 72, by: w.owner.id });
    await expect(grant(73)).rejects.toThrow(/support_access_grants_check|check constraint/);
  });

  it('R-PERM-11: the 72 h window runs from the database clock, never a caller-supplied created_at', async () => {
    // created a year "in the future" with expires 72 h after that would be a 1-year grant: refused
    await expect(
      asOwner((tx) => sql`INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, created_at, expires_at)
        VALUES (${w.tenantId}, ${uuid()}, ${supportUserId}, ${w.owner.id}, 'x', now() + interval '1 year', now() + interval '1 year 72 hours')`.execute(tx)),
    ).rejects.toThrow(/check constraint/);
  });

  it('R-PERM-11: only an Owner issues a grant, in their own name; Admin and Team Lead cannot', async () => {
    await expect(grant(1, admin)).rejects.toThrow(/SUPPORT_GRANT_FORBIDDEN|row-level security/);
    await expect(grant(1, w.tl!)).rejects.toThrow(/SUPPORT_GRANT_FORBIDDEN|row-level security/);
    // the Owner cannot attribute the grant to someone else
    await expect(
      asOwner((tx) => sql`INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, expires_at)
        VALUES (${w.tenantId}, ${uuid()}, ${supportUserId}, ${admin.id}, 'x', now() + interval '1 hour')`.execute(tx)),
    ).rejects.toThrow(/SUPPORT_GRANT_FORBIDDEN/);
  });

  it('R-PERM-11: a grant can be revoked but never extended, back-dated or un-revoked', async () => {
    const id = await grant(1);
    await expect(asOwner((tx) => sql`UPDATE support_access_grants SET expires_at = expires_at + interval '1 hour' WHERE id = ${id}`.execute(tx))).rejects.toThrow(/SUPPORT_GRANT_IMMUTABLE/);
    await expect(asOwner((tx) => sql`UPDATE support_access_grants SET created_at = created_at + interval '1 hour' WHERE id = ${id}`.execute(tx))).rejects.toThrow(/SUPPORT_GRANT_IMMUTABLE/);
    await asOwner((tx) => sql`UPDATE support_access_grants SET revoked_at = now() WHERE id = ${id}`.execute(tx));
    await expect(asOwner((tx) => sql`UPDATE support_access_grants SET revoked_at = NULL WHERE id = ${id}`.execute(tx))).rejects.toThrow(/SUPPORT_GRANT_IMMUTABLE/);
    // a revoked grant gives no access
    expect(await count(support(id), 'contacts')).toBe(0);
  });

  it('R-PERM-11: support with a live grant reads tenant-wide; without one (none, expired, revoked) it reads nothing', async () => {
    await selfCreated(h.app, w, w.agents[0]!, 'Read Me');
    const live = await grant(2);
    expect(await count(support(live), 'contacts')).toBeGreaterThan(0);
    expect(await count(support(uuid()), 'contacts')).toBeGreaterThan(0); // the live grant is what counts, not the id named
    await asOwner((tx) => sql`UPDATE support_access_grants SET revoked_at = now() WHERE support_user_id = ${supportUserId} AND revoked_at IS NULL`.execute(tx));
    expect(await count(support(live), 'contacts')).toBe(0);
    // an expired grant (fixture: no application path makes time pass)
    const expired = await grant(1);
    await suFixture(h.su, `ALTER TABLE support_access_grants DISABLE TRIGGER support_access_grants_guard`);
    await suFixture(h.su, `UPDATE support_access_grants SET created_at = now() - interval '3 hours', expires_at = now() - interval '1 hour' WHERE id = $1`, [expired]);
    await suFixture(h.su, `ALTER TABLE support_access_grants ENABLE TRIGGER support_access_grants_guard`);
    expect(await count(support(expired), 'contacts')).toBe(0);
  });

  it('R-PERM-11: any write by a support actor is refused, through RLS and through SECURITY DEFINER functions', async () => {
    const id = await grant(2);
    const contact = await selfCreated(h.app, w, w.agents[0]!, 'Do Not Touch');
    await expect(asSupport(id, (tx) => sql`UPDATE contacts SET pond_summary = 'support was here' WHERE id = ${contact}`.execute(tx))).rejects.toThrow(/SUPPORT_READ_ONLY/);
    await expect(asSupport(id, (tx) => sql`INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body, source) VALUES (${w.tenantId}, ${uuid()}, ${contact}, ${w.owner.id}, 'x', 'manual')`.execute(tx))).rejects.toThrow(/SUPPORT_READ_ONLY|row-level security/);
    await expect(asSupport(id, (tx) => sql`DELETE FROM team_members WHERE user_id = ${w.agents[0]!.id}`.execute(tx))).rejects.toThrow(/SUPPORT_READ_ONLY/);
    await expect(asSupport(id, (tx) => sql`INSERT INTO jobs (tenant_id, queue, kind, run_at) VALUES (${w.tenantId}, 'default', 'x.y', now())`.execute(tx))).rejects.toThrow(/SUPPORT_READ_ONLY/);
    await expect(asSupport(id, (tx) => sql`INSERT INTO audit_log (tenant_id, id, occurred_at, actor_kind, actor_user_id, support_grant_id, action, entity_type) VALUES (${w.tenantId}, ${uuid()}, now(), 'support', ${supportUserId}, ${id}, 'settings.changed', 'x')`.execute(tx))).rejects.toThrow(/SUPPORT_READ_ONLY/);
    // a definer function (BYPASSRLS owner) that would otherwise accept a tenant-wide support caller
    await expect(asSupport(id, (tx) => sql`SELECT app.revoke_member_sessions(${w.agents[0]!.id}::uuid, now())`.execute(tx))).rejects.toThrow(/SUPPORT_READ_ONLY/);
    await expect(asSupport(id, (tx) => sql`SELECT app.erase_contact(${contact}::uuid, ${uuid()}::uuid, 'x')`.execute(tx))).rejects.toThrow(/ERASE_FORBIDDEN|SUPPORT_READ_ONLY/);
    expect(await suRows(h.su, `SELECT pond_summary FROM contacts WHERE id = $1`, [contact])).toEqual([{ pond_summary: null }]);
  });

  it('R-PERM-11: every public table carries the statement-level support write block', async () => {
    const missing = await suRows<{ relname: string }>(h.su, `
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
         AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'support_read_only' AND t.tgenabled = 'O')
       ORDER BY 1`);
    expect(missing).toEqual([]);
  });
});

describe('R-AUDIT-6 audit_log and the ownership ledger (0016)', () => {
  it('R-AUDIT-6: only Owner/Admin read audit_log; Team Lead, Agent and support read nothing', async () => {
    await asOwner((tx) => sql`INSERT INTO audit_log (tenant_id, id, occurred_at, actor_kind, actor_via, actor_user_id, actor_role, action, entity_type)
      VALUES (${w.tenantId}, ${uuid()}, now(), 'user', 'api', ${w.owner.id}, 'owner', 'settings.changed', 'tenant_settings')`.execute(tx));
    expect(await count(w.owner.actor, 'audit_log')).toBeGreaterThan(0);
    expect(await count(admin.actor, 'audit_log')).toBeGreaterThan(0);
    expect(await count(w.tl!.actor, 'audit_log')).toBe(0);
    expect(await count(w.agents[0]!.actor, 'audit_log')).toBe(0);
    expect(await count(support(await grant(1)), 'audit_log')).toBe(0);
  });

  it("R-AUDIT-6: a Team Lead reads their team's ownership ledger and not another team's", async () => {
    const mine = await selfCreated(h.app, w, w.agents[0]!, 'Team A Lead'); // agent 0 is on the TL's team
    const theirs = await selfCreated(h.app, w, other, 'Team B Lead');
    const visible = async (actor: Parameters<typeof withTenantTx>[0], contact: ContactId) =>
      withTenantTx(actor, async (tx) => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM lead_ownership_events WHERE contact_id = ${contact}`.execute(tx)).rows[0]!.n), { db: h.app });
    expect(await visible(w.tl!.actor, mine)).toBeGreaterThan(0);
    expect(await visible(w.tl!.actor, theirs)).toBe(0);
    // Owner and Admin read every team's ledger; the other team's agent reads their own
    expect(await visible(w.owner.actor, theirs)).toBeGreaterThan(0);
    expect(await visible(admin.actor, theirs)).toBeGreaterThan(0);
    expect(await visible(other.actor, theirs)).toBeGreaterThan(0);
    expect(await visible(other.actor, mine)).toBe(0);
    // when the Team B lead moves to a Team A agent, the Team Lead reads its history from that event on
    expect((await cmd(h.app, w.owner.actor, theirs, { kind: 'reassign', toUserId: w.agents[0]!.id, reason: 'MANUAL' })).outcome.ok).toBe(true);
    expect(await visible(w.tl!.actor, theirs)).toBeGreaterThan(0);
  });
});

describe('R-AUDIT-9 audit retention (0016)', () => {
  const oldRow = async (age: string) => {
    const id = uuid();
    await suFixture(h.su, `INSERT INTO audit_log (tenant_id, id, occurred_at, actor_kind, actor_via, action, entity_type) VALUES ($1, $2, now() - $3::interval, 'system', 'worker', 'settings.changed', 'tenant')`, [w.tenantId, id, age]);
    return id;
  };
  const exists = async (id: string) => (await suRows(h.su, `SELECT 1 FROM audit_log WHERE id = $1`, [id])).length === 1;

  it('R-AUDIT-9: a 6-year-old audit row cannot be deleted outside the sweep, by app_user or by any other role', async () => {
    const six = await oldRow('6 years');
    await expect(asOwner((tx) => sql`DELETE FROM audit_log WHERE id = ${six}`.execute(tx))).rejects.toThrow(/permission denied/);
    await expect(h.su.query(`DELETE FROM audit_log WHERE id = $1`, [six])).rejects.toThrow(/APPEND_ONLY/);
    await expect(h.su.query(`TRUNCATE audit_log`)).rejects.toThrow(/APPEND_ONLY/);
    expect(await exists(six)).toBe(true);
  });

  it('R-AUDIT-9: the sweep deletes rows older than 7 years and keeps younger ones, even when called with a far-future time', async () => {
    const six = await oldRow('6 years');
    const eight = await oldRow('7 years 1 day');
    const fresh = await oldRow('1 minute');
    const r = await withPreTenant(async (tx) => (await sql<{ r: Record<string, number> }>`SELECT app.retention_sweep(now() + interval '20 years') AS r`.execute(tx)).rows[0]!.r, { db: h.app });
    expect(r.audit_log).toBeGreaterThanOrEqual(1);
    expect([await exists(eight), await exists(six), await exists(fresh)]).toEqual([false, true, true]);
    await withPreTenant((tx) => sql`SELECT app.retention_sweep(now())`.execute(tx), { db: h.app });
    expect(await exists(six)).toBe(true);
    expect(await suRows(h.su, `SELECT app.audit_retention()::text AS p`)).toEqual([{ p: '7 years' }]);
  });

  it('R-AUDIT-9: an application role cannot insert a back-dated audit row (which the sweep would delete early)', async () => {
    await expect(
      asOwner((tx) => sql`INSERT INTO audit_log (tenant_id, id, occurred_at, actor_kind, actor_via, actor_user_id, actor_role, action, entity_type)
        VALUES (${w.tenantId}, ${uuid()}, now() - interval '8 years', 'user', 'api', ${w.owner.id}, 'owner', 'settings.changed', 'x')`.execute(tx)),
    ).rejects.toThrow(/AUDIT_OCCURRED_AT_INVALID/);
  });

  it('R-AUDIT-9: app.retention_sweep is the only function that deletes audit rows', async () => {
    const fns = await suRows<{ fn: string }>(h.su, `
      SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('app','auth','public') AND p.prosrc ~* 'delete\\s+from\\s+(public\\.)?audit_log' ORDER BY 1`);
    expect(fns).toEqual([{ fn: 'app.retention_sweep(timestamp with time zone)' }]);
    const owners = await suRows<{ o: string }>(h.su, `SELECT pg_get_userbyid(proowner) AS o FROM pg_proc WHERE oid = 'app.retention_sweep(timestamptz)'::regprocedure`);
    expect(owners).toEqual([{ o: 'app_retention' }]);
  });
});

describe('E59 erasure of a contact on a closed deal (0016, R-DATA-4)', () => {
  const closedDeal = async (contact: ContactId, stage = 'closed') => {
    const id = uuid();
    await asOwner(async (tx) => {
      await sql`INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id)
                VALUES (${w.tenantId}, ${id}, 'Purchase', 'buy', 'active', now(), ${contact}, ${w.agents[0]!.id})`.execute(tx);
      await sql`INSERT INTO deal_contacts (tenant_id, deal_id, contact_id, role) VALUES (${w.tenantId}, ${id}, ${contact}, 'buyer')`.execute(tx);
      await sql`UPDATE deals SET stage = ${stage}, closed_at = CASE WHEN ${stage} = 'closed' THEN now() END WHERE id = ${id}`.execute(tx);
    });
    return id;
  };
  const erase = (actor: Parameters<typeof withTenantTx>[0], contact: ContactId) =>
    withTenantTx(actor, (tx) => sql`SELECT app.erase_contact(${contact}::uuid, ${uuid()}::uuid, 'privacy request')`.execute(tx), { db: h.app });
  const unlinkPrimary = (actor: Parameters<typeof withTenantTx>[0], deal: string) =>
    withTenantTx(actor, (tx) => sql`UPDATE deals SET primary_contact_id = NULL WHERE id = ${deal}`.execute(tx), { db: h.app });

  it('E59 R-DATA-4: erasing a contact on a closed deal is refused with CONTACT_ON_DEAL and nothing is deleted', async () => {
    const c = await selfCreated(h.app, w, w.agents[0]!, 'Closed Buyer');
    await closedDeal(c);
    await expect(erase(w.owner.actor, c)).rejects.toThrow(/CONTACT_ON_DEAL/);
    await expect(erase(admin.actor, c)).rejects.toThrow(/CONTACT_ON_DEAL/);
    expect(await suRows(h.su, `SELECT 1 FROM contacts WHERE id = $1`, [c])).toHaveLength(1);
  });

  it('E59 R-DATA-4: the Owner removes the deal link (the deal record stays), then erasure succeeds and is audited', async () => {
    const c = await selfCreated(h.app, w, w.agents[0]!, 'Erase After Unlink');
    const deal = await closedDeal(c);
    // Agent (deal owner), Admin and Team Lead cannot remove the person from the transaction record
    await expect(unlinkPrimary(w.agents[0]!.actor, deal)).rejects.toThrow(/DEAL_PRIMARY_CONTACT_REQUIRED/);
    await expect(unlinkPrimary(admin.actor, deal)).rejects.toThrow(/DEAL_PRIMARY_CONTACT_REQUIRED/);
    await asOwner(async (tx) => {
      await sql`UPDATE deals SET primary_contact_id = NULL WHERE id = ${deal}`.execute(tx);
      await sql`DELETE FROM deal_contacts WHERE deal_id = ${deal} AND contact_id = ${c}`.execute(tx);
    });
    await erase(w.owner.actor, c);
    expect(await suRows(h.su, `SELECT 1 FROM contacts WHERE id = $1`, [c])).toHaveLength(0);
    expect(await suRows(h.su, `SELECT stage, primary_contact_id FROM deals WHERE id = $1`, [deal])).toEqual([{ stage: 'closed', primary_contact_id: null }]);
    expect(await suRows(h.su, `SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'contact.erase'`, [c])).toEqual([{ action: 'contact.erase' }]);
  });

  it('E59: a deal that is still open keeps its person; a new deal always names one', async () => {
    const c = await selfCreated(h.app, w, w.agents[0]!, 'Open Deal Person');
    const deal = await closedDeal(c, 'under_contract');
    await expect(unlinkPrimary(w.owner.actor, deal)).rejects.toThrow(/DEAL_PRIMARY_CONTACT_REQUIRED/);
    await expect(
      asOwner((tx) => sql`INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id)
        VALUES (${w.tenantId}, ${uuid()}, 'No one', 'buy', 'closed', now(), NULL, ${w.owner.id})`.execute(tx)),
    ).rejects.toThrow(/DEAL_PRIMARY_CONTACT_REQUIRED|row-level security/);
  });
});
