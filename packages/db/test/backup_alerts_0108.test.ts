// R-TEAMQ-17 (b19 team-queue lane, step 2; migration 0108): lead_backup_alerts, the record of each minute-three
// decision (one row per inquiry: who was alerted, when and why, or why nobody was), and the `backup` collaborator
// role. What the database itself holds, whatever the API does:
//   - one row per inquiry, written by the system only; nobody updates or deletes one;
//   - Owner, Admin and the system of the team read every row; the alerted person reads their own; anyone else reads
//     a row only when they can read its inquiry; every actor of another team reads and writes nothing (R-TEN-1);
//   - support reads with a live grant and never writes (R-PERM-11);
//   - a `backup` collaborator grant is an ordinary collaborator row: it gives sight of that one lead only, and none
//     once it has expired.
// Names here are made up.
import type { ContactId, SupportActor, TenantId, UserId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { BUY, PH, createHarness, createWorld, intakeLead, suRows, uuid, type Harness, type Member, type World } from './world.js';

let h: Harness;
let w: World;
let other: World;
let lead: ContactId;
let inquiryId: string;

type Actor = Parameters<typeof withTenantTx>[0];
const as = <T>(actor: Actor, fn: Parameters<typeof withTenantTx<T>>[1]) => withTenantTx(actor, fn, { db: h.app });
const inquiryOf = async (contactId: string) => (await suRows<{ id: string }>(h.su, 'SELECT id FROM lead_inquiries WHERE contact_id = $1', [contactId]))[0]!.id;
/** One row; by default the job's own shape for an alerted backup (0109: one member alerted, no fallback reason). */
const alertRow = (actor: Actor, world: World, inquiry: string, o: { outcome?: string; alerted?: string | null; recipient?: string | null; reason?: string | null; count?: number } = {}) =>
  as(actor, async (tx) => {
    const id = uuid();
    const outcome = o.outcome ?? 'alerted';
    const alerted = o.alerted === undefined ? world.agents[1]!.id : o.alerted;
    const recipient = o.recipient === undefined ? 'backup' : o.recipient;
    const reason = o.reason === undefined ? (recipient === 'team_lead' || recipient === 'admins' ? 'backup_unavailable' : null) : o.reason;
    await sql`
      INSERT INTO lead_backup_alerts (tenant_id, id, inquiry_id, lead_source_id, arrived_at, due_at, decided_at, outcome, alerted_user_id, recipient, fallback_reason, alerted_count, holder)
      VALUES (${world.tenantId}, ${id}, ${inquiry}, ${world.leadSourceId}, now() - interval '4 minutes', now() - interval '1 minute', now(), ${outcome},
              ${alerted}, ${recipient}, ${reason}, ${o.count ?? (outcome === 'alerted' ? 1 : 0)}, 'on_offer')`.execute(tx);
    return id;
  });
const visibleTo = (actor: Actor, tenantId: string = w.tenantId) =>
  as(actor, async (tx) => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM lead_backup_alerts WHERE tenant_id = ${tenantId}`.execute(tx)).rows[0]!.n));

beforeAll(async () => {
  h = await createHarness();
  w = await createWorld(h.app, { agents: 3, teamLead: true, rule: 'round_robin' });
  other = await createWorld(h.app, { agents: 1 });
  lead = (await intakeLead(h.app, w, BUY)).contactId; // on offer to a member of the rule
  inquiryId = await inquiryOf(lead);
});
afterAll(async () => {
  await h?.close();
});

describe('R-TEAMQ-17 (0108): the record of a backup alert', () => {
  it('R-TEAMQ-17 E953: the system writes one row per inquiry; a second row for the same inquiry is refused; nobody else writes one', async () => {
    await alertRow(w.system('timer'), w, inquiryId);
    await expect(alertRow(w.system('timer'), w, inquiryId)).rejects.toThrow(/lead_backup_alerts_inquiry_once/);
    const second = await inquiryOf((await intakeLead(h.app, w, BUY)).contactId);
    for (const m of [w.owner, w.tl!, w.agents[0]!]) await expect(alertRow(m.actor, w, second)).rejects.toThrow(/row-level security/);
    expect((await suRows(h.su, 'SELECT 1 FROM lead_backup_alerts WHERE tenant_id = $1', [w.tenantId])).length).toBe(1);
  });

  it('R-TEAMQ-17: the row says who was alerted exactly when its outcome is "alerted", with how they were chosen', async () => {
    const q = await inquiryOf((await intakeLead(h.app, w, BUY)).contactId);
    await expect(alertRow(w.system('timer'), w, q, { outcome: 'alerted', alerted: null, recipient: null })).rejects.toThrow(/check constraint/);
    await expect(alertRow(w.system('timer'), w, q, { outcome: 'human_attempt' })).rejects.toThrow(/check constraint/);
    await expect(alertRow(w.system('timer'), w, q, { outcome: 'made_up', alerted: null, recipient: null })).rejects.toThrow(/check constraint/);
    // R-TEAMQ-21 (0109): how many were alerted goes with the outcome; several only for the Owners and Admins; a reason exactly when it was not the backup
    await expect(alertRow(w.system('timer'), w, q, { count: 0 })).rejects.toThrow(/lead_backup_alerts_count_matches/);
    await expect(alertRow(w.system('timer'), w, q, { outcome: 'human_attempt', alerted: null, recipient: null, count: 1 })).rejects.toThrow(/lead_backup_alerts_count_matches/);
    await expect(alertRow(w.system('timer'), w, q, { count: 2 })).rejects.toThrow(/lead_backup_alerts_one_unless_admins/);
    await expect(alertRow(w.system('timer'), w, q, { recipient: 'team_lead', reason: null })).rejects.toThrow(/lead_backup_alerts_reason_matches/);
    await expect(alertRow(w.system('timer'), w, q, { reason: 'backup_is_holder' })).rejects.toThrow(/lead_backup_alerts_reason_matches/);
    await expect(alertRow(w.system('timer'), w, q, { recipient: 'team_lead', reason: 'made_up' })).rejects.toThrow(/check constraint/);
    await expect(alertRow(w.system('timer'), w, q, { recipient: 'someone' })).rejects.toThrow(/check constraint/);
    const forAdmins = await inquiryOf((await intakeLead(h.app, w, BUY)).contactId);
    await alertRow(w.system('timer'), w, forAdmins, { alerted: w.owner.id, recipient: 'admins', reason: 'backup_is_holder', count: 2 });
    await alertRow(w.system('timer'), w, q, { outcome: 'human_attempt', alerted: null, recipient: null });
  });

  it('R-TEAMQ-17: nobody updates or deletes a row: not the Owner, not the system', async () => {
    for (const actor of [w.owner.actor, w.system('timer')]) {
      await expect(as(actor, (tx) => sql`UPDATE lead_backup_alerts SET outcome = 'human_attempt', alerted_user_id = NULL, recipient = NULL WHERE inquiry_id = ${inquiryId}`.execute(tx))).rejects.toThrow(/permission denied/);
      await expect(as(actor, (tx) => sql`DELETE FROM lead_backup_alerts WHERE inquiry_id = ${inquiryId}`.execute(tx))).rejects.toThrow(/permission denied/);
    }
  });

  it('R-TEAMQ-17 R-PERM-5: who reads a row: Owner and the system every row; the alerted person their own; another agent none; the Team Lead only the rows of inquiries they can read', async () => {
    const all = (await suRows(h.su, 'SELECT 1 FROM lead_backup_alerts WHERE tenant_id = $1', [w.tenantId])).length;
    expect(await visibleTo(w.owner.actor)).toBe(all);
    expect(await visibleTo(w.system('worker'))).toBe(all);
    expect(await visibleTo(w.agents[1]!.actor)).toBeGreaterThanOrEqual(1); // the alerted person (the fixture's alerted member)
    const offeree = (await suRows<{ u: string }>(h.su, 'SELECT offered_to_user_id AS u FROM contacts WHERE id = $1', [lead]))[0]!.u;
    const bystander = [w.agents[0]!, w.agents[2]!].find((m) => m.id !== offeree && m.id !== w.agents[1]!.id);
    if (bystander) {
      const rows = await as(bystander.actor, async (tx) => (await sql<{ inquiry_id: string }>`SELECT inquiry_id FROM lead_backup_alerts`.execute(tx)).rows.map((r) => r.inquiry_id));
      expect(rows).not.toContain(inquiryId);
    }
    // the Team Lead leads the offeree's team: they read the lead's inquiry, so its alert row
    const tlRows = await as(w.tl!.actor, async (tx) => (await sql<{ inquiry_id: string }>`SELECT inquiry_id FROM lead_backup_alerts`.execute(tx)).rows.map((r) => r.inquiry_id));
    expect(tlRows).toContain(inquiryId);
  });

  it('R-TEAMQ-17 R-TEN-1: tenant isolation: another team reads none of these rows and cannot write one for this team\'s inquiry, nor one of its own naming this team\'s member', async () => {
    for (const actor of [other.owner.actor, other.agents[0]!.actor, other.system('timer')]) expect(await visibleTo(actor)).toBe(0);
    const q = await inquiryOf((await intakeLead(h.app, w, BUY)).contactId);
    await expect(alertRow(other.system('timer'), w, q)).rejects.toThrow(/row-level security/);
    const theirs = await inquiryOf((await intakeLead(h.app, other)).contactId);
    await expect(alertRow(other.system('timer'), other, theirs, { alerted: w.agents[0]!.id })).rejects.toThrow(/foreign key/);
    await expect(alertRow(other.system('timer'), other, q, { alerted: other.agents[0]!.id })).rejects.toThrow(/foreign key/);
    expect(await visibleTo(other.owner.actor, other.tenantId)).toBe(0);
  });

  it('R-TEAMQ-17 R-PERM-11: support reads with a live grant and never writes', async () => {
    const supportUserId = uuid() as UserId;
    await withPreTenant((tx) => sql`INSERT INTO users (id, email, display_name, password_hash) VALUES (${supportUserId}, ${`support-${uuid()}@platform.test`}, 'Platform Support', ${PH})`.execute(tx), { userId: supportUserId, db: h.app });
    const grantId = uuid();
    const support: SupportActor = { kind: 'support', userId: supportUserId, tenantId: w.tenantId as TenantId, grantId };
    expect(await visibleTo(support)).toBe(0);
    await as(w.owner.actor, (tx) => sql`INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, expires_at)
      VALUES (${w.tenantId}, ${grantId}, ${supportUserId}, ${w.owner.id}, 'backup alert check', now() + interval '1 hour')`.execute(tx));
    expect(await visibleTo(support)).toBeGreaterThan(0);
    const q = await inquiryOf((await intakeLead(h.app, w, BUY)).contactId);
    await expect(alertRow(support, w, q)).rejects.toThrow(/SUPPORT_READ_ONLY/);
  });
});

describe('R-TEAMQ-16 (0108): the `backup` collaborator role', () => {
  const sees = (m: Member, contactId: string) => as(m.actor, async (tx) => (await sql`SELECT 1 FROM contacts WHERE id = ${contactId}`.execute(tx)).rows.length === 1);
  const detail = (m: Member, contactId: string) => as(m.actor, async (tx) => (await sql<{ v: boolean }>`SELECT COALESCE(app.contact_detail_visible(app.tenant_id(), ${contactId}::uuid), false) AS v`.execute(tx)).rows[0]!.v);

  it('R-TEAMQ-16 E951 E952: a time-boxed backup grant on a lead still ON OFFER gives that one member sight of that one lead and its detail; it gives nobody else anything, and nothing once it has expired', async () => {
    const offeree = (await suRows<{ u: string }>(h.su, 'SELECT offered_to_user_id AS u FROM contacts WHERE id = $1', [lead]))[0]!.u;
    const backup = w.agents.find((m) => m.id !== offeree)!;
    const bystander = w.agents.find((m) => m.id !== offeree && m.id !== backup.id)!;
    const otherLead = (await intakeLead(h.app, w, BUY)).contactId;
    expect(await sees(backup, lead)).toBe(false);
    await as(w.system('timer'), (tx) => sql`
      INSERT INTO contact_collaborators (tenant_id, contact_id, user_id, role, expires_at) VALUES (${w.tenantId}, ${lead}, ${backup.id}, 'backup', now() + interval '24 hours')`.execute(tx));
    expect(await sees(backup, lead)).toBe(true);
    expect(await detail(backup, lead)).toBe(true);
    expect(await sees(bystander, lead)).toBe(false);
    const offereeOfOther = (await suRows<{ u: string }>(h.su, 'SELECT offered_to_user_id AS u FROM contacts WHERE id = $1', [otherLead]))[0]!.u;
    if (offereeOfOther !== backup.id) expect(await sees(backup, otherLead)).toBe(false);
    // expired: nothing
    await h.su.query(`UPDATE contact_collaborators SET expires_at = now() - interval '1 second' WHERE contact_id = $1 AND user_id = $2`, [lead, backup.id]);
    expect(await sees(backup, lead)).toBe(false);
    expect(await detail(backup, lead)).toBe(false);
  });

  it('R-TEAMQ-16: the role is one of the known collaborator roles; an unknown one is still refused', async () => {
    const c = (await intakeLead(h.app, w)).contactId;
    await expect(as(w.system('timer'), (tx) => sql`INSERT INTO contact_collaborators (tenant_id, contact_id, user_id, role) VALUES (${w.tenantId}, ${c}, ${w.agents[0]!.id}, 'watcher')`.execute(tx))).rejects.toThrow(/check constraint/);
  });
});
