// R-TWL-11 (lane telephony-safeguards S3): text carried in MMS text/plain parts, on real Postgres and the fakes.
// E386 a STOP only in a part revokes like a STOP body and is confirmed once per message; E387 unreadable parts;
// E388 an agent's alert phone; E389 a part never lifts. Also: the job is enqueued in the inbound message's own
// transaction, two concurrent runs apply a part once (address + contact locks), the kill switch refuses the fetch,
// visibility follows the message, the thread shows parts as plain text, parts never reach an assistant prompt, and
// erasure cascades.
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import type { TelephonyProvider } from '../providers/types.js';
import { TwilioTelephony } from '../providers/twilio/telephony.js';
import { systemActor } from '../worker/systemActor.js';
import { queueOutboundInTx } from './compose.js';
import { dispatchOutbound } from './dispatch.js';
import { PENDING_PART_SENTENCE, TEXT_PART_MAX_BYTES, UNREADABLE_PART_NOTICE, decodeTextPart } from './mmsText.js';
import { readTextParts } from './mmsTextJob.js';
import { type CommsWorld, call, commsWorld, ownedContact, randomPhone, sendText, telephonyWebhook } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2 });
});
afterAll(async () => {
  await h?.close();
});

const hex32 = () => randomBytes(16).toString('hex');
const mediaUrl = (mm: string, me: string) => `https://api.twilio.com/2010-04-01/Accounts/AC${'1'.repeat(32)}/Messages/${mm}/Media/${me}`;

/** An inbound MMS whose parts are `parts` (text bytes, or another type); the fake serves each part's bytes by SID. */
async function mms(from: string, to: string, body: string, parts: { bytes: Uint8Array | 'missing'; type?: string }[], extra: Record<string, string> = {}) {
  const mm = `MM${hex32()}`;
  const form: Record<string, string> = { MessageSid: mm, From: from, To: to, Body: body, NumMedia: String(parts.length), ...extra };
  parts.forEach((p, i) => {
    const me = `ME${hex32()}`;
    form[`MediaUrl${i}`] = mediaUrl(mm, me);
    form[`MediaContentType${i}`] = p.type ?? 'text/plain';
    h.providers.telephony.media.set(me, p.bytes === 'missing' ? 'missing' : { bytes: p.bytes, contentType: p.type ?? 'text/plain' });
  });
  const r = await telephonyWebhook(h, '/webhooks/telephony/sms', form);
  expect(r.statusCode).toBe(200);
  const m = (await h.su.query<{ id: string }>('SELECT id FROM messages WHERE provider_message_ref = $1', [mm])).rows[0];
  return { mm, messageId: m?.id ?? null };
}
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));
const job = async (messageId: string) => (await h.su.query<{ payload: { messageRef: string; parts: { position: number; ref: string | null }[] } }>("SELECT payload FROM jobs WHERE kind = 'comms.mms_text' AND payload->>'messageId' = $1", [messageId])).rows;
async function runPartJob(messageId: string) {
  const j = (await job(messageId))[0]!.payload;
  return readTextParts(systemActor(w.tenantId, 'provider'), { messageId, messageRef: j.messageRef, parts: j.parts }, w.deps);
}
const parts = async (messageId: string) => (await h.su.query('SELECT position, status, body, classification FROM message_text_parts WHERE message_id = $1 ORDER BY position', [messageId])).rows;
const revokes = async (contactId: string) => Number((await h.su.query<{ n: string }>("SELECT count(*) AS n FROM consent_events WHERE contact_id = $1 AND event_type = 'revoke'", [contactId])).rows[0]!.n);
const lifts = async (contactId: string) => Number((await h.su.query<{ n: string }>("SELECT count(*) AS n FROM consent_events WHERE contact_id = $1 AND event_type <> 'revoke'", [contactId])).rows[0]!.n);
const confirmations = async (contactId: string) => (await h.su.query<{ id: string }>("SELECT id FROM messages WHERE contact_id = $1 AND direction = 'outbound' AND action_category = 'opt_out_confirmation'", [contactId])).rows;

