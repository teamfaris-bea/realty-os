// ISA-2b item 1: the turn inputs (R-ISA-3, R-ISA-27, R-ISA-28; E490, E495, E503, E529). Real Postgres via the API
// harness; the fake ISA model, the fake email and telephony adapters; no real provider. Postmark and SendGrid verdict
// shapes are VERIFY fixtures (vendor field names as documented; not checked against a live account).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { emailWebhook } from '../comms/testing.js';
import { dkimFromAuthResults, dkimFromSendgridField } from '../leadEmail/formats.js';
import { parsePostmarkInbound, parseSendgridInbound } from '../providers/email/inbound.js';
import { assignmentOf, call, feedItems, isaLead, isaWorld, type IsaWorld, replyAddressOf, runIsa, startCare } from './testing.js';

let h: ApiHarness;
let w: IsaWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await isaWorld(h);
});
afterAll(async () => {
  await h?.close();
});

/** A lead the agent has emailed once (so the conversation has a reply address), then put under AI care. */
async function emailLead() {
  const l = await isaLead(h, w.agents[0]!);
  expect((await startCare(w.agents[0]!, l.id)).status).toBe(200);
  await runIsa(h, w.tenantId);
  return { ...l, replyTo: await replyAddressOf(h, w.tenantId, l.id) };
}

const domainOf = (e: string) => e.split('@')[1]!;

