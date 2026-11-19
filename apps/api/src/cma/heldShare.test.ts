// A held CMA share sent through "send what was held" (POST /messages/:id/send, comms sendExisting → dispatch TX1 with
// retap) is re-checked for client readiness (R-CMA-7, R-CMA-9; E612; ARCHITECTURE §21.48 VERIFY 9). Real Postgres;
// the fake email provider records every send; no real MLS. A share is held when the client replied after it was
// queued (E27); until this check, a re-tap inside the 5 minutes between two compliance sweeps sent it whatever had
// happened to the CMA's readiness since.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { depsFromPlatform, dispatchOutbound } from '../comms/index.js';
import { type CmaBody, type ShareWorld, call, emailSeller, feedLastSyncedAt, localSales, mlsSale, oneTap, sharePreview, shareQueued, shareWorld, withPlatformCmaCleared } from './testing.js';

let h: ApiHarness;
let w: ShareWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await shareWorld(h);
  await localSales(w, 10);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const agent = () => w.agents[0]!;
const msg = async (id: string) => (await h.su.query('SELECT status, status_reason, dispatched_at FROM messages WHERE id = $1', [id])).rows[0] as { status: string; status_reason: string | null; dispatched_at: Date | null };
const sentTo = (to: string | null) => h.providers.email.sent.filter((m) => m.to === to).length;
/** A successful sync recovers the feed: one far-away record, never a comp of these homes. */
const freshFeed = () => mlsSale(w, { status: 'withdrawn', closePriceCents: null, closeDate: null, city: 'Faraway', postalCode: '96999', latE6: 21_000_000, lonE6: -157_000_000, subdivision: null });
type ShareView = CmaBody['cma'] & { share: { message: { status: string; sentence: string } | null } | null };
const view = async (id: string) => (await call<{ cma: ShareView }>(agent(), 'GET', `/cma/${id}`)).body.cma;
type SendAnswer = { result?: string; message?: { status: string; statusReason: string | null }; error?: { code: string; details?: { blockers?: string[] } } };
const retap = (messageId: string) => call<SendAnswer>(agent(), 'POST', `/messages/${messageId}/send`, {});

/** A shared CMA whose email is held for a re-tap: queued, then the client replied before it was dispatched (E27). */
async function heldShare() {
  const s = await emailSeller(w, agent());
  const tap = await oneTap(agent(), s.c);
  expect(tap.status).toBe(201);
  const r = await withPlatformCmaCleared(h, async () => {
    const p = await sharePreview(agent(), tap.body.cma.id);
    expect(p.body.preview.canShare, JSON.stringify(p.body.preview.blockers)).toBe(true);
    return shareQueued(h, agent(), p.body.preview);
  });
  expect(r.message.status).toBe('queued');
  await h.su.query('UPDATE conversations SET inbound_seq = inbound_seq + 1, last_inbound_at = now() WHERE contact_id = $1', [s.c]);
  const d = await dispatchOutbound(r.message.id, depsFromPlatform(h.app.platform), { tenantId: w.tenantId, actor: agent().actor() });
  expect(d.kind).toBe('needs_retap');
  expect(await msg(r.message.id)).toMatchObject({ status: 'queued', status_reason: 'CLIENT_REPLIED_SINCE_SCHEDULED' });
  return { ...s, cmaId: tap.body.cma.id, messageId: r.message.id };
}

describe('R-CMA-7 E759 (VERIFY 9): the re-tap of a held CMA share re-checks client readiness', () => {
  it('R-CMA-7 R-CMA-9 E759 E612: the report stopped being ready (the MLS feed went stale) before the re-tap: refused with that blocker, the email canceled, nothing dispatched', async () => {
    const q = await heldShare();
    const before = sentTo(q.email);
    await withPlatformCmaCleared(h, async () => {
      await feedLastSyncedAt(w, new Date(Date.now() - 3 * 86_400_000));
      // no compliance sweep has run yet: the share is still queued when the agent taps Send
      expect((await msg(q.messageId)).status).toBe('queued');
      const r = await retap(q.messageId);
      // every blocker that holds now, the first one first (a stale feed also hides its comps): codes only
      expect([r.status, r.body.error?.code, r.body.error?.details?.blockers]).toEqual([409, 'CMA_NOT_SHAREABLE', ['FEED_STALE', 'COMPS_HIDDEN']]);
    });
    await freshFeed();
    expect(sentTo(q.email)).toBe(before);
    expect(await msg(q.messageId)).toEqual({ status: 'canceled', status_reason: 'CMA_FEED_STALE', dispatched_at: null });
    expect((await view(q.cmaId)).share!.message).toMatchObject({ status: 'canceled', sentence: 'The email was canceled before sending: the MLS feed went out of date. Prepare a new CMA to share again.' });
    // it stays canceled when the feed is fresh again: a second tap finds nothing to send
    const again = await withPlatformCmaCleared(h, () => retap(q.messageId));
    expect([again.status, again.body.error?.code]).toEqual([409, 'MESSAGE_NOT_SENDABLE']);
    expect(sentTo(q.email)).toBe(before);
  });

  it('R-CMA-7 E759: counsel review of platform:cma is not recorded at the re-tap: refused PLATFORM_NOT_CLEARED, nothing dispatched', async () => {
    const q = await heldShare();
    const before = sentTo(q.email);
    const r = await retap(q.messageId);
    expect([r.status, r.body.error?.code]).toEqual([409, 'CMA_NOT_SHAREABLE']);
    expect(r.body.error?.details?.blockers).toContain('PLATFORM_NOT_CLEARED');
    expect(sentTo(q.email)).toBe(before);
    expect(await msg(q.messageId)).toEqual({ status: 'canceled', status_reason: 'CMA_PLATFORM_NOT_CLEARED', dispatched_at: null });
  });

  it('E759 E27 R-CMA-9: a held share whose CMA is still client-ready is sent by the re-tap, once', async () => {
    const q = await heldShare();
    const before = sentTo(q.email);
    const r = await withPlatformCmaCleared(h, () => retap(q.messageId));
    expect([r.status, r.body.result]).toEqual([200, 'sent']);
    expect(sentTo(q.email)).toBe(before + 1);
    expect((await msg(q.messageId)).status).toBe('sent');
  });

  it('E759 E27 R-GATE-14: the send-time gate still decides a ready held share: the seller unsubscribed since, so the re-tap is blocked by the gate and nothing is dispatched', async () => {
    const q = await heldShare();
    const before = sentTo(q.email);
    expect((await call(agent(), 'POST', `/contacts/${q.c}/do-not-contact`, {})).status).toBe(200);
    const r = await withPlatformCmaCleared(h, () => retap(q.messageId));
    expect(r.status).toBe(200);
    expect(r.body.result).toBe('blocked');
    expect(sentTo(q.email)).toBe(before);
    expect((await msg(q.messageId)).status).toBe('blocked');
  });
});
