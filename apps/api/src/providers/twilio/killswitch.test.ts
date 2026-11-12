// R-TWL-1: the telephony kill switch (TELEPHONY_LIVE_REQUESTS). With it off — the default in every environment,
// production included — the Twilio adapter refuses EVERY outbound REST request before making it, with the typed
// provider error TELEPHONY_LIVE_OFF. The injected fetch fails the test if it is ever called, so "no request ever
// happens" is asserted, not inferred. Fixtures are reserved test values only (+1 555 01xx, obviously fake SIDs).
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig, redactConfig } from '../../config.js';
import { createProviders } from '../index.js';
import { ProviderError } from '../types.js';
import { TELEPHONY_LIVE_OFF } from './http.js';
import { TwilioCarrierLookup, TwilioTelephony } from './telephony.js';

const MASTER = 'AC' + '0'.repeat(32);
const SUB = 'AC' + 'f'.repeat(32);
const account = { accountRef: SUB, secret: 'fake-subaccount-token' };
const hex = (c: string) => c.repeat(32);

/** A fetch that must never run: calling it fails the test (and records the call so the assertion is explicit). */
function forbiddenFetch() {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    calls.push(String(input));
    throw new Error(`R-TWL-1 violated: a request left the process: ${String(input)}`);
  }) as typeof fetch;
  return { f, calls };
}

const base = (o: Record<string, string | undefined> = {}) => ({
  DATABASE_URL: 'postgres://app_user:pw@db/realty',
  KEK_BASE64: randomBytes(32).toString('base64'),
  SESSION_SECRET_BASE64: randomBytes(32).toString('base64'),
  ...o,
});

/** every outbound operation of the adapter, each with otherwise valid input */
function everyOperation(t: TwilioTelephony, c: TwilioCarrierLookup): [string, () => Promise<unknown>][] {
  return [
    ['sendSms', () => t.sendSms({ account, from: '+15555550100', to: '+15555550101', body: 'Hi', idempotencyKey: 'k1' })],
    ['dialCall', () => t.dialCall({ account, from: '+15555550100', agentPhone: '+15555550102', to: '+15555550101', idempotencyKey: 'c1', record: false })],
    ['purchaseNumber', () => t.purchaseNumber(account, { areaCode: '555' })],
    ['releaseNumber', () => t.releaseNumber(account, 'PN' + hex('a'))],
    ['lookupMessage', () => t.lookupMessage(account, 'm1', { from: '+15555550100', to: '+15555550101', body: 'Hi', dispatchedAt: 1_794_300_000_000 })],
    ['senderRegistrationStatus (toll-free)', () => t.senderRegistrationStatus(account, 'HH' + hex('b'))],
    ['senderRegistrationStatus (10DLC)', () => t.senderRegistrationStatus(account, `MG${hex('c')}/QE${hex('d')}`)],
    ['fetchMedia', () => t.fetchMedia(account, { messageRef: 'MM' + hex('e'), mediaRef: 'ME' + hex('1') })],
    ['deleteMedia', () => t.deleteMedia(account, { messageRef: 'MM' + hex('e'), mediaRef: 'ME' + hex('1') })],
    ['fetchRecording', () => t.fetchRecording(account, 'RE' + hex('2'))],
    ['deleteRecording', () => t.deleteRecording(account, 'RE' + hex('2'))],
    ['createSubaccount', () => t.createSubaccount('tenant', 'tenant-0001')],
    ['deliverVerificationCode', () => t.deliverVerificationCode({ to: '+15555550101', code: '123456' })],
    ['carrier lookup', () => c.lookup('+15555550101')],
  ];
}

