// Batch 11 review ownership-data/F2 (R-OWN-24, R-PERM-8, R-PERM-9): a merge moves the merged-away record's calls to the
// survivor (packages/db/src/ownership/merge.ts mergeCommunication) but never their recordings and transcripts, which
// keep the merged-away record's id (recordings.contact_id and transcripts.contact_id). Contacts RLS hides that record
// (closed, no owner) from everyone who is not tenant-wide, so recordings_select / transcripts_select
// (app.contact_detail_visible on the merged-away record), the recording-scope RESTRICTIVE policy (its own/team/deal
// branches look the merged-away record up) and the API's recording facts all stopped at it: the survivor's agent, Team
// Lead and the TC on the person's deal could no longer play a moved call or read its transcript; only the Owner and
// Admins could. The same class as ownership-data/F1 (documents, migration 0075). Real Postgres as app_user through the
// real server, fake providers; the superuser pool writes the deal fixture and reads state back.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { command, leadsWorker, suFixture } from '../leads/testing.js';
import { type CommsWorld, call, commsWorld, ownedContact, randomEmail, randomPhone, runJobs, telephonyWebhook } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let stranger: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, teamLead: true, others: ['tc'] });
  for (const a of w.agents) await alertPhone(a);
  stranger = await h.signup();
}, 240_000);
afterAll(async () => {
  await h?.close();
});

async function alertPhone(c: TestClient): Promise<void> {
  const ch = await c.post('/api/me/alert-phone', { phone: randomPhone() });
  const code = h.providers.telephony.verificationCodes.at(-1)!.code;
  const r = await c.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code });
  if (r.statusCode !== 200) throw new Error(`alert phone: ${r.statusCode} ${r.body}`);
}

const voice = (ref: string, status: string, extra: Record<string, string> = {}) =>
  telephonyWebhook(h, '/webhooks/telephony/voice', { CallSid: ref, From: w.mainNumber, To: '+14155550000', CallStatus: status, Direction: 'outbound-api', ...extra });

/** The agent's tap-to-call to `contactId`, announced, answered and recorded; the recording is copied and transcribed. */
async function recordedCall(agent: TestClient, contactId: string): Promise<{ callId: string; recordingId: string }> {
  const r = await call<{ callId: string | null }>(agent, 'POST', `/contacts/${contactId}/calls`, {});
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const callId = r.body.callId!;
  const ref = (await h.su.query<{ r: string }>('SELECT provider_call_ref AS r FROM calls WHERE id = $1', [callId])).rows[0]!.r;
  await voice(ref, 'ringing');
  await voice(ref, 'in-progress', { AnnouncementStatus: 'played' });
  await voice(ref, 'completed', { CallDuration: '61' });
  const recRef = `RE${randomUUID().replace(/-/g, '').slice(0, 30)}`;
  expect((await telephonyWebhook(h, '/webhooks/telephony/recording', { CallSid: ref, RecordingSid: recRef, RecordingDuration: '60', From: w.mainNumber })).statusCode).toBe(200);
  await runJobs(h, w.tenantId, ['comms.recording_copy', 'comms.transcribe']);
  const rec = (await h.su.query<{ id: string }>("SELECT r.id FROM recordings r JOIN transcripts t ON t.tenant_id = r.tenant_id AND t.recording_id = r.id AND t.status = 'ready' WHERE r.call_id = $1", [callId])).rows[0];
  expect(rec, 'a stored recording with a ready transcript').toBeDefined();
  return { callId, recordingId: rec!.id };
}

type Reads = { token: number; stream: number | null; transcript: number; segments: boolean };
const PLAYS: Reads = { token: 200, stream: 200, transcript: 200, segments: true };
const NOTHING: Reads = { token: 404, stream: null, transcript: 404, segments: false };

