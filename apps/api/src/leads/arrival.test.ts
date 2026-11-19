// ONE arrival instant everywhere, over real Postgres (b19 team-queue lane, review fix M3; DATA_MODEL R-TEAMQ-19,
// E871 to E873). The reviewer's two reproductions, exactly:
//   (a) the source's clock runs 4 minutes AHEAD: the owner texted one second after the lead reached the team; the
//       queue said nobody had tried, the report showed no attempt, and the backup was alerted and given access;
//   (b) a BACK-DATED second inquiry: an earlier text was credited to the new inquiry as "within 5 minutes" and no
//       alert fired although nobody had responded since it reached the team.
// Leads arrive through the real intake (with the time the source claims), the text goes through the real send path,
// the job is the real `leads.backup_alert` handler. The superuser pool only reads state back and moves clocks
// (everything of a person N minutes into the past, together). Invented people and sources only.
import type { Instant } from '@realty/core/foundation';
import { instantFromDate } from '@realty/core/foundation';
import { arrivalInstant } from '@realty/core/priority';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARRIVAL } from '../accountability/repos/teamQueue.js';
import { assistantWorld, grantConsent } from '../assistant/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, sendText } from '../comms/testing.js';
import { BACKUP_ALERT_JOB } from './backupAlert.js';
import { call, command, contactState, freshReauth, leadsWorker, postIntake, randomPhone, suFixture } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let backup: TestClient;

