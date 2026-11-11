// Test helpers for module 28 (imported by *.test.ts only). Everything the product does goes through the real
// server as app_user; the reconcile pass runs as the worker's system actor, exactly as the job would. The
// superuser only reads state back and moves clocks. Fakes only: no real provider, lead or send.
import { randomUUID } from 'node:crypto';
import type { Instant } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { call, ownedContact } from '../comms/testing.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { systemActor } from '../worker/systemActor.js';
import { type ReconcileResult, reconcileSellerUpdates } from './reconcile.js';

export { call };

export interface SellerListing {
  listingId: string;
  address: string;
  sellers: { id: string; phone: string; email: string }[];
}

let n = 0;
/** A team listing created by `agent` (its listing agent) with `sellers` seller contacts (the first 'seller', the rest 'co_seller'). */
export async function sellerListing(agent: TestClient, o: { sellers?: number; postalCode?: string; priceCents?: number } = {}): Promise<SellerListing> {
  n += 1;
  const address = `${100 + n} Birch Ln`;
  const r = await call<{ listing: { id: string } }>(agent, 'POST', '/listings', { status: 'active', addressLine1: address, city: 'Oakland', region: 'CA', postalCode: o.postalCode ?? '94610', listPriceCents: o.priceCents ?? 85_000_000, beds: 3, bathsX10: 20, sqft: 1450, propertyType: 'single_family' });
  if (r.status !== 201) throw new Error(`listing: ${r.status} ${JSON.stringify(r.body)}`);
  const listingId = r.body.listing.id;
  const sellers = [];
  for (let i = 0; i < (o.sellers ?? 1); i++) {
    const c = await ownedContact(agent, { consent: false, firstName: i === 0 ? 'Sam' : 'Alex' });
    const l = await call(agent, 'POST', `/listings/${listingId}/contacts`, { contactId: c.id, role: i === 0 ? 'seller' : 'co_seller' });
    if (l.status !== 200) throw new Error(`seller: ${l.status} ${JSON.stringify(l.body)}`);
    sellers.push(c);
  }
  return { listingId, address, sellers };
}

/** One reconcile pass for a tenant as the worker's system actor (the job's own transaction). */
export async function reconcile(h: ApiHarness, tenantId: string, now: number = Date.now()): Promise<ReconcileResult> {
  const d = depsFromPlatform(h.app.platform);
  return withTenantTx(systemActor(tenantId, 'worker'), (tx) => reconcileSellerUpdates(tx, { envelope: d.envelope, ids: d.ids, tenantId }, now as Instant), { db: h.database });
}

export async function draftsOf(h: ApiHarness, listingId: string): Promise<{ id: string; status: string; owner_user_id: string; contact_id: string | null; dedupe_key: string; trigger_ref: Record<string, unknown>; payload: Record<string, unknown>; edited_payload: Record<string, unknown> | null; autonomy: string; action_category: string }[]> {
  return (
    await h.su.query(
      "SELECT id, status, owner_user_id, contact_id, dedupe_key, trigger_ref, payload, edited_payload, autonomy, action_category FROM assistant_actions WHERE kind = 'seller_update_draft' AND trigger_ref->>'listing_id' = $1 ORDER BY created_at, id",
      [listingId],
    )
  ).rows;
}

/** A showing `hoursAgo` hours ago, logged by `agent`, with optional feedback. */
export async function showing(agent: TestClient, listingId: string, o: { hoursAgo?: number; status?: string; feedback?: string; rating?: number; buyerContactId?: string } = {}): Promise<{ showingId: string; feedbackId: string | null }> {
  const at = new Date(Date.now() - (o.hoursAgo ?? 24) * 3_600_000).toISOString();
  const s = await call<{ showing: { id: string } }>(agent, 'POST', `/listings/${listingId}/showings`, { startsAt: at, status: o.status ?? 'completed', buyerAgentName: 'Pat Buyer-Agent', ...(o.buyerContactId ? { buyerContactId: o.buyerContactId } : {}) });
  if (s.status !== 201) throw new Error(`showing: ${s.status} ${JSON.stringify(s.body)}`);
  let feedbackId: string | null = null;
  if (o.feedback !== undefined || o.rating !== undefined) {
    const f = await call<{ showing: { feedback: { id: string }[] } }>(agent, 'POST', `/showings/${s.body.showing.id}/feedback`, { comments: o.feedback ?? null, rating: o.rating ?? null, receivedAt: at });
    if (f.status !== 200 && f.status !== 201) throw new Error(`feedback: ${f.status} ${JSON.stringify(f.body)}`);
    feedbackId = (await agent.h.su.query<{ id: string }>('SELECT id FROM showing_feedback WHERE showing_id = $1 ORDER BY received_at DESC LIMIT 1', [s.body.showing.id])).rows[0]!.id;
  }
  return { showingId: s.body.showing.id, feedbackId };
}

export const RECOMMENDATION = 'My take: hold the price two more weeks, then revisit.';
export const cmd = () => randomUUID();

export type UpdateT = {
  id: string;
  listingId: string;
  status: string;
  canSend: boolean;
  stale: boolean;
  assembledThrough: string;
  period: { key: string; label: string; text: string };
  sections: { kind: string; state: string; statement: string; lines: { text: string; feedback: { feedbackId: string; namesPerson: boolean; excluded: boolean } | null }[]; sources: { text: string; evidence: { sourceType: string; sourceId: string; label: string }[] }[] }[];
  recipients: { contactId: string; sendable: boolean; visible: boolean; channel: string | null; whyNot: string | null; personDoNotContact: boolean; reasons: { source: string }[] }[];
  recommendation: string;
  excludedFeedbackIds: string[];
  preview: { channel: string; subject: string; body: string };
};
export type SendT = { result: string; status: string; messageId: string | null; recipients: { contactId: string; messageId: string | null; result: string }[] };
