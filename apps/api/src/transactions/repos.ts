// SQL of api/transactions. Every statement is tenant-scoped (tenant_id = app.tenant_id()) and runs under the
// caller's RLS: a person's request reads and writes the deal dates their deal visibility allows (policy
// deal_dates_all); the reconcile and the cancellation job run as the system actor.
import { type IanaZone, type Instant, ianaZone, instantFromDate } from '@realty/core/foundation';
import type { DealDate, DealSide, MilestoneKind, Responsible } from '@realty/core/transactions';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface DateRow {
  id: string;
  deal_id: string;
  kind: MilestoneKind;
  label: string | null;
  due_on: string;
  source: DealDate['source'];
  status: DealDate['status'];
  due_version: number;
  due_at: Date | null;
  reminder_at: Date | null;
  completed_at: Date | null;
  responsible: Responsible | null;
  basis: Record<string, unknown>;
  confirmed_by_user_id: string | null;
  confirmed_at: Date | null;
}

export const DATE_COLS = sql`dd.id, dd.deal_id, dd.kind, dd.label, dd.due_on::text AS due_on, dd.source, dd.status, dd.due_version, dd.due_at,
  dd.reminder_at, dd.completed_at, dd.responsible, dd.basis, dd.confirmed_by_user_id, dd.confirmed_at`;

const at = (d: Date | null): Instant | null => (d === null ? null : instantFromDate(d));

/** The stored row as core's DealDate. */
export function coreDate(r: DateRow): DealDate {
  return {
    id: r.id as DealDate['id'],
    kind: r.kind,
    label: r.label,
    dueOn: r.due_on as DealDate['dueOn'],
    source: r.source,
    status: r.status,
    dueVersion: r.due_version,
    dueAt: at(r.due_at),
    reminderAt: at(r.reminder_at),
    completedAt: at(r.completed_at),
    responsible: r.responsible,
    basis: r.basis as DealDate['basis'],
  };
}

export async function dateById(tx: Tx, id: string, o: { lock?: boolean } = {}): Promise<DateRow | null> {
  const r = o.lock
    ? await sql<DateRow>`SELECT ${DATE_COLS} FROM deal_dates dd WHERE dd.tenant_id = app.tenant_id() AND dd.id = ${id} FOR UPDATE`.execute(tx)
    : await sql<DateRow>`SELECT ${DATE_COLS} FROM deal_dates dd WHERE dd.tenant_id = app.tenant_id() AND dd.id = ${id}`.execute(tx);
  return r.rows[0] ?? null;
}

export async function datesOfDeal(tx: Tx, dealId: string): Promise<DateRow[]> {
  const r = await sql<DateRow>`SELECT ${DATE_COLS} FROM deal_dates dd WHERE dd.tenant_id = app.tenant_id() AND dd.deal_id = ${dealId} ORDER BY dd.due_on, dd.id`.execute(tx);
  return r.rows;
}

export interface TenantTxnSettings {
  zone: IanaZone;
  templates: unknown;
  jurisdictions: string[];
}

export async function txnSettings(tx: Tx): Promise<TenantTxnSettings> {
  const r = await sql<{ z: string; t: unknown; j: string[] }>`
    SELECT default_timezone AS z, milestone_templates AS t, operating_jurisdictions AS j FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  const x = r.rows[0];
  return { zone: ianaZone(x?.z) ?? (ianaZone('America/New_York') as IanaZone), templates: x?.t ?? [], jurisdictions: x?.j ?? [] };
}

export interface DealHead {
  id: string;
  side: DealSide;
  stage: string;
  ownerUserId: string;
  name: string;
}

export async function dealHead(tx: Tx, dealId: string): Promise<DealHead | null> {
  const r = await sql<{ id: string; side: DealSide; stage: string; owner_user_id: string; name: string }>`
    SELECT id, side, stage, owner_user_id, name FROM deals WHERE tenant_id = app.tenant_id() AND id = ${dealId}`.execute(tx);
  const d = r.rows[0];
  return d ? { id: d.id, side: d.side, stage: d.stage, ownerUserId: d.owner_user_id, name: d.name } : null;
}

export interface DealRecipient {
  contactId: string;
  name: string | null;
  ownerUserId: string | null;
  live: boolean;
  roles: string[];
}

/** The deal's contacts with their roles (deal_contacts) and the contact facts the update path needs. */
export async function dealRecipients(tx: Tx, dealIds: readonly string[]): Promise<Map<string, DealRecipient[]>> {
  const out = new Map<string, DealRecipient[]>();
  if (dealIds.length === 0) return out;
  const r = await sql<{ deal_id: string; contact_id: string; name: string | null; owner_user_id: string | null; live: boolean; roles: string[] }>`
    SELECT dc.deal_id, dc.contact_id, c.display_name AS name, c.owner_user_id, (c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL) AS live,
           array_agg(dc.role ORDER BY dc.role) AS roles
      FROM deal_contacts dc JOIN contacts c ON c.tenant_id = dc.tenant_id AND c.id = dc.contact_id
     WHERE dc.tenant_id = app.tenant_id() AND dc.deal_id = ANY (${dealIds}::uuid[])
     GROUP BY dc.deal_id, dc.contact_id, c.display_name, c.owner_user_id, c.deleted_at, c.merged_into_contact_id
     ORDER BY dc.deal_id, dc.contact_id`.execute(tx);
  for (const x of r.rows) {
    const list = out.get(x.deal_id) ?? [];
    list.push({ contactId: x.contact_id, name: x.name, ownerUserId: x.owner_user_id, live: x.live, roles: x.roles });
    out.set(x.deal_id, list);
  }
  return out;
}
