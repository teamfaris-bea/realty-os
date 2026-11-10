// The database side of a spot check (R-IMPORT-5): what the commit wrote for one record, read back.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { RecordRow } from './records.js';

export async function dbSide(tx: Tx, rec: RecordRow): Promise<Record<string, unknown> | null> {
  const t = rec.target_table;
  const id = rec.target_id;
  if (!t || !id) return null;
  switch (t) {
    case 'contacts': {
      const c = (await sql<{ display_name: string; first_name: string | null; last_name: string | null; deleted: boolean }>`
        SELECT display_name, first_name, last_name, deleted_at IS NOT NULL AS deleted FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx)).rows[0];
      if (!c) return null;
      const pts = (await sql<{ kind: string; address: string }>`SELECT kind, address FROM contact_points WHERE tenant_id = app.tenant_id() AND contact_id = ${id} AND status <> 'removed' ORDER BY kind, address`.execute(tx)).rows;
      return { displayName: c.display_name, firstName: c.first_name, lastName: c.last_name, phones: pts.filter((p) => p.kind === 'phone').map((p) => p.address), emails: pts.filter((p) => p.kind === 'email').map((p) => p.address), deleted: c.deleted };
    }
    case 'lead_ownership_events': {
      const e = (await sql<{ to_state: string; owner_user_id: string | null; pond_id: string | null }>`
        SELECT to_state, owner_user_id, pond_id FROM lead_ownership_events WHERE tenant_id = app.tenant_id() AND event_id = ${id}`.execute(tx)).rows[0];
      return e ? { state: e.to_state, ownerUserId: e.owner_user_id, pondId: e.pond_id } : null;
    }
    case 'notes': {
      const n = (await sql<{ body: string; created_at: Date }>`SELECT body, created_at FROM notes WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx)).rows[0];
      return n ? { body: n.body, occurredAt: n.created_at.toISOString() } : null;
    }
    case 'messages': {
      const m = (await sql<{ channel: string; direction: string; body: string; occurred_at: Date }>`
        SELECT channel, direction, body, occurred_at FROM messages WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx)).rows[0];
      return m ? { channel: m.channel, direction: m.direction, body: m.body, occurredAt: m.occurred_at.toISOString() } : null;
    }
    case 'calls': {
      const c = (await sql<{ direction: string; started_at: Date; duration_s: number | null; status: string; rec: string | null }>`
        SELECT c.direction, c.started_at, c.duration_s, c.status, (SELECT r.consent_basis FROM recordings r WHERE r.tenant_id = c.tenant_id AND r.call_id = c.id LIMIT 1) AS rec
          FROM calls c WHERE c.tenant_id = app.tenant_id() AND c.id = ${id}`.execute(tx)).rows[0];
      return c ? { direction: c.direction, startedAt: c.started_at.toISOString(), durationS: c.duration_s, status: c.status, recording: c.rec === null ? null : 'recording notice unknown' } : null;
    }
    case 'consent_events':
    case 'suppressions': {
      const ids = rec.created_rows.map((r) => r.id);
      const ev = (await sql<{ channel: string; event_type: string; consent_level: string }>`
        SELECT channel, event_type, consent_level FROM consent_events WHERE tenant_id = app.tenant_id() AND id = ANY (${ids}::uuid[]) ORDER BY channel, event_type`.execute(tx)).rows;
      const sp = (await sql<{ reason: string }>`SELECT reason FROM suppressions WHERE tenant_id = app.tenant_id() AND id = ANY (${ids}::uuid[])`.execute(tx)).rows;
      return { events: ev.map((e) => `${e.event_type}:${e.channel}:${e.consent_level}`), doNotContact: sp.length > 0 };
    }
    default:
      return null;
  }
}
