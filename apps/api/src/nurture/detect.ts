// Detection (PHASE2_3_PLAN §5.4 #26; R-NURT-1, R-NURT-2, R-NURT-3, R-NURT-7; E81, E84, E101).
//
// Facts only, never signals (core detectFirings): a price decrease keyed per listing_price_history row, a
// return to market, and a closed deal's yearly home anniversary. Each firing is ONE playbook_step_runs row
// with no enrollment and a unique trigger_key (a re-run, a second worker or a re-sync inserts nothing new),
// so the contact's one live enrollment is untouched. Opt-outs are not looked at here: nothing is dropped for
// compliance reasons (D1); the send-time gate and the DB guards decide when the message goes.
//
// Sources:
//   - MLS sync (module 24, one flagged hook in mls/sync.ts): every changed MLS row enqueues one system job
//     (nurture.listing_changed), so contact locks are never held across the sync's page. MLS rows reach clients only while mls/eligibility.ts says so (clientView: live,
//     reviewed pack, fresh feed, display allowed, not a mirror of a team listing, E81/E85/E86).
//   - Team price and status changes (workspace/listings.ts updateListing, one flagged line): a job
//     nurture.listing_changed carries the listing_price_history row id (or the status change), run as the system.
//   - The daily anniversary scan (anniversary:{deal}:{yyyy}:{contact}; Feb 29 ⇒ Feb 28, E101).
// Digest (R-NURT-3): after inserting, the contact's open firings of that playbook are re-digested with the
// approved window (core digest) and every member's scheduled_for becomes its batch's send time, so the
// reconcile wakes each batch once.
import { anniversariesDue, detectFirings, digest, type Fact, type Firing, type ListingStatus, type TriggerCandidate } from '@realty/core/nurture';
import type { EvidenceRef } from '@realty/core/assistant';
import type { ContactId, Instant, TenantId } from '@realty/core/foundation';
import { type Tx, enqueueJob, lockContact, lockContacts } from '@realty/db';
import { sql } from 'kysely';
import { type ListingRow, LISTING_COLS, clientView, mlsEligibility } from '../mls/eligibility.js';
import { firingOfRow } from './decide.js';
import * as R from './repos.js';
import { NURTURE_JOBS, type NurtureDeps } from './types.js';

/**
 * Inserts the firings of one fact for the contacts it concerns, then re-digests each contact's batch. `o.evidence`
 * replaces core's evidence of every firing (avm.refresh: the home_valuations row's R-AVM-1 sentence as the snippet).
 */
export async function recordFactInTx(tx: Tx, deps: Pick<NurtureDeps, 'ids'>, fact: Fact, rels: readonly { contactId: string; ownerUserId: string | null; relation: TriggerCandidate['relation'] }[], o: { evidence?: EvidenceRef[] } = {}): Promise<number> {
  if (rels.length === 0) return 0;
  const playbooks = await R.approvedTriggerPlaybooks(tx);
  if (playbooks.length === 0) return 0;
  const candidates: TriggerCandidate[] = rels.flatMap((c) => playbooks.map((p) => ({ contactId: c.contactId, ownerUserId: c.ownerUserId, relation: c.relation, playbook: p.ref })));
  const firings = detectFirings(fact, candidates).map((f) => (o.evidence ? { ...f, evidence: o.evidence } : f));
  let inserted = 0;
  const touched = new Map<string, { contactId: string; playbookId: string }>();
  // contact locks in id order (callers that record several facts in one transaction lock all their contacts first)
  for (const f of [...firings].sort((a, b) => a.contactId.localeCompare(b.contactId) || a.triggerKey.localeCompare(b.triggerKey))) {
    await lockContact(tx, f.contactId as ContactId);
    const c = await R.contactState(tx, f.contactId);
    if (!c || !c.live) continue;
    if (await R.insertFiring(tx, deps.ids.next<'PlaybookStepRunId'>(), f)) {
      inserted += 1;
      touched.set(`${f.contactId}:${f.playbookId}`, { contactId: f.contactId, playbookId: f.playbookId });
    }
  }
  for (const t of touched.values()) {
    const p = playbooks.find((x) => x.ref.playbookId === t.playbookId);
    if (p) await redigestInTx(tx, t.contactId, t.playbookId, p.content.digestWindowMinutes);
  }
  return inserted;
}

/** R-NURT-3: the contact's open firings of a playbook in batches of the approved window; members share a send time. */
export async function redigestInTx(tx: Tx, contactId: string, playbookId: string, windowMinutes: number): Promise<void> {
  const open = await R.openFirings(tx, contactId, playbookId);
  const firings: Firing[] = [];
  const idOf = new Map<string, string>();
  for (const r of open) {
    const f = firingOfRow(r);
    if (f === null) continue;
    firings.push(f);
    idOf.set(f.triggerKey, r.id);
  }
  // core digest drops an earlier item of the same listing from the message (E83); the run is still in the
  // batch (same send time) so it settles with the message instead of firing on its own later
  for (const b of digestKeepAll(firings, windowMinutes)) await R.setScheduledFor(tx, b.ids.map((k) => idOf.get(k)!).filter(Boolean), b.sendAt);
}

