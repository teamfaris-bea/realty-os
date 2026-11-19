// The minute-three backup alert over real Postgres (b19 team-queue lane, step 2; owner decisions 1 and 2,
// 2026-11-19; DATA_MODEL R-TEAMQ-14 to R-TEAMQ-18, E846 to E856). Leads arrive through the real intake, the job is
// the real `leads.backup_alert` handler run by a real worker, attempts go through the real send and dial paths (fake
// providers), the automatic reply comes from the real first-response job. The superuser pool only reads state back
// and moves clocks (an inquiry that arrived four minutes ago, a job that is due). Invented people and sources only.
//
// It alerts only: after every case the owner, the offer and the pond are what they were, and nothing went to the client.
import { randomUUID } from 'node:crypto';
import type { Instant, UserActor } from '@realty/core/foundation';
import { businessCalendar, instantFromDate } from '@realty/core/foundation';
import { backupAlertDueAt } from '@realty/core/priority';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvedPlaybook, assistantWorld, grantConsent, runJobs } from '../assistant/testing.js';
import { teamScoreboard } from '../accountability/scoreboard.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, ownedContact, randomEmail, sendText, telephonyWebhook } from '../comms/testing.js';
import { marketingReady } from '../bulk/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { BACKUP_ALERT_JOB, BACKUP_ALERT_SWEEP_JOB, decideBackupAlert, sweepLostBackupAlerts } from './backupAlert.js';
import { leadsHandlers } from './handlers.js';
import { call, command, contactState, freshReauth, importedUnassigned, jobs, ledger, leadsWorker, leadsWorld, postIntake, randomPhone, registerPush, suFixture } from './testing.js';

let h: ApiHarness;
let w: CommsWorld & { others: TestClient[] };
/** the named backup of every covered source here: an agent outside the rotation and outside every team */
let backup: TestClient;
let bystander: TestClient;
const FR = ['assistant.first_response', 'comms.dispatch'];

interface Src {
  id: string;
  token: string;
  name: string;
}
interface AlertRow {
  outcome: string;
  alerted_user_id: string | null;
  recipient: string | null;
  fallback_reason: string | null;
  alerted_count: number;
  holder: string | null;
  holder_user_id: string | null;
  holder_pond_id: string | null;
  grant_expires_at: Date | null;
  decided_at: Date;
  due_at: Date;
  arrived_at: Date;
  inquiry_id: string;
}

async function alertPhone(c: TestClient): Promise<void> {
  const ch = await c.post('/api/me/alert-phone', { phone: randomPhone() });
  const code = h.providers.telephony.verificationCodes.at(-1)!.code;
  const r = await c.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code });
  if (r.statusCode !== 200) throw new Error(`alert phone: ${r.statusCode} ${r.body}`);
}

