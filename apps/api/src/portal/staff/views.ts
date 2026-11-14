// What staff see of the portal (R-PORTAL-16; honest UI): every view says whether the client can see anything now and,
// if not, why. Reads under the person's RLS. The preview renders the client's view through shared/view.ts, the very
// serializer the client routes use.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { hint } from '../../comms/dispatch.js';
import { ITEM_STILL_LISTED_UNSHARED, NOT_VISIBLE, type NotVisibleReason, RETRACTED_BY_SYNC, RETRACTED_NOT_SELLER_SIDE } from '../shared/copy.js';
import { type PortalItemRow, grantContent, grantView } from '../shared/view.js';
import { isoOrNull, portalClearedInTx } from './common.js';

export interface AccountView {
  id: string;
  contactId: string;
  status: 'invited' | 'active' | 'disabled';
  statusText: string;
  loginPoint: { id: string; kind: 'email' | 'phone'; hint: string; status: string; usable: boolean } | null;
  signInImpossible: string | null;
  disabledReason: string | null;
}

export async function accountViews(tx: Tx, ids: readonly string[]): Promise<AccountView[]> {
  if (ids.length === 0) return [];
  const r = await sql<{ id: string; contact_id: string; status: AccountView['status']; activated_at: Date | null; disabled_reason: string | null; point_id: string | null; kind: 'email' | 'phone' | null; address: string | null; point_status: string | null; removed: boolean | null }>`
    SELECT a.id, a.contact_id, a.status, a.activated_at, a.disabled_reason, p.id AS point_id, p.kind, p.address, p.status AS point_status,
           p.removed_at IS NOT NULL AS removed
      FROM portal_accounts a LEFT JOIN contact_points p ON p.tenant_id = a.tenant_id AND p.id = a.login_point_id
     WHERE a.tenant_id = app.tenant_id() AND a.id = ANY (${ids as string[]}::uuid[]) ORDER BY a.created_at, a.id`.execute(tx);
  return r.rows.map((a) => {
    const usable = a.point_id !== null && a.removed === false && a.point_status === 'active';
    const statusText =
      a.status === 'disabled' ? 'Disabled.' : a.status === 'active' ? `Signed in on ${a.activated_at!.toISOString().slice(0, 10)}.` : 'Invited; has not signed in yet.';
    return {
      id: a.id,
      contactId: a.contact_id,
      status: a.status,
      statusText,
      loginPoint: a.point_id && a.kind && a.address ? { id: a.point_id, kind: a.kind, hint: hint(a.address), status: a.removed ? 'removed' : (a.point_status ?? 'unknown'), usable } : null,
      signInImpossible: a.status !== 'disabled' && !usable ? 'Sign-in is impossible: the sign-in email or phone was removed or marked wrong. Choose another one for this client.' : null,
      disabledReason: a.disabled_reason,
    };
  });
}

export interface GrantStaffView {
  id: string;
  accountId: string;
  state: 'live' | 'revoked' | 'lapsed' | 'not_a_party' | 'account_disabled' | 'contact_deleted';
  stateText: string;
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  view: ReturnType<typeof grantView>;
}

interface GrantRow {
  id: string;
  portal_account_id: string;
  display: unknown;
  granted_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  lapsed: boolean;
  party: boolean;
  account_status: string;
  /** the account's contact is soft-deleted (seen by a tenant-wide reader: contacts_select hides deleted rows from others) */
  contact_deleted: boolean;
}

async function grantRows(tx: Tx, where: ReturnType<typeof sql>): Promise<GrantRow[]> {
  const r = await sql<GrantRow>`
    SELECT g.id, g.portal_account_id, g.display, g.granted_at, g.expires_at, g.revoked_at, u.display_name AS revoked_by,
           (g.expires_at IS NOT NULL AND g.expires_at <= now()) AS lapsed,
           app.portal_party_ok(g.tenant_id, g.portal_account_id, g.deal_id, g.listing_id) AS party, a.status AS account_status,
           EXISTS (SELECT 1 FROM contacts c WHERE c.tenant_id = a.tenant_id AND c.id = a.contact_id AND c.deleted_at IS NOT NULL) AS contact_deleted
      FROM portal_grants g JOIN portal_accounts a ON a.tenant_id = g.tenant_id AND a.id = g.portal_account_id
      LEFT JOIN users u ON u.id = g.revoked_by_user_id
     WHERE g.tenant_id = app.tenant_id() AND ${where} ORDER BY g.granted_at, g.id`.execute(tx);
  return r.rows;
}

function stateOf(g: GrantRow): { state: GrantStaffView['state']; reason: NotVisibleReason | null } {
  if (g.revoked_at) return { state: 'revoked', reason: 'REVOKED' };
  if (g.lapsed) return { state: 'lapsed', reason: 'LAPSED' };
  if (g.account_status === 'disabled') return { state: 'account_disabled', reason: 'DISABLED' };
  // b15 (b14 low f): before the party check: 0091's portal_party_ok is false for a soft-deleted client, who is still a
  // party; saying "no longer a party" would be false
  if (g.contact_deleted) return { state: 'contact_deleted', reason: 'CONTACT_DELETED' };
  if (!g.party) return { state: 'not_a_party', reason: 'NOT_A_PARTY' };
  return { state: 'live', reason: null };
}

