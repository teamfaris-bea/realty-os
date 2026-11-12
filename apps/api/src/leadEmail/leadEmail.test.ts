// Lead-email intake end to end through the real server (module 22's lead-email slice; DATA_MODEL R-INBOX-9,
// R-LEM-1..8; E78, E153): the inbound address per lead source, the trust rule, the existing intake (dedupe, inquiry,
// routing, first response to the LEAD's own points, D1), and the Needs review list (accept / discard).
import { ROLES, type Role, can } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LEAD_EMAIL_RESPONSE_SCHEMAS } from './routes.js';
import { freshReauth } from '../admin/testing.js';
import { type AssistantWorld, approvedPlaybook, assistantWorld, call, messagesOf, randomPhone, runJobs } from '../assistant/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { contactState, importedUnassigned, jobs, ledger } from '../leads/testing.js';
import { contactCount, contactsWith, enableInbox, labelledBody, leadAddress, messageRows, outcomeOf, postLeadEmail } from './testing.js';
import { HOLD_SENTENCES } from './trust.js';
import { LEADMETA_HEAD_HTML, forwardedByHand } from './parse/fixtures.js';

let h: ApiHarness;
let w: AssistantWorld;
let address: string;
const others: Partial<Record<Role, TestClient>> = {};

beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 2, teamLead: true });
  for (const role of ['admin', 'isa', 'tc'] as const) others[role] = await h.invite(w.owner, role);
  others.owner = w.owner;
  others.team_lead = w.teamLead!;
  others.agent = w.agents[0]!;
  address = (await enableInbox(h, w.owner, w.sourceId)).address!;
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const FR = ['assistant.first_response', 'comms.dispatch'];
const verified = (o: { name?: string; email?: string; phone?: string; message?: string; property?: string }) => ({ to: address, from: 'Zillow Leads <leads@zillow.com>', dkim: [{ domain: 'zillow.com', result: 'pass' }], text: labelledBody(o) });

describe('R-LEM-1 the inbound address of a lead source', () => {
  it('R-LEM-1: an Owner turns it on: a server-generated leads+<160-bit key>@<inbound domain>, shown again on reload, with the allowed sender domains; only its hash routes; audited', async () => {
    expect(address).toMatch(/^leads\+[0-9a-f]{40}@leads\.realty-os\.invalid$/);
    const again = await call<{ inbox: { address: string; allowedSenderDomains: string[]; suggestedSenderDomains: { domain: string; label: string }[] } }>(w.owner, 'GET', `/lead-sources/${w.sourceId}/lead-email`);
    expect(again.status).toBe(200);
    expect(again.body.inbox.address).toBe(address);
    expect(again.body.inbox.allowedSenderDomains).toEqual(['zillow.com', 'realtor.com', 'portal.test']);
    // a suggestion's label is the portal's name: the page marks it "suggested" and says it is unconfirmed until a
    // test lead from that portal becomes a lead automatically; the VERIFY marker is for engineers and counsel
    // (trust.ts), never in what an Owner reads
    expect(again.body.inbox.suggestedSenderDomains).toEqual([
      { domain: 'zillow.com', label: 'Zillow' },
      { domain: 'realtor.com', label: 'Realtor.com' },
    ]);
    expect(JSON.stringify(again.body)).not.toMatch(/VERIFY/);
    const key = address.slice('leads+'.length, address.indexOf('@'));
    const k = (await h.su.query<{ key_hash: Buffer; key_enc: Buffer }>('SELECT key_hash, key_enc FROM lead_email_inbox_keys WHERE tenant_id = $1', [w.tenantId])).rows;
    expect(k).toHaveLength(1);
    expect(k[0]!.key_enc.toString('latin1')).not.toContain(key); // stored encrypted
    expect(k[0]!.key_hash.toString('hex')).toHaveLength(64);
    const a = (await h.su.query("SELECT actor_kind, changes FROM audit_log WHERE tenant_id = $1 AND action = 'lead_email.inbox_enabled'", [w.tenantId])).rows;
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a[0])).not.toContain(key);
    // enabling twice returns the same inbox
    await freshReauth(h, w.owner);
    expect((await call<{ inbox: { address: string } }>(w.owner, 'POST', `/lead-sources/${w.sourceId}/lead-email`, {})).body.inbox.address).toBe(address);
  });

  it('R-LEM-1 R-PERM-5: only Owner/Admin see or change the address (everyone else 404); changing it needs a fresh re-auth', async () => {
    for (const role of ['team_lead', 'agent', 'isa', 'tc'] as const) {
      expect((await call(others[role]!, 'GET', `/lead-sources/${w.sourceId}/lead-email`)).status, role).toBe(404);
      await freshReauth(h, others[role]!);
      expect((await call(others[role]!, 'POST', `/lead-sources/${w.sourceId}/lead-email/rotate`)).status, role).toBe(404);
    }
    expect((await call(others.admin!, 'GET', `/lead-sources/${w.sourceId}/lead-email`)).status).toBe(200);
    // a stale session cannot rotate (🔒)
    await h.su.query('UPDATE sessions SET reauthenticated_at = NULL WHERE user_id = $1', [others.admin!.userId]);
    const stale = await call(others.admin!, 'POST', `/lead-sources/${w.sourceId}/lead-email/rotate`);
    expect([stale.status, stale.code]).toEqual([401, 'REAUTH_REQUIRED']);
  });

  it('R-LEM-7: allowed sender domains must be registrable domains: no public suffix, no wildcard, no lookalike junk; a change is audited', async () => {
    await freshReauth(h, w.owner);
    for (const bad of ['com', 'co.uk', '*.zillow.com', 'zillow', 'zil low.com', 'https://zillow.com', '-zillow.com']) {
      const r = await call(w.owner, 'PUT', `/lead-sources/${w.sourceId}/lead-email/sender-domains`, { domains: [bad] });
      expect([bad, r.status, r.code]).toEqual([bad, 422, 'LEAD_EMAIL_DOMAIN_INVALID']);
    }
    const ok = await call<{ inbox: { allowedSenderDomains: string[] } }>(w.owner, 'PUT', `/lead-sources/${w.sourceId}/lead-email/sender-domains`, { domains: ['Zillow.com.', 'realtor.com', 'portal.test', 'zillow.com'] });
    expect(ok.body.inbox.allowedSenderDomains).toEqual(['zillow.com', 'realtor.com', 'portal.test']);
    expect((await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'lead_email.sender_domains_changed'", [w.tenantId])).rows[0].n).toBe(1);
  });
});

