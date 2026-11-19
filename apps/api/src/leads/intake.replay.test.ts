// Webhook replay on the lead intake endpoint (security-hardening lane, docs/SECURITY.md §Webhooks).
//
// A lead source signs `t.rawBody` with HMAC-SHA256; the guard accepts t within ±5 minutes. Inside that
// window a captured delivery can be re-sent byte for byte. Lead sources send no provider event id, so
// idempotency rests on intake's own dedup: (source, external id), else the inquiry fingerprint for
// FINGERPRINT_WINDOW_MS. These tests pin that a replay inside the signature window can never create a
// second inquiry, contact or routing — which needs the fingerprint window to outlast the signature window.
import { FINGERPRINT_WINDOW_MS } from '@realty/core/ownership';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AssistantWorld, approvedPlaybook, assistantWorld, call, ownedContact, randomEmail, runJobs } from '../assistant/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { chatSource, createWidget, openChat, pointsOf } from '../channels/testing.js';
import { contactsWith, enableInbox, outcomeOf, postLeadEmail } from '../leadEmail/testing.js';
import { SIGNATURE_FUTURE_SKEW_S, SIGNATURE_TOLERANCE_S, signedHeader } from '../providers/webhooks.js';
import { type LeadsWorld, jobs, leadsWorld, postIntake, randomPhone } from './testing.js';

let h: ApiHarness;
let w: LeadsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await leadsWorld(h, { agents: 1 });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

async function replayTwice(body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const headers = { 'content-type': 'application/json', 'x-realty-signature': signedHeader(h.config.webhookSecrets.lead, Math.floor(Date.now() / 1000), raw) };
  const send = () => h.app.inject({ method: 'POST', url: `/api/intake/${w.token}`, headers, payload: raw });
  const first = await send();
  const second = await send();
  return { first, second };
}

const counts = async () => {
  const q = await h.su.query<{ contacts: number; inquiries: number; offers: number }>(
    `SELECT (SELECT count(*)::int FROM contacts WHERE tenant_id = $1) AS contacts,
            (SELECT count(*)::int FROM lead_inquiries WHERE tenant_id = $1 AND outcome <> 'duplicate_ignored') AS inquiries,
            (SELECT count(*)::int FROM lead_ownership_events WHERE tenant_id = $1 AND type = 'offered') AS offers`,
    [w.tenantId],
  );
  return q.rows[0]!;
};

describe('lead intake webhook replay', () => {
  it('the inquiry fingerprint window outlasts the signature replay window (so every in-window replay is deduplicated)', () => {
    // a delivery is accepted while t ∈ [now − TOLERANCE, now + FUTURE_SKEW], so a replay lands at most
    // TOLERANCE + FUTURE_SKEW (+1 s of rounding) after the first receipt
    expect(FINGERPRINT_WINDOW_MS).toBeGreaterThan((SIGNATURE_TOLERANCE_S + SIGNATURE_FUTURE_SKEW_S + 1) * 1000);
  });

  it('R-OWN-25 E19: a byte-identical replay of a signed delivery (phone lead) is duplicate_ignored: no second contact, inquiry or offer', async () => {
    const before = await counts();
    const { first, second } = await replayTwice({ inquiryType: 'buy', fullName: 'Rae Play', phones: [randomPhone()] });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { outcome: string }).outcome).toBe('duplicate_ignored');
    const after = await counts();
    expect(after.contacts - before.contacts).toBe(1);
    expect(after.inquiries - before.inquiries).toBe(1);
    expect(after.offers - before.offers).toBe(1);
  });

  it('R-OWN-25 E19: replays of name-only and external-id deliveries are deduplicated too', async () => {
    const before = await counts();
    const nameOnly = await replayTwice({ inquiryType: 'sell', fullName: 'Nomi Phoneless' });
    const withId = await replayTwice({ inquiryType: 'buy', fullName: 'Ext Id', emails: ['ext.id@example.test'], externalId: `ext-${Date.now()}` });
    for (const r of [nameOnly, withId]) {
      expect([200, 201]).toContain(r.first.statusCode);
      expect((r.second.json() as { outcome: string }).outcome).toBe('duplicate_ignored');
    }
    const after = await counts();
    expect(after.contacts - before.contacts).toBe(2);
    expect(after.inquiries - before.inquiries).toBe(2);
  });
});

