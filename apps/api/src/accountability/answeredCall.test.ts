// A person ANSWERED the lead's own call (b19 team-queue lane, review fix M4; DATA_MODEL R-TEAMQ-22, E882 to E884),
// end to end over real Postgres: the call comes in through the real telephony webhooks (the fake provider's
// signature), rings the agent, and a person presses 1. The queue and the report must say so: never "nobody has
// called, texted or emailed yet", never a human attempt. The call that itself creates a call-in inquiry (a tracked
// number) starts a moment BEFORE the inquiry reaches the team: it is matched by the inquiry's own reference.
// The superuser pool only reads state back and moves clocks. Invented people, sources and numbers only.
import type { Instant } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, freshReauth, randomPhone, sid, telephonyWebhook } from '../comms/testing.js';
import { BACKUP_ALERT_JOB, decideBackupAlert } from '../leads/backupAlert.js';
import { command, contactState, leadsWorker, postIntake, suFixture } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';

let h: ApiHarness;
let w: CommsWorld;
let backup: TestClient;
let yard: { id: string; token: string };
let tracking: { id: string; e164: string };
let web: { id: string; token: string };
let agentPhone: string;

/** The path + query of an absolute callback URL found in TwiML (attribute values are XML-escaped). */
function hookPath(twiml: string, attr: string): string {
  const m = new RegExp(`${attr}="([^"]+)"`).exec(twiml);
  if (!m) throw new Error(`no ${attr} in ${twiml}`);
  const u = new URL(m[1]!.replace(/&amp;/g, '&'));
  return u.pathname.replace(/^\/api/, '') + u.search;
}
const ring = (from: string, to: string, callSid: string) => telephonyWebhook(h, '/webhooks/telephony/voice', { CallSid: callSid, From: from, To: to, CallStatus: 'ringing', Direction: 'inbound' });
/** The lead calls `to`; the agent's phone rings, they hear the whisper and press 1: a person answered. */
async function calledAndAnswered(from: string, to: string): Promise<string> {
  const callSid = sid('CA');
  const first = await ring(from, to, callSid);
  if (first.statusCode !== 200 || !first.body.includes('<Dial')) throw new Error(`the call did not ring anyone: ${first.statusCode} ${first.body}`);
  const child = sid('CA');
  const screen = await telephonyWebhook(h, hookPath(first.body, 'url'), { CallSid: child, ParentCallSid: callSid, From: to, To: agentPhone, CallStatus: 'in-progress', Direction: 'outbound-dial' });
  const accept = await telephonyWebhook(h, hookPath(screen.body, 'action'), { CallSid: child, ParentCallSid: callSid, Digits: '1' });
  if (accept.body.includes('Hangup')) throw new Error(`not bridged: ${accept.body}`);
  return callSid;
}
const callRow = async (callSid: string) => (await h.su.query<{ contact_id: string; status: string; handled_by: string; answered_at: Date | null; started_at: Date; agent_user_id: string | null }>('SELECT contact_id, status, handled_by, answered_at, started_at, agent_user_id FROM calls WHERE provider_call_ref = $1', [callSid])).rows[0]!;
const inquiriesOf = async (contactId: string) => (await h.su.query<{ id: string; external_id: string | null; created_at: Date }>('SELECT id, external_id, created_at FROM lead_inquiries WHERE contact_id = $1 ORDER BY created_at', [contactId])).rows;

