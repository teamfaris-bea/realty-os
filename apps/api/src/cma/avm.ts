// In-house home values (module 71's AVM part, lane V2-B; R-CMA-10, R-CMA-7, R-CMA-6, R-AVM-1..3, R-INT-1, R-INT-6).
//
//   InHouseAvm          the AvmProvider production registers (providers/index.ts). A process-wide singleton with no
//                       per-tenant state: every estimate opens its own system transaction of the call context's
//                       tenant, read-only from its first statement (E635), outside every contact lock (avm.refresh calls
//                       it between TX1 and TX2), and values only that tenant's own MLS rows through V1-C's value run
//                       (cma/pipeline.ts). No network call, no third-party AVM (D9). Configuration or sync failures throw
//                       (no row: the month is not ended); data reasons answer "unavailable" (E99, E626).
//   automatedGate       R-CMA-7 for automated outputs: V1-C's client readiness under automated_notes, plus platform:avm
//                       and SUBJECT_LISTED for a note, client_cma for a seller range (M1), and every pack text rendering
//                       unchanged under literal() (E628). Returns the lines every client rendering carries.
//   availability        the per-tenant no-op (E620): both packs cleared and a live connection recording agent_cma and
//                       automated_notes with its valuation section reviewed; else one sentence for the triggers page.
// A stored ref never widens a gate: every later check (queue, draft approval, sweep) re-reads packs and connections.
// Logs carry codes and counts only, never an address or a value.
import { type IanaZone, type Instant, localDateOf } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { literal } from '../nurture/decide.js';
import { ProviderError } from '../providers/types.js';
import type { AddressFacts, AvmCallContext, AvmEstimate, AvmProvider, AvmUnavailable } from '../providers/integrations/types.js';
import { systemActor } from '../worker/systemActor.js';
import { LISTING_COLS, type ListingRow, addressKey, mlsEligibility, mlsRowsAtAddress, packReviewed, valuationStatement } from './deps.js';
import { type Blocker, CMA_PLATFORM_PACK, LIVE_STATUSES, type ReadinessInput, clientReadiness } from './gates.js';
import { LICENCE_SENTENCE, valueForSubjectInTx } from './pipeline.js';
import { platformCleared } from './repos.js';
import { readinessInputOf } from './service.js';

/** The source name clients see (owner question 2): never a vendor's (VERIFY WITH COUNSEL C2, MLS M4). */
export const IN_HOUSE_PROVIDER = 'recent MLS sales';
export const IN_HOUSE_METHOD = (methodVersion: string) => `comparable sales (${methodVersion})`;
export const AVM_PLATFORM_PACK = 'platform:avm';

/** `inhouse:{methodVersion}:{sorted connection ids joined by '+'}:{inputs sha256}` (R-CMA-10, owner question 11). */
export const IN_HOUSE_REF = /^inhouse:cma\/\d+(\+[a-z-]+)?:[0-9a-f-]{36}(\+[0-9a-f-]{36})*:[0-9a-f]{64}$/;

export interface InHouseRef {
  methodVersion: string;
  connectionIds: string[];
  inputsSha256: string;
}

export function inHouseRef(methodVersion: string, connectionIds: readonly string[], inputsSha256: string): string {
  return `inhouse:${methodVersion}:${[...new Set(connectionIds)].sort().join('+')}:${inputsSha256}`;
}

/** The parts of a valid in-house ref, else null (fail closed: a malformed ref is never displayable). */
export function parseInHouseRef(ref: string | null | undefined): InHouseRef | null {
  if (typeof ref !== 'string' || !IN_HOUSE_REF.test(ref)) return null;
  const [, methodVersion, conns, sha] = ref.split(':') as [string, string, string, string];
  return { methodVersion, connectionIds: conns.split('+'), inputsSha256: sha };
}

/** Data reasons: the source answered and has no value for the address (an unavailable row, E99, E626). */
const DATA_CODES: ReadonlySet<string> = new Set(['CMA_SUBJECT_INCOMPLETE', 'CMA_SUBJECT_TYPE_NOT_SUPPORTED', 'NO_SALES', 'INSUFFICIENT_COMPS', 'SUBJECT_INCOMPLETE', 'SUBJECT_TYPE_NOT_SUPPORTED']);

// ---- the gate -------------------------------------------------------------------------------------------------

export type AutomatedOutput = 'note' | 'seller_range';
export type GateCode = Blocker['code'] | 'AVM_NOT_CLEARED' | 'SUBJECT_LISTED' | 'CLIENT_CMA_NOT_RECORDED' | 'STATEMENT_NOT_RENDERABLE';
export interface GateBlocker {
  code: GateCode;
  sentence: string;
  count?: number;
  listingIds?: string[];
}
export type GateResult = { ok: true; lines: string[] } | { ok: false; code: GateCode; sentence: string; blockers: GateBlocker[] };

