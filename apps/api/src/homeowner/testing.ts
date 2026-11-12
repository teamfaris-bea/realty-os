// Test helpers of module 78 (never imported by runtime code). Everything is synthetic: fictional streets in a
// Beaufort ZIP, "Doe" owners, PINs "TEST-…". The deterministic FakePublicRecords answers; no county is ever called.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { ownedContact } from '../comms/testing.js';
import { call } from '../leads/testing.js';
import { closedDeal, beforeThisMonth } from '../nurture/testing.js';
import type { FakePublicRecords } from '../predict/provider.js';
import { memoryAlerts } from '../worker/observability.js';
import { systemActor } from '../worker/systemActor.js';
import { type HomeownerDeps, runHomeownerRefresh, type WithTx } from './refresh.js';

export type Reason = 'seller_intent' | 'seller_inquiry' | 'homeowner_tag' | 'past_buyer';
export interface Addr {
  line1: string;
  line2?: string | null;
  city: string;
  region: string;
  postalCode: string;
}

let street = 0;
export const nextBeaufortAddress = (o: Partial<Addr> = {}): Addr => ({ line1: `${100 + ++street} Sample Lane`, city: 'Exampleton', region: 'SC', postalCode: '29902', ...o });

/** A county payload naming `owners`, with a mailing address and a transfer, as the connector would parse it. */
export function countyRecord(a: Addr, owners: string[], o: { extra?: Record<string, unknown>; homeowner?: Record<string, unknown> } = {}): Record<string, unknown> {
  return {
    address: { line1: a.line1, line2: a.line2 ?? null, city: a.city, region: 'SC', postalCode: a.postalCode },
    ownerNames: owners,
    source: 'Beaufort County GIS parcel layer',
    providerRef: `TEST-${String(street).padStart(4, '0')}`,
    homeowner: { owner_mailing_address: 'PO BOX 1, EXAMPLETON SC 29902', last_transfer_date: '2015-06-01', last_transfer_price_cents: 25_000_000, ...(o.homeowner ?? {}) },
    ...(o.extra ?? {}),
  };
}

export const tenantTx = (h: ApiHarness, tenantId: string): WithTx => (fn) => withTenantTx(systemActor(tenantId, 'worker'), fn, { db: h.database });

export async function refresh(h: ApiHarness, tenantId: string, deps: HomeownerDeps, o: { nightOnly?: boolean } = {}) {
  const alerts = memoryAlerts();
  const report = await runHomeownerRefresh(tenantTx(h, tenantId), deps, { tenantId, alerts, nightOnly: o.nightOnly ?? false });
  return { report, alerts };
}

/** Recognises the contact by `reason` (fixtures through the superuser, as other module tests do for deals). */
export async function recognise(h: ApiHarness, w: { tenantId: string; sourceId: string }, contactId: string, ownerUserId: string, reason: Reason, homeLine1?: string): Promise<void> {
  if (reason === 'seller_intent') await h.su.query(`UPDATE contacts SET intent = 'seller' WHERE id = $1`, [contactId]);
  if (reason === 'seller_inquiry') {
    await h.su.query(`INSERT INTO lead_inquiries (tenant_id, id, contact_id, lead_source_id, received_at, inquiry_type, fingerprint, outcome)
                      VALUES ($1, $2, $3, $4, now(), 'value', $5, 'attached')`, [w.tenantId, randomUUID(), contactId, w.sourceId, `fp-${randomUUID()}`]);
  }
  if (reason === 'homeowner_tag') {
    const tag = await h.su.query<{ id: string }>(`SELECT id FROM tags WHERE tenant_id = $1 AND name_key = 'homeowner'`, [w.tenantId]);
    let tagId = tag.rows[0]?.id;
    if (!tagId) {
      tagId = randomUUID();
      await h.su.query(`INSERT INTO tags (tenant_id, id, name, created_by_kind) VALUES ($1, $2, 'Homeowner', 'import')`, [w.tenantId, tagId]);
    }
    await h.su.query(`INSERT INTO contact_tags (tenant_id, contact_id, tag_id, added_by_kind) VALUES ($1, $2, $3, 'migrated')`, [w.tenantId, contactId, tagId]);
  }
  if (reason === 'past_buyer') await closedDeal(h, w.tenantId, contactId, ownerUserId, beforeThisMonth(), homeLine1 ? {} : {});
}

export async function addAddress(agent: TestClient, contactId: string, a: Addr, kind: 'home' | 'property' | 'mailing' | 'interest' = 'home'): Promise<string> {
  const r = await call<{ address: { id: string } }>(agent, 'POST', `/contacts/${contactId}/addresses`, { kind, line1: a.line1, ...(a.line2 ? { line2: a.line2 } : {}), city: a.city, region: a.region, postalCode: a.postalCode });
  if (r.status !== 201) throw new Error(`address: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.address.id;
}

/** A recognised contact of `agent` with one Beaufort home whose county record names them ("<first> Doe"). */
export async function homeowner(h: ApiHarness, w: { tenantId: string; sourceId: string }, agent: TestClient, records: FakePublicRecords | null, o: { reason?: Reason; owners?: (first: string) => string[]; address?: Partial<Addr>; record?: Parameters<typeof countyRecord>[2] } = {}) {
  const first = `Sam${randomUUID().slice(0, 4)}`;
  const c = await ownedContact(agent, { firstName: first, consent: false });
  const address = nextBeaufortAddress(o.address);
  const addressId = await addAddress(agent, c.id, address);
  await recognise(h, w, c.id, agent.userId!, o.reason ?? 'seller_intent');
  records?.put(address, countyRecord(address, o.owners ? o.owners(first) : [`${first.toUpperCase()} DOE`], o.record));
  return { id: c.id, first, address, addressId };
}

export async function profileOf(h: ApiHarness, addressId: string) {
  const p = await h.su.query(`SELECT * FROM homeowner_profiles WHERE contact_address_id = $1`, [addressId]);
  const row = p.rows[0] ?? null;
  const facts = row ? (await h.su.query(`SELECT * FROM homeowner_profile_facts WHERE profile_id = $1 ORDER BY field`, [row.id])).rows : [];
  return { profile: row, facts };
}

/** Rows a pass could have written anywhere else (it writes none): sends, jobs, cards, tasks, notifications, enrollments. */
export async function sideEffects(h: ApiHarness, tenantId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ['messages', 'calls', 'jobs', 'priority_feed_items', 'tasks', 'notifications', 'playbook_enrollments', 'audit_log', 'contact_addresses', 'contact_tags', 'deals']) {
    out[t] = Number((await h.su.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [tenantId])).rows[0].n);
  }
  out.contacts = Number((await h.su.query(`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1`, [tenantId])).rows[0].n);
  out.contactsChanged = Number((await h.su.query(`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1 AND updated_at > now() - interval '0 seconds'`, [tenantId])).rows[0].n);
  return out;
}