describe('R-LEM-3 R-INBOX-9 a verified lead email becomes a lead through the existing intake', () => {
  it('R-LEM-3 R-INBOX-9 R-OWN-10: DKIM aligned to an allowlisted domain + a parsed contact point ⇒ contact, inquiry with the lead source and source spans, an offer, the first-response job; the portal address is never a contact point', async () => {
    const email = leadAddress();
    const phone = randomPhone();
    const r = await postLeadEmail(h, verified({ name: 'Dana Field', email, phone, property: '12 Elm St, Springfield, IL 62701', message: 'Can I tour Saturday?' }));
    expect(outcomeOf(r)).toBe('lead_created');
    const [contactId] = await contactsWith(h, w.tenantId, email);
    expect(contactId).toBeDefined();
    const points = (await h.su.query<{ kind: string; address: string }>('SELECT kind, address FROM contact_points WHERE contact_id = $1 ORDER BY kind', [contactId])).rows;
    expect(points).toEqual([{ kind: 'email', address: email }, { kind: 'phone', address: phone }]);
    expect(await contactsWith(h, w.tenantId, 'leads@zillow.com')).toEqual([]);
    const inq = (await h.su.query('SELECT lead_source_id, parse_status, parse_evidence, property_text, postal_code, message FROM lead_inquiries WHERE contact_id = $1', [contactId])).rows;
    expect(inq).toHaveLength(1);
    expect(inq[0]).toMatchObject({ lead_source_id: w.sourceId, parse_status: 'parsed', postal_code: '62701', message: 'Can I tour Saturday?' });
    expect(inq[0].parse_evidence.name).toEqual({ start: expect.any(Number), end: expect.any(Number) });
    const c = await contactState(h, contactId!);
    expect(c.ownership_state).toBe('offered');
    expect(w.agents.map((a) => a.userId)).toContain(c.offered_to_user_id);
    expect((await jobs(h, w.tenantId, 'assistant.first_response')).filter((j) => j.payload.contactId === contactId)).toHaveLength(1);
    const row = (await messageRows(h, w.tenantId)).find((m) => m.contact_id === contactId)!;
    expect(row).toMatchObject({ status: 'lead_created', hold_code: null, parser_kind: 'zillow', sender_domain: 'zillow.com', content_enc: null });
  });

  it('R-OWN-25 R-LEM-3: the same person by lead email again (another listing) attaches to the one contact (dedupe by address); no second first response', async () => {
    const email = leadAddress();
    expect(outcomeOf(await postLeadEmail(h, verified({ name: 'Eli Twice', email, property: '1 A St' })))).toBe('lead_created');
    expect(outcomeOf(await postLeadEmail(h, verified({ name: 'Eli Twice', email, property: '2 B St' })))).toBe('lead_created');
    const ids = await contactsWith(h, w.tenantId, email);
    expect(ids).toHaveLength(1);
    expect((await h.su.query('SELECT count(*)::int AS n FROM lead_inquiries WHERE contact_id = $1', [ids[0]])).rows[0].n).toBe(2);
    expect((await jobs(h, w.tenantId, 'assistant.first_response')).filter((j) => j.payload.contactId === ids[0])).toHaveLength(1);
  });

  // Owner decision D8 (2026-11-12; batch 6 review ownership-sla/F4): an import leaves people unassigned and never
  // routed (no owner in the source, a CSV row, owner decision B4); their next portal lead attached and reached nobody.
  it('R-OWN-20 E341: a lead email from a person an import left unassigned (never routed) routes them like a returning lead through the same intake: the inquiry on them, one offer, no second contact, no first response', async () => {
    const email = leadAddress();
    const id = await importedUnassigned(h, w.tenantId, { firstName: 'Ida', lastName: 'Imported', emails: [email] });
    expect(outcomeOf(await postLeadEmail(h, verified({ name: 'Ida Imported', email, property: '4 Oak St, Springfield, IL 62701', message: 'Still looking, can we talk?' })))).toBe('lead_created');
    expect(await contactsWith(h, w.tenantId, email)).toEqual([id]);
    expect((await h.su.query('SELECT outcome, parse_status, lead_source_id FROM lead_inquiries WHERE contact_id = $1', [id])).rows).toEqual([{ outcome: 'reinquiry', parse_status: 'parsed', lead_source_id: w.sourceId }]);
    expect((await ledger(h, id)).map((e) => [e.type, e.reason_code])).toEqual([['imported', 'IMPORTED'], ['reinquiry', 'REINQUIRY_ROUTE'], ['offered', 'ROUND_ROBIN']]);
    const c = await contactState(h, id);
    expect(c.ownership_state).toBe('offered');
    expect(w.agents.map((a) => a.userId)).toContain(c.offered_to_user_id);
    expect((await h.su.query("SELECT kind FROM notifications WHERE subject_id = $1 AND kind = 'lead_offer'", [id])).rows).toHaveLength(1);
    expect((await jobs(h, w.tenantId, 'assistant.first_response')).filter((j) => j.payload.contactId === id)).toEqual([]);
    const row = (await messageRows(h, w.tenantId)).find((m) => m.contact_id === id)!;
    expect(row).toMatchObject({ status: 'lead_created', hold_code: null });
  });

  it('R-LEM-4 R-AST-16: the first response goes once to the LEAD’s own phone, never to the portal’s sender address', async () => {
    await approvedPlaybook(w.owner, { templateKey: 'new_lead_response' });
    const email = leadAddress();
    const phone = randomPhone();
    const sms = h.providers.telephony.sms.length;
    const mail = h.providers.email.sent.length;
    expect(outcomeOf(await postLeadEmail(h, verified({ name: 'Fay Reply', email, phone })))).toBe('lead_created');
    const [contactId] = await contactsWith(h, w.tenantId, email);
    await runJobs(h, w.tenantId, FR);
    const newSms = h.providers.telephony.sms.slice(sms);
    const newMail = h.providers.email.sent.slice(mail);
    expect(newSms.filter((s) => s.to === phone)).toHaveLength(1);
    expect(newMail.filter((m) => /zillow/i.test(m.to))).toHaveLength(0);
    expect((await messagesOf(h, contactId!)).filter((m) => m.initiator === 'assistant').map((m) => `${m.channel}:${m.status}`)).toEqual(['sms:sent']);
  });

  it('R-LEM-4 D1: a lead whose phone and email opted out is created and routed but never auto-messaged', async () => {
    const email = leadAddress();
    const phone = randomPhone();
    const sms = h.providers.telephony.sms.length;
    const mail = h.providers.email.sent.length;
    expect(outcomeOf(await postLeadEmail(h, verified({ name: 'Gus Optout', email, phone })))).toBe('lead_created');
    const [contactId] = await contactsWith(h, w.tenantId, email);
    for (const kind of ['phone', 'email'] as const) {
      const pid = (await h.su.query<{ id: string }>('SELECT id FROM contact_points WHERE contact_id = $1 AND kind = $2', [contactId, kind])).rows[0]!.id;
      const r = await call(w.owner, 'POST', `/contacts/${contactId}/consent`, { kind: 'revoke', pointId: pid, channel: kind === 'phone' ? 'sms' : 'email', purpose: 'all', evidence: { note: 'asked not to be contacted' } });
      expect(r.status).toBe(200);
    }
    await runJobs(h, w.tenantId, FR);
    expect(h.providers.telephony.sms.slice(sms).filter((s) => s.to === phone)).toHaveLength(0);
    expect(h.providers.email.sent.slice(mail).filter((m) => m.to === email)).toHaveLength(0);
    expect((await messagesOf(h, contactId!)).filter((m) => m.initiator === 'assistant' && m.status === 'sent')).toEqual([]);
    expect((await contactState(h, contactId!)).ownership_state).toBe('offered');
  });
});