export const GATE_SENTENCES = {
  AVM_NOT_CLEARED: 'Home-value notes wait for counsel review of platform:avm, which is not recorded.',
  SUBJECT_LISTED: 'The home is listed now (in the MLS or as a team listing), so no automated value is sent until the listing ends.',
  CLIENT_CMA_NOT_RECORDED: 'Your MLS licence pack does not record that sold data may be used in CMAs for clients, which seller value ranges also need until your MLS answers which use governs them.',
  STATEMENT_NOT_RENDERABLE: 'A statement, attribution or disclaimer in your MLS licence pack holds a line break or another character that cannot be shown as written, so nothing is sent until it is corrected.',
} as const;

/** Live team listings in the key's 5-digit ZIP whose address keys to `key` (comps.ts:180-183's keying). */
async function liveTeamListingsAt(tx: Tx, key: string): Promise<ListingRow[]> {
  const zip = key.split('|')[4] ?? null;
  const rows = zip === null || !/^\d{5}$/.test(zip) ? [] : (await sql<ListingRow>`SELECT ${LISTING_COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'team'
      AND l.postal_code LIKE ${`${zip}%`} AND l.status = ANY (${[...LIVE_STATUSES]}::text[]) ORDER BY l.id LIMIT 5000`.execute(tx)).rows;
  return rows.filter((r) => addressKey({ line1: r.address_line1, line2: r.address_line2, city: r.city, region: r.region, postalCode: r.postal_code }) === key);
}

/**
 * Whether an automated output may carry a value now (R-CMA-7, R-CMA-10). `input` is the run's readiness input
 * (readinessInputOf, or rebuilt from a stored ref); `use`, the value and the dismissals are set here. A note passes no
 * comps (none is shown, M3); a seller range passes the comps it shows.
 */
export async function automatedGate(tx: Tx, now: Instant, input: ReadinessInput, o: { output: AutomatedOutput }): Promise<GateResult> {
  const note = o.output === 'note';
  const r = await clientReadiness(tx, { ...input, now, use: 'automated_notes', hasValue: true, nearMatchDismissed: [], compSales: note ? [] : input.compSales });
  const blockers: GateBlocker[] = [...r.share.blockers];
  const add = (code: keyof typeof GATE_SENTENCES, extra: Partial<GateBlocker> = {}) => {
    if (!blockers.some((b) => b.code === code)) blockers.push({ code, sentence: GATE_SENTENCES[code], ...extra });
  };
  const { e } = input.conns;
  const read = [...new Set([...input.conns.used.map((u) => u.conn.id), ...input.readConnectionIds])].sort();
  if (note) {
    if (!(await platformCleared(tx, AVM_PLATFORM_PACK))) add('AVM_NOT_CLEARED');
    // E625: the past client's house live in the MLS (any flag, any brokerage) or a live team listing (C3)
    if (input.addressKey !== null) {
      const mls = (await mlsRowsAtAddress(tx, input.addressKey)).filter((x) => LIVE_STATUSES.includes(x.status));
      const team = await liveTeamListingsAt(tx, input.addressKey);
      if (mls.length + team.length > 0) add('SUBJECT_LISTED', { listingIds: [...new Set([...mls, ...team].map((x) => x.id))].sort() });
    }
  } else {
    // M1: until the MLS answers which use governs seller ranges, both are required (owner question 14)
    if (read.some((id) => e.connections.find((c) => c.id === id)?.pack.valuation.clientCma !== true)) add('CLIENT_CMA_NOT_RECORDED');
  }
  // every pack text a client rendering carries, exactly as written (E628: never altered)
  const lines: string[] = [];
  for (const id of read) {
    const conn = e.connections.find((c) => c.id === id);
    if (!conn) continue;
    const statement = valuationStatement(conn.pack, input.state)?.text ?? null;
    for (const t of [statement, conn.pack.attributionText, conn.pack.disclaimerText]) {
      if (t === null) continue;
      if (literal(t) !== t) add('STATEMENT_NOT_RENDERABLE');
      else if (!lines.includes(t)) lines.push(t);
    }
  }
  if (blockers.length > 0) return { ok: false, code: blockers[0]!.code, sentence: blockers[0]!.sentence, blockers };
  return { ok: true, lines };
}

// ---- availability -------------------------------------------------------------------------------------------

export const AVAILABILITY_SENTENCES = {
  packs: (which: string) => `Home-value notes from recent MLS sales wait for counsel review of ${which}. Nothing is requested or sent until it is recorded.`,
  noConnection: 'Home values need a live MLS connection.',
  licence: LICENCE_SENTENCE,
} as const;

