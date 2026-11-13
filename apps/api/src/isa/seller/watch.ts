// The seller watch (R-ISA-17, R-ISA-18, R-ISA-26; E535, E537, E538; docs/AI_ISA.md §6.3 "The seller watch"). Run per
// assignment once per tenant-local day, in its own transaction, in ISA-2's lock order (lockForTurn, then the watch
// row). It skips, keeping the snapshot, on an ineligible or stale feed; a changed display-rules or rule version resets
// the snapshot silently. Events come only from a row's own newer mls_modified_at and stored status, never from
// absence: new_competitor, competitor_pending, competitor_back_on_market, competitor_price_change; competitor_sold and
// competitor_off_market are recorded, never rendered. At most 3 events per run; the rest carry over. Delivery goes
// through STUB(ISA-2) enqueueListingEventInTx (not built yet: ISA-2 has no listing_event turn). Each run re-checks
// link 10 (H5): a listing at the home ends or pauses care.
import { type Instant, type SystemActor, localDateOf, ianaZone, type IanaZone } from '@realty/core/foundation';
import { canonicalJson } from '@realty/core/compliance';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { type ListingRow, listingRows, mlsEligibility } from './cmaSeam.js';
import { competitorsInTx } from './competition.js';
import { assignmentSubjectLinkInTx } from './gates.js';
import { type IsaDeps, assignmentById, enqueueListingEventInTx, lockForTurn, systemEndInTx, systemPauseInTx } from './isa2Seam.js';
import type { CompetitorEvent } from './isa1Seam.js';
import { watchOf } from './subject.js';
import { COMPETITION_RULE_VERSION, versionsOf } from './versions.js';

export const MAX_EVENTS_PER_RUN = 3;
/** Recorded, never rendered (§6.3): sold data reaches a seller only through the sold path, after the packs clear. */
export const RECORDED_ONLY: ReadonlySet<CompetitorEvent> = new Set(['competitor_sold', 'competitor_off_market']);

interface SnapEntry {
  status: string;
  mod: string | null;
  price: string | null;
}
type Snapshot = Record<string, SnapEntry>;

export interface WatchRun {
  code: 'RAN' | 'NOT_SELLER' | 'NO_SUBJECT' | 'ALREADY_RAN' | 'SKIPPED_STALE' | 'VERSION_RESET' | 'WATCH_LIMIT_REACHED' | 'ENDED' | 'PAUSED';
  events: { event: CompetitorEvent; listingId: string; delivered: boolean }[];
}

const entryOf = (r: ListingRow): SnapEntry => ({ status: r.status, mod: r.mls_modified_at?.toISOString() ?? null, price: r.list_price_cents === null ? null : String(r.list_price_cents) });
const newer = (r: ListingRow, e: SnapEntry) => r.mls_modified_at !== null && (e.mod === null || r.mls_modified_at.getTime() > Date.parse(e.mod));

/** The event a row's own newer record means (null: nothing to say). */
export function eventOf(r: ListingRow, prev: SnapEntry | undefined): CompetitorEvent | null {
  if (prev === undefined) return r.status === 'active' || r.status === 'coming_soon' ? 'new_competitor' : null;
  if (!newer(r, prev)) return null;
  if (r.status === 'sold') return 'competitor_sold';
  if (r.status !== 'active' && r.status !== 'coming_soon' && r.status !== 'pending') return 'competitor_off_market';
  if (r.status === 'pending' && prev.status !== 'pending') return 'competitor_pending';
  if ((r.status === 'active' || r.status === 'coming_soon') && prev.status === 'pending') return 'competitor_back_on_market';
  if (r.status === prev.status && (r.list_price_cents === null ? null : String(r.list_price_cents)) !== prev.price) return 'competitor_price_change';
  return null;
}