describe('R-LEM-5 E153 Needs review', () => {
  let heldId: string;

  it('E153 R-INBOX-9: a "Zillow lead" from an unaligned domain is held: no contact, no routing, no job, nothing sent to the number in it', async () => {
    const phone = randomPhone();
    const before = await contactCount(h, w.tenantId);
    const sms = h.providers.telephony.sms.length;
    const r = await postLeadEmail(h, { to: address, from: 'Zillow <leads@zillow.com>', dkim: [{ domain: 'bulk-mailer.test', result: 'pass' }], text: labelledBody({ name: 'Hal Held', phone }) });
    expect(outcomeOf(r)).toBe('needs_review');
    expect(await contactCount(h, w.tenantId)).toBe(before);
    await runJobs(h, w.tenantId, FR);
    expect(h.providers.telephony.sms.slice(sms).filter((s) => s.to === phone)).toHaveLength(0);
    const row = (await messageRows(h, w.tenantId)).at(-1)!;
    expect(row).toMatchObject({ status: 'needs_review', hold_code: 'DKIM_UNALIGNED', contact_id: null });
    expect(row.content_enc).not.toBeNull();
    expect(row.content_enc!.toString('latin1')).not.toContain('Hal Held'); // encrypted at rest
    heldId = row.id;
  });

  it('R-LEM-6: Owner, Admin and Team Lead see why it was held, with the parsed fields; agents, ISAs and TCs get 404', async () => {
    for (const role of ['owner', 'admin', 'team_lead'] as const) {
      const r = await call<{ items: { id: string; holdCode: string; holdSentence: string; canAccept: boolean; fields: { name: { value: string } | null } }[]; pendingCount: number }>(others[role]!, 'GET', '/lead-email/reviews');
      expect(r.status, role).toBe(200);
      const it = r.body.items.find((x) => x.id === heldId)!;
      expect(it).toMatchObject({ holdCode: 'DKIM_UNALIGNED', canAccept: true });
      expect(it.holdSentence).toMatch(/different domain/);
      expect(it.fields.name?.value).toBe('Hal Held');
      expect(r.body.pendingCount).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(r.body)).not.toMatch(/VERIFY/);
    }
    // every reason a reviewer can be shown is plain words
    for (const s of Object.values(HOLD_SENTENCES)) expect(s).not.toMatch(/VERIFY/);
    for (const role of ['agent', 'isa', 'tc'] as const) expect((await call(others[role]!, 'GET', '/lead-email/reviews')).status, role).toBe(404);
  });

  it('R-LEM-6 R-INBOX-9: a Team Lead accepts it: the same intake creates and routes the lead WITHOUT an autonomous first response; audited; the stored content is purged; a second decision is 409', async () => {
    const r = await call<{ review: { status: string }; contactId: string }>(w.teamLead!, 'POST', `/lead-email/reviews/${heldId}/accept`, {});
    expect(r.status).toBe(200);
    expect(r.body.review.status).toBe('accepted');
    const c = await contactState(h, r.body.contactId);
    expect(c.ownership_state).toBe('offered');
    expect((await jobs(h, w.tenantId, 'assistant.first_response')).filter((j) => j.payload.contactId === r.body.contactId)).toHaveLength(0);
    const row = (await h.su.query('SELECT status, content_enc, parsed_enc, decided_by_user_id, contact_id FROM lead_email_messages WHERE id = $1', [heldId])).rows[0];
    expect(row).toMatchObject({ status: 'accepted', content_enc: null, parsed_enc: null, decided_by_user_id: w.teamLead!.userId, contact_id: r.body.contactId });
    const a = (await h.su.query("SELECT actor_kind, changes, reason FROM audit_log WHERE tenant_id = $1 AND action = 'lead_email.review_accepted' AND entity_id = $2", [w.tenantId, heldId])).rows;
    expect(a).toHaveLength(1);
    expect(a[0].changes.by_user_id).toEqual({ from: null, to: w.teamLead!.userId });
    const again = await call(w.owner, 'POST', `/lead-email/reviews/${heldId}/discard`);
    expect([again.status, again.code]).toEqual([409, 'LEAD_EMAIL_NOT_PENDING']);
  });

  it('R-LEM-6: discard purges the content and creates nothing; audited', async () => {
    const before = await contactCount(h, w.tenantId);
    expect(outcomeOf(await postLeadEmail(h, { to: address, from: 'x@spam.test', dkim: [], text: labelledBody({ name: 'Ivy Spam', email: leadAddress() }) }))).toBe('needs_review');
    const id = (await messageRows(h, w.tenantId)).at(-1)!.id;
    const r = await call<{ review: { status: string } }>(w.owner, 'POST', `/lead-email/reviews/${id}/discard`);
    expect([r.status, r.body.review.status]).toEqual([200, 'discarded']);
    expect(await contactCount(h, w.tenantId)).toBe(before);
    expect((await h.su.query('SELECT content_enc, parsed_enc FROM lead_email_messages WHERE id = $1', [id])).rows[0]).toEqual({ content_enc: null, parsed_enc: null });
    expect((await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'lead_email.review_discarded' AND entity_id = $1", [id])).rows[0].n).toBe(1);
    expect((await call(others.agent!, 'POST', `/lead-email/reviews/${id}/discard`)).status).toBe(404);
  });

  it('E78 R-INBOX-9: a verified email whose format is unreadable is held; accepting needs a phone or email (422), which the reviewer may type', async () => {
    const before = await contactCount(h, w.tenantId);
    const r = await postLeadEmail(h, { to: address, from: 'leads@zillow.com', dkim: [{ domain: 'zillow.com', result: 'pass' }], text: 'Someone is interested in a home. Log in to see the details.' });
    expect(outcomeOf(r)).toBe('needs_review');
    const row = (await messageRows(h, w.tenantId)).at(-1)!;
    expect(['UNKNOWN_FORMAT', 'PARTIAL_FORMAT', 'NO_CONTACT_POINT']).toContain(row.hold_code);
    const no = await call(w.owner, 'POST', `/lead-email/reviews/${row.id}/accept`, {});
    expect([no.status, no.code]).toEqual([422, 'LEAD_EMAIL_NO_CONTACT_POINT']);
    expect(await contactCount(h, w.tenantId)).toBe(before);
    const phone = randomPhone();
    const ok = await call<{ contactId: string }>(w.owner, 'POST', `/lead-email/reviews/${row.id}/accept`, { name: 'Jo Typed', phone });
    expect(ok.status).toBe(200);
    expect((await h.su.query('SELECT address FROM contact_points WHERE contact_id = $1', [ok.body.contactId])).rows).toEqual([{ address: phone }]);
  });
});

describe('R-PERM-1 lead_email.review_* route × role matrix (DATA_MODEL §8 lead-email row)', () => {
  it('R-PERM-1: each role’s HTTP outcome on the review routes equals core.can()', async () => {
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const role of ROLES) {
      const c = others[role]!;
      const ok = (s: number) => (s === 404 ? 'NOT_FOUND' : 'allowed');
      got[`${role} view`] = ok((await call(c, 'GET', '/lead-email/reviews')).status);
      // a fresh held email per role: an authorized discard is 200, anyone else gets 404 and the email stays held
      expect(outcomeOf(await postLeadEmail(h, { to: address, from: 'x@unknown.test', dkim: [], text: labelledBody({ name: `Matrix ${role}`, email: leadAddress() }) }))).toBe('needs_review');
      const held = (await messageRows(h, w.tenantId)).at(-1)!.id;
      got[`${role} decide`] = ok((await call(c, 'POST', `/lead-email/reviews/${held}/discard`)).status);
      const actor = { kind: 'user' as const, userId: c.userId!, tenantId: c.tenantId!, role, sessionId: 'x' };
      want[`${role} view`] = can(actor, 'lead_email_review.view', {}).ok ? 'allowed' : 'NOT_FOUND';
      want[`${role} decide`] = can(actor, 'lead_email_review.decide', {}).ok ? 'allowed' : 'NOT_FOUND';
    }
    expect(got).toEqual(want);
    expect(want).toMatchObject({ 'owner view': 'allowed', 'team_lead decide': 'allowed', 'agent view': 'NOT_FOUND', 'tc decide': 'NOT_FOUND' });
  });
});

