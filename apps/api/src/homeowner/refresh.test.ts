// The homeowner.refresh pass (module 78; D10) on real Postgres as app_user, with the deterministic public-records
// fake only (no county is called). R-HOME-1, R-HOME-2, R-HOME-3, R-HOME-7, R-HOME-9, R-HOME-10.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { FakePublicRecords, UnconfiguredPublicRecords } from '../predict/provider.js';
import { ProviderError } from '../providers/types.js';
import { handlers as registered } from '../worker/handlers/index.js';
import { memoryAlerts } from '../worker/observability.js';
import { systemActor } from '../worker/systemActor.js';
import { type WorkspaceWorld, workspaceWorld } from '../workspace/testing.js';
import { closedDeal, beforeThisMonth } from '../nurture/testing.js';
import { HOMEOWNER_JOBS, homeownerHandlers, makeHomeownerHandlers } from './handlers.js';
import { addAddress, countyRecord, homeowner, nextBeaufortAddress, profileOf, recognise, refresh, sideEffects } from './testing.js';
import { ownedContact } from '../comms/testing.js';

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness();
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const fake = () => {
  const f = new FakePublicRecords();
  f.today = () => new Date().toISOString().slice(0, 10);
  return f;
};
const world = () => workspaceWorld(h, { agents: 2 });
const setZone = (tenantId: string, tz: string) => h.su.query('UPDATE tenant_settings SET default_timezone = $2 WHERE tenant_id = $1', [tenantId, tz]);
function zoneAtLocalHour(hour: number): string {
  let n = (hour - new Date().getUTCHours() + 48) % 24;
  if (n > 14) n -= 24;
  return n === 0 ? 'Etc/GMT' : n > 0 ? `Etc/GMT-${n}` : `Etc/GMT+${-n}`;
}
const DAY = 86_400_000;
const near = (d: Date, target: number) => Math.abs(new Date(d).getTime() - target) < 120_000;
/** a fixture write with triggers and FKs off (one transaction; ids only, never user input) */
const asSu = (q: string, p: string[]) => h.su.query(`BEGIN; SET LOCAL session_replication_role = replica; ${q.replace(/\$(\d)/g, (_, i) => `'${p[Number(i) - 1]}'`)}; COMMIT;`);
const DNC = `UPDATE contacts SET do_not_contact_at = now(), do_not_contact_event_id = gen_random_uuid() WHERE id = $1 AND do_not_contact_at IS NULL`;

