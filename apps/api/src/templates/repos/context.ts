// The one-person render context (parity module 63; R-PAR-24): built under the SENDER's RLS for exactly one
// person. A field the sender cannot see is simply absent; nothing here can read another contact's row.
import type { OnePersonContext } from '@realty/core/parity/templates';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

/** The person's names, or null when the sender does not see their DETAIL (pond/offer cards are not enough). */
export async function contactNames(tx: Tx, contactId: string): Promise<OnePersonContext['contact'] | null> {
  const r = await sql<{ first_name: string | null; last_name: string | null; display_name: string; v: boolean }>`
    SELECT first_name, last_name, display_name, app.contact_detail_visible(tenant_id, id) AS v
      FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${contactId} AND deleted_at IS NULL AND merged_into_contact_id IS NULL`.execute(tx);
  const c = r.rows[0];
  if (!c || !c.v) return null;
  return { firstName: c.first_name, lastName: c.last_name, displayName: c.display_name };
}

/** The sender's own name, email and number (their direct line, else the team main), and the tenant's names. */
export async function senderContext(tx: Tx): Promise<Pick<OnePersonContext, 'agent' | 'team' | 'brokerage'>> {
  const r = await sql<{ display_name: string | null; email: string | null; phone: string | null; team_name: string | null; brokerage: string | null }>`
    SELECT u.display_name, u.email,
           (SELECT n.e164 FROM phone_numbers n WHERE n.tenant_id = app.tenant_id() AND n.released_at IS NULL AND n.sms_capable
               AND (n.purpose = 'team_main' OR (n.purpose = 'agent_direct' AND n.assigned_user_id = app.user_id()))
             ORDER BY (n.purpose = 'agent_direct') DESC, n.acquired_at, n.id LIMIT 1) AS phone,
           s.team_name, s.brokerage_legal_name AS brokerage
      FROM tenant_settings s
      LEFT JOIN users u ON u.id = app.user_id()
     WHERE s.tenant_id = app.tenant_id()`.execute(tx);
  const x = r.rows[0];
  const name = (x?.display_name ?? '').trim();
  const space = name.indexOf(' ');
  return {
    agent: { firstName: space < 0 ? name || null : name.slice(0, space), lastName: space < 0 ? null : name.slice(space + 1).trim() || null, phone: x?.phone ?? null, email: x?.email ?? null },
    team: { name: x?.team_name ?? x?.brokerage ?? null },
    brokerage: { name: x?.brokerage ?? null },
  };
}

/** Live custom field values of ONE person (contact_field_values follow the person's detail, R-PAR-19). */
export async function fieldValues(tx: Tx, contactId: string): Promise<Record<string, string | null>> {
  const r = await sql<{ key: string; field_type: string; value_text: string | null; value_number: string | null; value_date: string | null; value_options: string[] | null; options: { id: string; label: string }[] }>`
    SELECT d.key, d.field_type, v.value_text, v.value_number::text AS value_number, to_char(v.value_date, 'YYYY-MM-DD') AS value_date,
           v.value_options, d.options
      FROM contact_field_values v
      JOIN custom_field_defs d ON d.tenant_id = v.tenant_id AND d.id = v.field_id AND d.archived_at IS NULL
     WHERE v.tenant_id = app.tenant_id() AND v.contact_id = ${contactId}`.execute(tx);
  const out: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  for (const x of r.rows) {
    const label = (id: string) => x.options.find((o) => o.id === id)?.label ?? null;
    switch (x.field_type) {
      case 'text':
        out[x.key] = x.value_text;
        break;
      case 'number':
        out[x.key] = x.value_number;
        break;
      case 'date':
        out[x.key] = x.value_date;
        break;
      default:
        out[x.key] = (x.value_options ?? []).map(label).filter((l): l is string => l !== null).join(', ') || null;
    }
  }
  return out;
}

/** The complete context for one person, or null when the sender cannot see them. */
export async function onePersonContext(tx: Tx, contactId: string): Promise<OnePersonContext | null> {
  const contact = await contactNames(tx, contactId);
  if (!contact) return null;
  return { contact, ...(await senderContext(tx)), fields: await fieldValues(tx, contactId) };
}
