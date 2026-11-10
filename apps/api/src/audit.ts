// audit() and the redaction layer shared by audit diffs and logs (CONVENTIONS §8; R-AUDIT-3,
// R-AUDIT-4, R-AUDIT-5, R-TEN-7).
//
//   await withTenantTx(actor, async (tx) => {
//     ...the action...
//     await audit(tx, actor, { action: 'member.role_changed', entity: { type: 'membership', id },
//                              changes: redactDiff(before, after), reason: 'PROMOTED' });
//   });
//
// - Written INSIDE the action's transaction: if the insert fails (RLS forgery check, CHECK, a
//   rolled-back tx), the action fails with it (R-AUDIT-3).
// - `changes` is a RedactedDiff, which only redactDiff()/redactSnapshot() can build: non-PII fields
//   become {from, to}; PII fields (names, phones, emails, addresses, bodies, notes, secrets) become
//   {"changed": true} (R-AUDIT-4). Field classification FAILS CLOSED: a field not known to be
//   non-PII is treated as PII. The classification of every DB column is snapshot-tested.
// - `reason` is a code or a short sentence; emails and phone numbers are masked out of it.
// - request id, ip and user agent come from the request context (AsyncLocalStorage), never from
//   the caller.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { Actor, AuditAction, IdGenerator } from '@realty/core/foundation';
import { actorAuditColumns, instant, isAuditAction, uuidv7Generator } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

// ---- request context --------------------------------------------------------------------------

