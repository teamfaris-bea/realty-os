// One-click email unsubscribe (RFC 8058) through the Origin allowlist (security-hardening lane).
//
// Marketing email carries `List-Unsubscribe: <https://…/api/email/unsubscribe/{token}>` and
// `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. The mailbox provider (not a browser) POSTs
// `List-Unsubscribe=One-Click` to that URL, with no Origin header, or with its own. The person's
// unsubscribe page posts from the API's public origin, which need not be the web origin. The route's
// only authority is the MAC-signed token in the URL (no cookie, no session), so a cross-site request
// can do nothing the token holder could not: it is exempt from the Origin check, and an opt-out must
// never be blocked by it (owner decision D1: opt-outs always work).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { suFixture } from '../leads/testing.js';
import { signedRef } from './render.js';
import { type CommsWorld, call, commsWorld, ownedContact } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const oneClick = (url: string, headers: Record<string, string> = {}) =>
  h.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, payload: 'List-Unsubscribe=One-Click' });

let ready = false;
async function senderSetup(): Promise<void> {
  if (ready) return;
  const agent = w.agents[0]!;
  h.providers.email.verifiedDomains.add('mail.example.test');
  const dom = await call<{ domain: { id: string } }>(w.owner, 'POST', '/sending-domains', { domain: 'mail.example.test' });
  await call(w.owner, 'POST', `/sending-domains/${dom.body.domain.id}/verify`);
  await call(w.owner, 'POST', '/email-identities', { fromAddress: `agent-${randomUUID().slice(0, 6)}@mail.example.test`, displayName: 'Agent A', userId: agent.userId, domainId: dom.body.domain.id });
  await suFixture(h, [{ text: "UPDATE tenant_settings SET brokerage_postal_address = '1 Main St, Springfield' WHERE tenant_id = $1", values: [w.tenantId] }]);
  ready = true;
}

async function marketingEmail(): Promise<{ contactId: string; path: string }> {
  await senderSetup();
  const agent = w.agents[0]!;
  const c = await ownedContact(agent);
  const sent = await call<{ result: string }>(agent, 'POST', `/contacts/${c.id}/messages`, { channel: 'email', subject: 'Homes you may like', body: 'Three new listings this week.', idempotencyKey: `e-${randomUUID()}` });
  expect(sent.body.result).toBe('sent');
  const mail = h.providers.email.sent.filter((m) => m.to === c.email).at(-1)!;
  const url = new URL(mail.headers!['List-Unsubscribe']!.slice(1, -1));
  return { contactId: c.id, path: url.pathname };
}

const marketingRevoked = async (contactId: string) =>
  (
    await h.su.query(
      `SELECT 1 FROM consent_events
        WHERE tenant_id = $2 AND contact_id = $1 AND channel = 'email' AND purpose = 'marketing' AND event_type = 'revoke'`,
      [contactId, w.tenantId],
    )
  ).rowCount ?? 0;

describe('one-click unsubscribe', () => {
  it('R-CONSENT-18 D1: the mailbox provider’s one-click POST (no Origin header) unsubscribes the person', async () => {
    const m = await marketingEmail();
    const res = await oneClick(m.path);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unsubscribed: true });
    expect(await marketingRevoked(m.contactId)).toBeGreaterThan(0);
  });

  it('D1: a POST from the unsubscribe page itself (the API’s public origin) or a provider origin works too', async () => {
    const m = await marketingEmail();
    expect((await oneClick(m.path, { origin: new URL(h.config.publicBaseUrl).origin })).statusCode).toBe(200);
    const m2 = await marketingEmail();
    expect((await oneClick(m2.path, { origin: 'https://mail.provider.example' })).statusCode).toBe(200);
  });

  it('the exemption gives a forged or tampered token nothing: 404, and no session cookie is ever read', async () => {
    const forged = signedRef(new Uint8Array(32), 'unsubscribe', w.tenantId, randomUUID());
    expect((await oneClick(`/api/email/unsubscribe/${forged}`)).statusCode).toBe(404);
    const wrongMessage = signedRef(h.config.sessionSecret, 'unsubscribe', w.tenantId, randomUUID());
    expect((await oneClick(`/api/email/unsubscribe/${wrongMessage}`)).statusCode).toBe(404);
  });

  it('the exemption is only for routes that declare a capability token; other public routes still need the Origin', async () => {
    const exempt = h.app.platform.routeTable.filter((r) => r.capabilityUrl);
    // module 22: the website-chat start and message routes, whose only authority is the widget key / session token in the URL
    expect(exempt.map((r) => `${r.method} ${r.url}`).sort()).toEqual(['POST /api/email/unsubscribe/:token', 'POST /api/public/chat/:widgetToken/start', 'POST /api/public/chat/session/:token/messages']);
    for (const r of exempt) expect(r.auth).toBe('public');
  });
});
