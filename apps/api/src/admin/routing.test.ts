// api/admin routing rules through the real server and Postgres: R-OWN-10 (rule shape, and the rules
// configured here drive real routing: first enabled match by position, disabled/archived rules never
// match, no match ⇒ default pond NO_RULE_MATCH), the atomic reorder (deferrable unique position, two
// sessions racing), optimistic versions, R-AUDIT-5 routing changes.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { auditRows, call, freshReauth, inviteViaApi, registerPush, routeInquiry } from './testing.js';

interface Rule {
  id: string;
  position: number;
  version: number;
  strategy: string;
  enabled: boolean;
  members: { userId: string; weight: number }[];
}

let h: ApiHarness;
let owner: TestClient;
let a1: TestClient;
let a2: TestClient;
let tc: TestClient;
let defaultPondId: string;

async function rules(): Promise<Rule[]> {
  return (await call<{ rules: Rule[] }>(owner, 'GET', '/routing-rules')).body.rules;
}

async function create(body: Record<string, unknown>) {
  return call<{ rule: Rule }>(owner, 'POST', '/routing-rules', body);
}

async function archiveAll() {
  for (const r of await rules()) expect((await call(owner, 'DELETE', `/routing-rules/${r.id}`)).status).toBe(200);
}

beforeAll(async () => {
  h = await createApiHarness();
  owner = await h.signup();
  a1 = await inviteViaApi(h, owner, 'agent');
  a2 = await inviteViaApi(h, owner, 'agent');
  tc = await inviteViaApi(h, owner, 'tc');
  await registerPush(a1);
  await registerPush(a2);
  await freshReauth(h, owner);
  const ponds = await call<{ ponds: { id: string; isDefault: boolean }[] }>(owner, 'GET', '/ponds');
  defaultPondId = ponds.body.ponds.find((p) => p.isDefault)!.id;
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('R-OWN-10 rule shape', () => {
  it('R-OWN-10: strategy ⇔ target: direct needs directUserId, pond needs targetPondId, only round_robin/weighted carry members', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ name: 'd', strategy: 'direct' }, 'directUserId'],
      [{ name: 'p', strategy: 'pond' }, 'targetPondId'],
      [{ name: 'rr', strategy: 'round_robin', directUserId: a1.userId }, 'directUserId'],
      [{ name: 'rr', strategy: 'round_robin', targetPondId: defaultPondId }, 'targetPondId'],
      [{ name: 'd', strategy: 'direct', directUserId: a1.userId, members: [{ userId: a2.userId, weight: 1 }] }, 'members'],
    ];
    for (const [body, field] of cases) {
      const r = await create(body);
      expect({ field, status: r.status, code: r.code, detail: (r.body as { error?: { details?: { field?: string } } }).error?.details?.field }).toEqual({ field, status: 422, code: 'RULE_INVALID', detail: field });
    }
    expect(await rules()).toEqual([]);
  });

  it('R-OWN-10: match is the core schema: sources, lead_types, zips, price band; unknown keys and an inverted band are refused', async () => {
    expect((await create({ name: 'x', strategy: 'pond', targetPondId: defaultPondId, match: { cities: ['Charleston'] } })).code).toBe('RULE_INVALID');
    expect((await create({ name: 'x', strategy: 'pond', targetPondId: defaultPondId, match: { price_min: 500, price_max: 100 } })).code).toBe('RULE_INVALID');
    expect((await create({ name: 'x', strategy: 'pond', targetPondId: defaultPondId, match: { zips: ['2940'] } })).code).toBe('RULE_INVALID');
    const ok = await create({ name: 'Downtown sellers', strategy: 'pond', targetPondId: defaultPondId, match: { lead_types: ['sell'], zips: ['29401-1234'], price_min: 0, price_max: 90_000_000 } });
    expect(ok.status).toBe(201);
    expect((ok.body.rule as unknown as { match: unknown }).match).toEqual({ lead_types: ['sell'], zips: ['29401-1234'], price_min: 0, price_max: 90_000_000 });
    await archiveAll();
  });

  it('R-OWN-10 R-PERM-15: candidates must be active members in a role that is offered leads (never a TC, Owner or Admin)', async () => {
    for (const userId of [tc.userId, owner.userId, randomUUID()]) {
      const r = await create({ name: 'x', strategy: 'round_robin', members: [{ userId, weight: 1 }] });
      expect([r.status, r.code]).toEqual([422, 'MEMBER_NOT_ELIGIBLE']);
      expect((await create({ name: 'x', strategy: 'direct', directUserId: userId })).code).toBe('MEMBER_NOT_ELIGIBLE');
    }
    expect((await create({ name: 'x', strategy: 'round_robin', members: [{ userId: a1.userId, weight: 1 }, { userId: a1.userId, weight: 2 }] })).code).toBe('RULE_INVALID');
    expect(await rules()).toEqual([]);
  });

  it('R-OWN-10: a pond from another tenant, or an archived pond, is never a target or fallback', async () => {
    const other = await h.signup();
    const otherPond = (await call<{ ponds: { id: string }[] }>(other, 'GET', '/ponds')).body.ponds[0]!.id;
    const r = await create({ name: 'x', strategy: 'pond', targetPondId: otherPond });
    expect([r.status, r.code]).toEqual([422, 'RULE_INVALID']);
    const p = await call<{ pond: { id: string } }>(owner, 'POST', '/ponds', { name: 'Old leads' });
    expect((await call(owner, 'DELETE', `/ponds/${p.body.pond.id}`)).status).toBe(200);
    expect((await create({ name: 'x', strategy: 'round_robin', fallbackPondId: p.body.pond.id })).body).toMatchObject({ error: { details: { reason: 'archived_pond' } } });
  });
});