describe('R-AST-13 R-TEN-3 response and request schemas', () => {
  it('R-AST-13 R-TEN-3: lead-email response schemas have no confidence* fields and no tenant id fields (snapshot)', () => {
    const shapes: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(LEAD_EMAIL_RESPONSE_SCHEMAS)) {
      const json = z.toJSONSchema(schema);
      const text = JSON.stringify(json);
      expect(text).not.toMatch(/confidence/i);
      expect(text).not.toMatch(/"tenant_id"|"tenantId"/);
      shapes[name] = json;
    }
    expect(shapes).toMatchSnapshot();
  });

  it('R-TEN-3: a tenant id in a request body is refused (strict schemas)', async () => {
    await freshReauth(h, w.owner);
    const r = await call(w.owner, 'PUT', `/lead-sources/${w.sourceId}/lead-email/sender-domains`, { domains: ['zillow.com'], tenantId: w.tenantId });
    expect([r.status, r.code]).toEqual([422, 'VALIDATION_FAILED']);
  });
});

// ---- R-LEM-9..12: personal mailboxes, forwarding, portal catalog, lead metadata (SYNTHETIC fixtures) ------------

let gmailSeq = 0;
/** A consumer-domain address that can never be a real mailbox ('_' and '-' are not allowed in a Gmail account name). */
const syntheticGmail = (who: string) => `synthetic_${who}-${Date.now().toString(36)}-${++gmailSeq}@gmail.com`;
const FORWARDER = `synthetic_forwarder-${Date.now().toString(36)}@gmail.com`;
const handForward = (text: string, from = FORWARDER) => ({ to: address, from: `Agent Sample <${from}>`, subject: 'Fwd: New lead', dkim: [{ domain: 'gmail.com', result: 'pass' }], text });
type Item = { id: string; holdCode: string; holdSentence: string; canAccept: boolean; text: string | null; fields: { name: { value: string } | null; emails: { value: string }[]; phones: { value: string }[] } | null };
const reviewItem = async (id: string): Promise<Item> => (await call<{ items: Item[] }>(w.owner, 'GET', '/lead-email/reviews')).body.items.find((x) => x.id === id)!;
const pointsOf = async (contactId: string) => (await h.su.query<{ address: string }>('SELECT address FROM contact_points WHERE contact_id = $1 ORDER BY address', [contactId])).rows.map((r) => r.address);
const inboxOf = async () => (await call<{ inbox: { allowedSenderDomains: string[]; ignoredSenderDomains: string[]; suggestedSenderDomains: unknown[]; portalCatalog: { portal: string; domain: string; label: string; preTicked: boolean }[] } }>(w.owner, 'GET', `/lead-sources/${w.sourceId}/lead-email`)).body.inbox;