/** A made-up lead source; `covered` names agents[0] as its owner and `backup` as its backup and turns coverage on. */
async function source(name: string, o: { covered?: boolean; noAutomatedContact?: boolean; world?: CommsWorld; backupUser?: TestClient } = {}): Promise<Src> {
  const world = o.world ?? w;
  await freshReauth(h, world.owner);
  const s = await call<{ source: { id: string }; ingestToken: string }>(world.owner, 'POST', '/lead-sources', { name, kind: 'website' });
  if (s.status !== 201) throw new Error(`lead source: ${s.status} ${JSON.stringify(s.body)}`);
  const id = s.body.source.id;
  if (o.covered !== false) {
    const c = await call(world.owner, 'PUT', `/lead-sources/${id}/coverage`, { ownerUserId: world.agents[0]!.userId, backupUserId: (o.backupUser ?? backup).userId, highIntent: false, covered: true });
    if (c.status !== 200) throw new Error(`coverage: ${c.status} ${JSON.stringify(c.body)}`);
  }
  if (o.noAutomatedContact) {
    const r = await call(world.owner, 'PUT', `/lead-sources/${id}/ai-care`, { noAiCare: true });
    if (r.status !== 200) throw new Error(`ai-care: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return { id, token: s.body.ingestToken, name };
}

interface Lead {
  contactId: string;
  inquiryId: string;
  phone: string;
}
async function arrive(src: Src, body: Record<string, unknown> = {}): Promise<Lead> {
  const phone = randomPhone();
  const r = await postIntake(h, src.token, { inquiryType: 'buy', fullName: 'Dana Rivera', phones: [phone], ...body });
  if (r.statusCode !== 201 && r.statusCode !== 200) throw new Error(`intake: ${r.statusCode} ${r.body}`);
  const j = r.json() as { contactId: string; inquiryId: string };
  return { contactId: j.contactId, inquiryId: j.inquiryId, phone };
}
/** The agent the lead is on offer to accepts it. */
async function accept(lead: Lead, world: CommsWorld = w): Promise<TestClient> {
  const st = await contactState(h, lead.contactId);
  const owner = [...world.agents, ...(world.teamLead ? [world.teamLead] : [])].find((a) => a.userId === st.offered_to_user_id);
  if (!owner || !st.offer_id) throw new Error(`lead not offered: ${st.ownership_state}`);
  const acc = await command(owner, lead.contactId, 'accept', { offerId: st.offer_id });
  if (acc.status !== 200) throw new Error(`accept: ${acc.status} ${JSON.stringify(acc.body)}`);
  return owner;
}
const alertJobs = async (tenantId = w.tenantId, inquiryId?: string) => (await jobs(h, tenantId, BACKUP_ALERT_JOB.kind)).filter((j) => inquiryId === undefined || j.payload.inquiryId === inquiryId);
/** clock fixture: the inquiry arrived (and reached the team) `minutes` ago, and its job is due now */
async function minutesPass(lead: Lead, minutes = 4, tenantId = w.tenantId): Promise<void> {
  await h.su.query(`UPDATE lead_inquiries SET received_at = received_at - ($2::int * interval '1 minute'), created_at = created_at - ($2::int * interval '1 minute') WHERE id = $1`, [lead.inquiryId, minutes]);
  await h.su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND kind = $2 AND status = 'pending' AND payload->>'inquiryId' = $3`, [tenantId, BACKUP_ALERT_JOB.kind, lead.inquiryId]);
}
const alertRows = async (inquiryId: string) => (await h.su.query<AlertRow>('SELECT * FROM lead_backup_alerts WHERE inquiry_id = $1', [inquiryId])).rows;
const alertNotes = async (inquiryId: string) =>
  (await h.su.query<{ id: string; user_id: string; kind: string; priority: string; title: string; body: string | null; subject_id: string }>(`SELECT id, user_id, kind, priority, title, body, subject_id FROM notifications WHERE dedupe_key = $1`, [`backup_alert:${inquiryId}`])).rows;
const channelsOf = async (notificationId: string) => (await h.su.query<{ channel: string }>('SELECT channel FROM notification_deliveries WHERE notification_id = $1 ORDER BY channel', [notificationId])).rows.map((r) => r.channel);
const grantOf = async (contactId: string, userId: string | null) =>
  (await h.su.query<{ role: string; expires_at: Date | null; removed_at: Date | null; live: boolean }>(`SELECT role, expires_at, removed_at, (removed_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS live FROM contact_collaborators WHERE contact_id = $1 AND user_id = $2`, [contactId, userId])).rows[0];
/** what went to the client: every outbound message and call of the person, by who started it */
const toClient = async (contactId: string) =>
  (await h.su.query<{ kind: string; initiator: string }>(
    `SELECT 'message' AS kind, initiator FROM messages WHERE contact_id = $1 AND direction = 'outbound' UNION ALL SELECT 'call', initiator FROM calls WHERE contact_id = $1 AND direction = 'outbound' ORDER BY 1, 2`,
    [contactId],
  )).rows;
const holding = async (contactId: string) => {
  const s = await contactState(h, contactId);
  return { state: s.ownership_state, owner: s.owner_user_id, offeredTo: s.offered_to_user_id, offerId: s.offer_id, offerExpiresAt: s.offer_expires_at?.toISOString() ?? null, pond: s.pond_id, seq: s.ownership_seq };
};
const run = () => leadsWorker(h).drain();
interface ReportInquiry {
  inquiryId: string;
  attempt: { kind: string; by: { userId: string; name: string | null } | null; role: string } | null;
}
/** The lead response report's own line for one inquiry (GET /team/lead-response, step 1). */
async function reported(c: TestClient, inquiryId: string): Promise<ReportInquiry | undefined> {
  const r = await call<{ inquiries: ReportInquiry[] }>(c, 'GET', '/team/lead-response?range=7d');
  if (r.status !== 200) throw new Error(`lead response: ${r.status}`);
  return r.body.inquiries.find((i) => i.inquiryId === inquiryId);
}
async function humanText(by: TestClient, contactId: string): Promise<void> {
  await grantConsent(by, contactId, 'sms');
  const r = await sendText(by, contactId, 'Hi, thanks for reaching out. When is a good time to talk?');
  if (r.body.result !== 'sent') throw new Error(`text not sent: ${JSON.stringify(r.body)}`);
}

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = (await assistantWorld(h, { agents: 2, teamLead: true })) as CommsWorld & { others: TestClient[] };
  backup = await h.invite(w.owner, 'agent');
  bystander = await h.invite(w.owner, 'agent');
  await registerPush(backup);
  await alertPhone(backup);
  const s = await call<{ settings: { version: number } }>(w.owner, 'GET', '/settings');
  const cap = await call(w.owner, 'PATCH', '/settings', { version: s.body.settings.version, uncontactedCapacityCap: 50 });
  if (cap.status !== 200) throw new Error(`settings: ${cap.status} ${JSON.stringify(cap.body)}`);
  // a verified sending domain and a postal address, so a person's own email passes the gate
  await marketingReady(h, w);
  // staffed all day, so three staffed minutes are three minutes unless a test sets the hours itself
  await suFixture(h, [{ text: `UPDATE tenant_settings SET routing_hours_start = '00:00', routing_hours_end = '24:00' WHERE tenant_id = $1`, values: [w.tenantId] }]);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('R-TEAMQ-14 when the backup alert is queued and when it runs', () => {
  it('R-TEAMQ-14 R-TEAMQ-15 E847: an inquiry from a covered source queues ONE job due three staffed minutes after arrival; with no human attempt it alerts the source\'s backup by push and by text to their alert phone, names the lead, the source, the wait and who it is with, records one row, and changes nothing about who has the lead', async () => {
    const src = await source('Website form (alert test)');
    const lead = await arrive(src);
    const before = await holding(lead.contactId);
    expect(before.state).toBe('offered');
    const queued = await alertJobs(w.tenantId, lead.inquiryId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: 'pending', payload: { inquiryId: lead.inquiryId }, dedupe_key: `leads.backup_alert:${lead.inquiryId}` });
    const inq = (await h.su.query<{ received_at: Date; created_at: Date }>('SELECT received_at, created_at FROM lead_inquiries WHERE id = $1', [lead.inquiryId])).rows[0]!;
    const dueMs = queued[0]!.run_at.getTime() - Math.max(inq.received_at.getTime(), inq.created_at.getTime());
    expect(Math.abs(dueMs - 180_000)).toBeLessThan(2_000);
    // not due yet: the worker leaves it alone and nobody is alerted
    await run();
    expect(await alertRows(lead.inquiryId)).toEqual([]);
    expect(await alertNotes(lead.inquiryId)).toEqual([]);

    await minutesPass(lead);
    await run();
    const rows = await alertRows(lead.inquiryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'alerted', alerted_user_id: backup.userId, recipient: 'backup', holder: 'on_offer', holder_user_id: before.offeredTo, holder_pond_id: null });
    expect(rows[0]!.grant_expires_at).not.toBeNull();
    const notes = await alertNotes(lead.inquiryId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ user_id: backup.userId, kind: 'first_touch_due', priority: 'critical', subject_id: lead.contactId });
    expect(notes[0]!.title).toMatch(/^New lead waiting 4 min: Dana R\. from Website form \(alert test\)\. With .+ \(on offer\)\. You are the backup\.$/);
    expect(notes[0]!.title.length).toBeLessThanOrEqual(120);
    expect(notes[0]!.body).toBe('Nobody has called, texted or emailed. You can open this lead and call or text for the next 24 hours.');
    // the existing critical path: in-app, the backup's push subscription, and a text to their verified alert phone
    expect(await channelsOf(notes[0]!.id)).toEqual(['in_app', 'sms', 'web_push']);
    // no full name, number or address of the client in what is pushed and texted
    expect(notes[0]!.title).not.toMatch(/Rivera|\d{3}[-.\s]?\d{4}/);
    // alerts only: the same offer to the same person with the same deadline, the same ledger head
    expect(await holding(lead.contactId)).toEqual(before);
    expect(await toClient(lead.contactId)).toEqual([]);
    expect((await alertJobs(w.tenantId, lead.inquiryId)).map((j) => j.status)).toEqual(['succeeded']);
  });

  it('R-TEAMQ-14 E848: an automated reply does not cancel it: the first-response message went out, and the backup is still alerted', async () => {
    await approvedPlaybook(w.owner, { templateKey: 'new_lead_response' });
    const src = await source('Open house sign-in (alert test)');
    const lead = await arrive(src);
    await accept(lead);
    await runJobs(h, w.tenantId, FR);
    expect(await toClient(lead.contactId)).toEqual([{ kind: 'message', initiator: 'assistant' }]);
    await minutesPass(lead);
    await run();
    expect((await alertRows(lead.inquiryId)).map((r) => [r.outcome, r.alerted_user_id])).toEqual([['alerted', backup.userId]]);
    expect(await alertNotes(lead.inquiryId)).toHaveLength(1);
    // still only the automatic reply: the alert itself sent the client nothing
    expect(await toClient(lead.contactId)).toEqual([{ kind: 'message', initiator: 'assistant' }]);
  });

  it('R-TEAMQ-14 E848: a human text, a human call or a human email, by anyone, cancels it: nobody is alerted and the row says why', async () => {
    const src = await source('Yard sign calls (alert test)');
    // a text by the owner
    const texted = await arrive(src);
    const owner = await accept(texted);
    await humanText(owner, texted.contactId);
    // a call by the Team Lead (not the owner): anyone's attempt counts
    const called = await arrive(src);
    await accept(called);
    await alertPhone(w.teamLead!);
    const dial = await call<{ result: string }>(w.teamLead!, 'POST', `/contacts/${called.contactId}/calls`, {});
    expect([dial.status, dial.body.result]).toEqual([200, 'dialing']);
    // an email by the owner
    const mailed = await arrive(src, { emails: [randomEmail()] });
    const mailOwner = await accept(mailed);
    await grantConsent(mailOwner, mailed.contactId, 'email');
    const mail = await call<{ result: string }>(mailOwner, 'POST', `/contacts/${mailed.contactId}/messages`, { channel: 'email', subject: 'Your question', body: 'Happy to help. When can we talk?', idempotencyKey: `e-${randomUUID()}` });
    expect(mail.body.result).toBe('sent');
    // an attempt made without any alert keeps its step 1 role: the owner's is "owner", the Team Lead's "other"
    expect((await reported(w.owner, texted.inquiryId))!.attempt).toMatchObject({ role: 'owner', by: { userId: owner.userId } });
    expect((await reported(w.owner, called.inquiryId))!.attempt).toMatchObject({ role: 'other', by: { userId: w.teamLead!.userId } });
    for (const lead of [texted, called, mailed]) {
      await minutesPass(lead);
      await run();
      const rows = await alertRows(lead.inquiryId);
      expect(rows.map((r) => [r.outcome, r.alerted_user_id, r.recipient, r.grant_expires_at])).toEqual([['human_attempt', null, null, null]]);
      expect(await alertNotes(lead.inquiryId)).toEqual([]);
      expect(await grantOf(lead.contactId, backup.userId)).toBeUndefined();
    }
  });

  it('R-TEAMQ-14 E846: an off-hours arrival is due three staffed minutes after opening; woken before that, the job waits and alerts nobody', async () => {
    const world = (await assistantWorld(h, { agents: 1, teamLead: true })) as CommsWorld;
    const b = await h.invite(world.owner, 'agent');
    const src = await source('Night form (alert test)', { world, backupUser: b });
    // staffed hours that open later today in the team's zone: now is outside them
    const zone = (await h.su.query<{ z: string }>('SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = $1', [world.tenantId])).rows[0]!.z;
    await suFixture(h, [{ text: `UPDATE tenant_settings SET routing_hours_start = '22:00', routing_hours_end = '23:00' WHERE tenant_id = $1`, values: [world.tenantId] }]);
    const lead = await arrive(src);
    const inq = (await h.su.query<{ received_at: Date; created_at: Date }>('SELECT received_at, created_at FROM lead_inquiries WHERE id = $1', [lead.inquiryId])).rows[0]!;
    const cal = businessCalendar({ zone, open: '22:00', close: '23:00' });
    const expected = backupAlertDueAt(instantFromDate(inq.received_at), instantFromDate(inq.created_at), cal);
    const job = (await alertJobs(world.tenantId, lead.inquiryId))[0]!;
    // 22:03 local today (the world's zone has its local hour between 10 and 16 now)
    expect(Math.abs(job.run_at.getTime() - expected)).toBeLessThan(2_000);
    expect(job.run_at.getTime() - Date.now()).toBeGreaterThan(5 * 3_600_000);
    expect(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(job.run_at)).toBe('22:03');
    // woken early (the job made due by hand, the clock not moved): it goes back to sleep until then
    await h.su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE id = $1`, [job.id]);
    await run();
    expect(await alertRows(lead.inquiryId)).toEqual([]);
    expect(await alertNotes(lead.inquiryId)).toEqual([]);
    const after = (await alertJobs(world.tenantId, lead.inquiryId))[0]!;
    expect(after.status).toBe('pending');
    expect(Math.abs(after.run_at.getTime() - expected)).toBeLessThan(2_000);
  });

  it('R-TEAMQ-14 E854: never queued for an uncovered source, for a source whose coverage is not complete, or for an import; and a source that stopped being covered in between alerts nobody', async () => {
    const plain = await source('Uncovered portal (alert test)', { covered: false });
    const a = await arrive(plain);
    expect(await alertJobs(w.tenantId, a.inquiryId)).toEqual([]);
    const before = (await alertJobs()).length;
    await importedUnassigned(h, w.tenantId, { firstName: 'Imported', lastName: 'Example', phones: [randomPhone()] });
    expect((await alertJobs()).length).toBe(before);
    // covered at intake, switched off before minute three
    const src = await source('Switched off (alert test)');
    const lead = await arrive(src);
    expect(await alertJobs(w.tenantId, lead.inquiryId)).toHaveLength(1);
    const off = await call(w.owner, 'PUT', `/lead-sources/${src.id}/coverage`, { ownerUserId: w.agents[0]!.userId, backupUserId: backup.userId, highIntent: false, covered: false });
    expect(off.status).toBe(200);
    await minutesPass(lead);
    await run();
    expect((await alertRows(lead.inquiryId)).map((r) => [r.outcome, r.alerted_user_id])).toEqual([['source_not_covered', null]]);
    expect(await alertNotes(lead.inquiryId)).toEqual([]);
  });

  it('R-TEAMQ-14: a person answered the lead\'s own call, or the lead was closed, before minute three: nobody is alerted and the row says which', async () => {
    const src = await source('Answered or closed (alert test)');
    // the lead called in and a person picked up (an inbound answered call has no application path in this module: a fixture row)
    const answered = await arrive(src);
    const conversationId = randomUUID();
    await suFixture(h, [
      { text: `INSERT INTO conversations (tenant_id, id, contact_id) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, contact_id) DO NOTHING`, values: [w.tenantId, conversationId, answered.contactId] },
      {
        text: `INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, agent_user_id, client_address, initiator, handled_by, status, started_at, answered_at, ended_at, duration_s, recording_mode, recording_decision)
               SELECT $1, $2, c.id, $3, 'inbound', $4, $5, 'client', 'human', 'completed', now(), now(), now(), 95, 'off', '{}'::jsonb FROM conversations c WHERE c.tenant_id = $1 AND c.contact_id = $3`,
        values: [w.tenantId, randomUUID(), answered.contactId, w.agents[0]!.userId, answered.phone],
      },
    ]);
    // another lead is closed as spam by the Owner before anyone is alerted
    const closed = await arrive(src);
    const seq = Number((await contactState(h, closed.contactId)).ownership_seq);
    expect((await command(w.owner, closed.contactId, 'close', { reason: 'spam', expectedSeq: seq })).status).toBe(200);
    for (const lead of [answered, closed]) await minutesPass(lead);
    await run();
    expect((await alertRows(answered.inquiryId)).map((r) => [r.outcome, r.alerted_user_id])).toEqual([['answered_call', null]]);
    expect((await alertRows(closed.inquiryId)).map((r) => [r.outcome, r.alerted_user_id, r.holder])).toEqual([['lead_closed', null, null]]);
    expect(await alertNotes(answered.inquiryId)).toEqual([]);
    expect(await alertNotes(closed.inquiryId)).toEqual([]);
  });

  it('R-TEAMQ-14 E855: a "No automated contact" source: its CLIENT gets nothing, and the staff alert still fires', async () => {
    const src = await source('Partner referrals (alert test)', { noAutomatedContact: true });
    const lead = await arrive(src);
    await accept(lead);
    await runJobs(h, w.tenantId, FR); // the approved first reply exists for this team; this source's client still gets none
    await minutesPass(lead);
    await run();
    expect((await alertRows(lead.inquiryId)).map((r) => [r.outcome, r.alerted_user_id])).toEqual([['alerted', backup.userId]]);
    expect((await alertNotes(lead.inquiryId)).map((n) => n.user_id)).toEqual([backup.userId]);
    expect(await toClient(lead.contactId)).toEqual([]);
  });
});

describe('R-TEAMQ-15 who is alerted (owner decision 2)', () => {
  it('R-TEAMQ-15 E849: the named backup is suspended: the Team Lead of whoever has the lead is alerted instead, with no new access; the row says it was the fallback', async () => {
    const world = (await assistantWorld(h, { agents: 1, teamLead: true })) as CommsWorld;
    await suFixture(h, [{ text: `UPDATE tenant_settings SET routing_hours_start = '00:00', routing_hours_end = '24:00' WHERE tenant_id = $1`, values: [world.tenantId] }]);
    const b = await h.invite(world.owner, 'agent');
    const src = await source('Fallback form (alert test)', { world, backupUser: b });
    const lead = await arrive(src);
    const holder = (await holding(lead.contactId)).offeredTo;
    await freshReauth(h, world.owner);
    const members = await call<{ members: { userId: string; version: number }[] }>(world.owner, 'GET', '/members');
    const version = members.body.members.find((m) => m.userId === b.userId)!.version;
    expect((await call(world.owner, 'PATCH', `/members/${b.userId}`, { status: 'suspended', version })).status).toBe(200);
    await minutesPass(lead, 4, world.tenantId);
    await run();
    const rows = await alertRows(lead.inquiryId);
    expect(rows.map((r) => [r.outcome, r.alerted_user_id, r.recipient, r.holder_user_id, r.grant_expires_at])).toEqual([['alerted', world.teamLead!.userId, 'team_lead', holder, null]]);
    const notes = await alertNotes(lead.inquiryId);
    expect(notes.map((n) => [n.user_id, n.priority])).toEqual([[world.teamLead!.userId, 'critical']]);
    expect(notes[0]!.title).toMatch(/The source's backup is unavailable\.$/);
    // no collaborator row for anyone: the Team Lead already reaches their team's leads
    expect((await h.su.query('SELECT 1 FROM contact_collaborators WHERE contact_id = $1', [lead.contactId])).rows).toEqual([]);
    // and the source reads as flagged and not covered (R-TEAMQ-11)
    const cov = await call<{ coverage: { covered: boolean; warnings: { code: string }[] } }>(world.owner, 'GET', `/lead-sources/${src.id}/coverage`);
    expect(cov.body.coverage.covered).toBe(false);
    expect(cov.body.coverage.warnings.map((x) => x.code)).toContain('BACKUP_UNAVAILABLE');
  });

  it('R-TEAMQ-15 R-TEAMQ-21 E849 E880: the backup is suspended and whoever has the lead has no Team Lead (a pond): the team\'s Owners and Admins are alerted, never nobody (review fix M2: this case used to end as "no recipient")', async () => {
    const world = await leadsWorld(h, { agents: 1, rule: false });
    await suFixture(h, [{ text: `UPDATE tenant_settings SET routing_hours_start = '00:00', routing_hours_end = '24:00' WHERE tenant_id = $1`, values: [world.tenantId] }]);
    const b = await h.invite(world.owner, 'agent');
    const cover = await call(world.owner, 'PUT', `/lead-sources/${world.sourceId}/coverage`, { ownerUserId: world.agents[0]!.userId, backupUserId: b.userId, highIntent: false, covered: true });
    expect(cover.status).toBe(200);
    const lead = await arrive({ id: world.sourceId, token: world.token, name: 'Portal' });
    expect((await holding(lead.contactId)).state).toBe('in_pond');
    await freshReauth(h, world.owner);
    const members = await call<{ members: { userId: string; version: number }[] }>(world.owner, 'GET', '/members');
    expect((await call(world.owner, 'PATCH', `/members/${b.userId}`, { status: 'suspended', version: members.body.members.find((m) => m.userId === b.userId)!.version })).status).toBe(200);
    await minutesPass(lead, 4, world.tenantId);
    await run();
    expect((await alertRows(lead.inquiryId)).map((r) => [r.outcome, r.alerted_user_id, r.recipient, r.fallback_reason, r.alerted_count, r.holder, r.holder_pond_id, r.grant_expires_at])).toEqual([
      ['alerted', world.owner.userId, 'admins', 'backup_unavailable', 1, 'pond', world.defaultPondId, null],
    ]);
    const notes = await alertNotes(lead.inquiryId);
    expect(notes.map((n) => [n.user_id, n.kind, n.priority])).toEqual([[world.owner.userId, 'first_touch_due', 'critical']]);
    expect(notes[0]!.title).toMatch(/In the pond .+\. The source's backup is unavailable\.$/);
    expect(notes[0]!.body).toBe('Nobody has called, texted or emailed. You are alerted as an Owner or Admin, because the backup named on its source cannot be reached and whoever has this lead has no team lead.');
    expect((await h.su.query('SELECT 1 FROM contact_collaborators WHERE contact_id = $1', [lead.contactId])).rows).toEqual([]);
  });
});

describe('R-TEAMQ-27 a send the provider reported as failed (review fix L6)', () => {
  it('R-TEAMQ-27 E892 E893: the owner\'s text FAILED at the carrier: the lead stays in the queue with "tried … but the text failed", the backup is alerted and told a text was tried, and the report still shows it as the attempt (the scoreboard\'s definition), marked failed', async () => {
    const src = await source('Carrier failure (alert test)');
    const lead = await arrive(src);
    const owner = await accept(lead);
    await grantConsent(owner, lead.contactId, 'sms');
    const sent = await sendText(owner, lead.contactId, 'Hi, thanks for reaching out. When is a good time to talk?');
    expect(sent.body.result).toBe('sent');
    const messageId = sent.body.message!.id;
    // while it is only "sent" it is an attempt like any other: the lead is not waiting
    const rowsOf = async () => (await call<{ groups: { key: string; rows: { contact: { id: string }; why: string; failedAttemptAt: string | null }[]; failedAttempts: number | null }[] }>(w.owner, 'GET', '/team/queue')).body.groups.find((g) => g.key === 'new_lead')!;
    expect((await rowsOf()).rows.find((r) => r.contact.id === lead.contactId)).toBeUndefined();
    // the carrier reports that the text was not delivered
    const ref = (await h.su.query<{ provider_message_ref: string }>('SELECT provider_message_ref FROM messages WHERE id = $1', [messageId])).rows[0]!.provider_message_ref;
    expect((await telephonyWebhook(h, `/webhooks/telephony/status?m=${messageId}`, { MessageSid: ref, MessageStatus: 'undelivered', ErrorCode: '30007', From: w.mainNumber, To: lead.phone })).statusCode).toBe(200);
    expect((await h.su.query<{ status: string }>('SELECT status FROM messages WHERE id = $1', [messageId])).rows[0]!.status).toBe('undelivered');

    const g = await rowsOf();
    const row = g.rows.find((r) => r.contact.id === lead.contactId)!;
    expect(row).toBeDefined();
    expect(row.why).toMatch(/Owned by .+ \S+ \S\. tried at \d{1,2}:\d\d [AP]M, but the text failed\. Nobody else has called, texted or emailed\./);
    expect(row.why).not.toMatch(/Nobody has called, texted or emailed yet/);
    expect(row.failedAttemptAt).not.toBeNull();
    expect(g.failedAttempts).toBeGreaterThanOrEqual(1);

    // minute three: the failed text does not suppress the alert, and the alert says a text was tried
    await minutesPass(lead);
    await run();
    expect((await alertRows(lead.inquiryId)).map((r) => [r.outcome, r.alerted_user_id])).toEqual([['alerted', backup.userId]]);
    const notes = await alertNotes(lead.inquiryId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe('A text was tried, but it failed. Nobody else has called, texted or emailed. You can open this lead and call or text for the next 24 hours.');

    // the report keeps the scoreboard's definition: it is the first attempt, and it says it failed
    const rep = await call<{ inquiries: { inquiryId: string; state: string; attempt: { kind: string; role: string; failed: boolean; by: { userId: string } | null } | null }[]; sources: { sourceId: string; attempted: number; failedAttempts: number }[] }>(w.owner, 'GET', '/team/lead-response?range=7d');
    expect(rep.body.inquiries.find((i) => i.inquiryId === lead.inquiryId)).toMatchObject({ state: 'attempted', attempt: { kind: 'text', role: 'owner', failed: true, by: { userId: owner.userId } } });
    expect(rep.body.sources.find((x) => x.sourceId === src.id)).toMatchObject({ attempted: 1, failedAttempts: 1 });

    // a second text that goes through takes the lead out of the queue
    expect((await sendText(owner, lead.contactId, 'Trying again: when is a good time to talk?')).body.result).toBe('sent');
    expect((await rowsOf()).rows.find((r) => r.contact.id === lead.contactId)).toBeUndefined();
  });
});

describe('R-TEAMQ-24 one definition of "covered now" (review fix L3)', () => {
  it('R-TEAMQ-24 E888 E889: the source\'s OWNER is suspended: the card says "Not covered" and, in words, that the backup alert still goes to the backup and that the automatic return to the pond is back on, with the TEAM\'s own time (45 minutes here, never a hard-coded 30); the job does exactly what the card says', async () => {
    const world = (await assistantWorld(h, { agents: 1, teamLead: true })) as CommsWorld;
    await suFixture(h, [{ text: `UPDATE tenant_settings SET routing_hours_start = '00:00', routing_hours_end = '24:00' WHERE tenant_id = $1`, values: [world.tenantId] }]);
    const sourceOwner = await h.invite(world.owner, 'agent');
    const b = await h.invite(world.owner, 'agent');
    const settings = await call<{ settings: { version: number } }>(world.owner, 'GET', '/settings');
    expect((await call(world.owner, 'PATCH', '/settings', { version: settings.body.settings.version, firstTouchReleaseSeconds: 2700 })).status).toBe(200);
    const src = await source('Owner suspended (alert test)', { world, covered: false });
    await freshReauth(h, world.owner);
    expect((await call(world.owner, 'PUT', `/lead-sources/${src.id}/coverage`, { ownerUserId: sourceOwner.userId, backupUserId: b.userId, highIntent: false, covered: true })).status).toBe(200);
    interface Cov {
      coverage: { covered: boolean; sentence: string; effects: string[]; backup: { name: string | null } };
    }
    const covered = (await call<Cov>(world.owner, 'GET', `/lead-sources/${src.id}/coverage`)).body.coverage;
    const backupName = covered.backup.name!.replace(/\.$/, '');
    expect([covered.covered, covered.effects]).toEqual([
      true,
      [
        `A new lead nobody has called, texted or emailed after 3 minutes of staffed time alerts the backup, ${backupName}.`,
        'A lead with no first contact is not sent back to the pond after 45 minutes while its own owner is an active member.',
      ],
    ]);
    const lead = await arrive(src);
    const members = await call<{ members: { userId: string; version: number }[] }>(world.owner, 'GET', '/members');
    expect((await call(world.owner, 'PATCH', `/members/${sourceOwner.userId}`, { status: 'suspended', version: members.body.members.find((m) => m.userId === sourceOwner.userId)!.version })).status).toBe(200);
    const cov = (await call<Cov>(world.owner, 'GET', `/lead-sources/${src.id}/coverage`)).body.coverage;
    expect(cov.covered).toBe(false);
    expect(cov.sentence).toMatch(/^Not covered: the owner, .+, is suspended\.$/);
    expect(cov.effects).toEqual([
      `The backup alert still fires: a new lead nobody has called, texted or emailed after 3 minutes of staffed time alerts the backup, ${backupName}.`,
      'A lead with no first contact goes back to the pond after 45 minutes again, as on any source that is not covered.',
    ]);
    // the job: the alert still fires, to the backup, as the card says
    await minutesPass(lead, 4, world.tenantId);
    await run();
    expect((await alertRows(lead.inquiryId)).map((r) => [r.outcome, r.alerted_user_id, r.recipient])).toEqual([['alerted', b.userId, 'backup']]);
    // switched off: the card says no alert is sent, and the job sends none
    await freshReauth(h, world.owner);
    expect((await call(world.owner, 'PUT', `/lead-sources/${src.id}/coverage`, { ownerUserId: sourceOwner.userId, backupUserId: b.userId, highIntent: false, covered: true })).status).toBe(200);
    const second = await arrive(src);
    expect((await call(world.owner, 'PUT', `/lead-sources/${src.id}/coverage`, { ownerUserId: sourceOwner.userId, backupUserId: b.userId, highIntent: false, covered: false })).status).toBe(200);
    expect((await call<Cov>(world.owner, 'GET', `/lead-sources/${src.id}/coverage`)).body.coverage.effects).toEqual([
      'No backup alert is sent for this source.',
      "A lead with no first contact goes back to the pond after 45 minutes, the team's setting.",
    ]);
    await minutesPass(second, 4, world.tenantId);
    await run();
    expect((await alertRows(second.inquiryId)).map((r) => r.outcome)).toEqual(['source_not_covered']);
  });
});

describe('R-TEAMQ-21 the backup is the person holding the lead (review fix M2)', () => {
  const setBackup = async (world: CommsWorld, sourceId: string, userId: string | null) => {
    await freshReauth(h, world.owner);
    const r = await call<{ coverage: { warnings: { code: string; sentence: string }[] } }>(world.owner, 'PUT', `/lead-sources/${sourceId}/coverage`, { ownerUserId: world.agents[0]!.userId, backupUserId: userId, highIntent: false, covered: true });
    if (r.status !== 200) throw new Error(`coverage: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.coverage;
  };

  it('R-TEAMQ-21 E879 E881: a lead ON OFFER to, then OWNED by, the source\'s backup: only their Team Lead is alerted ("… who is also the backup for this source"), recorded as team_lead; the holder gets no alert and nobody gets new access; the source says the backup is in its rotation', async () => {
    const src = await source('Rotation test');
    // on offer to the backup
    const offered = await arrive(src);
    const before = await holding(offered.contactId);
    expect(before.state).toBe('offered');
    const cov = await setBackup(w, src.id, before.offeredTo);
    expect(cov.warnings).toContainEqual({ code: 'BACKUP_IN_ROTATION', sentence: 'The backup also receives these leads. When a lead is with them, their team lead is alerted instead.' });
    await minutesPass(offered);
    await run();
    expect((await alertRows(offered.inquiryId)).map((r) => [r.outcome, r.alerted_user_id, r.recipient, r.fallback_reason, r.alerted_count, r.holder, r.holder_user_id, r.grant_expires_at])).toEqual([
      ['alerted', w.teamLead!.userId, 'team_lead', 'backup_is_holder', 1, 'on_offer', before.offeredTo, null],
    ]);
    const notes = await alertNotes(offered.inquiryId);
    expect(notes.map((n) => [n.user_id, n.priority])).toEqual([[w.teamLead!.userId, 'critical']]);
    expect(notes[0]!.title).toMatch(/^New lead waiting 4 min: Dana R\. from Rotation test\. With .+ \(on offer\), who is also the backup for this source\.$/);
    expect(notes[0]!.body).toBe('Nobody has called, texted or emailed. You are alerted as their team lead, because the backup named on this source is the person who has the lead.');
    expect(notes[0]!.title.length).toBeLessThanOrEqual(120);
    expect((await h.su.query('SELECT 1 FROM contact_collaborators WHERE contact_id = $1', [offered.contactId])).rows).toEqual([]);
    expect(await holding(offered.contactId)).toEqual(before);
    expect(await toClient(offered.contactId)).toEqual([]);

    // owned by the backup
    const owned = await arrive(src);
    const owner = await accept(owned);
    await setBackup(w, src.id, owner.userId);
    await minutesPass(owned);
    await run();
    expect((await alertRows(owned.inquiryId)).map((r) => [r.outcome, r.alerted_user_id, r.recipient, r.fallback_reason, r.holder, r.holder_user_id])).toEqual([['alerted', w.teamLead!.userId, 'team_lead', 'backup_is_holder', 'owner', owner.userId]]);
    const ownedNotes = await alertNotes(owned.inquiryId);
    expect(ownedNotes.map((n) => n.user_id)).toEqual([w.teamLead!.userId]);
    expect(ownedNotes[0]!.title).toMatch(/\. With [^()]+, who is also the backup for this source\.$/);
    // the queue says who was told and why, as the Owner and as the Team Lead read it
    const q = await call<{ groups: { key: string; rows: { contact: { id: string }; backupAlert: { alerted: boolean; line: string } | null }[] }[] }>(w.owner, 'GET', '/team/queue');
    const row = q.body.groups.find((g) => g.key === 'new_lead')!.rows.find((r) => r.contact.id === owned.contactId)!;
    expect(row.backupAlert!.line).toMatch(/^The backup has this lead: their team lead, \S+ \S\., was alerted at \d{1,2}:\d\d [AP]M\.$/);
  });

  it('R-TEAMQ-21 E880: the backup holds the lead and has NO team lead: the Owner and the Admin are both alerted, recorded as admins with their number; the holder is not', async () => {
    const world = (await assistantWorld(h, { agents: 1, others: ['admin'] })) as CommsWorld & { others: TestClient[] };
    await suFixture(h, [{ text: `UPDATE tenant_settings SET routing_hours_start = '00:00', routing_hours_end = '24:00' WHERE tenant_id = $1`, values: [world.tenantId] }]);
    const admin = world.others[0]!;
    const agent = world.agents[0]!;
    const src = await source('Solo agent form (alert test)', { world, backupUser: agent });
    const lead = await arrive(src);
    expect((await holding(lead.contactId)).offeredTo).toBe(agent.userId);
    await minutesPass(lead, 4, world.tenantId);
    await run();
    const both = [world.owner.userId, admin.userId].sort();
    expect((await alertRows(lead.inquiryId)).map((r) => [r.outcome, r.alerted_user_id, r.recipient, r.fallback_reason, r.alerted_count, r.holder_user_id, r.grant_expires_at])).toEqual([['alerted', both[0], 'admins', 'backup_is_holder', 2, agent.userId, null]]);
    const notes = await alertNotes(lead.inquiryId);
    expect(notes.map((n) => n.user_id).sort()).toEqual(both);
    for (const n of notes) {
      expect(n.title).toMatch(/\(on offer\), who is also the backup for this source\.$/);
      expect(n.body).toBe('Nobody has called, texted or emailed. You are alerted as an Owner or Admin, because the backup named on this source is the person who has the lead, and they have no team lead.');
    }
    expect((await h.su.query('SELECT 1 FROM contact_collaborators WHERE contact_id = $1', [lead.contactId])).rows).toEqual([]);
  });

  it('R-TEAMQ-21: "nobody" is recorded only when the team has nobody else: a one-person team whose Owner holds the lead and is its own backup', async () => {
    const world = await leadsWorld(h, { agents: 0, rule: false });
    await suFixture(h, [{ text: `UPDATE tenant_settings SET routing_hours_start = '00:00', routing_hours_end = '24:00' WHERE tenant_id = $1`, values: [world.tenantId] }]);
    await freshReauth(h, world.owner);
    const cover = await call(world.owner, 'PUT', `/lead-sources/${world.sourceId}/coverage`, { ownerUserId: world.owner.userId, backupUserId: world.owner.userId, highIntent: false, covered: true });
    expect(cover.status).toBe(200);
    const lead = await arrive({ id: world.sourceId, token: world.token, name: 'Portal' });
    const st = await contactState(h, lead.contactId);
    expect(st.ownership_state).toBe('in_pond');
    // the Owner takes the pond lead themself
    const take = await command(world.owner, lead.contactId, 'reassign', { toUserId: world.owner.userId });
    expect(take.status).toBe(200);
    expect((await holding(lead.contactId)).owner).toBe(world.owner.userId);
    await minutesPass(lead, 4, world.tenantId);
    await run();
    expect((await alertRows(lead.inquiryId)).map((r) => [r.outcome, r.alerted_user_id, r.recipient, r.alerted_count, r.holder_user_id])).toEqual([['no_recipient', null, null, 0, world.owner.userId]]);
    expect(await alertNotes(lead.inquiryId)).toEqual([]);
  });
});

