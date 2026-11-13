// Shared helpers of the staff portal routes (R-PORTAL-13, R-PORTAL-14): one transaction as the person, stable codes
// for the portal guards' refusals, and the §8 facts of a deal, listing, grant, item or account.
import { type Action, type ResourceFacts, type UserActor, can } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { AppError, isErrorCode } from '../../errors.js';
import { actorOf, platformOf } from '../../workspace/common.js';
import { dealFacts } from '../../workspace/deals.js';

/** DB refusal codes the portal maps to its own stable codes (anything else from a guard is an API bug: logged, 500). */
const DB_CODES: Record<string, string> = {
  PORTAL_NOT_A_PARTY: 'PORTAL_NOT_A_PARTY',
  PORTAL_SOURCE_NOT_IN_GRANT: 'PORTAL_SOURCE_NOT_IN_GRANT',
  PORTAL_NOT_SELLER_SIDE: 'PORTAL_NOT_SELLER_SIDE',
  PORTAL_ITEM_RETRACTED: 'PORTAL_ITEM_RETRACTED',
  PORTAL_GRANT_REVOKED: 'PORTAL_GRANT_REVOKED',
  PORTAL_ACCOUNT_DISABLED: 'PORTAL_ACCOUNT_DISABLED',
  PORTAL_LOGIN_POINT: 'PORTAL_LOGIN_POINT_MISSING',
};

export function dbCodeOf(e: unknown): string | null {
  const m = /^([A-Z][A-Z0-9_]+):/.exec(String((e as { message?: unknown })?.message ?? ''));
  return m ? m[1]! : null;
}

export function mapPortalDbError(req: FastifyRequest, e: unknown): unknown {
  if (e instanceof AppError) return e;
  const code = dbCodeOf(e);
  if (code && DB_CODES[code] && isErrorCode(DB_CODES[code]!)) return new AppError(DB_CODES[code] as never);
  if (code && /^PORTAL_|^CLIENT_READ_ONLY/.test(code)) {
    req.log.error({ code }, 'portal: a database guard refused an API write');
    return new AppError('INTERNAL_ERROR');
  }
  return e;
}

/** One request transaction as the person (R-TEN-3); portal DB codes become stable codes. */
export async function staffTx<T>(req: FastifyRequest, fn: (tx: Tx, actor: UserActor, now: number) => Promise<T>): Promise<T> {
  const actor = actorOf(req);
  try {
    return await withTenantTx(actor, (tx, now) => fn(tx, actor, now), { db: platformOf(req).db, retries: 2 });
  } catch (e) {
    throw mapPortalDbError(req, e);
  }
}

/** can() with the request's re-auth state (for per-grant checks inside a handler). */
export function canFor(req: FastifyRequest): (action: Action, facts: ResourceFacts) => boolean {
  const actor = actorOf(req);
  const state = req.authState;
  return (action, facts) => state !== undefined && can(actor, action, { ...facts, reauth: { reauthenticatedAt: state.reauthenticatedAt, now: state.now } }).ok;
}

/** A listing's §8 facts for the portal: own = listing agent, team = a team member's listing (null: invisible). */
export async function listingPortalFacts(tx: Tx, listingId: string): Promise<ResourceFacts | null> {
  const r = await sql<{ own: boolean; team: boolean }>`
    SELECT listing_agent_user_id IS NOT DISTINCT FROM app.user_id() AS own,
           COALESCE(listing_agent_user_id = ANY (app.my_team_member_ids()), false) AS team
      FROM listings WHERE tenant_id = app.tenant_id() AND id = ${listingId}`.execute(tx);
  const f = r.rows[0];
  return f ? { own: f.own === true, team: f.team === true } : null;
}

export async function scopeFacts(tx: Tx, scope: { dealId: string | null; listingId: string | null }): Promise<ResourceFacts | null> {
  if (scope.dealId) return dealFacts(tx, scope.dealId);
  if (scope.listingId) return listingPortalFacts(tx, scope.listingId);
  return null;
}

export interface GrantScope {
  id: string;
  accountId: string;
  dealId: string | null;
  listingId: string | null;
}

/** A grant the person can see (staff RLS), or null. */
export async function grantById(tx: Tx, grantId: string): Promise<GrantScope | null> {
  const r = await sql<{ id: string; portal_account_id: string; deal_id: string | null; listing_id: string | null }>`
    SELECT id, portal_account_id, deal_id, listing_id FROM portal_grants WHERE tenant_id = app.tenant_id() AND id = ${grantId}`.execute(tx);
  const g = r.rows[0];
  return g ? { id: g.id, accountId: g.portal_account_id, dealId: g.deal_id, listingId: g.listing_id } : null;
}

export async function grantFacts(tx: Tx, grantId: string): Promise<ResourceFacts | null> {
  const g = await grantById(tx, grantId);
  return g ? scopeFacts(tx, g) : null;
}

/** The facts of the scopes of every grant (merged: any scope a role grant names, from any grant). */
export async function mergedFacts(tx: Tx, grants: readonly GrantScope[]): Promise<ResourceFacts | null> {
  let seen = false;
  const out = { own: false, team: false, deal: false };
  for (const g of grants) {
    const f = await scopeFacts(tx, g);
    if (!f) continue;
    seen = true;
    out.own ||= f.own === true;
    out.team ||= f.team === true;
    out.deal ||= f.deal === true;
  }
  return seen ? out : null;
}

export async function grantsOfAccount(tx: Tx, accountId: string): Promise<GrantScope[]> {
  const r = await sql<{ id: string; portal_account_id: string; deal_id: string | null; listing_id: string | null }>`
    SELECT id, portal_account_id, deal_id, listing_id FROM portal_grants WHERE tenant_id = app.tenant_id() AND portal_account_id = ${accountId}`.execute(tx);
  return r.rows.map((g) => ({ id: g.id, accountId: g.portal_account_id, dealId: g.deal_id, listingId: g.listing_id }));
}

export async function accountFacts(tx: Tx, accountId: string): Promise<ResourceFacts | null> {
  const a = await sql<{ id: string }>`SELECT id FROM portal_accounts WHERE tenant_id = app.tenant_id() AND id = ${accountId}`.execute(tx);
  if (a.rows.length === 0) return null;
  return mergedFacts(tx, await grantsOfAccount(tx, accountId));
}

export async function itemGrant(tx: Tx, itemId: string): Promise<GrantScope | null> {
  const r = await sql<{ grant_id: string }>`SELECT grant_id FROM portal_items WHERE tenant_id = app.tenant_id() AND id = ${itemId}`.execute(tx);
  return r.rows[0] ? grantById(tx, r.rows[0].grant_id) : null;
}

/** platform:portal cleared (counsel review; never a code default, D11). */
export async function portalClearedInTx(tx: Tx): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`SELECT app.platform_cleared('platform:portal') AS ok`.execute(tx);
  return r.rows[0]?.ok === true;
}

export async function memberName(tx: Tx, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const r = await sql<{ n: string }>`SELECT display_name AS n FROM users WHERE id = ${userId}`.execute(tx);
  return r.rows[0]?.n ?? null;
}

export const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export const requireFacts = (f: ResourceFacts | null): ResourceFacts => {
  if (!f) throw new AppError('NOT_FOUND');
  return f;
};
