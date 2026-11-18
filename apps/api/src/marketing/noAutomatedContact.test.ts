// b18 review B18S-5 (owner product boundary, 2026-11-14): an open-house invite is a mass send (R-MKT-8), so a person a
// lead source marked "No automated contact for leads from this source" sent is left out of it and counted: no message is
// created for them, the answer and its sentence say how many were left out and why, and everyone else is invited as
// before. A made-up source; fakes only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { marketingReady } from '../bulk/testing.js';
import { freshReauth, ownedContact } from '../comms/testing.js';
import { NO_AUTOMATED_CONTACT_LABEL, SOURCE_NO_AUTOMATED_CONTACT } from '../leads/automatedContact.js';
import { importedPerson } from '../leads/testing.js';
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

type Sent = { sent: number; total: number; noAutomatedContact: number; sourceUnclassified: number; text: string; recipients: { contactId: string; outcome: string; messageId: string | null }[] };

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

describe('R-LSRC-9 A2 A3: open-house invites leave out an imported person whose source is not reviewed yet, under its own words', () => {
  it('R-LSRC-9 E729: "Sent 1 of 3; 1 left out (No automated contact …); 1 left out (imported, source not reviewed yet …)": each reason is counted and worded on its own, and no message is created for either', async () => {
    const l = await teamListing(w.agent, {});
    const p = (await generateAll(w.agent, l, { kinds: ['open_house_invite'] })).open_house_invite!;
    expect((await approve(w.agent, p)).status).toBe(200);
    const people = await Promise.all(Array.from({ length: 3 }, () => ownedContact(w.agent, { consent: false })));
    await h.su.query('UPDATE contacts SET original_lead_source_id = $2 WHERE id = $1', [people[1]!.id, marked]);
    await importedPerson(h, w.tenantId, w.owner.userId!, people[2]!.id);
    const r = await call<Sent>(w.agent, 'POST', `/marketing-pieces/${p.id}/invite/send`, { recipientContactIds: people.map((x) => x.id) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sent: 1, total: 3, noAutomatedContact: 1, sourceUnclassified: 1 });
    expect(r.body.text).toBe('Sent 1 of 3; 1 left out (No automated contact for leads from their source); 1 left out (imported, source not reviewed yet: an Owner reviews it under Lead sources)');
    expect(r.body.recipients.find((x) => x.contactId === people[2]!.id)).toMatchObject({ outcome: 'source_unclassified', messageId: null });
    expect(r.body.recipients.find((x) => x.contactId === people[1]!.id)).toMatchObject({ outcome: 'no_automated_contact', messageId: null });
    expect((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE marketing_piece_id = $1 AND contact_id = ANY ($2::uuid[])', [p.id, [people[1]!.id, people[2]!.id]])).rows[0].n).toBe(0);
    expect(h.providers.email.sent.some((m) => m.to === people[2]!.email)).toBe(false);
    expect(NO_AUTOMATED_CONTACT_LABEL).toBe('No automated contact for leads from this source');
  });

  it('R-LSRC-9 R-PERM-5: a person the sender cannot see keeps the plain "no email" outcome: the invite never reveals that an unseen record is imported, unreviewed or a marked source\'s', async () => {
    const l = await teamListing(w.agent, {});
    const p = (await generateAll(w.agent, l, { kinds: ['open_house_invite'] })).open_house_invite!;
    expect((await approve(w.agent, p)).status).toBe(200);
    // two people another agent holds (the sending agent's row-level security does not show them)
    const unseenUnreviewed = await ownedContact(w.agents[1]!, { consent: false });
    const unseenMarked = await ownedContact(w.agents[1]!, { consent: false });
    expect((await call(w.agent, 'GET', `/contacts/${unseenUnreviewed.id}`)).status).toBe(404);
    await importedPerson(h, w.tenantId, w.owner.userId!, unseenUnreviewed.id);
    await h.su.query('UPDATE contacts SET original_lead_source_id = $2 WHERE id = $1', [unseenMarked.id, marked]);
    const r = await call<Sent>(w.agent, 'POST', `/marketing-pieces/${p.id}/invite/send`, { recipientContactIds: [unseenUnreviewed.id, unseenMarked.id] });
    expect(r.status).toBe(200);
    expect(r.body.recipients.map((x) => x.outcome)).toEqual(['no_email', 'no_email']);
    expect(r.body).toMatchObject({ sent: 0, noAutomatedContact: 0, sourceUnclassified: 0 });
  });
});
