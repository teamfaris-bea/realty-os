// Builds core/portal's SourceFacts from rows (R-PORTAL-3, R-PORTAL-14, R-PORTAL-19). Reads under the caller's RLS (a
// person publishing, or the system in portal.sync), so a source the publisher cannot see is simply absent.
import { type IanaZone, type Instant, ianaZone, instantFromDate } from '@realty/core/foundation';
import { KIND_SOURCE_TYPE, type PortalKind, type PortalSource, type Publisher, type SourceFacts } from '@realty/core/portal';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface GrantBindingRow {
  deal_id: string | null;
  listing_id: string | null;
  deal_listing_id: string | null;
  contact_id: string;
  seller_side: boolean;
  revoked: boolean;
  lapsed: boolean;
  disabled: boolean;
}

export async function grantBinding(tx: Tx, grantId: string): Promise<GrantBindingRow | null> {
  const r = await sql<GrantBindingRow>`
    SELECT g.deal_id, g.listing_id, d.listing_id AS deal_listing_id, a.contact_id,
           (g.deal_id IS NOT NULL AND EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.tenant_id = g.tenant_id AND dc.deal_id = g.deal_id
                                                AND dc.contact_id = a.contact_id AND dc.role IN ('seller','co_seller'))) AS seller_side,
           g.revoked_at IS NOT NULL AS revoked, (g.expires_at IS NOT NULL AND g.expires_at <= now()) AS lapsed,
           a.status = 'disabled' AS disabled
      FROM portal_grants g
      JOIN portal_accounts a ON a.tenant_id = g.tenant_id AND a.id = g.portal_account_id
      LEFT JOIN deals d ON d.tenant_id = g.tenant_id AND d.id = g.deal_id
     WHERE g.tenant_id = app.tenant_id() AND g.id = ${grantId}`.execute(tx);
  return r.rows[0] ?? null;
}

