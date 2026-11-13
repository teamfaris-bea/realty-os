// Test fixtures for the AI ISA seller part (ISA-3; imported by *.test.ts only). Synthetic data only: no real MLS,
// brokerage, person or address; fakes only, nothing real is sent. MLS rows reach the database through V1-A's real
// sync (cma/testing.ts). The superuser pool only clears packs (in try/finally, in the test's own database), widens the
// seeded policy's capabilities (the policy editor is the web lane's) and moves stored instants.
import { randomUUID } from 'node:crypto';
import type { Instant } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import type { ApiHarness } from '../../auth/testHarness.js';
import { address, cmaPack, localSales, mlsSale, daysAgo } from '../../cma/testing.js';
import { depsFromPlatform } from '../../comms/runtime.js';
import { mlsConnection } from '../../mls/testing.js';
import { systemActor } from '../../worker/systemActor.js';
import { type IsaLead, type IsaWorld, call, isaLead, isaWorld, optInAgent, startCare } from '../testing.js';
import { type IsaDeps, assignmentById, contextFor, queueIsaMessageInTx } from './isa2Seam.js';
import type { SellerDeps } from './comps.js';

export const SELLER_CAPS = ['converse', 'seller_competition', 'seller_sold_comps'];

export interface SellerWorld extends IsaWorld {
  mls: string;
}

/** The AI ISA world plus an MLS feed whose pack records every valuation use (ai_isa_comps included unless told). */
export async function sellerWorld(h: ApiHarness, o: { valuation?: Record<string, unknown>; pack?: Record<string, unknown> } = {}): Promise<SellerWorld> {
  const w = await isaWorld(h, { optIn: false });
  // the seeded policy widened to the seller capabilities (the guard freezes an approved version; the editor is the web lane's)
  await h.su.query(`SET session_replication_role = replica; UPDATE playbook_versions SET steps = jsonb_set(steps, '{capabilities}', '${JSON.stringify(SELLER_CAPS)}'::jsonb) WHERE id = '${w.versionId}'; SET session_replication_role = origin`);
  await optInAgent(h, w.agents[0]!, w.versionId, SELLER_CAPS);
  const mls = await mlsConnection(h, w.tenantId, w.owner.userId!, { pack: o.pack ?? cmaPack({ valuation: { ai_isa_comps: true, ...o.valuation } }), lastSyncedAt: new Date() });
  return { ...w, mls };
}

/** Runs `fn` with platform:cma and platform:ai_isa_seller_data recorded as reviewed, restoring them after (E534). */
export async function withSellerPacksCleared<T>(h: ApiHarness, fn: () => Promise<T>, keys: readonly string[] = ['platform:cma', 'platform:ai_isa_seller_data']): Promise<T> {
  await h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = ANY ($1::text[]) AND status = 'published'`, [keys]);
  try {
    return await fn();
  } finally {
    await h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = ANY ($1::text[])`, [keys]);
  }
}

/** A statement double for V2-A's printable/statementProminence (the shipped seam refuses every statement). */
export const PRINTABLE_STATEMENTS: SellerDeps = {
  statement: {
    printable: () => true,
    statementProminence: (min: number) => ({ ok: true, code: null, pointSize: Math.max(12, min) }),
  },
};

export interface SellerLead extends IsaLead {
  addressId: string;
  assignmentId: string;
  /** the seller's own MLS record */
  recordId: string;
}

export const HOME_LINE = '100 Sample Ave';
let homes = 0;
/** A distinct home address per lead (so leads of one world never share a subject record). */
export const nextHomeLine = () => `${11 + homes++} Sample Ct`;

/**
 * A seller lead of agent 0 under seller-side care: a property address, the home's own sold MLS record (3 bd, 1,500
 * sq ft, 400 days ago), `comps` comparable local sales, and the watch row (created by the system).
 */