describe('R-TEAMQ-16 the backup\'s access', () => {
  it('R-TEAMQ-16 E851 E852: on an OWNED lead the backup can open the person and place a call with the fake provider; the first touch is credited to the backup and the owner is unchanged; the owner\'s own attempt then ends the backup\'s access', async () => {
    const src = await source('Accepted then silent (alert test)');
    const lead = await arrive(src);
    const owner = await accept(lead);
    // before the alert the backup cannot see the person at all, nor call them
    expect((await call(backup, 'GET', `/contacts/${lead.contactId}`)).status).toBe(404);
    expect((await call(backup, 'POST', `/contacts/${lead.contactId}/calls`, {})).status).toBe(404);
    await minutesPass(lead);
    await run();
    const row = (await alertRows(lead.inquiryId))[0]!;
    expect(row).toMatchObject({ outcome: 'alerted', alerted_user_id: backup.userId, holder: 'owner', holder_user_id: owner.userId });
    const grant = (await grantOf(lead.contactId, backup.userId))!;
    expect(grant).toMatchObject({ role: 'backup', removed_at: null, live: true });
    const hours = (grant.expires_at!.getTime() - row.decided_at.getTime()) / 3_600_000;
    expect(Math.abs(hours - 24)).toBeLessThan(0.01);
    expect(row.grant_expires_at!.getTime()).toBe(grant.expires_at!.getTime());
    // the grant is audited as the system's, with the role and no name
    const audit = (await h.su.query<{ actor_kind: string; reason: string; changes: Record<string, unknown> }>(`SELECT actor_kind, reason, changes FROM audit_log WHERE action = 'collaborator.added' AND entity_id = $1`, [lead.contactId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_kind: 'system', reason: 'BACKUP_ALERT' });

    // the backup opens the person and calls: the gate, the dial and the touch are the ordinary ones
    const seen = await call<{ contact: { id: string } }>(backup, 'GET', `/contacts/${lead.contactId}`);
    expect(seen.status).toBe(200);
    const dial = await call<{ result: string; callId: string }>(backup, 'POST', `/contacts/${lead.contactId}/calls`, {});
    expect([dial.status, dial.body.result]).toEqual([200, 'dialing']);
    expect(h.providers.telephony.calls.at(-1)).toMatchObject({ to: lead.phone });
    const first = (await ledger(h, lead.contactId)).find((e) => e.type === 'first_touch_recorded')!;
    expect(first).toMatchObject({ reason_code: 'FIRST_TOUCH_CALL', actor_kind: 'user', actor_user_id: backup.userId, owner_user_id: owner.userId });
    expect((await holding(lead.contactId)).owner).toBe(owner.userId);
    expect(await toClient(lead.contactId)).toEqual([{ kind: 'call', initiator: 'human' }]);
    // R-TEAMQ-18: the response report credits the attempt to the backup, under their own id, as "backup"
    expect((await reported(w.owner, lead.inquiryId))!.attempt).toMatchObject({ kind: 'call', by: { userId: backup.userId }, role: 'backup' });
    // the backup's own attempt keeps their window; a member who was not alerted still sees nothing
    expect((await grantOf(lead.contactId, backup.userId))!.live).toBe(true);
    expect((await call(bystander, 'GET', `/contacts/${lead.contactId}`)).status).toBe(404);

    // the owner now makes their own attempt: the backup's access ends with it
    await humanText(owner, lead.contactId);
    const ended = (await grantOf(lead.contactId, backup.userId))!;
    expect(ended.live).toBe(false);
    expect(ended.removed_at).toBeNull(); // the row stays, as the record
    expect((await call(backup, 'GET', `/contacts/${lead.contactId}`)).status).toBe(404);
    expect((await call(backup, 'POST', `/contacts/${lead.contactId}/calls`, {})).status).toBe(404);
  });

  it('R-TEAMQ-23 E885 E886 (review fix M5): the backup makes the FIRST call on an owned lead: the owner\'s speed to lead does not improve (not "within", not "responded", no median), the period is shown as "first touch by the backup", and the speed-to-lead view says so; the owner\'s own first call on another lead still counts as theirs', async () => {
    interface Board {
      userId: string;
      speedToLead: { medianSeconds: number | null; withinSla: number; total: number; responded: number; pending: number; byBackup: number };
    }
    const board = async (userId: string): Promise<Board['speedToLead']> => {
      const r = await call<{ members: Board[] }>(w.owner, 'GET', '/team/scoreboard?range=7d');
      if (r.status !== 200) throw new Error(`scoreboard: ${r.status}`);
      return r.body.members.find((m) => m.userId === userId)!.speedToLead;
    };
    const src = await source('Backup calls first (alert test)');
    const lead = await arrive(src);
    const owner = await accept(lead);
    const before = await board(owner.userId!);
    await minutesPass(lead);
    await run();
    expect((await alertRows(lead.inquiryId))[0]).toMatchObject({ outcome: 'alerted', alerted_user_id: backup.userId, recipient: 'backup' });
    const dial = await call<{ result: string }>(backup, 'POST', `/contacts/${lead.contactId}/calls`, {});
    expect([dial.status, dial.body.result]).toEqual([200, 'dialing']);
    // the ledger is unchanged in what it records: the first touch, on the owner's period, made by the backup
    expect((await ledger(h, lead.contactId)).find((e) => e.type === 'first_touch_recorded')).toMatchObject({ actor_user_id: backup.userId, owner_user_id: owner.userId });

    const after = await board(owner.userId!);
    // the owner's own numbers did not improve
    expect([after.withinSla, after.responded, after.medianSeconds]).toEqual([before.withinSla, before.responded, before.medianSeconds]);
    // the period is no longer "still waiting" on the owner, and it is not a miss of theirs: it is the backup's first touch
    expect(after.byBackup).toBe(before.byBackup + 1);
    expect(after.pending).toBe(before.pending - 1);
    expect(after.total).toBe(before.total);
    // the same numbers from the all-live computation (no daily rollup)
    const live = await withTenantTx(w.owner.actor(), (tx, now) => teamScoreboard(tx, w.owner.actor() as UserActor, '7d', now as Instant, 'live'), { db: h.database });
    expect(live.members.find((m) => m.userId === owner.userId)!.speedToLead).toEqual(after);
    // the speed-to-lead view shows the period as first touched by the backup, not as the owner's response
    const view = (await h.su.query<{ user_id: string; first_touch_at: Date | null; first_touch_user_id: string | null; first_touch_by_backup: boolean; response_seconds: string | null; within_sla: boolean }>(
      'SELECT user_id, first_touch_at, first_touch_user_id, first_touch_by_backup, response_seconds, within_sla FROM v_speed_to_lead WHERE contact_id = $1', [lead.contactId])).rows;
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ user_id: owner.userId, first_touch_user_id: backup.userId, first_touch_by_backup: true, response_seconds: null, within_sla: false });
    expect(view[0]!.first_touch_at).not.toBeNull();

    // the owner's OWN first call on another lead is theirs, as before
    const mine = await arrive(src);
    const mineOwner = await accept(mine);
    await alertPhone(mineOwner);
    const base = await board(mineOwner.userId!);
    const own = await call<{ result: string }>(mineOwner, 'POST', `/contacts/${mine.contactId}/calls`, {});
    expect([own.status, own.body.result]).toEqual([200, 'dialing']);
    const mineAfter = await board(mineOwner.userId!);
    expect([mineAfter.withinSla, mineAfter.responded, mineAfter.byBackup]).toEqual([base.withinSla + 1, base.responded + 1, base.byBackup]);
    const ownView = (await h.su.query<{ first_touch_by_backup: boolean; within_sla: boolean; first_touch_user_id: string }>('SELECT first_touch_by_backup, within_sla, first_touch_user_id FROM v_speed_to_lead WHERE contact_id = $1', [mine.contactId])).rows;
    expect(ownView).toEqual([{ first_touch_by_backup: false, within_sla: true, first_touch_user_id: mineOwner.userId }]);
  });

  it('R-TEAMQ-16 E851: on a lead still ON OFFER the backup can open the person and call; the offer stands, no first touch is written to the ledger (nobody owns it yet), and the access ends on its own after 24 hours', async () => {
    const src = await source('Still on offer (alert test)');
    const lead = await arrive(src);
    const before = await holding(lead.contactId);
    expect(before.state).toBe('offered');
    await minutesPass(lead);
    await run();
    expect((await grantOf(lead.contactId, backup.userId))!.live).toBe(true);
    expect((await call(backup, 'GET', `/contacts/${lead.contactId}`)).status).toBe(200);
    const dial = await call<{ result: string }>(backup, 'POST', `/contacts/${lead.contactId}/calls`, {});
    expect([dial.status, dial.body.result]).toEqual([200, 'dialing']);
    expect(await holding(lead.contactId)).toEqual(before);
    expect((await ledger(h, lead.contactId)).map((e) => e.type)).not.toContain('first_touch_recorded');
    // the call is the backup's own, in the call record
    expect((await h.su.query<{ agent_user_id: string }>(`SELECT agent_user_id FROM calls WHERE contact_id = $1 AND direction = 'outbound'`, [lead.contactId])).rows).toEqual([{ agent_user_id: backup.userId }]);
    // R-TEAMQ-18: with nobody owning the lead yet, the report still credits the attempt to the backup, as "backup"
    expect((await reported(w.owner, lead.inquiryId))!.attempt).toMatchObject({ kind: 'call', by: { userId: backup.userId }, role: 'backup' });
    // 24 hours later (clock fixture on the grant): nothing
    await h.su.query(`UPDATE contact_collaborators SET expires_at = now() - interval '1 second', created_at = created_at - interval '25 hours' WHERE contact_id = $1 AND user_id = $2`, [lead.contactId, backup.userId]);
    expect((await call(backup, 'GET', `/contacts/${lead.contactId}`)).status).toBe(404);
    expect((await call(backup, 'POST', `/contacts/${lead.contactId}/calls`, {})).status).toBe(404);
  });

  it('R-TEAMQ-16: a member who already collaborates on the lead keeps their own access as it was (the alert never shortens or replaces it)', async () => {
    const src = await source('Already collaborating (alert test)');
    const lead = await arrive(src);
    const owner = await accept(lead);
    const add = await call(owner, 'POST', `/contacts/${lead.contactId}/collaborators`, { userId: backup.userId, role: 'co_agent' });
    expect(add.status).toBe(200);
    await minutesPass(lead);
    await run();
    expect((await alertRows(lead.inquiryId))[0]).toMatchObject({ outcome: 'alerted', alerted_user_id: backup.userId, grant_expires_at: null });
    expect(await grantOf(lead.contactId, backup.userId)).toMatchObject({ role: 'co_agent', expires_at: null, live: true });
  });
});

