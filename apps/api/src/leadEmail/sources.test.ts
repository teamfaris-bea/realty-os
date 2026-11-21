// Universal lead-email intake: each source template, the prose fallback, dedupe, routing, the timeline note,
// and the realtor.com / Opcity day-5 reminder. Every address and name here is synthetic.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTx, defaultIds } from '@realty/db';
import { type AssistantWorld, assistantWorld, randomPhone } from '../assistant/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { contactState, jobs } from '../leads/testing.js';
import { remindReferralUpdates } from '../leads/referralUpdate.js';
import { systemActor } from '../worker/systemActor.js';
import {
  AGENTDASH_INVOICE_TEXT,
  AGENTDASH_REREFERRAL_TEXT,
  AGENTDASH_TEXT,
  FALLBACK_PROSE,
  HOMES_TEXT,
  IDX_TEXT,
  OPCITY_LOFTY_TEXT,
  OPCITY_TEXT,
  REALTOR_MARKET_VIP_TEXT,
  REALTOR_TEXT,
  ZILLOW_PREMIER_TEXT,
} from './parse/fixtures.js';
import { contactCount, contactsWith, enableInbox, leadAddress, outcomeOf, postLeadEmail } from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;
let address: string;

beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 1 });
  address = (await enableInbox(h, w.owner, w.sourceId, ['zillow.com', 'realtor.com', 'vu.com', 'opcity.com', 'homes.com', 'lofty.com', 'idx-broker.test', 'forms.idx-site.test'])).address!;
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const post = (fromDomain: string, text: string, subject: string) =>
  postLeadEmail(h, { to: address, from: `Leads <notify@${fromDomain}>`, dkim: [{ domain: fromDomain, result: 'pass' }], text, subject });

const swap = (text: string, email: string, phone = randomPhone()) => text.replace(/[A-Za-z0-9._%+-]+@example\.test/i, email).replace(/\(555\) 555-\d{4}|555-555-\d{4}/, phone);

async function inquiryOf(contactId: string) {
  return (
    await h.su.query<{ id: string; outcome: string; parse_status: string; message: string | null; source_detail: Record<string, unknown> }>(
      'SELECT id, outcome, parse_status, message, source_detail FROM lead_inquiries WHERE contact_id = $1 ORDER BY received_at, id',
      [contactId],
    )
  ).rows;
}

