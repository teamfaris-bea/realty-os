// The team work queue over real Postgres, through the real server as each role (b19 team-queue lane; DATA_MODEL
// R-TEAMQ-1..6, E820..E826). Every lead comes in through the real intake, every attempt through the real send and
// dial paths, the automatic reply from the real first-response job; the superuser pool only reads state back, moves
// clocks, and writes the few rows with no application path here (a past-due task, an unassigned state).
// Invented people and sources only.
import { randomUUID } from 'node:crypto';
import { type Role, can } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvedPlaybook, assistantWorld, grantConsent, inboundSms, ownedContact, randomEmail, randomPhone, runJobs } from '../assistant/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { freshReauth } from '../admin/testing.js';
import { marketingReady } from '../bulk/testing.js';
import { importedUnassigned, leadsWorld, postIntake } from '../leads/testing.js';
import { type AccWorld, acceptedLead, call, command, contactState, endedAppointment, intake, promiseTask, sendText, suFixture } from './testing.js';

let h: ApiHarness;
let w: AccWorld;
let outsider: TestClient;
let admin: TestClient;
let isa: TestClient;
let tc: TestClient;
const FR = ['assistant.first_response', 'comms.dispatch'];

interface RowT {
  key: string;
  contact: { id: string; name: string };
  source: string | null;
  owner: { kind: 'owner' | 'on_offer' | 'pond' | 'unassigned'; userId: string | null; name: string | null; pondId: string | null; label: string };
  why: string;
  since: string;
  waitingSeconds: number;
  staffedSeconds: number | null;
  offHours: boolean;
}
interface GroupT {
  key: string;
  label: string;
  empty: string;
  rows: RowT[];
  total: number;
  more: number;
  atLeast: boolean;
}
interface QueueT {
  groups: GroupT[];
  staffedHours: { open: string; close: string; zone: string };
  windows: { newLeadDays: number; replyDays: number; taskDays: number; appointmentDays: number };
  generatedAt: string;
}

