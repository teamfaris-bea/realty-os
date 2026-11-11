// Shared by the lane perf-misses-2 equivalence tests: the request contexts a row-by-row comparison runs
// under, set exactly as the API sets them (withTenantTx / withPortalTx set_config, transaction-local):
//   every member role (two members each where the tenant has two), the system actor, support WITHOUT a
//   grant, support WITH a live grant, and a client (portal) principal.
// Tests only (imported by *.test.ts).
import type pg from 'pg';

export interface EqActor {
  label: string;
  tenantId: string;
  userId: string;
  actorKind: 'user' | 'system' | 'support' | '';
  principal: 'staff' | 'client';
  /** support with a grant: the grant row is inserted (and removed) by the test, as the superuser */
  grant?: boolean;
  /** client principal: the portal account id GUC */
  portalAccountId?: string;
}

/** Two members per role (first and last by user id), the system actor, support ±grant and a client. */
export async function equivalenceActors(su: pg.Client | pg.Pool, tenantId: string, opts: { perRole?: number } = {}): Promise<EqActor[]> {
  const ms = (await su.query<{ user_id: string; role: string }>(`SELECT user_id, role FROM memberships WHERE tenant_id = $1 AND status = 'active' ORDER BY role, user_id`, [tenantId])).rows;
  const per = opts.perRole ?? 2;
  const out: EqActor[] = [];
  for (const role of [...new Set(ms.map((m) => m.role))]) {
    const of = ms.filter((m) => m.role === role);
    const pick = per >= of.length ? of : [...of.slice(0, Math.ceil(per / 2)), ...of.slice(of.length - Math.floor(per / 2))];
    for (const m of pick) out.push({ label: `${role}:${m.user_id.slice(0, 8)}`, tenantId, userId: m.user_id, actorKind: 'user', principal: 'staff' });
  }
  const owner = ms.find((m) => m.role === 'owner')!;
  out.push({ label: 'system', tenantId, userId: '', actorKind: 'system', principal: 'staff' });
  // support staff are platform users; the owner's user id stands in (the grant decides, not the membership)
  const supportUser = (await su.query<{ id: string }>(`SELECT id FROM users WHERE id <> ALL ($1::uuid[]) ORDER BY id LIMIT 1`, [ms.map((m) => m.user_id)])).rows[0]?.id ?? owner.user_id;
  out.push({ label: 'support (no grant)', tenantId, userId: supportUser, actorKind: 'support', principal: 'staff' });
  out.push({ label: 'support (grant)', tenantId, userId: supportUser, actorKind: 'support', principal: 'staff', grant: true });
  const acct = (await su.query<{ id: string }>(`SELECT id FROM portal_accounts WHERE tenant_id = $1 ORDER BY id LIMIT 1`, [tenantId]).catch(() => ({ rows: [] as { id: string }[] }))).rows[0]?.id;
  out.push({ label: 'client principal', tenantId, userId: '', actorKind: '', principal: 'client', portalAccountId: acct ?? '00000000-0000-0000-0000-000000000000' });
  return out;
}

/** Inside an open transaction on `c` (as the superuser): the actor's GUCs, then SET LOCAL ROLE app_user. */
export async function enterAs(c: pg.Client, a: EqActor, ownershipCommand = ''): Promise<void> {
  if (a.grant) {
    await c.query(`INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, expires_at)
                   SELECT $1, gen_random_uuid(), $2, m.user_id, 'equivalence test', now() + interval '1 hour'
                     FROM memberships m WHERE m.tenant_id = $1 AND m.role = 'owner' ORDER BY m.user_id LIMIT 1`, [a.tenantId, a.userId]);
  }
  if (a.principal === 'client') {
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.principal_type', 'client', true), set_config('app.portal_account_id', $2, true),
                          set_config('app.user_id', '', true), set_config('app.actor_kind', '', true), set_config('app.ownership_command', '', true)`, [a.tenantId, a.portalAccountId]);
  } else {
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_kind', $3, true),
                          set_config('app.principal_type', 'staff', true), set_config('app.ownership_command', $4, true)`, [a.tenantId, a.userId, a.actorKind, ownershipCommand]);
  }
  await c.query('SET LOCAL ROLE app_user');
}

/** Back to the superuser inside the same transaction. */
export async function leave(c: pg.Client): Promise<void> {
  await c.query('RESET ROLE');
}
