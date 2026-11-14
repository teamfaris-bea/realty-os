// b18 review B18S-5 (owner product boundary, 2026-11-14): an open-house invite is a mass send (R-MKT-8), so a person a
// lead source marked "No automated contact for leads from this source" sent is left out of it and counted: no message is
// created for them, the answer and its sentence say how many were left out and why, and everyone else is invited as
// before. A made-up source; fakes only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { marketingReady } from '../bulk/testing.js';
import { freshReauth, ownedContact } from '../comms/testing.js';
import { SOURCE_NO_AUTOMATED_CONTACT } from '../leads/automatedContact.js';
import { type MarketingWorld, approve, call, generateAll, marketingWorld, teamListing } from './testing.js';

let h: ApiHarness;
let w: MarketingWorld;
let marked: string;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await marketingWorld(h);
  await marketingReady(h, w);
  marked = (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Partner referral (test)', kind: 'portal' })).body.source.id;
  await freshReauth(h, w.owner);
  expect((await call(w.owner, 'PUT', `/lead-sources/${marked}/ai-care`, { noAiCare: true })).status).toBe(200);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

type Sent = { sent: number; total: number; noAutomatedContact: number; text: string; recipients: { contactId: string; outcome: string; messageId: string | null }[] };

describe('R-LSRC-8 B18S-5: open-house invites leave out leads from a source marked "No automated contact"', () => {
  it('B18S-5 E727: "Sent 2 of 3; 1 left out (No automated contact for leads from their source)": no message for that person, the others are invited', async () => {
    const l = await teamListing(w.agent, {});
    const p = (await generateAll(w.agent, l, { kinds: ['open_house_invite'] })).open_house_invite!;
    expect((await approve(w.agent, p)).status).toBe(200);
    const people = await Promise.all(Array.from({ length: 3 }, () => ownedContact(w.agent, { consent: false })));
    await h.su.query('UPDATE contacts SET original_lead_source_id = $2 WHERE id = $1', [people[1]!.id, marked]);
    const r = await call<Sent>(w.agent, 'POST', `/marketing-pieces/${p.id}/invite/send`, { recipientContactIds: people.map((x) => x.id) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sent: 2, total: 3, noAutomatedContact: 1, text: 'Sent 2 of 3; 1 left out (No automated contact for leads from their source)' });
    expect(r.body.recipients.find((x) => x.contactId === people[1]!.id)).toMatchObject({ outcome: 'no_automated_contact', messageId: null });
    expect((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE marketing_piece_id = $1 AND contact_id = $2', [p.id, people[1]!.id])).rows[0].n).toBe(0);
    expect(h.providers.email.sent.some((m) => m.to === people[1]!.email)).toBe(false);
    expect(SOURCE_NO_AUTOMATED_CONTACT).toBe('SOURCE_NO_AUTOMATED_CONTACT');
  });
});