/** A contact with two phones (the STOP fan-out reaches both, R-CONSENT-7). */
async function twoPhoneContact(agent: TestClient) {
  const c = await ownedContact(agent);
  const second = randomPhone();
  const r = await call(agent, 'POST', `/contacts/${c.id}/points`, { kind: 'phone', address: second });
  return { ...c, second: r.status < 300 ? second : null };
}

describe('R-TWL-11 decoding (pure)', () => {
  it('R-TWL-11: at most 16 KiB, strict UTF-8, BOM stripped, a NUL or invalid UTF-8 is unreadable', () => {
    expect(decodeTextPart(utf8('STOP'))).toEqual({ ok: true, text: 'STOP' });
    expect(decodeTextPart(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('STOP')]))).toEqual({ ok: true, text: 'STOP' });
    expect(decodeTextPart(new Uint8Array(TEXT_PART_MAX_BYTES).fill(0x41)).ok).toBe(true);
    expect(decodeTextPart(new Uint8Array(TEXT_PART_MAX_BYTES + 1).fill(0x41))).toEqual({ ok: false, reason: 'TOO_LARGE' });
    expect(decodeTextPart(new Uint8Array([0x53, 0x00, 0x54]))).toEqual({ ok: false, reason: 'CONTENT_MISMATCH' });
    expect(decodeTextPart(new Uint8Array([0x53, 0xff, 0xfe]))).toEqual({ ok: false, reason: 'CONTENT_MISMATCH' });
    expect(decodeTextPart(new Uint8Array([0xc3]))).toEqual({ ok: false, reason: 'CONTENT_MISMATCH' });
  });
});

