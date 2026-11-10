// E38 (DATA_MODEL §5) / R-CONSENT-4: a lead provider's consent text is stored verbatim with the inquiry
// (consent_disclosures, sha256-verified) and recorded in the consent ledger at `inquiry` (expiring after
// the jurisdiction-pack window) when it names another company, or at `express_written` when it names this
// tenant. Since owner decision D1 the level is history only: it never changes who can be messaged; only
// an opt-out blocks. Real Postgres through the real intake route (createApiHarness → createTestDb).
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, inboundSms, randomEmail, sendText } from '../comms/testing.js';
import { command, contactState, intake, postIntake, randomPhone } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const DAY = 86_400_000;
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const zillowText = () => `By submitting you agree to be contacted by Zillow Group and its partners by call, text or email, including by autodialer. Ref ${randomUUID()}`;

interface EventRow {
  channel: string;
  purpose: string;
  event_type: string;
  consent_level: string;
  source: string;
  actor_kind: string;
  disclosure_id: string | null;
  occurred_at: Date;
  recorded_at: Date;
  expires_at: Date | null;
  address_kind: string;
}

async function events(contactId: string): Promise<EventRow[]> {
  const r = await h.su.query<EventRow>(
    `SELECT channel, purpose, event_type, consent_level, source, actor_kind, disclosure_id, occurred_at, recorded_at, expires_at, address_kind
       FROM consent_events WHERE contact_id = $1 ORDER BY address_kind, channel, recorded_at, id`,
    [contactId],
  );
  return r.rows;
}

async function disclosuresWithBody(body: string) {
  return (
    await h.su.query<{ id: string; body: string; body_sha256: string; names_seller: string; source_kind: string; channel_scope: string[]; purpose_scope: string[]; created_at: Date }>(
      'SELECT id, body, body_sha256, names_seller, source_kind, channel_scope, purpose_scope, created_at FROM consent_disclosures WHERE tenant_id = $1 AND body_sha256 = $2',
      [w.tenantId, sha256(body)],
    )
  ).rows;
}

async function inquiryDisclosure(inquiryId: string): Promise<string | null> {
  return (await h.su.query<{ d: string | null }>('SELECT consent_disclosure_id AS d FROM lead_inquiries WHERE id = $1', [inquiryId])).rows[0]!.d;
}

async function stateRows(contactId: string) {
  return (
    await h.su.query<{ channel: string; purpose: string; status: string; consent_level: string }>(
      `SELECT s.channel, s.purpose, s.status, s.consent_level FROM consent_state s
        WHERE s.tenant_id = $2 AND s.address_hmac IN (SELECT address_hmac FROM contact_points WHERE contact_id = $1)
        ORDER BY s.channel, s.purpose`,
      [contactId, w.tenantId],
    )
  ).rows;
}