describe('R-OWN-10 the configured rules drive routing', () => {
  it('R-OWN-10: first enabled match by position wins; a reorder, a disable and an archive each change the next routing; no match ⇒ default pond NO_RULE_MATCH', async () => {
    const everyone = await create({ name: 'Everyone → A1', strategy: 'direct', directUserId: a1.userId });
    const buyers = await create({ name: 'Buyers → A2', strategy: 'direct', directUserId: a2.userId, match: { lead_types: ['buy'] } });
    expect([everyone.status, buyers.status]).toEqual([201, 201]);
    expect((await routeInquiry(h, owner.tenantId!, { inquiryType: 'buy' })).offeredTo).toBe(a1.userId);

    const order = await call<{ rules: Rule[] }>(owner, 'PUT', '/routing-rules/order', { ruleIds: [buyers.body.rule.id, everyone.body.rule.id] });
    expect(order.body.rules.map((r) => [r.id, r.position])).toEqual([[buyers.body.rule.id, 1], [everyone.body.rule.id, 2]]);
    expect((await routeInquiry(h, owner.tenantId!, { inquiryType: 'buy' })).offeredTo).toBe(a2.userId);
    expect((await routeInquiry(h, owner.tenantId!, { inquiryType: 'sell' })).offeredTo).toBe(a1.userId);

    const cur = (await rules()).find((r) => r.id === buyers.body.rule.id)!;
    expect((await call(owner, 'PATCH', `/routing-rules/${cur.id}`, { enabled: false, version: cur.version })).status).toBe(200);
    expect((await routeInquiry(h, owner.tenantId!, { inquiryType: 'buy' })).offeredTo).toBe(a1.userId);

    await archiveAll();
    const none = await routeInquiry(h, owner.tenantId!, { inquiryType: 'buy' });
    expect(none).toMatchObject({ state: 'in_pond', pondId: defaultPondId, reason: 'NO_RULE_MATCH', offeredTo: null });
  });

  it('R-OWN-10: a round-robin rule built through PUT /members alternates between its members; weights are stored', async () => {
    const rr = await create({ name: 'Round robin', strategy: 'round_robin' });
    const set = await call<{ rule: Rule }>(owner, 'PUT', `/routing-rules/${rr.body.rule.id}/members`, [
      { userId: a1.userId, weight: 1 },
      { userId: a2.userId, weight: 3 },
    ]);
    expect(set.body.rule.members).toEqual(
      [{ userId: a1.userId, weight: 1 }, { userId: a2.userId, weight: 3 }].sort((x, y) => (x.userId! < y.userId! ? -1 : 1)),
    );
    expect(set.body.rule.version).toBe(rr.body.rule.version + 1);
    const got = [];
    for (let i = 0; i < 4; i++) got.push((await routeInquiry(h, owner.tenantId!, { inquiryType: 'general' })).offeredTo);
    expect(new Set(got)).toEqual(new Set([a1.userId, a2.userId]));
    expect(got[0]).not.toBe(got[1]);
    // switching the strategy to pond clears the members in the same transaction
    const cur = (await rules()).find((r) => r.id === rr.body.rule.id)!;
    const sw = await call<{ rule: Rule }>(owner, 'PATCH', `/routing-rules/${cur.id}`, { strategy: 'pond', targetPondId: defaultPondId, version: cur.version });
    expect(sw.body.rule).toMatchObject({ strategy: 'pond', members: [] });
    await archiveAll();
  });

  it('VERSION_CONFLICT: a PATCH with a stale version changes nothing and returns the fresh rule', async () => {
    const r = await create({ name: 'Stale', strategy: 'pond', targetPondId: defaultPondId });
    expect((await call(owner, 'PATCH', `/routing-rules/${r.body.rule.id}`, { name: 'Fresh', version: r.body.rule.version })).status).toBe(200);
    const stale = await call(owner, 'PATCH', `/routing-rules/${r.body.rule.id}`, { name: 'Lost update', version: r.body.rule.version });
    expect([stale.status, stale.code]).toEqual([409, 'VERSION_CONFLICT']);
    expect(stale.body).toMatchObject({ error: { details: { rule: { name: 'Fresh' } } } });
    await archiveAll();
    expect((await call(owner, 'PATCH', `/routing-rules/${r.body.rule.id}`, { name: 'x', version: 99 })).code).toBe('NOT_FOUND');
  });
});

