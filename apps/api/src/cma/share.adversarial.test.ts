// Adversarial checks of the V2-A share (R-CMA-9, D1, D9, D11, R-GATE-14, R-PERM-5, R-CMA-8; E600; VERIFY 8): it never
// sends twice, never sends without dispatch, never opens on the wrong platform pack, never sends to an address that is
// not the recipient's, and never changes a CMA it refused. Fakes only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { depsFromPlatform, dispatchOutbound } from '../comms/index.js';
import { type ShareWorld, call, emailSeller, localSales, oneTap, shareFrom, sharePreview, shareQueued, shareWorld, withPlatformCmaCleared } from './testing.js';

let h: ApiHarness;
let w: ShareWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await shareWorld(h);
  await localSales(w, 8);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const agent = () => w.agents[0]!;
const errorOf = (r: { body: unknown }) => (r.body as { error: { code: string; details?: Record<string, unknown> } }).error;
async function draft() {
  const s = await emailSeller(w, agent());
  const tap = await oneTap(agent(), s.c);
  return { ...s, id: tap.body.cma.id };
}
const sentTo = (to: string | null) => h.providers.email.sent.filter((m) => m.to === to).length;

describe('VERIFY 8 E600: the share\'s dispatch job and the in-request dispatch race safely', () => {
  it('VERIFY 8 R-GATE-14: the in-request dispatch and the comms.dispatch job running at once send exactly one email', async () => {
    const d = await draft();
    const r = await withPlatformCmaCleared(h, async () => shareQueued(h, agent(), (await sharePreview(agent(), d.id)).body.preview));
    const deps = depsFromPlatform(h.app.platform);
    const results = await Promise.all([dispatchOutbound(r.message.id, deps, { tenantId: w.tenantId, actor: agent().actor() }), dispatchOutbound(r.message.id, deps, { tenantId: w.tenantId })]);
    expect(results.map((x) => x.kind).sort()).toEqual(['noop', 'sent']);
    expect(sentTo(d.email)).toBe(1);
    expect((await h.su.query('SELECT count(*)::int AS n FROM jobs WHERE kind = $1 AND payload ->> $2 = $3', ['comms.dispatch', 'messageId', r.message.id])).rows[0].n).toBe(1);
  });
});

describe('adversarial', () => {
  it('D9 D11: clearing platform:avm (automated notes) never opens CMA sharing; only platform:cma does', async () => {
    const d = await draft();
    await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:avm'");
    try {
      const pv = (await sharePreview(agent(), d.id)).body.preview;
      expect(pv.blockers.map((b) => b.code)).toEqual(['PLATFORM_NOT_CLEARED']);
      expect((await shareFrom(agent(), pv)).status).toBe(409);
    } finally {
      await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:avm'");
    }
    expect(sentTo(d.email)).toBe(0);
  });

  it('R-CMA-9: forged hashes never send (CONTENT_CHANGED first, then REPORT_CHANGED); the CMA stays a draft', async () => {
    const d = await draft();
    await withPlatformCmaCleared(h, async () => {
      const pv = (await sharePreview(agent(), d.id)).body.preview;
      expect(errorOf(await shareFrom(agent(), pv, { contentSha256: 'f'.repeat(64) })).details).toEqual({ reason: 'CONTENT_CHANGED' });
      expect(errorOf(await shareFrom(agent(), pv, { reportSha256: 'f'.repeat(64) })).details).toEqual({ reason: 'REPORT_CHANGED' });
    });
    expect((await h.su.query('SELECT status FROM cma_reports WHERE id = $1', [d.id])).rows[0].status).toBe('draft');
    expect(sentTo(d.email)).toBe(0);
  });

  it('R-PERM-5: an address that is not the recipient\'s (another contact\'s email, a removed one) is refused before anything is stored', async () => {
    const d = await draft();
    const other = await emailSeller(w, agent());
    await withPlatformCmaCleared(h, async () => {
      const pv = (await sharePreview(agent(), d.id)).body.preview;
      const theirs = (await h.su.query("SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'email'", [other.c])).rows[0].id;
      expect(errorOf(await shareFrom(agent(), pv, { toPointId: theirs })).details).toEqual({ issues: [{ path: '/toPointId', code: 'not_an_email_of_recipient' }] });
      // the address removed from the person between the preview and the tap
      await h.su.query("UPDATE contact_points SET status = 'removed', removed_at = now() WHERE id = $1", [pv.toPointId]);
      expect(errorOf(await shareFrom(agent(), pv)).details).toEqual({ issues: [{ path: '/toPointId', code: 'not_an_email_of_recipient' }] });
    });
    expect((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE contact_id = ANY ($1::uuid[])', [[d.c, other.c]])).rows[0].n).toBe(0);
  });

  it('E600 R-CMA-8: two shares of one CMA to two recipients at once: one wins, the other is CMA_NOT_DRAFT (never a second email)', async () => {
    const d = await draft();
    const co = await emailSeller(w, agent(), { name: 'Cory Coseller' });
    expect((await call(agent(), 'POST', `/contacts/${d.c}/relationships`, { relatedContactId: co.c, kind: 'co_seller' })).status).toBe(201);
    await withPlatformCmaCleared(h, async () => {
      const a = (await sharePreview(agent(), d.id)).body.preview;
      const b = (await sharePreview(agent(), d.id, { recipientContactId: co.c })).body.preview;
      const [x, y] = await Promise.all([shareFrom(agent(), a), shareFrom(agent(), b)]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
      expect([x, y].filter((r) => r.status === 409).map((r) => errorOf(r).code)).toEqual(['CMA_NOT_DRAFT']);
    });
    expect(sentTo(d.email) + sentTo(co.email)).toBe(1);
  });

  it('R-CMA-8: a superseded draft is never shared (CMA_NOT_DRAFT); a body cannot set the email\'s text or subject (strict)', async () => {
    const d = await draft();
    const pv = await withPlatformCmaCleared(h, async () => (await sharePreview(agent(), d.id)).body.preview);
    const addr = (await h.su.query('SELECT contact_address_id FROM cma_reports WHERE id = $1', [d.id])).rows[0].contact_address_id;
    expect((await call(agent(), 'POST', '/cma', { purpose: 'listing_price', contactId: d.c, subject: { kind: 'contact_address', contactAddressId: addr } })).status).toBe(201);
    await withPlatformCmaCleared(h, async () => {
      expect(errorOf(await shareFrom(agent(), pv)).code).toBe('CMA_NOT_DRAFT');
    });
    expect((await call(agent(), 'POST', `/cma/${d.id}/share`, { recipientContactId: d.c, toPointId: pv.toPointId, contentSha256: pv.contentSha256, reportSha256: pv.reportSha256, body: 'free text' })).status).toBe(422);
    expect(sentTo(d.email)).toBe(0);
  });
});