export interface RequestContext {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  ids?: IdGenerator;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequest(): RequestContext | undefined {
  return requestContext.getStore();
}

// ---- field classification ---------------------------------------------------------------------

export type FieldClass = 'pii' | 'secret' | 'plain';

/** Business identity printed on all marketing (A7f): auditable as from/to. */
const PLAIN_EXACT = new Set([
  'brokerage_legal_name',
  'brokerage_license_number',
  'brokerage_postal_address',
  'team_name',
  'slug',
  'status',
  'role',
  'kind',
  'type',
  'stage',
  'intent',
  'purpose',
  'channel',
  'channels',
  'strategy',
  'position',
  'priority',
  'outcome',
  'phase',
  'initiator',
  'source',
  'provider',
  'code',
  'category',
  'sensitivity',
  'reliability',
  'timezone',
  'default_timezone',
  'jurisdiction',
  'home_jurisdiction',
  'operating_jurisdictions',
  'region',
  'country',
  'accepting_leads',
  'pinned',
  'imported',
  'legal_hold',
  'open_to_all',
  'active',
  'enabled',
  'self_reported',
  'needs_review',
  'ai_enabled',
  'weight',
  'beds',
  'sqft',
  'recording_mode',
  'notification_detail',
  'mfa_required_roles',
  'autonomous_categories',
  'eligible_roles',
  'reinquiry',
  'match',
  'max_offers',
  'max_deferrals',
  'claims_per_day',
  'claim_cooldown_hours',
  'opt_out_confirmation_sender',
  'email_quiet_hours',
  'recording_enabled',
  'transcribe_imported_recordings',
  'team_lead_recording_access',
  'tc_recording_access',
  'agent_consent_entry_allowed',
  'line_type',
  'direction',
  'side',
  'listed',
  'registry',
  'event',
  'event_type',
  'consent_level',
  'action',
  'entity_type',
  'actor_kind',
  'actor_via',
  'actor_role',
  'queue',
  'routing_hours_start',
  'routing_hours_end',
  'contact_window_start',
  'contact_window_end',
  'quiet_start',
  'quiet_end',
  'property_type',
  'contact_type',
  'inquiry_type',
  'property_types',
  'cities',
  'postal_codes',
  'is_default',
  'is_lead',
  'is_primary',
]);

/** Structural suffixes that never hold free text (ids, instants, counts, digests), checked after secrets. */
const STRUCTURAL_RE = /^id$|_id$|_ids$|_at$|_until$|_on$|_count$|^count_|_sha256$|_hash$|_hmac$|_ms$|_s$|_tokens$|(^|_)seq$|_step$|_version$|_cents$|_bps$/;
/** PII and secrets, checked before the non-PII patterns (so `email_verified_at` stays PII). */
const SECRET_RE = /(^|_)(password|secret|token|totp|recovery|wrapped_key|dek)(_|$)|_enc$/;
const PII_RE =
  /(^|_)(first|last|middle|display|full|legal|preferred|maiden)_?name$|email|phone|e164|(^|_)address(?!_kind|_hmac)|^line[12]$|(^|_)(body|bodies|message|note|notes|text|summary|transcript|snippet|subject|title|description|comment|explanation|quote|draft|payload|raw|segments|endpoint|keys|hint|tags|imported_fields|value|ip|user_agent|city|postal_code|attributes|evidence|criteria|fields|match_reason|issues|normalized|location|url)(_|$)/;
const PLAIN_RE =
  /^id$|_id$|_ids$|_at$|_until$|_date$|(^|_)seq$|version$|_version_no$|_count$|^count$|_cents$|_bps$|_x10$|_seconds$|_minutes$|_hours$|_days$|_per_24h$|_per_7d$|_ms$|_round$|^(is|has)_|_enabled$|_allowed$|_access$|_required$|_hash$|_hmac$|_code$|_codes$|_kind$|_type$|_status$|_role$|_state$/;

/**
 * Entities whose `name` is a configuration label (team, pond, routing rule, ...). Everywhere else a
 * `name` is PII: a deal or saved-search name usually carries the client's name or address.
 */
const LABEL_NAME_ENTITIES = new Set(['tenant', 'team', 'pond', 'routing_rule', 'lead_source', 'playbook']);

/**
 * Classifies a field (column) name. Unknown names are PII (fail closed). `entity` (the audited
 * entity type) only matters for `name`, which is plain on LABEL_NAME_ENTITIES and PII otherwise.
 */
export function classifyField(name: string, entity?: string): FieldClass {
  const n = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(); // contactId → contact_id
  if (n === 'name') return entity !== undefined && LABEL_NAME_ENTITIES.has(entity) ? 'plain' : 'pii';
  if (PLAIN_EXACT.has(n)) return 'plain';
  if (SECRET_RE.test(n)) return 'secret';
  if (STRUCTURAL_RE.test(n)) return 'plain';
  if (PII_RE.test(n)) return 'pii';
  if (PLAIN_RE.test(n)) return 'plain';
  return 'pii';
}

// ---- redacted diffs ---------------------------------------------------------------------------

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type DiffEntry = { from: Json; to: Json } | { changed: true };
declare const REDACTED: unique symbol;
/** A redacted diff. Build it with redactDiff()/redactSnapshot(); a plain object literal does not type-check. */
export type RedactedDiff = { readonly [field: string]: DiffEntry } & { readonly [REDACTED]: true };

function toJson(v: unknown): Json {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return maskPii(v);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Uint8Array) return `[${v.length} bytes]`;
  if (Array.isArray(v)) return v.map(toJson);
  if (typeof v === 'object') {
    const o: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = classifyField(k) === 'plain' ? toJson(x) : '[redacted]';
    return o;
  }
  return null;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(toJsonRaw(a)) === JSON.stringify(toJsonRaw(b));
}

function toJsonRaw(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  return v;
}

/**
 * The redacted diff between two snapshots of an entity: only changed fields; PII and secrets as
 * {"changed": true}; everything else as {from, to}. `before` null means created. Pass the audited
 * entity type (`opts.entity`, same as audit()'s entity.type) so a label `name` can stay readable.
 */
export function redactDiff(before: Record<string, unknown> | null, after: Record<string, unknown> | null, opts: { entity?: string } = {}): RedactedDiff {
  const out: Record<string, DiffEntry> = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const k of [...keys].sort()) {
    const a = before?.[k];
    const b = after?.[k];
    if (same(a, b)) continue;
    out[k] = classifyField(k, opts.entity) === 'plain' ? { from: toJson(a), to: toJson(b) } : { changed: true };
  }
  return out as unknown as RedactedDiff;
}

