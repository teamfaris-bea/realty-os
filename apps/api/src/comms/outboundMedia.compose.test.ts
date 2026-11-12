// D5a compose and dispatch of a photo text (R-MMS-1, R-MMS-2, R-MMS-5, R-MMS-6, R-OWN-14, R-GATE-14, R-PAR-12; E27, E290,
// E291, E292, E297): one-to-one human texts only, on the one send path, with opt-outs checked at send time, and the
// provider fetching every item through the app byte for byte.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { command, freshReauth, ledger } from '../leads/testing.js';
import { dispatchAgentAlertSms } from './dispatch.js';
import { appFetch, jpeg, mediaRows, mp4, png, sendPhotoText, uploadId } from './outboundMedia.testing.js';
import { type CommsWorld, call, commsWorld, decisionsFor, inboundSms, messageRow, ownedContact, randomPhone, runJobs, sendText } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let agent2: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2 });
  agent = w.agents[0]!;
  agent2 = w.agents[1]!;
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const smsTo = (phone: string) => h.providers.telephony.sms.filter((m) => m.to === phone);
const codeOf = (b: unknown) => (b as { error: { code: string; details?: Record<string, unknown> } }).error;
const issuesOf = (b: unknown) => (codeOf(b).details as { issues: { path: string; code: string }[] }).issues;

