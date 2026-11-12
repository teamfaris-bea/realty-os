// One side-effect-free value run (module 71's AVM part, lane V2-B; R-CMA-10, R-CMA-2..5, R-CMA-6).
//
//   valueForSubjectInTx   V1-C's compute without storing: the agent gate (R-CMA-6), the connections it admits narrowed
//                         to those whose licence pack records the use (valuation.automated_notes; with `sellerRange` also
//                         client_cma until M1 is answered), the subject (V1-C's resolveSubject), and V1-C's run with no
//                         agent include or exclude. The engine is V1-B's (R-CMA-2..5), called, never re-implemented.
//   inputsSha256Of        the hash of everything the engine read: the engine subject, the candidates sorted by identity,
//                         the tier reads, the valuation date and the method (V1-C's contentOf pattern), so the same
//                         inputs in any order give the same hash (R-CMA-5). ISA-3's compsForSubjectInTx wraps this run
//                         (it lives here, not in cma/service.ts as AI_ISA.md:687 says; reported to ISA-3).
// It never writes and never calls comms: it runs inside InHouseAvm's own read-only transaction (cma/avm.ts) and in the
// seller update's caller transaction (cma/sellerValue.ts). A V1 refusal comes back as { ok: false, code, sentence } with
// V1's code and sentence, unchanged.
import { canonicalJson, sha256Hex } from '@realty/core/compliance';
import { type IanaZone, type Instant, localDateOf } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { AppError } from '../errors.js';
import type { CmaCandidate, CmaSubject, CmaTier } from './deps.js';
import { type CmaConnections, agentGate, mlsDataAsOf } from './gates.js';
import { connectionSizeField } from './repos.js';
import { type StoredResult, run, zoneOf } from './service.js';
import { type ResolvedSubject, type SubjectInput, engineSubject, resolveSubject } from './subject.js';

/** Availability's licence sentence (E620): no connection the agent gate admits records the automated use. */
export const LICENCE_SENTENCE =
  'Your MLS licence pack does not record that automated home-value notes may use MLS sold data, or that part is not reviewed by counsel. An Owner or Admin records it from your MLS agreement.';

export type ValueUse = 'automated_notes';

export type ValueRun =
  | {
      ok: true;
      resolved: ResolvedSubject;
      result: StoredResult;
      /** the connections the run read (the agent gate's, narrowed to the use) */
      conns: CmaConnections;
      zone: IanaZone;
      valuationDate: string;
      /** the oldest last sync of the comps' connections (else of every connection read); null: one never synced */
      mlsDataAsOf: Date | null;
      inputsSha256: string;
    }
  | { ok: false; code: string; sentence: string };

const refusal = (e: unknown): { ok: false; code: string; sentence: string } | null => {
  if (!(e instanceof AppError) || e.code === 'NOT_FOUND') return null;
  const s = (e.details as { sentence?: unknown } | undefined)?.sentence;
  return { ok: false, code: e.code, sentence: typeof s === 'string' ? s : e.code };
};

/** The hash of a run's inputs (see the header). */
export function inputsSha256Of(o: { subject: CmaSubject; candidates: readonly CmaCandidate[]; tierReads: readonly { tier: CmaTier | 'rate_pool'; limitReached: boolean }[]; valuationDate: string; methodVersion: string }): string {
  const candidates = [...o.candidates].sort((a, b) => (a.ref.identity < b.ref.identity ? -1 : a.ref.identity > b.ref.identity ? 1 : 0));
  const plain = JSON.parse(JSON.stringify({ engineSubject: o.subject, candidates, tierReads: o.tierReads, valuationDate: o.valuationDate, methodVersion: o.methodVersion })) as unknown;
  return sha256Hex(canonicalJson(plain));
}

/** The connections of `c` whose pack records the use (M1: a seller range also needs client_cma). */
export function connectionsForUse(c: CmaConnections, o: { sellerRange?: boolean | undefined }): CmaConnections {
  return { e: c.e, used: c.used.filter((u) => u.conn.pack.valuation.automatedNotes && (!o.sellerRange || u.conn.pack.valuation.clientCma)) };
}

/** One value run for `subject` (see the header). Read-only; throws only NOT_FOUND (a subject the caller cannot see). */
export async function valueForSubjectInTx(tx: Tx, now: Instant, subject: SubjectInput, o: { contactId: string | null; use: ValueUse; sellerRange?: boolean; valuationDate?: string }): Promise<ValueRun> {
  let gate: CmaConnections;
  try {
    gate = await agentGate(tx, now);
  } catch (e) {
    const r = refusal(e);
    if (r) return r;
    throw e;
  }
  const conns = connectionsForUse(gate, o);
  if (conns.used.length === 0) return { ok: false, code: 'CMA_VALUATION_NOT_ALLOWED', sentence: LICENCE_SENTENCE };
  const zone = await zoneOf(tx);
  const valuationDate = o.valuationDate ?? (localDateOf(now, zone) as string);
  const connectionIds = conns.used.map((u) => u.conn.id);
  try {
    const sizeField = await connectionSizeField(tx, connectionIds);
    const resolved = await resolveSubject(tx, subject, { contactId: o.contactId, sizeField, connectionIds });
    const { result, candidates, tierReads } = await run(tx, conns, resolved, valuationDate, [], []);
    return {
      ok: true,
      resolved,
      result,
      conns,
      zone,
      valuationDate,
      mlsDataAsOf: mlsDataAsOf(conns, result.comps.map((c) => c.ref.connectionId)),
      inputsSha256: inputsSha256Of({ subject: engineSubject(resolved), candidates, tierReads, valuationDate, methodVersion: result.methodVersion }),
    };
  } catch (e) {
    const r = refusal(e);
    if (r) return r;
    throw e;
  }
}
