// F2-ERASE-HELD-LEAD-EMAIL (batch 5 review; R-DATA-4, R-DATA-3, R-LEM-5, R-LEM-6; migration 0041).
//
// A held ("Needs review") lead email is never linked to a contact, so erasure, which deleted by contact id, never
// found it: after a privacy erasure the person's name, phone, email and message were still shown decrypted in Needs
// review, and accepting the email re-created the erased person. Held content also never expired. Now a held email
// keeps the tenant-HMACs of the addresses it names (point_hmacs, as intake keys them); erasing a person purges every
// held email naming one of their addresses (status `erased`: content, parse, keys and sender domain gone, the message
// key kept so a replay stays a duplicate), and the retention sweep expires held content 30 days after receipt.
// Through the real webhook and routes as app_user, fake providers, own createTestDb database.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshReauth } from '../admin/testing.js';
import { type AssistantWorld, assistantWorld, call, randomPhone } from '../assistant/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { suFixture } from '../leads/testing.js';
import { createMaintenance } from '../worker/maintenance.js';
import { memoryAlerts, memoryLogger } from '../worker/observability.js';
import { HandlerRegistry } from '../worker/registry.js';
import { contactsWith, enableInbox, labelledBody, outcomeOf, postLeadEmail } from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;
let tl: TestClient;
let address: string;

beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 1, teamLead: true });
  tl = w.teamLead!;
  address = (await enableInbox(h, w.owner, w.sourceId)).address!;
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const uniq = () => randomUUID().slice(0, 8);
const verified = { from: 'Zillow Leads <leads@zillow.com>', dkim: [{ domain: 'zillow.com', result: 'pass' }] };
const dkimFailed = { from: 'Zillow Leads <leads@zillow.com>', dkim: [{ domain: 'zillow.com', result: 'fail' }] };
type Item = { id: string; status: string; text: string | null; fields: { name: { value: string } | null; phones: { value: string }[]; emails: { value: string }[] } | null };
const reviews = (who: TestClient, status: 'needs_review' | 'decided') => call<{ items: Item[]; pendingCount: number }>(who, 'GET', `/lead-email/reviews?status=${status}`);
const row = async (id: string) =>
  (await h.su.query<{ status: string; content: boolean; parsed: boolean; hmacs: number; sender_domain: string | null }>(`
    SELECT status, content_enc IS NOT NULL AS content, parsed_enc IS NOT NULL AS parsed, cardinality(point_hmacs) AS hmacs, sender_domain
      FROM lead_email_messages WHERE tenant_id = $1 AND id = $2`, [w.tenantId, id])).rows[0]!;
const heldIds = async () => (await h.su.query<{ id: string }>("SELECT id FROM lead_email_messages WHERE tenant_id = $1 AND status = 'needs_review' ORDER BY created_at, id", [w.tenantId])).rows.map((r) => r.id);