describe('R-LEM-11 personal mailboxes (hand forwards)', () => {
  it('R-LEM-11 E326: a lead forwarded by hand from gmail.com is held PERSONAL_MAILBOX; only the forwarded block is read; the lead’s own gmail address is kept; Accept needs no retyping', async () => {
    const lead = syntheticGmail('lead');
    const phone = randomPhone();
    const before = await contactCount(h, w.tenantId);
    expect(outcomeOf(await postLeadEmail(h, handForward(forwardedByHand('gmail', { lead, phone }))))).toBe('needs_review');
    expect(await contactCount(h, w.tenantId)).toBe(before);
    const row = (await messageRows(h, w.tenantId)).at(-1)!;
    expect(row).toMatchObject({ status: 'needs_review', hold_code: 'PERSONAL_MAILBOX', parser_kind: 'generic', sender_domain: 'gmail.com', contact_id: null });
    const it = await reviewItem(row.id);
    expect(it.holdSentence).toBe(HOLD_SENTENCES.PERSONAL_MAILBOX);
    expect(it.canAccept).toBe(true);
    expect(it.fields?.name?.value).toBe('Sam Lead'); // not the forwarder's note above the marker
    expect(it.fields?.emails.map((e) => e.value)).toEqual([lead]);
    expect(it.text).toContain('FYI see below'); // the reviewer still sees the whole email
    const r = await call<{ contactId: string }>(w.owner, 'POST', `/lead-email/reviews/${row.id}/accept`, {});
    expect(r.status).toBe(200);
    expect(await pointsOf(r.body.contactId)).toEqual([phone, lead].sort());
    expect((await jobs(h, w.tenantId, 'assistant.first_response')).filter((j) => j.payload.contactId === r.body.contactId)).toHaveLength(0);
  });

  it('R-LEM-11 E327: allowlisting gmail.com is refused (reason consumer_mailbox); an older saved entry is ignored by the rule and listed in ignoredSenderDomains', async () => {
    await freshReauth(h, w.owner);
    for (const d of ['gmail.com', 'Outlook.com', 'mail.yahoo.com']) {
      const r = await call<{ error: { details?: { reason?: string } } }>(w.owner, 'PUT', `/lead-sources/${w.sourceId}/lead-email/sender-domains`, { domains: ['zillow.com', d] });
      expect([d, r.status, r.code, r.body.error.details?.reason]).toEqual([d, 422, 'LEAD_EMAIL_DOMAIN_INVALID', 'consumer_mailbox']);
    }
    const saved = (await inboxOf()).allowedSenderDomains;
    expect(saved).not.toContain('gmail.com');
    expect((await inboxOf()).ignoredSenderDomains).toEqual([]);
    // an entry saved before the rule (written directly, as an old row would be)
    await h.su.query("UPDATE integration_connections SET allowed_sender_domains = array_append(allowed_sender_domains, 'gmail.com') WHERE tenant_id = $1 AND kind = 'lead_email' AND lead_source_id = $2", [w.tenantId, w.sourceId]);
    try {
      const inbox = await inboxOf();
      expect(inbox.allowedSenderDomains).toContain('gmail.com');
      expect(inbox.ignoredSenderDomains).toEqual(['gmail.com']);
      // a gmail.com email with gmail.com's own DKIM pass is still not a lead
      expect(outcomeOf(await postLeadEmail(h, { to: address, from: syntheticGmail('sender'), dkim: [{ domain: 'gmail.com', result: 'pass' }], text: labelledBody({ name: 'Gail Mail', email: leadAddress() }) }))).toBe('needs_review');
      expect((await messageRows(h, w.tenantId)).at(-1)!.hold_code).toBe('PERSONAL_MAILBOX');
    } finally {
      await h.su.query('UPDATE integration_connections SET allowed_sender_domains = $3::text[] WHERE tenant_id = $1 AND kind = $4 AND lead_source_id = $2', [w.tenantId, w.sourceId, saved, 'lead_email']);
    }
  });

  it('R-LEM-11 E590: the forwarder’s From address, a member’s account email and alert phone, and a team number are never kept; two accepted forwards of different leads ⇒ two contacts', async () => {
    const agent = w.agents[0]!;
    const memberEmail = (await h.su.query<{ email: string }>('SELECT email::text AS email FROM users WHERE id = $1', [agent.userId])).rows[0]!.email;
    const alert = randomPhone();
    await h.su.query('UPDATE memberships SET alert_phone_e164 = $1, alert_phone_verified_at = now() WHERE tenant_id = $2 AND user_id = $3', [alert, w.tenantId, agent.userId]);
    const forward = (lead: string, phone: string, name: string) =>
      [
        'see below',
        '---------- Forwarded message ---------',
        'From: Zillow <leads@zillow.com>',
        '',
        `Name: ${name}`,
        `Email: ${FORWARDER}`,
        `Email: ${memberEmail.toUpperCase()}`,
        `Email: ${lead}`,
        `Phone: ${alert}`,
        `Phone: ${w.mainNumber}`,
        `Phone: ${phone}`,
      ].join('\n');
    const contacts: string[] = [];
    for (const name of ['Lee One', 'Lee Two']) {
      const lead = syntheticGmail('lead');
      const phone = randomPhone();
      expect(outcomeOf(await postLeadEmail(h, handForward(forward(lead, phone, name))))).toBe('needs_review');
      const row = (await messageRows(h, w.tenantId)).at(-1)!;
      const it = await reviewItem(row.id);
      expect(it.fields?.emails.map((e) => e.value)).toEqual([lead]);
      expect(it.fields?.phones.map((p) => p.value)).toEqual([phone]);
      const r = await call<{ contactId: string }>(w.owner, 'POST', `/lead-email/reviews/${row.id}/accept`, {});
      expect(r.status).toBe(200);
      expect(await pointsOf(r.body.contactId)).toEqual([phone, lead].sort());
      contacts.push(r.body.contactId);
    }
    expect(new Set(contacts).size).toBe(2);
    for (const a of [FORWARDER, memberEmail, alert, w.mainNumber]) expect(await contactsWith(h, w.tenantId, a), a).toEqual([]);
    // the auto-create path drops them too (a verified portal email listing the team's own addresses)
    const lead = leadAddress();
    const text = ['New lead from Zillow', 'Name: Lou Auto', `Email: ${memberEmail}`, `Email: ${lead}`, `Phone: ${w.mainNumber}`, `Phone: ${alert}`].join('\n');
    expect(outcomeOf(await postLeadEmail(h, { to: address, from: 'leads@zillow.com', dkim: [{ domain: 'zillow.com', result: 'pass' }], text }))).toBe('lead_created');
    const [cid] = await contactsWith(h, w.tenantId, lead);
    expect(await pointsOf(cid!)).toEqual([lead]);
    // only team points ⇒ nothing to reach the person by: held, never a lead
    const only = ['New lead from Zillow', 'Name: Lou Team', `Email: ${memberEmail}`, `Phone: ${alert}`].join('\n');
    expect(outcomeOf(await postLeadEmail(h, { to: address, from: 'leads@zillow.com', dkim: [{ domain: 'zillow.com', result: 'pass' }], text: only }))).toBe('needs_review');
    expect((await messageRows(h, w.tenantId)).at(-1)!.hold_code).toBe('NO_CONTACT_POINT');
    // a point the reviewer types is kept, even a team number
    const held = (await messageRows(h, w.tenantId)).at(-1)!;
    const typed = await call<{ contactId: string }>(w.owner, 'POST', `/lead-email/reviews/${held.id}/accept`, { phone: alert });
    expect(typed.status).toBe(200);
    expect(await pointsOf(typed.body.contactId)).toEqual([alert]);
  });
});

