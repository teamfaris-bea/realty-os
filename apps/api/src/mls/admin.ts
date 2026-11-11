// MLS admin and the licence-pack editor (PHASE2_3_PLAN §5.4 #24; R-MLS-2, R-MLS-3, R-MLS-4; N6).
//
//   mlsAdminView       Owner/Admin: each mls_feed connection in words (status, last sync, "MLS data as of …",
//                      whether its data may reach clients now) and its licence pack, value by value.
//   saveLicensePack    Owner/Admin 🔒 (route: re-auth, CSRF): the whole pack, each value with the person's
//                      statement whether counsel reviewed it. The pack counts as counsel-reviewed
//                      (`reviewed_by_counsel_at`, read by core packReviewed) only when EVERY value is marked
//                      reviewed; otherwise nothing is shown to clients (core applyDisplayRules). A pack whose
//                      values and marks are unchanged keeps its review time; any change re-stamps it.
//                      Written under the caller's RLS (the 0018 guard lets Owner/Admin edit licence packs),
//                      audited with keys only (never the texts).
// Every value is VERIFY WITH COUNSEL / MLS; nothing here encodes a particular MLS's rules.
import { DISPLAY_FIELDS, type DisplayField, LISTING_STATUSES, type ListingStatus, feedStale, packReviewed, parseLicensePack, staleNotice } from '@realty/core/listings';
import type { IanaZone, Instant, UserActor } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import { serviceOf, statusSentence } from '../integrations/catalog.js';
import type { ConnectionStatus } from '../providers/integrations/types.js';
import { RESULT_SENTENCE } from './spark/service.js';
import { connectionClientEligible, mlsConnections } from './eligibility.js';

/** The editable values, in display order (snake_case: the stored JSON keys). */
export const PACK_KEYS = ['max_staleness_hours', 'attribution_text', 'disclaimer_text', 'allow_rehost_photos', 'require_listing_brokerage', 'client_fields', 'client_statuses', 'public_fields', 'public_statuses'] as const;
export type PackKey = (typeof PACK_KEYS)[number];

export interface PackValues {
  max_staleness_hours: number | null;
  attribution_text: string | null;
  disclaimer_text: string | null;
  allow_rehost_photos: boolean;
  require_listing_brokerage: boolean;
  client_fields: DisplayField[];
  client_statuses: ListingStatus[];
  public_fields: DisplayField[];
  public_statuses: ListingStatus[];
}

export type PackInput = { [K in PackKey]: { value: PackValues[K]; counselReviewed: boolean } };

export interface PackView {
  values: { key: PackKey; value: PackValues[PackKey]; counselReviewed: boolean }[];
  reviewedByCounselAt: string | null;
  unreviewedCount: number;
  sentence: string;
}

export interface MlsConnectionAdminView {
  id: string;
  displayName: string;
  status: string;
  statusSentence: string;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  mlsDataAsOf: string;
  feedStale: boolean;
  clientDisplay: boolean;
  clientDisplaySentence: string;
  licensePack: PackView;
}

const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

/** The stored JSON → the editor's values (strictest where unreadable, like core parseLicensePack). */
export function packValues(stored: unknown): { values: PackValues; marks: Partial<Record<PackKey, boolean>> } {
  const p = parseLicensePack(stored);
  const marksRaw = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>)['counsel_reviewed_values'] : undefined;
  const marks: Partial<Record<PackKey, boolean>> = {};
  if (marksRaw && typeof marksRaw === 'object' && !Array.isArray(marksRaw)) for (const k of PACK_KEYS) if ((marksRaw as Record<string, unknown>)[k] === true) marks[k] = true;
  return {
    values: {
      max_staleness_hours: p.maxStalenessHours,
      attribution_text: p.attributionText,
      disclaimer_text: p.disclaimerText,
      allow_rehost_photos: p.allowRehostPhotos,
      require_listing_brokerage: p.requireListingBrokerage,
      client_fields: [...p.audiences.client.fields],
      client_statuses: [...p.audiences.client.statuses],
      public_fields: [...p.audiences.public.fields],
      public_statuses: [...p.audiences.public.statuses],
    },
    marks,
  };
}

export function packView(stored: unknown): PackView {
  const { values, marks } = packValues(stored);
  const pack = parseLicensePack(stored);
  const unreviewed = PACK_KEYS.filter((k) => marks[k] !== true).length;
  const sentence = packReviewed(pack)
    ? 'Every value is marked as reviewed by counsel. MLS listings may be shown to clients within these rules.'
    : `Not shown to clients: ${unreviewed} of ${PACK_KEYS.length} values are not marked as reviewed by counsel.`;
  return { values: PACK_KEYS.map((key) => ({ key, value: values[key], counselReviewed: marks[key] === true })), reviewedByCounselAt: pack.reviewedByCounselAt, unreviewedCount: unreviewed, sentence };
}

