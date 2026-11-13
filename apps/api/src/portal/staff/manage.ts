// Revoke a grant, disable an account, change the login point, edit a grant's title (R-PORTAL-13, R-PORTAL-14,
// R-PORTAL-18). Each as the person, audited, final where the schema says so (409 on a second revoke or disable). A
// disabled account stops at the client's next request (portal.resolve_session needs an active account). A login point
// change voids outstanding links (portal.consume_login needs the same current point), not open sessions (Q-PORTAL-13):
// the answer says how to end them.
import type { UserActor } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../../audit.js';
import { AppError } from '../../errors.js';

export async function revokeGrant(tx: Tx, actor: UserActor, grantId: string): Promise<void> {
  const cur = await sql<{ revoked_at: Date | null }>`SELECT revoked_at FROM portal_grants WHERE tenant_id = app.tenant_id() AND id = ${grantId} FOR UPDATE`.execute(tx);
  if (!cur.rows[0]) throw new AppError('NOT_FOUND');
  if (cur.rows[0].revoked_at) throw new AppError('PORTAL_GRANT_REVOKED');
  const r = await sql`UPDATE portal_grants SET revoked_at = now(), revoked_by_user_id = ${actor.userId}
                       WHERE tenant_id = app.tenant_id() AND id = ${grantId} AND revoked_at IS NULL`.execute(tx);
  if (Number(r.numAffectedRows ?? 0) !== 1) throw new AppError('NOT_FOUND');
  await audit(tx, actor, { action: 'portal.grant_revoked', entity: { type: 'portal_grant', id: grantId } });
}

export async function disableAccount(tx: Tx, actor: UserActor, accountId: string, reason: 'CLIENT_ASKED' | 'WRONG_PERSON' | 'NO_LONGER_A_CLIENT'): Promise<void> {
  const cur = await sql<{ status: string }>`SELECT status FROM portal_accounts WHERE tenant_id = app.tenant_id() AND id = ${accountId} FOR UPDATE`.execute(tx);
  if (!cur.rows[0]) throw new AppError('NOT_FOUND');
  if (cur.rows[0].status === 'disabled') throw new AppError('PORTAL_ACCOUNT_DISABLED');
  const r = await sql`UPDATE portal_accounts SET status = 'disabled', disabled_at = now(), disabled_reason = ${reason}
                       WHERE tenant_id = app.tenant_id() AND id = ${accountId} AND status <> 'disabled'`.execute(tx);
  if (Number(r.numAffectedRows ?? 0) !== 1) throw new AppError('NOT_FOUND');
  await audit(tx, actor, { action: 'portal.account_disabled', entity: { type: 'portal_account', id: accountId }, reason });
}

export async function changeLoginPoint(tx: Tx, actor: UserActor, accountId: string, pointId: string): Promise<void> {
  const a = await sql<{ status: string; contact_id: string; login_point_id: string }>`
    SELECT status, contact_id, login_point_id FROM portal_accounts WHERE tenant_id = app.tenant_id() AND id = ${accountId} FOR UPDATE`.execute(tx);
  const acc = a.rows[0];
  if (!acc) throw new AppError('NOT_FOUND');
  if (acc.status === 'disabled') throw new AppError('PORTAL_ACCOUNT_DISABLED');
  const p = await sql<{ id: string }>`
    SELECT id FROM contact_points WHERE tenant_id = app.tenant_id() AND id = ${pointId} AND contact_id = ${acc.contact_id}
       AND kind IN ('email','phone') AND removed_at IS NULL AND status = 'active'`.execute(tx);
  if (!p.rows[0]) throw new AppError('PORTAL_LOGIN_POINT_MISSING');
  if (acc.login_point_id === pointId) return;
  await sql`UPDATE portal_accounts SET login_point_id = ${pointId} WHERE tenant_id = app.tenant_id() AND id = ${accountId}`.execute(tx);
  await audit(tx, actor, { action: 'portal.login_point_changed', entity: { type: 'portal_account', id: accountId } });
}

export async function setGrantTitle(tx: Tx, actor: UserActor, grantId: string, title: string): Promise<void> {
  const cur = await sql<{ display: Record<string, unknown> }>`SELECT display FROM portal_grants WHERE tenant_id = app.tenant_id() AND id = ${grantId} FOR UPDATE`.execute(tx);
  if (!cur.rows[0]) throw new AppError('NOT_FOUND');
  const r = await sql`UPDATE portal_grants SET display = display || jsonb_build_object('title', ${title}::text) WHERE tenant_id = app.tenant_id() AND id = ${grantId}`.execute(tx);
  if (Number(r.numAffectedRows ?? 0) !== 1) throw new AppError('NOT_FOUND');
  await audit(tx, actor, { action: 'portal.display_updated', entity: { type: 'portal_grant', id: grantId }, reason: 'title' });
}
