// Adversarial tests of module 22's public chat routes and its tenancy (R-TEN-12, R-TEN-3, R-INBOX-5, R-PERM-5):
// forged widget keys, another team's key, wrong websites, oversized bodies, replay, header and control-character
// injection, rate limits, credential-less CORS, and cross-tenant isolation of every new route. Fakes only.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AssistantWorld, assistantWorld, call } from '../assistant/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { chatSpamReason, claimOf, originAllowed, parseCursor } from './webchat.js';
import { acceptLead, chatMessage, chatPoll, chatSource, codeOf, createWidget, openChat, SITE, startChat, visitorIp } from './testing.js';

let h: ApiHarness;
let a: AssistantWorld;
let b: AssistantWorld;
let srcA: { sourceId: string; disclosureId: string };
let srcB: { sourceId: string; disclosureId: string };
let wa: { id: string; key: string };
let wb: { id: string; key: string };

beforeAll(async () => {
  h = await createApiHarness();
  a = await assistantWorld(h, { agents: 2 });
  b = await assistantWorld(h, { agents: 1 });
  srcA = await chatSource(h, a.owner, a.tenantId);
  srcB = await chatSource(h, b.owner, b.tenantId);
  wa = await createWidget(h, a.owner, srcA.sourceId, [SITE]);
  wb = await createWidget(h, b.owner, srcB.sourceId, ['https://other-team.test']);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const start = (key: string, body: Record<string, unknown>, o: { origin?: string | null; ip?: string } = {}) => startChat(h, key, { name: 'Vee', phone: '+14155550123', message: 'Hello', disclosureId: srcA.disclosureId, ...body }, o);

describe('R-TEN-12 forged and foreign widget keys', () => {
  it('R-TEN-12: malformed keys, unknown keys of the right shape and keys with SQL in them are 404 and resolve nothing', async () => {
    for (const k of ['x', 'wk_' + '0'.repeat(40), "wk_' OR 1=1 --", 'wk_' + 'g'.repeat(40), wa.key.toUpperCase(), wa.key + '0']) {
      const r = await start(encodeURIComponent(k), {});
      expect([k, r.statusCode]).toEqual([k, 404]);
    }
  });

  it('R-TEN-12 R-TEN-3: another team\'s key on this team\'s website is 404 (its allowed origins), and with its own website it still cannot use this team\'s disclosure: no tenant can be named by the body', async () => {
    expect((await start(wb.key, {}, { origin: SITE })).statusCode).toBe(404);
    const r = await start(wb.key, { disclosureId: srcA.disclosureId }, { origin: 'https://other-team.test' });
    expect([r.statusCode, codeOf(r)]).toEqual([409, 'WEBCHAT_DISCLOSURE_STALE']);
    const injected = await start(wa.key, { tenantId: b.tenantId });
    expect(injected.statusCode).toBe(422);
    expect((await start(wa.key, {}, { origin: null })).statusCode).toBe(404); // a widget with allowed origins needs one
  });
});

describe('R-INBOX-5 hostile bodies', () => {
  it('R-INBOX-5: oversized bodies are 413 before parsing; control characters, CRLF header injection, both a phone and an email, or no claim are 422', async () => {
    const big = await startChat(h, wa.key, JSON.stringify({ name: 'Vee', phone: '+14155550123', message: 'x'.repeat(20_000), disclosureId: srcA.disclosureId }));
    expect(big.statusCode).toBe(413);
    for (const body of [
      { name: 'Vee\r\nBcc: victim@example.test' },
      { name: 'Vee\u0000' },
      { name: 'Vee‮' },
      { message: 'hello\u0007' },
      { phone: undefined, email: 'a@b.test\r\nBcc: x@y.test' },
      { email: 'vee@example.test' },
      { phone: undefined },
      { message: 'x'.repeat(2001) },
    ]) {
      const r = await start(wa.key, body);
      expect([JSON.stringify(body).slice(0, 60), r.statusCode]).toEqual([JSON.stringify(body).slice(0, 60), 422]);
    }
  });

  it('R-INBOX-5: per-session message limits cut a flood off with 429; nothing past the limit is stored', async () => {
    const c = await openChat(h, wa.key, srcA.disclosureId, { name: 'Flo Flood' });
    const ip = visitorIp();
    const codes: number[] = [];
    for (let i = 0; i < 24; i++) codes.push((await chatMessage(h, c.token, { message: `msg ${i}`, clientMessageId: randomUUID() }, { ip })).statusCode);
    expect(codes.filter((s) => s === 200)).toHaveLength(20);
    expect(codes.slice(20).every((s) => s === 429)).toBe(true);
    expect((await h.su.query("SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'inbound'", [c.contactId])).rows[0].n).toBe(21);
  });

  it('R-TEN-12: a malformed poll cursor is 422; a forged session token is 404; the poll returns only id, body, time and author', async () => {
    const c = await openChat(h, wa.key, srcA.disclosureId, { name: 'Pol Poll' });
    expect((await chatPoll(h, c.token, 'not-a-cursor')).statusCode).toBe(422);
    expect((await chatPoll(h, 'A'.repeat(43))).statusCode).toBe(404);
    expect((await chatPoll(h, "x' OR '1'='1")).statusCode).toBe(404);
    const agent = await acceptLead(h, a.agents, c.contactId);
    await call(agent, 'POST', `/contacts/${c.contactId}/messages`, { channel: 'web_chat', body: 'Hi Pol', idempotencyKey: `c-${randomUUID()}` });
    const p = JSON.parse((await chatPoll(h, c.token)).body) as { messages: Record<string, unknown>[] };
    expect(Object.keys(p.messages[0]!).sort()).toEqual(['body', 'from', 'id', 'sentAt']);
    expect(JSON.stringify(p)).not.toContain(a.tenantId);
    expect(JSON.stringify(p)).not.toContain(c.contactId);
  });
});

describe('credential-less CORS on the public chat routes only', () => {
  it('a preflight from any website is allowed without credentials on /public/chat; staff routes keep the web-origin allowlist', async () => {
    const pre = await h.app.inject({ method: 'OPTIONS', url: `/api/public/chat/${wa.key}/start`, headers: { origin: 'https://random.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    expect(pre.headers['access-control-allow-origin']).toBe('https://random.example');
    expect(pre.headers['access-control-allow-credentials']).toBeUndefined();
    const staff = await h.app.inject({ method: 'OPTIONS', url: '/api/admin/web-chat/widgets', headers: { origin: 'https://random.example', 'access-control-request-method': 'POST' } });
    expect(staff.headers['access-control-allow-origin']).not.toBe('https://random.example');
  });
});

describe('R-PERM-5 R-TEN-3 cross-tenant isolation of every new route', () => {
  it('R-PERM-5: team B never sees team A\'s chat contact, sessions or widgets, and cannot rotate, re-origin or reply through them', async () => {
    const c = await openChat(h, wa.key, srcA.disclosureId, { name: 'Tess Tenant' });
    expect((await call(b.owner, 'GET', `/contacts/${c.contactId}`)).status).toBe(404);
    expect((await call(b.agents[0]!, 'POST', `/contacts/${c.contactId}/messages`, { channel: 'web_chat', body: 'x', idempotencyKey: `c-${randomUUID()}` })).status).toBe(404);
    const list = await call<{ widgets: { id: string }[] }>(b.owner, 'GET', '/admin/web-chat/widgets');
    expect(list.body.widgets.map((x) => x.id)).toEqual([wb.id]);
    expect((await call(b.owner, 'POST', `/admin/web-chat/widgets/${wa.id}/rotate`)).status).toBe(404);
    expect((await call(b.owner, 'PUT', `/admin/web-chat/widgets/${wa.id}/origins`, { allowedOrigins: [] })).status).toBe(404);
    expect((await call(b.owner, 'POST', '/admin/web-chat/widgets', { displayName: 'steal', leadSourceId: srcA.sourceId })).status).toBe(404);
    // the sessions table is system-only until linked, and then visible only through the contact (staff of A)
    const visible = await withTenantTx(b.owner.actor(), async (tx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM webchat_sessions`.execute(tx)).rows[0]!.n, { db: h.database });
    expect(visible).toBe(0);
    const own = await withTenantTx(a.agents[0]!.actor(), async (tx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM webchat_sessions WHERE contact_id IS NULL`.execute(tx)).rows[0]!.n, { db: h.database });
    expect(own).toBe(0);
  });
});

describe('decision functions (property tests)', () => {
  it('R-INBOX-5: the spam check never flags a plain sentence and a plain name; it flags link floods and names that are links or addresses', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Z][a-z]{1,10}( [A-Z][a-z]{1,12})?$/), fc.stringMatching(/^[A-Za-z ,.?!']{1,200}$/), (name, msg) => {
        if (msg.trim() === '' || /(.)\1{29,}/.test(msg)) return;
        expect(chatSpamReason({ name, message: msg })).toBeNull();
      }),
    );
    expect(chatSpamReason({ name: 'Vee', message: 'see http://a.test http://b.test http://c.test' })).toBe('LINKS');
    expect(chatSpamReason({ name: 'www.casino.com', message: 'hi' })).toBe('NAME_NOT_A_NAME');
    expect(chatSpamReason({ name: 'a@b.c', message: 'hi' })).toBe('NAME_NOT_A_NAME');
    expect(chatSpamReason({ name: 'Vee', message: 'a'.repeat(40) })).toBe('REPEATED');
  });

  it('R-INBOX-1: a claim is exactly one valid phone or email, never both, never with line breaks', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (p, e) => {
        expect(claimOf({ phone: p, email: e })).toBeNull();
        const em = claimOf({ email: `${e}\n` });
        expect(em).toBeNull();
      }),
    );
    expect(claimOf({ email: 'Vee@Example.TEST' })).toEqual({ kind: 'email', address: 'vee@example.test' });
  });

  it('R-INBOX-7: origins: an allowlist matches exactly; no allowlist accepts any; cursors parse only their own shape', () => {
    fc.assert(
      fc.property(fc.webUrl(), (u) => {
        const o = new URL(u).origin.toLowerCase();
        expect(originAllowed([o], o)).toBe(true);
        expect(originAllowed([o], null)).toBe(false);
        expect(originAllowed([], null)).toBe(true);
        expect(originAllowed(['https://only.test'], o === 'https://only.test' ? 'https://x.test' : o)).toBe(false);
      }),
    );
    fc.assert(fc.property(fc.string(), (s) => {
      const c = parseCursor(s);
      if (c !== null && c !== 'invalid') expect(`${c.us}.${c.id}`).toBe(s);
    }));
  });
});