/** The JSON stored for an input (canonical order; unknown fields and statuses dropped, never widened). */
export function storedPack(input: PackInput, reviewedAt: string | null): Record<string, unknown> {
  const fields = (xs: readonly string[]) => DISPLAY_FIELDS.filter((f) => xs.includes(f));
  const statuses = (xs: readonly string[]) => LISTING_STATUSES.filter((s) => xs.includes(s));
  return {
    reviewed_by_counsel_at: reviewedAt,
    max_staleness_hours: input.max_staleness_hours.value,
    attribution_text: input.attribution_text.value,
    disclaimer_text: input.disclaimer_text.value,
    allow_rehost_photos: input.allow_rehost_photos.value,
    require_listing_brokerage: input.require_listing_brokerage.value,
    audiences: {
      client: { fields: fields(input.client_fields.value), statuses: statuses(input.client_statuses.value) },
      public: { fields: fields(input.public_fields.value), statuses: statuses(input.public_statuses.value) },
    },
    counsel_reviewed_values: Object.fromEntries(PACK_KEYS.map((k) => [k, input[k].counselReviewed === true])),
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type ConnRow = { id: string; display_name: string; status: ConnectionStatus; status_reason: string | null; last_error_code: string | null; disconnected_at: Date | null; last_synced_at: Date | null; next_sync_at: Date | null; license_pack: unknown };

async function mlsRows(tx: Tx, id?: string, lock = false): Promise<ConnRow[]> {
  return (
    await sql<ConnRow>`
      SELECT id, display_name, status, status_reason, last_error_code, disconnected_at, last_synced_at, next_sync_at, license_pack FROM integration_connections
       WHERE tenant_id = app.tenant_id() AND kind = 'mls_feed' AND (${id ?? null}::uuid IS NULL OR id = ${id ?? null}::uuid)
       ORDER BY created_at, id ${lock ? sql`FOR UPDATE` : sql``}`.execute(tx)
  ).rows;
}

export async function mlsAdminView(tx: Tx, now: Instant): Promise<{ connections: MlsConnectionAdminView[] }> {
  const zone = ((await sql<{ z: string }>`SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]?.z ?? 'UTC') as IanaZone;
  const facts = new Map((await mlsConnections(tx)).map((c) => [c.id, c]));
  return {
    connections: (await mlsRows(tx)).map((r) => {
      const f = facts.get(r.id)!;
      const stale = feedStale(f.lastSyncedAt, now, f.pack);
      const eligible = connectionClientEligible(f, now);
      const base = statusSentence(r.status, r.status_reason, serviceOf('mls_feed')!, { disconnectedAt: isoOrNull(r.disconnected_at) });
      const hint = r.last_error_code ? RESULT_SENTENCE[r.last_error_code] : undefined;
      return {
        id: r.id,
        displayName: r.display_name,
        status: r.status,
        statusSentence: hint ? `${base} ${hint}` : base,
        lastSyncedAt: isoOrNull(r.last_synced_at),
        nextSyncAt: isoOrNull(r.next_sync_at),
        mlsDataAsOf: staleNotice(f.lastSyncedAt, zone),
        feedStale: stale,
        clientDisplay: eligible,
        clientDisplaySentence: eligible
          ? 'MLS listings may reach clients (alerts) within the licence pack.'
          : !packReviewed(f.pack)
            ? 'MLS listings are not shown to clients: the licence pack is not counsel-reviewed.'
            : f.pack.attributionText === null || f.pack.disclaimerText === null
              ? 'MLS listings are not shown to clients: the licence pack needs an attribution and a disclaimer.'
              : stale
                ? 'MLS listings are paused for clients: the MLS data is older than the licence pack allows.'
                : 'MLS listings are not shown to clients: the connection is not live.',
        licensePack: packView(r.license_pack),
      };
    }),
  };
}

export async function saveLicensePack(tx: Tx, actor: UserActor, connectionId: string, input: PackInput, now: Instant): Promise<PackView> {
  const [row] = await mlsRows(tx, connectionId, true);
  if (!row) throw new AppError('NOT_FOUND');
  if (row.status === 'disconnected') throw new AppError('CONNECTION_NOT_CONNECTABLE', { status: row.status });
  const before = packValues(row.license_pack);
  const allReviewed = PACK_KEYS.every((k) => input[k].counselReviewed === true);
  const prevAt = parseLicensePack(row.license_pack).reviewedByCounselAt;
  const unchanged = sameJson(storedPack(input, null), storedPack(Object.fromEntries(PACK_KEYS.map((k) => [k, { value: before.values[k], counselReviewed: before.marks[k] === true }])) as PackInput, null));
  const reviewedAt = allReviewed ? (unchanged && prevAt ? prevAt : new Date(now).toISOString()) : null;
  const next = storedPack(input, reviewedAt);
  await sql`UPDATE integration_connections SET license_pack = ${JSON.stringify(next)}::jsonb WHERE tenant_id = app.tenant_id() AND id = ${row.id}`.execute(tx);
  const after = packValues(next).values;
  const changedKeys = PACK_KEYS.filter((k) => !sameJson(before.values[k], after[k]));
  await audit(tx, actor, {
    action: 'integration.changed',
    entity: { type: 'integration_connection', id: row.id },
    changes: redactDiff({ license_pack_reviewed: prevAt !== null }, { license_pack_reviewed: reviewedAt !== null, changed_keys: changedKeys.join(','), unreviewed_keys: PACK_KEYS.filter((k) => !input[k].counselReviewed).join(',') }),
    reason: 'LICENSE_PACK_CHANGED',
  });
  return packView(next);
}