const toStaff = (g: GrantRow): GrantStaffView => {
  const s = stateOf(g);
  return {
    id: g.id,
    accountId: g.portal_account_id,
    state: s.state,
    stateText: s.reason ? NOT_VISIBLE[s.reason] : 'Live.',
    grantedAt: g.granted_at.toISOString(),
    expiresAt: isoOrNull(g.expires_at),
    revokedAt: isoOrNull(g.revoked_at),
    revokedBy: g.revoked_at ? (g.revoked_by ?? 'A team member') : null,
    view: grantView({ id: g.id, display: g.display, expiresAt: g.expires_at }),
  };
};

export async function grantStaffViews(tx: Tx, ids: readonly string[]): Promise<GrantStaffView[]> {
  if (ids.length === 0) return [];
  return (await grantRows(tx, sql`g.id = ANY (${ids as string[]}::uuid[])`)).map(toStaff);
}

export interface ItemStaffView {
  id: string;
  grantId: string;
  kind: PortalItemRow['kind'];
  title: string;
  occursOn: string | null;
  publishedAt: string;
  publishedBy: string;
  retractedAt: string | null;
  retractedBy: string | null;
  note: string | null;
}

const SELLER_SIDE_KINDS: ReadonlySet<string> = new Set(['showing', 'feedback', 'seller_update']);

export async function itemStaffViews(tx: Tx, grantIds: readonly string[]): Promise<ItemStaffView[]> {
  if (grantIds.length === 0) return [];
  const r = await sql<{ id: string; grant_id: string; kind: PortalItemRow['kind']; title: string; occurs_on: string | null; published_at: Date; published_by_kind: string; pub: string | null; retracted_at: Date | null; retracted_by_user_id: string | null; ret: string | null; unshared: boolean | null }>`
    SELECT i.id, i.grant_id, i.kind, i.title, i.occurs_on::text AS occurs_on, i.published_at, i.published_by_kind, pu.display_name AS pub,
           i.retracted_at, i.retracted_by_user_id, ru.display_name AS ret,
           (i.kind = 'document' AND i.retracted_at IS NULL AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.tenant_id = i.tenant_id AND d.id = i.document_id AND d.shared_to_portal)) AS unshared
      FROM portal_items i LEFT JOIN users pu ON pu.id = i.published_by_user_id LEFT JOIN users ru ON ru.id = i.retracted_by_user_id
     WHERE i.tenant_id = app.tenant_id() AND i.grant_id = ANY (${grantIds as string[]}::uuid[])
     ORDER BY i.published_at, i.id`.execute(tx);
  return r.rows.map((i) => ({
    id: i.id,
    grantId: i.grant_id,
    kind: i.kind,
    title: i.title,
    occursOn: i.occurs_on,
    publishedAt: i.published_at.toISOString(),
    publishedBy: i.published_by_kind === 'system' ? 'Automatic' : (i.pub ?? 'A team member'),
    retractedAt: isoOrNull(i.retracted_at),
    retractedBy: i.retracted_at === null ? null : i.retracted_by_user_id === null ? 'Automatic' : (i.ret ?? 'A team member'),
    // the sync retracts a showing, feedback or seller update only when the client stopped being seller-side (b14 review R3)
    note: i.retracted_at !== null && i.retracted_by_user_id === null ? (SELLER_SIDE_KINDS.has(i.kind) ? RETRACTED_NOT_SELLER_SIDE : RETRACTED_BY_SYNC) : i.unshared ? ITEM_STILL_LISTED_UNSHARED : null,
  }));
}

/** GET /deals/:id/portal, /listings/:id/portal: accounts, grants and items of that deal or listing. */
export async function scopeState(tx: Tx, scope: { kind: 'deal' | 'listing'; id: string }) {
  const grants = (await grantRows(tx, scope.kind === 'deal' ? sql`g.deal_id = ${scope.id}::uuid` : sql`g.listing_id = ${scope.id}::uuid`)).map(toStaff);
  const accountIds = [...new Set(grants.map((g) => g.accountId))];
  const cleared = await portalClearedInTx(tx);
  return {
    portalCleared: cleared,
    portalText: cleared ? null : NOT_VISIBLE.PORTAL_OFF,
    accounts: await accountViews(tx, accountIds),
    grants,
    items: await itemStaffViews(tx, grants.map((g) => g.id)),
  };
}

/** GET /portal-grants/:id/preview: the client's view of this grant, and why the client cannot see it now. */
export async function grantPreview(tx: Tx, grantId: string) {
  const rows = await grantRows(tx, sql`g.id = ${grantId}::uuid`);
  const g = rows[0];
  if (!g) return null;
  const items = await sql<{ id: string; grant_id: string; kind: PortalItemRow['kind']; title: string; body: string | null; occurs_on: string | null; published_at: Date }>`
    SELECT id, grant_id, kind, title, body, occurs_on::text AS occurs_on, published_at
      FROM portal_items WHERE tenant_id = app.tenant_id() AND grant_id = ${grantId}::uuid AND retracted_at IS NULL ORDER BY published_at, id`.execute(tx);
  const content = grantContent(
    { id: g.id, display: g.display, expiresAt: g.expires_at },
    items.rows.map((i) => ({ id: i.id, grantId: i.grant_id, kind: i.kind, title: i.title, body: i.body, occursOn: i.occurs_on, publishedAt: i.published_at })),
  );
  const why: string[] = [];
  if (!(await portalClearedInTx(tx))) why.push(NOT_VISIBLE.PORTAL_OFF);
  const s = stateOf(g);
  if (s.reason) why.push(NOT_VISIBLE[s.reason]);
  else if (g.account_status === 'invited') why.push(NOT_VISIBLE.NOT_SIGNED_IN);
  return { visibleNow: why.length === 0, why, grant: content.grant, timeline: content.timeline, documents: content.documents };
}
