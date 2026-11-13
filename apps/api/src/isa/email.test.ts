// AI ISA email on fakes (docs/AI_ISA.md §4.4, §7.3; R-ISA-7, R-GATE-12, R-CONSENT-18). Every AI ISA message is marketing, so
// an AI ISA email meets the same CAN-SPAM checks as any marketing email (gate check 4): the verified domain, the brokerage
// name, the postal address and an unsubscribe mechanism in the body. Real Postgres via the API harness; the fake ISA
// model and the fake telephony and email adapters; no real model, send, call or vendor. AI_ISA_LIVE_SENDS,
// TELEPHONY_LIVE_REQUESTS and MLS_LIVE_CALLS stay off.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { suFixture } from '../leads/testing.js';
import { aiMessages, assignmentOf, call, isaLead, type IsaLead, isaWorld, type IsaWorld, runIsa, startCare } from './testing.js';

let h: ApiHarness;
let w: IsaWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await isaWorld(h);
  // the team email identity on a verified sending domain, and the brokerage postal address (gate check 3 and 4)
  const domain = 'send.example.test';
  h.providers.email.verifiedDomains.add(domain);
  const dom = await call<{ domain: { id: string } }>(w.owner, 'POST', '/sending-domains', { domain });
  if (dom.status !== 201) throw new Error(`domain: ${dom.status} ${JSON.stringify(dom.body)}`);
  const ver = await call<{ domain: { verifiedAt: string | null } }>(w.owner, 'POST', `/sending-domains/${dom.body.domain.id}/verify`);
  if (!ver.body.domain?.verifiedAt) throw new Error(`verify: ${ver.status} ${JSON.stringify(ver.body)}`);
  await suFixture(h, [
    { text: 'UPDATE email_identities SET domain_id = $2 WHERE tenant_id = $1 AND id = $3', values: [w.tenantId, dom.body.domain.id, w.identityId] },
    { text: "UPDATE tenant_settings SET brokerage_postal_address = '1 Main St, Springfield, IL 62701' WHERE tenant_id = $1", values: [w.tenantId] },
  ]);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

/** A reply by email from the lead's bound address, DKIM-aligned (an email turn, R-ISA-28). */
async function inboundEmail(l: IsaLead, text: string): Promise<void> {
  const { ingestInbound } = await import('../comms/inbound.js');
  const { depsFromPlatform } = await import('../comms/runtime.js');
  const { systemActor } = await import('../worker/systemActor.js');
  const conv = await h.su.query<{ id: string }>('SELECT id FROM conversations WHERE contact_id = $1', [l.id]);
  const r = await ingestInbound(systemActor(w.tenantId, 'provider'), {
    kind: 'email', providerRef: `em-${randomUUID()}`, from: l.email, to: 'r+token@in.example.test', subject: 'Re: A note', text, headers: {},
    conversationId: conv.rows[0]!.id, dkim: [{ domain: 'example.test', result: 'pass' }],
  }, depsFromPlatform(h.app.platform));
  if (r.kind !== 'stored') throw new Error(`inbound: ${JSON.stringify(r)}`);
}

/** The unsubscribe link in an email body's footer. */
function unsubscribeLink(body: string): string {
  const m = /^Unsubscribe: (\S+)$/m.exec(body);
  if (!m) throw new Error(`no unsubscribe line in: ${body}`);
  return m[1]!;
}

const turnsOf = async (contactId: string) =>
  (await h.su.query<{ seq: number; status: string; trigger_kind: string; channel: string | null }>('SELECT seq, status, trigger_kind, channel FROM ai_isa_turns WHERE contact_id = $1 ORDER BY seq', [contactId])).rows;

