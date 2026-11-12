// Lane telephony-safeguards after merging batch 8 (photo/video texts D5a, texting reactions D5b): the safeguards still
// hold on the new paths.
//   R-TWL-7  a reaction text ("Loved “…”") that Twilio flags OptOutType=STOP still revokes (our reaction reading is not a
//            revoke, so the provider's STOP applies).
//   R-TWL-1  a photo-only text refused by the kill switch fails with the same honest reason (TELEPHONY_LIVE_OFF) and no
//            request leaves the process.
//   R-TWL-2  the daily cap counts a photo text (channel mms) like a text.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import type { TelephonyProvider } from '../providers/types.js';
import { TwilioTelephony } from '../providers/twilio/telephony.js';
import { dispatchOutbound } from './dispatch.js';
import { png, sendPhotoText, uploadId } from './outboundMedia.testing.js';
import { TELEPHONY_LIVE_OFF } from './telephonySafeguards.js';
import { type CommsWorld, commsWorld, inboundSms, messageRow, ownedContact, sendText, sid, telephonyWebhook } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
});
afterAll(async () => {
  await h?.close();
});

/** iOS quotes the reacted-to text with typographic quotes */
const quoted = (s: string) => `“${s}”`;
const revokes = async (contactId: string) => Number((await h.su.query<{ n: string }>("SELECT count(*) AS n FROM consent_events WHERE contact_id = $1 AND event_type = 'revoke'", [contactId])).rows[0]!.n);

describe('batch 8 × telephony safeguards', () => {
  it('R-TWL-7: a reaction text with OptOutType=STOP still revokes (and the same reaction without it does not)', async () => {
    const agent = w.agents[0]!;
    const a = await ownedContact(agent, { confirmDistinct: true });
    const b = await ownedContact(agent, { confirmDistinct: true });
    const sentBody: string[] = [];
    for (const c of [a, b]) {
      const s = await sendText(agent, c.id, 'See you at 3');
      expect(s.body.result).toBe('sent');
      sentBody.push((await messageRow(h, s.body.message!.id)).body);
    }
    expect((await inboundSms(h, a.phone, w.mainNumber, `Loved ${quoted(sentBody[0]!)}`)).statusCode).toBe(200);
    expect((await h.su.query('SELECT count(*)::int AS n FROM message_reactions r JOIN messages m ON m.id = r.message_id WHERE m.contact_id = $1', [a.id])).rows[0]!.n).toBe(1);
    expect(await revokes(a.id)).toBe(0);
    const r = await telephonyWebhook(h, '/webhooks/telephony/sms', { MessageSid: sid(), From: b.phone, To: w.mainNumber, Body: `Loved ${quoted(sentBody[1]!)}`, NumMedia: '0', OptOutType: 'STOP' });
    expect(r.statusCode).toBe(200);
    expect(await revokes(b.id)).toBeGreaterThanOrEqual(1);
    const k = (await h.su.query("SELECT opt_out_keyword FROM messages WHERE contact_id = $1 AND direction = 'inbound'", [b.id])).rows[0]!.opt_out_keyword;
    expect(k).toBe('OPTOUTTYPE_STOP');
    expect((await sendText(agent, b.id, 'Still on?')).body.result).toBe('blocked');
  });

  it('R-TWL-1: a photo-only text refused by the kill switch fails TELEPHONY_LIVE_OFF; no request is made', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const id = await uploadId(agent, c.id, png(), 'image/png');
    const calls: string[] = [];
    const real = new TwilioTelephony({ accountSid: 'AC' + '0'.repeat(32), authToken: 'fake', publicBaseUrl: h.config.publicBaseUrl, fetch: (async (u: string) => { calls.push(String(u)); throw new Error('no request may leave'); }) as unknown as typeof fetch });
    const providers = h.app.platform.providers as { telephony: TelephonyProvider };
    const fake = providers.telephony;
    providers.telephony = real;
    let r;
    try {
      r = await sendPhotoText(agent, c.id, [id], '');
    } finally {
      providers.telephony = fake;
    }
    expect(calls).toEqual([]);
    expect(r.body.result).toBe('failed');
    const m = await messageRow(h, r.body.message!.id);
    expect([m.status, m.status_reason]).toEqual(['failed', TELEPHONY_LIVE_OFF]);
    expect(await revokes(c.id)).toBe(0);
  });

  it('R-TWL-2: the daily cap counts a photo text like a text (over the cap it is blocked DAILY_SEND_CAP_REACHED)', async () => {
    const agent = w.agents[0]!;
    await h.su.query('UPDATE tenant_settings SET telephony_daily_cap = 1 WHERE tenant_id = $1', [w.tenantId]);
    await h.su.query('DELETE FROM telephony_daily_usage WHERE tenant_id = $1', [w.tenantId]);
    const due = async () => {
      const c = await ownedContact(agent);
      const up = await uploadId(agent, c.id, png(), 'image/png');
      const r = await sendPhotoText(agent, c.id, [up], 'Front porch', { scheduleAt: new Date(Date.now() + 3_600_000).toISOString() });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1", [r.body.message!.id]);
      return r.body.message!.id;
    };
    const first = await due();
    const second = await due();
    expect((await messageRow(h, first)) as unknown as { channel: string }).toMatchObject({ channel: 'mms' });
    const capped = { ...w.deps, telephonyDailyCap: true };
    expect((await dispatchOutbound(first, capped, { tenantId: w.tenantId })).kind).toBe('sent');
    expect((await dispatchOutbound(second, capped, { tenantId: w.tenantId })).kind).toBe('blocked');
    expect((await messageRow(h, second)).status_reason).toBe('DAILY_SEND_CAP_REACHED');
    await h.su.query('UPDATE tenant_settings SET telephony_daily_cap = 200 WHERE tenant_id = $1', [w.tenantId]);
  });
});
