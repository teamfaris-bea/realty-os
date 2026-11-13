// b14 audit F1 (orchestrator decision (b)): defence in depth behind F2. Since F2 a sign-in link's body is a fixed line and
// never holds the URL (seal.test.ts). Every reader that copies message bodies into another record or a prompt also
// skips action_category 'portal_login_link', so even a link body that did hold a token (a row written before the seal,
// or a future regression) is never copied: comms lastOutbound (the handback's "Last sent" claim and its evidence
// snippet), assistant/repos/context.ts (the assistant's context bundle and its reaction targets), isa/turn.ts (the AI ISA
// prompt and sources) and comms/reactions.ts (a reaction is never linked to, or quoted from, a link).
// Fakes only (FakeIsaAi records every prompt); platform:portal and platform:ai_isa are cleared in the per-test database.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contactBundle, contactCore } from '../assistant/repos/context.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { queueOutboundInTx } from '../comms/compose.js';
import { inboundSms, playbookFixture } from '../comms/testing.js';
import { type IsaWorld, isaLead, isaWorld, runIsa, startCare } from '../isa/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { askLink, call, client, deal, invite, setPortalCleared, slugOf } from './testing.js';

let h: ApiHarness;
let w: IsaWorld;
let slug: string;
let ipSeq = 0;
const ip = () => `198.51.100.${(++ipSeq % 200) + 20}`;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await isaWorld(h);
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

/** A token-shaped value no real link carries. */
const PLANTED = `#token=${'Q'.repeat(43)}`;
/** A link body that holds a token, shaped as the pre-seal body was (the whole token inside the first 200 characters). */
const legacyBody = (first: string) => `Harbor Realty LLC: here is the sign-in link for ${first}'s client portal. It works once, for 15 minutes. https://app.example.test/portal.html${PLANTED} If you did not ask for it, ignore this text.`;

/**
 * Agent 0's client, invited, signing in by text; one link sent; its body then made to hold a token. `on: 'listing'` invites
 * them as the seller of a withdrawn team listing (not an open deal or an active listing, so AI care may start).
 */
async function linkSentByText(contactId: string, phone: string, first: string, on: 'deal' | 'listing' = 'deal'): Promise<string> {
  const agent = w.agents[0]!;
  const phonePoint = (await h.su.query<{ id: string }>(`SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone'`, [contactId])).rows[0]!.id;
  let inv;
  if (on === 'deal') {
    inv = await invite(agent, await deal(agent, contactId), contactId, { loginPointId: phonePoint });
  } else {
    const l = await call<{ listing: { id: string } }>(agent, 'POST', '/listings', { status: 'withdrawn', addressLine1: '3 Reader Row', city: 'Exampleville', region: 'CA', postalCode: '94000' });
    if (l.status !== 201) throw new Error(`listing ${l.status} ${JSON.stringify(l.body)}`);
    expect((await call(agent, 'POST', `/listings/${l.body.listing.id}/contacts`, { contactId, role: 'seller' })).status).toBe(200);
    inv = await invite(agent, l.body.listing.id, contactId, { loginPointId: phonePoint }, 'listings');
  }
  if (inv.status !== 200) throw new Error(`invite ${inv.status} ${JSON.stringify(inv.body)}`);
  expect((await askLink(h, slug, phone, ip())).statusCode).toBe(202);
  const m = (await h.su.query<{ id: string; status: string; body: string }>(`SELECT id, status, body FROM messages WHERE contact_id = $1 AND action_category = 'portal_login_link' ORDER BY created_at DESC LIMIT 1`, [contactId])).rows[0]!;
  expect(m.status).toBe('sent');
  expect(m.body).not.toContain('#token='); // F2: the real body never holds it
  await h.su.query('UPDATE messages SET body = $2 WHERE id = $1', [m.id, legacyBody(first)]);
  return m.id;
}

const step = { stepKey: 'checkin', channel: 'sms', delay: { anchor: 'enrollment', offsetSeconds: 0 }, purpose: 'informational', category: 'reminder', intent: 'appointment_reminder', template: 'Reminder: your showing is tomorrow at 10.', personalization: 'none', slots: [], maxLength: 640, stopIf: [] };

