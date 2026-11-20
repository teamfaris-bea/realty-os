// R-ISA-39, E1012 (migration 0112; review fix F9): playbook_versions.narrows_previous is written once and frozen.
//
// The consent chain's link 4 and the send guard (0080, 0081, 0083) read narrows_previous to decide whether care bound
// to an older version of the team AI policy continues under its successor without a re-confirmation. Nothing in the
// database stopped an UPDATE of that one column: flipped to true on a WIDER successor, by SQL in an Owner, Admin,
// system or granted-support context, it made the chain serve the wider content to every agent's care at once. No
// application path did it. 0112: the column may be set only in the UPDATE that takes a version from draft to approved,
// only for a playbook of kind ai_isa, and never changes afterwards.
// Every write here is made as the actor named, through app_user and row-level security; the superuser only reads back.
import type { SupportActor, TenantId, UserActor, UserId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Tx, withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { PH, type Harness, type Member, type World, createHarness, createWorld, suRows, uuid } from './world.js';

let h: Harness;
let w: World;
let admin: Member;
let support: SupportActor;

/** A 64-hex content hash made from the version id (the fixture's content is empty; only its hash has to match the approval row's). */
const sha = (id: string) => id.replace(/-/g, '').padEnd(64, '0').slice(0, 64);
const as = <T,>(actor: Parameters<typeof withTenantTx>[0], fn: (tx: Tx) => Promise<T>) => withTenantTx(actor, fn, { db: h.app });
const narrows = async (id: string) => (await suRows<{ n: boolean | null; status: string }>(h.su, 'SELECT narrows_previous AS n, status FROM playbook_versions WHERE id = $1', [id]))[0]!;

async function playbook(kind: string): Promise<string> {
  const id = uuid();
  await as(w.owner.actor, (tx) => sql`INSERT INTO playbooks (tenant_id, id, kind, scope, name) VALUES (app.tenant_id(), ${id}, ${kind}, 'team', ${`${kind} ${id.slice(0, 6)}`})`.execute(tx));
  return id;
}
/** A draft version, as the Owner inserts one. `narrows`: the value the INSERT names (undefined: the column is not named). */
async function draft(playbookId: string, versionNo: number, narrowsAtInsert?: boolean | null): Promise<string> {
  const id = uuid();
  await as(w.owner.actor, (tx) => (narrowsAtInsert === undefined
    ? sql`INSERT INTO playbook_versions (tenant_id, id, playbook_id, version_no, steps, tone, content_sha256, status, created_by_user_id)
          VALUES (app.tenant_id(), ${id}, ${playbookId}, ${versionNo}, '[]'::jsonb, '{}'::jsonb, ${sha(id)}, 'draft', ${w.owner.id})`
    : sql`INSERT INTO playbook_versions (tenant_id, id, playbook_id, version_no, steps, tone, content_sha256, status, created_by_user_id, narrows_previous)
          VALUES (app.tenant_id(), ${id}, ${playbookId}, ${versionNo}, '[]'::jsonb, '{}'::jsonb, ${sha(id)}, 'draft', ${w.owner.id}, ${narrowsAtInsert})`).execute(tx));
  return id;
}
/** The approving transaction, as isa/policy.ts writes it: the approval row, the previous version superseded, then ONE update of status and narrows_previous. */
async function approve(versionId: string, o: { narrows?: boolean | null; supersede?: string; actor?: UserActor } = {}): Promise<void> {
  const actor = o.actor ?? w.owner.actor;
  await as(actor, async (tx) => {
    await sql`INSERT INTO playbook_approvals (tenant_id, id, playbook_version_id, decision, decided_by_user_id, decided_by_role, content_sha256, attestation, decided_at)
      VALUES (app.tenant_id(), ${uuid()}, ${versionId}, 'approve', ${actor.userId}, ${actor.role}, ${sha(versionId)}, 'I approve this version of the policy.', now())`.execute(tx);
    if (o.supersede) await sql`UPDATE playbook_versions SET status = 'superseded' WHERE tenant_id = app.tenant_id() AND id = ${o.supersede}`.execute(tx);
    if (o.narrows === undefined) await sql`UPDATE playbook_versions SET status = 'approved' WHERE tenant_id = app.tenant_id() AND id = ${versionId}`.execute(tx);
    else await sql`UPDATE playbook_versions SET status = 'approved', narrows_previous = ${o.narrows} WHERE tenant_id = app.tenant_id() AND id = ${versionId}`.execute(tx);
  });
}
const flip = (actor: Parameters<typeof withTenantTx>[0], versionId: string, to: boolean | null) =>
  as(actor, (tx) => sql`UPDATE playbook_versions SET narrows_previous = ${to} WHERE tenant_id = app.tenant_id() AND id = ${versionId}`.execute(tx));

beforeAll(async () => {
  h = await createHarness(4);
  w = await createWorld(h.app, { agents: 2 });
  const a = w.agents[1]!;
  await as(w.owner.actor, (tx) => sql`UPDATE memberships SET role = 'admin', accepting_leads = false WHERE user_id = ${a.id}`.execute(tx));
  admin = { id: a.id, role: 'admin', actor: { ...a.actor, role: 'admin' } };
  const supportUserId = uuid() as UserId;
  await withPreTenant((tx) => sql`INSERT INTO users (id, email, display_name, password_hash) VALUES (${supportUserId}, ${`support-${uuid()}@platform.test`}, 'Platform Support', ${PH})`.execute(tx), { userId: supportUserId, db: h.app });
  const grantId = uuid();
  await as(w.owner.actor, (tx) => sql`INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, expires_at)
    VALUES (${w.tenantId}, ${grantId}, ${supportUserId}, ${w.owner.id}, 'ticket', now() + interval '1 hour')`.execute(tx));
  support = { kind: 'support', userId: supportUserId, tenantId: w.tenantId as TenantId, grantId };
}, 120_000);
afterAll(async () => {
  await h?.close();
});

describe('R-ISA-39 E1012 narrows_previous is written at approval and frozen (0112)', () => {
  let policy: string;
  let v1: string;
  let wider: string;

  it('the approving UPDATE of a policy version sets it: false for a first version, true or false for a successor', async () => {
    policy = await playbook('ai_isa');
    v1 = await draft(policy, 1);
    expect(await narrows(v1)).toEqual({ n: null, status: 'draft' });
    await approve(v1, { narrows: false });
    expect(await narrows(v1)).toEqual({ n: false, status: 'approved' });
    wider = await draft(policy, 2);
    await approve(wider, { narrows: false, supersede: v1 });
    expect(await narrows(wider)).toEqual({ n: false, status: 'approved' });
    expect(await narrows(v1)).toEqual({ n: false, status: 'superseded' });
    const narrower = await draft(policy, 3);
    await approve(narrower, { narrows: true, supersede: wider });
    expect(await narrows(narrower)).toEqual({ n: true, status: 'approved' });
  });

  it('F9: flipping it on an approved or superseded version is refused for the Owner, an Admin, the system and granted support', async () => {
    // `wider` is the superseded WIDER successor of v1: true here would let v1's care run under it with no re-confirmation
    for (const [who, actor] of [['owner', w.owner.actor], ['admin', admin.actor], ['system worker', w.system()], ['system assistant', w.system('assistant')]] as const) {
      await expect(flip(actor, wider, true), who).rejects.toThrow(/PLAYBOOK_NARROWS_FROZEN/);
      await expect(flip(actor, wider, null), who).rejects.toThrow(/PLAYBOOK_NARROWS_FROZEN/);
      await expect(flip(actor, v1, true), who).rejects.toThrow(/PLAYBOOK_NARROWS_FROZEN/);
    }
    // a support grant is read-only: whatever refuses it, the value does not change
    await flip(support, wider, true).catch(() => undefined);
    expect(await narrows(wider)).toEqual({ n: false, status: 'superseded' });
    expect(await narrows(v1)).toEqual({ n: false, status: 'superseded' });
    // writing the value it already holds is no change
    await expect(flip(w.owner.actor, wider, false)).resolves.toBeDefined();
  });

  it('it cannot be named at INSERT, set on a draft, or changed by the superseding or revoking UPDATE', async () => {
    await expect(draft(policy, 4, true)).rejects.toThrow(/PLAYBOOK_NARROWS_FROZEN/);
    await expect(draft(policy, 4, false)).rejects.toThrow(/PLAYBOOK_NARROWS_FROZEN/);
    const d = await draft(policy, 4, null);
    await expect(flip(w.owner.actor, d, true)).rejects.toThrow(/PLAYBOOK_NARROWS_FROZEN/);
    const current = (await suRows<{ id: string }>(h.su, `SELECT id FROM playbook_versions WHERE playbook_id = $1 AND status = 'approved'`, [policy]))[0]!.id;
    await expect(as(w.owner.actor, (tx) => sql`UPDATE playbook_versions SET status = 'superseded', narrows_previous = false WHERE tenant_id = app.tenant_id() AND id = ${current}`.execute(tx))).rejects.toThrow(/PLAYBOOK_NARROWS_FROZEN/);
    await expect(as(w.owner.actor, async (tx) => {
      await sql`INSERT INTO playbook_approvals (tenant_id, id, playbook_version_id, decision, decided_by_user_id, decided_by_role, content_sha256, attestation, decided_at)
        VALUES (app.tenant_id(), ${uuid()}, ${current}, 'revoke', ${w.owner.id}, 'owner', ${sha(current)}, 'I revoke this version of the policy.', now())`.execute(tx);
      await sql`UPDATE playbook_versions SET status = 'revoked', narrows_previous = false WHERE tenant_id = app.tenant_id() AND id = ${current}`.execute(tx);
    })).rejects.toThrow(/PLAYBOOK_NARROWS_FROZEN/);
    expect(await narrows(current)).toEqual({ n: true, status: 'approved' });
  });

  it('a version approved without naming it keeps NULL (not a narrowing) and cannot be given a value later', async () => {
    const other = await playbook('ai_isa');
    const a = await draft(other, 1);
    await approve(a);
    expect(await narrows(a)).toEqual({ n: null, status: 'approved' });
    await expect(flip(w.owner.actor, a, true)).rejects.toThrow(/PLAYBOOK_NARROWS_FROZEN/);
  });

  it('only the team AI policy has it: the approving UPDATE of any other kind of playbook cannot set it', async () => {
    const nurture = await playbook('nurture');
    const n1 = await draft(nurture, 1);
    await expect(approve(n1, { narrows: true })).rejects.toThrow(/PLAYBOOK_NARROWS_NOT_POLICY/);
    await expect(approve(n1, { narrows: false })).rejects.toThrow(/PLAYBOOK_NARROWS_NOT_POLICY/);
    await approve(n1);
    expect(await narrows(n1)).toEqual({ n: null, status: 'approved' });
    await expect(flip(w.owner.actor, n1, true)).rejects.toThrow(/PLAYBOOK_NARROWS_FROZEN/);
  });

  it('the guard is an invoker trigger with a pinned search_path, not callable by PUBLIC', async () => {
    const f = (await suRows<{ definer: boolean; config: string[] | null; pub: boolean }>(h.su, `SELECT p.prosecdef AS definer, p.proconfig AS config,
      has_function_privilege('public', p.oid, 'EXECUTE') AS pub FROM pg_proc p WHERE p.oid = 'app.playbook_versions_narrows_guard()'::regprocedure`))[0]!;
    expect(f).toEqual({ definer: false, config: ['search_path=pg_catalog, public'], pub: false });
    const t = await suRows<{ tgname: string; tgtype: number }>(h.su, `SELECT tgname, tgtype FROM pg_trigger WHERE tgrelid = 'public.playbook_versions'::regclass AND NOT tgisinternal ORDER BY tgname`);
    expect(t.map((x) => x.tgname)).toContain('playbook_versions_narrows_guard');
  });
});