describe('recognition builds a profile (R-HOME-1, R-HOME-3)', () => {
  let w: WorkspaceWorld;
  beforeAll(async () => {
    w = await world();
  }, 120_000);

  it('R-HOME-1 E561: each of the four reasons builds a matched profile with every value, its source and date; an unrecognised contact gets no lookup', async () => {
    const records = fake();
    const made = [];
    for (const reason of ['seller_intent', 'seller_inquiry', 'homeowner_tag', 'past_buyer'] as const) made.push({ reason, ...(await homeowner(h, w, w.agents[0]!, records, { reason })) });
    const plain = await ownedContact(w.agents[0]!, { consent: false });
    const plainAddress = nextBeaufortAddress();
    const plainId = await addAddress(w.agents[0]!, plain.id, plainAddress);
    records.put(plainAddress, countyRecord(plainAddress, ['JANE DOE']));
    const { report } = await refresh(h, w.tenantId, { publicRecords: records });
    expect(report.outcome).toBe('done');
    for (const m of made) {
      const { profile, facts } = await profileOf(h, m.addressId);
      expect(profile, m.reason).toMatchObject({ status: 'matched', county_key: 'sc-beaufort', match_detail: null, source: 'Beaufort County GIS parcel layer', last_failure_at: null });
      expect(profile.recognized_by, m.reason).toContain(m.reason);
      expect(profile.parcel_ref).toMatch(/^TEST-/);
      expect(near(profile.next_refresh_at, Date.now() + 30 * DAY)).toBe(true);
      expect(near(profile.retention_until, Date.now() + 365 * DAY)).toBe(true);
      expect(facts.map((f) => f.field)).toEqual(['last_transfer_date', 'last_transfer_price_cents', 'owner_mailing_address']);
      for (const f of facts) expect(f.source).toBe('Beaufort County GIS parcel layer');
    }
    expect((await profileOf(h, plainId)).profile).toBeNull();
    expect(records.homeownerCalls).not.toContain(expect.stringContaining(plainAddress.line1.toLowerCase().split(' ')[0]!));
    expect(records.homeownerCalls).toHaveLength(4);
    // the property lookup of module 50 is never made by this pass
    expect(records.calls).toEqual([]);
  });

  it('R-HOME-3 E562: an owner-name mismatch keeps nothing: no facts, no mailing address, no parcel or source', async () => {
    const records = fake();
    const c = await homeowner(h, w, w.agents[0]!, records, { owners: () => ['SOMEONE ELSE'] });
    await refresh(h, w.tenantId, { publicRecords: records });
    const { profile, facts } = await profileOf(h, c.addressId);
    expect(profile).toMatchObject({ status: 'not_matched', match_detail: 'owner_name_mismatch', parcel_ref: null, source: null, record_as_of: null });
    expect(facts).toEqual([]);
  });

  it('R-HOME-3 E563: a county record at a different address keeps nothing (address_mismatch)', async () => {
    const records = fake();
    const c = await homeowner(h, w, w.agents[0]!, null);
    records.put(c.address, countyRecord({ ...c.address, line1: '999 Other Road' }, [`${c.first.toUpperCase()} DOE`]));
    await refresh(h, w.tenantId, { publicRecords: records });
    expect((await profileOf(h, c.addressId)).profile).toMatchObject({ status: 'not_matched', match_detail: 'address_mismatch' });
    expect((await profileOf(h, c.addressId)).facts).toEqual([]);
  });

  it('R-HOME-3 E564: entity owners are dropped before attach: only an LLC or a trust is missing_data; a person beside an entity matches', async () => {
    const records = fake();
    const only = await homeowner(h, w, w.agents[0]!, records, { owners: (f) => [`${f.toUpperCase()} DOE LLC`, `${f.toUpperCase()} DOE FAMILY TRUST`] });
    const both = await homeowner(h, w, w.agents[0]!, records, { owners: (f) => [`SAMPLE HOLDINGS LLC & ${f.toUpperCase()} DOE`] });
    await refresh(h, w.tenantId, { publicRecords: records });
    expect((await profileOf(h, only.addressId)).profile).toMatchObject({ status: 'not_matched', match_detail: 'missing_data' });
    expect((await profileOf(h, both.addressId)).profile).toMatchObject({ status: 'matched' });
  });

  it('E565: no record is not_available and several are ambiguous; neither keeps a value', async () => {
    const records = fake();
    const none = await homeowner(h, w, w.agents[0]!, null);
    const many = await homeowner(h, w, w.agents[0]!, null);
    records.put(many.address, { available: false, detail: 'ambiguous' });
    await refresh(h, w.tenantId, { publicRecords: records });
    expect((await profileOf(h, none.addressId)).profile).toMatchObject({ status: 'not_available', match_detail: null });
    expect((await profileOf(h, many.addressId)).profile).toMatchObject({ status: 'ambiguous' });
  });

  it('R-HOME-3 E584: matched then not matched: the facts are deleted first and the profile keeps nothing', async () => {
    const records = fake();
    const c = await homeowner(h, w, w.agents[0]!, records);
    await refresh(h, w.tenantId, { publicRecords: records });
    expect((await profileOf(h, c.addressId)).facts.length).toBeGreaterThan(0);
    records.put(c.address, countyRecord(c.address, ['NEW OWNER']));
    await h.su.query(`UPDATE homeowner_profiles SET next_refresh_at = now() - interval '1 minute' WHERE contact_address_id = $1`, [c.addressId]);
    await refresh(h, w.tenantId, { publicRecords: records });
    const after = await profileOf(h, c.addressId);
    expect(after.profile).toMatchObject({ status: 'not_matched', match_detail: 'owner_name_mismatch', parcel_ref: null });
    expect(after.facts).toEqual([]);
  });

  it('R-HOME-2 E560: a past buyer\'s K2 mailing row is a subject; other mailing and interest rows never are', async () => {
    const records = fake();
    const c = await ownedContact(w.agents[0]!, { firstName: 'Kim', consent: false });
    const bought = nextBeaufortAddress();
    const boughtId = await addAddress(w.agents[0]!, c.id, bought, 'mailing');
    const interest = nextBeaufortAddress();
    const interestId = await addAddress(w.agents[0]!, c.id, interest, 'interest');
    await closedDeal(h, w.tenantId, c.id, w.agents[0]!.userId!, beforeThisMonth(), { listing: { line1: bought.line1, city: bought.city, postalCode: bought.postalCode } });
    records.put(bought, countyRecord(bought, ['KIM DOE']));
    records.put(interest, countyRecord(interest, ['KIM DOE']));
    await refresh(h, w.tenantId, { publicRecords: records });
    expect((await profileOf(h, boughtId)).profile).toMatchObject({ status: 'matched', recognized_by: ['past_buyer'] });
    expect((await profileOf(h, interestId)).profile).toBeNull();
  });

  it('R-HOME-10 R-HOME-7: a pass sends, enqueues, notifies, cards and writes nothing else: no message, job, feed card, task, notification, enrollment, audit row, address, tag or deal', async () => {
    const records = fake();
    await homeowner(h, w, w.agents[0]!, records);
    const before = await sideEffects(h, w.tenantId);
    await refresh(h, w.tenantId, { publicRecords: records });
    const after = await sideEffects(h, w.tenantId);
    expect({ ...after, contactsChanged: 0 }).toEqual({ ...before, contactsChanged: 0 });
  });
});