describe('atomic reorder (deferrable unique position)', () => {
  it('a reorder that swaps every position commits in one transaction (the deferred UNIQUE never trips midway); a wrong id set changes nothing', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await create({ name: `R${i}`, strategy: 'pond', targetPondId: defaultPondId })).body.rule.id);
    const reversed = [...ids].reverse();
    const r = await call<{ rules: Rule[] }>(owner, 'PUT', '/routing-rules/order', { ruleIds: reversed });
    expect(r.body.rules.map((x) => x.id)).toEqual(reversed);
    expect(r.body.rules.map((x) => x.position)).toEqual([1, 2, 3, 4]);
    for (const bad of [[...ids.slice(0, 3)], [...ids.slice(0, 3), randomUUID()], [ids[0], ids[0], ids[1], ids[2]]]) {
      const res = await call(owner, 'PUT', '/routing-rules/order', { ruleIds: bad });
      expect([res.status, res.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect(res.body).toMatchObject({ error: { details: { ruleIds: reversed } } });
    }
    expect((await rules()).map((x) => x.id)).toEqual(reversed);
    await archiveAll();
  });

  it('two sessions reordering concurrently serialize; a third session polling positions only ever sees a complete order (never a duplicate or a mix)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await create({ name: `C${i}`, strategy: 'pond', targetPondId: defaultPondId })).body.rule.id);
    const second = await h.login(owner.email);
    second.totpSecret = owner.totpSecret;
    expect((await second.post('/api/auth/mfa/verify', { code: await second.totp() })).statusCode).toBe(200);
    const perms = [ids, [...ids].reverse(), [ids[2]!, ids[0]!, ids[4]!, ids[1]!, ids[3]!], [ids[4]!, ids[3]!, ids[0]!, ids[1]!, ids[2]!]];
    const valid = new Set(perms.map((p) => p.join(',')));
    const reader = new pg.Client({ connectionString: h.testDb.ownerUrl });
    await reader.connect();
    let polling = true;
    const seen: string[] = [];
    const poll = (async () => {
      while (polling) {
        const r = await reader.query<{ id: string; position: number }>(
          'SELECT id, position FROM routing_rules WHERE tenant_id = $1 AND archived_at IS NULL ORDER BY position',
          [owner.tenantId],
        );
        const positions = r.rows.map((x) => x.position);
        expect(new Set(positions).size).toBe(positions.length);
        seen.push(r.rows.map((x) => x.id).join(','));
      }
    })();
    try {
      for (let round = 0; round < 4; round++) {
        const [x, y] = await Promise.all([
          call(owner, 'PUT', '/routing-rules/order', { ruleIds: perms[round % perms.length] }),
          call(second, 'PUT', '/routing-rules/order', { ruleIds: perms[(round + 1) % perms.length] }),
        ]);
        expect([x.status, y.status]).toEqual([200, 200]);
        const final = (await rules()).map((r) => r.id).join(',');
        expect([perms[round % perms.length]!.join(','), perms[(round + 1) % perms.length]!.join(',')]).toContain(final);
      }
    } finally {
      polling = false;
      await poll;
      await reader.end();
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(valid.has(s)).toBe(true);
    await archiveAll();
  });

  it('concurrent creates never collide on a position (per-tenant admin lock): every rule gets a distinct position', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => create({ name: `P${i}`, strategy: 'pond', targetPondId: defaultPondId })));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
    const positions = (await rules()).map((r) => r.position);
    expect(new Set(positions).size).toBe(6);
    await archiveAll();
  });
});