/** Batches by core digest, keeping every firing (also the ones a later firing of the same home replaced). */
export function digestKeepAll(firings: readonly Firing[], windowMinutes: number): { sendAt: Instant; ids: string[] }[] {
  const batches = digest(firings, windowMinutes);
  const out = batches.map((b) => ({ sendAt: b.sendAt, ids: b.firings.map((f) => f.triggerKey) }));
  const placed = new Set(out.flatMap((b) => b.ids));
  for (const f of firings) {
    if (placed.has(f.triggerKey)) continue;
    // replaced inside a window: it belongs to the batch whose window covers its instant
    const home = batches.find((b) => b.contactId === f.contactId && b.playbookId === f.playbookId && f.scheduledFor < b.sendAt && b.firings.some((x) => x.scheduledFor <= f.scheduledFor || x.triggerKey === f.triggerKey))
      ?? batches.find((b) => b.contactId === f.contactId && b.playbookId === f.playbookId && f.scheduledFor < b.sendAt);
    const i = home === undefined ? -1 : batches.indexOf(home);
    if (i >= 0) out[i]!.ids.push(f.triggerKey);
    else out.push({ sendAt: f.scheduledFor, ids: [f.triggerKey] });
  }
  return out;
}

// ---- listings ------------------------------------------------------------------------------------------

/** What a listing row was before a change (taken by the caller before it writes). */
export interface ListingBefore {
  status: ListingStatus;
  priceCents: number | null;
}

async function listingRow(tx: Tx, listingId: string): Promise<ListingRow | null> {
  const r = await sql<ListingRow>`SELECT ${LISTING_COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.id = ${listingId}`.execute(tx);
  return r.rows[0] ?? null;
}

/**
 * The facts of one listing change (price decrease per history row, return to market) and their firings.
 * `historyId`: the listing_price_history row of the price change (null: the newest row, when the price changed).
 */
export async function recordListingChangeInTx(tx: Tx, deps: Pick<NurtureDeps, 'ids'>, i: { listingId: string; before: ListingBefore | null; priceChanged: boolean; historyId?: string | null; statusKey?: string | null; now: Instant }): Promise<number> {
  if (i.before === null) return 0; // a new listing is a new match (R-MLS-6, the saved-search path), never a trigger
  const row = await listingRow(tx, i.listingId);
  if (!row) return 0;
  const e = await mlsEligibility(tx, i.now);
  const view = clientView(e, row);
  const displayAllowed = row.source === 'team' ? true : view !== null;
  const feedFresh = row.source === 'team' ? true : row.mls_connection_id !== null && !e.staleIds.includes(row.mls_connection_id);
  const address = row.address_line1;
  const followers = await R.listingFollowers(tx, row.id);
  const rels = followers.map((f) => ({ contactId: f.contactId, ownerUserId: f.ownerUserId, relation: { kind: 'listing' as const, listingId: row.id, via: f.via } }));
  // every contact lock this job takes, once, in id order (the order lockContacts uses everywhere)
  await lockContacts(tx, followers.map((f) => f.contactId as ContactId));
  let n = 0;
  if (i.priceChanged) {
    const step = await R.priceStep(tx, row.id, i.historyId ?? null);
    if (step && step.oldCents !== null) {
      n += await recordFactInTx(tx, deps, { kind: 'price_change', listingId: row.id, historyId: step.historyId, source: row.source, oldPriceCents: step.oldCents, newPriceCents: step.newCents, at: step.at, address, mlsNumber: row.mls_number, displayAllowed, feedFresh }, rels);
    }
  }
  if (i.statusKey === undefined ? row.status !== i.before.status : i.statusKey !== null && row.status !== i.before.status) {
    const key = i.statusKey ?? `${row.id}:status:${row.mls_modified_at ? row.mls_modified_at.getTime() : i.now}`;
    n += await recordFactInTx(tx, deps, { kind: 'status_change', listingId: row.id, historyId: key, source: row.source, from: i.before.status, to: row.status, at: i.now, address, mlsNumber: row.mls_number, priceCents: row.list_price_cents === null ? null : Number(row.list_price_cents), displayAllowed, feedFresh }, rels);
  }
  return n;
}

/** MLS hook (module 24, flagged): the stored row before the upsert, for recordListingChangeInTx after it. */
export async function mlsListingBefore(tx: Tx, mlsNumber: string, connectionId: string): Promise<(ListingBefore & { id: string }) | null> {
  const s = await R.listingSnapshotByMls(tx, mlsNumber, connectionId);
  return s ? { id: s.id, status: s.status, priceCents: s.priceCents } : null;
}

/**
 * MLS hook (module 24, flagged): after a changed row was upserted in the sync's write transaction, enqueue one
 * nurture.listing_changed system job for it. Detection does not run inside the sync transaction: it takes contact
 * locks, and holding those across a whole page (in an order no other path uses) could deadlock with ingestion,
 * merges and dispatch, and roll the page back.
 */