describe('one intake address reads every lead-source email', () => {
  it('AgentDash new referral: contact, Veterans United fields, routing, timeline; a re-referral is the same person', async () => {
    const email = leadAddress();
    const phone = randomPhone();
    const first = await post('vu.com', swap(AGENTDASH_TEXT, email, phone), 'New referral from Veterans United');
    expect(outcomeOf(first)).toBe('lead_created');
    const [contactId] = await contactsWith(h, w.tenantId, email);
    expect(contactId).toBeDefined();
    const inquiries = await inquiryOf(contactId!);
    expect(inquiries).toHaveLength(1);
    expect(inquiries[0]).toMatchObject({
      outcome: 'new_contact',
      parse_status: 'parsed',
      source_detail: expect.objectContaining({ channel: 'lead_email', format: 'agentdash', detected_source: 'Veterans United', military_status: 'Active duty', lender: 'Veterans United', loan_type: 'VA' }),
    });
    expect(inquiries[0]!.source_detail.referral_update).toBeUndefined();
    const state = await contactState(h, contactId!);
    expect(state.ownership_state).toBe('offered');
    expect(state.offered_to_user_id).toBe(w.agents[0]!.userId);
    const note = (await h.su.query<{ source: string; body: string; author_user_id: string | null }>('SELECT source, body, author_user_id FROM notes WHERE contact_id = $1', [contactId])).rows;
    expect(note).toHaveLength(1);
    expect(note[0]).toMatchObject({ source: 'lead_email', author_user_id: null });
    expect(note[0]!.body).toContain('Veterans United');
    expect(note[0]!.body).toContain('100 Oak St');

    const again = await post('vu.com', swap(AGENTDASH_REREFERRAL_TEXT, email, phone), 'Updated referral from Veterans United');
    expect(outcomeOf(again)).toBe('lead_created');
    expect(await contactsWith(h, w.tenantId, email)).toEqual([contactId]);
    const both = await inquiryOf(contactId!);
    expect(both).toHaveLength(2);
    // an offered lead's next inquiry attaches; it does not open a second person or move the offer
    expect(both.map((i) => i.outcome)).toEqual(['new_contact', 'attached']);
    expect((await contactState(h, contactId!)).ownership_state).toBe('offered');
  });

  it('an AgentDash invoice is kept for review and creates nobody, even though it names a phone', async () => {
    const before = await contactCount(h, w.tenantId);
    const r = await post('vu.com', AGENTDASH_INVOICE_TEXT, 'Invoice for closing documents');
    expect(outcomeOf(r)).toBe('needs_review');
    expect(await contactCount(h, w.tenantId)).toBe(before);
    expect(await contactsWith(h, w.tenantId, '5555550199')).toEqual([]);
  });

  it('Zillow Premier Agent, realtor.com Market VIP, Opcity, a Lofty relay, Homes.com, and an IDX form', async () => {
    const cases = [
      { domain: 'zillow.com', text: ZILLOW_PREMIER_TEXT, subject: 'New Zillow contact', format: 'zillow', source: 'Zillow', referral: false },
      { domain: 'realtor.com', text: REALTOR_MARKET_VIP_TEXT, subject: 'New Market VIP Prospect', format: 'realtor', source: 'Realtor.com', referral: true },
      { domain: 'opcity.com', text: OPCITY_TEXT, subject: 'New Opcity referral', format: 'opcity', source: 'Opcity', referral: true },
      { domain: 'lofty.com', text: OPCITY_LOFTY_TEXT, subject: 'New lead - Source Opcity', format: 'opcity', source: 'Opcity', referral: true },
      { domain: 'homes.com', text: HOMES_TEXT, subject: 'New Homes.com lead', format: 'homes', source: 'Homes.com', referral: false },
      { domain: 'forms.idx-site.test', text: IDX_TEXT, subject: 'New IDX inquiry', format: 'generic', source: 'IDX', referral: false },
    ];
    for (const c of cases) {
      const email = leadAddress();
      const r = await post(c.domain, swap(c.text, email), c.subject);
      expect(outcomeOf(r), c.source).toBe('lead_created');
      const [id] = await contactsWith(h, w.tenantId, email);
      const [inq] = await inquiryOf(id!);
      expect(inq!.source_detail, c.source).toMatchObject({ format: c.format, detected_source: c.source, channel: 'lead_email' });
      expect(inq!.source_detail.referral_update, c.source).toBe(c.referral ? true : undefined);
      expect(inq!.parse_status).toBe('parsed');
      expect((await contactState(h, id!)).ownership_state).toBe('offered');
    }
    const plain = leadAddress();
    expect(outcomeOf(await post('realtor.com', swap(REALTOR_TEXT, plain), 'New realtor.com lead'))).toBe('lead_created');
    const [plainId] = await contactsWith(h, w.tenantId, plain);
    expect((await inquiryOf(plainId!))[0]!.source_detail.referral_update).toBeUndefined();
  });

  it('prose with a phone and email still becomes a lead, flagged for review, with no autonomous reply; an unverified copy does not', async () => {
    const email = leadAddress();
    const phone = randomPhone();
    const text = swap(FALLBACK_PROSE, email, phone);
    const before = await contactCount(h, w.tenantId);
    const forged = await postLeadEmail(h, { to: address, from: 'Leads <notify@idx-broker.test>', dkim: [{ domain: 'evil.test', result: 'pass' }], text, subject: 'Question about a listing' });
    expect(outcomeOf(forged)).toBe('needs_review');
    expect(await contactCount(h, w.tenantId)).toBe(before);

    const ok = await post('idx-broker.test', text, 'Question about a listing');
    expect(outcomeOf(ok)).toBe('lead_created');
    const [id] = await contactsWith(h, w.tenantId, email);
    const [inq] = await inquiryOf(id!);
    expect(inq).toMatchObject({ parse_status: 'needs_review', source_detail: expect.objectContaining({ format: 'fallback', detected_source: 'Unparsed email', needs_review: true }) });
    expect(inq!.message).toContain('15 Spruce St');
    expect((await jobs(h, w.tenantId, 'assistant.first_response')).filter((j) => j.payload.contactId === id)).toHaveLength(0);
    const note = (await h.su.query<{ body: string }>('SELECT body FROM notes WHERE contact_id = $1 AND source = $2', [id, 'lead_email'])).rows[0]!.body;
    expect(note).toContain('review the fields');
    expect((await contactState(h, id!)).ownership_state).toBe('offered');
  });
});