describe('b14 F1: no reader copies a sign-in link body (defence in depth behind F2)', () => {
  it('F1: a reply on a contact with a live assistant enrollment: no assistant_claims.text or evidence_refs.snippet holds the token, and the assistant\'s context bundle holds none', async () => {
    const c = await client(w.agents[0]!, { firstName: 'Rhea' });
    await linkSentByText(c.id, c.phone, 'Rhea');
    // a live nurture enrollment with a scheduled step: the reply pauses it and hands back (R-AST-9)
    const pb = await playbookFixture(h, w.tenantId, w.owner, c.id, { scope: 'team', step, body: 'Reminder: your showing is tomorrow at 10.', category: 'reminder', purpose: 'informational' });
    const q = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => queueOutboundInTx(tx, w.deps, { contactId: c.id, channel: 'sms', body: 'Reminder: your showing is tomorrow at 10.', initiator: 'assistant', purpose: 'informational', category: 'reminder', assistantActionId: pb.actionId, playbookStepRunId: pb.stepRunId, idempotencyKey: `n:${randomUUID()}`, scheduleAt: (Date.now() + 3600_000) as never }, now), { db: h.database });
    expect(q.ok).toBe(true);
    expect((await inboundSms(h, c.phone, w.mainNumber, 'Can we push the showing to Friday?')).statusCode).toBe(200);
    const claims = (await h.su.query<{ claim_kind: string; text: string; snippet: string | null }>(
      `SELECT c.claim_kind, c.text, e.snippet FROM assistant_claims c JOIN assistant_actions a ON a.tenant_id = c.tenant_id AND a.id = c.action_id
         LEFT JOIN evidence_refs e ON e.tenant_id = c.tenant_id AND e.claim_id = c.id
        WHERE a.contact_id = $1 AND a.kind = 'handback'`, [c.id])).rows;
    expect(claims.map((x) => x.claim_kind)).toContain('client_statement'); // the handback was made
    for (const x of claims) {
      expect(x.text).not.toContain('#token=');
      expect(x.snippet ?? '').not.toContain('#token=');
    }
    // the assistant's context bundle (assistant/repos/context.ts), as the assistant run builds it
    const bundle = await withTenantTx(systemActor(w.tenantId, 'assistant'), async (tx) => contactBundle(tx, (await contactCore(tx, c.id))!), { db: h.database });
    expect(JSON.stringify(bundle)).not.toContain('#token=');
    expect(JSON.stringify(bundle)).toContain('Can we push the showing to Friday?'); // the bundle was read
  });

  it('F1: a reaction quoting a link body word for word (comms/reactions.ts) is never linked to the link, so no reaction copy quotes it', async () => {
    const c = await client(w.agents[0]!, { firstName: 'Remy' });
    const linkId = await linkSentByText(c.id, c.phone, 'Remy');
    expect((await inboundSms(h, c.phone, w.mainNumber, `Liked “${legacyBody('Remy')}”`)).statusCode).toBe(200);
    expect((await h.su.query('SELECT 1 FROM message_reactions WHERE target_message_id = $1', [linkId])).rowCount).toBe(0);
  });

  it('F1: the AI ISA prompt and its sources never carry a sign-in link body sent to a bound point', async () => {
    const l = await isaLead(h, w.agents[0]!);
    await linkSentByText(l.id, l.phone, 'Lark', 'listing');
    const s = await startCare(w.agents[0]!, l.id);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    await runIsa(h, w.tenantId);
    await inboundSms(h, l.phone, w.mainNumber, 'Hello, is the house on Elm still available?');
    const before = w.ai.calls.length;
    await runIsa(h, w.tenantId);
    expect(w.ai.calls.length).toBeGreaterThan(before);
    const prompts = JSON.stringify(w.ai.calls.slice(before));
    expect(prompts).toContain('is the house on Elm still available'); // the turn read the thread
    expect(prompts).not.toContain('#token=');
    expect(prompts).not.toContain('sign-in link');
    const turns = (await h.su.query<{ sources: unknown }>(`SELECT * FROM ai_isa_turns WHERE contact_id = $1`, [l.id])).rows;
    expect(JSON.stringify(turns)).not.toContain('#token=');
  });

  it('F1: the staff thread itself shows the stored line (never a link) for a link sent after the seal', async () => {
    const c = await client(w.agents[0]!, { firstName: 'Tess' });
    const dealId = await deal(w.agents[0]!, c.id);
    const inv = await invite(w.agents[0]!, dealId, c.id);
    expect(inv.status).toBe(200);
    await askLink(h, slug, c.email, ip());
    const thread = await call(w.agents[0]!, 'GET', `/contacts/${c.id}/timeline`);
    expect(thread.status).toBe(200);
    const text = JSON.stringify(thread.body);
    expect(text).toContain("sign-in link for Tess's client portal");
    expect(text).not.toContain('#token=');
  });
});