describe('an AI ISA email is a CAN-SPAM marketing email (R-ISA-7, R-GATE-12, R-CONSENT-18)', () => {
  it('R-CONSENT-18: an AI email reply to a lead with a verified domain and a postal address goes out, never refused UNSUBSCRIBE_MISSING', async () => {
    const l = await isaLead(h, w.agents[0]!);
    expect((await startCare(w.agents[0]!, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    await inboundEmail(l, 'Hi, we are looking for a place soon. Email is best for me.');
    await runIsa(h, w.tenantId);
    const emails = (await aiMessages(h, l.id)).filter((m) => m.channel === 'email');
    expect(emails.length).toBeGreaterThanOrEqual(1);
    expect(emails.map((m) => m.status_reason)).not.toContain('UNSUBSCRIBE_MISSING');
    const sent = emails.filter((m) => m.status === 'sent');
    expect(sent.length).toBeGreaterThanOrEqual(1);
    // what was checked is what went out: the body names the unsubscribe and the postal address, and the provider got
    // that body and the one-click headers with the SAME link
    const body = sent.at(-1)!.body;
    expect(body).toMatch(/\bunsubscribe\b/i);
    expect(body).toContain('1 Main St, Springfield, IL 62701');
    expect(body).not.toContain('Reply STOP');
    const mail = h.providers.email.sent.filter((m) => m.to === l.email).at(-1)!;
    expect(mail.text).toBe(body);
    expect(mail.headers?.['List-Unsubscribe']).toBe(`<${unsubscribeLink(body)}>`);
    expect((await assignmentOf(h, l.id))!.ended_at).toBeNull();
  });

  it('R-ISA-31 E499: the link in the AI email works: one click revokes email marketing for the address and ends AI care', async () => {
    const l = await isaLead(h, w.agents[0]!);
    await startCare(w.agents[0]!, l.id);
    await runIsa(h, w.tenantId);
    await inboundEmail(l, 'Hello, can you email me about homes?');
    await runIsa(h, w.tenantId);
    const sent = (await aiMessages(h, l.id)).filter((m) => m.channel === 'email' && m.status === 'sent').at(-1)!;
    const res = await h.app.inject({ method: 'POST', url: new URL(unsubscribeLink(sent.body)).pathname, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unsubscribed: true });
    const revoked = await h.su.query(`SELECT 1 FROM consent_events WHERE contact_id = $1 AND channel = 'email' AND purpose = 'marketing' AND event_type = 'revoke'`, [l.id]);
    expect(revoked.rowCount).toBeGreaterThan(0);
    await runIsa(h, w.tenantId);
    expect((await assignmentOf(h, l.id))!.ended_at).not.toBeNull();
  });

  it('R-ISA-20: the model never sees an AI email\'s footer: the next turn\'s prompt has the earlier AI email without its unsubscribe link', async () => {
    const l = await isaLead(h, w.agents[0]!);
    await startCare(w.agents[0]!, l.id);
    await runIsa(h, w.tenantId);
    await inboundEmail(l, 'Hi there, we want to move this spring.');
    await runIsa(h, w.tenantId);
    const sent = (await aiMessages(h, l.id)).filter((m) => m.channel === 'email' && m.status === 'sent').at(-1)!;
    const calls = w.ai.calls.length;
    await inboundEmail(l, 'Thanks. Mostly the north side of town.');
    await runIsa(h, w.tenantId);
    const prompt = w.ai.calls.slice(calls).map((c) => c.user).find((u) => u.includes('north side of town'));
    expect(prompt).toBeDefined();
    expect(prompt).toContain("AI assistant, "); // the earlier AI email is in the thread, sign-off included
    expect(prompt).not.toContain(unsubscribeLink(sent.body));
    expect(prompt).not.toMatch(/\/api\/email\/unsubscribe\//);
  });
});

describe('a refused AI email blocks that message only (docs/AI_ISA.md §5.4 terminal class, §5.5 holds)', () => {
  it('§5.4: a terminal refusal (POSTAL_ADDRESS_MISSING) is no hold and no pause: the next inbound is its own turn and model call, and its reply goes out once the cause is fixed', async () => {
    const l = await isaLead(h, w.agents[0]!);
    await startCare(w.agents[0]!, l.id);
    await runIsa(h, w.tenantId);
    await suFixture(h, [{ text: 'UPDATE tenant_settings SET brokerage_postal_address = NULL WHERE tenant_id = $1', values: [w.tenantId] }]);
    try {
      await inboundEmail(l, 'Hi, we are looking for a 3 bedroom place.');
      await runIsa(h, w.tenantId);
    } finally {
      await suFixture(h, [{ text: "UPDATE tenant_settings SET brokerage_postal_address = '1 Main St, Springfield, IL 62701' WHERE tenant_id = $1", values: [w.tenantId] }]);
    }
    const refused = (await aiMessages(h, l.id)).filter((m) => m.channel === 'email');
    expect(refused.map((m) => [m.status, m.status_reason])).toEqual([['blocked', 'POSTAL_ADDRESS_MISSING']]);
    const a = (await assignmentOf(h, l.id))!;
    expect(a.paused_at).toBeNull();
    expect(a.ended_at).toBeNull();
    // no hold: a hold re-enqueues the turn under the `:hold` key (handlers.ts sendResultInTx, HOLD_CODES)
    expect((await h.su.query(`SELECT 1 FROM jobs WHERE dedupe_key = $1`, [`ai_isa.turn:${a.id}:${a.epoch}:hold`])).rowCount).toBe(0);
    const before = { turns: (await turnsOf(l.id)).length, calls: w.ai.calls.length };
    await inboundEmail(l, 'Are you still there? Mornings are best for me.');
    await runIsa(h, w.tenantId);
    const turns = await turnsOf(l.id);
    expect(turns.length).toBeGreaterThan(before.turns);
    expect(turns.at(-1)).toMatchObject({ trigger_kind: 'inbound', channel: 'email', status: 'sent' });
    expect(w.ai.calls.length).toBeGreaterThan(before.calls);
    expect((await aiMessages(h, l.id)).filter((m) => m.channel === 'email').map((m) => m.status)).toEqual(['blocked', 'sent']);
  });
});
