// Drift verifiers (periodic, one job per tenant per night, maintenance queue).
//
// ownership.drift_check (R-OWN-4): re-folds the ledger of every contact with events in the last 25 h
// plus a 1 % sample and compares fold(ledger) with the stored projection (core `diffProjection`).
// A mismatch raises a P1 alert and writes `ownership.drift_detected` to audit_log (system actor, in
// this job's transaction). Nothing is auto-corrected: the projection is left exactly as found.
//
// consent.drift_check (R-CONSENT-6): re-projects a sample of consent_state keys (rows computed in the
// last 25 h plus a 1 % sample) from consent_events with core `projectConsent`, at the instant the row
// was computed, and alarms (P1) on any difference. Not auto-corrected either.
import { projectConsent } from '@realty/core/compliance';
import { HOUR_MS, instant } from '@realty/core/foundation';
import { diffProjection } from '@realty/core/ownership';
import { loadConsentEvents } from '@realty/db';
import type { z } from 'zod';
import { audit, redactDiff } from '../../audit.js';
import { jobPayload } from '../payload.js';
import { consentCandidates, driftCandidates, projectionsAndLedgers } from '../repos/drift.js';
import type { TxJobHandler } from '../types.js';

export const DriftPayload = jobPayload({});
export type DriftPayload = z.infer<typeof DriftPayload>;

export interface DriftOptions {
  /** look-back window for recently changed rows (default 25 h) */
  recentMs?: number;
  /** random sample of all rows, percent (default 1) */
  samplePct?: number;
  /** cap per tenant per run (default 20 000) */
  max?: number;
  /** cadence (default daily at 08:00 UTC, i.e. the US night) */
  every?: { ms: number; offsetMs?: number };
}

const DAILY = { ms: 24 * HOUR_MS, offsetMs: 8 * HOUR_MS };
const CHUNK = 500;

export function ownershipDriftHandler(o: DriftOptions = {}): TxJobHandler<DriftPayload> {
  return {
    kind: 'ownership.drift_check',
    queue: 'maintenance',
    priority: 500,
    via: 'worker',
    schema: DriftPayload,
    every: o.every ?? DAILY,
    periodicPayload: {},
    async run(ctx) {
      const since = instant(ctx.now - (o.recentMs ?? 25 * HOUR_MS));
      const ids = await driftCandidates(ctx.tx, since, o.samplePct ?? 1, o.max ?? 20_000);
      let drifted = 0;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const rows = await projectionsAndLedgers(ctx.tx, ids.slice(i, i + CHUNK));
        for (const [contactId, { stored, events }] of rows) {
          const diffs = diffProjection(events, stored);
          if (diffs.length === 0) continue;
          drifted++;
          const before = Object.fromEntries(diffs.map((d) => [d.field, d.ledger as never]));
          const after = Object.fromEntries(diffs.map((d) => [d.field, d.stored as never]));
          await audit(ctx.tx, ctx.actor, {
            action: 'ownership.drift_detected',
            entity: { type: 'contact', id: contactId },
            changes: redactDiff(before, after),
            reason: 'PROJECTION_DRIFT',
          });
          ctx.alerts.raise({
            severity: 'P1',
            code: 'OWNERSHIP_DRIFT',
            tenantId: ctx.actor.tenantId,
            details: { contactId, fields: diffs.map((d) => d.field).join(','), jobId: ctx.job.id.toString() },
          });
        }
      }
      ctx.log.info('ownership drift check', { jobId: ctx.job.id.toString(), tenantId: ctx.actor.tenantId, count: ids.length, result: { drifted } });
    },
  };
}

export function consentDriftHandler(o: DriftOptions = {}): TxJobHandler<DriftPayload> {
  return {
    kind: 'consent.drift_check',
    queue: 'maintenance',
    priority: 500,
    via: 'worker',
    schema: DriftPayload,
    every: o.every ?? DAILY,
    periodicPayload: {},
    async run(ctx) {
      const since = instant(ctx.now - (o.recentMs ?? 25 * HOUR_MS));
      const rows = await consentCandidates(ctx.tx, since, o.samplePct ?? 1, o.max ?? 20_000);
      let drifted = 0;
      for (const row of rows) {
        const events = await loadConsentEvents(ctx.tx, row.channel, row.addressHmacHex);
        const projected = [...projectConsent(events, row.computedAt).values()].find((p) => p.purpose === row.purpose) ?? null;
        const fields: string[] = [];
        if (!projected) fields.push('missing_ledger');
        else {
          if (projected.status !== row.status) fields.push('status');
          if (projected.level !== row.level) fields.push('consent_level');
          if (projected.basisEventId !== row.basisEventId) fields.push('basis_event_id');
          if (projected.expiresAt !== row.expiresAt) fields.push('expires_at');
          if (projected.ledgerEventCount !== row.ledgerEventCount) fields.push('ledger_event_count');
        }
        if (fields.length === 0) continue;
        drifted++;
        ctx.alerts.raise({
          severity: 'P1',
          code: 'CONSENT_DRIFT',
          tenantId: ctx.actor.tenantId,
          details: { channel: row.channel, purpose: row.purpose, fields: fields.join(','), jobId: ctx.job.id.toString() },
        });
      }
      ctx.log.info('consent drift check', { jobId: ctx.job.id.toString(), tenantId: ctx.actor.tenantId, count: rows.length, result: { drifted } });
    },
  };
}
