// Batch 16 (R-GATE-12, R-CONSENT-18, R-ISA-8, R-ISA-25; docs/AI_ISA.md §7.3): every AI ISA message is stored as
// marketing, and gate check 4 refuses a marketing email whose body has no unsubscribe (UNSUBSCRIBE_MISSING). Until
// batch 16 composeMessage added "Reply STOP to opt out." at most, so every AI ISA email was refused there. Now each AI
// email carries nurture's unsubscribe line (EMAIL_UNSUBSCRIBE_LINE) and the brokerage's postal address, and passes check
// 4 at dispatch (comms/dispatch.ts, D1); with AI_ISA_LIVE_SENDS false on a non-fake adapter it is still held, by the
// live-sends hold. Real Postgres through the API harness, fakes only: the "non-fake" adapter is only the config name the
// hold reads, and no provider is ever called for real.
import { EMAIL_UNSUBSCRIBE_LINE } from '@realty/core/compliance';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { TEST_STATEMENT } from '../cma/testing.js';
import { aiIsaLiveOff, depsFromPlatform } from '../comms/runtime.js';
import { suFixture } from '../leads/testing.js';
import type { FakeEmail } from '../providers/fake/email.js';
import { type IsaDeps, contextFor, queueIsaMessageInTx } from './seller/isa2Seam.js';
import { type SellerLead, type SellerWorld, asSystem, confirm, nowInstant, queueFactsAs, sellerLead, sellerWorld, withSellerPacksCleared } from './seller/testing.js';
import { call, grantInitiated, initiatedDayNow, openZone, runIsa } from './testing.js';

const POSTAL = '1 Sample St, Oakland, CA 94110';
const REPLY = 'Thanks for writing. What part of town are you hoping to be in?';

let h: ApiHarness;
let w: SellerWorld;
let fake: FakeEmail;
let cfg: { providers: { telephony: string; email: string }; aiIsaLiveSends: boolean };

beforeAll(async () => {
  h = await createApiHarness();
  w = await sellerWorld(h);
  cfg = h.app.platform.config as typeof cfg;
  fake = h.providers.email as unknown as FakeEmail;
  // a verified sending domain under the team identity the assistant sends from, and the brokerage's postal address: a
  // marketing email needs both (R-PAR-39, R-GATE-12), so neither is what decides the cases below
  fake.verifiedDomains.add('mail.ai-unsubscribe.test');
  const dom = await call<{ domain: { id: string } }>(w.owner, 'POST', '/sending-domains', { domain: 'mail.ai-unsubscribe.test' });
  expect((await call(w.owner, 'POST', `/sending-domains/${dom.body.domain.id}/verify`)).status).toBe(200);
  await h.su.query(`UPDATE email_identities SET domain_id = $2, from_address = 'team@mail.ai-unsubscribe.test' WHERE tenant_id = $1 AND user_id IS NULL`, [w.tenantId, dom.body.domain.id]);
  await suFixture(h, [{ text: 'UPDATE tenant_settings SET brokerage_postal_address = $2 WHERE tenant_id = $1', values: [w.tenantId, POSTAL] }]);
});
afterAll(async () => {
  await h?.close();
});

/** A live seller under care with its consent and a confirmed home, the start turn's messages two days back. */
async function lead(): Promise<SellerLead> {
  const l = await sellerLead(h, w);
  await grantInitiated(h, w.tenantId, l);
  expect((await confirm(w, l)).status).toBe(200);
  await runIsa(h, w.tenantId);
  // the guard spaces AI messages and caps initiated ones per day: the start turn's messages move two days back
  await h.su.query(`UPDATE messages SET created_at = created_at - interval '2 days', dispatched_at = dispatched_at - interval '2 days' WHERE contact_id = $1 AND initiator = 'assistant'`, [l.id]);
  return l;
}

/** ISA-2's TX-B queue path with a plain conversation reply by email (no facts). */
function queueReply(l: SellerLead): Promise<string | null> {
  return asSystem(h, w, l, async (tx, a, actor) => {
    const now = nowInstant();
    const ctx = await contextFor(tx, a, now);
    return queueIsaMessageInTx({ tx, deps: depsFromPlatform(h.app.platform) as unknown as IsaDeps, actor, ctx, now, turnId: null, pinnedSeq: a.lastInboundSeq },
      { kind: 'queue_message', messageKind: 'conversation', purpose: 'marketing', channel: 'email', lines: [], text: REPLY, handles: [], offerId: null, slotIndex: null, initiated: true }, a.machine);
  });
}

