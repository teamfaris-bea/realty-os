// The seller part through real turns (ISA-3; R-ISA-20; E502, E536; batch 13 audit F8, F9): an inbound text, the
// turn job and FakeIsaAi / HostileIsaAi, the worker draining (runIsa). Real Postgres through the API harness; fakes
// only; nothing real is sent (AI_ISA_LIVE_SENDS, TELEPHONY_LIVE_REQUESTS and MLS_LIVE_CALLS stay false). Packs are
// cleared only in this test's database, in try/finally.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../../auth/testHarness.js';
import { inboundSms } from '../../comms/testing.js';
import { HostileIsaAi } from '../../providers/fake/hostileIsaAi.js';
import type { AiProvider } from '../../providers/types.js';
import { aiMessages, grantInitiated, runIsa } from '../testing.js';
import { buildCompsInTx } from './comps.js';
import { COMPS_PLACEHOLDER, SELLER_RUNTIME } from './index.js';
import { PRINTABLE_STATEMENTS, type SellerLead, type SellerWorld, asSystem, confirm, nowInstant, queueFactsAs, sellerLead, sellerWorld, withSellerPacksCleared } from './testing.js';

let h: ApiHarness;
let w: SellerWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await sellerWorld(h);
});
afterEach(() => {
  (h.providers as { ai: AiProvider }).ai = w.ai;
  w.ai.script.length = 0;
});
afterAll(async () => {
  await h?.close();
});

/** A seller lead under care with a confirmed home and its own-form written consent, the start turn run. */
async function liveSeller(): Promise<SellerLead> {
  const l = await sellerLead(h, w);
  await grantInitiated(h, w.tenantId, l);
  expect((await confirm(w, l)).status).toBe(200);
  await runIsa(h, w.tenantId);
  return l;
}

const watch = async (l: SellerLead) => (await h.su.query<{ comps_suspended_at: Date | null; subject_disputed_at: Date | null }>(`SELECT comps_suspended_at, subject_disputed_at FROM ai_isa_seller_watch WHERE assignment_id = $1`, [l.assignmentId])).rows[0]!;
const build = (l: SellerLead) => withSellerPacksCleared(h, () => asSystem(h, w, l, (tx, a, actor) => buildCompsInTx(tx, actor, a, nowInstant(), PRINTABLE_STATEMENTS)));

/** A comps email queued with the packs cleared and the statement double, then marked sent (the dispatch is a fake). */
async function sentCompsEmail(l: SellerLead): Promise<{ id: string; body: string }> {
  // the start turn's messages two days back (the guard spaces AI messages and caps initiated ones per day)
  await h.su.query(`UPDATE messages SET created_at = created_at - interval '2 days', dispatched_at = dispatched_at - interval '2 days' WHERE contact_id = $1 AND initiator = 'assistant'`, [l.id]);
  // queued and marked sent while the packs are cleared (the messages guard refuses a sold fact's send otherwise)
  const id = await withSellerPacksCleared(h, async () => {
    const was = SELLER_RUNTIME.deps;
    SELLER_RUNTIME.deps = PRINTABLE_STATEMENTS;
    try {
      const m = await queueFactsAs(h, w, l, ['comps']);
      expect(m).not.toBeNull();
      await h.su.query(`UPDATE messages SET status = 'sent', dispatched_at = now() WHERE id = $1`, [m]);
      await h.su.query(`UPDATE ai_isa_shared_facts SET status = 'sent' WHERE message_id = $1`, [m]);
      return m;
    } finally {
      SELLER_RUNTIME.deps = was;
    }
  });
  await h.su.query(`DELETE FROM jobs WHERE tenant_id = $1 AND kind = 'comms.dispatch' AND status = 'pending'`, [w.tenantId]);
  return { id: id!, body: (await h.su.query<{ body: string }>('SELECT body FROM messages WHERE id = $1', [id])).rows[0]!.body };
}

