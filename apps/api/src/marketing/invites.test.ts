// Open-house invites (module 29; DATA_MODEL R-MKT-8, R-PAR-12, D1; E94, E152). Every invite is a per-recipient email
// through composeHumanMessage → dispatchOutbound (module 22's one send path): canContact and the DB dispatch guard
// decide each one; opted-out recipients are skipped and counted, never sent, and raise no failed_send exception.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { marketingReady } from '../bulk/testing.js';
import { ownedContact, pointId } from '../comms/testing.js';
import { type MarketingWorld, approve, call, generateAll, marketingWorld, teamListing } from './testing.js';

let h: ApiHarness;
let w: MarketingWorld;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await marketingWorld(h);
  await marketingReady(h, w);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

async function revokeEmail(contactId: string): Promise<void> {
  const pid = await pointId(h, contactId, 'email');
  const r = await call(w.agent, 'POST', `/contacts/${contactId}/consent`, { kind: 'revoke', pointId: pid, channel: 'email', purpose: 'all', evidence: { note: 'asked to stop' } });
  if (r.status !== 200) throw new Error(`revoke ${r.status} ${JSON.stringify(r.body)}`);
}

async function approvedInvite(): Promise<{ id: string; listingId: string }> {
  const l = await teamListing(w.agent, {});
  const p = (await generateAll(w.agent, l, { kinds: ['open_house_invite'] })).open_house_invite!;
  const a = await approve(w.agent, p);
  if (a.status !== 200) throw new Error(`approve: ${JSON.stringify(a.body)}`);
  return { id: p.id, listingId: l };
}

type Sent = { sent: number; total: number; optedOut: number; blocked: number; noEmail: number; text: string; recipients: { contactId: string; outcome: string; messageId: string | null }[] };

describe('R-MKT-8 invites are per-recipient gated emails from an approved version', () => {
  it('E94 R-MKT-8 R-PAR-12: an invitee who unsubscribed between approval and send is blocked; "Sent 4 of 5; 1 opted out"; no failed_send item', async () => {
    const inv = await approvedInvite();
    const people = await Promise.all(Array.from({ length: 5 }, () => ownedContact(w.agent, { consent: false })));
    await revokeEmail(people[2]!.id); // after approval, before the send
    const r = await call<Sent>(w.agent, 'POST', `/marketing-pieces/${inv.id}/invite/send`, { recipientContactIds: people.map((p) => p.id) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sent: 4, total: 5, optedOut: 1, blocked: 0, text: 'Sent 4 of 5; 1 opted out' });
    expect(r.body.recipients.find((x) => x.contactId === people[2]!.id)!.outcome).toBe('opted_out');
    const rows = (await h.su.query("SELECT contact_id, channel, purpose, status, marketing_piece_id FROM messages WHERE marketing_piece_id = $1", [inv.id])).rows;
    expect(rows.filter((m) => m.status === 'sent' || m.status === 'delivered')).toHaveLength(4);
    expect(rows.every((m) => m.channel === 'email' && m.purpose === 'marketing')).toBe(true);
    expect(rows.find((m) => m.contact_id === people[2]!.id)?.status ?? 'blocked').not.toMatch(/sent|delivered/);
    // the fake email outbox never received the opted-out address
    expect(h.providers.email.sent.some((m) => m.to === people[2]!.email)).toBe(false);
    expect((await h.su.query("SELECT count(*)::int AS n FROM exception_items WHERE tenant_id = $1 AND item_type = 'failed_send'", [w.tenantId])).rows[0].n).toBe(0);
    // the same recipient is never sent the same version twice
    const again = await call<Sent>(w.agent, 'POST', `/marketing-pieces/${inv.id}/invite/send`, { recipientContactIds: [people[0]!.id] });
    expect(again.body.sent).toBe(1);
    expect((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE marketing_piece_id = $1 AND contact_id = $2', [inv.id, people[0]!.id])).rows[0].n).toBe(1);
  });

  it('R-MKT-8 R-MKT-1: a draft invite sends nothing (MARKETING_PIECE_NOT_APPROVED); the DB guard refuses an invite row of an unapproved piece too', async () => {
    const l = await teamListing(w.agent, {});
    const p = (await generateAll(w.agent, l, { kinds: ['open_house_invite'] })).open_house_invite!;
    const c = await ownedContact(w.agent, { consent: false });
    const r = await call(w.agent, 'POST', `/marketing-pieces/${p.id}/invite/send`, { recipientContactIds: [c.id] });
    expect([r.status, r.code]).toEqual([409, 'MARKETING_PIECE_NOT_APPROVED']);
    expect((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE marketing_piece_id = $1', [p.id])).rows[0].n).toBe(0);
    const social = (await generateAll(w.agent, l, { kinds: ['social_post'] })).social_post!;
    expect((await approve(w.agent, social)).status).toBe(200);
    const notInvite = await call(w.agent, 'POST', `/marketing-pieces/${social.id}/invite/send`, { recipientContactIds: [c.id] });
    expect(notInvite.code).toBe('MARKETING_NOT_INVITE');
  });

  it('E152 R-MKT-8: an open-house email to 900 contacts, 40 unsubscribed: 860 sent, 40 blocked and counted on the send, not 40 exceptions', async () => {
    const inv = await approvedInvite();
    const ids: string[] = [];
    const batch = 25;
    for (let i = 0; i < 900; i += batch) {
      const made = await Promise.all(Array.from({ length: Math.min(batch, 900 - i) }, () => ownedContact(w.agent, { consent: false, confirmDistinct: true })));
      ids.push(...made.map((m) => m.id));
    }
    for (let i = 0; i < 40; i += 10) await Promise.all(ids.slice(i * 20, i * 20 + 10).map((id) => revokeEmail(id)));
    const optedOut = new Set([0, 1, 2, 3].flatMap((k) => ids.slice(k * 200, k * 200 + 10)));
    expect(optedOut.size).toBe(40);
    const before = (await h.su.query("SELECT count(*)::int AS n FROM exception_items WHERE tenant_id = $1 AND item_type = 'failed_send'", [w.tenantId])).rows[0].n;
    const r = await call<Sent>(w.agent, 'POST', `/marketing-pieces/${inv.id}/invite/send`, { recipientContactIds: ids });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sent: 860, total: 900, optedOut: 40, blocked: 0, text: 'Sent 860 of 900; 40 opted out' });
    for (const x of r.body.recipients) expect(x.outcome === 'opted_out').toBe(optedOut.has(x.contactId));
    expect((await h.su.query("SELECT count(*)::int AS n FROM exception_items WHERE tenant_id = $1 AND item_type = 'failed_send'", [w.tenantId])).rows[0].n).toBe(before);
  }, 300_000);
});