interface QueueRow {
  contact: { id: string };
  why: string;
  answeredCallAt: string | null;
}
interface QueueGroup {
  key: string;
  label: string;
  rows: QueueRow[];
  total: number;
  answeredCalls: number | null;
}
const newLeads = async (c: TestClient): Promise<QueueGroup> => {
  const r = await call<{ groups: QueueGroup[] }>(c, 'GET', '/team/queue');
  if (r.status !== 200) throw new Error(`queue: ${r.status}`);
  return r.body.groups.find((g) => g.key === 'new_lead')!;
};
interface ReportInquiry {
  inquiryId: string;
  state: string;
  attempt: { kind: string; by: { userId: string } | null; role: string } | null;
  answeredCall: { at: string; by: { userId: string; name: string | null } | null; wallSeconds: number } | null;
  waiting: { wallSeconds: number } | null;
  within5: boolean;
}
interface Rollup {
  sourceId: string;
  inquiries: number;
  attempted: number;
  answeredCalls: number;
  waiting: number;
  within5: number;
}
const report = async (c: TestClient) => (await call<{ inquiries: ReportInquiry[]; sources: Rollup[]; totals: Omit<Rollup, 'sourceId'> }>(c, 'GET', '/team/lead-response?range=7d')).body;
const alertRows = async (inquiryId: string) => (await h.su.query<{ outcome: string; alerted_user_id: string | null }>('SELECT outcome, alerted_user_id FROM lead_backup_alerts WHERE inquiry_id = $1', [inquiryId])).rows;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  // the catch-all rule rings its next member with a verified phone for a call nobody owns yet; both agents have one
  w = await commsWorld(h, { agents: 2 });
  backup = await h.invite(w.owner, 'agent');
  await suFixture(h, [{ text: `UPDATE tenant_settings SET routing_hours_start = '00:00', routing_hours_end = '24:00' WHERE tenant_id = $1`, values: [w.tenantId] }]);
  agentPhone = randomPhone();
  for (const agent of w.agents) {
    const ch = await agent.post('/api/me/alert-phone', { phone: agent === w.agents[0] ? agentPhone : randomPhone() });
    const code = h.providers.telephony.verificationCodes.at(-1)!.code;
    const v = await agent.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code });
    if (v.statusCode !== 200) throw new Error(`alert phone: ${v.statusCode} ${v.body}`);
  }
  await freshReauth(h, w.owner);
  const mk = async (name: string, kind: string) => {
    const s = await call<{ source: { id: string }; ingestToken: string }>(w.owner, 'POST', '/lead-sources', { name, kind });
    if (s.status !== 201) throw new Error(`lead source: ${s.status} ${JSON.stringify(s.body)}`);
    // covered, with a backup outside the rotation: the minute-three job is queued for its inquiries
    const cov = await call(w.owner, 'PUT', `/lead-sources/${s.body.source.id}/coverage`, { ownerUserId: w.agents[0]!.userId, backupUserId: backup.userId, highIntent: false, covered: true });
    if (cov.status !== 200) throw new Error(`coverage: ${cov.status} ${JSON.stringify(cov.body)}`);
    return { id: s.body.source.id, token: s.body.ingestToken };
  };
  yard = await mk('Yard sign calls (answered test)', 'sign_call');
  web = await mk('Website form (answered test)', 'website');
  const n = await call<{ number: { id: string; e164: string } }>(w.owner, 'POST', '/numbers', { purpose: 'tracking', areaCode: '415', leadSourceId: yard.id });
  if (n.status !== 201) throw new Error(`number: ${n.status} ${JSON.stringify(n.body)}`);
  tracking = n.body.number;
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('R-TEAMQ-22 a person answered the lead\'s own call (review fix M4)', () => {
  it('R-TEAMQ-22 E882 E883 E884: a new caller on a tracked number whose call a person answers: the inquiry\'s OWN call counts (it started before the inquiry reached the team): the queue says a person answered, the report shows "answered call" (not an attempt, not waiting), and the backup is not alerted', async () => {
    const from = randomPhone();
    const callSid = await calledAndAnswered(from, tracking.e164);
    const k = await callRow(callSid);
    expect(k).toMatchObject({ status: 'in_progress', handled_by: 'human' });
    expect(w.agents.map((a) => a.userId)).toContain(k.agent_user_id);
    expect(k.answered_at).not.toBeNull();
    const [inq] = await inquiriesOf(k.contact_id);
    expect(inq!.external_id).toBe(`tracking:call:${callSid}`);
    // the premise, made certain (clock fixture): the call that IS the inquiry started ringing two seconds BEFORE the
    // inquiry row was written (as stored, the two are within a millisecond or two of each other, either way round)
    expect(Math.abs(k.started_at.getTime() - inq!.created_at.getTime())).toBeLessThan(2_000);
    await h.su.query(`UPDATE calls SET started_at = $2::timestamptz - interval '2 seconds' WHERE provider_call_ref = $1`, [callSid, inq!.created_at]);

    for (const who of [w.owner, w.teamLead].filter((c): c is TestClient => c !== null && c !== undefined)) {
      const g = await newLeads(who);
      const row = g.rows.find((r) => r.contact.id === k.contact_id)!;
      expect(row).toBeDefined();
      expect(row.why).toMatch(/A person answered their call at \d{1,2}:\d\d [AP]M\. Nobody has called back, texted or emailed since\.$/);
      expect(row.why).not.toMatch(/Nobody has called, texted or emailed yet/);
      expect(new Date(row.answeredCallAt!).getTime()).toBe(k.answered_at!.getTime());
      expect(g.label).toBe('New leads nobody has called, texted or emailed yet');
      expect(g.answeredCalls).toBeGreaterThanOrEqual(1);
      expect(g.answeredCalls!).toBeLessThanOrEqual(g.total);
    }
    const rep = await report(w.owner);
    const line = rep.inquiries.find((i) => i.inquiryId === inq!.id)!;
    expect(line).toMatchObject({ state: 'answered_call', attempt: null, waiting: null, within5: false, answeredCall: { by: { userId: k.agent_user_id } } });
    expect(rep.sources.find((s) => s.sourceId === yard.id)).toMatchObject({ inquiries: 1, attempted: 0, answeredCalls: 1, waiting: 0, within5: 0 });

    // minute three: a person has spoken with them, so nobody is alerted, and the row says which
    await h.su.query(`UPDATE lead_inquiries SET received_at = received_at - interval '4 minutes', created_at = created_at - interval '4 minutes' WHERE id = $1`, [inq!.id]);
    await h.su.query(`UPDATE calls SET started_at = started_at - interval '4 minutes', answered_at = answered_at - interval '4 minutes' WHERE provider_call_ref = $1`, [callSid]);
    await h.su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND kind = $2 AND status = 'pending' AND payload->>'inquiryId' = $3`, [w.tenantId, BACKUP_ALERT_JOB.kind, inq!.id]);
    await leadsWorker(h).drain();
    expect(await alertRows(inq!.id)).toEqual([{ outcome: 'answered_call', alerted_user_id: null }]);
  });

  it('R-TEAMQ-22 E882: a web lead who then calls the team and is answered: the same true words; the agent\'s call back is the human attempt that takes it out of the queue, and the report keeps both facts', async () => {
    const phone = randomPhone();
    const r = await postIntake(h, web.token, { inquiryType: 'buy', fullName: 'Dana Rivera', phones: [phone] });
    expect(r.statusCode).toBe(201);
    const lead = r.json() as { contactId: string; inquiryId: string };
    const st = await contactState(h, lead.contactId);
    const agent = w.agents.find((a) => a.userId === st.offered_to_user_id)!;
    expect(agent).toBeDefined();
    expect((await command(agent, lead.contactId, 'accept', { offerId: st.offer_id })).status).toBe(200);
    // before any call: the plain words
    expect((await newLeads(w.owner)).rows.find((x) => x.contact.id === lead.contactId)!.why).toMatch(/Nobody has called, texted or emailed yet\./);
    const callSid = await calledAndAnswered(phone, w.mainNumber);
    expect((await callRow(callSid)).contact_id).toBe(lead.contactId);
    const row = (await newLeads(w.owner)).rows.find((x) => x.contact.id === lead.contactId)!;
    expect(row.why).toMatch(/^Arrived .* from Website form \(answered test\)\. Owned by .+ A person answered their call at \d{1,2}:\d\d [AP]M\. Nobody has called back, texted or emailed since\.$/);
    expect((await report(w.owner)).inquiries.find((i) => i.inquiryId === lead.inquiryId)).toMatchObject({ state: 'answered_call', attempt: null, waiting: null });
    // the decision at minute three, asked directly four minutes on: answered, nobody alerted
    const actor = systemActor(w.tenantId, 'timer');
    const decided = await withTenantTx(actor, (tx, now) => decideBackupAlert(tx, h.app.platform.ids, lead.inquiryId, (now + 4 * 60_000) as Instant, actor), { db: h.database });
    expect(decided).toMatchObject({ outcome: 'answered_call' });

    // the agent calls back: a human attempt
    const dial = await call<{ result: string }>(agent, 'POST', `/contacts/${lead.contactId}/calls`, {});
    expect([dial.status, dial.body.result]).toEqual([200, 'dialing']);
    expect((await newLeads(w.owner)).rows.find((x) => x.contact.id === lead.contactId)).toBeUndefined();
    const after = (await report(w.owner)).inquiries.find((i) => i.inquiryId === lead.inquiryId)!;
    expect(after).toMatchObject({ state: 'attempted', attempt: { kind: 'call', by: { userId: agent.userId }, role: 'owner' }, waiting: null });
    expect(after.answeredCall).not.toBeNull();
    expect((await report(w.owner)).sources.find((s) => s.sourceId === web.id)).toMatchObject({ inquiries: 1, attempted: 1, answeredCalls: 0, waiting: 0 });
  });

  it('R-TEAMQ-22: a call nobody answered (it rang out to voicemail) changes nothing: still "nobody has called, texted or emailed yet", still waiting', async () => {
    const from = randomPhone();
    const callSid = sid('CA');
    const first = await ring(from, tracking.e164, callSid);
    expect(first.body).toContain('<Dial');
    const vm = await telephonyWebhook(h, hookPath(first.body, 'action'), { CallSid: callSid, DialCallStatus: 'no-answer' });
    expect(vm.body).toContain('<Record ');
    const k = await callRow(callSid);
    expect(k.answered_at).toBeNull();
    const [inq] = await inquiriesOf(k.contact_id);
    const row = (await newLeads(w.owner)).rows.find((x) => x.contact.id === k.contact_id)!;
    expect(row.answeredCallAt).toBeNull();
    expect(row.why).toMatch(/Nobody has called, texted or emailed yet\./);
    expect((await report(w.owner)).inquiries.find((i) => i.inquiryId === inq!.id)).toMatchObject({ state: 'waiting', attempt: null, answeredCall: null });
  });
});