describe('E38 lead-provider disclosures', () => {
  it('E38 R-CONSENT-4: a provider disclosure naming another company stores the full text (sha256-verified) and records `inquiry` per address and channel, expiring after the 90-day pack window, in the intake transaction', async () => {
    const text = zillowText();
    const phone = randomPhone();
    const email = randomEmail();
    const r = await intake(h, w, { fullName: 'Ezra Provider', phones: [phone], emails: [email], consentDisclosure: { text, namesSeller: 'Zillow Group', channels: ['sms', 'voice', 'email'] } });
    expect(r.outcome).toBe('new_contact');
    const d = await disclosuresWithBody(text);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ body: text, body_sha256: sha256(text), names_seller: 'Zillow Group', source_kind: 'lead_provider', channel_scope: ['sms', 'voice', 'email'], purpose_scope: ['marketing', 'informational'] });
    expect(await inquiryDisclosure(r.inquiryId!)).toBe(d[0]!.id);
    const ev = await events(r.contactId);
    expect(ev.map((e) => [e.address_kind, e.channel])).toEqual([['email', 'email'], ['phone', 'sms'], ['phone', 'voice']]);
    for (const e of ev) {
      expect(e).toMatchObject({ purpose: 'all', event_type: 'grant', consent_level: 'inquiry', source: 'lead_provider', actor_kind: 'system', disclosure_id: d[0]!.id });
      expect(e.expires_at!.getTime() - e.occurred_at.getTime()).toBe(90 * DAY);
    }
    // the same transaction as the contact (now() is the transaction start time)
    const cAt = (await h.su.query<{ t: Date }>('SELECT created_at AS t FROM contacts WHERE id = $1', [r.contactId])).rows[0]!.t.getTime();
    expect([...ev.map((e) => e.recorded_at.getTime()), d[0]!.created_at.getTime()]).toEqual([cAt, cAt, cAt, cAt]);
    // the projection (written with the events) is an unexpired inquiry: history, not a block
    const st = await stateRows(r.contactId);
    expect(st).toHaveLength(6);
    expect(new Set(st.map((s) => `${s.status}:${s.consent_level}`))).toEqual(new Set(['granted:inquiry']));
  });

  it('E38 R-CONSENT-4: a disclosure that names this tenant (brokerage legal name or team name) records `express_written` with no expiry', async () => {
    const names = (await h.su.query<{ b: string; t: string }>('SELECT brokerage_legal_name AS b, team_name AS t FROM tenant_settings WHERE tenant_id = $1', [w.tenantId])).rows[0]!;
    for (const namesSeller of [names.b, `${names.t} and its agents`]) {
      const text = `I agree that ${namesSeller} may text me at the number provided. Ref ${randomUUID()}`;
      const r = await intake(h, w, { fullName: 'Wren Written', phones: [randomPhone()], consentDisclosure: { text, namesSeller, channels: ['sms'], purposes: ['marketing'] } });
      const d = await disclosuresWithBody(text);
      expect(d[0]).toMatchObject({ source_kind: 'lead_provider', channel_scope: ['sms'], purpose_scope: ['marketing'] });
      const ev = await events(r.contactId);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ channel: 'sms', purpose: 'marketing', consent_level: 'express_written', disclosure_id: d[0]!.id, expires_at: null });
    }
  });

  it('E38 R-CONSENT-4: the same disclosure text twice reuses one consent_disclosures row (UNIQUE tenant, body_sha256); the attached inquiry records its own events', async () => {
    const text = zillowText();
    const phone = randomPhone();
    const a = await intake(h, w, { fullName: 'Remy Twice', phones: [phone], inquiryType: 'buy', consentDisclosure: { text, namesSeller: 'Zillow Group', channels: ['sms'] } });
    // a different inquiry for the same (still offered) person attaches
    const b = await intake(h, w, { fullName: 'Remy Twice', phones: [phone], inquiryType: 'sell', consentDisclosure: { text, namesSeller: 'Zillow Group', channels: ['sms'] } });
    expect([b.outcome, b.contactId]).toEqual(['attached', a.contactId]);
    const d = await disclosuresWithBody(text);
    expect(d).toHaveLength(1);
    expect([await inquiryDisclosure(a.inquiryId!), await inquiryDisclosure(b.inquiryId!)]).toEqual([d[0]!.id, d[0]!.id]);
    const ev = await events(a.contactId);
    expect(ev.map((e) => [e.channel, e.consent_level, e.disclosure_id])).toEqual([['sms', 'inquiry', d[0]!.id], ['sms', 'inquiry', d[0]!.id]]);
  });

  it('E38 R-CONSENT-4: an inquiry without a disclosure records no consent event (no consent is manufactured); a duplicate_ignored post records nothing either', async () => {
    const phone = randomPhone();
    const email = randomEmail();
    const r = await intake(h, w, { fullName: 'Noa None', phones: [phone], emails: [email] });
    expect(await events(r.contactId)).toEqual([]);
    expect(await inquiryDisclosure(r.inquiryId!)).toBeNull();
    // the same person + type inside 10 minutes is a fingerprint duplicate: no disclosure, no event
    const text = zillowText();
    const dup = await intake(h, w, { fullName: 'Noa None', phones: [phone], emails: [email], consentDisclosure: { text, namesSeller: 'Zillow Group' } });
    expect([dup.outcome, dup.contactId]).toEqual(['duplicate_ignored', r.contactId]);
    expect(await events(r.contactId)).toEqual([]);
    expect(await disclosuresWithBody(text)).toEqual([]);
  });

  it('E38 R-CONSENT-4: without a disclosure in the body, the lead source\'s configured disclosure is recorded (set once on POST /lead-sources)', async () => {
    const text = zillowText();
    const src = await call<{ source: { id: string }; ingestToken: string }>(w.owner, 'POST', '/lead-sources', { name: `Zillow ${randomUUID().slice(0, 6)}`, kind: 'portal', consentDisclosure: { text, namesSeller: 'Zillow Group', channels: ['sms', 'voice'] } });
    expect(src.status).toBe(201);
    const d = await disclosuresWithBody(text);
    expect(d[0]).toMatchObject({ source_kind: 'lead_provider', channel_scope: ['sms', 'voice'] });
    expect((await h.su.query('SELECT consent_disclosure_id FROM lead_sources WHERE id = $1', [src.body.source.id])).rows[0]).toEqual({ consent_disclosure_id: d[0]!.id });
    const res = await postIntake(h, src.body.ingestToken, { inquiryType: 'buy', fullName: 'Sol Source', phones: [randomPhone()], emails: [randomEmail()] });
    expect(res.statusCode).toBe(201);
    const r = JSON.parse(res.body) as { contactId: string; inquiryId: string };
    expect(await inquiryDisclosure(r.inquiryId)).toBe(d[0]!.id);
    // the scope is the disclosure's: phone channels only, nothing for the email
    expect((await events(r.contactId)).map((e) => [e.channel, e.consent_level, e.disclosure_id])).toEqual([['sms', 'inquiry', d[0]!.id], ['voice', 'inquiry', d[0]!.id]]);
    // input validation: bounded, strict (no tenant id), non-blank
    const bad = await postIntake(h, w.token, { fullName: 'Val Bad', phones: [randomPhone()], consentDisclosure: { text: ' ', namesSeller: 'Zillow Group' } });
    expect(bad.statusCode).toBe(422);
    const forged = await postIntake(h, w.token, { fullName: 'Val Bad', phones: [randomPhone()], consentDisclosure: { text, namesSeller: 'Zillow Group', tenant_id: randomUUID() } });
    expect(forged.statusCode).toBe(422);
    const long = await postIntake(h, w.token, { fullName: 'Val Bad', phones: [randomPhone()], consentDisclosure: { text: 'x'.repeat(10_001), namesSeller: 'Zillow Group' } });
    expect(long.statusCode).toBe(422);
  });
});