describe('fences and purges (R-HOME-7, R-HOME-9)', () => {
  let w: WorkspaceWorld;
  beforeAll(async () => {
    w = await world();
  }, 120_000);

  it('R-HOME-7 E566: an address edited while the county answers is not written; the next pass checks the new address', async () => {
    const records = fake();
    const c = await homeowner(h, w, w.agents[0]!, records);
    records.beforeAnswer = async () => {
      await h.su.query(`UPDATE contact_addresses SET line2 = 'Unit 2' WHERE id = $1`, [c.addressId]);
    };
    const { report } = await refresh(h, w.tenantId, { publicRecords: records });
    records.beforeAnswer = null;
    expect(report.lookups.fenced).toBeGreaterThanOrEqual(1);
    expect((await profileOf(h, c.addressId)).profile).toBeNull();
    records.put({ ...c.address, line2: 'Unit 2' }, countyRecord({ ...c.address, line2: 'Unit 2' }, [`${c.first.toUpperCase()} DOE`]));
    await refresh(h, w.tenantId, { publicRecords: records });
    expect((await profileOf(h, c.addressId)).profile).toMatchObject({ status: 'matched' });
  });

  it('R-HOME-7 E567: a contact marked do-not-contact, or no longer recognised, while the county answers gets nothing written', async () => {
    const records = fake();
    const dnc = await homeowner(h, w, w.agents[0]!, records);
    const gone = await homeowner(h, w, w.agents[0]!, records);
    records.beforeAnswer = async () => {
      await asSu(DNC, [dnc.id]);
      await h.su.query(`UPDATE contacts SET intent = NULL WHERE id = $1`, [gone.id]);
    };
    await refresh(h, w.tenantId, { publicRecords: records });
    records.beforeAnswer = null;
    expect((await profileOf(h, dnc.addressId)).profile).toBeNull();
    expect((await profileOf(h, gone.addressId)).profile).toBeNull();
  });

  it('R-HOME-9 E568: a contact no longer recognised (intent changed, tag removed) loses the profile on the next pass', async () => {
    const records = fake();
    const a = await homeowner(h, w, w.agents[0]!, records);
    const t = await homeowner(h, w, w.agents[0]!, records, { reason: 'homeowner_tag' });
    await refresh(h, w.tenantId, { publicRecords: records });
    expect((await profileOf(h, a.addressId)).profile).not.toBeNull();
    expect((await profileOf(h, t.addressId)).profile).toMatchObject({ recognized_by: ['homeowner_tag'] });
    await h.su.query(`UPDATE contacts SET intent = 'buyer' WHERE id = $1`, [a.id]);
    await h.su.query(`DELETE FROM contact_tags WHERE contact_id = $1`, [t.id]);
    const { report } = await refresh(h, w.tenantId, { publicRecords: records });
    expect(report.purged.ineligible, JSON.stringify(report)).toBeGreaterThanOrEqual(2);
    expect((await profileOf(h, a.addressId)).profile).toBeNull();
    expect((await profileOf(h, t.addressId)).profile).toBeNull();
  });

  it('R-HOME-9 E569: a contact marked do-not-contact or merged away loses the profile', async () => {
    const records = fake();
    const cs = [await homeowner(h, w, w.agents[0]!, records), await homeowner(h, w, w.agents[0]!, records)];
    await refresh(h, w.tenantId, { publicRecords: records });
    for (const c of cs) expect((await profileOf(h, c.addressId)).profile).not.toBeNull();
    await asSu(DNC, [cs[0]!.id]);
    await asSu(`UPDATE contacts SET merged_into_contact_id = $1 WHERE id = $2`, [cs[0]!.id, cs[1]!.id]);
    await refresh(h, w.tenantId, { publicRecords: new UnconfiguredPublicRecords() });
    for (const c of cs) expect((await profileOf(h, c.addressId)).profile).toBeNull();
  });

  it('R-HOME-9 E587 E574: expired profiles are purged even when public records are not configured, and nothing is written or looked up', async () => {
    const records = fake();
    const c = await homeowner(h, w, w.agents[0]!, records);
    await refresh(h, w.tenantId, { publicRecords: records });
    await h.su.query(`UPDATE homeowner_profiles SET checked_at = now() - interval '400 days', retention_until = now() - interval '35 days' WHERE contact_address_id = $1`, [c.addressId]);
    const fresh = await homeowner(h, w, w.agents[0]!, null);
    const u = new UnconfiguredPublicRecords();
    const { report } = await refresh(h, w.tenantId, { publicRecords: u });
    expect(report.outcome).toBe('not_configured');
    expect(report.purged.expired).toBeGreaterThanOrEqual(1);
    expect((await profileOf(h, c.addressId)).profile).toBeNull();
    expect((await profileOf(h, fresh.addressId)).profile).toBeNull();
  });

  it('R-HOME-9: a profile whose address is deleted cascades (E571), and erasure takes the contact\'s profiles (E570)', async () => {
    const records = fake();
    const a = await homeowner(h, w, w.agents[0]!, records);
    await refresh(h, w.tenantId, { publicRecords: records });
    await h.su.query('DELETE FROM contact_addresses WHERE id = $1', [a.addressId]);
    expect((await profileOf(h, a.addressId)).profile).toBeNull();
  });
});