describe('R-TWL-11 a STOP carried only in a text part', () => {
  it('R-TWL-11 E386: the part row and its job are written by the inbound message\'s own transaction; the part revokes like a STOP body, is confirmed by the platform once, and a re-run does nothing', async () => {
    const agent = w.agents[0]!;
    const c = await twoPhoneContact(agent);
    const { messageId } = await mms(c.phone, w.mainNumber, '', [{ bytes: utf8('STOP') }, { bytes: new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')), type: 'image/png' }]);
    expect(messageId).not.toBeNull();
    // same transaction: the pending part and the job exist as soon as the webhook answered (no second transaction)
    expect(await parts(messageId!)).toEqual([{ position: 0, status: 'pending', body: null, classification: null }]);
    expect(await job(messageId!)).toHaveLength(1);
    expect(await revokes(c.id)).toBe(0);
    // the text part is not a file: the media copy job was given the image only
    const mediaJob = (await h.su.query("SELECT payload FROM jobs WHERE kind = 'comms.media_copy' AND payload->>'messageId' = $1", [messageId])).rows[0]!.payload as { items: { position: number }[] };
    expect(mediaJob.items.map((i) => i.position)).toEqual([1]);

    const r = await runPartJob(messageId!);
    expect(r).toEqual({ read: 1, skipped: 0, revoked: ['stop'] });
    expect(await parts(messageId!)).toEqual([{ position: 0, status: 'read', body: 'STOP', classification: 'stop' }]);
    const n = await revokes(c.id);
    expect(n).toBe(c.second ? 2 : 1); // every phone of the contact (R-CONSENT-7), like a STOP body
    const conf = await confirmations(c.id);
    expect(conf).toHaveLength(1);
    // the confirmation goes out through the single send path (the MMS counts as the keyword sender)
    const sentConf = await dispatchOutbound(conf[0]!.id, w.deps, { tenantId: w.tenantId });
    expect(sentConf, JSON.stringify(sentConf)).toMatchObject({ kind: 'sent' });
    expect((await sendText(agent, c.id, 'Still interested?')).body.result).toBe('blocked');
    // re-run (a retried job): nothing more
    expect(await runPartJob(messageId!)).toEqual({ read: 0, skipped: 0, revoked: [] });
    expect(await revokes(c.id)).toBe(n);
    expect(await confirmations(c.id)).toHaveLength(1);
  });

  it('R-TWL-11 E386: two concurrent runs of the job for one message apply the part once (address then contact locks)', async () => {
    const c = await ownedContact(w.agents[0]!);
    const { messageId } = await mms(c.phone, w.mainNumber, '', [{ bytes: utf8('stop') }]);
    const out = await Promise.all([runPartJob(messageId!), runPartJob(messageId!), runPartJob(messageId!)]);
    expect(out.map((o) => o.revoked.length).reduce((a, b) => a + b, 0)).toBe(1);
    expect(await revokes(c.id)).toBe(1);
    expect(await confirmations(c.id)).toHaveLength(1);
  });

  it('R-TWL-11: a STOP in the Body AND in a part revokes once and is confirmed at most once (the Body already produced it)', async () => {
    const a = await ownedContact(w.agents[0]!);
    await mms(a.phone, w.mainNumber, 'STOP', []);
    const bodyOnly = await revokes(a.id);
    const b = await ownedContact(w.agents[0]!);
    const { messageId } = await mms(b.phone, w.mainNumber, 'STOP', [{ bytes: utf8('STOP') }]);
    expect((await runPartJob(messageId!)).revoked).toEqual([]);
    expect(await revokes(b.id)).toBe(bodyOnly);
    expect((await confirmations(b.id)).length).toBeLessThanOrEqual(1);
  });

  it('R-TWL-11: opt-out language or a wrong number only in a part is applied with its usual effects (needs review), no reply', async () => {
    const c = await ownedContact(w.agents[0]!);
    const { messageId } = await mms(c.phone, w.mainNumber, 'Photo of the porch', [{ bytes: utf8('please stop texting me') }]);
    expect((await runPartJob(messageId!)).revoked).toEqual(['opt_out_language']);
    expect(await revokes(c.id)).toBeGreaterThanOrEqual(1);
    expect((await h.su.query('SELECT do_not_contact_at IS NOT NULL AS dnc FROM contacts WHERE id = $1', [c.id])).rows[0]?.dnc ?? true).toBe(true);
    expect(await confirmations(c.id)).toHaveLength(0);
    const d = await ownedContact(w.agents[0]!);
    const wn = await mms(d.phone, w.mainNumber, '', [{ bytes: utf8('wrong number') }]);
    expect((await runPartJob(wn.messageId!)).revoked).toEqual(['wrong_number']);
    expect((await h.su.query("SELECT status FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [d.id])).rows[0]!.status).toBe('wrong_number');
  });

  it('R-TWL-11 E389: a part never lifts an opt-out (START, YES) and never gets a reply of its own (HELP)', async () => {
    const c = await ownedContact(w.agents[0]!);
    await mms(c.phone, w.mainNumber, 'STOP', []);
    const before = { r: await revokes(c.id), l: await lifts(c.id), conf: (await confirmations(c.id)).length };
    for (const t of ['START', 'YES', 'HELP', 'unstop']) {
      const { messageId } = await mms(c.phone, w.mainNumber, '', [{ bytes: utf8(t) }]);
      expect((await runPartJob(messageId!)).revoked).toEqual([]);
    }
    expect(await lifts(c.id)).toBe(before.l);
    expect(await revokes(c.id)).toBe(before.r);
    expect((await h.su.query("SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'outbound' AND action_category = 'help_reply'", [c.id])).rows[0]!.n).toBe(0);
  });
});

describe('R-TWL-11 E387 unreadable, oversized and refused parts', () => {
  it('R-TWL-11 E387: oversized, NUL, invalid UTF-8 and a refused fetch: a skipped row each, ONE notice to the handler, no revoke; the thread reports them as not saved', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { firstName: 'Avery' });
    const { messageId } = await mms(c.phone, w.mainNumber, 'see attached', [
      { bytes: new Uint8Array(TEXT_PART_MAX_BYTES + 1).fill(0x53) },
      { bytes: new Uint8Array([0x53, 0x00, 0x54, 0x4f, 0x50]) },
      { bytes: new Uint8Array([0xff, 0xfe, 0x53]) },
      { bytes: 'missing' },
    ]);
    expect(await runPartJob(messageId!)).toEqual({ read: 0, skipped: 4, revoked: [] });
    const skipped = (await h.su.query('SELECT position, reason FROM message_media_skipped WHERE message_id = $1 ORDER BY position', [messageId])).rows;
    expect(skipped).toEqual([{ position: 0, reason: 'TOO_LARGE' }, { position: 1, reason: 'CONTENT_MISMATCH' }, { position: 2, reason: 'CONTENT_MISMATCH' }, { position: 3, reason: 'FETCH_FAILED' }]);
    const notes = (await h.su.query("SELECT user_id, title FROM notifications WHERE tenant_id = $1 AND dedupe_key = $2", [w.tenantId, `text_part_unreadable:${messageId}`])).rows;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.user_id).toBe(agent.userId);
    expect(notes[0]!.title).toBe(UNREADABLE_PART_NOTICE('Avery D.'));
    expect(await revokes(c.id)).toBe(0);
    const view = (await call<{ messages: { messageId: string; skipped: unknown[]; textParts: unknown[] }[] }>(agent, 'GET', `/contacts/${c.id}/attachments`)).body.messages.find((m) => m.messageId === messageId)!;
    expect(view.skipped).toHaveLength(4);
    expect(view.textParts).toEqual([]);
  });

  it('R-TWL-11 R-TWL-1: with the kill switch off the part is refused (FETCH_FAILED) and no request is made', async () => {
    const c = await ownedContact(w.agents[0]!);
    const { messageId } = await mms(c.phone, w.mainNumber, '', [{ bytes: utf8('STOP') }]);
    const calls: string[] = [];
    const real = new TwilioTelephony({ accountSid: 'AC' + '0'.repeat(32), authToken: 'fake', publicBaseUrl: h.config.publicBaseUrl, fetch: (async (u: string) => { calls.push(String(u)); throw new Error('no request may leave'); }) as unknown as typeof fetch });
    const providers = h.app.platform.providers as { telephony: TelephonyProvider };
    const fake = providers.telephony;
    providers.telephony = real;
    try {
      expect((await runPartJob(messageId!)).skipped).toBe(1);
    } finally {
      providers.telephony = fake;
    }
    expect(calls).toEqual([]);
    expect((await h.su.query('SELECT reason FROM message_media_skipped WHERE message_id = $1', [messageId])).rows).toEqual([{ reason: 'FETCH_FAILED' }]);
  });
});

describe('R-TWL-11 E388 an agent\'s alert phone', () => {
  it('R-TWL-11 E388: a STOP in a text part from an agent\'s verified alert phone revokes their alert texts (no message row); START in a part never lifts it', async () => {
    const agent = w.agents[1]!;
    const phone = randomPhone();
    const ch = await agent.post('/api/me/alert-phone', { phone });
    const code = h.providers.telephony.verificationCodes.at(-1)!.code;
    expect((await agent.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code })).statusCode).toBe(200);
    const { mm, messageId } = await mms(phone, w.mainNumber, '', [{ bytes: utf8('STOP') }]);
    expect(messageId).toBeNull();
    const j = (await h.su.query<{ payload: { agentUserId: string; messageRef: string; parts: { position: number; ref: string | null }[] } }>("SELECT payload FROM jobs WHERE kind = 'comms.mms_text' AND payload->>'messageRef' = $1", [mm])).rows[0]!.payload;
    expect(j.agentUserId).toBe(agent.userId);
    const r = await readTextParts(systemActor(w.tenantId, 'provider'), j, w.deps);
    expect(r.revoked).toEqual(['stop']);
    const ev = (await h.su.query("SELECT event_type, source FROM consent_events WHERE contact_id IS NULL AND evidence->>'matched' = 'TEXT_PART_STOP'")).rows;
    expect(ev).toEqual([{ event_type: 'revoke', source: 'inbound_keyword' }]);
    // once only, and a START part changes nothing
    expect((await readTextParts(systemActor(w.tenantId, 'provider'), j, w.deps)).revoked).toEqual([]);
    const start = await mms(phone, w.mainNumber, '', [{ bytes: utf8('START') }]);
    const j2 = (await h.su.query<{ payload: { agentUserId: string; messageRef: string; parts: { position: number; ref: string | null }[] } }>("SELECT payload FROM jobs WHERE kind = 'comms.mms_text' AND payload->>'messageRef' = $1", [start.mm])).rows[0]!.payload;
    expect((await readTextParts(systemActor(w.tenantId, 'provider'), j2, w.deps)).revoked).toEqual([]);
    expect((await h.su.query("SELECT count(*)::int AS n FROM consent_events WHERE contact_id IS NULL AND event_type = 'resubscribe' AND occurred_at > now() - interval '1 minute'")).rows[0]!.n).toBe(0);
  });
});

describe('R-TWL-11 the thread, visibility, prompts and erasure', () => {
  it('R-TWL-11: the thread shows a read part as plain text ("Text in this message: …") and a pending one as not read yet', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const { messageId } = await mms(c.phone, w.mainNumber, '', [{ bytes: utf8('<b>See you at 5</b>') }, { bytes: utf8('later part') }]);
    // read only the first part
    const j = (await job(messageId!))[0]!.payload;
    await readTextParts(systemActor(w.tenantId, 'provider'), { messageId: messageId!, messageRef: j.messageRef, parts: j.parts.slice(0, 1) }, w.deps);
    const view = (await call<{ messages: { messageId: string; textParts: { position: number; status: string; text: string | null }[] }[] }>(agent, 'GET', `/contacts/${c.id}/attachments`)).body.messages.find((m) => m.messageId === messageId)!;
    // readTextParts reads every pending part of the message (the payload's list is informative only)
    expect(view.textParts.map((p) => p.status)).toEqual(['read', 'read']);
    expect(view.textParts[0]!.text).toBe('<b>See you at 5</b>');
    const pending = await mms(c.phone, w.mainNumber, '', [{ bytes: utf8('not yet') }]);
    const v2 = (await call<{ messages: { messageId: string; textParts: { status: string; text: string | null }[] }[] }>(agent, 'GET', `/contacts/${c.id}/attachments`)).body.messages.find((m) => m.messageId === pending.messageId)!;
    expect(v2.textParts).toEqual([{ position: 0, status: 'pending', text: null }]);
    expect(PENDING_PART_SENTENCE).toBe("Part of this text hasn't been read yet.");
  });

  it('R-TWL-11: a part is visible exactly when its message is (another agent sees neither); only pending → read; erasure cascades', async () => {
    const owner = w.agents[0]!;
    const c = await ownedContact(owner);
    const { messageId } = await mms(c.phone, w.mainNumber, '', [{ bytes: utf8('hello') }]);
    const visible = (actor: TestClient) => withTenantTx(actor.actor(), async (tx) => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM message_text_parts WHERE message_id = ${messageId}`.execute(tx)).rows[0]!.n), { db: h.database });
    const sees = (actor: TestClient) => withTenantTx(actor.actor(), async (tx) => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM messages WHERE id = ${messageId}`.execute(tx)).rows[0]!.n), { db: h.database });
    expect(await visible(owner)).toBe(1);
    expect(await sees(w.agents[1]!)).toBe(0);
    expect(await visible(w.agents[1]!)).toBe(0);
    // an agent (not tenant-wide) cannot write a part, even on their own contact's message
    await expect(withTenantTx(owner.actor(), (tx) => sql`INSERT INTO message_text_parts (tenant_id, message_id, position) VALUES (app.tenant_id(), ${messageId}, 7)`.execute(tx), { db: h.database })).rejects.toThrow();
    await runPartJob(messageId!);
    await expect(h.su.query("UPDATE message_text_parts SET status = 'pending', body = NULL, classification = NULL, read_at = NULL WHERE message_id = $1", [messageId])).rejects.toThrow(/TEXT_PART_TRANSITION/);
    await expect(h.su.query("UPDATE message_text_parts SET body = 'edited' WHERE message_id = $1", [messageId])).rejects.toThrow(/TEXT_PART_TRANSITION/);
    const fk = (await h.su.query("SELECT confdeltype FROM pg_constraint WHERE conrelid = 'message_text_parts'::regclass AND contype = 'f' AND confrelid = 'messages'::regclass")).rows;
    expect(fk).toEqual([{ confdeltype: 'c' }]);
  });

  it('R-TWL-11: parts never reach an assistant prompt: messages.body is untouched and only the text-part modules and the thread view read message_text_parts', async () => {
    const c = await ownedContact(w.agents[0]!);
    const { messageId } = await mms(c.phone, w.mainNumber, 'Body only', [{ bytes: utf8('secret part words') }]);
    await runPartJob(messageId!);
    expect((await h.su.query('SELECT body FROM messages WHERE id = $1', [messageId])).rows[0]!.body).toBe('Body only');
    const API = join(dirname(fileURLToPath(import.meta.url)), '..');
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? (n === '__snapshots__' ? [] : walk(join(d, n))) : /\.ts$/.test(n) && !n.endsWith('.test.ts') ? [join(d, n)] : []));
    const readers = walk(API).filter((f) => readFileSync(f, 'utf8').includes('message_text_parts')).map((f) => relative(API, f).replaceAll('\\', '/')).sort();
    expect(readers).toEqual(['comms/media.ts', 'comms/mmsText.ts', 'comms/mmsTextJob.ts']);
  });
});