describe('F2-ERASE-HELD-LEAD-EMAIL: a held lead email goes with the person it names, and expires', () => {
  it('R-LEM-5: a held email keeps the HMAC keys of the addresses it names (never the addresses in the clear)', async () => {
    const email = `kay.${uniq()}@example.test`;
    const phone = randomPhone();
    expect(outcomeOf(await postLeadEmail(h, { to: address, ...dkimFailed, text: labelledBody({ name: 'Kay Keys', email, phone }) }))).toBe('needs_review');
    const id = (await heldIds()).at(-1)!;
    const keys = (await h.su.query<{ k: string[] }>("SELECT ARRAY(SELECT encode(x, 'hex') FROM unnest(point_hmacs) x ORDER BY 1) AS k FROM lead_email_messages WHERE id = $1", [id])).rows[0]!.k;
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k).toMatch(/^[0-9a-f]{64}$/);
    const raw = (await h.su.query<{ t: string }>('SELECT point_hmacs::text AS t FROM lead_email_messages WHERE id = $1', [id])).rows[0]!.t;
    expect(raw).not.toContain(email);
    expect(raw).not.toContain(phone.slice(1));
  });

  it('R-DATA-4 R-LEM-6: erasing a person purges their held email (not listed or acceptable for anyone, content and parse gone, a replay stays a duplicate); another person\'s held email stays', async () => {
    const email = `ada.${uniq()}@example.test`;
    const heldPhone = randomPhone();
    expect(outcomeOf(await postLeadEmail(h, { to: address, ...verified, text: labelledBody({ name: 'Ada Erasure', email, phone: randomPhone(), message: 'Tour on Saturday?' }) }))).toBe('lead_created');
    const [c] = await contactsWith(h, w.tenantId, email);
    expect(c).toBeDefined();
    // held: a DKIM failure carrying the same person's email plus another number and their street
    const replay = { to: address, ...dkimFailed, messageId: `<${randomUUID()}@mail.test>`, text: labelledBody({ name: 'Ada Erasure', email, phone: heldPhone, message: 'My other number; I live at 12 Probe Lane' }) };
    expect(outcomeOf(await postLeadEmail(h, replay))).toBe('needs_review');
    const held = (await heldIds()).at(-1)!;
    // a stranger's held email (shares nothing with the person)
    expect(outcomeOf(await postLeadEmail(h, { to: address, ...dkimFailed, text: labelledBody({ name: 'Sam Stranger', email: `sam.${uniq()}@example.test`, phone: randomPhone() }) }))).toBe('needs_review');
    const stranger = (await heldIds()).at(-1)!;
    const before = (await reviews(w.owner, 'needs_review')).body.pendingCount;

    await freshReauth(h, w.owner);
    const er = await call(w.owner, 'POST', `/contacts/${c}/erase`, { reason: 'PRIVACY_REQUEST' }); if (process.env.DEBUG_ISA) console.log('DBG', JSON.stringify(er.body));
    expect(er.status).toBe(200);

    expect(await row(held)).toEqual({ status: 'erased', content: false, parsed: false, hmacs: 0, sender_domain: null });
    for (const who of [w.owner, tl]) {
      for (const status of ['needs_review', 'decided'] as const) {
        const list = await reviews(who, status);
        expect(list.status).toBe(200);
        expect(list.body.items.map((i) => i.id), `${status}`).not.toContain(held);
        expect(JSON.stringify(list.body)).not.toContain(email);
        expect(JSON.stringify(list.body)).not.toContain('Ada Erasure');
      }
    }
    expect((await reviews(w.owner, 'needs_review')).body.pendingCount).toBe(before - 1);
    // accepting or discarding it is refused as unknown: the erased person is never re-created from it
    await freshReauth(h, tl);
    expect((await call(tl, 'POST', `/lead-email/reviews/${held}/accept`, {})).code).toBe('NOT_FOUND');
    expect((await call(tl, 'POST', `/lead-email/reviews/${held}/discard`, {})).code).toBe('NOT_FOUND');
    expect(await contactsWith(h, w.tenantId, email)).toEqual([]);
    expect(await contactsWith(h, w.tenantId, heldPhone)).toEqual([]);
    // the provider re-delivering the same message after its webhook id was purged (app.purge_webhook_events) is still a
    // duplicate: the erased row is the replay tombstone, so nothing is held again
    await suFixture(h, [{ text: "DELETE FROM webhook_events WHERE tenant_id = $1 AND provider = 'email' AND provider_event_id LIKE 'lead-email:%'", values: [w.tenantId] }]);
    expect(outcomeOf(await postLeadEmail(h, replay))).toBe('duplicate');
    expect(await heldIds()).not.toContain(held);
    expect(await row(held)).toMatchObject({ status: 'erased', content: false });
    // the stranger's held email is untouched
    expect(await row(stranger)).toMatchObject({ status: 'needs_review', content: true, parsed: true, hmacs: 2 });
    expect((await reviews(w.owner, 'needs_review')).body.items.map((i) => i.id)).toContain(stranger);
  });

  it('R-DATA-3: held content expires 30 days after receipt in the worker\'s retention pass (status expired, not listed, not acceptable); a newer held email stays', async () => {
    expect(outcomeOf(await postLeadEmail(h, { to: address, ...dkimFailed, text: labelledBody({ name: 'Bob Retention', email: `bob.${uniq()}@example.test`, phone: randomPhone() }) }))).toBe('needs_review');
    const oldOne = (await heldIds()).at(-1)!;
    expect(outcomeOf(await postLeadEmail(h, { to: address, ...dkimFailed, text: labelledBody({ name: 'Cid Recent', email: `cid.${uniq()}@example.test`, phone: randomPhone() }) }))).toBe('needs_review');
    const fresh = (await heldIds()).at(-1)!;
    // a clock fixture (received_at is immutable for every writer: the guard is off for this one statement)
    await suFixture(h, [{ text: "UPDATE lead_email_messages SET received_at = now() - interval '31 days' WHERE id = $1", values: [oldOne] }]);
    const report = await createMaintenance({ db: h.database, registry: new HandlerRegistry(), log: memoryLogger(), alerts: memoryAlerts(), periodicEveryMs: Number.MAX_SAFE_INTEGER }).runOnce();
    expect(report.failedSteps).toEqual([]);
    expect(report.retention?.lead_emails_expired).toBeGreaterThanOrEqual(1);
    expect(await row(oldOne)).toEqual({ status: 'expired', content: false, parsed: false, hmacs: 0, sender_domain: null });
    expect(await row(fresh)).toMatchObject({ status: 'needs_review', content: true, parsed: true });
    const ids = (await reviews(w.owner, 'needs_review')).body.items.map((i) => i.id);
    expect(ids).toContain(fresh);
    expect(ids).not.toContain(oldOne);
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/lead-email/reviews/${oldOne}/accept`, {})).code).toBe('NOT_FOUND');
  });
});
