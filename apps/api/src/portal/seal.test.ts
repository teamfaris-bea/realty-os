// b14 audit F2 (orchestrator decision (a), a flagged module-22 edit; R-PORTAL-11, E684): the sign-in URL never enters
// messages.body. The message stores a fixed line; the URL lives in a sealed side record (portal_link_seals, migration
// 0242: definer-only, envelope-encrypted with the message id in the AAD) that comms/dispatch.ts reads as the system
// at providerSend and in reconcileOutbound, and that goes at the first final status, after 15 minutes, and with the
// message (an erasure). Fakes only; platform:portal is cleared in the per-test database inside try/finally.
import { requestPortalLogin, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshReauth } from '../admin/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { dispatchOutbound, reconcileOutbound, renderSealedLink } from '../comms/dispatch.js';
import { depsFromPlatform } from '../comms/runtime.js';
import type { CommsDeps } from '../comms/types.js';
import type { EmailRequest, SubmitHint, TelephonyAccount } from '../providers/types.js';
import { systemActor } from '../worker/systemActor.js';
import { portalLinkUrl } from './shared/copy.js';
import { deliverLinks, linkBackstopInTx, linkExpireInTx } from './signin/links.js';
import { TOKEN_RE, askLink, call, client, deal, invite, lastToken, portalWorld, setPortalCleared, slugOf, type PortalWorld } from './testing.js';

let h: ApiHarness;
let w: PortalWorld;
let slug: string;
let ipSeq = 0;
const ip = () => `198.51.100.${(++ipSeq % 200) + 20}`;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await portalWorld(h);
  slug = await slugOf(h, w.tenantId);
  await setPortalCleared(h, true);
}, 240_000);
afterAll(async () => {
  try {
    await setPortalCleared(h, false);
  } finally {
    await h?.close();
  }
});

async function invited(firstName: string, o: { byText?: boolean } = {}) {
  const c = await client(w.agents[0]!, { firstName });
  const dealId = await deal(w.agents[0]!, c.id);
  const inv = await invite(w.agents[0]!, dealId, c.id);
  if (inv.status !== 200) throw new Error(`invite ${inv.status} ${JSON.stringify(inv.body)}`);
  if (o.byText) {
    const phonePoint = (await h.su.query<{ id: string }>(`SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone'`, [c.id])).rows[0]!.id;
    const r = await call(w.agents[0]!, 'POST', `/portal-accounts/${inv.body.account.id}/login-point`, { pointId: phonePoint });
    if (r.status !== 200) throw new Error(`login point ${r.status}`);
  }
  return { ...c, dealId, accountId: inv.body.account.id };
}
type Row = { id: string; status: string; status_reason: string | null; body: string; channel: string };
const linkRows = async (contactId: string) =>
  (await h.su.query<Row>(`SELECT id, status, status_reason, body, channel FROM messages WHERE action_category = 'portal_login_link' AND contact_id = $1 ORDER BY created_at`, [contactId])).rows;
