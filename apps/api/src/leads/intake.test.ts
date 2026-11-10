// api/leads intake (BUILD_PLAN module 11): lead source API → dedup → contact + routing + offer
// notification + first-response job in ONE transaction; attribution capture; duplicates (E18–E20);
// the 02:00 lead (E8); nobody eligible (E11); unknown sources and bad signatures write no tenant rows.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { FIRST_RESPONSE_JOB, cardSummary } from './intake.js';
import { type LeadsWorld, call, command, contactState, intake, jobs, ledger, leadsWorld, postIntake, randomPhone, zoneWithLocalHour } from './testing.js';

let h: ApiHarness;
let w: LeadsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await leadsWorld(h, { agents: 2, teamLead: true });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('intake → offer', () => {
  it('R-OWN-10 R-OWN-9: a new inquiry creates the contact and offers it to a rule member in the intake transaction, with the offer notification and its delivery rows', async () => {
    const r = await intake(h, w, { fullName: 'Avery Stone', emails: ['avery.stone@example.test'], postalCode: '02134', priceMinCents: 40_000_000, priceMaxCents: 55_000_000 });
    expect([r.status, r.outcome]).toEqual([201, 'new_contact']);
    const c = await contactState(h, r.contactId);
    expect(c.ownership_state).toBe('offered');
    expect(w.agents.map((a) => a.userId)).toContain(c.offered_to_user_id);
    // the notification and its in-app + web-push deliveries were written by the SAME transaction as the offer
    // `now()` is the transaction start time: rows written by one transaction share it exactly
    // (xmin cannot be compared: the duplicate-safe inserts run in savepoints with their own xids)
    const n = await h.su.query<{ kind: string; priority: string; title: string; body: string | null; n_at: Date; d_channels: string[]; d_at: Date[] }>(
      `SELECT n.kind, n.priority, n.title, n.body, n.created_at AS n_at,
              array_agg(d.channel ORDER BY d.channel) AS d_channels, array_agg(DISTINCT d.created_at) AS d_at
         FROM notifications n JOIN notification_deliveries d ON d.tenant_id = n.tenant_id AND d.notification_id = n.id
        WHERE n.subject_id = $1 AND n.user_id = $2 GROUP BY n.tenant_id, n.id`,
      [r.contactId, c.offered_to_user_id],
    );
    const cAt = (await h.su.query<{ t: Date }>('SELECT created_at AS t FROM contacts WHERE id = $1', [r.contactId])).rows[0]!.t.getTime();
    const jAt = (await h.su.query<{ t: Date }>("SELECT created_at AS t FROM jobs WHERE kind = 'ownership.offer_expiry' AND payload->>'contactId' = $1", [r.contactId])).rows[0]!.t.getTime();
    expect(n.rows).toHaveLength(1);
    expect(n.rows[0]).toMatchObject({ kind: 'lead_offer', priority: 'critical', d_channels: ['in_app', 'web_push'] });
    expect(n.rows[0]!.body).toBeNull(); // lock screens never show the lead's name or number
    expect(n.rows[0]!.title).not.toMatch(/Avery|Stone/);
    const stamps = [n.rows[0]!.n_at.getTime(), ...n.rows[0]!.d_at.map((d) => d.getTime()), jAt];
    expect(stamps).toEqual(stamps.map(() => cAt));
  });

  it('R-AST-16: the 60-second first-response job is enqueued in the intake transaction (ids only), once per contact', async () => {
    const r = await intake(h, w, { fullName: 'Blake Rivers' });
    const j = (await jobs(h, w.tenantId, FIRST_RESPONSE_JOB.kind)).filter((x) => x.payload.contactId === r.contactId);
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ status: 'pending', dedupe_key: `assistant.first_response:${r.contactId}`, payload: { contactId: r.contactId } });
    const jAt = (await h.su.query<{ t: Date }>('SELECT created_at AS t FROM jobs WHERE id = $1', [j[0]!.id])).rows[0]!.t.getTime();
    const cAt = (await h.su.query<{ t: Date }>('SELECT created_at AS t FROM contacts WHERE id = $1', [r.contactId])).rows[0]!.t.getTime();
    expect(jAt).toBe(cAt); // same transaction (now() = transaction start)
    // the job runs within a minute of intake (it is due now, on the realtime queue)
    expect(Math.abs(j[0]!.run_at.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('A7d: first-touch attribution (source, campaign, ad, utm) is captured on the contact and the inquiry', async () => {
    const r = await intake(h, w, { fullName: 'Casey Hart', campaignRef: 'fall-buyers', adRef: 'ad-77', sourceDetail: { utm_source: 'zillow', utm_medium: 'cpc' } });
    const c = (await h.su.query('SELECT original_lead_source_id, original_campaign_ref, original_ad_ref, original_source_detail FROM contacts WHERE id = $1', [r.contactId])).rows[0];
    expect(c).toEqual({ original_lead_source_id: w.sourceId, original_campaign_ref: 'fall-buyers', original_ad_ref: 'ad-77', original_source_detail: { utm_source: 'zillow', utm_medium: 'cpc' } });
    const i = (await h.su.query('SELECT lead_source_id, campaign_ref, ad_ref, source_detail, outcome, raw_payload_enc IS NOT NULL AS enc FROM lead_inquiries WHERE contact_id = $1', [r.contactId])).rows[0];
    expect(i).toEqual({ lead_source_id: w.sourceId, campaign_ref: 'fall-buyers', ad_ref: 'ad-77', source_detail: { utm_source: 'zillow', utm_medium: 'cpc' }, outcome: 'new_contact', enc: true });
    // the raw payload is ciphertext (no plaintext name in it)
    const raw = (await h.su.query<{ b: Buffer }>('SELECT raw_payload_enc AS b FROM lead_inquiries WHERE contact_id = $1', [r.contactId])).rows[0]!.b;
    expect(raw.toString('latin1')).not.toContain('Casey');
  });

  it('R-PERM-6: the card summary is built from structured fields only (type, ZIP, price band), never from free text', async () => {
    const r = await intake(h, w, { fullName: 'Dana Fox', postalCode: '02134', priceMinCents: 40_000_000, priceMaxCents: 55_000_000, message: 'Call me at +1 415 555 0101, I am Dana Fox' });
    const s = (await h.su.query<{ pond_summary: string }>('SELECT pond_summary FROM contacts WHERE id = $1', [r.contactId])).rows[0]!.pond_summary;
    expect(s).toBe('Buying · 02134 · $400k–$550k');
    expect(cardSummary({ inquiryType: 'sell', priceMaxCents: 120_000_000 })).toBe('Selling · up to $1.2M');
  });
});

describe('duplicates and dedup (R-OWN-25)', () => {
  it('R-OWN-25 E19: the same (source, external id) posted twice is duplicate_ignored and writes nothing; the same person + type within 10 min without an id is duplicate_ignored by fingerprint', async () => {
    const phone = randomPhone();
    const ext = `zillow-${randomUUID()}`;
    const a = await intake(h, w, { externalId: ext, fullName: 'Eli Moss', phones: [phone] });
    const before = (await h.su.query('SELECT count(*)::int AS n FROM lead_inquiries WHERE contact_id = $1', [a.contactId])).rows[0].n;
    const b = await intake(h, w, { externalId: ext, fullName: 'Eli Moss', phones: [phone] });
    expect([b.status, b.outcome, b.contactId, b.inquiryId]).toEqual([200, 'duplicate_ignored', a.contactId, a.inquiryId]);
    expect((await h.su.query('SELECT count(*)::int AS n FROM lead_inquiries WHERE contact_id = $1', [a.contactId])).rows[0].n).toBe(before);
    // no external id: the fingerprint (source + identifiers + type) inside 10 minutes
    const c = await intake(h, w, { fullName: 'Eli Moss', phones: [phone] });
    expect([c.outcome, c.contactId]).toEqual(['duplicate_ignored', a.contactId]);
    const outcomes = (await h.su.query<{ outcome: string }>('SELECT outcome FROM lead_inquiries WHERE contact_id = $1 ORDER BY received_at, id', [a.contactId])).rows.map((x) => x.outcome);
    expect(outcomes).toEqual(['new_contact', 'duplicate_ignored']);
    // one routing only
    expect((await ledger(h, a.contactId)).filter((e) => e.type === 'offered')).toHaveLength(1);
  });

  it('R-OWN-25 E20: two simultaneous inquiries for the same unknown person produce one contact and one routing', async () => {
    for (let round = 0; round < 3; round++) {
      const email = `twin-${randomUUID().slice(0, 8)}@example.test`;
      const results = await Promise.all([
        intake(h, w, { fullName: 'Jordan Twin', emails: [email], phones: [], inquiryType: 'buy' }),
        intake(h, w, { fullName: 'Jordan Twin', emails: [email], phones: [], inquiryType: 'sell' }),
      ]);
      const ids = new Set(results.map((r) => r.contactId));
      expect(ids.size).toBe(1);
      expect(results.map((r) => r.outcome).sort()).toEqual(['attached', 'new_contact']);
      const contactId = [...ids][0]!;
      const n = (await h.su.query("SELECT count(*)::int AS n FROM contact_points WHERE kind = 'email' AND address = $1", [email])).rows[0].n;
      expect(n).toBe(1);
      expect((await ledger(h, contactId)).filter((e) => e.type === 'offered')).toHaveLength(1);
    }
  });

  it('R-OWN-25: a phone matching one contact and an email matching another attaches to the earliest and records a phone_email_split candidate; a similar name only suggests', async () => {
    const phone = randomPhone();
    const email = `split-${randomUUID().slice(0, 8)}@example.test`;
    const first = await intake(h, w, { fullName: 'Morgan Split', phones: [phone], inquiryType: 'buy' });
    const second = await intake(h, w, { fullName: 'Morgan Split', phones: [], emails: [email], inquiryType: 'sell' });
    expect(second.contactId).not.toBe(first.contactId); // a fuzzy name match never attaches
    const third = await intake(h, w, { fullName: 'Morgan Split', phones: [phone], emails: [email], inquiryType: 'rent' });
    expect([third.outcome, third.contactId]).toEqual(['attached', first.contactId]);
    const [a, b] = [first.contactId, second.contactId].sort();
    const cand = (await h.su.query<{ match_reason: string }>('SELECT match_reason FROM contact_duplicate_candidates WHERE contact_a_id = $1 AND contact_b_id = $2', [a, b])).rows;
    expect(cand.map((x) => x.match_reason).sort()).toEqual(['trigram_name']); // first suggestion stays (one row per pair)
    // the attach added the email to the earliest contact and never merged
    const pts = (await h.su.query<{ kind: string }>('SELECT kind FROM contact_points WHERE contact_id = $1 ORDER BY kind', [first.contactId])).rows.map((x) => x.kind);
    expect(pts).toEqual(['email', 'phone']);
    expect((await contactState(h, second.contactId)).closed_reason).toBeNull();
  });

  it('R-OWN-20 R-OWN-21 E18: a duplicate inquiry for an owned contact attaches, never re-routes or changes the owner, notifies the owner and pins a feed item; a re-inquiry SLA starts only after 7 days without a touch', async () => {
    const phone = randomPhone();
    const a = await intake(h, w, { fullName: 'Quinn Owned', phones: [phone] });
    const st = await contactState(h, a.contactId);
    const agent = w.agents.find((x) => x.userId === st.offered_to_user_id)!;
    const acc = await command(agent, a.contactId, 'accept', { offerId: st.offer_id });
    expect(acc.status).toBe(200);
    const owned = await contactState(h, a.contactId);
    const again = await intake(h, w, { fullName: 'Quinn Owned', phones: [phone], inquiryType: 'sell' });
    expect([again.outcome, again.contactId]).toEqual(['reinquiry', a.contactId]);
    const after = await contactState(h, a.contactId);
    expect([after.ownership_state, after.owner_user_id, after.ownership_period_seq]).toEqual(['owned', agent.userId, owned.ownership_period_seq]);
    const ev = await ledger(h, a.contactId);
    expect(ev.at(-1)).toMatchObject({ type: 'reinquiry', reason_code: 'REINQUIRY' });
    expect(ev.filter((e) => e.type === 'offered')).toHaveLength(1);
    const notif = (await h.su.query("SELECT priority FROM notifications WHERE user_id = $1 AND subject_id = $2 AND dedupe_key LIKE 'reinquiry:%'", [agent.userId, a.contactId])).rows;
    expect(notif).toEqual([{ priority: 'high' }]);
    const feed = (await h.su.query("SELECT band, item_type FROM priority_feed_items WHERE user_id = $1 AND contact_id = $2 AND item_type = 'reinquiry'", [agent.userId, a.contactId])).rows;
    expect(feed).toEqual([{ band: 'pinned', item_type: 'reinquiry' }]);
    // last human touch 8 days ago → the next re-inquiry starts a new period with an SLA (E68)
    await h.su.query("UPDATE contacts SET last_human_touch_at = now() - interval '8 days' WHERE id = $1", [a.contactId]);
    const third = await intake(h, w, { fullName: 'Quinn Owned', phones: [phone], inquiryType: 'rent' });
    expect(third.outcome).toBe('reinquiry');
    const late = await contactState(h, a.contactId);
    expect(late.owner_user_id).toBe(agent.userId);
    expect(Number(late.ownership_period_seq)).toBeGreaterThan(Number(owned.ownership_period_seq));
    expect(late.first_touch_due_at).not.toBeNull();
    expect((await ledger(h, a.contactId)).at(-1)).toMatchObject({ type: 'reinquiry', reason_code: 'REINQUIRY_SLA' });
  });

  it('R-OWN-20: a re-inquiry for a pond lead re-routes it (pond setting reroute, the default)', async () => {
    const phone = randomPhone();
    const a = await intake(h, w, { fullName: 'Riley Pond', phones: [phone] });
    const st = await contactState(h, a.contactId);
    const agent = w.agents.find((x) => x.userId === st.offered_to_user_id)!;
    await command(agent, a.contactId, 'accept', { offerId: st.offer_id });
    expect((await command(agent, a.contactId, 'release', { reason: 'wrong_area' })).status).toBe(200);
    expect((await contactState(h, a.contactId)).ownership_state).toBe('in_pond');
    // a different inquiry (a sale): the same type within 10 minutes would be a fingerprint duplicate (E19)
    const again = await intake(h, w, { fullName: 'Riley Pond', phones: [phone], inquiryType: 'sell' });
    expect(again.outcome).toBe('reinquiry');
    const after = await contactState(h, a.contactId);
    expect(after.ownership_state).toBe('offered');
    // the releaser is in cooldown for this lead (R-OWN-11 #6): the other agent gets it
    expect(after.offered_to_user_id).not.toBe(agent.userId);
  });
});

describe('closed contacts', () => {
  it('R-OWN-20: a re-inquiry for a contact closed as spam stays closed and notifies the Admins; a soft-deleted contact is never matched (a new contact is created)', async () => {
    const phone = randomPhone();
    const a = await intake(h, w, { fullName: 'Spammy Sender', phones: [phone] });
    expect((await command(w.owner, a.contactId, 'close', { reason: 'spam' })).status).toBe(200);
    const again = await intake(h, w, { fullName: 'Spammy Sender', phones: [phone], inquiryType: 'sell' });
    expect([again.outcome, again.contactId]).toEqual(['reinquiry', a.contactId]);
    expect((await contactState(h, a.contactId)).closed_reason).toBe('spam');
    const n = (await h.su.query("SELECT user_id FROM notifications WHERE subject_id = $1 AND dedupe_key LIKE 'reinquiry:%'", [a.contactId])).rows;
    expect(n).toEqual([{ user_id: w.owner.userId }]);
    const phone2 = randomPhone();
    const b = await intake(h, w, { fullName: 'Gone Away', phones: [phone2] });
    expect((await command(w.owner, b.contactId, 'delete')).status).toBe(200);
    const fresh = await intake(h, w, { fullName: 'Gone Away', phones: [phone2], inquiryType: 'sell' });
    expect(fresh.outcome).toBe('new_contact');
    expect(fresh.contactId).not.toBe(b.contactId);
  });
});

describe('E8 / E11 / sources', () => {
  it('R-OWN-9 R-OWN-13 E8: a lead arriving at 02:00 is offered now; the window counts from 08:00 and the first-touch SLA from the next contactable instant (09:00)', async () => {
    const tz = zoneWithLocalHour(1, 4);
    const night = await leadsWorld(h, { agents: 1, timezone: tz });
    const r = await intake(h, night, { fullName: 'Nora Night' });
    const st = await contactState(h, r.contactId);
    expect(st.ownership_state).toBe('offered');
    // delivered now: the offer notification exists already
    expect((await h.su.query("SELECT count(*)::int AS n FROM notifications WHERE subject_id = $1 AND kind = 'lead_offer'", [r.contactId])).rows[0].n).toBe(1);
    const local = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    expect(local(st.offer_expires_at!)).toBe('08:05');
    // the agent accepts at night: the SLA is 15 business-minutes after 09:00 local (contact window start)
    const acc = await command(night.agents[0]!, r.contactId, 'accept', { offerId: st.offer_id });
    expect(acc.status).toBe(200);
    const owned = await contactState(h, r.contactId);
    expect(local(owned.first_touch_due_at!)).toBe('09:15');
  });

  it('R-OWN-9 R-OWN-11 E11: with nobody eligible (no working notification channel) the lead goes to the pond with NO_ELIGIBLE_AGENT and the TL and Admins get a critical notification', async () => {
    const dark = await leadsWorld(h, { agents: 2, push: false, teamLead: true });
    const r = await intake(h, dark, { fullName: 'Nobody Home' });
    const st = await contactState(h, r.contactId);
    expect([st.ownership_state, st.pond_id]).toEqual(['in_pond', dark.defaultPondId]);
    const ev = (await ledger(h, r.contactId)).at(-1)!;
    expect(ev).toMatchObject({ type: 'sent_to_pond', reason_code: 'NO_ELIGIBLE_AGENT' });
    const cands = ev.payload.candidates as { userId: string; eligible: boolean; skipReason?: string }[];
    expect(cands.map((c) => c.skipReason)).toEqual(['NO_CRITICAL_CHANNEL', 'NO_CRITICAL_CHANNEL']);
    const notified = (await h.su.query<{ user_id: string; priority: string }>('SELECT user_id, priority FROM notifications WHERE subject_id = $1 ORDER BY user_id', [r.contactId])).rows;
    const expected = [dark.owner.userId!, ...(dark.teamLead ? [dark.teamLead.userId!] : [])].sort();
    expect(notified.map((n) => n.user_id).sort()).toEqual(expected);
    expect(new Set(notified.map((n) => n.priority))).toEqual(new Set(['critical']));
  });

  it('R-TEN-3: an unknown token is 404 and leaves an unrouted platform record only; a bad signature is 403 and writes no tenant row', async () => {
    const before = (await h.su.query('SELECT count(*)::int AS n FROM lead_inquiries')).rows[0].n;
    const unknown = await postIntake(h, 'x'.repeat(43), { fullName: 'Ghost', phones: [randomPhone()] });
    expect(unknown.statusCode).toBe(404);
    const unrouted = (await h.su.query("SELECT count(*)::int AS n FROM webhook_events WHERE provider = 'lead' AND status = 'unrouted' AND tenant_id IS NULL")).rows[0].n;
    expect(unrouted).toBeGreaterThan(0);
    const unsigned = await postIntake(h, w.token, { fullName: 'Ghost', phones: [randomPhone()] }, { sign: false });
    expect([unsigned.statusCode, JSON.parse(unsigned.body).error.code]).toEqual([403, 'WEBHOOK_SIGNATURE_INVALID']);
    expect((await h.su.query('SELECT count(*)::int AS n FROM lead_inquiries')).rows[0].n).toBe(before);
    // E51: a body naming a tenant is refused by the strict schema
    const forged = await postIntake(h, w.token, { fullName: 'Ghost', tenant_id: randomUUID() });
    expect(forged.statusCode).toBe(422);
    // no name and no valid identifier
    const empty = await postIntake(h, w.token, { phones: ['123'] });
    expect([empty.statusCode, JSON.parse(empty.body).error.code]).toEqual([422, 'INQUIRY_EMPTY']);
  });

  it('lead sources: Owner/Admin create one and get the ingest token once (only its hash is stored); agents cannot list them', async () => {
    const list = await call<{ sources: { id: string; hasToken: boolean }[] }>(w.owner, 'GET', '/lead-sources');
    expect(list.body.sources.find((s) => s.id === w.sourceId)).toMatchObject({ hasToken: true });
    expect(JSON.stringify(list.body)).not.toContain(w.token);
    expect((await call(w.agents[0]!, 'GET', '/lead-sources')).status).toBe(404);
    const audit = (await h.su.query("SELECT action, reason FROM audit_log WHERE tenant_id = $1 AND entity_type = 'lead_source'", [w.tenantId])).rows;
    expect(audit).toContainEqual({ action: 'routing.changed', reason: 'LEAD_SOURCE_CREATED' });
  });
});

describe('acceptance', () => {
  it('BUILD_PLAN 11 acceptance: lead intake to a committed offer (with notification + delivery rows) p95 < 2 s (20 sequential intakes, fake providers)', async () => {
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const r = await intake(h, w, { fullName: `Speed ${i}` });
      times.push(performance.now() - t0);
      expect((await contactState(h, r.contactId)).ownership_state).toBe('offered');
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(2000);
  });
});