describe('R-LEM-12 forwarding', () => {
  const confirmation = (o: { dkim?: { domain: string; result: string }[]; subject?: string; from?: string } = {}) => ({
    to: address,
    from: o.from ?? 'Gmail Team <forwarding-noreply@google.com>',
    subject: o.subject ?? '(#123456789) Gmail Forwarding Confirmation - Receive Mail from someone@example.com',
    dkim: o.dkim ?? [{ domain: 'google.com', result: 'pass' }],
    text: ['someone@example.com has requested to automatically forward mail to your email address.', 'Confirmation code: 123456789', '', 'Name: Not A Lead', `Email: ${leadAddress()}`].join('\n'),
  });

  it('R-LEM-12 E328: a Gmail forwarding confirmation is held FORWARDING_CONFIRMATION naming the requester, never a lead; its code is readable; a forged copy without the aligned pass gets the ordinary hold', async () => {
    const before = await contactCount(h, w.tenantId);
    expect(outcomeOf(await postLeadEmail(h, confirmation()))).toBe('needs_review');
    const row = (await messageRows(h, w.tenantId)).at(-1)!;
    expect(row).toMatchObject({ hold_code: 'FORWARDING_CONFIRMATION', parser_kind: null, contact_id: null, sender_domain: 'google.com' });
    expect(row.content_enc!.toString('latin1')).not.toContain('123456789'); // encrypted at rest
    const it = await reviewItem(row.id);
    expect(it.holdSentence).toBe("someone@example.com asked Gmail to forward its mail here. If you don't know that address, discard this. If you do, give that person the confirmation code in the email below, then discard this email.");
    expect(it.canAccept).toBe(false);
    expect(it.fields).toBeNull();
    expect(it.text).toContain('Confirmation code: 123456789');
    expect(await contactCount(h, w.tenantId)).toBe(before);
    // a subdomain sender with an aligned pass is one too; a subject without the requester has the general sentence
    expect(outcomeOf(await postLeadEmail(h, confirmation({ from: 'forwarding-noreply@mail.google.com', dkim: [{ domain: 'google.com', result: 'pass' }], subject: 'Gmail Forwarding Confirmation' })))).toBe('needs_review');
    const sub = (await messageRows(h, w.tenantId)).at(-1)!;
    expect(sub.hold_code).toBe('FORWARDING_CONFIRMATION');
    expect((await reviewItem(sub.id)).holdSentence).toBe(HOLD_SENTENCES.FORWARDING_CONFIRMATION);
    // forged: no aligned google.com pass ⇒ whatever the trust rule says
    for (const [dkim, code] of [
      [[{ domain: 'attacker.test', result: 'pass' }], 'DKIM_UNALIGNED'],
      [[{ domain: 'gmail.com', result: 'pass' }], 'DKIM_UNALIGNED'],
      [[{ domain: 'google.com', result: 'fail' }], 'DKIM_FAILED'],
      [[], 'DKIM_MISSING'],
    ] as const) {
      expect(outcomeOf(await postLeadEmail(h, confirmation({ dkim: [...dkim] })))).toBe('needs_review');
      expect((await messageRows(h, w.tenantId)).at(-1)!.hold_code).toBe(code);
    }
    expect(outcomeOf(await postLeadEmail(h, confirmation({ from: 'forwarding-noreply@google.com.evil.test', dkim: [{ domain: 'google.com.evil.test', result: 'pass' }] })))).toBe('needs_review');
    expect((await messageRows(h, w.tenantId)).at(-1)!.hold_code).toBe('SENDER_NOT_ALLOWED');
    expect(await contactCount(h, w.tenantId)).toBe(before);
  });

  it('R-LEM-12 E353: accepting a forwarding confirmation, even with a typed phone, is 409 LEAD_EMAIL_NOT_A_LEAD; Discard works', async () => {
    expect(outcomeOf(await postLeadEmail(h, confirmation()))).toBe('needs_review');
    const row = (await messageRows(h, w.tenantId)).at(-1)!;
    const before = await contactCount(h, w.tenantId);
    for (const body of [{}, { phone: randomPhone(), name: 'Typed Person' }]) {
      const r = await call(w.owner, 'POST', `/lead-email/reviews/${row.id}/accept`, body);
      expect([r.status, r.code]).toEqual([409, 'LEAD_EMAIL_NOT_A_LEAD']);
    }
    expect(await contactCount(h, w.tenantId)).toBe(before);
    expect((await h.su.query('SELECT status FROM lead_email_messages WHERE id = $1', [row.id])).rows[0].status).toBe('needs_review');
    const d = await call<{ review: { status: string } }>(w.owner, 'POST', `/lead-email/reviews/${row.id}/discard`);
    expect([d.status, d.body.review.status]).toEqual([200, 'discarded']);
  });

  it('R-LEM-12 E329: an auto-forwarded portal email (To: the agent; our address only in the generic `to` array) routes; signature intact ⇒ lead; broken ⇒ DKIM_FAILED', async () => {
    const lead = leadAddress();
    const fwd = (dkim: { domain: string; result: string }[], email: string) => ({ to: ['agent.sample@example.test', address], from: 'Zillow <leads@zillow.com>', dkim, text: labelledBody({ name: 'Ari Auto', email }) });
    expect(outcomeOf(await postLeadEmail(h, fwd([{ domain: 'zillow.com', result: 'pass' }], lead)))).toBe('lead_created');
    expect(await contactsWith(h, w.tenantId, lead)).toHaveLength(1);
    expect(outcomeOf(await postLeadEmail(h, fwd([{ domain: 'zillow.com', result: 'fail' }], leadAddress())))).toBe('needs_review');
    expect((await messageRows(h, w.tenantId)).at(-1)!.hold_code).toBe('DKIM_FAILED');
    expect(outcomeOf(await postLeadEmail(h, { ...fwd([{ domain: 'zillow.com', result: 'pass' }], leadAddress()), to: ['agent.sample@example.test'] }))).toBe('unrouted');
  });
});