async function queue(c: TestClient): Promise<QueueT> {
  const r = await call<QueueT>(c, 'GET', '/team/queue');
  if (r.status !== 200) throw new Error(`team queue: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const groupOf = (q: QueueT, key: string) => q.groups.find((g) => g.key === key)!;
const rowOf = async (c: TestClient, key: string, contactId: string) => groupOf(await queue(c), key).rows.find((r) => r.contact.id === contactId);
const nameOf = async (userId: string) => (await h.su.query<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [userId])).rows[0]!.display_name;
const agentOf = (userId: string) => [...w.agents, w.teamLead!, outsider].find((a) => a.userId === userId)!;

/** A lead on offer to one of the two team agents (nobody accepted it). */
async function offeredLead(body: Record<string, unknown> = {}) {
  const res = await intake(h, w, body);
  const st = await contactState(h, res.contactId);
  if (st.ownership_state !== 'offered') throw new Error(`lead not on offer: ${st.ownership_state}`);
  return { contactId: res.contactId, offeredTo: st.offered_to_user_id! };
}

/** A lead a team agent accepted and released to the default pond without contacting. */
async function pondLead() {
  const lead = await acceptedLead(h, w);
  const r = await command(lead.owner, lead.contactId, 'release', { reason: 'not_a_fit' });
  if (r.status !== 200) throw new Error(`release: ${r.status} ${JSON.stringify(r.body)}`);
  if ((await contactState(h, lead.contactId)).ownership_state !== 'in_pond') throw new Error('lead not in a pond');
  return lead.contactId;
}

/** A lead a team agent accepted, handed by the Owner to the agent outside the Team Lead's team. */
async function outsiderLead() {
  const lead = await acceptedLead(h, w);
  const r = await command(w.owner, lead.contactId, 'reassign', { toUserId: outsider.userId });
  if (r.status !== 200) throw new Error(`reassign: ${r.status} ${JSON.stringify(r.body)}`);
  return lead.contactId;
}

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  const base = await assistantWorld(h, { agents: 2, teamLead: true, others: ['admin', 'isa', 'tc'] });
  [admin, isa, tc] = base.others as [TestClient, TestClient, TestClient];
  // an agent NOT on the Team Lead's team
  outsider = await h.invite(base.owner, 'agent');
  w = { ...base, outsider };
  await approvedPlaybook(w.owner, { templateKey: 'new_lead_response' });
  // a verified sending domain and a postal address, so a person's own email passes the gate
  await marketingReady(h, w);
  // the two agents take every lead of this file, none contacted (the default cap of 5 would send later ones to the pond)
  const s = await call<{ settings: { version: number } }>(w.owner, 'GET', '/settings');
  const cap = await call(w.owner, 'PATCH', '/settings', { version: s.body.settings.version, uncontactedCapacityCap: 50 });
  if (cap.status !== 200) throw new Error(`settings: ${cap.status} ${JSON.stringify(cap.body)}`);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('R-TEAMQ-1 the queue', () => {
  it('R-TEAMQ-1: five groups in one order, each with its label, its honest empty line, the staffed hours and the look-back windows', async () => {
    const q = await queue(w.owner);
    expect(q.groups.map((g) => g.key)).toEqual(['new_lead', 'unanswered_reply', 'due_promise', 'overdue_follow_up', 'appointment_outcome']);
    expect(groupOf(q, 'new_lead').empty).toBe('Nobody is waiting on a first call.');
    for (const g of q.groups) expect(g.more).toBe(g.total - g.rows.length);
    expect(q.staffedHours).toEqual({ open: '08:00', close: '21:00', zone: expect.any(String) });
    expect(q.windows).toEqual({ newLeadDays: 14, replyDays: 14, taskDays: 90, appointmentDays: 30 });
  });

  it('R-TEAMQ-1 the queue only reads: no job, notification, message, ledger event or audit row is written by reading it', async () => {
    await offeredLead();
    const counts = async () =>
      (await h.su.query(
        `SELECT (SELECT count(*)::int FROM jobs WHERE tenant_id = $1) AS jobs, (SELECT count(*)::int FROM notifications WHERE tenant_id = $1) AS notifications,
                (SELECT count(*)::int FROM messages WHERE tenant_id = $1) AS messages, (SELECT count(*)::int FROM lead_ownership_events WHERE tenant_id = $1) AS ledger,
                (SELECT count(*)::int FROM audit_log WHERE tenant_id = $1) AS audit, (SELECT count(*)::int FROM priority_feed_items WHERE tenant_id = $1) AS feed`,
        [w.tenantId],
      )).rows[0];
    const before = await counts();
    for (const c of [w.owner, admin, w.teamLead!]) await queue(c);
    expect(await counts()).toEqual(before);
  });
});

describe('R-TEAMQ-2 a new lead with no human attempt', () => {
  it('R-TEAMQ-2 E820: a lead on offer, an owned lead, a pond lead and an unassigned lead each appear with their reason, their source and who has them', async () => {
    const offered = await offeredLead();
    const owned = await acceptedLead(h, w);
    const pond = await pondLead();
    const unassigned = await offeredLead();
    // fixture: the state a lead is in while it waits for the router (no application path leaves it there on demand)
    await suFixture(h, [{ text: `UPDATE contacts SET ownership_state = 'unassigned', offer_id = NULL, offered_to_user_id = NULL, offer_expires_at = NULL WHERE id = $1`, values: [unassigned.contactId] }]);

    const g = groupOf(await queue(w.owner), 'new_lead');
    const row = (id: string) => g.rows.find((r) => r.contact.id === id)!;
    const offeree = await nameOf(offered.offeredTo);
    expect(row(offered.contactId)).toMatchObject({ contact: { name: 'Pat Lead' }, source: 'Portal', owner: { kind: 'on_offer', userId: offered.offeredTo, name: offeree, label: `No owner yet: on offer to ${offeree}` } });
    expect(row(offered.contactId).why).toBe(`Arrived less than a minute ago from Portal. On offer to ${offeree}. Nobody has called, texted or emailed yet. No automatic reply has gone out.`);
    const ownerName = await nameOf(owned.owner.userId!);
    expect(row(owned.contactId)).toMatchObject({ owner: { kind: 'owner', userId: owned.owner.userId, label: ownerName } });
    expect(row(owned.contactId).why).toContain(`Owned by ${ownerName}.`);
    const pondName = (await h.su.query<{ name: string }>('SELECT name FROM ponds WHERE id = $1', [w.defaultPondId])).rows[0]!.name;
    expect(row(pond)).toMatchObject({ owner: { kind: 'pond', userId: null, pondId: w.defaultPondId, label: `No owner yet: in the pond ${pondName}` } });
    expect(row(pond).why).toContain(`In the pond ${pondName}.`);
    expect(row(unassigned.contactId)).toMatchObject({ owner: { kind: 'unassigned', userId: null, label: 'No owner yet: not assigned to anyone' } });
    expect(row(unassigned.contactId).why).toContain('Not assigned to anyone.');
    for (const id of [offered.contactId, owned.contactId, pond, unassigned.contactId]) {
      expect(row(id).waitingSeconds).toBeGreaterThanOrEqual(0);
      expect(row(id).staffedSeconds).toBeLessThanOrEqual(row(id).waitingSeconds);
    }
  });

  it('R-TEAMQ-2 E823: the wait is counted from ARRIVAL, not from when an agent accepted', async () => {
    const lead = await acceptedLead(h, w);
    // clock fixture: the inquiry arrived (was claimed, and reached the team: R-TEAMQ-19) 3 hours ago; the agent accepted just now
    await h.su.query(`UPDATE lead_inquiries SET received_at = now() - interval '3 hours', created_at = now() - interval '3 hours' WHERE contact_id = $1`, [lead.contactId]);
    const row = (await rowOf(w.owner, 'new_lead', lead.contactId))!;
    expect(row.waitingSeconds).toBeGreaterThanOrEqual(3 * 3600);
    expect(row.waitingSeconds).toBeLessThan(3 * 3600 + 120);
    expect(row.why).toMatch(/^Arrived 3 h ago from Portal/);
    const owned = (await h.su.query<{ owned_at: Date }>('SELECT owned_at FROM contacts WHERE id = $1', [lead.contactId])).rows[0]!.owned_at;
    expect(new Date(row.since).getTime()).toBeLessThan(owned.getTime() - 2 * 3600_000);
  });

  it('R-TEAMQ-2 E821: an automated first reply never clears it; a human text does', async () => {
    const lead = await acceptedLead(h, w);
    await runJobs(h, w.tenantId, FR);
    const auto = (await h.su.query<{ initiator: string; status: string }>(`SELECT initiator, status FROM messages WHERE contact_id = $1 AND direction = 'outbound'`, [lead.contactId])).rows;
    expect(auto).toEqual([{ initiator: 'assistant', status: 'sent' }]);
    const waiting = (await rowOf(w.teamLead!, 'new_lead', lead.contactId))!;
    expect(waiting.why).toMatch(/Nobody has called, texted or emailed yet\. An automatic reply went out (at \d{1,2}:\d\d [AP]M|.* ago)\.$/);

    await grantConsent(lead.owner, lead.contactId, 'sms');
    expect((await sendText(lead.owner, lead.contactId, 'Hi, this is your agent. When is a good time to talk?')).body.result).toBe('sent');
    expect(await rowOf(w.teamLead!, 'new_lead', lead.contactId)).toBeUndefined();
  });

  it('R-TEAMQ-2 E821: a human call clears it, and so does a human email', async () => {
    const called = await acceptedLead(h, w);
    expect(await rowOf(w.owner, 'new_lead', called.contactId)).toBeDefined();
    // a call: the agent's verified alert phone is the bridge
    const ch = await called.owner.post('/api/me/alert-phone', { phone: randomPhone() });
    const code = h.providers.telephony.verificationCodes.at(-1)!.code;
    expect((await called.owner.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code })).statusCode).toBe(200);
    const dial = await call<{ result: string }>(called.owner, 'POST', `/contacts/${called.contactId}/calls`, {});
    expect([dial.status, dial.body.result]).toEqual([200, 'dialing']);
    expect(await rowOf(w.owner, 'new_lead', called.contactId)).toBeUndefined();

    const emailed = await acceptedLead(h, w, { emails: [randomEmail()] });
    expect(await rowOf(w.owner, 'new_lead', emailed.contactId)).toBeDefined();
    await grantConsent(emailed.owner, emailed.contactId, 'email');
    const mail = await call<{ result: string }>(emailed.owner, 'POST', `/contacts/${emailed.contactId}/messages`, { channel: 'email', subject: 'Your question', body: 'Happy to help. When can we talk?', idempotencyKey: `e-${randomUUID()}` });
    expect(mail.body.result).toBe('sent');
    expect(await rowOf(w.owner, 'new_lead', emailed.contactId)).toBeUndefined();
  });

  it('R-TEAMQ-2 E821: an attempt by someone who is not the owner clears it too (the question is whether anybody tried)', async () => {
    const lead = await acceptedLead(h, w);
    await grantConsent(w.owner, lead.contactId, 'sms');
    expect((await sendText(w.owner, lead.contactId, 'Hello from the team. Someone will call you shortly.')).body.result).toBe('sent');
    expect(await rowOf(w.owner, 'new_lead', lead.contactId)).toBeUndefined();
  });

  it('R-TEAMQ-2 R-IMPORT-6 E820: an imported person and a person a member typed in are not inquiries and never appear', async () => {
    const imported = await importedUnassigned(h, w.tenantId, { firstName: 'Ines', lastName: 'Imported', phones: [randomPhone()] });
    const typed = await ownedContact(w.agents[0]!, { firstName: 'Tess' });
    const q = await queue(w.owner);
    const everyone = q.groups.flatMap((g) => g.rows.map((r) => r.contact.id));
    expect(everyone).not.toContain(imported);
    expect(everyone).not.toContain(typed.id);
    expect((await h.su.query('SELECT 1 FROM lead_inquiries WHERE contact_id = ANY ($1::uuid[])', [[imported, typed.id]])).rows).toEqual([]);
  });

  it('R-TEAMQ-2: a person from a "No automated contact" source still appears (the queue is about human work)', async () => {
    await freshReauth(h, w.owner);
    const src = await call<{ source: { id: string }; ingestToken: string }>(w.owner, 'POST', '/lead-sources', { name: 'Harbor referral desk (test)', kind: 'referral' });
    expect(src.status).toBe(201);
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'PUT', `/lead-sources/${src.body.source.id}/ai-care`, { noAiCare: true })).status).toBe(200);
    const r = await postIntake(h, src.body.ingestToken, { inquiryType: 'sell', fullName: 'Nora Quiet', phones: [randomPhone()] });
    expect(r.statusCode).toBe(201);
    const id = (r.json() as { contactId: string }).contactId;
    await runJobs(h, w.tenantId, FR);
    expect((await h.su.query(`SELECT 1 FROM messages WHERE contact_id = $1 AND direction = 'outbound'`, [id])).rows).toEqual([]);
    const row = (await rowOf(w.owner, 'new_lead', id))!;
    expect(row.source).toBe('Harbor referral desk (test)');
    expect(row.why).toMatch(/^Arrived .* from Harbor referral desk \(test\)\. .* Nobody has called, texted or emailed yet\. No automatic reply has gone out\.$/);
  });
});

describe('R-TEAMQ-3 an unanswered reply', () => {
  it('R-TEAMQ-3 E824: a text nobody answered is listed with its owner; a person’s reply clears it', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { firstName: 'Rhea' });
    expect((await inboundSms(h, c.phone, w.mainNumber, 'Is the open house still on for Sunday?')).statusCode).toBe(200);
    const row = (await rowOf(w.teamLead!, 'unanswered_reply', c.id))!;
    const name = await nameOf(agent.userId!);
    expect(row).toMatchObject({ contact: { name: 'Rhea Doe' }, owner: { kind: 'owner', userId: agent.userId, label: name }, staffedSeconds: null });
    expect(row.why).toBe(`They texted less than a minute ago; no answer from a person yet. Owned by ${name}.`);
    // typed in by the agent: never a "new lead"
    expect(await rowOf(w.teamLead!, 'new_lead', c.id)).toBeUndefined();

    expect((await sendText(agent, c.id, 'Yes, 1 to 3 PM. See you there.')).body.result).toBe('sent');
    expect(await rowOf(w.teamLead!, 'unanswered_reply', c.id)).toBeUndefined();
  });
});

describe('R-TEAMQ-4 promises and follow-ups past due', () => {
  it('R-TEAMQ-4 E825: a promise past its deadline and a follow-up past its deadline are listed with whom they are on; one not yet due and one an import created are not', async () => {
    const lead = await acceptedLead(h, w);
    const agent = lead.owner;
    const name = await nameOf(agent.userId!);
    const due = await promiseTask(h, w.tenantId, lead.contactId, agent.userId!, { dueInMs: -3 * 3600_000 });
    const later = await promiseTask(h, w.tenantId, lead.contactId, agent.userId!, { dueInMs: 3600_000 });
    const imported = await promiseTask(h, w.tenantId, lead.contactId, agent.userId!, { dueInMs: -3600_000, createdByKind: 'import' });
    const followUp = randomUUID();
    await h.su.query(
      `INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, due_at, created_by_kind, created_by_user_id)
       VALUES ($1, $2, $3, $4, 'follow_up', 'Check in about financing', now() - interval '26 hours', 'user', $3)`,
      [w.tenantId, followUp, agent.userId, lead.contactId],
    );
    const q = await queue(w.teamLead!);
    const promises = groupOf(q, 'due_promise').rows.filter((r) => r.contact.id === lead.contactId);
    expect(promises.map((r) => r.key)).toEqual([`task:${due.taskId}`]);
    expect(promises[0]).toMatchObject({ owner: { kind: 'owner', userId: agent.userId, label: name }, why: `Promise “Send the comps” was due 3 h ago. ${name} made it.` });
    const followUps = groupOf(q, 'overdue_follow_up').rows.filter((r) => r.contact.id === lead.contactId);
    expect(followUps.map((r) => [r.key, r.why])).toEqual([[`task:${followUp}`, `Follow-up “Check in about financing” was due 26 h ago. Assigned to ${name}.`]]);
    const keys = q.groups.flatMap((g) => g.rows.map((r) => r.key));
    expect(keys).not.toContain(`task:${later.taskId}`);
    expect(keys).not.toContain(`task:${imported.taskId}`);
  });
});

describe('R-TEAMQ-5 an appointment needing an outcome', () => {
  it('R-TEAMQ-5: it is listed as soon as it has ended (the exception list waits two hours); one still to come is not', async () => {
    const lead = await acceptedLead(h, w);
    const ended = await endedAppointment(h, lead.owner, lead.contactId, 60_000);
    const upcoming = await call<{ appointment: { id: string } }>(lead.owner, 'POST', '/appointments', { kind: 'consult', startsAt: new Date(Date.now() + 3_600_000).toISOString(), endsAt: new Date(Date.now() + 7_200_000).toISOString(), contactId: lead.contactId });
    expect(upcoming.status).toBe(201);
    const g = groupOf(await queue(w.teamLead!), 'appointment_outcome');
    const name = await nameOf(lead.owner.userId!);
    const mine = g.rows.filter((r) => r.contact.id === lead.contactId);
    expect(mine.map((r) => r.key)).toEqual([`appt:${ended}`]);
    expect(mine[0]!.why).toBe(`Buyer consult ended 1 min ago with no outcome logged. It is ${name}’s appointment.`);
    expect(mine[0]!.owner).toMatchObject({ kind: 'owner', userId: lead.owner.userId });
    // the existing exception list has nothing for it yet (missing_outcome needs two hours)
    expect((await h.su.query(`SELECT 1 FROM exception_items WHERE dedupe_key = $1`, [`appt:${ended}`])).rows).toEqual([]);
  });
});

describe('R-TEAMQ-6 who may read it, and whose rows', () => {
  it('R-TEAMQ-6 R-PERM-1 R-PERM-5: each role’s HTTP outcome equals core.can(): Owner, Admin and Team Lead read it; an Agent, an ISA and a TC get 404', async () => {
    const users: Record<Role, TestClient> = { owner: w.owner, admin, team_lead: w.teamLead!, agent: w.agents[0]!, isa, tc };
    const got: string[] = [];
    for (const role of Object.keys(users) as Role[]) {
      const want = can(users[role].actor(), 'team_queue.view', { team: true }).ok;
      const res = await call(users[role], 'GET', '/team/queue');
      expect({ role, ok: res.status === 200 }).toEqual({ role, ok: want });
      if (!want) expect([res.status, res.code]).toEqual([404, 'NOT_FOUND']);
      got.push(`${role} ${res.status}`);
    }
    expect(got).toEqual(['owner 200', 'admin 200', 'team_lead 200', 'agent 404', 'isa 404', 'tc 404']);
    expect((await h.client().request('GET', '/api/team/queue')).statusCode).toBe(401);
    expect((await call(w.owner, 'GET', `/team/queue?tenant_id=${w.tenantId}`)).status).toBe(422);
  });

  it('R-TEAMQ-6: a Team Lead sees their team’s rows and pond leads; a lead, a promise and an appointment of an agent outside their team, and an unassigned lead, are the Owner’s and Admin’s to see', async () => {
    const mine = await acceptedLead(h, w);
    const theirs = await outsiderLead();
    const promise = await promiseTask(h, w.tenantId, theirs, outsider.userId!, { dueInMs: -3600_000 });
    const appt = await endedAppointment(h, outsider, theirs, 60_000);
    const pond = await pondLead();
    const unassigned = await offeredLead();
    await suFixture(h, [{ text: `UPDATE contacts SET ownership_state = 'unassigned', offer_id = NULL, offered_to_user_id = NULL, offer_expires_at = NULL WHERE id = $1`, values: [unassigned.contactId] }]);

    const idsOf = (q: QueueT) => new Set(q.groups.flatMap((g) => g.rows.map((r) => r.contact.id)));
    const keysOf = (q: QueueT) => q.groups.flatMap((g) => g.rows.map((r) => r.key));
    for (const boss of [w.owner, admin]) {
      const q = await queue(boss);
      for (const id of [mine.contactId, theirs, pond, unassigned.contactId]) expect(idsOf(q).has(id)).toBe(true);
      expect(keysOf(q)).toEqual(expect.arrayContaining([`task:${promise.taskId}`, `appt:${appt}`]));
    }
    const tl = await queue(w.teamLead!);
    expect(idsOf(tl).has(mine.contactId)).toBe(true);
    expect(idsOf(tl).has(pond)).toBe(true);
    expect(idsOf(tl).has(theirs)).toBe(false);
    expect(idsOf(tl).has(unassigned.contactId)).toBe(false);
    expect(keysOf(tl)).not.toContain(`task:${promise.taskId}`);
    expect(keysOf(tl)).not.toContain(`appt:${appt}`);
    // every row a Team Lead gets is of a person their own RLS shows them
    const visible = new Set((await call<{ contact: { id: string } }>(w.teamLead!, 'GET', `/contacts/${mine.contactId}`)).status === 200 ? [mine.contactId] : []);
    expect(visible.has(mine.contactId)).toBe(true);
    expect((await call(w.teamLead!, 'GET', `/contacts/${theirs}`)).status).toBe(404);
    expect(agentOf(outsider.userId!)).toBe(outsider);
  });

  it('R-TEAMQ-6 R-TEN-3: another tenant’s rows never appear', async () => {
    const other = await leadsWorld(h, { agents: 1 });
    const theirs = (await intake(h, other)).contactId;
    const ours = (await offeredLead()).contactId;
    const mineIds = (await queue(w.owner)).groups.flatMap((g) => g.rows.map((r) => r.contact.id));
    expect(mineIds).toContain(ours);
    expect(mineIds).not.toContain(theirs);
    const otherIds = (await queue(other.owner)).groups.flatMap((g) => g.rows.map((r) => r.contact.id));
    expect(otherIds).toEqual([theirs]);
  });
});