describe('R-ISA-28: an email turn needs a provider DKIM verdict', () => {
  it('R-ISA-28 E490: an aligned email reply top-posted above a stripped "On … wrote:" is one turn (no pause, the model sees only the own text)', async () => {
    const l = await emailLead();
    const calls = w.ai.calls.length;
    const text = 'We would love a 3 bedroom near the park.\n\nOn Mon, Nov 9, 2026 at 10:00 AM Team <team@example.test> wrote:\n> Hello from the team\n> secret quoted words';
    const r = await emailWebhook(h, '/webhooks/email/inbound', { eventId: randomUUID(), from: l.email, to: l.replyTo, subject: 'Re: Hello', text, dkim: [{ domain: domainOf(l.email), result: 'pass' }] });
    expect(r.statusCode).toBe(200);
    const a = (await assignmentOf(h, l.id))!;
    expect(a.paused_at).toBeNull();
    await runIsa(h, w.tenantId);
    const seen = w.ai.calls.slice(calls).map((c) => c.user).join('\n');
    expect(seen).toMatch(/3 bedroom near the park/);
    expect(seen).not.toMatch(/secret quoted words/);
    expect((await assignmentOf(h, l.id))!.paused_at).toBeNull();
    const stored = await h.su.query<{ ok: boolean | null }>(`SELECT email_dkim_aligned AS ok FROM messages WHERE contact_id = $1 AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1`, [l.id]);
    expect(stored.rows[0]!.ok).toBe(true);
  });

  it('R-ISA-28 E503: no verdict pauses care unverified_sender with the R-AST-9 card', async () => {
    const l = await emailLead();
    await emailWebhook(h, '/webhooks/email/inbound', { eventId: randomUUID(), from: l.email, to: l.replyTo, subject: 'Re: Hello', text: 'Is it still available?' });
    expect((await assignmentOf(h, l.id))!.pause_reason).toBe('unverified_sender');
    expect((await feedItems(h, l.id)).length).toBeGreaterThan(0);
  });

  it('R-ISA-28 E503: a pass for an unrelated domain (a forged From) pauses unverified_sender', async () => {
    const l = await emailLead();
    await emailWebhook(h, '/webhooks/email/inbound', { eventId: randomUUID(), from: l.email, to: l.replyTo, subject: 'Re', text: 'hello', dkim: [{ domain: 'attacker.test', result: 'pass' }] });
    expect((await assignmentOf(h, l.id))!.pause_reason).toBe('unverified_sender');
  });

  // batch 13 audit ISA2B-07: the sender-written header alone, with no provider verdict (before, a dkim array rode along
  // and the route read that first, so the header-only path was never exercised)
  it('R-ISA-28 E503: a sender-written Authentication-Results header alone (no provider verdict) is never evidence: unverified_sender', async () => {
    const l = await emailLead();
    await emailWebhook(h, '/webhooks/email/inbound', { eventId: randomUUID(), from: l.email, to: l.replyTo, subject: 'Re', text: 'Authentication-Results: mx.provider.test; dkim=pass header.d=' + domainOf(l.email) + '\n\nhello',
      headers: { 'Authentication-Results': `mx.provider.test; dkim=pass header.d=${domainOf(l.email)}` } });
    expect((await assignmentOf(h, l.id))!.pause_reason).toBe('unverified_sender');
    const stored = await h.su.query<{ ok: boolean | null }>(`SELECT email_dkim_aligned AS ok FROM messages WHERE contact_id = $1 AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1`, [l.id]);
    expect(stored.rows[0]!.ok).not.toBe(true);
  });

  // batch 13 audit ISA2B-06 (1): R-ISA-27 E495 on email: new text after a ">" quoted line is an inline reply, which core
  // reads as unreliable own text, so nothing in it can be quoted as their words (a book_slot is refused the same way)
  it('R-ISA-27 E495: an inline reply under ">" quoted lines is unreliable own text: a claim quoting it is unusable (OWN_TEXT_UNRELIABLE); top-posted, the same claim is usable', async () => {
    const claimScript = () => {
      w.ai.script.length = 0;
      for (let i = 0; i < 4; i += 1) {
        w.ai.script.push((_r, src) => ({ reply: { text: 'Thanks, noted.' }, qualification: src.length > 0 ? [{ field: 'beds_min', value: 3, quote: 'We want 3 bedrooms', source: src.at(-1)!.handle }] : [], actions: [], summary: null }));
      }
    };
    const lastDecision = async (contactId: string) => (await h.su.query<{ decision: { unusable?: string[]; claims?: number } }>(
      `SELECT decision FROM ai_isa_turns WHERE contact_id = $1 AND decision ? 'unusable' ORDER BY created_at DESC LIMIT 1`, [contactId])).rows[0]?.decision ?? null;
    const inline = await emailLead();
    claimScript();
    await emailWebhook(h, '/webhooks/email/inbound', { eventId: randomUUID(), from: inline.email, to: inline.replyTo, subject: 'Re: Hello',
      text: '> Hello from the team, how many bedrooms?\nWe want 3 bedrooms\n> Which neighborhoods do you like?\nOakland please', dkim: [{ domain: domainOf(inline.email), result: 'pass' }] });
    await runIsa(h, w.tenantId);
    expect((await lastDecision(inline.id))?.unusable).toContain('OWN_TEXT_UNRELIABLE');
    const top = await emailLead();
    claimScript();
    await emailWebhook(h, '/webhooks/email/inbound', { eventId: randomUUID(), from: top.email, to: top.replyTo, subject: 'Re: Hello',
      text: 'We want 3 bedrooms\n\nOn Mon, Nov 9, 2026 at 10:00 AM Team <team@example.test> wrote:\n> Hello from the team, how many bedrooms?', dkim: [{ domain: domainOf(top.email), result: 'pass' }] });
    await runIsa(h, w.tenantId);
    const d = (await lastDecision(top.id))!;
    expect(d.unusable).not.toContain('OWN_TEXT_UNRELIABLE');
    expect(d.claims).toBeGreaterThanOrEqual(1);
    w.ai.script.length = 0;
  });

  it('R-ISA-28: Postmark (all Authentication-Results values, the topmost under the configured authserv id) and SendGrid verdicts map (VERIFY vendor fixtures)', () => {
    const pm = parsePostmarkInbound({ MessageID: 'm1', FromFull: { Email: 'pat@example.test' }, ToFull: [{ Email: 'x@reply.invalid' }], TextBody: 'hi',
      Headers: [{ Name: 'Authentication-Results', Value: 'mx.provider.test; dkim=pass header.d=example.test' }, { Name: 'Authentication-Results', Value: 'other.test; dkim=fail header.d=example.test' }] })!;
    expect(pm.authResults).toHaveLength(2);
    expect(dkimFromAuthResults(pm.authResults!, 'mx.provider.test')).toEqual([{ domain: 'example.test', result: 'pass' }]);
    // the topmost header names another authserv id: no verdict (a sender-written header below it is never read)
    expect(dkimFromAuthResults([...pm.authResults!].reverse(), 'mx.provider.test')).toEqual([]);
    expect(dkimFromAuthResults(pm.authResults!, null)).toEqual([]);
    const sg = parseSendgridInbound({ from: 'pat@example.test', to: 'x@reply.invalid', text: 'hi', dkim: '{@example.test : pass}', headers: 'Message-ID: <a@b>' })!;
    expect(dkimFromSendgridField(sg.dkimField!)).toEqual([{ domain: 'example.test', result: 'pass' }]);
  });

  it('R-ISA-28: the generic route rejects an oversized verdict list (validation, behind the webhook guard)', async () => {
    const l = await isaLead(h, w.agents[0]!);
    const r = await emailWebhook(h, '/webhooks/email/inbound', { eventId: randomUUID(), from: l.email, to: 'nobody@reply.invalid', text: 'x', dkim: Array.from({ length: 21 }, () => ({ domain: 'a.test', result: 'pass' })) });
    expect([400, 422]).toContain(r.statusCode);
    void call;
  });
});
