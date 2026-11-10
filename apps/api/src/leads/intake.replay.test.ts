// Webhook replay on the lead intake endpoint (security-hardening lane, docs/SECURITY.md §Webhooks).
//
// A lead source signs `t.rawBody` with HMAC-SHA256; the guard accepts t within ±5 minutes. Inside that
// window a captured delivery can be re-sent byte for byte. Lead sources send no provider event id, so
// idempotency rests on intake's own dedup: (source, external id), else the inquiry fingerprint for
// FINGERPRINT_WINDOW_MS. These tests pin that a replay inside the signature window can never create a
// second inquiry, contact or routing — which needs the fingerprint window to outlast the signature window.
import { FINGERPRINT_WINDOW_MS } from '@realty/core/ownership';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { SIGNATURE_FUTURE_SKEW_S, SIGNATURE_TOLERANCE_S, signedHeader } from '../providers/webhooks.js';
import { type LeadsWorld, leadsWorld, randomPhone } from './testing.js';

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
