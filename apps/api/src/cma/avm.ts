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
import { type AvmEstimate as CoreEstimate, SKIP_REASON_TEXT, homeValueText } from '@realty/core/nurture';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { literal } from '../nurture/decide.js';
import { ProviderError } from '../providers/types.js';
import type { AddressFacts, AvmCallContext, AvmEstimate, AvmProvider, AvmUnavailable } from '../providers/integrations/types.js';
import { systemActor } from '../worker/systemActor.js';
import { LISTING_COLS, type ListingRow, type MlsEligibility, addressKey, mlsEligibility, mlsRowsAtAddress, packReviewed, uspsCode, valuationEligible, valuationStatement } from './deps.js';
import { type Blocker, CMA_PLATFORM_PACK, LIVE_STATUSES, type ReadinessInput, clientReadiness, liveNotLivingArea } from './gates.js';
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

// ---- the note after it was estimated -----------------------------------------------------------------------

/** "MLS data as of {Mon D, YYYY}." of the estimate's own data date (never a later sync's, R-CMA-10). */
export const asOfLine = (asOf: string) => `MLS data as of ${longDate(asOf)}.`;

export const REF_SENTENCE = 'This estimate has no valid in-house reference, so it is not shown to clients.';

interface StoredValuation {
  provider: string;
  provider_ref: string | null;
  as_of: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
}

/**
 * The in-house note's gate after the estimate (R-CMA-7, R-NURT-4), without the engine: from the stored row's ref (its
 * connections), its address's state and key, and the caller's MLS eligibility `e`, in the caller's transaction (the
 * one that queues, or the draft approval's). Null only for a row that is not in-house (no ref and another provider's
 * name: FakeAvmP2 paths unchanged). An in-house-named row without a valid ref, a malformed ref, or a foreign or gone
 * connection fails (E634, E637). On success the lines are the gate's plus the estimate's own "MLS data as of" line.
 */
export async function inHouseNoteGate(tx: Tx, valuationId: string, e: MlsEligibility, now: Instant): Promise<GateResult | null> {
  const v = (
    await sql<StoredValuation>`SELECT v.provider, v.provider_ref, to_char(v.as_of, 'YYYY-MM-DD') AS as_of, a.line1, a.line2, a.city, a.region, a.postal_code
      FROM home_valuations v LEFT JOIN contact_addresses a ON a.tenant_id = v.tenant_id AND a.id = v.contact_address_id
     WHERE v.tenant_id = app.tenant_id() AND v.id = ${valuationId}`.execute(tx)
  ).rows[0];
  if (!v) return { ok: false, code: 'NO_VALUE', sentence: REF_SENTENCE, blockers: [] };
  if (v.provider_ref === null && v.provider !== IN_HOUSE_PROVIDER) return null;
  const ref = parseInHouseRef(v.provider_ref);
  if (ref === null || v.as_of === null) return { ok: false, code: 'NO_VALUE', sentence: REF_SENTENCE, blockers: [{ code: 'NO_VALUE', sentence: REF_SENTENCE }] };
  const key = v.line1 === null ? null : addressKey({ line1: v.line1, line2: v.line2, city: v.city ?? '', region: v.region ?? '', postalCode: v.postal_code ?? '' });
  const gate = await automatedGate(
    tx,
    now,
    {
      conns: { e, used: [] },
      now,
      state: v.region === null ? null : uspsCode(v.region),
      addressKey: key,
      addressLine: v.line1,
      subjectMlsListingId: null,
      compSales: [],
      readConnectionIds: ref.connectionIds,
      nearMatchDismissed: [],
      hasValue: true,
      // R-MLS-7 (batch 13): the ref keeps no size sources; the MLS rows at the subject's key are judged now
      notLivingArea: await liveNotLivingArea(tx, { compSales: [], subjectMlsListingId: null, addressKey: key }),
    },
    { output: 'note' },
  );
  return gate.ok ? { ok: true, lines: [...gate.lines, asOfLine(v.as_of)] } : gate;
}

/** Whether a display pack is reviewed with attribution and disclaimer (the sweep's per-connection check). */
export const displayPackReviewed = (p: Parameters<typeof packReviewed>[0]) => packReviewed(p) && p.attributionText !== null && p.disclaimerText !== null;

// ---- after the queue: the sweep -----------------------------------------------------------------------------

/** Notes canceled per sweep pass at most (bounded work in the shared 5-minute transaction). */
export const HOME_VALUE_SWEEP_LIMIT = 500;
export const HOME_VALUE_NOT_DISPLAYABLE = 'HOME_VALUE_NOT_DISPLAYABLE';

