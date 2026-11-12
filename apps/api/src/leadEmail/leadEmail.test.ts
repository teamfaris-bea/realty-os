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
