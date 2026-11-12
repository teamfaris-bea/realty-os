// Adversarial cases for the homeowner-profile lane (D10): tenancy, opt-outs (R-PAR-12 included), autonomy and the
// lane's own risk rules (person-level data, owner names, the protected-proxy rule). Real Postgres, the fake only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { call } from '../leads/testing.js';
import { FakePublicRecords } from '../predict/provider.js';
import { type WorkspaceWorld, workspaceWorld } from '../workspace/testing.js';
import { countyRecord, homeowner, profileOf, refresh, sideEffects } from './testing.js';

let h: ApiHarness;
let a: WorkspaceWorld;
let b: WorkspaceWorld;
const fake = () => {
  const f = new FakePublicRecords();
  f.today = () => new Date().toISOString().slice(0, 10);
  return f;
};

beforeAll(async () => {
  h = await createApiHarness();
  a = await workspaceWorld(h, { agents: 2 });
  b = await workspaceWorld(h, { agents: 1 });
}, 240_000);
afterAll(async () => {
  await h?.close();
});

/** Every text value the homeowner tables and the rows a pass could touch hold for a tenant. */
async function storedText(tenantId: string): Promise<string> {
  const rows = await h.su.query(
    `SELECT row_to_json(p)::text AS t FROM homeowner_profiles p WHERE tenant_id = $1
     UNION ALL SELECT row_to_json(f)::text FROM homeowner_profile_facts f WHERE tenant_id = $1
     UNION ALL SELECT row_to_json(x)::text FROM audit_log x WHERE tenant_id = $1
     UNION ALL SELECT row_to_json(j)::text FROM jobs j WHERE tenant_id = $1`, [tenantId]);
  return rows.rows.map((r) => r.t).join('\n');
}

