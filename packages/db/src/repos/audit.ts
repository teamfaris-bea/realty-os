// audit_log writes (R-AUDIT-2, R-AUDIT-3, R-AUDIT-4). Rows are written in the caller's transaction,
// so if the audit insert fails, the action fails. The RLS policy only accepts actor_kind 'user'
// rows for the current user in a user context and 'system' rows in a system context: forging is
// impossible. `changes` must be a redacted diff (ids/codes, or {"changed": true} for PII fields);
// api/platform's audit() builds it for request code, db/client writes only id/code diffs.
import type { Actor, AuditAction, IdGenerator, Instant } from '@realty/core/foundation';
import { AUDIT_ACTION_RE, actorAuditColumns, toIso } from '@realty/core/foundation';
import { sql } from 'kysely';
import type { JsonValue } from '../schema.js';
import type { Tx } from '../tenantTx.js';

export interface AuditRowSpec {
  action: AuditAction;
  entityType: string;
  entityId: string | null;
  /** redacted diff: ids, codes, instants, or {"changed": true} for PII fields */
  changes?: { [k: string]: JsonValue };
  /** a code or short non-PII sentence */
  reason?: string | null;
  requestId?: string | null;
}

export async function insertAuditRow(tx: Tx, actor: Actor, ids: IdGenerator, occurredAt: Instant, a: AuditRowSpec): Promise<void> {
  if (!AUDIT_ACTION_RE.test(a.action)) throw new TypeError(`audit action must match area.verb: ${a.action}`);
  const c = actorAuditColumns(actor);
  await sql`
    INSERT INTO audit_log (tenant_id, id, occurred_at, actor_kind, actor_via, actor_user_id, actor_role, support_grant_id,
                           action, entity_type, entity_id, changes, reason, request_id)
    VALUES (app.tenant_id(), ${ids.next<'AuditLogId'>()}, ${toIso(occurredAt)}::timestamptz, ${c.actorKind}, ${c.actorVia},
            ${c.actorUserId}, ${c.actorRole}, ${c.supportGrantId}, ${a.action}, ${a.entityType}, ${a.entityId},
            ${JSON.stringify(a.changes ?? {})}::jsonb, ${a.reason ?? null}, ${a.requestId ?? null})`.execute(tx);
}