export async function sellerLead(h: ApiHarness, w: SellerWorld, o: { comps?: number; record?: Parameters<typeof mlsSale>[1] | null; side?: 'seller' | 'both'; channels?: ('sms' | 'email')[]; line1?: string } = {}): Promise<SellerLead & { line1: string }> {
  const l = await isaLead(h, w.agents[0]!);
  const line1 = o.line1 ?? nextHomeLine();
  const addressId = await address(h, w.tenantId, l.id, { kind: 'property', line1 });
  const fw = { h, tenantId: w.tenantId, mls: w.mls };
  const recordId = o.record === null ? '' : await mlsSale(fw, { line1, closeDate: daysAgo(400), beds: 3, sqft: 1500, bathsX10: 20, ...o.record });
  if ((o.comps ?? 8) > 0) await localSales(fw, o.comps ?? 8);
  const s = await startCare(w.agents[0]!, l.id, { side: o.side ?? 'seller', ...(o.channels ? { channels: o.channels } : {}) });
  if (s.status !== 200) throw new Error(`start: ${s.status} ${JSON.stringify(s.body)}`);
  const assignmentId = s.body.assignmentId;
  await withTenantTx(systemActor(w.tenantId, 'assistant'), async (tx) => {
    const { ensureWatchInTx } = await import('./subject.js');
    await ensureWatchInTx(tx, { id: assignmentId, contactId: l.id });
  }, { db: h.database });
  return { ...l, addressId, assignmentId, recordId, line1 };
}

/** The panel, as `client` sees it. */
export async function panel(client: Parameters<typeof call>[0], contactId: string) {
  return call<Record<string, unknown> & { subject: { state: string; factsSha256: string | null; recordListingId: string | null; contactAddressId: string | null; confirmed: boolean } }>(client, 'GET', `/contacts/${contactId}/ai-isa/seller`);
}

/** The owner confirms the subject through the route (as themselves). */
export async function confirm(w: SellerWorld, l: SellerLead) {
  const p = await panel(w.agents[0]!, l.id);
  return call(w.agents[0]!, 'POST', `/contacts/${l.id}/ai-isa/confirm-subject`, { contactAddressId: p.body.subject.contactAddressId, recordListingId: p.body.subject.recordListingId, factsSha256: p.body.subject.factsSha256 });
}

/** A system transaction (via 'assistant' unless told) over the assignment. */
export async function asSystem<T>(h: ApiHarness, w: SellerWorld, l: SellerLead, fn: (tx: Parameters<Parameters<typeof withTenantTx>[1]>[0], a: NonNullable<Awaited<ReturnType<typeof assignmentById>>>, actor: ReturnType<typeof systemActor>) => Promise<T>, via: 'assistant' | 'worker' = 'assistant'): Promise<T> {
  const actor = systemActor(w.tenantId, via);
  return withTenantTx(actor, async (tx) => fn(tx, (await assignmentById(tx, l.assignmentId))!, actor), { db: h.database });
}

export const nowInstant = (): Instant => Date.now() as Instant;
export { randomUUID };

/**
 * A second MLS feed of the world (its own attribution and disclaimer; every valuation use recorded, ai_isa_comps
 * included), live now. Returns its connection id (E536 "two connections").
 */
export async function secondFeed(h: ApiHarness, w: SellerWorld, o: { attribution: string; disclaimer: string }): Promise<string> {
  return mlsConnection(h, w.tenantId, w.owner.userId!, { pack: { ...cmaPack({ valuation: { ai_isa_comps: true } }), attribution_text: o.attribution, disclaimer_text: o.disclaimer }, lastSyncedAt: new Date() });
}

/** ISA-2's TX-B queue path with a facts message (the H2 hook builds the body). Returns the message id or null. */
export function queueFactsAs(h: ApiHarness, w: SellerWorld, l: SellerLead, handles: string[], channel: 'sms' | 'email' = 'email'): Promise<string | null> {
  return asSystem(h, w, l, async (tx, a, actor) => {
    const now = nowInstant();
    const ctx = await contextFor(tx, a, now);
    return queueIsaMessageInTx({ tx, deps: depsFromPlatform(h.app.platform) as unknown as IsaDeps, actor, ctx, now, turnId: null, pinnedSeq: a.lastInboundSeq },
      { kind: 'queue_message', messageKind: 'facts', purpose: 'marketing', channel, lines: [], text: null, handles, offerId: null, slotIndex: null, initiated: true }, a.machine);
  });
}

/** Sets the seeded policy's allowed channels (the guard freezes an approved version; the editor is the web lane's). */
export async function policyChannels(h: ApiHarness, w: SellerWorld, channels: ('sms' | 'email')[]): Promise<void> {
  await h.su.query(`SET session_replication_role = replica; UPDATE playbook_versions SET steps = jsonb_set(steps, '{channels}', '${JSON.stringify(channels)}'::jsonb) WHERE id = '${w.versionId}'; SET session_replication_role = origin`);
}