describe('R-LEM-7 R-LEM-9 R-LEM-10 the portal catalog and lead metadata', () => {
  it('R-LEM-7 R-LEM-9: the inbox lists the portal catalog (only Zillow and Realtor.com pre-ticked; suggestedSenderDomains unchanged); no VERIFY in the response', async () => {
    const inbox = await inboxOf();
    expect(inbox.suggestedSenderDomains).toEqual([
      { domain: 'zillow.com', label: 'Zillow' },
      { domain: 'realtor.com', label: 'Realtor.com' },
    ]);
    expect(inbox.portalCatalog).toEqual([
      { portal: 'zillow', domain: 'zillow.com', label: 'Zillow', preTicked: true },
      { portal: 'realtor', domain: 'realtor.com', label: 'Realtor.com', preTicked: true },
      { portal: 'redfin', domain: 'redfin.com', label: 'Redfin', preTicked: false },
      { portal: 'homes', domain: 'homes.com', label: 'Homes.com', preTicked: false },
      { portal: 'homes', domain: 'homesnap.com', label: 'Homes.com', preTicked: false },
      { portal: 'trulia', domain: 'trulia.com', label: 'Trulia', preTicked: false },
      { portal: 'opcity', domain: 'opcity.com', label: 'Opcity', preTicked: false },
    ]);
    expect(JSON.stringify(inbox)).not.toMatch(/VERIFY/);
  });

  it('R-LEM-9: a redfin.com labelled email with redfin.com allowed and an aligned DKIM pass becomes a lead (parser generic)', async () => {
    await freshReauth(h, w.owner);
    const saved = (await inboxOf()).allowedSenderDomains;
    expect((await call(w.owner, 'PUT', `/lead-sources/${w.sourceId}/lead-email/sender-domains`, { domains: [...saved, 'redfin.com'] })).status).toBe(200);
    const lead = leadAddress();
    expect(outcomeOf(await postLeadEmail(h, { to: address, from: 'Redfin <leads@redfin.com>', dkim: [{ domain: 'redfin.com', result: 'pass' }], text: labelledBody({ name: 'Rae Redfin', email: lead }) }))).toBe('lead_created');
    const [cid] = await contactsWith(h, w.tenantId, lead);
    expect((await messageRows(h, w.tenantId)).find((m) => m.contact_id === cid)).toMatchObject({ status: 'lead_created', parser_kind: 'generic', sender_domain: 'redfin.com' });
    expect(await contactsWith(h, w.tenantId, 'leads@redfin.com')).toEqual([]);
  });

  it('R-LEM-10: a verified email carrying leadmetadata.org tags becomes a lead with parser_kind leadmetadata; lead_source never changes the lead source', async () => {
    const lead = leadAddress();
    const html = LEADMETA_HEAD_HTML.replace('Avery.Sample@Example.test', lead).replace('(555) 010-2030', randomPhone());
    expect(outcomeOf(await postLeadEmail(h, { to: address, from: 'leads@portal.test', dkim: [{ domain: 'portal.test', result: 'pass' }], html }))).toBe('lead_created');
    const [cid] = await contactsWith(h, w.tenantId, lead);
    expect((await messageRows(h, w.tenantId)).find((m) => m.contact_id === cid)).toMatchObject({ parser_kind: 'leadmetadata' });
    const inq = (await h.su.query('SELECT lead_source_id, parse_evidence, property_text FROM lead_inquiries WHERE contact_id = $1', [cid])).rows;
    expect(inq).toHaveLength(1);
    expect(inq[0]).toMatchObject({ lead_source_id: w.sourceId, property_text: '5 Birch Ln, Fairview, OR 97024' });
    expect(inq[0].parse_evidence.format).toBe('leadmetadata');
    expect(JSON.stringify(inq[0])).not.toContain('Some Other Portal');
  });
});