describe('R-TWL-11 adversarial: the MMS keyword-reply exemption stays narrow (guard 0132)', () => {
  it('R-TWL-11 R-PAR-12: after an MMS STOP from one phone, a "confirmation" to the contact\'s OTHER opted-out phone, or any non-exempt system text to the sender, is refused (gate and guard)', async () => {
    const agent = w.agents[0]!;
    const c = await twoPhoneContact(agent);
    expect(c.second).not.toBeNull();
    await mms(c.phone, w.mainNumber, 'STOP', []);
    const other = (await h.su.query<{ id: string }>("SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone' AND address = $2", [c.id, c.second])).rows[0]!.id;
    const queued = await withTenantTx(systemActor(w.tenantId, 'worker'), async (tx, now) => {
      const a = await queueOutboundInTx(tx, w.deps, { contactId: c.id, channel: 'sms', body: 'You are unsubscribed.', initiator: 'system', purpose: 'informational', category: 'opt_out_confirmation', phoneNumberId: w.mainNumberId, toPointId: other, idempotencyKey: `adv-confirm:${c.id}` }, now);
      const b = await queueOutboundInTx(tx, w.deps, { contactId: c.id, channel: 'sms', body: 'New listings near you', initiator: 'system', purpose: 'informational', category: 'none', phoneNumberId: w.mainNumberId, idempotencyKey: `adv-other:${c.id}` }, now);
      return [a, b];
    }, { db: h.database });
    for (const q of queued) {
      expect(q.ok).toBe(true);
      const id = (q as { messageId: string }).messageId;
      expect((await dispatchOutbound(id, w.deps, { tenantId: w.tenantId })).kind).toBe('blocked');
      // the database guard refuses the same send on its own (defence in depth): forcing the row to dispatching fails
      await h.su.query("UPDATE messages SET status = 'queued', status_reason = NULL, gate_decision_id = NULL WHERE id = $1", [id]);
      await expect(h.su.query("UPDATE messages SET status = 'dispatching', dispatched_at = now() WHERE id = $1", [id])).rejects.toThrow(/^RECIPIENT_OPTED_OUT:/);
    }
  });
});
