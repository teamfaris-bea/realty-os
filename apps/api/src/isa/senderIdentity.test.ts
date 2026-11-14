// b18 item e (PHASE2_3_PLAN OQ-1114-12, owner product choice 2026-11-14): an AI ISA email comes from the team's verified
// email identity, never an agent's personal or an unverified address; it names the assigned agent (the lead's owner) in
// its From name, subject and sign-off; and a reply reaches the lead's own thread, whose owner is that agent. Real
// Postgres through the API harness, the fake email adapter only (no provider is called for real).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { emailWebhook } from '../comms/testing.js';
import { suFixture } from '../leads/testing.js';
import type { FakeEmail } from '../providers/fake/email.js';
import { type IsaDeps, contextFor, queueIsaMessageInTx } from './seller/isa2Seam.js';
import { type SellerLead, type SellerWorld, asSystem, confirm, nowInstant, sellerLead, sellerWorld } from './seller/testing.js';
import { call, grantInitiated, initiatedDayNow, openZone, replyAddressOf, runIsa } from './testing.js';

const POSTAL = '1 Sample St, Oakland, CA 94110';
const REPLY = 'Thanks for writing. Which neighbourhoods are you looking at?';
const DOMAIN = 'mail.ai-sender.test';
const TEAM_FROM = `team@${DOMAIN}`;

let h: ApiHarness;
let w: SellerWorld;
let fake: FakeEmail;
let personalFrom: string;
let agentFirst: string;
let brokerage: string;
let team: string;

beforeAll(async () => {
  h = await createApiHarness();
  w = await sellerWorld(h);
  fake = h.providers.email as unknown as FakeEmail;
  fake.verifiedDomains.add(DOMAIN);
  const dom = await call<{ domain: { id: string } }>(w.owner, 'POST', '/sending-domains', { domain: DOMAIN });
  expect((await call(w.owner, 'POST', `/sending-domains/${dom.body.domain.id}/verify`)).status).toBe(200);
  await h.su.query(`UPDATE email_identities SET domain_id = $2, from_address = $3 WHERE tenant_id = $1 AND user_id IS NULL`, [w.tenantId, dom.body.domain.id, TEAM_FROM]);
  // the assigned agent also has a personal identity, on the same verified domain: the assistant must still not use it
  personalFrom = `agent-${randomUUID().slice(0, 6)}@${DOMAIN}`;
  const mine = await call(w.owner, 'POST', '/email-identities', { fromAddress: personalFrom, displayName: 'Agent personal', userId: w.agents[0]!.userId, domainId: dom.body.domain.id });
  expect(mine.status).toBe(201);
  await suFixture(h, [{ text: 'UPDATE tenant_settings SET brokerage_postal_address = $2 WHERE tenant_id = $1', values: [w.tenantId, POSTAL] }]);
  const s = (await h.su.query<{ b: string; t: string | null }>('SELECT brokerage_legal_name AS b, team_name AS t FROM tenant_settings WHERE tenant_id = $1', [w.tenantId])).rows[0]!;
  brokerage = s.b;
  team = s.t ?? s.b;
  agentFirst = (await h.su.query<{ f: string }>(`SELECT split_part(display_name, ' ', 1) AS f FROM users WHERE id = $1`, [w.agents[0]!.userId])).rows[0]!.f;
});
afterAll(async () => {
  await h?.close();
});

/** A live lead under care (the seller world's), its start turn two days back so a new email may go now. */
async function lead(): Promise<SellerLead> {
  const l = await sellerLead(h, w);
  await grantInitiated(h, w.tenantId, l);
  expect((await confirm(w, l)).status).toBe(200);
  await runIsa(h, w.tenantId);
  await h.su.query(`UPDATE messages SET created_at = created_at - interval '2 days', dispatched_at = dispatched_at - interval '2 days' WHERE contact_id = $1 AND initiator = 'assistant'`, [l.id]);
  return l;
}

function queueReply(l: SellerLead): Promise<string | null> {
  return asSystem(h, w, l, async (tx, a, actor) => {
    const now = nowInstant();
    const ctx = await contextFor(tx, a, now);
    return queueIsaMessageInTx({ tx, deps: depsFromPlatform(h.app.platform) as unknown as IsaDeps, actor, ctx, now, turnId: null, pinnedSeq: a.lastInboundSeq },
      { kind: 'queue_message', messageKind: 'conversation', purpose: 'marketing', channel: 'email', lines: [], text: REPLY, handles: [], offerId: null, slotIndex: null, initiated: true }, a.machine);
  });
}

async function outcome(id: string) {
  const m = (await h.su.query<{ status: string; body: string; subject: string | null; from_address: string | null; email_identity_id: string | null; conversation_id: string; contact_id: string }>('SELECT status, body, subject, from_address, email_identity_id, conversation_id, contact_id FROM messages WHERE id = $1', [id])).rows[0]!;
  const denied = (await h.su.query<{ r: string[] }>(`SELECT reason_codes AS r FROM gate_decisions WHERE message_id = $1 AND outcome = 'deny'`, [id])).rows.flatMap((x) => x.r);
  return { ...m, denied, sent: fake.sent.filter((x) => x.idempotencyKey === id) };
}

