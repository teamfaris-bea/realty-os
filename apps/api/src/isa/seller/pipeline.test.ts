// The one comps pipeline, compsForSubjectInTx (ISA-3 scope 3; R-ISA-18, R-CMA-6, R-CMA-7; E534, E538). Read-only: run in a
// READ ONLY transaction with the cma_reports count unchanged. On behalf of the lead's owner only (canAsRole). V1's
// readiness output is byte-identical under the default use.
import { sql } from 'kysely';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../../auth/testHarness.js';
import { systemActor } from '../../worker/systemActor.js';
import { clientReadiness, compsForSubjectInTx, readinessConnections } from './cmaSeam.js';
import { type SellerLead, type SellerWorld, nowInstant, sellerLead, sellerWorld, withSellerPacksCleared } from './testing.js';

let h: ApiHarness;
let w: SellerWorld;
let l: SellerLead;

beforeAll(async () => {
  h = await createApiHarness();
  w = await sellerWorld(h);
  l = await sellerLead(h, w);
});
afterAll(async () => {
  await h?.close();
});

const reports = async () => Number((await h.su.query('SELECT count(*) AS n FROM cma_reports')).rows[0].n);
const runAs = (via: 'assistant' | 'worker', userId = w.agents[0]!.userId!) =>
  withTenantTx(systemActor(w.tenantId, via), async (tx) => {
    await sql`SET LOCAL transaction_read_only = on`.execute(tx);
    return compsForSubjectInTx(tx, systemActor(w.tenantId, via), nowInstant(), { kind: 'contact_address', contactAddressId: l.addressId }, { contactId: l.id, onBehalfOf: { userId } });
  }, { db: h.database });

describe('compsForSubjectInTx (R-ISA-18)', () => {
  it('R-ISA-18 R-CMA-7: read-only in a READ ONLY transaction, no cma_reports row; with the default packs readiness lists PLATFORM_NOT_CLEARED (the D11 state)', async () => {
    const before = await reports();
    const r = await runAs('assistant');
    expect(r.ok).toBe(true);
    const ok = r as Extract<typeof r, { ok: true }>;
    expect(ok.result.comps.length).toBeGreaterThanOrEqual(3);
    expect(ok.record?.listingId).toBe(l.recordId);
    expect(ok.readiness.share.blockers.map((b) => b.code)).toEqual(['PLATFORM_NOT_CLEARED']);
    expect(await reports()).toBe(before);
  });

  it('E534 D11: platform:avm recorded with platform:cma unreviewed still gives PLATFORM_NOT_CLEARED', async () => {
    const r = await withSellerPacksCleared(h, () => runAs('assistant'), ['platform:avm', 'platform:ai_isa_seller_data']);
    expect((r as Extract<typeof r, { ok: true }>).readiness.share.blockers.map((b) => b.code)).toEqual(['PLATFORM_NOT_CLEARED']);
  });

  it('R-ISA-18: only the assistant may run it (SELLER_FACTS_NOT_ALLOWED via worker)', async () => {
    expect(await runAs('worker')).toMatchObject({ ok: false, code: 'SELLER_FACTS_NOT_ALLOWED' });
  });

  it('E538 R-CMA-6: on behalf of someone who does not own the contact, a role of isa or a suspended membership: CMA_SCOPE_LOST', async () => {
    expect(await runAs('assistant', w.agents[1]!.userId!)).toMatchObject({ ok: false, code: 'CMA_SCOPE_LOST' });
    const u = w.agents[0]!.userId!;
    for (const change of [`role = 'isa'`, `status = 'suspended'`]) {
      await h.su.query(`SET session_replication_role = replica; UPDATE memberships SET ${change} WHERE user_id = '${u}' AND tenant_id = '${w.tenantId}'; SET session_replication_role = origin`);
      try {
        expect(await runAs('assistant')).toMatchObject({ ok: false, code: 'CMA_SCOPE_LOST' });
      } finally {
        await h.su.query(`SET session_replication_role = replica; UPDATE memberships SET role = 'agent', status = 'active' WHERE user_id = '${u}' AND tenant_id = '${w.tenantId}'; SET session_replication_role = origin`);
      }
    }
  });

  it('R-CMA-7: the default use is byte-identical to use client_cma; ai_isa adds the seller-data pack and its own sentences', async () => {
    const out = await withTenantTx(systemActor(w.tenantId, 'assistant'), async (tx) => {
      const now = nowInstant();
      const base = { conns: await readinessConnections(tx, now), now, state: 'CA', addressKey: null, addressLine: null, subjectMlsListingId: null, compSales: [], readConnectionIds: [], nearMatchDismissed: [], hasValue: false };
      return { plain: await clientReadiness(tx, base), client: await clientReadiness(tx, { ...base, use: 'client_cma' }), isa: await clientReadiness(tx, { ...base, use: 'ai_isa' }) };
    }, { db: h.database });
    expect(JSON.stringify(out.plain)).toBe(JSON.stringify(out.client));
    expect(out.plain.share.blockers.find((b) => b.code === 'NO_VALUE')!.sentence).toBe('There is no value: not enough comparable sales.');
    expect(out.isa.share.blockers.find((b) => b.code === 'NO_VALUE')!.sentence).toBe('Not enough comparable recent sales to send.');
    expect(out.isa.share.blockers.find((b) => b.code === 'PLATFORM_NOT_CLEARED')!.sentence).toMatch(/platform:ai_isa_seller_data/);
    expect(out.plain.share.blockers.find((b) => b.code === 'PLATFORM_NOT_CLEARED')!.sentence).not.toMatch(/ai_isa/);
  });
});