describe('R-TEAMQ-26 a merge carries the waiting inquiry and the backup\'s grant to the surviving record (review fix L5)', () => {
  it('R-TEAMQ-26 E891: the alerted lead is merged INTO another record of the same person: the waiting inquiry is the survivor\'s (it stays in the queue, with its alert line, and in the report), the backup can open the survivor until the same expiry and no longer holds a live grant on the merged-away record; the merge moved no owner beyond its own rule and sent the client nothing', async () => {
    const src = await source('Merged away (alert test)');
    const lead = await arrive(src);
    const owner = await accept(lead);
    await minutesPass(lead);
    await run();
    const alert = (await alertRows(lead.inquiryId))[0]!;
    expect(alert).toMatchObject({ outcome: 'alerted', alerted_user_id: backup.userId, recipient: 'backup' });
    const granted = (await grantOf(lead.contactId, backup.userId))!;
    expect(granted.live).toBe(true);
    // the same person, typed in by the same agent as a second record: the survivor of the merge
    const survivor = (await ownedContact(owner, { consent: false, firstName: 'Dana', confirmDistinct: true })).id;
    expect((await call(backup, 'GET', `/contacts/${survivor}`)).status).toBe(404);
    const merged = await command(w.owner, survivor, 'merge', { loserId: lead.contactId, ownerChoice: owner.userId });
    expect(merged.status).toBe(200);
    await run(); // a Team Lead's merge moves in the follow-up job; the Owner's moved inline: either way it is done now
    expect((await h.su.query('SELECT merged_into_contact_id AS m FROM contacts WHERE id = $1', [lead.contactId])).rows[0]!.m).toBe(survivor);

    // the inquiry is the survivor's now, with its alert row (which follows its inquiry)
    expect((await h.su.query('SELECT contact_id FROM lead_inquiries WHERE id = $1', [lead.inquiryId])).rows).toEqual([{ contact_id: survivor }]);
    const q = await call<{ groups: { key: string; rows: { contact: { id: string }; why: string; backupAlert: { alerted: boolean; line: string } | null }[] }[] }>(w.owner, 'GET', '/team/queue');
    const rows = q.body.groups.find((g) => g.key === 'new_lead')!.rows;
    expect(rows.find((r) => r.contact.id === lead.contactId)).toBeUndefined();
    const row = rows.find((r) => r.contact.id === survivor)!;
    expect(row).toBeDefined();
    expect(row.why).toMatch(/Nobody has called, texted or emailed yet\./);
    expect(row.backupAlert).toMatchObject({ alerted: true, line: expect.stringMatching(/^Backup alerted at /) });
    expect((await reported(w.owner, lead.inquiryId))!.attempt).toBeNull();

    // the backup's grant: live on the survivor until the SAME expiry; not live on the merged-away record
    const carried = (await grantOf(survivor, backup.userId))!;
    expect(carried).toMatchObject({ role: 'backup', removed_at: null, live: true });
    expect(carried.expires_at!.getTime()).toBe(granted.expires_at!.getTime());
    expect((await grantOf(lead.contactId, backup.userId))!.live).toBe(false);
    expect((await call(backup, 'GET', `/contacts/${survivor}`)).status).toBe(200);
    expect((await call(bystander, 'GET', `/contacts/${survivor}`)).status).toBe(404);
    // the backup's call from the survivor is the attempt on the carried inquiry, credited to the backup
    const dial = await call<{ result: string }>(backup, 'POST', `/contacts/${survivor}/calls`, {});
    expect([dial.status, dial.body.result]).toEqual([200, 'dialing']);
    expect((await reported(w.owner, lead.inquiryId))!.attempt).toMatchObject({ kind: 'call', by: { userId: backup.userId }, role: 'backup' });
    expect((await holding(survivor)).owner).toBe(owner.userId);
    expect(await toClient(survivor)).toEqual([{ kind: 'call', initiator: 'human' }]);
  });

  it('R-TEAMQ-26 E891: an EXPIRED grant, or a member\'s other access on the survivor, is not touched by the merge: nothing is revived and nothing is replaced', async () => {
    const src = await source('Merged, expired (alert test)');
    const lead = await arrive(src);
    const owner = await accept(lead);
    await minutesPass(lead);
    await run();
    await h.su.query(`UPDATE contact_collaborators SET expires_at = now() - interval '1 second' WHERE contact_id = $1 AND user_id = $2`, [lead.contactId, backup.userId]);
    const survivor = (await ownedContact(owner, { consent: false, firstName: 'Dana', confirmDistinct: true })).id;
    expect((await command(w.owner, survivor, 'merge', { loserId: lead.contactId, ownerChoice: owner.userId })).status).toBe(200);
    await run();
    expect(await grantOf(survivor, backup.userId)).toBeUndefined();
    expect((await call(backup, 'GET', `/contacts/${survivor}`)).status).toBe(404);

    // a co-agent of the survivor who is also the loser's alerted backup keeps exactly their co-agent access
    const lead2 = await arrive(src);
    const owner2 = await accept(lead2);
    await minutesPass(lead2);
    await run();
    expect((await grantOf(lead2.contactId, backup.userId))!.live).toBe(true);
    const survivor2 = (await ownedContact(owner2, { consent: false, firstName: 'Dana', confirmDistinct: true })).id;
    expect((await call(owner2, 'POST', `/contacts/${survivor2}/collaborators`, { userId: backup.userId, role: 'co_agent' })).status).toBe(200);
    expect((await command(w.owner, survivor2, 'merge', { loserId: lead2.contactId, ownerChoice: owner2.userId })).status).toBe(200);
    await run();
    expect(await grantOf(survivor2, backup.userId)).toMatchObject({ role: 'co_agent', expires_at: null, live: true });
  });
});

