// R-TWL-6 (lane telephony-safeguards S2): a logged request never contains X-Twilio-Signature. The server's pino redact
// paths are one exported constant (server.ts LOG_REDACT_PATHS) that names the signature on request, response and bare
// header objects; this test drives real webhook requests at the most verbose level and logs header-bearing objects
// directly, and the signature never appears in any line.
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { telephonySignature } from '../providers/webhooks.js';
import { LOG_REDACT_PATHS } from '../server.js';

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'trace' });
});
afterAll(async () => {
  await h?.close();
});

describe('R-TWL-6 X-Twilio-Signature is redacted from logs', () => {
  it('R-TWL-6: LOG_REDACT_PATHS names the signature on req, res and bare headers (plus the existing credentials)', () => {
    for (const p of ['req.headers["x-twilio-signature"]', 'res.headers["x-twilio-signature"]', 'headers["x-twilio-signature"]', 'req.headers.authorization', 'headers["x-api-key"]']) {
      expect(LOG_REDACT_PATHS).toContain(p);
    }
  });

  it('R-TWL-6: the redact list censors a header-bearing object a handler might log (Fastify\'s pino with exactly these paths)', async () => {
    const lines: string[] = [];
    const app = Fastify({ logger: { level: 'info', stream: { write: (l: string) => void lines.push(l) }, redact: { paths: [...LOG_REDACT_PATHS], censor: '[redacted]' } } });
    const log = app.log;
    const sig = 'c2lnbmF0dXJlLXZhbHVlLWZvci10ZXN0cw==';
    log.info({ req: { headers: { 'x-twilio-signature': sig } } }, 'a');
    log.info({ res: { headers: { 'x-twilio-signature': sig } } }, 'b');
    log.info({ headers: { 'x-twilio-signature': sig } }, 'c');
    expect(lines).toHaveLength(3);
    // req/res objects pass Fastify's serializers (no headers survive); a bare header object is censored by path
    for (const l of lines) expect(l).not.toContain(sig);
    expect(lines[2]).toContain('"x-twilio-signature":"[redacted]"');
    await app.close();
  });

  it('R-TWL-6: signed (and mis-signed) webhook requests at trace level leave no signature in any log line', async () => {
    const params = { MessageSid: 'SM' + '7'.repeat(32), From: '+15555550111', To: '+15555550112', Body: 'hi', NumMedia: '0' };
    const url = new URL('/api/webhooks/telephony/sms', h.config.publicBaseUrl).toString();
    const good = telephonySignature(h.config.webhookSecrets.telephony, url, params);
    const bad = 'Zm9yZ2VkLXNpZ25hdHVyZS10aGF0LWlzLWxvbmc=';
    for (const sig of [good, bad]) {
      const r = await h.app.inject({ method: 'POST', url: '/api/webhooks/telephony/sms', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, payload: new URLSearchParams(params).toString() });
      expect([200, 403]).toContain(r.statusCode);
    }
    h.app.log.warn({ headers: { 'x-twilio-signature': good } }, 'handler logged headers');
    expect(h.logs.length).toBeGreaterThan(0);
    for (const l of h.logs) {
      expect(l).not.toContain(good);
      expect(l).not.toContain(bad);
    }
  });
});