describe('R-AUDIT-5 routing changes', () => {
  it('R-AUDIT-5: create, member set, update, reorder and archive each write routing.changed in the same transaction, with ids and labels only', async () => {
    const before = (await auditRows(h, owner.tenantId!, 'routing.')).length;
    const r = await create({ name: 'Audited', strategy: 'round_robin', members: [{ userId: a1.userId, weight: 2 }] });
    await call(owner, 'PUT', `/routing-rules/${r.body.rule.id}/members`, [{ userId: a2.userId, weight: 5 }]);
    const cur = (await rules()).find((x) => x.id === r.body.rule.id)!;
    await call(owner, 'PATCH', `/routing-rules/${cur.id}`, { maxOffers: 2, version: cur.version });
    expect((await call(owner, 'PUT', '/routing-rules/order', { ruleIds: [cur.id] })).status).toBe(200); // unchanged order: nothing to audit
    const other = await create({ name: 'Other', strategy: 'pond', targetPondId: defaultPondId });
    await call(owner, 'PUT', '/routing-rules/order', { ruleIds: [other.body.rule.id, cur.id] });
    await call(owner, 'DELETE', `/routing-rules/${cur.id}`);
    const rows = (await auditRows(h, owner.tenantId!, 'routing.')).slice(before).filter((x) => x.entity_id !== other.body.rule.id);
    expect(rows.map((x) => x.reason)).toEqual(['CREATED', 'MEMBERS_SET', 'UPDATED', 'REORDERED', 'ARCHIVED']);
    expect(rows[3]!.changes).toEqual({ rule_ids: { from: [cur.id, other.body.rule.id], to: [other.body.rule.id, cur.id] } });
    await archiveAll();
    expect(rows[1]!.changes).toEqual({
      member_user_ids: { from: [a1.userId], to: [a2.userId] },
      member_weight_codes: { from: [`${a1.userId}=2`], to: [`${a2.userId}=5`] },
    });
    expect(rows[2]!.changes).toEqual({ max_offers: { from: null, to: 2 } });
    for (const x of rows) expect(x.actor_user_id).toBe(owner.userId);
  });
});