describe('b9 comms ownership-data/F3: a forwarder who is no longer active', () => {
  it('b9 comms ownership-data/F3 R-LEM-11 E590 E60: a suspended (or removed) forwarder’s account email and alert phone are still never kept; two accepted forwards ⇒ two contacts', async () => {
    for (const status of ['suspended', 'removed'] as const) {
      const agent = await h.invite(w.owner, 'agent');
      const memberEmail = (await h.su.query<{ email: string }>('SELECT email::text AS email FROM users WHERE id = $1', [agent.userId])).rows[0]!.email;
      const alert = randomPhone();
      await h.su.query('UPDATE memberships SET alert_phone_e164 = $1, alert_phone_verified_at = now() WHERE tenant_id = $2 AND user_id = $3', [alert, w.tenantId, agent.userId]);
      const version = (await h.su.query<{ version: number }>('SELECT version FROM memberships WHERE tenant_id = $1 AND user_id = $2', [w.tenantId, agent.userId])).rows[0]!.version;
      await freshReauth(h, w.owner);
      const p = await call(w.owner, 'PATCH', `/members/${agent.userId}`, { status, version: Number(version) });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      expect((await h.su.query<{ status: string }>('SELECT status FROM memberships WHERE tenant_id = $1 AND user_id = $2', [w.tenantId, agent.userId])).rows[0]!.status).not.toBe('active');
      const contacts: string[] = [];
      for (const name of [`Sue ${status} One`, `Sue ${status} Two`]) {
        const lead = syntheticGmail('lead');
        const phone = randomPhone();
        const text = ['see below', '---------- Forwarded message ---------', 'From: Zillow <leads@zillow.com>', '', `Name: ${name}`, `Email: ${memberEmail}`, `Email: ${lead}`, `Phone: ${alert}`, `Phone: ${phone}`].join('\n');
        expect(outcomeOf(await postLeadEmail(h, handForward(text)))).toBe('needs_review');
        const row = (await messageRows(h, w.tenantId)).at(-1)!;
        const r = await call<{ contactId: string }>(w.owner, 'POST', `/lead-email/reviews/${row.id}/accept`, {});
        expect(r.status).toBe(200);
        expect(await pointsOf(r.body.contactId), status).toEqual([phone, lead].sort());
        contacts.push(r.body.contactId);
      }
      expect(new Set(contacts).size, status).toBe(2);
      for (const a of [memberEmail, alert]) expect(await contactsWith(h, w.tenantId, a), `${status} ${a}`).toEqual([]);
    }
  });
});
