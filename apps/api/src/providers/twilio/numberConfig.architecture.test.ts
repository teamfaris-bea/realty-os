// R-TWL-5 (lane telephony-safeguards S2): no code path updates an existing number at Twilio. The owner's existing
// numbers are routed to other webhooks and must never be changed. Two proofs:
//   1 source scan of every non-test file of apps/api, packages and scripts: the only reference to Twilio's
//     IncomingPhoneNumbers resource is number purchase (POST IncomingPhoneNumbers.json) and release (DELETE
//     IncomingPhoneNumbers/{PN}.json), and number-configuration fields (SmsUrl, VoiceUrl, fallbacks, application SIDs,
//     a number's StatusCallback) are written only by purchase, which the kill switch blocks while off (R-TWL-1);
//   2 every operation of the adapter, driven with a recording fetch: no request ever targets
//     IncomingPhoneNumbers/{sid} with anything but DELETE.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TwilioTelephony } from './telephony.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return ['node_modules', 'dist', '__snapshots__', '.git', 'coverage'].includes(n) ? [] : sourceFiles(p);
    return /\.(ts|tsx|mjs|js|cjs)$/.test(n) && !/\.test\.tsx?$/.test(n) && !n.endsWith('.d.ts') ? [p] : [];
  });
}
const files = () => ['apps/api/src', 'apps/web/src', 'packages', 'scripts'].flatMap((d) => sourceFiles(join(REPO, d))).map((f) => relative(REPO, f).replaceAll('\\', '/'));

/** Twilio IncomingPhoneNumber configuration fields (the ones that re-point a number). */
const NUMBER_CONFIG_FIELD = /\b(SmsUrl|SmsMethod|SmsFallbackUrl|SmsFallbackMethod|SmsApplicationSid|VoiceUrl|VoiceMethod|VoiceFallbackUrl|VoiceFallbackMethod|VoiceApplicationSid|VoiceReceiveMode|TrunkSid|EmergencyAddressSid|BundleSid)\s*:/;
const ADAPTER = 'apps/api/src/providers/twilio/telephony.ts';

