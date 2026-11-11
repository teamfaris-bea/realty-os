// Inbound MMS media (comms/media.ts): only allowed types whose bytes match, at most 10 items of at most
// 5 MB, stored encrypted and linked to the message; refused items are recorded with their reason; the
// download is safe (nosniff, sandbox CSP, attachment unless a raster image) and visible only to whoever
// sees the message.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { FAKE_PNG } from '../providers/fake/telephony.js';
import { systemActor } from '../worker/systemActor.js';
import { MAX_MEDIA_BYTES, allowedType, checkMedia, copyInboundMedia, mediaItemsOf } from './media.js';
import { type CommsWorld, call, commsWorld, ownedContact, runJobs, sid, telephonyWebhook } from './testing.js';

const hex32 = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
const mediaUrl = (msg: string, me: string) => `https://api.twilio.com/2010-04-01/Accounts/AC${'1'.repeat(32)}/Messages/${msg}/Media/${me}`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const HTML = new TextEncoder().encode('<html><script>alert(1)</script></html>');
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');

describe('media policy (pure)', () => {
  it('allows common MMS types (and vendor aliases), never SVG, HTML, scripts or archives', () => {
    expect(allowedType('image/jpeg; charset=binary')).toBe('image/jpeg');
    expect(allowedType('image/jpg')).toBe('image/jpeg');
    expect(allowedType('text/x-vcard')).toBe('text/vcard');
    for (const t of ['image/svg+xml', 'text/html', 'application/javascript', 'application/zip', 'application/octet-stream', '', null]) expect(allowedType(t)).toBeNull();
  });

  it('refuses bytes that are not the declared type, empty files and anything over 5 MB', () => {
    expect(checkMedia('image/png', FAKE_PNG)).toEqual({ ok: true, contentType: 'image/png' });
    expect(checkMedia('image/jpeg', JPEG)).toEqual({ ok: true, contentType: 'image/jpeg' });
    expect(checkMedia('image/jpeg', HTML)).toEqual({ ok: false, reason: 'CONTENT_MISMATCH' });
    expect(checkMedia('image/png', SVG)).toEqual({ ok: false, reason: 'CONTENT_MISMATCH' });
    expect(checkMedia('image/png', new Uint8Array())).toEqual({ ok: false, reason: 'CONTENT_MISMATCH' });
    expect(checkMedia('image/svg+xml', SVG)).toEqual({ ok: false, reason: 'TYPE_NOT_ALLOWED' });
    const big = new Uint8Array(MAX_MEDIA_BYTES + 1);
    big.set(FAKE_PNG);
    expect(checkMedia('image/png', big)).toEqual({ ok: false, reason: 'TOO_LARGE' });
  });

  it('keeps only the media SID of each MediaUrl (the URL itself is never fetched)', () => {
    const me = `ME${hex32()}`;
    const items = mediaItemsOf({ NumMedia: '3', MediaUrl0: mediaUrl(`MM${hex32()}`, me), MediaContentType0: 'image/png', MediaUrl1: 'http://169.254.169.254/latest/meta-data', MediaContentType1: 'image/png', MediaUrl2: 'not a url' });
    expect(items).toEqual([
      { position: 0, ref: me, declaredType: 'image/png' },
      { position: 1, ref: null, declaredType: 'image/png' },
      { position: 2, ref: null, declaredType: null },
    ]);
  });
});

let h: ApiHarness;
let w: CommsWorld;
beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2 });
});
afterAll(async () => {
  await h?.close();
});

async function inboundMms(from: string, items: { type: string; bytes?: Uint8Array | 'missing' }[]) {
  const messageSid = `MM${hex32()}`;
  const form: Record<string, string> = { MessageSid: messageSid, From: from, To: w.mainNumber, Body: 'Here are the photos', NumMedia: String(items.length) };
  const refs: string[] = [];
  items.forEach((it, i) => {
    const me = `ME${hex32()}`;
    refs.push(me);
    form[`MediaUrl${i}`] = mediaUrl(messageSid, me);
    form[`MediaContentType${i}`] = it.type;
    if (it.bytes) h.providers.telephony.media.set(me, it.bytes === 'missing' ? 'missing' : { bytes: it.bytes, contentType: it.type });
  });
  const r = await telephonyWebhook(h, '/webhooks/telephony/sms', form);
  expect(r.statusCode).toBe(200);
  const m = (await h.su.query<{ id: string; channel: string }>('SELECT id, channel FROM messages WHERE provider_message_ref = $1', [messageSid])).rows[0]!;
  return { messageId: m.id, channel: m.channel, refs };
}