/** Same as redactDiff(null, snapshot): every present field. */
export function redactSnapshot(snapshot: Record<string, unknown>, opts: { entity?: string } = {}): RedactedDiff {
  return redactDiff(null, snapshot, opts);
}

// ---- PII masking for strings (audit reasons, logs, error messages) ----------------------------

const EMAIL_G = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g;
const E164_G = /\+[1-9]\d{6,14}\b/g;
const NANP_G = /(?<![\w-])(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]\d{4}(?!\d)/g;

export function maskPii(s: string): string {
  return s.replace(EMAIL_G, '[email]').replace(E164_G, '[phone]').replace(NANP_G, '[phone]');
}

/** Keys pino and Fastify use for log metadata: kept (strings still masked). */
const LOG_KEYS = new Set([
  'level',
  'time',
  'pid',
  'hostname',
  'msg',
  'reqId',
  'requestId',
  'req',
  'res',
  'err',
  'method',
  'url',
  'route',
  'statusCode',
  'responseTime',
  'remoteAddress',
  'stack',
  'message',
  'name',
  'code',
  'type',
  'tenantId',
  'userId',
  'jobId',
  'durationMs',
  'count',
  'reason',
  'provider',
  'action',
  'kind',
  'module',
]);

/** Log redaction: drops values under PII keys and masks emails/E.164/phone numbers in strings. */
export function redactForLog(v: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof v === 'string') return maskPii(v);
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Uint8Array) return `[${v.length} bytes]`;
  if (Array.isArray(v)) return v.map((x) => redactForLog(x, depth + 1));
  if (v instanceof Error) {
    const e = v as Error & { code?: unknown };
    return { type: e.name, message: maskPii(e.message), code: typeof e.code === 'string' ? e.code : undefined, stack: e.stack ? maskPii(e.stack) : undefined };
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (LOG_KEYS.has(k) || classifyField(k) === 'plain') out[k] = redactForLog(x, depth + 1);
    else out[k] = '[redacted]';
  }
  return out;
}

// ---- audit() ----------------------------------------------------------------------------------

export interface EntityRef {
  type: string;
  id: string | null;
}

export class AuditSpecError extends TypeError {
  override readonly name = 'AuditSpecError';
}

const ENTITY_RE = /^[a-z][a-z_]*$/;
const fallbackIds: IdGenerator = uuidv7Generator({ now: () => instant(Date.now()) }, (n) => new Uint8Array(randomBytes(n)));

/**
 * Writes one audit_log row in `tx` (the action's transaction). Throws on a bad spec; a DB failure
 * propagates and aborts the transaction, so the action cannot commit without its audit row.
 */
export async function audit(tx: Tx, actor: Actor, e: { action: AuditAction; entity: EntityRef; changes?: RedactedDiff; reason?: string }): Promise<void> {
  if (!isAuditAction(e.action)) throw new AuditSpecError(`unknown audit action: ${String(e.action)}`);
  if (!ENTITY_RE.test(e.entity.type)) throw new AuditSpecError('entity.type must be snake_case');
  const ctx = currentRequest();
  const ids = ctx?.ids ?? fallbackIds;
  const c = actorAuditColumns(actor);
  const reason = e.reason === undefined ? null : maskPii(e.reason).slice(0, 200);
  await sql`
    INSERT INTO audit_log (tenant_id, id, occurred_at, actor_kind, actor_via, actor_user_id, actor_role, support_grant_id,
                           action, entity_type, entity_id, changes, reason, request_id, ip, user_agent)
    VALUES (app.tenant_id(), ${ids.next<'AuditLogId'>()}, clock_timestamp(), ${c.actorKind}, ${c.actorVia}, ${c.actorUserId},
            ${c.actorRole}, ${c.supportGrantId}, ${e.action}, ${e.entity.type}, ${e.entity.id},
            ${JSON.stringify(e.changes ?? {})}::jsonb, ${reason}, ${ctx?.requestId ?? null}, ${ctx?.ip ?? null}::inet,
            ${ctx?.userAgent ? ctx.userAgent.slice(0, 300) : null})`.execute(tx);
}
