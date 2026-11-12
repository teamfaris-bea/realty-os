// D5a Twilio adapter for photo texts against a stubbed fetch (no live calls; R-MMS-6, R-MMS-7, E298): one MediaUrl key
// per item, no Body when it is empty, the URL refusals, and the media / outbound-listing parsing.
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../providers/types.js';
import { TwilioTelephony } from '../providers/twilio/telephony.js';

const MASTER = 'AC' + '1'.repeat(32);
const SUB = 'AC' + '2'.repeat(32);
const account = { accountRef: SUB, secret: 'sub-token-secret' };
const MM = 'MM' + 'a'.repeat(32);

function stub(responses: { status: number; json?: unknown }[]) {
  const seen: { method: string; url: URL; form: URLSearchParams }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ method: init?.method ?? 'GET', url: new URL(String(input)), form: new URLSearchParams(String(init?.body ?? '')) });
    const r = responses.shift();
    if (!r) throw new Error('unexpected request');
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, seen };
}
const tw = (f: typeof fetch) => new TwilioTelephony({ accountSid: MASTER, authToken: 'master-token', publicBaseUrl: 'https://api.example.test', fetch: f, sleep: async () => undefined });

describe('R-MMS-6: TwilioTelephony.sendSms with media', () => {
  it('R-MMS-6: repeated MediaUrl keys in order; no Body for a photo-only text; no ValidityPeriod/SmartEncoded/SendAsMms/ContentRetention/AddressRetention', async () => {
    const s = stub([{ status: 201, json: { sid: MM, status: 'queued' } }]);
    const urls = ['https://api.example.test/api/mms/media?token=a', 'https://api.example.test/api/mms/media?token=b'];
    const r = await tw(s.f).sendSms({ account, from: '+14155550100', to: '+14155550123', body: '', idempotencyKey: 'm1', mediaUrls: urls });
    expect(r.providerRef).toBe(MM);
    const form = s.seen[0]!.form;
    expect(form.getAll('MediaUrl')).toEqual(urls);
    expect(form.has('Body')).toBe(false);
    for (const k of ['ValidityPeriod', 'SmartEncoded', 'SendAsMms', 'ContentRetention', 'AddressRetention']) expect(form.has(k), k).toBe(false);
    const t = stub([{ status: 201, json: { sid: MM, status: 'queued' } }]);
    await tw(t.f).sendSms({ account, from: '+14155550100', to: '+14155550123', body: 'With words', idempotencyKey: 'm2', mediaUrls: urls.slice(0, 1) });
    expect(t.seen[0]!.form.get('Body')).toBe('With words');
  });

  it('R-MMS-6: a URL that is not http(s), or more than 10 URLs, is refused before any request (TWILIO_MEDIA_URL_INVALID)', async () => {
    for (const mediaUrls of [['ftp://x.test/a'], ['javascript:alert(1)'], ['not a url'], Array.from({ length: 11 }, (_, i) => `https://x.test/${i}`)]) {
      const s = stub([]);
      const e = await tw(s.f).sendSms({ account, from: '+14155550100', to: '+14155550123', body: 'x', idempotencyKey: 'k', mediaUrls }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).kind).toBe('rejected');
      expect((e as ProviderError).providerCode).toBe('TWILIO_MEDIA_URL_INVALID');
      expect(s.seen).toHaveLength(0);
    }
  });
});

describe('R-MMS-7 / E298: listing the provider copies', () => {
  it('R-MMS-7: listMessageMedia reads Messages/{MM}/Media.json and keeps only valid ME SIDs; an invalid message SID is refused', async () => {
    const s = stub([{ status: 200, json: { media_list: [{ sid: 'ME' + 'b'.repeat(32) }, { sid: '../evil' }, { sid: 'ME' + 'c'.repeat(32) }] } }]);
    expect(await tw(s.f).listMessageMedia(account, MM)).toEqual(['ME' + 'b'.repeat(32), 'ME' + 'c'.repeat(32)]);
    expect(s.seen[0]!.url.pathname).toBe(`/2010-04-01/Accounts/${SUB}/Messages/${MM}/Media.json`);
    await expect(tw(stub([]).f).listMessageMedia(account, '../x')).rejects.toBeInstanceOf(ProviderError);
  });

  it('E298: listOutboundMediaMessages filters From and DateSent by day, keeps outbound MM SIDs with media inside the window, and pages with a cap', async () => {
    const t0 = Date.parse('2026-11-12T10:00:00Z');
    const msg = (sid: string, at: number, o: Record<string, unknown> = {}) => ({ sid, date_created: new Date(at).toUTCString(), direction: 'outbound-api', num_media: '1', ...o });
    const inWin = 'MM' + '1'.repeat(32);
    const s = stub([
      { status: 200, json: { messages: [msg(inWin, t0 + 60_000), msg('MM' + '2'.repeat(32), t0 + 30 * 60_000), msg('MM' + '3'.repeat(32), t0, { num_media: '0' }), msg('MM' + '4'.repeat(32), t0, { direction: 'inbound' }), msg('SM' + '5'.repeat(32), t0)], next_page_uri: `/2010-04-01/Accounts/${SUB}/Messages.json?Page=1` } },
      { status: 200, json: { messages: [], next_page_uri: null } },
    ]);
    const r = await tw(s.f).listOutboundMediaMessages(account, { from: '+14155550100', createdFrom: t0 - 60_000, createdTo: t0 + 20 * 60_000 });
    expect(r).toEqual({ refs: [inWin], complete: true });
    const q = s.seen[0]!.url.searchParams;
    expect(q.get('From')).toBe('+14155550100');
    expect(q.get('DateSent>')).toBe('2026-11-12');
    expect(q.get('DateSent<')).toBe('2026-11-12');
    // more pages than the cap: not complete
    const many = stub(Array.from({ length: 5 }, () => ({ status: 200, json: { messages: [], next_page_uri: `/2010-04-01/Accounts/${SUB}/Messages.json?Page=2` } })));
    expect((await tw(many.f).listOutboundMediaMessages(account, { from: '+14155550100', createdFrom: t0, createdTo: t0 + 1 })).complete).toBe(false);
  });
});