const rowOf = async (id: string) => (await h.su.query<Row>('SELECT id, status, status_reason, body, channel FROM messages WHERE id = $1', [id])).rows[0];
const seals = async (messageId: string) => Number((await h.su.query<{ n: string }>('SELECT count(*) AS n FROM portal_link_seals WHERE message_id = $1', [messageId])).rows[0]!.n);
/** The stored body holds neither the link nor its token. */
function expectNoLink(body: string, token?: string | null) {
  expect(body).not.toMatch(/#token=/);
  expect(body).not.toMatch(/portal\.html/);
  if (token) expect(body).not.toContain(token);
}
const sys = () => systemActor(w.tenantId, 'worker');
const deps = () => depsFromPlatform(h.app.platform);
const origin = () => h.app.platform.config.webOrigins[0]!;

/**
 * Comms deps whose email provider awaits `before(args)` ahead of every call: a slow or held provider for one dispatch.
 * Generic (a Proxy over every method), so it names no outbound method: R-GATE-2's lint rule covers tests too.
 */
function heldEmail(before: (args: unknown[]) => Promise<void>): CommsDeps {
  const d = deps();
  const email = new Proxy(h.providers.email, {
    get: (t, p, r) => {
      const v: unknown = Reflect.get(t, p, r);
      return typeof v === 'function'
        ? async (...a: unknown[]) => {
            await before(a);
            return (v as (...x: unknown[]) => unknown).apply(t, a);
          }
        : v;
    },
  });
  return { ...d, providers: { ...d.providers, email } };
}
const quiet = { warn: () => {}, error: () => {} };

describe('b14 F2: the sign-in URL never enters messages.body (R-PORTAL-11, E684)', () => {
  it('F2 R-PORTAL-11: the provider gets the stored line with the full link rendered after it; the body holds no link while dispatching or once sent; the seal goes at the final status', async () => {
    const c = await invited('Nora');
    const during: Row[] = [];
    const links = await requestPortalLogin(slug, c.email, { db: h.database });
    expect(links).toHaveLength(1);
    await deliverLinks({ comms: heldEmail(async ([r]) => void during.push((await rowOf((r as EmailRequest).idempotencyKey))!)), webOrigin: origin(), log: quiet }, links);
    const mail = h.providers.email.sent.filter((m) => m.to === c.email).at(-1)!;
    const token = TOKEN_RE.exec(mail.text)![1]!;
    const [m] = await linkRows(c.id);
    expect(during.map((x) => x.status)).toEqual(['dispatching']);
    expectNoLink(during[0]!.body, token);
    expect(m!.status).toBe('sent');
    expectNoLink(m!.body, token);
    expect(m!.body).toContain("sign-in link for Nora's client portal");
    expect(mail.text).toBe(renderSealedLink(m!.body, portalLinkUrl(origin(), token), 'email'));
    expect(await seals(m!.id)).toBe(0);
    // search never indexed the token (0032's trigger tokenizes the body)
    const hits = await h.su.query(`SELECT 1 FROM message_search_tokens WHERE message_id = $1 AND token ILIKE $2`, [m!.id, `%${token.slice(0, 12).toLowerCase()}%`]);
    expect(hits.rowCount).toBe(0);
  });

  it('F2: the worker wins TX1 (the queued comms.dispatch) and the inline dispatch returns at once: the body holds no link while queued, while the worker is sending, or once sent; the link reaches the client once', async () => {
    const c = await invited('Wren');
    const before = h.providers.email.sent.length;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: Row[] = [];
    let worker: Promise<unknown> | null = null;
    try {
      const links = await requestPortalLogin(slug, c.email, { db: h.database });
      expect(links).toHaveLength(1);
      await deliverLinks({
        comms: deps(),
        webOrigin: origin(),
        log: quiet,
        beforeInlineDispatch: async (messageId) => {
          seen.push((await rowOf(messageId))!);
          // the worker's comms.dispatch takes TX1 first and is held inside the provider send
          worker = dispatchOutbound(messageId, heldEmail(() => gate), { tenantId: w.tenantId });
          for (let i = 0; i < 200 && (await rowOf(messageId))!.status !== 'dispatching'; i++) await new Promise((r) => setTimeout(r, 10));
        },
      }, links);
      // the inline dispatch found the worker's TX1 and returned; the worker is still sending
      const [m] = await linkRows(c.id);
      seen.push(m!);
      expect(seen.map((x) => x.status)).toEqual(['queued', 'dispatching']);
      release();
      await worker;
      const after = (await linkRows(c.id))[0]!;
      seen.push(after);
      expect(after.status).toBe('sent');
      const token = links[0]!.token;
      for (const x of seen) expectNoLink(x.body, token);
      const mails = h.providers.email.sent.slice(before).filter((x) => x.to === c.email);
      expect(mails).toHaveLength(1);
      expect(mails[0]!.text).toContain(`#token=${token}`);
      expect(await seals(after.id)).toBe(0);
    } finally {
      release();
    }
  });

  it('F2 E684: while the outcome is unknown the seal is kept and the reconcile looks the text up by exactly what the provider got; the body never holds the link; the seal goes once the reconcile decides', async () => {
    const c = await invited('Kai', { byText: true });
    h.providers.telephony.failNext('timeout_after_submit');
    await askLink(h, slug, c.phone, ip());
    const [m] = (await linkRows(c.id)).slice(-1);
    expect(m!.status).toBe('dispatch_unknown');
    const text = h.providers.telephony.sms.filter((s) => s.to === c.phone).at(-1)!.body;
    const token = TOKEN_RE.exec(text)![1]!;
    expectNoLink(m!.body, token);
    expect(text).toBe(renderSealedLink(m!.body, portalLinkUrl(origin(), token), 'sms'));
    expect(await seals(m!.id)).toBe(1);
    // the link job before 15 minutes keeps the seal (the reconcile still needs it)
    await withTenantTx(sys(), (tx, now) => linkExpireInTx(tx, m!.id, now), { db: h.database });
    expect(await seals(m!.id)).toBe(1);
    const fake = h.providers.telephony;
    const hints: (SubmitHint | undefined)[] = [];
    const orig = fake.lookupMessage.bind(fake);
    (fake as { lookupMessage: (a: TelephonyAccount, k: string, hint?: SubmitHint) => ReturnType<typeof orig> }).lookupMessage = (a, k, hint) => {
      hints.push(hint);
      return orig(a, k);
    };
    try {
      expect(await reconcileOutbound(m!.id, deps(), w.tenantId)).toMatchObject({ kind: 'resolved' });
    } finally {
      delete (fake as { lookupMessage?: unknown }).lookupMessage;
    }
    expect(hints.map((x) => x?.body)).toEqual([text]);
    const after = (await rowOf(m!.id))!;
    expect(after.status).toBe('sent');
    expectNoLink(after.body, token);
    expect(await seals(m!.id)).toBe(0);
  });

  it('F2: after 15 minutes the seal is gone (the link job and portal.sync\'s backstop) and nothing renders the link again; a link still queued is canceled PORTAL_LINK_EXPIRED with no link in its body', async () => {
    const age = async (id: string) => {
      await h.su.query(`UPDATE portal_link_seals SET created_at = created_at - interval '16 minutes', expires_at = expires_at - interval '16 minutes' WHERE message_id = $1`, [id]);
      await h.su.query(`UPDATE messages SET created_at = created_at - interval '16 minutes' WHERE id = $1`, [id]);
    };
    // dispatch_unknown at 15 minutes: the link job drops the seal; the reconcile can no longer render the link
    const a = await invited('Ash', { byText: true });
    h.providers.telephony.failNext('timeout_after_submit');
    await askLink(h, slug, a.phone, ip());
    const [ma] = (await linkRows(a.id)).slice(-1);
    expect(ma!.status).toBe('dispatch_unknown');
    await age(ma!.id);
    const read = async (id: string) => withTenantTx(sys(), async (tx) => (await sql<{ c: Buffer | null }>`SELECT portal.link_for_send(${id}::uuid) AS c`.execute(tx)).rows[0]!.c, { db: h.database });
    expect(await read(ma!.id)).toBeNull(); // an expired seal is never read, even before it is deleted
    await withTenantTx(sys(), (tx, now) => linkExpireInTx(tx, ma!.id, now), { db: h.database });
    expect(await seals(ma!.id)).toBe(0);
    expectNoLink((await rowOf(ma!.id))!.body);
    // the same through portal.sync's backstop
    const b = await invited('Bea', { byText: true });
    h.providers.telephony.failNext('timeout_after_submit');
    await askLink(h, slug, b.phone, ip());
    const [mb] = (await linkRows(b.id)).slice(-1);
    await age(mb!.id);
    await withTenantTx(sys(), (tx) => linkBackstopInTx(tx, 500), { db: h.database });
    expect(await seals(mb!.id)).toBe(0);
    // a link still queued at 15 minutes: canceled PORTAL_LINK_EXPIRED, its seal gone, no link in its body
    const q = await invited('Quin');
    h.providers.email.failNext('unavailable');
    await askLink(h, slug, q.email, ip());
    const [mq] = (await linkRows(q.id)).slice(-1);
    await h.su.query(`UPDATE messages SET status = 'queued' WHERE id = $1`, [mq!.id]);
    expect(await seals(mq!.id)).toBe(0); // the failed send was final: the seal went then
    await age(mq!.id);
    await withTenantTx(sys(), (tx, now) => linkExpireInTx(tx, mq!.id, now), { db: h.database });
    const after = (await rowOf(mq!.id))!;
    expect(after).toMatchObject({ status: 'canceled', status_reason: 'PORTAL_LINK_EXPIRED' });
    expectNoLink(after.body);
  });

  it('F2: a send whose seal is gone sends nothing and fails PORTAL_LINK_UNAVAILABLE (never a link-less text, never dispatch_unknown)', async () => {
    const c = await invited('Gus');
    const before = h.providers.email.sent.length;
    const links = await requestPortalLogin(slug, c.email, { db: h.database });
    await deliverLinks({
      comms: deps(),
      webOrigin: origin(),
      log: quiet,
      beforeInlineDispatch: async (messageId) => {
        await h.su.query('DELETE FROM portal_link_seals WHERE message_id = $1', [messageId]);
      },
    }, links);
    const [m] = await linkRows(c.id);
    expect(m).toMatchObject({ status: 'failed', status_reason: 'PORTAL_LINK_UNAVAILABLE' });
    expectNoLink(m!.body, links[0]!.token);
    expect(h.providers.email.sent.length).toBe(before);
  });

  it('F2 R-GATE-14: a blocked link (do-not-contact) never held the link and leaves no seal', async () => {
    const c = await invited('Bo');
    expect((await call(w.agents[0]!, 'POST', `/contacts/${c.id}/do-not-contact`, { reason: 'asked_in_writing' })).status).toBe(200);
    const links = await requestPortalLogin(slug, c.email, { db: h.database });
    await deliverLinks({ comms: deps(), webOrigin: origin(), log: quiet }, links);
    const [m] = await linkRows(c.id);
    expect(m!.status).toBe('blocked');
    expectNoLink(m!.body, links[0]!.token);
    expect(await seals(m!.id)).toBe(0);
  });

  it('F2: app_user cannot read the side record (no staff role, not the system, not a client); only the system reads the sealed bytes, and only while the message is being sent', async () => {
    const c = await invited('Ida', { byText: true });
    h.providers.telephony.failNext('timeout_after_submit');
    await askLink(h, slug, c.phone, ip());
    const [m] = (await linkRows(c.id)).slice(-1);
    expect(await seals(m!.id)).toBe(1);
    for (const actor of [w.owner.actor(), w.agents[0]!.actor(), sys()]) {
      await expect(withTenantTx(actor, (tx) => sql`SELECT * FROM portal_link_seals`.execute(tx), { db: h.database })).rejects.toThrow(/permission denied/);
      await expect(withTenantTx(actor, (tx) => sql`DELETE FROM portal_link_seals`.execute(tx), { db: h.database })).rejects.toThrow(/permission denied/);
    }
    const read = (actor: Parameters<typeof withTenantTx>[0], id: string) =>
      withTenantTx(actor, async (tx) => (await sql<{ c: Buffer | null }>`SELECT portal.link_for_send(${id}::uuid) AS c`.execute(tx)).rows[0]!.c, { db: h.database });
    expect(await read(w.owner.actor(), m!.id)).toBeNull();
    expect(await read(w.agents[0]!.actor(), m!.id)).toBeNull();
    const sealed = await read(sys(), m!.id);
    expect(sealed).not.toBeNull();
    expect(sealed!.toString('latin1')).not.toMatch(/#token=|portal\.html/); // ciphertext, not the URL
    // a person cannot seal (or reseal) a link; the system cannot seal a message that is not a queued link
    await expect(withTenantTx(w.owner.actor(), (tx) => sql`SELECT portal.seal_link(${m!.id}::uuid, ${Buffer.alloc(48)})`.execute(tx), { db: h.database })).rejects.toThrow(/PORTAL_LINK_SEAL/);
    await expect(withTenantTx(sys(), (tx) => sql`SELECT portal.seal_link(${m!.id}::uuid, ${Buffer.alloc(48)})`.execute(tx), { db: h.database })).rejects.toThrow(/PORTAL_LINK_SEAL/);
    // once the outcome is known the system reads nothing either
    await reconcileOutbound(m!.id, deps(), w.tenantId);
    expect(await read(sys(), m!.id)).toBeNull();
  });

  it('F2 R-DATA-4: an erasure removes the sealed link with the message', async () => {
    // a listing seller (erasure refuses a person on a deal, CONTACT_ON_DEAL), signing in by text
    const agent = w.agents[0]!;
    const l = await call<{ listing: { id: string } }>(agent, 'POST', '/listings', { status: 'active', addressLine1: '7 Erasure Lane', city: 'Exampleville', region: 'CA', postalCode: '94000' });
    const c = await client(agent, { firstName: 'Eli' });
    expect((await call(agent, 'POST', `/listings/${l.body.listing.id}/contacts`, { contactId: c.id, role: 'seller' })).status).toBe(200);
    const phonePoint = (await h.su.query<{ id: string }>(`SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone'`, [c.id])).rows[0]!.id;
    expect((await invite(agent, l.body.listing.id, c.id, { loginPointId: phonePoint }, 'listings')).status).toBe(200);
    h.providers.telephony.failNext('timeout_after_submit');
    await askLink(h, slug, c.phone, ip());
    const [m] = (await linkRows(c.id)).slice(-1);
    expect(m!.status).toBe('dispatch_unknown');
    expect(await seals(m!.id)).toBe(1);
    expect(lastToken(h, c.phone)).not.toBeNull();
    await freshReauth(h, w.owner);
    const r = await call(w.owner, 'POST', `/contacts/${c.id}/erase`, { reason: 'PRIVACY_REQUEST' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await rowOf(m!.id)).toBeUndefined();
    expect(await seals(m!.id)).toBe(0);
  });
});