describe('homeowner lane: adversarial (R-HOME-1, R-HOME-3, R-HOME-6, R-HOME-7, R-HOME-8)', () => {
  it('R-HOME-3 E580: a hostile county payload stores only the closed field list: no co-owner, age, phone, lender, instruments or other owners\' addresses; owner names are stored, hashed or logged nowhere', async () => {
    const records = fake();
    const secret = `ZQX${randomUUID().slice(0, 6).toUpperCase()}`;
    const c = await homeowner(h, a, a.agents[0]!, records, {
      owners: (f) => [`${f.toUpperCase()} DOE & ${secret} COOWNER`, `${secret} SECOND`],
      record: {
        extra: { ownerAge: 71, phone: '+15555550111', lender: `${secret} BANK`, instruments: [{ book: 9, page: 9 }], coOwnerAddresses: [`9 ${secret} ROAD`] },
        homeowner: { owner_age: 71, loan_balance_cents: 1, equity_cents: 2, lender: `${secret} BANK`, owner_mailing_address: `PO BOX 7‮${secret}` },
      },
    });
    await refresh(h, a.tenantId, { publicRecords: records });
    const { profile, facts } = await profileOf(h, c.addressId);
    expect(profile.status).toBe('matched');
    expect(facts.map((f) => f.field).sort()).toEqual(['last_transfer_date', 'last_transfer_price_cents']);
    const text = await storedText(a.tenantId);
    expect(text).not.toContain(secret);
    expect(text).not.toMatch(/5555550111|"book"|\b71\b/);
  });

  it('R-HOME-3: an owner name that only resembles the contact (an entity, a reordered name with an extra word) never attaches', async () => {
    const records = fake();
    const llc = await homeowner(h, a, a.agents[0]!, records, { owners: (f) => [`${f.toUpperCase()} DOE LLC`] });
    const extra = await homeowner(h, a, a.agents[0]!, records, { owners: (f) => [`DOE, ${f.toUpperCase()} J`] });
    const reordered = await homeowner(h, a, a.agents[0]!, records, { owners: (f) => [`DOE, ${f.toUpperCase()}`] });
    await refresh(h, a.tenantId, { publicRecords: records });
    expect((await profileOf(h, llc.addressId)).profile.match_detail).toBe('missing_data');
    expect((await profileOf(h, extra.addressId)).profile.match_detail).toBe('owner_name_mismatch');
    expect((await profileOf(h, reordered.addressId)).profile.status).toBe('matched');
    for (const x of [llc, extra]) expect((await profileOf(h, x.addressId)).facts).toEqual([]);
  });

  it('R-HOME-1 E561: a protected-proxy tag never recognises a homeowner, even when it is named like the homeowner tag key', async () => {
    const records = fake();
    const c = await homeowner(h, b, b.agents[0]!, records, { reason: 'homeowner_tag' });
    await h.su.query(`UPDATE tags SET protected_proxy = true WHERE tenant_id = $1 AND name_key = 'homeowner'`, [b.tenantId]);
    // (protection only tightens: tenant b keeps the protected tag for the rest of this file)
    await refresh(h, b.tenantId, { publicRecords: records });
    expect((await profileOf(h, c.addressId)).profile).toBeNull();
    expect(records.homeownerCalls).toEqual([]);
  });

  it('R-HOME-1 R-HOME-9 R-PAR-12 R-CHAN-3 E568: a person-level do-not-contact is never looked up and gets no profile; a STOP on a phone changes nothing here because nothing is ever sent', async () => {
    const records = fake();
    const dnc = await homeowner(h, a, a.agents[0]!, records);
    const r = await call(a.agents[0]!, 'POST', `/contacts/${dnc.id}/do-not-contact`, { reason: 'other' });
    expect(r.status).toBe(200);
    const before = await sideEffects(h, a.tenantId);
    const calls = records.homeownerCalls.length;
    await refresh(h, a.tenantId, { publicRecords: records });
    expect(records.homeownerCalls.slice(calls).some((x) => x.startsWith(dnc.address.line1.toLowerCase().replace('lane', 'ln')))).toBe(false);
    expect((await profileOf(h, dnc.addressId)).profile).toBeNull();
    const after = await sideEffects(h, a.tenantId);
    expect({ ...after, contactsChanged: 0 }).toEqual({ ...before, contactsChanged: 0 });
  });

  it('R-HOME-2 R-INT-1: the adapter receives one postal address and nothing else (the fake refuses any other key; its log holds addresses only)', async () => {
    const records = fake();
    const c = await homeowner(h, a, a.agents[1]!, records);
    await refresh(h, a.tenantId, { publicRecords: records });
    for (const k of records.homeownerCalls) expect(k).toMatch(/^[a-z0-9 ]+\|[a-z0-9 ]*\|[a-z ]+\|sc\|\d{5}$/);
    expect(records.homeownerCalls.join('\n')).not.toMatch(new RegExp(`${c.first}|${c.id}|${a.tenantId}`, 'i'));
  });

  it('R-TEN-1 R-HOME-7 E585 E589: another tenant\'s Owner and another agent get 404; the panel route never accepts a tenant id', async () => {
    const records = fake();
    const c = await homeowner(h, a, a.agents[0]!, records);
    await refresh(h, a.tenantId, { publicRecords: records });
    expect((await call(b.owner, 'GET', `/contacts/${c.id}/homeowner`)).status).toBe(404);
    expect((await call(a.agents[1]!, 'GET', `/contacts/${c.id}/homeowner`)).status).toBe(404);
    expect((await call(a.agents[0]!, 'GET', `/contacts/${c.id}/homeowner?tenantId=${b.tenantId}`)).status).toBe(200);
    expect((await call(b.owner, 'GET', `/contacts/${c.id}/homeowner?tenantId=${a.tenantId}`)).status).toBe(404);
  });

  it('R-HOME-7 R-HOME-8: there is no write route: POST, PUT, PATCH and DELETE on the panel path do not exist', async () => {
    const c = await homeowner(h, a, a.agents[0]!, null);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const r = await call(a.agents[0]!, m, `/contacts/${c.id}/homeowner`, {});
      expect(r.status, m).toBe(404);
    }
  });

  it('R-HOME-6 R-OWN-1: a pass never changes ownership, stage, intent, tags or addresses', async () => {
    const records = fake();
    const c = await homeowner(h, a, a.agents[0]!, records);
    const snap = async () => JSON.stringify((await h.su.query(`SELECT c.ownership_state, c.owner_user_id, c.stage, c.intent, c.ownership_seq, (SELECT json_agg(row_to_json(x) ORDER BY x.id) FROM contact_addresses x WHERE x.contact_id = c.id) AS addrs FROM contacts c WHERE c.id = $1`, [c.id])).rows);
    const before = await snap();
    records.put(c.address, countyRecord(c.address, [`${c.first.toUpperCase()} DOE`], { homeowner: { owner_mailing_address: '1 ELSEWHERE RD, OTHERTOWN NY 10001' } }));
    await refresh(h, a.tenantId, { publicRecords: records });
    expect(await snap()).toBe(before);
  });
});