/**
 * The sweep's one candidate read (E623): queued or scheduled outbound messages of the tenant, their scheduled trigger
 * runs and their in-house valuations by primary key, at most `limit`. A builder of its own so the volume test can
 * EXPLAIN exactly this statement (b13 audit V2B-6, values.volume.test.ts).
 *
 * The run's valuation id is computed in a MATERIALIZED step first, so the join to home_valuations is a plain
 * `uuid = uuid` on its primary key. Written inline (`v.id = CASE WHEN … ~ … THEN (…)::uuid END`) the join clause holds
 * the non-leakproof regex match and uuid cast, which FORCE RLS keeps from being an index condition on home_valuations:
 * PostgreSQL then seq-scanned home_valuations once per run, and 10,000 queued notes hit the statement timeout.
 */
export function homeValueSweepCandidates(limit: number) {
  return sql<{ message_id: string; contact_id: string; action_id: string | null; provider_ref: string | null; region: string | null }>`
    WITH c AS MATERIALIZED (
      SELECT m.tenant_id, m.id AS message_id, m.contact_id, m.assistant_action_id AS action_id,
             CASE WHEN r.trigger_ref->'ref'->>'valuationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (r.trigger_ref->'ref'->>'valuationId')::uuid END AS valuation_id
        FROM messages m
        JOIN playbook_step_runs r ON r.tenant_id = m.tenant_id AND r.contact_id = m.contact_id AND r.status = 'scheduled' AND r.enrollment_id IS NULL AND r.message_id = m.id
       WHERE m.tenant_id = app.tenant_id() AND m.direction = 'outbound' AND m.status IN ('queued','scheduled')
         AND r.trigger_ref->>'trigger' = 'home_value'
    )
    SELECT c.message_id, c.contact_id, c.action_id, v.provider_ref, a.region
      FROM c
      JOIN home_valuations v ON v.tenant_id = c.tenant_id AND v.id = c.valuation_id
      LEFT JOIN contact_addresses a ON a.tenant_id = v.tenant_id AND a.id = v.contact_address_id
     WHERE v.provider_ref LIKE 'inhouse:%' OR v.provider = ${IN_HOUSE_PROVIDER}
     ORDER BY c.contact_id, c.message_id LIMIT ${limit}`;
}

/**
 * E623 (R-CMA-7): cancels queued in-house home-value notes once something fails for every note at once: platform:cma
 * or platform:avm, or a connection the note's ref names (V1-A's valuationEligible for automated_notes, fresh feed and
 * reviewed display pack included). Address checks (listed, withheld, near matches) are not read here: they run where
 * the note is built, queued and approved. Per failing note (under the message row's lock, b13 review B13-MRG-6): the message canceled only while
 * still queued (dispatched: untouched), its scheduled runs skipped ESTIMATE_NOT_DISPLAYABLE, its autonomous action
 * blocked. Idempotent. Returns the canceled message ids.
 */
export async function cancelIneligibleHomeValueNotesInTx(tx: Tx, now: Instant, o: { limit?: number } = {}): Promise<string[]> {
  const r = await homeValueSweepCandidates(o.limit ?? HOME_VALUE_SWEEP_LIMIT).execute(tx);
  if (r.rows.length === 0) return [];
  const packs = (await platformCleared(tx, CMA_PLATFORM_PACK)) && (await platformCleared(tx, AVM_PLATFORM_PACK));
  const e = await mlsEligibility(tx, now);
  const verdicts = new Map<string, boolean>();
  const holds = (ref: InHouseRef | null, region: string | null): boolean => {
    if (!packs || ref === null) return false;
    const state = region === null ? null : uspsCode(region);
    const k = `${ref.connectionIds.join('+')}|${state ?? ''}`;
    if (!verdicts.has(k)) verdicts.set(k, ref.connectionIds.every((id) => valuationEligible(e, id, 'automated_notes', state, now).ok && displayPackReviewed(e.pack(id)!)));
    return verdicts.get(k)!;
  };
  const failing = new Map<string, { contactId: string; actionId: string | null }>();
  for (const x of r.rows) if (!failing.has(x.message_id) && !holds(parseInHouseRef(x.provider_ref), x.region)) failing.set(x.message_id, { contactId: x.contact_id, actionId: x.action_id });
  const canceled: string[] = [];
  for (const [messageId, f] of failing) {
    // b13 review B13-MRG-6: no contact lock (as cma/sweep.ts): this pass runs in complianceSweepInTx's transaction
    // after the alerts pass's sorted contact locks; the message row (dispatch's FOR UPDATE) and the conditional UPDATEs
    // decide. A dispatched note is never touched.
    const u = await sql<{ id: string }>`
      UPDATE messages SET status = 'canceled', status_reason = ${HOME_VALUE_NOT_DISPLAYABLE}
       WHERE tenant_id = app.tenant_id() AND id = ${messageId} AND status IN ('queued','scheduled') RETURNING id`.execute(tx);
    if (u.rows.length === 0) continue; // dispatched meanwhile: the gate had the last word
    canceled.push(messageId);
    // the runs are settled here, as what they are (never NOT_QUEUED with a raw code, repos.ts:271-277)
    await sql`
      UPDATE playbook_step_runs SET status = 'skipped_ineligible', updated_at = now(),
             trigger_ref = trigger_ref || jsonb_build_object('skip', jsonb_build_object('reason', 'ESTIMATE_NOT_DISPLAYABLE', 'text', ${SKIP_NOT_DISPLAYABLE}::text))
       WHERE tenant_id = app.tenant_id() AND contact_id = ${f.contactId} AND status = 'scheduled' AND enrollment_id IS NULL AND message_id = ${messageId}`.execute(tx);
    if (f.actionId !== null) await sql`UPDATE assistant_actions SET status = 'blocked' WHERE tenant_id = app.tenant_id() AND id = ${f.actionId} AND kind = 'autonomous_message'`.execute(tx);
  }
  return canceled;
}