async function outcome(id: string) {
  const m = (await h.su.query<{ status: string; channel: string; body: string; purpose: string }>('SELECT status, channel, body, purpose FROM messages WHERE id = $1', [id])).rows[0]!;
  const denied = (await h.su.query<{ r: string[] }>(`SELECT reason_codes AS r FROM gate_decisions WHERE message_id = $1 AND outcome = 'deny'`, [id])).rows.flatMap((x) => x.r);
  return { ...m, denied, providerCalls: fake.sent.filter((x) => x.idempotencyKey === id) };
}

const blocks = (body: string) => body.split('\n\n');

describe('R-GATE-12 R-CONSENT-18 R-ISA-8 (batch 16): an AI ISA email passes check 4 with the unsubscribe line and the postal address', () => {
  it('a plain reply by email and a comps email each carry EMAIL_UNSUBSCRIBE_LINE and the postal address once, pass check 4 at dispatch and reach the fake email adapter', () =>
    initiatedDayNow(h, w.tenantId, openZone(), async () => {
      expect(cfg.aiIsaLiveSends).toBe(false);
      expect(aiIsaLiveOff(cfg).email).toBe(false); // the fake adapter: the live-sends hold does not apply

      const reply = await queueReply(await lead());
      expect(reply).not.toBeNull();
      await runIsa(h, w.tenantId, 2);
      const r = await outcome(reply!);
      expect({ channel: r.channel, purpose: r.purpose }).toEqual({ channel: 'email', purpose: 'marketing' });
      expect(r.denied).toEqual([]);
      expect(r.status).toBe('sent');
      expect(blocks(r.body).filter((x) => x === EMAIL_UNSUBSCRIBE_LINE)).toHaveLength(1);
      expect(blocks(r.body).filter((x) => x === POSTAL)).toHaveLength(1);
      expect(r.body).toContain(REPLY);
      expect(r.providerCalls).toHaveLength(1);
      expect(String(r.providerCalls[0]!.text)).toContain(EMAIL_UNSUBSCRIBE_LINE);

      const seller = await lead();
      const comps = await withSellerPacksCleared(h, () => queueFactsAs(h, w, seller, ['comps']));
      expect(comps).not.toBeNull();
      await withSellerPacksCleared(h, () => runIsa(h, w.tenantId, 2));
      const c = await outcome(comps!);
      expect(c.channel).toBe('email');
      expect(c.denied).toEqual([]);
      expect(c.status).toBe('sent');
      expect(c.body).toContain(`\n\n${TEST_STATEMENT}\n\n`);
      expect(blocks(c.body).filter((x) => x === EMAIL_UNSUBSCRIBE_LINE)).toHaveLength(1);
      expect(blocks(c.body).filter((x) => x === POSTAL)).toHaveLength(1);
      expect(c.providerCalls).toHaveLength(1);
    }));

  it('R-ISA-25: with AI_ISA_LIVE_SENDS false on a non-fake email adapter, a plain reply by email passes check 4 and is held by the live-sends hold alone; nothing reaches the provider', () =>
    initiatedDayNow(h, w.tenantId, openZone(), async () => {
      const reply = await queueReply(await lead());
      expect(reply).not.toBeNull();
      const saved = cfg.providers.email;
      cfg.providers.email = 'smtp';
      try {
        expect(aiIsaLiveOff(cfg).email).toBe(true);
        await runIsa(h, w.tenantId, 2);
      } finally {
        cfg.providers.email = saved;
      }
      const r = await outcome(reply!);
      expect(r.denied).toEqual(['AI_ISA_LIVE_OFF']);
      expect(r.status).toBe('blocked');
      expect(r.providerCalls).toEqual([]);
      expect(blocks(r.body).filter((x) => x === EMAIL_UNSUBSCRIBE_LINE)).toHaveLength(1);
    }));
});
