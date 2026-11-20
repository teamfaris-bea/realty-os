// R-TEAMQ-10 (b19 team-queue lane, step 2; migration 0107): a lead source's coverage columns, as the database itself
// holds them whatever the API does:
//   - "covered" can be on only while an owner and a backup are both named;
//   - the named people are members of THIS team (composite foreign keys), never another team's;
//   - only an Owner or an Admin, as themselves, changes coverage: not the system, an agent, a team lead or support;
//   - suspending or removing a named member never fails and never clears the source: the row keeps naming them.
// Names here are made up.
import type { SupportActor, TenantId, UserId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { PH, createHarness, createWorld, uuid, type Harness, type Member, type World } from './world.js';

let h: Harness;
let w: World;
let other: World;
let admin: Member;

type Actor = Parameters<typeof withTenantTx>[0];
const as = <T>(actor: Actor, fn: Parameters<typeof withTenantTx<T>>[1]) => withTenantTx(actor, fn, { db: h.app });
const cover = (actor: Actor, sourceId: string, o: { owner: string | null; backup: string | null; covered: boolean; highIntent?: boolean }) =>
  as(actor, async (tx) =>
    Number(
      (
        await sql`UPDATE lead_sources SET owner_user_id = ${o.owner}, backup_user_id = ${o.backup}, covered = ${o.covered}, high_intent = ${o.highIntent ?? false}, coverage_changed_at = now()
                   WHERE tenant_id = app.tenant_id() AND id = ${sourceId}`.execute(tx)
      ).numAffectedRows ?? 0,
    ),
  );
const row = async (sourceId: string) =>
  (await h.su.query<{ o: string | null; b: string | null; c: boolean; hi: boolean }>('SELECT owner_user_id AS o, backup_user_id AS b, covered AS c, high_intent AS hi FROM lead_sources WHERE id = $1', [sourceId])).rows[0]!;

beforeAll(async () => {
  h = await createHarness();
  w = await createWorld(h.app, { agents: 3, teamLead: true });
  other = await createWorld(h.app, { agents: 1 });
  const a = w.agents[2]!;
  await as(w.owner.actor, (tx) => sql`UPDATE memberships SET role = 'admin', accepting_leads = false WHERE user_id = ${a.id}`.execute(tx));
  admin = { id: a.id, role: 'admin', actor: { ...a.actor, role: 'admin' } };
});
afterAll(async () => {
  await h?.close();
});

describe('R-TEAMQ-10 (0107): lead source coverage in the database', () => {
  it('R-TEAMQ-10: every existing and new source starts with nobody named, not high intent, not covered', async () => {
    expect(await row(w.leadSourceId)).toEqual({ o: null, b: null, c: false, hi: false });
  });

  it('R-TEAMQ-10 E933: covered is refused without both an owner and a backup; with both it is stored', async () => {
    const [a, b] = w.agents as [Member, Member, Member];
    await expect(cover(w.owner.actor, w.leadSourceId, { owner: a.id, backup: null, covered: true })).rejects.toThrow(/lead_sources_covered_needs_both/);
    await expect(cover(w.owner.actor, w.leadSourceId, { owner: null, backup: b.id, covered: true })).rejects.toThrow(/lead_sources_covered_needs_both/);
    expect(await cover(w.owner.actor, w.leadSourceId, { owner: a.id, backup: b.id, covered: true, highIntent: true })).toBe(1);
    expect(await row(w.leadSourceId)).toEqual({ o: a.id, b: b.id, c: true, hi: true });
    // an Admin changes it too
    expect(await cover(admin.actor, w.leadSourceId, { owner: a.id, backup: b.id, covered: false })).toBe(1);
    expect(await cover(admin.actor, w.leadSourceId, { owner: a.id, backup: b.id, covered: true })).toBe(1);
  });

  it('R-TEAMQ-10 R-TEN-1: another team\'s member cannot be named, and another team\'s source cannot be changed or read', async () => {
    const [a] = w.agents as [Member];
    await expect(cover(w.owner.actor, w.leadSourceId, { owner: other.agents[0]!.id, backup: a.id, covered: false })).rejects.toThrow(/foreign key/);
    await expect(cover(w.owner.actor, w.leadSourceId, { owner: a.id, backup: other.owner.id, covered: false })).rejects.toThrow(/foreign key/);
    expect(await cover(other.owner.actor, w.leadSourceId, { owner: null, backup: null, covered: false })).toBe(0);
    expect(await as(other.owner.actor, async (tx) => (await sql`SELECT 1 FROM lead_sources WHERE id = ${w.leadSourceId}`.execute(tx)).rows.length)).toBe(0);
    expect((await row(w.leadSourceId)).o).toBe(a.id);
  });

  it('R-TEAMQ-10 R-PERM-11: only an Owner or an Admin changes coverage: an agent and a team lead change no row, the system and support are refused', async () => {
    const [a, b] = w.agents as [Member, Member, Member];
    const before = await row(w.leadSourceId);
    for (const m of [a, w.tl!]) expect(await cover(m.actor, w.leadSourceId, { owner: null, backup: null, covered: false })).toBe(0);
    for (const via of ['worker', 'timer', 'import', 'provider'] as const) {
      await expect(cover(w.system(via), w.leadSourceId, { owner: b.id, backup: a.id, covered: true })).rejects.toThrow(/LEAD_SOURCE_COVERAGE_OWNER_ADMIN_ONLY/);
    }
    // a source the system creates (an integration) cannot arrive already covered
    await expect(
      as(w.system('provider'), (tx) => sql`INSERT INTO lead_sources (tenant_id, id, name, kind, owner_user_id, backup_user_id, covered) VALUES (${w.tenantId}, ${uuid()}, 'Made by the system (0107 test)', 'other', ${a.id}, ${b.id}, true)`.execute(tx)),
    ).rejects.toThrow(/LEAD_SOURCE_COVERAGE_OWNER_ADMIN_ONLY/);
    // ...while its ordinary writes to a source still pass
    expect(await as(w.system('provider'), async (tx) => Number((await sql`UPDATE lead_sources SET updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${w.leadSourceId}`.execute(tx)).numAffectedRows ?? 0))).toBe(1);
    // support with a live grant never writes here
    const supportId = uuid() as UserId;
    await withPreTenant((tx) => sql`INSERT INTO users (id, email, display_name, password_hash) VALUES (${supportId}, ${`support-${uuid()}@platform.test`}, 'Platform Support', ${PH})`.execute(tx), { userId: supportId, db: h.app });
    const grantId = uuid();
    await as(w.owner.actor, (tx) => sql`INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, expires_at)
      VALUES (${w.tenantId}, ${grantId}, ${supportId}, ${w.owner.id}, 'coverage check', now() + interval '1 hour')`.execute(tx));
    const support: SupportActor = { kind: 'support', userId: supportId, tenantId: w.tenantId as TenantId, grantId };
    await expect(cover(support, w.leadSourceId, { owner: null, backup: null, covered: false })).rejects.toThrow(/SUPPORT_READ_ONLY/);
    expect(await row(w.leadSourceId)).toEqual(before);
  });

  it('R-TEAMQ-11 E934: suspending or removing a named member does not fail and does not clear the source: the row still names them', async () => {
    const [a, b] = w.agents as [Member, Member, Member];
    await cover(w.owner.actor, w.leadSourceId, { owner: a.id, backup: b.id, covered: true });
    await as(w.owner.actor, (tx) => sql`UPDATE memberships SET status = 'suspended' WHERE tenant_id = app.tenant_id() AND user_id = ${b.id}`.execute(tx));
    await as(w.owner.actor, (tx) => sql`UPDATE memberships SET status = 'removed', removed_at = now() WHERE tenant_id = app.tenant_id() AND user_id = ${a.id}`.execute(tx));
    expect(await row(w.leadSourceId)).toMatchObject({ o: a.id, b: b.id, c: true });
  });
});