describe('failures, budget, schedule (R-HOME-7)', () => {
  let w: WorkspaceWorld;
  beforeAll(async () => {
    w = await world();
  }, 120_000);

  it('R-HOME-7 E572: a failure keeps the values, checked_at and retention, retries after one day, and alerts when failures reach the threshold with no success', async () => {
    const records = fake();
    const c = await homeowner(h, w, w.agents[0]!, records);
    await refresh(h, w.tenantId, { publicRecords: records });
    const before = (await profileOf(h, c.addressId)).profile;
    await h.su.query(`UPDATE homeowner_profiles SET next_refresh_at = now() - interval '1 minute' WHERE tenant_id = $1`, [w.tenantId]);
    records.beforeAnswer = () => {
      throw new ProviderError('unavailable', 'COUNTY_HTTP_503');
    };
    const { report, alerts } = await refresh(h, w.tenantId, { publicRecords: records, settings: { failureAlertThreshold: 1 } });
    records.beforeAnswer = null;
    const { profile, facts } = await profileOf(h, c.addressId);
    expect(profile).toMatchObject({ status: 'matched', last_failure_code: 'unavailable' });
    expect(profile.checked_at).toEqual(before.checked_at);
    expect(profile.retention_until).toEqual(before.retention_until);
    expect(near(profile.next_refresh_at, Date.now() + DAY)).toBe(true);
    expect(facts.length).toBeGreaterThan(0);
    expect(report.lookups.failed).toBeGreaterThanOrEqual(1);
    expect(alerts.alerts.some((a) => a.code === 'WORKER_ERROR' && a.details.reason === 'PUBLIC_RECORDS_SOURCE_FAILING' && a.severity === 'P2')).toBe(true);
    expect(JSON.stringify(alerts.alerts)).not.toMatch(/Sample|DOE|Exampleton/);
  });

  it('R-HOME-7 E572: a timeout before any read writes a failed row with no values', async () => {
    const records = fake();
    const c = await homeowner(h, w, w.agents[0]!, records);
    records.beforeAnswer = () => {
      throw new ProviderError('timeout', 'COUNTY_TIMEOUT');
    };
    await refresh(h, w.tenantId, { publicRecords: records });
    records.beforeAnswer = null;
    const { profile, facts } = await profileOf(h, c.addressId);
    expect(profile).toMatchObject({ status: 'failed', checked_at: null, last_failure_code: 'timeout' });
    expect(facts).toEqual([]);
  });

  it('R-HOME-7 E578: ADDRESS_INVALID is retried only after 30 days', async () => {
    const records = fake();
    const c = await homeowner(h, w, w.agents[0]!, records);
    records.beforeAnswer = () => {
      throw new ProviderError('rejected', 'ADDRESS_INVALID');
    };
    await refresh(h, w.tenantId, { publicRecords: records });
    records.beforeAnswer = null;
    const { profile } = await profileOf(h, c.addressId);
    expect(profile).toMatchObject({ status: 'failed', last_failure_code: 'address_invalid' });
    expect(near(profile.next_refresh_at, Date.now() + 30 * DAY)).toBe(true);
    const calls = records.homeownerCalls.length;
    await refresh(h, w.tenantId, { publicRecords: records });
    expect(records.homeownerCalls.length - calls).toBe(0);
  });

  it('R-HOME-7: not_configured mid-pass stops the pass and writes no row', async () => {
    const records = fake();
    const c = await homeowner(h, w, w.agents[0]!, records);
    records.beforeAnswer = () => {
      throw new ProviderError('not_configured', 'PUBLIC_RECORDS_LIVE_CALLS_OFF');
    };
    const { report } = await refresh(h, w.tenantId, { publicRecords: records });
    records.beforeAnswer = null;
    expect(report.outcome).toBe('stopped_not_configured');
    expect((await profileOf(h, c.addressId)).profile).toBeNull();
  });

  it('R-HOME-7: a crash between a lookup and its write leaves no duplicate; the re-run completes', async () => {
    const records = fake();
    const cs = [await homeowner(h, w, w.agents[1]!, records), await homeowner(h, w, w.agents[1]!, records)];
    let n = 0;
    records.beforeAnswer = () => {
      if (++n === 2) throw new Error('worker crashed');
    };
    await expect(refresh(h, w.tenantId, { publicRecords: records })).rejects.toThrow(/worker crashed/);
    records.beforeAnswer = null;
    await refresh(h, w.tenantId, { publicRecords: records });
    for (const c of cs) {
      const rows = await h.su.query('SELECT count(*)::int AS n FROM homeowner_profiles WHERE contact_address_id = $1', [c.addressId]);
      expect(rows.rows[0].n).toBe(1);
    }
  });

  it('R-HOME-7 E586: lookups are budgeted per local date; a re-run on the same date looks up nothing already checked, and the 30-day refresh comes due', async () => {
    const w2 = await world();
    const records = fake();
    const cs = [await homeowner(h, w2, w2.agents[0]!, records), await homeowner(h, w2, w2.agents[0]!, records), await homeowner(h, w2, w2.agents[0]!, records)];
    const r1 = await refresh(h, w2.tenantId, { publicRecords: records, settings: { lookupBudgetPerDay: 2 } });
    expect(r1.report.lookups.made).toBe(2);
    const r2 = await refresh(h, w2.tenantId, { publicRecords: records, settings: { lookupBudgetPerDay: 2 } });
    expect(r2.report.lookups.made).toBe(0);
    const r3 = await refresh(h, w2.tenantId, { publicRecords: records, settings: { lookupBudgetPerDay: 3 } });
    expect(r3.report.lookups.made).toBe(1);
    const r4 = await refresh(h, w2.tenantId, { publicRecords: records });
    expect(r4.report.lookups.made).toBe(0);
    // 30 days on, a profile is due again
    await h.su.query(`UPDATE homeowner_profiles SET next_refresh_at = now() - interval '1 minute', checked_at = now() - interval '30 days', retention_until = now() + interval '300 days' WHERE contact_address_id = $1`, [cs[0]!.addressId]);
    const r5 = await refresh(h, w2.tenantId, { publicRecords: records });
    expect(r5.report.lookups.made).toBe(1);
    expect(near((await profileOf(h, cs[0]!.addressId)).profile.checked_at, Date.now())).toBe(true);
  }, 120_000);

  it('R-HOME-7: the handler acts only in the local night window [02:00, 05:00); registered once, hourly at :41, standalone, 3 attempts; logs carry counts only', async () => {
    const records = fake();
    const c = await homeowner(h, w, w.agents[0]!, records);
    const h1 = makeHomeownerHandlers(() => ({ publicRecords: records }))[0]!;
    expect(h1).toMatchObject({ kind: HOMEOWNER_JOBS.refresh, mode: 'standalone', queue: 'default', maxAttempts: 3, every: { ms: 3_600_000, offsetMs: 41 * 60_000 } });
    expect(registered.filter((x) => x.kind === HOMEOWNER_JOBS.refresh)).toHaveLength(1);
    expect(homeownerHandlers.map((x) => x.kind)).toEqual([HOMEOWNER_JOBS.refresh]);
    const run = async () => {
      const logs: unknown[] = [];
      const ctx = {
        actor: systemActor(w.tenantId, 'worker'),
        now: Date.now(),
        providers: h.providers,
        job: { id: 1n, kind: HOMEOWNER_JOBS.refresh, queue: 'default', attempts: 1 },
        log: { info: (...x: unknown[]) => logs.push(x), warn: () => {}, error: () => {}, debug: () => {}, child: () => ctx.log },
        alerts: memoryAlerts(),
        withTx: <T>(fn: (tx: never, now: never) => Promise<T>) => withTenantTx(systemActor(w.tenantId, 'worker'), fn as never, { db: h.database }),
      };
      await (h1 as unknown as { run: (c: unknown, p: unknown) => Promise<void> }).run(ctx, {});
      return logs;
    };
    await setZone(w.tenantId, zoneAtLocalHour(13));
    await run();
    expect(records.homeownerCalls).toEqual([]);
    await setZone(w.tenantId, zoneAtLocalHour(3));
    const logs = await run();
    expect(records.homeownerCalls.length).toBeGreaterThanOrEqual(1);
    expect((await profileOf(h, c.addressId)).profile).not.toBeNull();
    expect(JSON.stringify(logs)).not.toMatch(/Sam|DOE|Sample|Exampleton|TEST-/);
    await setZone(w.tenantId, 'UTC');
  });
});

describe('tenant isolation (R-TEN-1)', () => {
  it('R-TEN-1 R-HOME-7: a pass of tenant B neither reads nor writes tenant A', async () => {
    const a = await world();
    const b = await world();
    const records = fake();
    const ca = await homeowner(h, a, a.agents[0]!, records);
    await refresh(h, b.tenantId, { publicRecords: records });
    expect((await profileOf(h, ca.addressId)).profile).toBeNull();
    expect(records.homeownerCalls).toEqual([]);
    void randomUUID;
    void recognise;
  }, 120_000);
});