describe('inbound MMS media', () => {
  it('stores allowed media encrypted and linked to the message; refuses the rest with a reason; deletes the provider copies; a re-run changes nothing', async () => {
    const owner = w.agents[0]!;
    const c = await ownedContact(owner);
    const { messageId, channel, refs } = await inboundMms(c.phone, [
      { type: 'image/png', bytes: FAKE_PNG },
      { type: 'image/svg+xml', bytes: SVG },
      { type: 'image/jpeg', bytes: HTML },
      { type: 'application/pdf', bytes: 'missing' },
      { type: 'image/jpeg', bytes: JPEG },
    ]);
    expect(channel).toBe('mms');
    await runJobs(h, w.tenantId, ['comms.media_copy']);
    const stored = (await h.su.query<{ position: number; content_type: string; storage_key: string; purpose: string }>('SELECT mm.position, o.content_type, o.storage_key, o.purpose FROM message_media mm JOIN stored_objects o ON o.tenant_id = mm.tenant_id AND o.id = mm.object_id WHERE mm.message_id = $1 ORDER BY mm.position', [messageId])).rows;
    expect(stored.map((s) => [s.position, s.content_type, s.purpose])).toEqual([[0, 'image/png', 'mms'], [4, 'image/jpeg', 'mms']]);
    // ciphertext only in storage, under the tenant prefix
    expect(stored[0]!.storage_key.startsWith(`tenants/${w.tenantId}/`)).toBe(true);
    const raw = await h.providers.storage.get(stored[0]!.storage_key);
    expect(raw).not.toBeNull();
    expect(Buffer.from(raw!).includes(Buffer.from(FAKE_PNG.subarray(0, 16)))).toBe(false);
    const skipped = (await h.su.query('SELECT position, reason FROM message_media_skipped WHERE message_id = $1 ORDER BY position', [messageId])).rows;
    expect(skipped).toEqual([{ position: 1, reason: 'TYPE_NOT_ALLOWED' }, { position: 2, reason: 'CONTENT_MISMATCH' }, { position: 3, reason: 'FETCH_FAILED' }]);
    for (const i of [0, 2, 4]) expect(h.providers.telephony.deletedMedia).toContain(refs[i]);
    // idempotent
    const again = await copyInboundMedia(systemActor(w.tenantId, 'provider'), messageId, refs.map((ref, position) => ({ position, ref, declaredType: 'image/png' })), w.deps);
    expect(again).toEqual({ stored: 0, skipped: 0 });
    expect((await h.su.query('SELECT count(*)::int AS n FROM message_media WHERE message_id = $1', [messageId])).rows[0].n).toBe(2);

    // the thread's attachment list and the safe download
    const list = await call<{ messages: { messageId: string; media: { position: number; inline: boolean; url: string }[]; skipped: { reason: string }[] }[] }>(owner, 'GET', `/contacts/${c.id}/attachments`);
    expect(list.status).toBe(200);
    const mine = list.body.messages.find((m) => m.messageId === messageId)!;
    expect(mine.media.map((m) => [m.position, m.inline])).toEqual([[0, true], [4, true]]);
    expect(mine.skipped.map((s) => s.reason)).toEqual(['TYPE_NOT_ALLOWED', 'CONTENT_MISMATCH', 'FETCH_FAILED']);
    const dl = await owner.get(mine.media[0]!.url);
    expect(dl.statusCode).toBe(200);
    expect(new Uint8Array(dl.rawPayload)).toEqual(FAKE_PNG);
    expect(dl.headers['content-type']).toBe('image/png');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(dl.headers['content-disposition']).toBe('inline; filename="attachment-1.png"');
    expect(dl.headers['cache-control']).toBe('private, no-store');
    // a refused position was never stored
    expect((await owner.get(`/api/messages/${messageId}/media/1`)).statusCode).toBe(404);
    // R-PERM-5: another agent who does not see the contact gets 404 for both
    const other = w.agents[1]!;
    expect((await other.get(mine.media[0]!.url)).statusCode).toBe(404);
    expect((await call(other, 'GET', `/contacts/${c.id}/attachments`)).status).toBe(404);
  });

  it('at most 10 media items are kept; the rest are TOO_MANY', async () => {
    const c = await ownedContact(w.agents[0]!);
    const { messageId } = await inboundMms(c.phone, Array.from({ length: 12 }, () => ({ type: 'image/png', bytes: FAKE_PNG })));
    await runJobs(h, w.tenantId, ['comms.media_copy']);
    expect((await h.su.query('SELECT count(*)::int AS n FROM message_media WHERE message_id = $1', [messageId])).rows[0].n).toBe(10);
    expect((await h.su.query("SELECT position FROM message_media_skipped WHERE message_id = $1 AND reason = 'TOO_MANY' ORDER BY position", [messageId])).rows.map((r) => r.position)).toEqual([10, 11]);
  });

  it('a plain SMS enqueues no media job', async () => {
    const c = await ownedContact(w.agents[0]!);
    await telephonyWebhook(h, '/webhooks/telephony/sms', { MessageSid: sid(), From: c.phone, To: w.mainNumber, Body: 'hi', NumMedia: '0' });
    const m = (await h.su.query<{ id: string }>('SELECT id FROM messages WHERE contact_id = $1 AND direction = $2', [c.id, 'inbound'])).rows[0]!;
    expect((await h.su.query("SELECT 1 FROM jobs WHERE kind = 'comms.media_copy' AND dedupe_key = $1", [`comms.media_copy:${m.id}`])).rows).toHaveLength(0);
  });
});