/** The source text of one method of the adapter (from its name to the next method). */
function methodBody(src: string, name: string): string {
  const start = src.indexOf(`  async ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const next = src.indexOf('\n  async ', start + 10);
  return src.slice(start, next === -1 ? undefined : next);
}

describe('R-TWL-5 no code path writes number configuration at Twilio', () => {
  it('R-TWL-5: IncomingPhoneNumbers is referenced only by purchase (POST IncomingPhoneNumbers.json) and release (DELETE …/{PN}.json)', () => {
    const hits = files().filter((f) => readFileSync(join(REPO, f), 'utf8').includes('IncomingPhoneNumbers'));
    expect(hits).toEqual([ADAPTER]);
    const src = readFileSync(join(REPO, ADAPTER), 'utf8');
    const uses = [...src.matchAll(/this\.http\.request\(c, '(GET|POST|DELETE)', this\.acct\(c\.sid, [`']IncomingPhoneNumbers(\.json|\/)/g)].map((m) => `${m[1]} IncomingPhoneNumbers${m[2]}`);
    expect(uses).toEqual(['POST IncomingPhoneNumbers.json', 'DELETE IncomingPhoneNumbers/']);
    // every textual mention is one of those two, or a comment
    const mentions = src.split('\n').filter((l) => l.includes('IncomingPhoneNumbers') && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    expect(mentions).toHaveLength(2);
    expect(methodBody(src, 'purchaseNumber')).toContain("'POST', this.acct(c.sid, 'IncomingPhoneNumbers.json')");
    expect(methodBody(src, 'releaseNumber')).toContain("'DELETE'");
  });

  it('R-TWL-5: number-configuration fields (SmsUrl, VoiceUrl, fallbacks, application SIDs …) are written only inside purchaseNumber', () => {
    const offenders: string[] = [];
    for (const f of files()) {
      const src = readFileSync(join(REPO, f), 'utf8');
      if (f === ADAPTER) {
        const outside = src.replace(methodBody(src, 'purchaseNumber'), '');
        if (NUMBER_CONFIG_FIELD.test(outside)) offenders.push(`${f} (outside purchaseNumber)`);
      } else if (NUMBER_CONFIG_FIELD.test(src) && /twilio|IncomingPhone/i.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
    // a number's StatusCallback is set only at purchase; the other StatusCallback writes are per message / per call
    const src = readFileSync(join(REPO, ADAPTER), 'utf8');
    const statusCallbackMethods = ['purchaseNumber', 'sendSms', 'dialCall'];
    const rest = statusCallbackMethods.reduce((s, m) => s.replace(methodBody(s, m), ''), src);
    expect(/\bStatusCallback\s*:/.test(rest)).toBe(false);
    expect(methodBody(src, 'sendSms')).toContain("'Messages.json'");
    expect(methodBody(src, 'dialCall')).toContain("'Calls.json'");
  });

  it('R-TWL-5: driving every adapter operation (switch on, mocked HTTP), no request targets IncomingPhoneNumbers/{sid} except a DELETE', async () => {
    const seen: { method: string; url: string }[] = [];
    const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ method: init?.method ?? 'GET', url });
      if (url.includes('AvailablePhoneNumbers')) return ok({ available_phone_numbers: [{ phone_number: '+15555550177' }] });
      if (url.includes('IncomingPhoneNumbers.json')) return ok({ sid: 'PN' + 'a'.repeat(32), phone_number: '+15555550177' });
      if (url.includes('Messages.json') && init?.method === 'POST') return ok({ sid: 'SM' + 'b'.repeat(32), status: 'queued' });
      if (url.includes('Calls.json')) return ok({ sid: 'CA' + 'c'.repeat(32) });
      if (url.endsWith('Accounts.json')) return ok({ sid: 'AC' + 'd'.repeat(32), auth_token: 'tok' });
      if (url.includes('Recordings/') && url.endsWith('.wav')) return new Response(new Uint8Array([1, 2]), { status: 200 });
      return ok({ messages: [], status: 'TWILIO_APPROVED', campaign_status: 'VERIFIED', duration: '3', line_type_intelligence: { type: 'mobile' } });
    }) as typeof fetch;
    const t = new TwilioTelephony({ accountSid: 'AC' + '0'.repeat(32), authToken: 'fake-master', publicBaseUrl: 'https://api.example.test', platformSender: '+15555550199', fetch: f, sleep: async () => undefined, liveRequests: true });
    const account = { accountRef: 'AC' + 'f'.repeat(32), secret: 'fake-sub' };
    const hex = (c: string) => c.repeat(32);
    await t.createSubaccount('t', 'x');
    await t.sendSms({ account, from: '+15555550100', to: '+15555550101', body: 'x', idempotencyKey: 'k' });
    await t.dialCall({ account, from: '+15555550100', agentPhone: '+15555550102', to: '+15555550101', idempotencyKey: 'c', record: false });
    await t.lookupMessage(account, 'm', { from: '+15555550100', to: '+15555550101', body: 'x', dispatchedAt: Date.now() });
    await t.purchaseNumber(account, {});
    await t.releaseNumber(account, 'PN' + hex('a'));
    await t.senderRegistrationStatus(account, 'HH' + hex('b'));
    await t.senderRegistrationStatus(account, `MG${hex('c')}/QE${hex('d')}`);
    await t.fetchMedia(account, { messageRef: 'MM' + hex('e'), mediaRef: 'ME' + hex('1') });
    await t.deleteMedia(account, { messageRef: 'MM' + hex('e'), mediaRef: 'ME' + hex('1') });
    await t.fetchRecording(account, 'RE' + hex('2'));
    await t.deleteRecording(account, 'RE' + hex('2'));
    await t.deliverVerificationCode({ to: '+15555550101', code: '123456' });
    const onNumbers = seen.filter((r) => /IncomingPhoneNumbers\/PN/.test(r.url));
    expect(onNumbers.map((r) => r.method)).toEqual(['DELETE']);
    expect(seen.filter((r) => r.url.includes('IncomingPhoneNumbers')).map((r) => `${r.method} ${new URL(r.url).pathname.split('/').pop()}`)).toEqual(['POST IncomingPhoneNumbers.json', `DELETE PN${hex('a')}.json`]);
  });
});