describe('b18 OQ-1114-12: the AI email\'s sender, the agent it names and where its replies go', () => {
  it('E722 (R-ISA-8): from the team\'s verified identity, never the agent\'s personal one; the From name, subject and sign-off name the assigned agent; Reply-To is the lead\'s own thread, and a reply lands there under its owner', () =>
    initiatedDayNow(h, w.tenantId, openZone(), async () => {
      const l = await lead();
      const id = await queueReply(l);
      expect(id).not.toBeNull();
      await runIsa(h, w.tenantId, 2);
      const r = await outcome(id!);
      expect(r.denied).toEqual([]);
      expect(r.status).toBe('sent');
      expect(r.sent).toHaveLength(1);
      const mail = r.sent[0]!;
      // the verified team identity (user_id NULL), never the assigned agent's own address
      const ident = (await h.su.query<{ user_id: string | null; from_address: string; verified_at: Date | null }>('SELECT i.user_id, i.from_address, d.verified_at FROM email_identities i LEFT JOIN sending_domains d ON d.tenant_id = i.tenant_id AND d.id = i.domain_id WHERE i.id = $1', [r.email_identity_id])).rows[0]!;
      expect(ident.user_id).toBeNull();
      expect(ident.verified_at).not.toBeNull();
      expect(mail.from.address).toBe(TEAM_FROM);
      expect(mail.from.address).not.toBe(personalFrom);
      // the assigned agent (the lead's owner) named in the From name, the subject and the sign-off of every AI email
      const owner = (await h.su.query<{ owner_user_id: string }>('SELECT owner_user_id FROM contacts WHERE id = $1', [l.id])).rows[0]!.owner_user_id;
      expect(owner).toBe(w.agents[0]!.userId);
      expect(agentFirst.length).toBeGreaterThan(0);
      expect(mail.from.name).toBe(`${agentFirst}'s AI assistant (${team})`);
      expect(mail.subject).toBe(`A note from ${agentFirst}'s AI assistant`);
      expect(mail.text).toContain(`— ${agentFirst}'s AI assistant, ${brokerage}`);
      // replies go to the lead's own conversation: the Reply-To is its routing address, and a reply lands in it
      const replyTo = await replyAddressOf(h, w.tenantId, l.id);
      expect(mail.replyTo).toBe(replyTo);
      const back = await emailWebhook(h, '/webhooks/email/inbound', { eventId: randomUUID(), from: l.email, to: mail.replyTo!, subject: `Re: ${mail.subject}`, text: 'Mostly the east side.' });
      expect(back.statusCode).toBe(200);
      const inbound = (await h.su.query<{ contact_id: string; conversation_id: string }>("SELECT contact_id, conversation_id FROM messages WHERE contact_id = $1 AND direction = 'inbound' AND channel = 'email' ORDER BY created_at DESC LIMIT 1", [l.id])).rows[0]!;
      expect(inbound).toEqual({ contact_id: l.id, conversation_id: r.conversation_id });
    }));

  it('E722 (R-ISA-8): with an older team identity on an unverified domain beside the verified one, the assistant still sends from the verified team identity (it never sends from the unverified one)', () =>
    initiatedDayNow(h, w.tenantId, openZone(), async () => {
      const bad = await call<{ domain: { id: string } }>(w.owner, 'POST', '/sending-domains', { domain: 'unverified.ai-sender.test' });
      // fixture only: a team identity created before the verified one, on a domain that never verified
      const oldId = randomUUID();
      await h.su.query(`INSERT INTO email_identities (tenant_id, id, user_id, from_address, display_name, domain_id, status, created_at) VALUES ($1, $2, NULL, 'old@unverified.ai-sender.test', 'Old team', $3, 'active', now() - interval '30 days')`, [w.tenantId, oldId, bad.body.domain.id]);
      try {
        const id = await queueReply(await lead());
        await runIsa(h, w.tenantId, 2);
        const r = await outcome(id!);
        expect(r.denied).toEqual([]);
        expect(r.status).toBe('sent');
        expect(r.email_identity_id).not.toBe(oldId);
        expect(r.sent.map((x) => x.from.address)).toEqual([TEAM_FROM]);
      } finally {
        await h.su.query(`UPDATE email_identities SET status = 'disabled' WHERE id = $1`, [oldId]);
      }
    }));

  it('E722 (R-ISA-8): with no team identity at all, the assistant sends nothing: the agent\'s personal identity is never used instead', () =>
    initiatedDayNow(h, w.tenantId, openZone(), async () => {
      await h.su.query(`UPDATE email_identities SET status = 'disabled' WHERE tenant_id = $1 AND user_id IS NULL AND status = 'active'`, [w.tenantId]);
      try {
        const l = await lead();
        const before = fake.sent.length;
        const id = await queueReply(l);
        await runIsa(h, w.tenantId, 2);
        // either nothing is queued (no team sender to draft from) or what is queued has no identity and never goes out
        if (id !== null) {
          const r = await outcome(id);
          expect(r.status).not.toBe('sent');
          expect(r.sent).toEqual([]);
          expect(r.email_identity_id).toBeNull();
        }
        expect((await h.su.query("SELECT 1 FROM messages WHERE contact_id = $1 AND initiator = 'assistant' AND channel = 'email' AND status IN ('sent', 'delivered') AND created_at > now() - interval '1 hour'", [l.id])).rows).toEqual([]);
        expect(fake.sent.slice(before).filter((x) => x.to === l.email)).toEqual([]);
        expect(fake.sent.some((x) => x.from.address === personalFrom)).toBe(false);
      } finally {
        await h.su.query(`UPDATE email_identities SET status = 'active' WHERE tenant_id = $1 AND user_id IS NULL AND from_address = $2`, [w.tenantId, TEAM_FROM]);
      }
    }));
});