export async function mlsListingChangedInTx(tx: Tx, _deps: Pick<NurtureDeps, 'ids'>, listingId: string, before: ListingBefore | null, now: Instant): Promise<number> {
  if (before === null) return 0;
  const after = await R.listingSnapshotById(tx, listingId);
  if (!after) return 0;
  const priceChanged = after.priceCents !== before.priceCents;
  const statusChanged = after.status !== before.status;
  if (!priceChanged && !statusChanged) return 0;
  let historyId: string | null = null;
  if (priceChanged) historyId = (await R.priceStep(tx, listingId, null))?.historyId ?? null;
  const statusKey = statusChanged ? `${listingId}:status:${after.modifiedAt ?? now}` : null;
  await enqueueJob(tx, {
    queue: 'default',
    kind: NURTURE_JOBS.listingChanged,
    payload: { listingId, historyId, fromStatus: before.status, priceChanged: priceChanged && historyId !== null, statusKey },
    dedupeKey: `${NURTURE_JOBS.listingChanged}:${listingId}:${historyId ?? 'nohistory'}:${statusKey ?? 'nostatus'}`.slice(0, 200),
  });
  return 1;
}

/**
 * Team listing hook (workspace/listings.ts updateListing, flagged): in the person's transaction, after the
 * UPDATE (whose trigger wrote the price-history row), enqueue one system job with the row id and the prior
 * status. The job (nurture.listing_changed) records the facts as the system; its dedupe key is the change.
 */
export async function enqueueTeamListingChange(tx: Tx, i: { listingId: string; before: ListingBefore; priceChanged: boolean; statusChanged: boolean }): Promise<void> {
  if (!i.priceChanged && !i.statusChanged) return;
  let historyId: string | null = null;
  if (i.priceChanged) {
    const h = await sql<{ id: string }>`SELECT id FROM listing_price_history WHERE tenant_id = app.tenant_id() AND listing_id = ${i.listingId} ORDER BY changed_at DESC, id DESC LIMIT 1`.execute(tx);
    historyId = h.rows[0]?.id ?? null;
  }
  // the status change is keyed by the row's own write instant (one return to market = one key)
  const u = await sql<{ at: Date }>`SELECT updated_at AS at FROM listings WHERE tenant_id = app.tenant_id() AND id = ${i.listingId}`.execute(tx);
  const statusKey = i.statusChanged && u.rows[0] ? `${i.listingId}:status:${u.rows[0].at.getTime()}` : null;
  const changeKey = `${i.listingId}:${historyId ?? 'nohistory'}:${statusKey ?? 'nostatus'}`;
  await enqueueJob(tx, {
    queue: 'default',
    kind: NURTURE_JOBS.listingChanged,
    payload: { listingId: i.listingId, historyId, fromStatus: i.before.status, priceChanged: i.priceChanged && historyId !== null, statusKey },
    dedupeKey: `${NURTURE_JOBS.listingChanged}:${changeKey}`.slice(0, 200),
  });
}

// ---- anniversaries -------------------------------------------------------------------------------------

const PAGE = 200;

/** Today's local date (`YYYY-MM-DD`) in the tenant zone at `now`. */
export async function localToday(tx: Tx, zoneName: string, now: Instant): Promise<string> {
  const r = await sql<{ d: string }>`SELECT to_char((${new Date(now).toISOString()}::timestamptz AT TIME ZONE ${zoneName})::date, 'YYYY-MM-DD') AS d`.execute(tx);
  return r.rows[0]!.d;
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * nurture.anniversary_scan (daily per tenant; hourly runs are no-ops after the first): closed deals whose
 * anniversary is today in the tenant zone fire once per contact and year (E101: Feb 29 ⇒ Feb 28 in common
 * years). The firing key makes every later scan the same year a no-op.
 */
export async function anniversaryScanInTx(tx: Tx, deps: Pick<NurtureDeps, 'ids'>, now: Instant): Promise<number> {
  const zoneName = await R.tenantZone(tx);
  const today = await localToday(tx, zoneName, now);
  const year = Number(today.slice(0, 4));
  const md = today.slice(5);
  const monthDays = md === '02-28' && !isLeap(year) ? ['02-28', '02-29'] : [md];
  const facts: ReturnType<typeof anniversariesDue> = [];
  let after: string | null = null;
  for (;;) {
    const deals = await R.closedDealsOn(tx, monthDays, zoneName, after, PAGE);
    if (deals.length === 0) break;
    after = deals[deals.length - 1]!.dealId;
    facts.push(...anniversariesDue(deals.map((d) => ({ dealId: d.dealId, status: 'closed' as const, closedOn: d.closedOn, contactIds: d.contactIds, address: d.address })), today, now));
    if (deals.length < PAGE) break;
  }
  // every contact lock of the scan, once, in id order, before any firing is written (no lock cycle with other paths)
  await lockContacts(tx, facts.map((f) => f.contactId as ContactId));
  let n = 0;
  for (const f of facts) {
    const c = await R.contactState(tx, f.contactId);
    if (!c || !c.live) continue;
    n += await recordFactInTx(tx, deps, f, [{ contactId: c.id, ownerUserId: c.ownerUserId, relation: { kind: 'contact' } }]);
  }
  return n;
}

export type { TenantId };