describe('R-TEAMQ-17 once per inquiry', () => {
  it('R-TEAMQ-17 E853: idempotent on replay: the job run twice and the intake replayed leave one alert row, one notification, one job, and the same owner', async () => {
    const src = await source('Replayed (alert test)');
    const body = { inquiryType: 'buy', fullName: 'Robin Vale', phones: [randomPhone()], externalId: `ext-${randomUUID()}` };
    const first = await postIntake(h, src.token, body);
    expect(first.statusCode).toBe(201);
    const j = first.json() as { contactId: string; inquiryId: string };
    const lead: Lead = { contactId: j.contactId, inquiryId: j.inquiryId, phone: body.phones[0]! };
    const owner = await accept(lead);
    await minutesPass(lead);
    await run();
    expect(await alertRows(lead.inquiryId)).toHaveLength(1);
    const noteIds = (await alertNotes(lead.inquiryId)).map((n) => n.id);
    expect(noteIds).toHaveLength(1);
    // the same job delivered again (a lease that expired, the sweeper): nothing new
    await h.su.query(`UPDATE jobs SET status = 'pending', finished_at = NULL, run_at = now() - interval '1 second' WHERE tenant_id = $1 AND kind = $2 AND payload->>'inquiryId' = $3`, [w.tenantId, BACKUP_ALERT_JOB.kind, lead.inquiryId]);
    await run();
    // the decision asked for directly, twice more
    for (let i = 0; i < 2; i++) {
      const again = await withTenantTx(systemActor(w.tenantId, 'timer'), (tx, now) => decideBackupAlert(tx, h.app.platform.ids, lead.inquiryId, now as Instant, systemActor(w.tenantId, 'timer')), { db: h.database });
      expect(again.outcome).toBe('already_decided');
    }
    // the source posts the same inquiry again: the stored outcome, no second job
    const replay = await postIntake(h, src.token, body);
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { inquiryId: string }).inquiryId).toBe(lead.inquiryId);
    await run();
    expect(await alertRows(lead.inquiryId)).toHaveLength(1);
    expect((await alertNotes(lead.inquiryId)).map((n) => n.id)).toEqual(noteIds);
    expect(await alertJobs(w.tenantId, lead.inquiryId)).toHaveLength(1);
    expect((await h.su.query('SELECT 1 FROM contact_collaborators WHERE contact_id = $1', [lead.contactId])).rows).toHaveLength(1);
    expect((await holding(lead.contactId)).owner).toBe(owner.userId);
  });

  it('R-TEAMQ-17 E887 (review fix L2): two runs decide the same inquiry in OVERLAPPING transactions: one alerts; the loser commits nothing at all: the backup\'s grant keeps the winner\'s expiry, one audit row, one notification', async () => {
    const src = await source('Overlapping runs (alert test)');
    const lead = await arrive(src);
    const owner = await accept(lead);
    await minutesPass(lead);
    const actor = systemActor(w.tenantId, 'timer');
    const t1 = Date.now() as Instant;
    const t2 = (t1 + 5_000) as Instant; // the second run's clock is five seconds later: its grant would end five seconds later
    let firstDecided!: () => void;
    const decided = new Promise<void>((r) => (firstDecided = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // the first run decides (row, grant, notification written, not committed) and holds its transaction open
    const first = withTenantTx(actor, async (tx) => {
      const r = await decideBackupAlert(tx, h.app.platform.ids, lead.inquiryId, t1, actor);
      firstDecided();
      await gate;
      return r;
    }, { db: h.database });
    await decided;
    // the second run starts while the first is still open: it sees no row yet, and waits on the first run's writes
    const second = withTenantTx(actor, (tx) => decideBackupAlert(tx, h.app.platform.ids, lead.inquiryId, t2, actor), { db: h.database });
    await new Promise((r) => setTimeout(r, 400));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.outcome, b.outcome]).toEqual(['alerted', 'already_decided']);
    const rows = await alertRows(lead.inquiryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decided_at.getTime()).toBe(t1);
    // the loser changed nothing: the grant's expiry is the winner's (24 hours after ITS decision), exactly what the alert row says
    const grant = (await grantOf(lead.contactId, backup.userId))!;
    expect(grant.expires_at!.getTime()).toBe(t1 + 24 * 3_600_000);
    expect(grant.expires_at!.getTime()).toBe(rows[0]!.grant_expires_at!.getTime());
    expect((await h.su.query(`SELECT 1 FROM audit_log WHERE action = 'collaborator.added' AND entity_id = $1`, [lead.contactId])).rows).toHaveLength(1);
    expect(await alertNotes(lead.inquiryId)).toHaveLength(1);
    expect((await holding(lead.contactId)).owner).toBe(owner.userId);
  });

  it('R-TEAMQ-17 E856: a second inquiry from the same person is its own arrival: its own job, its own row, its own alert', async () => {
    const src = await source('Asked twice (alert test)');
    const first = await arrive(src);
    await accept(first);
    await minutesPass(first);
    await run();
    expect((await alertRows(first.inquiryId)).map((r) => r.outcome)).toEqual(['alerted']);
    // the same person asks again, about selling this time (a different inquiry, not a duplicate delivery)
    const again = await postIntake(h, src.token, { inquiryType: 'sell', fullName: 'Dana Rivera', phones: [first.phone] });
    expect(again.statusCode).toBe(200);
    const second = again.json() as { contactId: string; inquiryId: string; outcome: string };
    expect(second.outcome).toBe('reinquiry');
    expect(second.contactId).toBe(first.contactId);
    expect(second.inquiryId).not.toBe(first.inquiryId);
    expect(await alertJobs(w.tenantId, second.inquiryId)).toHaveLength(1);
    await minutesPass({ ...first, inquiryId: second.inquiryId });
    await run();
    expect((await alertRows(second.inquiryId)).map((r) => [r.outcome, r.alerted_user_id])).toEqual([['alerted', backup.userId]]);
    expect(await alertNotes(second.inquiryId)).toHaveLength(1);
    expect((await h.su.query('SELECT count(*)::int AS n FROM lead_backup_alerts l JOIN lead_inquiries i ON i.id = l.inquiry_id WHERE i.contact_id = $1', [first.contactId])).rows[0].n).toBe(2);
    // a duplicate delivery of the same form inside ten minutes is not an arrival: no job
    const dup = await postIntake(h, src.token, { inquiryType: 'sell', fullName: 'Dana Rivera', phones: [first.phone] });
    const dupId = (dup.json() as { inquiryId: string; outcome: string });
    expect(dupId.outcome).toBe('duplicate_ignored');
    expect(await alertJobs(w.tenantId, dupId.inquiryId)).toEqual([]);
  });
});