/** E620, in the caller's transaction: whether the tenant can be valued at all, else the one sentence. */
export async function availabilityInTx(tx: Tx, now: Instant): Promise<{ available: true } | { available: false; sentence: string }> {
  const cma = await platformCleared(tx, CMA_PLATFORM_PACK);
  const avm = await platformCleared(tx, AVM_PLATFORM_PACK);
  if (!cma || !avm) return { available: false, sentence: AVAILABILITY_SENTENCES.packs(!cma && !avm ? 'both platform:cma and platform:avm' : !cma ? 'platform:cma' : 'platform:avm') };
  const e = await mlsEligibility(tx, now);
  const live = e.connections.filter((c) => c.status === 'connected' || c.status === 'degraded');
  if (live.length === 0) return { available: false, sentence: AVAILABILITY_SENTENCES.noConnection };
  // a stale feed stays available: E369 is a visible skip, not silence
  if (!live.some((c) => c.pack.valuation.agentCma && c.pack.valuation.automatedNotes && c.pack.valuation.reviewedByCounselAt !== null)) return { available: false, sentence: AVAILABILITY_SENTENCES.licence };
  return { available: true };
}

// ---- the provider -------------------------------------------------------------------------------------------

/** "Mon D, YYYY" in the tenant's zone, of a `YYYY-MM-DD` date. */
export function longDate(isoDate: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${isoDate}T12:00:00Z`));
}

/** The read-only system transaction every in-house read runs in (E635; E1: SET TRANSACTION READ ONLY after the GUCs). */
export function readOnlySystemTx<T>(tenantId: string, db: AvmCallContext['db'], fn: (tx: Tx, now: Instant) => Promise<T>): Promise<T> {
  return withTenantTx(
    systemActor(tenantId, 'provider'),
    async (tx, now) => {
      await sql`SET TRANSACTION READ ONLY`.execute(tx);
      return fn(tx, now);
    },
    db ? { db } : {},
  );
}

export class InHouseAvm implements AvmProvider {
  readonly configured = true;
  /** test hook run first inside every estimate's own transaction (E635: prove it is read-only and holds no lock); null in production */
  onRead: ((tx: Tx) => Promise<void>) | null = null;

  async availability(c: { tenantId: string; db?: AvmCallContext['db'] }): Promise<{ available: true } | { available: false; sentence: string }> {
    return readOnlySystemTx(c.tenantId, c.db, (tx, now) => availabilityInTx(tx, now));
  }

  async estimate(_a: AddressFacts, ctx?: AvmCallContext): Promise<AvmUnavailable | AvmEstimate> {
    if (!ctx) throw new ProviderError('not_configured', 'AVM_CONTEXT_REQUIRED');
    return readOnlySystemTx(ctx.tenantId, ctx.db, async (tx, now) => {
      if (this.onRead) await this.onRead(tx);
      const v = await valueForSubjectInTx(tx, now, { kind: 'contact_address', contactAddressId: ctx.contactAddressId }, { contactId: ctx.contactId, use: 'automated_notes' });
      if (!v.ok) {
        if (DATA_CODES.has(v.code)) return { available: false, provider: IN_HOUSE_PROVIDER };
        throw new ProviderError('unavailable', v.code);
      }
      if (v.mlsDataAsOf === null) throw new ProviderError('unavailable', 'MLS_NOT_SYNCED');
      if (!v.result.available) {
        if (DATA_CODES.has(v.result.reason)) return { available: false, provider: IN_HOUSE_PROVIDER };
        throw new ProviderError('unavailable', v.result.reason);
      }
      const gate = await automatedGate(tx, now, readinessInputOf(v.resolved, v.result, v.conns, now, { nearMatchDismissed: [], hasValue: true, use: 'automated_notes', selfListingIds: v.resolved.selfListingIds }), { output: 'note' });
      return {
        available: true,
        valueCents: v.result.valueCents,
        lowCents: v.result.lowCents,
        highCents: v.result.highCents,
        asOf: localDateOf(v.mlsDataAsOf.getTime() as Instant, v.zone as IanaZone) as string,
        method: IN_HOUSE_METHOD(v.result.methodVersion),
        comparables: [],
        provider: IN_HOUSE_PROVIDER,
        displayAllowed: gate.ok,
        ref: inHouseRef(v.result.methodVersion, v.result.connectionIds, v.inputsSha256),
      };
    });
  }
}

/** Whether a display pack is reviewed with attribution and disclaimer (the sweep's per-connection check). */
export const displayPackReviewed = (p: Parameters<typeof packReviewed>[0]) => packReviewed(p) && p.attributionText !== null && p.disclaimerText !== null;