describe('E502 through a turn', () => {
  it('E502: "What\'s my house worth?" gets the pricing line (no price) and suspends comps', async () => {
    const l = await liveSeller();
    expect((await build(l)).ok).toBe(true);
    await inboundSms(h, l.phone, w.mainNumber, "What's my house worth?");
    await runIsa(h, w.tenantId);
    const msgs = await aiMessages(h, l.id);
    expect(msgs.some((m) => m.body.includes('Putting a price on your home is something'))).toBe(true);
    for (const m of msgs) expect(m.body).not.toMatch(/\$\s?\d/);
    expect((await watch(l)).comps_suspended_at).not.toBeNull();
    expect(((await build(l)) as { codes?: string[] }).codes).toContain('COMPS_SUSPENDED');
  });
});

describe('E536 nearby sales: refusal only', () => {
  it('E536: a question about a nearby sale goes to the agent as data_unavailable (its line, no price) and no nearby_sale row is written', async () => {
    const l = await liveSeller();
    // the model has no nearby action (ISA-1 output.ts): it escalates data_unavailable
    w.ai.script.push((_r, src) => ({ reply: null, qualification: [], actions: [{ type: 'escalate', class: 'data_unavailable', quoteRef: { source: src.at(-1)!.handle, quote: 'Has the yellow house on our street sold yet' } }], summary: null }));
    await inboundSms(h, l.phone, w.mainNumber, 'Has the yellow house on our street sold yet?');
    await runIsa(h, w.tenantId);
    const msgs = await aiMessages(h, l.id);
    expect(msgs.some((m) => m.body.includes("I don't have current market data for that right now."))).toBe(true);
    for (const m of msgs) expect(m.body).not.toMatch(/\$\s?\d|Sold for/);
    expect((await h.su.query(`SELECT count(*)::int AS n FROM ai_isa_shared_facts WHERE contact_id = $1 AND fact_kind = 'nearby_sale'`, [l.id])).rows[0].n).toBe(0);
    // no comps email was sent, so the subject is not marked disputed (owner question 9's system mark needs one)
    expect((await watch(l)).subject_disputed_at).toBeNull();
  });
});

describe('R-ISA-20: the prompt after a comps email', () => {
  it('R-ISA-20 E509: after a comps email the next turn\'s prompt holds the fixed placeholder, never a price, address or brokerage', async () => {
    const l = await liveSeller();
    const sent = await sentCompsEmail(l);
    expect(sent.body).toMatch(/Sold for \$/);
    const before = w.ai.calls.length;
    await inboundSms(h, l.phone, w.mainNumber, 'Thanks for that, can we talk next week');
    await runIsa(h, w.tenantId);
    const prompts = w.ai.calls.slice(before).map((c) => `${c.system}\n${c.user}`);
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) {
      expect(p).toContain(COMPS_PLACEHOLDER);
      expect(p).not.toMatch(/\$\s?\d|Sold for|sale price|Other Brokerage \(test\)|Sample Ave/);
    }
  });

  it('R-ISA-20: the UNSAFE screen applies to non-facts text only: the comps email states sale prices, every other AI text passes it', async () => {
    const UNSAFE = [/\$\s?\d/, /worth/i, /appraisal/i, /guarantee/i, /promise/i, /real person/i, /seller's market/i, /prices are rising/i, /better value/i, /commission/i];
    const l = await liveSeller();
    const sent = await sentCompsEmail(l);
    // the facts email is server text with sale prices and the "not an appraisal" line: the screen is not for it
    expect(UNSAFE.some((re) => re.test(sent.body))).toBe(true);
    for (const attack of ['price_number', 'appraisal_word', 'negated_value', 'sold_event_paraphrase'] as const) {
      (h.providers as { ai: AiProvider }).ai = new HostileIsaAi(attack);
      await inboundSms(h, l.phone, w.mainNumber, `And what about the market (${attack})`);
      await runIsa(h, w.tenantId);
    }
    const facts = new Set((await h.su.query<{ m: string }>(`SELECT DISTINCT message_id AS m FROM ai_isa_shared_facts WHERE contact_id = $1 AND message_id IS NOT NULL`, [l.id])).rows.map((x) => x.m));
    const others = (await aiMessages(h, l.id)).filter((m) => !facts.has(m.id));
    expect(others.length).toBeGreaterThan(0);
    for (const m of others) for (const re of UNSAFE) expect(m.body, String(re)).not.toMatch(re);
  });
});