describe('R-TEAMQ-28 smaller fixes of the review (L7)', () => {
  const sweep = () => withTenantTx(systemActor(w.tenantId, 'worker'), (tx, now) => sweepLostBackupAlerts(tx, now as Instant), { db: h.database });

  it('R-TEAMQ-28 E894: a LOST alert job is re-issued by the sweep, once: the inquiry is decided and its backup alerted; an inquiry not yet due, one already decided, one with its job alive and one of an uncovered source get nothing new', async () => {
    const src = await source('Lost job (alert test)');
    const lost = await arrive(src);
    const alive = await arrive(src);
    const early = await arrive(src);
    const plain = await source('Lost job, uncovered (alert test)', { covered: false });
    const uncovered = await arrive(plain);
    // the job of `lost` and of `early` disappears (a purge, a bad deploy); four minutes pass for `lost` and `alive`
    await h.su.query(`DELETE FROM jobs WHERE kind = $1 AND payload->>'inquiryId' = ANY ($2::text[])`, [BACKUP_ALERT_JOB.kind, [lost.inquiryId, early.inquiryId]]);
    await minutesPass(lost);
    await minutesPass(alive);
    expect(await alertJobs(w.tenantId, lost.inquiryId)).toEqual([]);
    const first = await sweep();
    expect(first.reissued).toBeGreaterThanOrEqual(1);
    expect((await alertJobs(w.tenantId, lost.inquiryId)).map((j) => j.status)).toEqual(['pending']);
    // the live job of `alive` is left alone (one job, never two); nothing for the one not yet due or the uncovered source
    expect(await alertJobs(w.tenantId, alive.inquiryId)).toHaveLength(1);
    expect(await alertJobs(w.tenantId, early.inquiryId)).toEqual([]);
    expect(await alertJobs(w.tenantId, uncovered.inquiryId)).toEqual([]);
    // swept again before the worker ran: still one job
    await sweep();
    expect(await alertJobs(w.tenantId, lost.inquiryId)).toHaveLength(1);
    await run();
    expect((await alertRows(lost.inquiryId)).map((r) => [r.outcome, r.alerted_user_id])).toEqual([['alerted', backup.userId]]);
    expect(await alertNotes(lost.inquiryId)).toHaveLength(1);
    // decided: the sweep has nothing more to do for it
    const before = (await alertJobs(w.tenantId, lost.inquiryId)).length;
    await sweep();
    expect((await alertJobs(w.tenantId, lost.inquiryId)).length).toBe(before);
    expect(await alertRows(lost.inquiryId)).toHaveLength(1);
    // the sweep is a registered periodic job of the team's worker
    expect(leadsHandlers.find((x) => x.kind === BACKUP_ALERT_SWEEP_JOB.kind)).toMatchObject({ every: { ms: 5 * 60_000 } });
  });

  it('R-TEAMQ-28 E895: the backup\'s grant ends when the lead changes owner: a reassignment by the Owner, and the owner\'s own release to the pond', async () => {
    const src = await source('Owner changes (alert test)');
    const a = await arrive(src);
    const ownerA = await accept(a);
    const b = await arrive(src);
    const ownerB = await accept(b);
    for (const lead of [a, b]) await minutesPass(lead);
    await run();
    for (const lead of [a, b]) expect((await grantOf(lead.contactId, backup.userId))!.live).toBe(true);
    // reassigned by the Owner to the other agent
    const other = w.agents.find((x) => x.userId !== ownerA.userId)!;
    expect((await command(w.owner, a.contactId, 'reassign', { toUserId: other.userId })).status).toBe(200);
    await run();
    expect((await grantOf(a.contactId, backup.userId))!).toMatchObject({ live: false, removed_at: null, role: 'backup' });
    expect((await call(backup, 'GET', `/contacts/${a.contactId}`)).status).toBe(404);
    // released to the pond by its own owner (an agent: the grant is ended for them by the follow-up job, as the system)
    expect((await command(ownerB, b.contactId, 'release', { reason: 'not_a_fit' })).status).toBe(200);
    await run();
    // (the lead is a pond lead now: what the backup can see of it is what any member of that pond sees, not the grant)
    expect((await grantOf(b.contactId, backup.userId))!).toMatchObject({ live: false, removed_at: null, role: 'backup' });
    expect((await holding(b.contactId)).state).toBe('in_pond');
  });

  it('R-TEAMQ-28 E896: a backup grant is always time-boxed (the database refuses a `backup` row with no expiry); a manual share of that member is an explicit, audited change to the role the sharer chose, never a silent permanent "backup"', async () => {
    const src = await source('Shared by hand (alert test)');
    const lead = await arrive(src);
    const owner = await accept(lead);
    await minutesPass(lead);
    await run();
    expect(await grantOf(lead.contactId, backup.userId)).toMatchObject({ role: 'backup', live: true });
    // no path can make a backup row permanent: the database itself refuses
    await expect(h.su.query(`UPDATE contact_collaborators SET expires_at = NULL WHERE contact_id = $1 AND user_id = $2`, [lead.contactId, backup.userId])).rejects.toThrow(/contact_collaborators_backup_time_boxed/);
    // the owner shares the person with that member by hand, as a co-agent: an explicit choice with its own audit row
    expect((await call(owner, 'POST', `/contacts/${lead.contactId}/collaborators`, { userId: backup.userId, role: 'co_agent' })).status).toBe(200);
    expect(await grantOf(lead.contactId, backup.userId)).toMatchObject({ role: 'co_agent', expires_at: null, live: true });
    const audits = (await h.su.query<{ actor_kind: string; actor_user_id: string | null; reason: string | null }>(`SELECT actor_kind, actor_user_id, reason FROM audit_log WHERE action = 'collaborator.added' AND entity_id = $1 ORDER BY seq`, [lead.contactId])).rows;
    expect(audits).toEqual([
      { actor_kind: 'system', actor_user_id: null, reason: 'BACKUP_ALERT' },
      { actor_kind: 'user', actor_user_id: owner.userId, reason: null },
    ]);
    // it is the owner's deliberate share now: their own attempt does not end it
    await humanText(owner, lead.contactId);
    expect((await grantOf(lead.contactId, backup.userId))!.live).toBe(true);
  });
});