/** core nurture's skip text for ESTIMATE_NOT_DISPLAYABLE (SKIP_REASON_TEXT; what skipRun stores). */
const SKIP_NOT_DISPLAYABLE = SKIP_REASON_TEXT.ESTIMATE_NOT_DISPLAYABLE;

// ---- draft approval ---------------------------------------------------------------------------------------

export const LINES_REQUIRED_SENTENCE = 'Keep the estimate sentence, the MLS statement, attribution, disclaimer and data date as written.';

export type HomeValueDraftBlock = { reason: 'HOME_VALUE_NOT_DISPLAYABLE'; code: string; sentence: string } | { reason: 'HOME_VALUE_LINES_REQUIRED'; sentence: string };

/**
 * E621, E624 (R-CMA-7, R-AVM-1): whether a draft built from in-house home-value runs may go out with `body` (the text
 * that would be sent, the agent's edit included). Reads the action's runs as dealDateStaleness does; per in-house
 * home_value run, inHouseNoteGate in the caller's transaction, then every required line (the R-AVM-1 sentence
 * recomputed from the stored row, the MLS statement, attribution, disclaimer and data date) verbatim in `body`.
 * Null: nothing blocks (no in-house run, or every check holds).
 */
export async function homeValueDraftBlock(tx: Tx, actionId: string, now: Instant, body: string): Promise<HomeValueDraftBlock | null> {
  const lead = (await sql<{ lead: string | null }>`SELECT CASE WHEN trigger_ref->>'kind' = 'trigger_run' THEN trigger_ref->>'stepRunId' END AS lead FROM assistant_actions WHERE tenant_id = app.tenant_id() AND id = ${actionId}`.execute(tx)).rows[0]?.lead ?? null;
  if (lead === null || !/^[0-9a-f-]{36}$/i.test(lead)) return null;
  const runs = await sql<{ valuation_id: string | null }>`
    SELECT DISTINCT r.trigger_ref->'ref'->>'valuationId' AS valuation_id
      FROM playbook_step_runs l
      JOIN playbook_step_runs r ON r.tenant_id = l.tenant_id AND r.enrollment_id IS NULL AND r.contact_id = l.contact_id AND (r.id = l.id OR r.assistant_action_id = ${actionId})
     WHERE l.tenant_id = app.tenant_id() AND l.id = ${lead}::uuid AND l.enrollment_id IS NULL AND r.trigger_ref->>'trigger' = 'home_value'`.execute(tx);
  if (runs.rows.length === 0) return null;
  const e = await mlsEligibility(tx, now);
  for (const x of runs.rows) {
    const id = x.valuation_id !== null && /^[0-9a-f-]{36}$/i.test(x.valuation_id) ? x.valuation_id : null;
    if (id === null) return { reason: 'HOME_VALUE_NOT_DISPLAYABLE', code: 'NO_VALUE', sentence: REF_SENTENCE };
    const gate = await inHouseNoteGate(tx, id, e, now);
    if (gate === null) continue;
    if (!gate.ok) return { reason: 'HOME_VALUE_NOT_DISPLAYABLE', code: gate.code, sentence: gate.sentence };
    const est = await storedEstimate(tx, id);
    const sentence = est === null ? null : homeValueText(est);
    if (sentence === null) return { reason: 'HOME_VALUE_NOT_DISPLAYABLE', code: 'NO_VALUE', sentence: REF_SENTENCE };
    if (![sentence, ...gate.lines].every((l) => body.includes(l))) return { reason: 'HOME_VALUE_LINES_REQUIRED', sentence: LINES_REQUIRED_SENTENCE };
  }
  return null;
}

async function storedEstimate(tx: Tx, id: string): Promise<CoreEstimate | null> {
  const v = (await sql<{ status: 'ok' | 'unavailable'; value_cents: string | null; low_cents: string | null; high_cents: string | null; as_of: string | null; display_allowed: boolean; provider: string }>`
    SELECT status, value_cents, low_cents, high_cents, to_char(as_of, 'YYYY-MM-DD') AS as_of, display_allowed, provider FROM home_valuations WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx)).rows[0];
  if (!v) return null;
  const n = (x: string | null) => (x === null ? null : Number(x));
  return { status: v.status, valueCents: n(v.value_cents), lowCents: n(v.low_cents), highCents: n(v.high_cents), asOf: v.as_of, displayAllowed: v.display_allowed, provider: v.provider };
}