export async function runSellerWatchInTx(tx: Tx, deps: IsaDeps, actor: SystemActor, assignmentId: string, now: Instant): Promise<WatchRun> {
  const a0 = await assignmentById(tx, assignmentId);
  if (a0 === null || a0.endedAt !== null || (a0.side !== 'seller' && a0.side !== 'both')) return { code: 'NOT_SELLER', events: [] };
  await lockForTurn(tx, a0.contactId, a0.id);
  const a = (await assignmentById(tx, assignmentId, 'update'))!;
  const w = await watchOf(tx, a.id, true);
  if (w === null) return { code: 'NO_SUBJECT', events: [] };
  const zone = (ianaZone((await sql<{ z: string }>`SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]?.z ?? 'UTC') ?? 'UTC') as IanaZone;
  if (w.last_run_at !== null && localDateOf(w.last_run_at.getTime() as Instant, zone) === localDateOf(now, zone)) return { code: 'ALREADY_RAN', events: [] };
  const ran = (extra = sql``) => sql`UPDATE ai_isa_seller_watch SET last_run_at = ${new Date(now)} ${extra} WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id}`.execute(tx);
  // link 10 first: a listing at the home ends or pauses care (E538)
  const link = await assignmentSubjectLinkInTx(tx, a);
  if (link.effect === 'end') {
    await ran();
    await systemEndInTx(tx, deps, actor, a, link.reason as never, now);
    return { code: 'ENDED', events: [] };
  }
  if (link.effect === 'pause') {
    await ran();
    await systemPauseInTx(tx, deps, actor, a, 'possible_listing', now);
    return { code: 'PAUSED', events: [] };
  }
  if (w.subject_confirmed_at === null || w.subject_record_listing_id === null || w.subject_facts === null) {
    await ran();
    return { code: 'NO_SUBJECT', events: [] };
  }
  const e = await mlsEligibility(tx, now);
  const live = e.connections.filter((c) => e.clientIds.includes(c.id));
  if (live.length === 0 || live.some((c) => e.staleIds.includes(c.id))) {
    await ran();
    return { code: 'SKIPPED_STALE', events: [] };
  }
  const versions = { connections: versionsOf(live), rule: COMPETITION_RULE_VERSION };
  const rec = (await listingRows(tx, [w.subject_record_listing_id]))[0];
  if (!rec) {
    await ran();
    return { code: 'NO_SUBJECT', events: [] };
  }
  const c = await competitorsInTx(tx, e, { recordRow: rec, facts: w.subject_facts });
  if (!c.ok) {
    await ran();
    return { code: 'WATCH_LIMIT_REACHED', events: [] };
  }
  const prevVersions = w.snapshot_versions as typeof versions | Record<string, never>;
  const snapshot = (w.last_snapshot ?? {}) as Snapshot;
  if (canonicalJson(prevVersions) !== canonicalJson(versions)) {
    // a new display-rules or rule version: reset silently (no event from the reset)
    const fresh: Snapshot = Object.fromEntries(c.rows.map((r) => [r.id, entryOf(r)]));
    await ran(sql`, last_snapshot = ${JSON.stringify(fresh)}::jsonb, snapshot_versions = ${JSON.stringify(versions)}::jsonb`);
    return { code: 'VERSION_RESET', events: [] };
  }
  // rows that left the competing set: read their own records (an event only from a newer record, never from absence)
  const gone = Object.keys(snapshot).filter((id) => !c.rows.some((r) => r.id === id));
  const goneRows = await listingRows(tx, gone);
  const candidates: { r: ListingRow; ev: CompetitorEvent }[] = [];
  for (const r of [...c.rows, ...goneRows]) {
    const ev = eventOf(r, snapshot[r.id]);
    if (ev !== null) candidates.push({ r, ev });
  }
  candidates.sort((x, y) => (x.r.id < y.r.id ? -1 : 1));
  const next: Snapshot = { ...snapshot };
  const events: WatchRun['events'] = [];
  let delivered = 0;
  for (const { r, ev } of candidates) {
    if (RECORDED_ONLY.has(ev)) {
      delete next[r.id];
      events.push({ event: ev, listingId: r.id, delivered: false });
      continue;
    }
    if (delivered >= MAX_EVENTS_PER_RUN) continue; // carried over: its snapshot entry is unchanged
    delivered += 1;
    const out = await enqueueListingEventInTx(tx, { assignmentId: a.id, event: ev, listingId: r.id, dedupeKey: `w:${ev}:${r.id}` });
    next[r.id] = entryOf(r);
    events.push({ event: ev, listingId: r.id, delivered: out.delivered });
  }
  // rows still competing without an event keep their entry; new rows without an event (a pending first seen) join
  for (const r of c.rows) if (next[r.id] === undefined && !candidates.some((x) => x.r.id === r.id)) next[r.id] = entryOf(r);
  await ran(sql`, last_snapshot = ${JSON.stringify(next)}::jsonb`);
  return { code: 'RAN', events };
}

/** The hourly sweep: one job per live seller assignment and tenant-local day (its own transaction each). */
export async function sellerWatchSweepInTx(tx: Tx, enqueue: (assignmentId: string, day: string) => Promise<void>, now: Instant): Promise<number> {
  const zone = (ianaZone((await sql<{ z: string }>`SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]?.z ?? 'UTC') ?? 'UTC') as IanaZone;
  const day = localDateOf(now, zone) as string;
  const r = await sql<{ id: string }>`SELECT a.id FROM ai_isa_assignments a WHERE a.tenant_id = app.tenant_id() AND a.ended_at IS NULL AND a.side IN ('seller','both') ORDER BY a.id LIMIT 1000`.execute(tx);
  for (const x of r.rows) await enqueue(x.id, day);
  return r.rows.length;
}