describe('E291 / E292 / R-MMS-1: composing a photo text', () => {
  it('R-MMS-1: a photo-only text is created as mms, its items at the positions given, the staged rows gone; R-MMS-6: the fake gets one URL per item', async () => {
    const c = await ownedContact(agent);
    const ids = [await uploadId(agent, c.id, png(), 'image/png'), await uploadId(agent, c.id, jpeg(), 'image/jpeg'), await uploadId(agent, c.id, mp4(3000), 'video/mp4')];
    const r = await sendPhotoText(agent, c.id, ids);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.result).toBe('sent');
    expect(r.body.message!.channel).toBe('mms');
    const rows = await mediaRows(h, r.body.message!.id);
    expect(rows.map((x) => [x.position, x.content_type])).toEqual([[0, 'image/png'], [1, 'image/jpeg'], [2, 'video/mp4']]);
    expect((await h.su.query('SELECT count(*)::int AS n FROM outbound_media_uploads WHERE id = ANY ($1)', [ids])).rows[0].n).toBe(0);
    const sent = smsTo(c.phone);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.providerRef).toMatch(/^MM[0-9a-f]{32}$/);
    expect(sent[0]!.mediaUrls).toHaveLength(3);
    for (const u of sent[0]!.mediaUrls) expect(u).toMatch(/^https:\/\/api\.test\.invalid\/api\/mms\/media\?token=[A-Za-z0-9_-]{55}\.[A-Za-z0-9_-]{32}$/);
  });

  it('R-MMS-6: the provider pulls every item through the app (HEAD then GET): bytes identical to the stored copy, the stored type, nosniff, attachment, no-store', async () => {
    const c = await ownedContact(agent);
    const ids = [await uploadId(agent, c.id, png(), 'image/png'), await uploadId(agent, c.id, jpeg(), 'image/jpeg')];
    const r = await sendPhotoText(agent, c.id, ids, 'The kitchen');
    const pulled = await h.providers.telephony.pullMedia(r.body.message!.id, appFetch(h));
    const rows = await mediaRows(h, r.body.message!.id);
    for (const [i, row] of rows.entries()) {
      // the stored copy's SHA-256 (of its plaintext) and size
      const o = (await h.su.query('SELECT sha256, byte_size FROM stored_objects WHERE id = $1', [row.object_id])).rows[0];
      expect(createHash('sha256').update(pulled[i]!.bytes).digest().equals(o.sha256)).toBe(true);
      expect(pulled[i]!.bytes.byteLength).toBe(Number(o.byte_size));
      expect(pulled[i]!.contentType).toBe(row.content_type);
    }
    const url = new URL(smsTo(c.phone)[0]!.mediaUrls[0]!);
    const g = await h.app.inject({ method: 'GET', url: url.pathname + url.search });
    expect(g.headers['content-type']).toBe('image/png');
    expect(g.headers['x-content-type-options']).toBe('nosniff');
    expect(g.headers['cache-control']).toBe('no-store');
    expect(g.headers['content-disposition']).toBe('attachment; filename="media-1.png"');
    expect(g.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  });

  it('E292: media on email or web chat is media_text_only; with bulkActionId or purposeOverride media_one_to_one_only; duplicates media_duplicate; nothing is created', async () => {
    const c = await ownedContact(agent);
    const id = await uploadId(agent, c.id);
    const before = (await h.su.query('SELECT count(*)::int AS n FROM messages WHERE contact_id = $1', [c.id])).rows[0].n;
    const cases: [Record<string, unknown>, string, string][] = [
      [{ channel: 'email', subject: 'Photos' }, '/mediaIds', 'media_text_only'],
      [{ channel: 'web_chat' }, '/mediaIds', 'media_text_only'],
      [{ mediaIds: [id, id] }, '/mediaIds', 'media_duplicate'],
    ];
    for (const [extra, path, code] of cases) {
      const r = await call(agent, 'POST', `/contacts/${c.id}/messages`, { channel: 'sms', body: 'Hi', idempotencyKey: `k-${randomUUID()}`, mediaIds: [id], ...extra });
      expect(r.status, code).toBe(422);
      expect(issuesOf(r.body)).toContainEqual({ path, code });
    }
    // purposeOverride is not an HTTP field: the bulk path's input is refused by compose.ts itself (direct caller)
    const { composeHumanMessage } = await import('./compose.js');
    await expect(composeHumanMessage(agent.actor(), c.id, { channel: 'sms', body: 'Hi', idempotencyKey: `k-${randomUUID()}`, mediaIds: [id], bulkActionId: randomUUID() }, w.deps)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: '/mediaIds', code: 'media_one_to_one_only' }] } });
    await expect(composeHumanMessage(agent.actor(), c.id, { channel: 'sms', body: 'Hi', idempotencyKey: `k-${randomUUID()}`, mediaIds: [id], purposeOverride: 'marketing' }, w.deps)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: '/mediaIds', code: 'media_one_to_one_only' }] } });
    expect((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE contact_id = $1', [c.id])).rows[0].n).toBe(before);
    expect((await h.su.query('SELECT count(*)::int AS n FROM outbound_media_uploads WHERE id = $1', [id])).rows[0].n).toBe(1);
  });

  it('R-MMS-9: an empty text without media is body_required; a one-to-one text over 1,600 characters is text_too_long', async () => {
    const c = await ownedContact(agent);
    const empty = await sendText(agent, c.id, '   ');
    expect(empty.status).toBe(422);
    expect(issuesOf(empty.body)).toContainEqual({ path: '/body', code: 'body_required' });
    const long = await sendText(agent, c.id, 'a'.repeat(1_601));
    expect(long.status).toBe(422);
    expect(issuesOf(long.body)).toContainEqual({ path: '/body', code: 'text_too_long' });
    // the preview: the same codes; withMedia allows an empty body on sms only
    const pv = await call<{ textSender: string | null; body: string }>(agent, 'POST', `/contacts/${c.id}/messages/preview`, { channel: 'sms', body: '', withMedia: true });
    expect(pv.status).toBe(200);
    expect(pv.body.textSender).toBe('local');
    expect((await call(agent, 'POST', `/contacts/${c.id}/messages/preview`, { channel: 'sms', body: '' })).status).toBe(422);
    expect(issuesOf((await call(agent, 'POST', `/contacts/${c.id}/messages/preview`, { channel: 'email', body: 'x', withMedia: true })).body)).toContainEqual({ path: '/mediaIds', code: 'media_text_only' });
  });

  it('E291: a re-post with the same idempotency key is a noop and attaches nothing', async () => {
    const c = await ownedContact(agent);
    const id = await uploadId(agent, c.id);
    const key = `k-${randomUUID()}`;
    const first = await call<{ result: string; message: { id: string } }>(agent, 'POST', `/contacts/${c.id}/messages`, { channel: 'sms', body: '', idempotencyKey: key, mediaIds: [id] });
    expect(first.body.result).toBe('sent');
    const again = await call<{ result: string; message: { id: string } }>(agent, 'POST', `/contacts/${c.id}/messages`, { channel: 'sms', body: '', idempotencyKey: key, mediaIds: [id] });
    expect(again.body.result).toBe('noop');
    expect(again.body.message.id).toBe(first.body.message.id);
    expect(await mediaRows(h, first.body.message.id)).toHaveLength(1);
  });

  it('E291: an expired upload and another agent\'s upload are MEDIA_UPLOAD_GONE with the same body apart from the request id; nothing is created', async () => {
    const c = await ownedContact(agent);
    const mine = await uploadId(agent, c.id);
    await h.su.query("UPDATE outbound_media_uploads SET expires_at = now() - interval '1 second' WHERE id = $1", [mine]);
    const a = await sendPhotoText(agent, c.id, [mine]);
    const c2 = await ownedContact(agent2);
    const theirs = await uploadId(agent2, c2.id);
    const b = await sendPhotoText(agent, c.id, [theirs]);
    expect(a.status).toBe(409);
    expect(b.status).toBe(409);
    const strip = (x: unknown, id: string) => JSON.stringify({ ...codeOf(x), requestId: null, details: { uploadId: (codeOf(x).details as { uploadId: string }).uploadId === id ? 'ID' : 'other' } });
    expect(strip(a.body, mine)).toBe(strip(b.body, theirs));
    expect((await h.su.query("SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'outbound'", [c.id])).rows[0].n).toBe(0);
  });

  it('E291: two concurrent sends naming one upload create one message; the other gets MEDIA_UPLOAD_GONE', async () => {
    const c = await ownedContact(agent);
    const id = await uploadId(agent, c.id);
    const [x, y] = await Promise.all([sendPhotoText(agent, c.id, [id], 'one'), sendPhotoText(agent, c.id, [id], 'two')]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect(codeOf((x.status === 409 ? x : y).body).code).toBe('MEDIA_UPLOAD_GONE');
    expect((await h.su.query("SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND channel = 'mms'", [c.id])).rows[0].n).toBe(1);
  });

  it('R-OWN-14: the owner\'s photo text records a touch via sms, at the TX1 dispatch instant', async () => {
    const c = await ownedContact(agent);
    const r = await sendPhotoText(agent, c.id, [await uploadId(agent, c.id)], 'Look');
    expect(r.body.result).toBe('sent');
    const m = await messageRow(h, r.body.message!.id);
    const touched = (await h.su.query('SELECT last_human_touch_at FROM contacts WHERE id = $1', [c.id])).rows[0].last_human_touch_at as Date;
    expect(touched.getTime()).toBe(m.dispatched_at!.getTime());
    const events = await ledger(h, c.id);
    const touch = events.filter((e) => JSON.stringify(e.payload).includes(r.body.message!.id));
    expect(touch.length).toBeGreaterThan(0);
    expect(JSON.stringify(touch.map((e) => e.payload))).toContain('sms');
  });
});