interface Src {
  id: string;
  token: string;
}
/** A made-up covered lead source: agents[0] is its named owner, `backup` its backup. */
async function coveredSource(name: string): Promise<Src> {
  await freshReauth(h, w.owner);
  const s = await call<{ source: { id: string }; ingestToken: string }>(w.owner, 'POST', '/lead-sources', { name, kind: 'website' });
  if (s.status !== 201) throw new Error(`lead source: ${s.status} ${JSON.stringify(s.body)}`);
  const c = await call(w.owner, 'PUT', `/lead-sources/${s.body.source.id}/coverage`, { ownerUserId: w.agents[0]!.userId, backupUserId: backup.userId, highIntent: false, covered: true });
  if (c.status !== 200) throw new Error(`coverage: ${c.status} ${JSON.stringify(c.body)}`);
  return { id: s.body.source.id, token: s.body.ingestToken };
}
async function arrive(src: Src, body: Record<string, unknown>): Promise<{ contactId: string; inquiryId: string; outcome: string }> {
  const r = await postIntake(h, src.token, { inquiryType: 'buy', fullName: 'Dana Rivera', ...body });
  if (r.statusCode !== 201 && r.statusCode !== 200) throw new Error(`intake: ${r.statusCode} ${r.body}`);
  return r.json() as { contactId: string; inquiryId: string; outcome: string };
}
async function accept(contactId: string): Promise<TestClient> {
  const st = await contactState(h, contactId);
  const owner = w.agents.find((a) => a.userId === st.offered_to_user_id);
  if (!owner || !st.offer_id) throw new Error(`lead not offered: ${st.ownership_state}`);
  const acc = await command(owner, contactId, 'accept', { offerId: st.offer_id });
  if (acc.status !== 200) throw new Error(`accept: ${acc.status} ${JSON.stringify(acc.body)}`);
  return owner;
}
async function humanText(by: TestClient, contactId: string): Promise<Date> {
  await grantConsent(by, contactId, 'sms');
  const r = await sendText(by, contactId, 'Hi, thanks for reaching out. When is a good time to talk?');
  if (r.body.result !== 'sent') throw new Error(`text not sent: ${JSON.stringify(r.body)}`);
  return (await h.su.query<{ dispatched_at: Date }>(`SELECT dispatched_at FROM messages WHERE contact_id = $1 AND direction = 'outbound' AND initiator = 'human' ORDER BY dispatched_at DESC LIMIT 1`, [contactId])).rows[0]!.dispatched_at;
}
const inquiry = async (id: string) => (await h.su.query<{ received_at: Date; created_at: Date }>('SELECT received_at, created_at FROM lead_inquiries WHERE id = $1', [id])).rows[0]!;
/** clock fixture: everything of the person so far (their inquiries, their messages, their ownership ledger) happened `minutes` earlier, in the same order */
async function everythingEarlier(contactId: string, minutes: number): Promise<void> {
  await suFixture(h, [
    { text: `UPDATE lead_inquiries SET received_at = received_at - ($2::int * interval '1 minute'), created_at = created_at - ($2::int * interval '1 minute') WHERE contact_id = $1`, values: [contactId, minutes] },
    { text: `UPDATE messages SET occurred_at = occurred_at - ($2::int * interval '1 minute'), dispatched_at = dispatched_at - ($2::int * interval '1 minute') WHERE contact_id = $1`, values: [contactId, minutes] },
    { text: `UPDATE lead_ownership_events SET occurred_at = occurred_at - ($2::int * interval '1 minute') WHERE contact_id = $1`, values: [contactId, minutes] },
  ]);
}
const jobDue = (inquiryId: string) => h.su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND kind = $2 AND status = 'pending' AND payload->>'inquiryId' = $3`, [w.tenantId, BACKUP_ALERT_JOB.kind, inquiryId]);
const alertRows = async (inquiryId: string) => (await h.su.query<{ outcome: string; alerted_user_id: string | null; arrived_at: Date; due_at: Date }>('SELECT outcome, alerted_user_id, arrived_at, due_at FROM lead_backup_alerts WHERE inquiry_id = $1', [inquiryId])).rows;
const alertNotes = async (inquiryId: string) => (await h.su.query<{ user_id: string }>(`SELECT user_id FROM notifications WHERE dedupe_key = $1`, [`backup_alert:${inquiryId}`])).rows;
const grants = async (contactId: string) => (await h.su.query<{ user_id: string; role: string }>('SELECT user_id, role FROM contact_collaborators WHERE contact_id = $1', [contactId])).rows;

interface QueueRow {
  contact: { id: string };
  why: string;
  since: string;
  waitingSeconds: number;
}
const newLeadRow = async (contactId: string): Promise<QueueRow | undefined> => {
  const r = await call<{ groups: { key: string; rows: QueueRow[] }[] }>(w.owner, 'GET', '/team/queue');
  if (r.status !== 200) throw new Error(`queue: ${r.status}`);
  return r.body.groups.find((g) => g.key === 'new_lead')!.rows.find((x) => x.contact.id === contactId);
};
interface ReportInquiry {
  inquiryId: string;
  arrivedAt: string;
  attempt: { at: string; by: { userId: string } | null; role: string; wallSeconds: number; staffedSeconds: number } | null;
  waiting: { wallSeconds: number } | null;
  within5: boolean;
}
const reported = async (inquiryId: string): Promise<ReportInquiry> => {
  const r = await call<{ inquiries: ReportInquiry[] }>(w.owner, 'GET', '/team/lead-response?range=7d');
  if (r.status !== 200) throw new Error(`lead response: ${r.status}`);
  return r.body.inquiries.find((i) => i.inquiryId === inquiryId)!;
};

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = (await assistantWorld(h, { agents: 2, teamLead: true })) as CommsWorld;
  backup = await h.invite(w.owner, 'agent');
  const s = await call<{ settings: { version: number } }>(w.owner, 'GET', '/settings');
  const cap = await call(w.owner, 'PATCH', '/settings', { version: s.body.settings.version, uncontactedCapacityCap: 50 });
  if (cap.status !== 200) throw new Error(`settings: ${cap.status} ${JSON.stringify(cap.body)}`);
  // staffed all day, so three staffed minutes are three minutes
  await suFixture(h, [{ text: `UPDATE tenant_settings SET routing_hours_start = '00:00', routing_hours_end = '24:00' WHERE tenant_id = $1`, values: [w.tenantId] }]);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('R-TEAMQ-19 one arrival instant: the job, the queue and the report agree on when a lead arrived', () => {
  it('R-TEAMQ-19 E871 (a): the source\'s clock runs 4 minutes ahead and the owner texts seconds after the lead reached the team: the queue does not list it, the report credits the owner within 5 minutes, and the backup is neither alerted nor given access', async () => {
    const src = await coveredSource('Fast clock form (arrival test)');
    const lead = await arrive(src, { phones: [randomPhone()], receivedAt: new Date(Date.now() + 4 * 60_000).toISOString() });
    const stored = await inquiry(lead.inquiryId);
    // the source's claim is kept as it was made: about four minutes after the moment the lead reached the team
    expect(stored.received_at.getTime() - stored.created_at.getTime()).toBeGreaterThan(3.5 * 60_000);
    const owner = await accept(lead.contactId);
    const textedAt = await humanText(owner, lead.contactId);
    // the reproduction's premise: the text is AFTER the lead reached the team and BEFORE the time the source claimed
    expect(textedAt.getTime()).toBeGreaterThan(stored.created_at.getTime());
    expect(textedAt.getTime()).toBeLessThan(stored.received_at.getTime());

    // ten minutes later (everything of the person moved together), with the job due
    await everythingEarlier(lead.contactId, 10);
    await jobDue(lead.inquiryId);
    await leadsWorker(h).drain();

    expect(await newLeadRow(lead.contactId)).toBeUndefined();
    const rep = await reported(lead.inquiryId);
    expect(rep.attempt).toMatchObject({ by: { userId: owner.userId }, role: 'owner' });
    expect(rep.attempt!.wallSeconds).toBeLessThan(60);
    expect(rep).toMatchObject({ within5: true, waiting: null });
    const after = await inquiry(lead.inquiryId);
    expect(new Date(rep.arrivedAt).getTime()).toBe(after.created_at.getTime());
    const rows = await alertRows(lead.inquiryId);
    expect(rows.map((r) => [r.outcome, r.alerted_user_id])).toEqual([['human_attempt', null]]);
    // the row's own arrival and due time are the same instant's: three minutes after the lead reached the team
    expect(rows[0]!.arrived_at.getTime()).toBe(after.created_at.getTime());
    expect(rows[0]!.due_at.getTime() - after.created_at.getTime()).toBe(180_000);
    expect(await alertNotes(lead.inquiryId)).toEqual([]);
    expect(await grants(lead.contactId)).toEqual([]);
  });

  it('R-TEAMQ-19 E872 (b): a back-dated second inquiry: the text sent before it reached the team is not a response to it: the queue lists it, the report shows it waiting (not "within 5 minutes"), and the backup is alerted', async () => {
    const src = await coveredSource('Back-dating portal (arrival test)');
    const phone = randomPhone();
    const first = await arrive(src, { phones: [phone] });
    const owner = await accept(first.contactId);
    await humanText(owner, first.contactId);
    // half an hour passes; the text is now 30 minutes old
    await everythingEarlier(first.contactId, 30);
    const textedAt = (await h.su.query<{ dispatched_at: Date }>(`SELECT dispatched_at FROM messages WHERE contact_id = $1 AND initiator = 'human'`, [first.contactId])).rows[0]!.dispatched_at;
    // the same person asks again (about selling: its own inquiry), and the source dates it 2 minutes BEFORE that text
    const second = await arrive(src, { phones: [phone], inquiryType: 'sell', receivedAt: new Date(textedAt.getTime() - 2 * 60_000).toISOString() });
    expect([second.contactId, second.outcome]).toEqual([first.contactId, 'reinquiry']);
    const stored = await inquiry(second.inquiryId);
    expect(stored.received_at.getTime()).toBeLessThan(textedAt.getTime());
    expect(stored.created_at.getTime()).toBeGreaterThan(textedAt.getTime());

    // nobody has responded since it reached the team: it waits, in the queue and in the report
    const row = (await newLeadRow(first.contactId))!;
    expect(row).toBeDefined();
    expect(row.why).toMatch(/Nobody has called, texted or emailed/);
    expect(new Date(row.since).getTime()).toBe(stored.created_at.getTime());
    expect(row.waitingSeconds).toBeLessThan(120);
    const rep = await reported(second.inquiryId);
    expect(rep).toMatchObject({ attempt: null, within5: false });
    expect(rep.waiting!.wallSeconds).toBeLessThan(120);
    expect(new Date(rep.arrivedAt).getTime()).toBe(stored.created_at.getTime());
    // the first inquiry keeps its own attempt
    expect((await reported(first.inquiryId)).attempt).toMatchObject({ by: { userId: owner.userId }, role: 'owner' });

    // four minutes after it reached the team (only this inquiry moves: the text stays where it was, before it)
    await h.su.query(`UPDATE lead_inquiries SET received_at = received_at - interval '4 minutes', created_at = created_at - interval '4 minutes' WHERE id = $1`, [second.inquiryId]);
    await jobDue(second.inquiryId);
    await leadsWorker(h).drain();
    expect((await alertRows(second.inquiryId)).map((r) => [r.outcome, r.alerted_user_id])).toEqual([['alerted', backup.userId]]);
    expect((await alertNotes(second.inquiryId)).map((n) => n.user_id)).toEqual([backup.userId]);
  });

  it('R-TEAMQ-19 E871 E872 E873: the SQL every read uses and the core definition agree, for a claim in the future, in the past and equal to the reach', async () => {
    const src = await coveredSource('Three clocks (arrival test)');
    const future = await arrive(src, { phones: [randomPhone()], receivedAt: new Date(Date.now() + 4 * 60_000).toISOString() });
    const past = await arrive(src, { phones: [randomPhone()], receivedAt: new Date(Date.now() - 26 * 3_600_000).toISOString() });
    const equal = await arrive(src, { phones: [randomPhone()] });
    await h.su.query('UPDATE lead_inquiries SET received_at = created_at WHERE id = $1', [equal.inquiryId]);
    const ids = [future.inquiryId, past.inquiryId, equal.inquiryId];
    const rows = await withTenantTx(
      w.owner.actor(),
      async (tx) => (await sql<{ id: string; received_at: Date; created_at: Date; arrival: Date }>`SELECT i.id, i.received_at, i.created_at, ${ARRIVAL} AS arrival FROM lead_inquiries i WHERE i.id = ANY (${ids}::uuid[])`.execute(tx)).rows,
      { db: h.database },
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const signs = ids.map((id) => Math.sign(byId.get(id)!.received_at.getTime() - byId.get(id)!.created_at.getTime()));
    expect(signs).toEqual([1, -1, 0]);
    for (const id of ids) {
      const r = byId.get(id)!;
      expect(r.arrival.getTime()).toBe(arrivalInstant(instantFromDate(r.received_at), instantFromDate(r.created_at)) as Instant);
      expect(r.arrival.getTime()).toBe(r.created_at.getTime());
    }
  });
});