describe('E38 under owner decision D1 (consent level is history only)', () => {
  it('E38 R-CONSENT-4: the E38 lead can be texted (the `inquiry` level blocks nothing); only an opt-out blocks, and a later provider disclosure never reinstates it', async () => {
    const agent = w.agents[0]!;
    const phone = randomPhone();
    const r = await intake(h, w, { fullName: 'Dee One', phones: [phone], consentDisclosure: { text: zillowText(), namesSeller: 'Zillow Group', channels: ['sms'] } });
    const st = await contactState(h, r.contactId);
    expect((await command(agent, r.contactId, 'accept', { offerId: st.offer_id })).status).toBe(200);
    expect((await stateRows(r.contactId)).every((s) => s.status === 'granted' && s.consent_level === 'inquiry')).toBe(true);
    const sent = await sendText(agent, r.contactId, 'Hi, following up on the home you asked about.');
    expect([sent.status, sent.body.result]).toEqual([200, 'sent']);
    expect(sent.body.decision?.reasons ?? []).toEqual([]);
    // an opt-out is the only thing that blocks
    expect((await inboundSms(h, phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
    const blocked = await sendText(agent, r.contactId, 'One more thing');
    expect(blocked.body.result).not.toBe('sent');
    expect(blocked.body.decision?.reasons).toContain('CONSENT_REVOKED');
    // a re-inquiry through the provider with a disclosure is recorded as a disclosure, but no event is
    // appended for the opted-out key, so the opt-out stands (only START or the person's own form may lift it)
    const again = await intake(h, w, { fullName: 'Dee One', phones: [phone], inquiryType: 'sell', consentDisclosure: { text: zillowText(), namesSeller: 'Zillow Group', channels: ['sms'] } });
    expect([again.outcome, again.contactId]).toEqual(['reinquiry', r.contactId]);
    expect(await inquiryDisclosure(again.inquiryId!)).not.toBeNull();
    const after = await stateRows(r.contactId);
    expect(after.filter((s) => s.channel === 'sms').map((s) => s.status)).toEqual(['revoked', 'revoked']);
    expect(after.every((s) => s.status === 'revoked')).toBe(true);
    expect((await events(r.contactId)).filter((e) => e.event_type === 'grant')).toHaveLength(1);
    expect((await sendText(agent, r.contactId, 'Still there?')).body.decision?.reasons).toContain('CONSENT_REVOKED');
  });
});

describe('E38 inquiry window comes from the jurisdiction pack', () => {
  it('E38 R-CONSENT-4: a shorter pack inquiry window (VERIFY WITH COUNSEL) sets expires_at = occurred_at + that window', async () => {
    const orig = (await h.su.query<{ rules: Record<string, unknown> }>("SELECT rules FROM jurisdiction_packs WHERE key = 'US' AND status = 'published'")).rows[0]!.rules;
    await h.su.query("UPDATE jurisdiction_packs SET rules = jsonb_set(rules, '{inquiry_basis_days}', '30') WHERE key = 'US' AND status = 'published'");
    try {
      const r = await intake(h, w, { fullName: 'Tess Thirty', phones: [randomPhone()], consentDisclosure: { text: zillowText(), namesSeller: 'Zillow Group', channels: ['sms'] } });
      const ev = await events(r.contactId);
      expect(ev).toHaveLength(1);
      expect(ev[0]!.expires_at!.getTime() - ev[0]!.occurred_at.getTime()).toBe(30 * DAY);
    } finally {
      await h.su.query("UPDATE jurisdiction_packs SET rules = $1::jsonb WHERE key = 'US' AND status = 'published'", [JSON.stringify(orig)]);
    }
  });
});
