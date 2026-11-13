// Fixtures for the module 45 DB tests (portal_api_*.test.ts). Builds on module 43's portalFixture.ts (left as it is):
// every staff-side row is written as app_user under RLS by the agent or the system actor, exactly as the API does.
// The superuser only flips platform:portal, ages rows and reads state back.
import type { TenantId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { withTenantTx } from '../src/tenantTx.js';
import type { Harness, Member, World } from './world.js';
import { uuid } from './world.js';

/** A team listing of the agent (the listing agent). */
export async function createListing(h: Harness, w: World, agent: Member, line1 = '12 Elm Street'): Promise<string> {
  const id = uuid();
  await withTenantTx(agent.actor, (tx) => sql`INSERT INTO listings (tenant_id, id, status, address_line1, city, region, postal_code, listing_agent_user_id)
    VALUES (${w.tenantId}, ${id}, 'active', ${line1}, 'Springfield', 'IL', '62701', ${agent.id})`.execute(tx), { db: h.app });
  return id;
}

export async function setDealListing(h: Harness, agent: Member, dealId: string, listingId: string): Promise<void> {
  await withTenantTx(agent.actor, (tx) => sql`UPDATE deals SET listing_id = ${listingId} WHERE id = ${dealId}`.execute(tx), { db: h.app });
}

export async function addDealContact(h: Harness, w: World, agent: Member, dealId: string, contactId: string, role: 'buyer' | 'seller' | 'co_buyer' | 'co_seller' | 'other'): Promise<void> {
  await withTenantTx(agent.actor, (tx) => sql`INSERT INTO deal_contacts (tenant_id, deal_id, contact_id, role) VALUES (${w.tenantId}, ${dealId}, ${contactId}, ${role})`.execute(tx), { db: h.app });
}

export async function createShowing(h: Harness, w: World, agent: Member, listingId: string, buyerContactId: string | null = null): Promise<string> {
  const id = uuid();
  await withTenantTx(agent.actor, (tx) => sql`INSERT INTO showings (tenant_id, id, listing_id, starts_at, buyer_contact_id, created_by_user_id)
    VALUES (${w.tenantId}, ${id}, ${listingId}, now() - interval '1 day', ${buyerContactId}, ${agent.id})`.execute(tx), { db: h.app });
  return id;
}

/** A confirmed manual milestone of the deal, entered by the agent. */
export async function createMilestone(h: Harness, w: World, agent: Member, dealId: string, dueOn = '2030-06-01', kind = 'inspection'): Promise<string> {
  const id = uuid();
  await withTenantTx(agent.actor, (tx) => sql`INSERT INTO deal_dates (tenant_id, id, deal_id, kind, due_on, status, confirmed_by_user_id, confirmed_at)
    VALUES (${w.tenantId}, ${id}, ${dealId}, ${kind}, ${dueOn}::date, 'confirmed', ${agent.id}, now())`.execute(tx), { db: h.app });
  return id;
}

/** Inserts a portal item as `actor` (a person or the system); returns the id or the guard's code. */
export async function insertItem(
  h: Harness,
  w: World,
  actor: Member | 'system',
  spec: { grantId: string; kind: string; sourceType: string; sourceId: string; version?: number; documentId?: string | null },
): Promise<{ id: string } | { code: string }> {
  const id = uuid();
  const a = actor === 'system' ? w.system('worker') : actor.actor;
  const by = actor === 'system' ? null : actor.id;
  return withTenantTx(a, (tx) => sql`INSERT INTO portal_items (tenant_id, id, grant_id, kind, title, source_type, source_id, source_version, document_id,
      published_by_kind, published_by_user_id, published_at)
    VALUES (${w.tenantId}, ${id}, ${spec.grantId}, ${spec.kind}, 'Item', ${spec.sourceType}, ${spec.sourceId}, ${spec.version ?? 1}, ${spec.documentId ?? null},
      ${by === null ? 'system' : 'user'}, ${by}, now())`.execute(tx), { db: h.app }).then(
    () => ({ id }),
    (e: Error) => ({ code: e.message.split(':')[0]! }),
  );
}

/** Retracts as `actor`, writing `by` as the author (defaults to the honest one). Returns 'ok' or the code. */
export async function retractItem(h: Harness, w: World, actor: Member | 'system', itemId: string, by?: string | null): Promise<string> {
  const a = actor === 'system' ? w.system('worker') : actor.actor;
  const author = by !== undefined ? by : actor === 'system' ? null : actor.id;
  return withTenantTx(a, async (tx) => {
    const r = await sql`UPDATE portal_items SET retracted_at = now(), retracted_by_user_id = ${author} WHERE id = ${itemId}`.execute(tx);
    return Number(r.numAffectedRows ?? 0) === 1 ? 'ok' : 'no_row';
  }, { db: h.app }).catch((e: Error) => e.message.split(':')[0]!);
}

export const tenantOf = (w: World): TenantId => w.tenantId;
