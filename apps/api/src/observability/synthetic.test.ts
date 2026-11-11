// The synthetic production check against a real listening API (fake providers, real Postgres): it
// passes end to end, and every failure names the step and a plain reason.
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, TEST_ORIGIN, TEST_PASSWORD, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, commsWorker, commsWorld, inboundSms, ownedContact } from '../comms/testing.js';
import { runSynthetic, syntheticOptionsFromEnv } from './synthetic.js';

let h: ApiHarness;
let w: CommsWorld;
let base = '';
let pump: NodeJS.Timeout | undefined;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h);
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  clearInterval(pump);
  await h?.close();
});

/** Runs the comms worker in the background (what the production worker does). */
function startWorker(): () => void {
  const worker = commsWorker(h);
  let busy = false;
  pump = setInterval(() => {
    if (busy) return;
    busy = true;
    h.su
      .query(`UPDATE jobs SET run_at = now() WHERE tenant_id = $1 AND kind = 'comms.dispatch' AND status = 'pending' AND run_at > now()`, [w.tenantId])
      .then(() => worker.tick())
      .catch(() => undefined)
      .finally(() => (busy = false));
  }, 50);
  return () => clearInterval(pump);
}

const opts = (contactId: string, extra: Partial<Parameters<typeof runSynthetic>[0]> = {}) => ({ baseUrl: base, origin: TEST_ORIGIN, email: w.agents[0]!.email, password: TEST_PASSWORD, contactId, pollMs: 100, ...extra });

describe('pnpm ops:synthetic', () => {
  it('signs in, loads the feed, sends one text that the provider accepts, and signs out', async () => {
    const c = await ownedContact(w.agents[0]!);
    const before = h.providers.telephony.sms.length;
    const stop = startWorker();
    try {
      const r = await runSynthetic(opts(c.id, { sendTimeoutMs: 20_000 }));
      expect(r.reason).toBeNull();
      expect(r.ok).toBe(true);
      expect(r.steps.map((s) => s.step)).toEqual(['ready', 'login', 'feed', 'send', 'accepted', 'logout']);
      expect(r.steps.every((s) => s.ok)).toBe(true);
      expect(h.providers.telephony.sms.length).toBe(before + 1);
    } finally {
      stop();
    }
  });

  it('a blocked send fails with the reason (the test contact opted out); D1 is never bypassed', async () => {
    const c = await ownedContact(w.agents[0]!);
    await inboundSms(h, c.phone, w.mainNumber, 'STOP');
    const r = await runSynthetic(opts(c.id));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^send: the send was blocked \(.+\); check the test contact is not opted out$/);
    expect(r.steps.at(-1)).toMatchObject({ step: 'logout', ok: true });
  });

  it('a message that is never accepted fails with a timeout that says so', async () => {
    const c = await ownedContact(w.agents[0]!);
    // the provider never confirms: the timeline keeps showing the message as queued
    const stuck: typeof fetch = async (input, init) => {
      const r = await fetch(input, init);
      if (!String(input).includes('/timeline')) return r;
      const j = (await r.json()) as { items: { status: string | null }[] };
      return new Response(JSON.stringify({ ...j, items: j.items.map((i) => ({ ...i, status: 'queued' })) }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const r = await runSynthetic(opts(c.id, { sendTimeoutMs: 400, fetch: stuck }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('accepted: the message was still queued after 0.4 s (is the worker running?)');
  });

  it('a wrong password fails at sign-in; an unreachable API fails at readiness', async () => {
    const c = await ownedContact(w.agents[0]!);
    const bad = await runSynthetic(opts(c.id, { password: 'wrong password here' }));
    expect(bad.reason).toBe('login: sign-in refused (HTTP 401, LOGIN_FAILED)');
    const down = await runSynthetic(opts(c.id, { baseUrl: 'http://127.0.0.1:1' }));
    expect(down.reason).toMatch(/^ready: could not reach the API/);
  });

  it('reports missing configuration by variable name', () => {
    expect(syntheticOptionsFromEnv({})).toEqual({ ok: false, missing: ['SYNTHETIC_BASE_URL', 'SYNTHETIC_EMAIL', 'SYNTHETIC_PASSWORD', 'SYNTHETIC_CONTACT_ID'] });
    const ok = syntheticOptionsFromEnv({ SYNTHETIC_BASE_URL: 'https://x.test', SYNTHETIC_EMAIL: 'a@x.test', SYNTHETIC_PASSWORD: 'p', SYNTHETIC_CONTACT_ID: 'c', SYNTHETIC_CHANNEL: 'email' });
    expect(ok.ok && ok.options.channel).toBe('email');
  });
});