export async function tenantZone(tx: Tx): Promise<IanaZone> {
  const r = await sql<{ z: string }>`SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  return ianaZone(r.rows[0]?.z ?? 'America/New_York') ?? (ianaZone('America/New_York') as IanaZone);
}

const inst = (d: Date | null): Instant | null => (d === null ? null : instantFromDate(d));

/** The source row of a kind, as core reads it, or null when the caller cannot see it. */
export async function loadSource(tx: Tx, kind: PortalKind, sourceId: string): Promise<PortalSource | null> {
  switch (KIND_SOURCE_TYPE[kind]) {
    case 'deal_date': {
      const r = await sql<{ id: string; deal_id: string; kind: string; label: string | null; due_on: string; status: string; due_version: number }>`
        SELECT id, deal_id, kind, label, due_on::text AS due_on, status, due_version FROM deal_dates WHERE tenant_id = app.tenant_id() AND id = ${sourceId}`.execute(tx);
      const x = r.rows[0];
      return x ? ({ type: 'deal_date', id: x.id, dealId: x.deal_id, kind: x.kind, label: x.label, dueOn: x.due_on, status: x.status, dueVersion: x.due_version } as unknown as PortalSource) : null;
    }
    case 'document': {
      const r = await sql<{ id: string; deal_id: string | null; listing_id: string | null; contact_id: string | null; object_id: string; kind: string; display_name: string; version_no: number; shared_to_portal: boolean; scan_status: string }>`
        SELECT id, deal_id, listing_id, contact_id, object_id, kind, display_name, version_no, shared_to_portal, scan_status
          FROM documents WHERE tenant_id = app.tenant_id() AND id = ${sourceId}`.execute(tx);
      const x = r.rows[0];
      return x
        ? ({ type: 'document', id: x.id, dealId: x.deal_id, listingId: x.listing_id, contactId: x.contact_id, objectId: x.object_id, kind: x.kind, displayName: x.display_name, versionNo: x.version_no, sharedToPortal: x.shared_to_portal, scanStatus: x.scan_status } as unknown as PortalSource)
        : null;
    }
    case 'showing': {
      const r = await sql<{ id: string; listing_id: string; starts_at: Date; status: string; source: string; buyer_agent_name: string | null; buyer_agent_brokerage: string | null; buyer_contact_id: string | null }>`
        SELECT id, listing_id, starts_at, status, source, buyer_agent_name, buyer_agent_brokerage, buyer_contact_id
          FROM showings WHERE tenant_id = app.tenant_id() AND id = ${sourceId}`.execute(tx);
      const x = r.rows[0];
      return x
        ? ({ type: 'showing', showing: { id: x.id, startsAt: inst(x.starts_at), status: x.status, source: x.source, buyerAgentName: x.buyer_agent_name, buyerAgentBrokerage: x.buyer_agent_brokerage }, listingId: x.listing_id, buyerContactId: x.buyer_contact_id } as unknown as PortalSource)
        : null;
    }
    case 'showing_feedback': {
      const r = await sql<{ id: string; showing_id: string; rating: number | null; comments: string | null; source: string; received_at: Date; listing_id: string; buyer_contact_id: string | null }>`
        SELECT f.id, f.showing_id, f.rating, f.comments, f.source, f.received_at, s.listing_id, s.buyer_contact_id
          FROM showing_feedback f JOIN showings s ON s.tenant_id = f.tenant_id AND s.id = f.showing_id
         WHERE f.tenant_id = app.tenant_id() AND f.id = ${sourceId}`.execute(tx);
      const x = r.rows[0];
      return x
        ? ({ type: 'showing_feedback', feedback: { id: x.id, showingId: x.showing_id, rating: x.rating, comments: x.comments, source: x.source, receivedAt: inst(x.received_at) }, listingId: x.listing_id, buyerContactId: x.buyer_contact_id } as unknown as PortalSource)
        : null;
    }
    case 'assistant_action': {
      const r = await sql<{ id: string; kind: string; status: string; listing: string | null; text: string | null }>`
        SELECT id, kind, status, trigger_ref->>'listing_id' AS listing, COALESCE(edited_payload, payload)->>'body' AS text
          FROM assistant_actions WHERE tenant_id = app.tenant_id() AND id = ${sourceId}`.execute(tx);
      const x = r.rows[0];
      return x ? ({ type: 'assistant_action', id: x.id, kind: x.kind, status: x.status, triggerListingId: x.listing, text: x.text ?? '' } as unknown as PortalSource) : null;
    }
    case 'task': {
      const r = await sql<{ id: string; deal_id: string | null; listing_id: string | null; title: string; due_at: Date | null; status: string }>`
        SELECT id, deal_id, listing_id, title, due_at, status FROM tasks WHERE tenant_id = app.tenant_id() AND id = ${sourceId}`.execute(tx);
      const x = r.rows[0];
      return x ? ({ type: 'task', id: x.id, dealId: x.deal_id, listingId: x.listing_id, title: x.title, dueAt: inst(x.due_at), status: x.status } as unknown as PortalSource) : null;
    }
  }
}

/** SourceFacts for publishing `kind`/`sourceId` into `grantId`, or null when the grant or the source is not visible. */
export async function sourceFacts(tx: Tx, grantId: string, kind: PortalKind, sourceId: string, publisher: Publisher): Promise<SourceFacts | null> {
  const g = await grantBinding(tx, grantId);
  if (!g) return null;
  const source = await loadSource(tx, kind, sourceId);
  if (!source) return null;
  return {
    source,
    grant: {
      dealId: g.deal_id,
      listingId: g.listing_id,
      dealListingId: g.deal_id ? g.deal_listing_id : null,
      clientContactId: g.contact_id,
      clientIsSellerSide: g.seller_side,
      revoked: g.revoked,
      lapsed: g.lapsed,
      accountDisabled: g.disabled,
    } as SourceFacts['grant'],
    publisher,
    zone: await tenantZone(tx),
  };
}