describe('R-TEAMQ-17 R-TEN-1 tenant isolation', () => {
  it('R-TEAMQ-17 R-TEN-1: another team\'s job cannot decide this team\'s inquiry; another team reads none of the alert rows or notifications; a member who was not alerted reads none either', async () => {
    const other = await leadsWorld(h, { agents: 1, teamLead: true });
    const src = await source('Isolation (alert test)');
    const lead = await arrive(src);
    await minutesPass(lead);
    // the other team's system actor asked to decide OUR inquiry finds no such inquiry and writes nothing
    const foreign = systemActor(other.tenantId, 'timer');
    const r = await withTenantTx(foreign, (tx, now) => decideBackupAlert(tx, h.app.platform.ids, lead.inquiryId, now as Instant, foreign), { db: h.database });
    expect(r.outcome).toBe('no_inquiry');
    expect(await alertRows(lead.inquiryId)).toEqual([]);
    await run();
    expect(await alertRows(lead.inquiryId)).toHaveLength(1);
    const count = (c: TestClient) => withTenantTx(c.actor(), async (tx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM lead_backup_alerts`.execute(tx)).rows[0]!.n, { db: h.database });
    expect(await count(other.owner)).toBe(0);
    expect(await count(other.teamLead!)).toBe(0);
    expect(await count(bystander)).toBe(0);
    expect(await count(backup)).toBeGreaterThan(0);
    expect((await h.su.query(`SELECT 1 FROM notifications WHERE tenant_id = $1 AND dedupe_key LIKE 'backup_alert:%'`, [other.tenantId])).rows).toEqual([]);
    const theirs = await call<{ notifications: { subjectId: string | null }[] }>(other.teamLead!, 'GET', '/notifications');
    expect(theirs.body.notifications.filter((n) => n.subjectId === lead.contactId)).toEqual([]);
  });
});

describe('R-TEAMQ-18 the team work queue and the response report show the backup alert', () => {
  interface QueueRow {
    contact: { id: string };
    why: string;
    backupAlert: { at: string; alerted: boolean; recipient: string | null; line: string } | null;
  }
  interface QueueGroup {
    key: string;
    rows: QueueRow[];
    total: number;
    backupAlerted: number | null;
    othersAlerted: number | null;
  }
  const newLeads = async (c: TestClient): Promise<QueueGroup> => {
    const r = await call<{ groups: QueueGroup[] }>(c, 'GET', '/team/queue');
    if (r.status !== 200) throw new Error(`queue: ${r.status}`);
    return r.body.groups.find((g) => g.key === 'new_lead')!;
  };
  interface Rollup {
    sourceId: string;
    inquiries: number;
    attempted: number;
    backupAlerted: number;
    byBackup: number;
  }
  interface Report {
    totals: Omit<Rollup, 'sourceId'>;
    sources: Rollup[];
    inquiries: { inquiryId: string; backupAlert: { at: string; to: { userId: string; name: string | null }; recipient: string } | null; attempt: { role: string } | null }[];
  }
  const reportOf = async (c: TestClient): Promise<Report> => (await call<Report>(c, 'GET', '/team/lead-response?range=7d')).body;

  it('R-TEAMQ-18 E857 E858: a waiting new lead whose backup was alerted carries a "Backup alerted at …" line naming who; the group counts alerted rows over all its rows; the report counts "backup alerted" over the source\'s inquiries and "by the backup" over those alerted', async () => {
    const src = await source('Queue and report (alert test)');
    // three arrivals: one alerted and still waiting, one alerted and then called by the backup, one answered by its owner in time
    const waiting = await arrive(src);
    await accept(waiting);
    const rescued = await arrive(src);
    await accept(rescued);
    const prompt = await arrive(src);
    const promptOwner = await accept(prompt);
    await humanText(promptOwner, prompt.contactId);
    for (const lead of [waiting, rescued, prompt]) await minutesPass(lead);
    await run();
    expect((await call<{ result: string }>(backup, 'POST', `/contacts/${rescued.contactId}/calls`, {})).body.result).toBe('dialing');

    // the queue (Owner: every lead)
    const g = await newLeads(w.owner);
    const row = g.rows.find((r) => r.contact.id === waiting.contactId)!;
    expect(row.backupAlert).not.toBeNull();
    expect(row.backupAlert!.alerted).toBe(true);
    expect(row.backupAlert!.line).toMatch(/^Backup alerted at \d{1,2}:\d\d [AP]M: \S+ \S\.$/);
    const alertRow = (await alertRows(waiting.inquiryId))[0]!;
    expect(new Date(row.backupAlert!.at).getTime()).toBe(alertRow.decided_at.getTime());
    expect(row.why).toMatch(/Nobody has called, texted or emailed yet\./);
    // the rescued lead left the queue (a person called), the prompt one too: neither is a waiting row
    expect(g.rows.find((r) => r.contact.id === rescued.contactId)).toBeUndefined();
    expect(g.rows.find((r) => r.contact.id === prompt.contactId)).toBeUndefined();
    // every count with its denominator: alerted rows of all waiting rows (other tests' leads are in both numbers)
    // R-TEAMQ-25 (review fix L4): "backup alerted" counts only the alerts that went to the backup; a team lead or the Owners and Admins alerted in their place are counted apart
    const alertedRows = g.rows.filter((r) => r.backupAlert?.alerted === true && r.backupAlert.recipient === 'backup').length;
    expect(g.backupAlerted).toBe(alertedRows);
    expect(g.othersAlerted).toBe(g.rows.filter((r) => r.backupAlert?.alerted === true && r.backupAlert.recipient !== 'backup').length);
    expect(g.backupAlerted!).toBeGreaterThanOrEqual(1);
    expect(g.backupAlerted!).toBeLessThanOrEqual(g.total);
    // the Team Lead sees their team's waiting lead with the same line; an agent has no queue
    expect((await newLeads(w.teamLead!)).rows.find((r) => r.contact.id === waiting.contactId)!.backupAlert!.line).toBe(row.backupAlert!.line);
    expect((await call(backup, 'GET', '/team/queue')).status).toBe(404);

    // the report, for this source: 3 inquiries; backup alerted on 2 of them; the backup made the first attempt on 1 of those 2
    const rep = await reportOf(w.owner);
    const mine = rep.sources.find((s) => s.sourceId === src.id)!;
    expect(mine).toMatchObject({ inquiries: 3, attempted: 2, backupAlerted: 2, byBackup: 1 });
    expect(rep.totals.backupAlerted).toBeGreaterThanOrEqual(2);
    expect(rep.totals.byBackup).toBeLessThanOrEqual(rep.totals.backupAlerted);
    const byId = new Map(rep.inquiries.map((i) => [i.inquiryId, i]));
    expect(byId.get(waiting.inquiryId)).toMatchObject({ attempt: null, backupAlert: { to: { userId: backup.userId }, recipient: 'backup' } });
    expect(byId.get(rescued.inquiryId)).toMatchObject({ attempt: { role: 'backup' }, backupAlert: { to: { userId: backup.userId }, recipient: 'backup' } });
    expect(byId.get(prompt.inquiryId)).toMatchObject({ attempt: { role: 'owner' }, backupAlert: null });
    // no client name, number or message in the alert line, and no id of another team anywhere
    expect(row.backupAlert!.line).not.toMatch(/Rivera|\d{3}[-.\s]\d{4}/);
  });

  it('R-TEAMQ-25 E890 (review fix L4): an alert that went to a TEAM LEAD is never counted or worded as "the backup": the queue counts it apart, the report counts "team lead alerted" and labels the team lead\'s attempt team_lead', async () => {
    const world = (await assistantWorld(h, { agents: 1, teamLead: true })) as CommsWorld;
    await suFixture(h, [{ text: `UPDATE tenant_settings SET routing_hours_start = '00:00', routing_hours_end = '24:00' WHERE tenant_id = $1`, values: [world.tenantId] }]);
    const b = await h.invite(world.owner, 'agent');
    const src = await source('Team lead fallback (alert test)', { world, backupUser: b });
    const lead = await arrive(src);
    await accept(lead, world);
    await freshReauth(h, world.owner);
    const members = await call<{ members: { userId: string; version: number }[] }>(world.owner, 'GET', '/members');
    expect((await call(world.owner, 'PATCH', `/members/${b.userId}`, { status: 'suspended', version: members.body.members.find((m) => m.userId === b.userId)!.version })).status).toBe(200);
    await minutesPass(lead, 4, world.tenantId);
    await run();
    expect((await alertRows(lead.inquiryId)).map((r) => [r.outcome, r.alerted_user_id, r.recipient])).toEqual([['alerted', world.teamLead!.userId, 'team_lead']]);

    // the queue: not "backup alerted"
    const q = await call<{ groups: { key: string; rows: { contact: { id: string }; backupAlert: { alerted: boolean; recipient: string | null; line: string } | null }[]; total: number; backupAlerted: number | null; othersAlerted: number | null }[] }>(world.owner, 'GET', '/team/queue');
    const g = q.body.groups.find((x) => x.key === 'new_lead')!;
    expect(g.rows.find((r) => r.contact.id === lead.contactId)!.backupAlert).toMatchObject({ alerted: true, recipient: 'team_lead', line: expect.stringMatching(/the team lead, .+, was alerted at/) });
    expect([g.backupAlerted, g.othersAlerted, g.total]).toEqual([0, 1, 1]);

    // the team lead then texts: their attempt is the team lead's, and the report's "backup" counts stay at zero
    await humanText(world.teamLead!, lead.contactId);
    interface Rep {
      sources: { sourceId: string; inquiries: number; attempted: number; backupAlerted: number; byBackup: number; teamLeadAlerted: number; byTeamLead: number; adminsAlerted: number }[];
      inquiries: { inquiryId: string; attempt: { role: string; by: { userId: string } | null } | null; backupAlert: { recipient: string } | null }[];
    }
    const rep = (await call<Rep>(world.owner, 'GET', '/team/lead-response?range=7d')).body;
    expect(rep.inquiries.find((i) => i.inquiryId === lead.inquiryId)).toMatchObject({ attempt: { role: 'team_lead', by: { userId: world.teamLead!.userId } }, backupAlert: { recipient: 'team_lead' } });
    expect(rep.sources.find((x) => x.sourceId === src.id)).toMatchObject({ inquiries: 1, attempted: 1, backupAlerted: 0, byBackup: 0, teamLeadAlerted: 1, byTeamLead: 1, adminsAlerted: 0 });
  });

  it('R-TEAMQ-18 R-TEN-1: another team\'s queue and report never show this team\'s alerts', async () => {
    const other = await leadsWorld(h, { agents: 1, teamLead: true });
    const g = await newLeads(other.owner);
    expect(g.rows).toEqual([]);
    expect(g.backupAlerted).toBe(0);
    const rep = await reportOf(other.owner);
    expect(rep.totals).toMatchObject({ inquiries: 0, backupAlerted: 0, byBackup: 0 });
  });
});