describe('R-TWL-1 telephony kill switch: the Twilio adapter', () => {
  for (const [label, live] of [['absent (fail closed)', undefined], ['false', false]] as const) {
    it(`R-TWL-1: with liveRequests ${label}, every outbound REST request is refused before it is made (TELEPHONY_LIVE_OFF)`, async () => {
      const ff = forbiddenFetch();
      const opts = { accountSid: MASTER, authToken: 'fake-master-token', publicBaseUrl: 'https://api.example.test', platformSender: '+15555550199', fetch: ff.f, sleep: async () => undefined, ...(live === undefined ? {} : { liveRequests: live }) };
      const ops = everyOperation(new TwilioTelephony(opts), new TwilioCarrierLookup(opts));
      expect(ops.length).toBeGreaterThanOrEqual(14);
      for (const [name, op] of ops) {
        const e = await op().then(() => null, (x: unknown) => x);
        expect(e, name).toBeInstanceOf(ProviderError);
        expect(e, name).toMatchObject({ kind: 'not_configured', providerCode: TELEPHONY_LIVE_OFF });
      }
      expect(ff.calls).toEqual([]);
    });
  }

  it('R-TWL-1: createProviders wires the switch: TELEPHONY_PROVIDER=twilio with the default config makes no request at all', async () => {
    const ff = forbiddenFetch();
    const c = loadConfig(base({ TELEPHONY_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: MASTER, TWILIO_AUTH_TOKEN: 'fake-master-token-0000' }));
    expect(c.telephonyLiveRequests).toBe(false);
    const p = createProviders(c, { clock: { now: () => 0 as never }, fetch: ff.f });
    await expect(p.telephony.sendSms({ account, from: '+15555550100', to: '+15555550101', body: 'x', idempotencyKey: 'k' })).rejects.toMatchObject({ providerCode: TELEPHONY_LIVE_OFF });
    await expect(p.carrier.lookup('+15555550101')).rejects.toMatchObject({ providerCode: TELEPHONY_LIVE_OFF });
    expect(ff.calls).toEqual([]);
  });

  it('R-TWL-1: only TELEPHONY_LIVE_REQUESTS=true turns it on; the switch reaches the adapter (the request is then attempted)', async () => {
    const ff = forbiddenFetch();
    const c = loadConfig(base({ TELEPHONY_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: MASTER, TWILIO_AUTH_TOKEN: 'fake-master-token-0000', TELEPHONY_LIVE_REQUESTS: 'true' }));
    expect(c.telephonyLiveRequests).toBe(true);
    const p = createProviders(c, { clock: { now: () => 0 as never }, fetch: ff.f });
    await expect(p.telephony.sendSms({ account, from: '+15555550100', to: '+15555550101', body: 'x', idempotencyKey: 'k' })).rejects.toBeInstanceOf(ProviderError);
    expect(ff.calls).toHaveLength(1); // proves the off-state test above is meaningful: the same path WOULD fetch
  });
});

describe('R-TWL-1 telephony kill switch: configuration', () => {
  it('R-TWL-1: TELEPHONY_LIVE_REQUESTS defaults to false in development, test and production, and is in the start-up log view', () => {
    expect(loadConfig(base()).telephonyLiveRequests).toBe(false);
    expect(loadConfig(base({ NODE_ENV: 'test' })).telephonyLiveRequests).toBe(false);
    expect(loadConfig(base({ TELEPHONY_LIVE_REQUESTS: 'false' })).telephonyLiveRequests).toBe(false);
    expect(redactConfig(loadConfig(base())).telephonyLiveRequests).toBe(false);
    expect(redactConfig(loadConfig(base({ TELEPHONY_LIVE_REQUESTS: 'true' }))).telephonyLiveRequests).toBe(true);
  });

  it('R-TWL-1: anything but true or false is refused at start-up, by name, without echoing the value', () => {
    for (const v of ['1', 'yes', 'enable-now', 'TRUE-ish']) {
      let msg = '';
      try {
        loadConfig(base({ TELEPHONY_LIVE_REQUESTS: v }));
      } catch (e) {
        msg = String(e);
      }
      expect(msg).toContain('TELEPHONY_LIVE_REQUESTS');
      expect(msg).not.toContain(v);
    }
  });
});