describe('realtor.com referral reminder at day 5', () => {
  it('no task before day 5; a task and a feed card after, once; a logged note suppresses it; nothing is sent to the client', async () => {
    const email = leadAddress();
    expect(outcomeOf(await post('opcity.com', swap(OPCITY_TEXT, email), 'New Opcity referral'))).toBe('lead_created');
    const [contactId] = await contactsWith(h, w.tenantId, email);
    const inquiryId = (await inquiryOf(contactId!))[0]!.id;
    const messages = async () => (await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM messages WHERE contact_id = $1', [contactId])).rows[0]!.n;

    const remind = () => withTenantTx(systemActor(w.tenantId, 'worker'), (tx, now) => remindReferralUpdates(tx, defaultIds(), now), { db: h.database });
    expect(await remind()).toEqual({ scanned: 0, opened: 0 });

    await h.su.query(`UPDATE lead_inquiries SET received_at = now() - interval '6 days' WHERE id = $1`, [inquiryId]);
    const sent = await messages();
    expect(await remind()).toEqual({ scanned: 1, opened: 1 });
    expect(await messages()).toBe(sent);
    const task = (await h.su.query<{ id: string; title: string; assignee_user_id: string; notes: string; created_by_kind: string }>('SELECT id, title, assignee_user_id, notes, created_by_kind FROM tasks WHERE contact_id = $1', [contactId])).rows;
    expect(task).toHaveLength(1);
    expect(task[0]).toMatchObject({ title: 'Update this realtor.com referral', assignee_user_id: w.agents[0]!.userId, created_by_kind: 'system' });
    expect(task[0]!.notes).toContain('Nothing was sent to the client');
    const card = (await h.su.query<{ item_type: string; user_id: string; state: string }>('SELECT item_type, user_id, state FROM priority_feed_items WHERE dedupe_key = $1', [`referral_update:${inquiryId}`])).rows;
    expect(card).toEqual([{ item_type: 'task_due', user_id: w.agents[0]!.userId, state: 'open' }]);
    expect(await remind()).toEqual({ scanned: 0, opened: 0 });
    expect((await h.su.query('SELECT count(*)::int AS n FROM tasks WHERE contact_id = $1', [contactId])).rows[0]!.n).toBe(1);

    const quiet = leadAddress();
    expect(outcomeOf(await post('opcity.com', swap(OPCITY_TEXT, quiet), 'New Opcity referral'))).toBe('lead_created');
    const [quietId] = await contactsWith(h, w.tenantId, quiet);
    const quietInquiry = (await inquiryOf(quietId!))[0]!.id;
    await h.su.query(`UPDATE lead_inquiries SET received_at = now() - interval '6 days' WHERE id = $1`, [quietInquiry]);
    await h.su.query(`INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body, source) VALUES ($1, $2, $3, $4, 'Called and logged the referral update', 'manual')`, [w.tenantId, randomUUID(), quietId, w.owner.userId]);
    expect(await remind()).toEqual({ scanned: 1, opened: 0 });
    expect((await h.su.query('SELECT count(*)::int AS n FROM tasks WHERE contact_id = $1', [quietId])).rows[0]!.n).toBe(0);
    expect((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE contact_id = $1', [quietId])).rows[0]!.n).toBe(0);
  });
});