/** What `c` gets from the three recording read routes: the stream token, the audited stream, the audited transcript. */
async function reads(c: TestClient, recordingId: string): Promise<Reads> {
  const tok = await call<{ url: string }>(c, 'POST', `/recordings/${recordingId}/stream-token`, { purpose: 'play' });
  const stream = tok.status === 200 ? (await c.get(tok.body.url)).statusCode : null;
  const tr = await call<{ segments: unknown[] }>(c, 'GET', `/recordings/${recordingId}/transcript`);
  return { token: tok.status, stream, transcript: tr.status, segments: tr.status === 200 && tr.body.segments.length > 0 };
}

async function merge(by: TestClient, survivorId: string, loserId: string, ownerChoice?: string): Promise<void> {
  const r = await command(by, survivorId, 'merge', { loserId, ...(ownerChoice ? { ownerChoice } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  // an agent's merge moves the messages and calls in the ownership follow-up (a tenant-wide one does it inline)
  await h.su.query("UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND kind = 'ownership.followup' AND status = 'pending'", [w.tenantId]);
  await leadsWorker(h).drain(10);
  const l = (await h.su.query('SELECT merged_into_contact_id, owner_user_id, closed_reason FROM contacts WHERE id = $1', [loserId])).rows[0]!;
  expect(l).toMatchObject({ merged_into_contact_id: survivorId, owner_user_id: null, closed_reason: 'merged' });
}

/** The data the finding is about: the call moved, its recording and transcript still name the merged-away record. */
async function expectRecordingLeftBehind(x: { callId: string; recordingId: string }, survivorId: string, loserId: string): Promise<void> {
  const row = (await h.su.query<{ call_contact: string; rec_contact: string; tr_contact: string }>(
    `SELECT c.contact_id AS call_contact, r.contact_id AS rec_contact, t.contact_id AS tr_contact
       FROM recordings r JOIN calls c ON c.tenant_id = r.tenant_id AND c.id = r.call_id
       JOIN transcripts t ON t.tenant_id = r.tenant_id AND t.recording_id = r.id WHERE r.id = $1`, [x.recordingId])).rows[0]!;
  expect(row).toEqual({ call_contact: survivorId, rec_contact: loserId, tr_contact: loserId });
}

const setRecordingAccess = (column: 'team_lead_recording_access' | 'tc_recording_access', on: boolean) =>
  suFixture(h, [{ text: `UPDATE tenant_settings SET ${column} = $2 WHERE tenant_id = $1`, values: [w.tenantId, on] }]);

describe('a merged-away record\'s call recordings follow the merge to the survivor (b11 review ownership-data/F2)', () => {
  it('R-OWN-24 R-PERM-8 R-PERM-9: after a merge the survivor\'s agent and Team Lead still play the moved call\'s recording and read its transcript; the Owner too; a peer agent and another tenant get 404', async () => {
    const agent = w.agents[0]!;
    const email = randomEmail();
    const survivor = await ownedContact(agent, { email, consent: false });
    const loser = await ownedContact(agent, { email, consent: false, confirmDistinct: true });
    const x = await recordedCall(agent, loser.id);
    // before the merge: the agent on the call and their Team Lead play it; the peer does not (R-PERM-8)
    expect(await reads(agent, x.recordingId)).toEqual(PLAYS);
    expect(await reads(w.teamLead!, x.recordingId)).toEqual(PLAYS);
    expect(await reads(w.agents[1]!, x.recordingId)).toEqual(NOTHING);

    await merge(agent, survivor.id, loser.id);
    await expectRecordingLeftBehind(x, survivor.id, loser.id);

    expect(await reads(agent, x.recordingId), 'the agent on the call, who owns the survivor').toEqual(PLAYS);
    expect(await reads(w.teamLead!, x.recordingId), 'the Team Lead of the survivor\'s agent (setting on)').toEqual(PLAYS);
    expect(await reads(w.owner, x.recordingId), 'the Owner (tenant-wide)').toEqual(PLAYS);
    expect(await reads(w.agents[1]!, x.recordingId), 'a peer agent').toEqual(NOTHING);
    expect(await reads(stranger, x.recordingId), 'another tenant\'s Owner').toEqual(NOTHING);
    // the Team Lead setting still decides (R-PERM-8): off ⇒ nothing, for the merged recording too
    await setRecordingAccess('team_lead_recording_access', false);
    try {
      expect(await reads(w.teamLead!, x.recordingId)).toEqual(NOTHING);
    } finally {
      await setRecordingAccess('team_lead_recording_access', true);
    }
    // every play and transcript view was audited against the recording / transcript (R-PERM-9)
    const plays = await h.su.query<{ actor_user_id: string }>("SELECT actor_user_id FROM audit_log WHERE tenant_id = $1 AND action = 'recording.play' AND entity_id = $2", [w.tenantId, x.recordingId]);
    expect(new Set(plays.rows.map((r) => r.actor_user_id))).toEqual(new Set([agent.userId, w.teamLead!.userId, w.owner.userId]));
  });

  it('R-OWN-24 R-PERM-8: the survivor\'s owner who was not on the call plays it as the person\'s owner once the Owner merges another agent\'s record into theirs; the agent who made the call no longer sees the person (as with the call itself) and gets 404', async () => {
    const [a, b] = [w.agents[0]!, w.agents[1]!];
    const survivor = await ownedContact(a, { consent: false });
    const loser = await ownedContact(b, { consent: false });
    const x = await recordedCall(b, loser.id);
    expect(await reads(a, x.recordingId), 'before the merge: not A\'s person, not A\'s call').toEqual(NOTHING);

    await merge(w.owner, survivor.id, loser.id, a.userId!);
    await expectRecordingLeftBehind(x, survivor.id, loser.id);

    expect(await reads(a, x.recordingId), 'the survivor\'s owner (recording scope "own" through the survivor)').toEqual(PLAYS);
    expect(await reads(w.teamLead!, x.recordingId)).toEqual(PLAYS);
    expect(await reads(b, x.recordingId), 'the agent on the call, who no longer sees the person').toEqual(NOTHING);
    expect(await reads(stranger, x.recordingId)).toEqual(NOTHING);
  });

  it('R-OWN-24 R-PERM-8: a TC on the person\'s deal (the merge re-points the deal to the survivor) plays the moved call while the TC setting is on, and gets 404 while it is off', async () => {
    const agent = w.agents[0]!;
    const tc = w.others[0]!;
    const survivor = await ownedContact(agent, { consent: false });
    const loser = await ownedContact(agent, { consent: false });
    const dealId = randomUUID();
    await suFixture(h, [
      { text: "INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id) VALUES ($1,$2,'Elm St purchase','buy','active',now(),$3,$4)", values: [w.tenantId, dealId, loser.id, agent.userId] },
      { text: "INSERT INTO deal_contacts (tenant_id, deal_id, contact_id, role) VALUES ($1,$2,$3,'buyer')", values: [w.tenantId, dealId, loser.id] },
      { text: "INSERT INTO deal_members (tenant_id, deal_id, user_id, role) VALUES ($1,$2,$3,'tc')", values: [w.tenantId, dealId, tc.userId] },
    ]);
    const x = await recordedCall(agent, loser.id);
    await setRecordingAccess('tc_recording_access', true);
    try {
      expect(await reads(tc, x.recordingId), 'before the merge, setting on').toEqual(PLAYS);

      await merge(agent, survivor.id, loser.id);
      await expectRecordingLeftBehind(x, survivor.id, loser.id);
      const d = (await h.su.query('SELECT primary_contact_id FROM deals WHERE id = $1', [dealId])).rows[0]!;
      expect(d.primary_contact_id).toBe(survivor.id);

      expect(await reads(tc, x.recordingId), 'after the merge, setting on').toEqual(PLAYS);
    } finally {
      await setRecordingAccess('tc_recording_access', false);
    }
    expect(await reads(tc, x.recordingId), 'setting off (the default)').toEqual(NOTHING);
  });
});