// ---- the same PERSON again, through a second integration (b19 team-queue lane, replay case (c) of the handoff audit) ----
//
// The tests above replay one delivery byte for byte. These replay a person: the same phone or email arriving from a
// second lead source through a second intake path. Every path ends in the one intake (ingestInquiryInTx), so the
// person is matched by exact phone or email whatever sent them: one contact, each inquiry kept with its own source,
// the 60-second first-response job only for the inquiry that created the person, and at most one live enrolment
// (the enrollment_one_live unique index). Invented people and sources throughout.
describe('replay: the same person through a second integration', () => {
  let aw: AssistantWorld;
  let mailSourceId: string;
  let mailAddress: string;
  const FR = ['assistant.first_response', 'comms.dispatch'];

  beforeAll(async () => {
    aw = await assistantWorld(h, { agents: 2 });
    await approvedPlaybook(aw.owner, { templateKey: 'new_lead_response' });
    const src = await call<{ source: { id: string } }>(aw.owner, 'POST', '/lead-sources', { name: 'Maple Row referral mail (test)', kind: 'referral' });
    if (src.status !== 201) throw new Error(`lead source: ${src.status} ${JSON.stringify(src.body)}`);
    mailSourceId = src.body.source.id;
    mailAddress = (await enableInbox(h, aw.owner, mailSourceId, ['portal.test'])).address!;
  }, 180_000);

  /** a lead email from the invented portal.test sender, DKIM aligned (what the trust rule needs to make a lead of it) */
  const leadEmailFrom = (o: { name: string; phone?: string; email?: string }) =>
    postLeadEmail(h, {
      to: mailAddress,
      from: 'Maple Row Leads <leads@portal.test>',
      subject: 'New lead',
      dkim: [{ domain: 'portal.test', result: 'pass' }],
      text: ['You have a new lead.', '', `Name: ${o.name}`, ...(o.email ? [`Email: ${o.email}`] : []), ...(o.phone ? [`Phone: ${o.phone}`] : []), 'Message: Is the bungalow still available?', '', 'Sent by the portal.'].join('\n'),
    });
  const liveEnrolments = async (contactId: string) =>
    (await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM playbook_enrollments WHERE contact_id = $1 AND state IN ('active','paused')`, [contactId])).rows[0]!.n;
  const firstResponseJobs = async (contactId: string) => (await jobs(h, aw.tenantId, 'assistant.first_response')).filter((j) => j.payload.contactId === contactId).length;
  const inquiriesOf = async (contactId: string) =>
    (await h.su.query<{ lead_source_id: string; outcome: string }>('SELECT lead_source_id, outcome FROM lead_inquiries WHERE contact_id = $1 ORDER BY received_at, id', [contactId])).rows;
  const contactsOfTenant = async () => (await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [aw.tenantId])).rows[0]!.n;

  it('replay: a repeat inquiry through a second integration attaches to the same person and adds no second enrolment', async () => {
    const before = await contactsOfTenant();

    // by PHONE: first the signed webhook of one source, then a lead email of another source
    const phone = randomPhone();
    const first = await postIntake(h, aw.token, { inquiryType: 'buy', fullName: 'Quill Returning', phones: [phone] });
    expect(first.statusCode).toBe(201);
    const quill = (first.json() as { contactId: string }).contactId;
    await runJobs(h, aw.tenantId, FR);
    expect(await liveEnrolments(quill)).toBe(1);
    expect(outcomeOf(await leadEmailFrom({ name: 'Quill Returning', phone }))).toBe('lead_created');
    await runJobs(h, aw.tenantId, FR);
    expect(await contactsWith(h, aw.tenantId, phone)).toEqual([quill]);
    expect(await inquiriesOf(quill)).toEqual([
      { lead_source_id: aw.sourceId, outcome: 'new_contact' },
      { lead_source_id: mailSourceId, outcome: 'attached' },
    ]);
    expect(await liveEnrolments(quill)).toBe(1);
    expect(await firstResponseJobs(quill)).toBe(1);

    // by EMAIL, the other way round: first the lead email, then the signed webhook
    const email = randomEmail();
    expect(outcomeOf(await leadEmailFrom({ name: 'Opal Mailmatch', email }))).toBe('lead_created');
    const [opal] = await contactsWith(h, aw.tenantId, email);
    await runJobs(h, aw.tenantId, FR);
    const again = await postIntake(h, aw.token, { inquiryType: 'sell', fullName: 'Opal Mailmatch', emails: [email.toUpperCase()] });
    expect((again.json() as { contactId: string }).contactId).toBe(opal);
    await runJobs(h, aw.tenantId, FR);
    expect(await contactsWith(h, aw.tenantId, email)).toEqual([opal]);
    expect((await inquiriesOf(opal!)).map((i) => i.lead_source_id)).toEqual([mailSourceId, aw.sourceId]);
    expect(await liveEnrolments(opal!)).toBeLessThanOrEqual(1);
    expect(await firstResponseJobs(opal!)).toBe(1);

    // two people, four inquiries: exactly two contacts were created
    expect((await contactsOfTenant()) - before).toBe(2);
  });

  // Today's deliberate exception (R-INBOX-1, E138, E154), pinned so nobody "fixes" it by accident: what a website-chat
  // visitor TYPES is an unverified claim. Anybody can type anybody's address, so attaching the chat to the person who
  // really has it would hand a stranger that person's thread and point automated replies at an address nobody proved.
  // The chat becomes its own new person holding only its chat identity, and a duplicate suggestion asks a human to
  // decide (merging is a person's decision, R-OWN-24).
  it('replay: a web-chat visitor who types a known address is not attached and gets a duplicate suggestion', async () => {
    const chat = await chatSource(h, aw.owner, aw.tenantId, 'Website chat (test)');
    const widget = await createWidget(h, aw.owner, chat.sourceId);
    const known = await ownedContact(aw.agents[0]!, { firstName: 'Ione' });
    const c = await openChat(h, widget.key, chat.disclosureId, { name: 'Ivo Typed', email: known.email });
    expect(c.contactId).not.toBe(known.id);
    // the typed address is not one of the chat person's points, and the known person gained no inquiry
    expect((await pointsOf(h, c.contactId)).map((p) => p.address)).not.toContain(known.email);
    expect(await contactsWith(h, aw.tenantId, known.email)).toEqual([known.id]);
    expect(await inquiriesOf(known.id)).toEqual([]);
    expect(await inquiriesOf(c.contactId)).toEqual([{ lead_source_id: chat.sourceId, outcome: 'new_contact' }]);
    const dup = (await h.su.query('SELECT match_reason, status FROM contact_duplicate_candidates WHERE (contact_a_id = $1 AND contact_b_id = $2) OR (contact_a_id = $2 AND contact_b_id = $1)', [c.contactId, known.id])).rows;
    expect(dup).toEqual([{ match_reason: 'shared_email', status: 'open' }]);
  });
});