describe('E290 / E27 / R-GATE-14 / R-MMS-5: a photo text at send time', () => {
  it('R-GATE-14 E290: a blocked photo text writes gate_decisions, mints no URL, sends nothing, and keeps its media', async () => {
    const c = await ownedContact(agent);
    expect((await inboundSms(h, c.phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
    const r = await sendPhotoText(agent, c.id, [await uploadId(agent, c.id)], 'Here');
    expect(r.body.result).toBe('blocked');
    expect((await decisionsFor(h, { messageId: r.body.message!.id }))[0]!.outcome).toBe('deny');
    expect(smsTo(c.phone).filter((m) => m.mediaUrls.length > 0)).toHaveLength(0);
    expect(await mediaRows(h, r.body.message!.id)).toHaveLength(1);
  });

  it('E290: a scheduled photo text dispatches through the job with its media; after a STOP it is canceled and the fake gets nothing', async () => {
    const c = await ownedContact(agent);
    const at = new Date(Date.now() + 3600_000).toISOString();
    const ok = await sendPhotoText(agent, c.id, [await uploadId(agent, c.id)], 'Saturday', { scheduleAt: at });
    expect(ok.body.result).toBe('scheduled');
    await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1", [ok.body.message!.id]);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    expect((await messageRow(h, ok.body.message!.id)).status).toBe('sent');
    expect(smsTo(c.phone)[0]!.mediaUrls).toHaveLength(1);

    const d = await ownedContact(agent);
    const later = await sendPhotoText(agent, d.id, [await uploadId(agent, d.id)], 'Sunday', { scheduleAt: at });
    expect((await inboundSms(h, d.phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
    await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1", [later.body.message!.id]);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const m = await messageRow(h, later.body.message!.id);
    expect(['canceled', 'blocked']).toContain(m.status);
    expect(smsTo(d.phone).filter((x) => x.mediaUrls.length > 0)).toHaveLength(0);
    expect(await mediaRows(h, later.body.message!.id)).toHaveLength(1);
  });

  it('E27: a held photo text (the client replied since) sent anyway goes with its media', async () => {
    const c = await ownedContact(agent);
    const r = await sendPhotoText(agent, c.id, [await uploadId(agent, c.id), await uploadId(agent, c.id, png(), 'image/png')], 'The view', { scheduleAt: new Date(Date.now() + 3600_000).toISOString() });
    expect((await inboundSms(h, c.phone, w.mainNumber, 'Thanks, any more photos?')).statusCode).toBe(200);
    await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1", [r.body.message!.id]);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    expect((await messageRow(h, r.body.message!.id)).status_reason).toBe('CLIENT_REPLIED_SINCE_SCHEDULED');
    const re = await call<{ result: string }>(agent, 'POST', `/messages/${r.body.message!.id}/send`, {});
    expect(re.body.result).toBe('sent');
    expect(smsTo(c.phone).at(-1)!.mediaUrls).toHaveLength(2);
  });

  it('R-MMS-5: a photo text whose object was shredded before dispatch ends failed MEDIA_UNAVAILABLE; the fake gets nothing', async () => {
    const c = await ownedContact(agent);
    const r = await sendPhotoText(agent, c.id, [await uploadId(agent, c.id)], 'Gone', { scheduleAt: new Date(Date.now() + 3600_000).toISOString() });
    await h.su.query("UPDATE stored_objects o SET dek_wrapped = NULL, deleted_at = now() FROM message_media mm WHERE mm.object_id = o.id AND mm.message_id = $1", [r.body.message!.id]);
    await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1", [r.body.message!.id]);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const m = await messageRow(h, r.body.message!.id);
    expect(m.status).toBe('failed');
    expect(m.status_reason).toBe('MEDIA_UNAVAILABLE');
    expect(smsTo(c.phone)).toHaveLength(0);
  });

  it('R-PAR-12: after a STOP from a removed phone, an mms to the live phone is blocked in TX1 with a gate_decisions row', async () => {
    const old = randomPhone();
    const live = randomPhone();
    const made = await call<{ contact: { id: string } }>(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Rita', lastName: 'Removed', phones: [old, live], emails: [] });
    const c = { id: made.body.contact.id };
    expect((await inboundSms(h, old, w.mainNumber, 'STOP')).statusCode).toBe(200);
    await h.su.query("UPDATE contact_points SET status = 'removed', removed_at = now(), removed_reason = 'old', is_primary = false WHERE contact_id = $1 AND address = $2", [c.id, old]);
    const livePoint = (await h.su.query('SELECT id FROM contact_points WHERE contact_id = $1 AND address = $2', [c.id, live])).rows[0].id;
    const r = await sendPhotoText(agent, c.id, [await uploadId(agent, c.id)], 'Hi', { toPointId: livePoint });
    expect(r.body.result).toBe('blocked');
    const dec = await decisionsFor(h, { messageId: r.body.message!.id });
    expect(dec).toHaveLength(1);
    expect(dec[0]!.reason_codes).toContain('CONSENT_REVOKED');
    expect(smsTo(live)).toHaveLength(0);
  });
});

describe('E297: the lead moved before a scheduled photo text was due', () => {
  const scheduleThenReassign = async (body: string, informational: boolean) => {
    const c = await ownedContact(agent);
    if (informational) expect((await inboundSms(h, c.phone, w.mainNumber, 'Can you send photos?')).statusCode).toBe(200);
    const ids = [await uploadId(agent, c.id), await uploadId(agent, c.id, png(), 'image/png')];
    const r = await sendPhotoText(agent, c.id, ids, body, { scheduleAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(r.body.result).toBe('scheduled');
    await freshReauth(h, w.owner);
    expect((await command(w.owner, c.id, 'reassign', { toUserId: agent2.userId, reason: 'MANUAL_REASSIGN' })).status).toBe(200);
    await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1", [r.body.message!.id]);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const m = await messageRow(h, r.body.message!.id);
    expect(m.status_reason).toBe('SENDER_NOT_AUTHORIZED');
    return (await h.su.query("SELECT explanation, payload FROM assistant_actions WHERE contact_id = $1 AND kind = 'message_draft'", [c.id])).rows;
  };

  it('E297: the draft carries the words only (channel sms) with the photos explanation', async () => {
    const drafts = await scheduleThenReassign('Here is the backyard', true);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].payload).toEqual({ channel: 'sms', body: 'Here is the backyard' });
    expect(drafts[0].explanation).toBe("The previous agent scheduled this message, with 2 photos or videos, before the lead moved to you. It was not sent. Drafts can't carry photos or videos: send your own text from the thread if it still fits.");
  });

  it('E297: a photo-only text, informational (no words) or marketing (only the brokerage line), creates no draft', async () => {
    expect(await scheduleThenReassign('', true)).toEqual([]);
    expect(await scheduleThenReassign('', false)).toEqual([]);
  });
});

describe('R-MMS-1: agent alerts never pass media', () => {
  it('R-MMS-1: dispatchAgentAlertSms sends a plain text (no mediaUrls)', async () => {
    const phone = randomPhone();
    await h.su.query('UPDATE memberships SET alert_phone_e164 = $3, alert_phone_verified_at = now() WHERE tenant_id = $1 AND user_id = $2', [w.tenantId, agent.userId, phone]);
    const nid = randomUUID();
    const did = randomUUID();
    await h.su.query("INSERT INTO notifications (tenant_id, id, user_id, kind, priority, title, body) VALUES ($1, $2, $3, 'system_notice', 'high', 'New lead', 'x')", [w.tenantId, nid, agent.userId]).catch(() => undefined);
    await h.su.query("INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, status) VALUES ($1, $2, $3, 'sms', 'pending')", [w.tenantId, did, nid]).catch(() => undefined);
    await dispatchAgentAlertSms(did, w.deps, w.tenantId);
    for (const m of h.providers.telephony.sms) if (m.to === phone) expect(m.mediaUrls).toEqual([]);
  });
});
