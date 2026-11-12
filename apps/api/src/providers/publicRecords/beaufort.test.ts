// The Beaufort County connector against a MOCK county (synthetic fixtures only; no county host is ever called).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config.js';
import { FakePublicRecords, PUBLIC_RECORDS_TEST_TEXT, UnconfiguredPublicRecords, parsePublicRecord } from '../../predict/provider.js';
import { createProviders } from '../index.js';
import { ProviderError } from '../types.js';
import { BEAUFORT_STATUS_OFF, BeaufortGisRecords, addressWhere, streetParts } from './beaufort.js';
import { BEAUFORT_SOURCE } from './fields.js';
import { CountyConfigError, CountyRateLimiter, checkCountyBaseUrl } from './http.js';
import { manualClock, mockCounty, type MockAnswer } from './testing.js';

const HOME = { line1: '10 Sample Lane', line2: null, city: 'Exampleton', region: 'SC', postalCode: '29902' };
const HOSTS = ['gis.beaufortcountysc.gov'];

function live(answers: Record<string, MockAnswer[]> = {}, extra: Partial<ConstructorParameters<typeof BeaufortGisRecords>[0]> = {}) {
  const m = mockCounty({ allowCalls: true, answers });
  const c = manualClock();
  const p = new BeaufortGisRecords({ liveCalls: true, allowedHosts: HOSTS, clock: c.clock, sleep: c.sleep, fetch: m.fetch, ...extra });
  return { p, m, c };
}
const rejection = async (pr: Promise<unknown>) => {
  try {
    await pr;
  } catch (e) {
    return e instanceof ProviderError ? `${e.kind}:${e.providerCode}` : String(e);
  }
  return 'resolved';
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Beaufort connector: live calls off (R-HOME-10)', () => {
  it('R-HOME-10 E573: with live calls off it builds no request and throws not_configured; the status says lookups are off', async () => {
    const m = mockCounty();
    const c = manualClock();
    const p = new BeaufortGisRecords({ liveCalls: false, clock: c.clock, fetch: m.fetch });
    expect(p.configured).toBe(false);
    expect(p.statusText).toBe(BEAUFORT_STATUS_OFF);
    expect(await rejection(p.lookupHomeowner(HOME))).toBe('not_configured:PUBLIC_RECORDS_LIVE_CALLS_OFF');
    expect(await rejection(p.lookupHomeowner({ ...HOME, line1: "1' OR '1'='1" }))).toBe('not_configured:PUBLIC_RECORDS_LIVE_CALLS_OFF');
    expect(m.calls).toEqual([]);
    expect(p.requests).toBe(0);
  });

  it('R-HOME-10: the mock county refuses any call while PUBLIC_RECORDS_LIVE_CALLS is unset (a full run makes zero outbound requests)', async () => {
    expect(process.env.PUBLIC_RECORDS_LIVE_CALLS ?? '').not.toBe('true');
    const m = mockCounty();
    await expect(m.fetch('https://gis.beaufortcountysc.gov/x', { method: 'GET', headers: {}, redirect: 'manual', signal: new AbortController().signal })).rejects.toThrow(/PUBLIC_RECORDS_LIVE_CALLS is off/);
  });

  it('R-HOME-2 R-HOME-10 R-PRED-2 E588: the property lookup (module 50) is never served by the county connector and makes no request, live or not', async () => {
    for (const liveCalls of [false, true]) {
      const m = mockCounty({ allowCalls: true });
      const p = new BeaufortGisRecords({ liveCalls, allowedHosts: HOSTS, clock: manualClock().clock, fetch: m.fetch });
      expect(await rejection(p.lookup())).toBe('not_configured:PUBLIC_RECORDS_PROPERTY_LOOKUP_OFF');
      expect(m.calls).toEqual([]);
    }
  });
});

describe('Beaufort connector: host and URL checks (R-HOME-10, R-INT-1)', () => {
  it('R-HOME-10: service URLs must be https on the default port without credentials, query or fragment, on a listed host', () => {
    expect(checkCountyBaseUrl('https://gis.beaufortcountysc.gov/server/rest/services', HOSTS)).toBe('https://gis.beaufortcountysc.gov/server/rest/services');
    for (const bad of ['http://gis.beaufortcountysc.gov/s', 'https://gis.beaufortcountysc.gov:8443/s', 'https://u:p@gis.beaufortcountysc.gov/s', 'https://gis.beaufortcountysc.gov/s?x=1', 'https://gis.beaufortcountysc.gov/s#f', 'https://evil.example/s', 'not a url']) {
      expect(() => checkCountyBaseUrl(bad, HOSTS), bad).toThrow(CountyConfigError);
    }
  });

  it('R-HOME-10: the connector refuses to build (start-up) when its host is not on PUBLIC_RECORDS_ALLOWED_HOSTS', () => {
    expect(() => new BeaufortGisRecords({ liveCalls: false, allowedHosts: ['gis.example.org'], clock: manualClock().clock })).toThrow(CountyConfigError);
  });

  it('R-HOME-10 R-INT-1: config: fake by default, live calls false by default everywhere; a bad switch value or a non-public host refuses start-up naming the key, never the value', () => {
    const base = { DATABASE_URL: 'postgres://app_user:pw@db/realty', KEK_BASE64: Buffer.alloc(32, 1).toString('base64'), SESSION_SECRET_BASE64: Buffer.alloc(32, 2).toString('base64') };
    const c = loadConfig(base);
    expect(c.publicRecords).toEqual({ provider: 'fake', liveCalls: false, allowedHosts: ['gis.beaufortcountysc.gov'] });
    expect(loadConfig({ ...base, PUBLIC_RECORDS_PROVIDER: 'county' }).publicRecords.liveCalls).toBe(false);
    expect(() => loadConfig({ ...base, PUBLIC_RECORDS_LIVE_CALLS: 'yes-please' })).toThrow(/PUBLIC_RECORDS_LIVE_CALLS must be true or false/);
    try {
      loadConfig({ ...base, PUBLIC_RECORDS_LIVE_CALLS: 'yes-please' });
    } catch (e) {
      expect(String(e)).not.toContain('yes-please');
    }
    expect(() => loadConfig({ ...base, PUBLIC_RECORDS_ALLOWED_HOSTS: 'localhost' })).toThrow(/PUBLIC_RECORDS_ALLOWED_HOSTS/);
    expect(() => loadConfig({ ...base, PUBLIC_RECORDS_PROVIDER: 'scraper' })).toThrow(/PUBLIC_RECORDS_PROVIDER/);
  });

  it('R-HOME-10: providers: county builds the connector (live off by default, so not configured); otherwise the fake in dev', () => {
    const base = { DATABASE_URL: 'postgres://app_user:pw@db/realty', KEK_BASE64: Buffer.alloc(32, 1).toString('base64'), SESSION_SECRET_BASE64: Buffer.alloc(32, 2).toString('base64') };
    const clock = manualClock().clock;
    const county = createProviders(loadConfig({ ...base, PUBLIC_RECORDS_PROVIDER: 'county' }), { clock }).publicRecords;
    expect(county).toBeInstanceOf(BeaufortGisRecords);
    expect(county.configured).toBe(false);
    expect(createProviders(loadConfig(base), { clock }).publicRecords).toBeInstanceOf(FakePublicRecords);
  });
});

describe('Beaufort connector: requests (R-HOME-10)', () => {
  it('R-HOME-10: a unique match: GET only, no redirects, f=json, a generic User-Agent, two requests (the Gisfile step is off), the query strings', async () => {
    const { p, m } = live();
    const r = await p.lookupHomeowner(HOME);
    expect(m.calls).toHaveLength(2);
    for (const c of m.calls) {
      expect(c.method).toBe('GET');
      expect(c.redirect).toBe('manual');
      expect(c.headers['user-agent']).toBe('realty-os-public-records/1');
      expect(c.url.startsWith('https://gis.beaufortcountysc.gov/server/rest/services/')).toBe(true);
      expect(new URL(c.url).searchParams.get('f')).toBe('json');
      expect(c.url).not.toMatch(/Exampleton|29902/i);
    }
    expect(m.calls.map((c) => decodeURIComponent(c.url.replace(/\+/g, ' ')))).toMatchSnapshot();
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    expect(r.record.address).toEqual({ line1: '10 SAMPLE LN', line2: null, city: 'Exampleton', region: 'SC', postalCode: '29902' });
    expect(r.record.providerRef).toBe('TEST-0001');
    expect(r.record.ownerNames).toEqual(['SAMPLE OWNER A', 'SAMPLE HOLDINGS LLC']);
    expect(r.record.facts).toEqual({ owner_mailing_address: { value: 'PO BOX 1, EXAMPLETON SC 29902', source: BEAUFORT_SOURCE, asOf: null } });
    // the fixture's extra attributes (age, phone, lender) never pass the strict parser (E580)
    expect(JSON.stringify(r)).not.toMatch(/61|5555550100|SAMPLE BANK/);
  });

  it('R-HOME-10: with useGisfileTable the third request adds the sale date and price', async () => {
    const { p, m } = live({}, { useGisfileTable: true });
    const r = await p.lookupHomeowner(HOME);
    expect(m.calls).toHaveLength(3);
    expect(r.status === 'found' && r.record.facts.last_transfer_date).toEqual({ value: '2015-06-01', source: BEAUFORT_SOURCE, asOf: null });
    expect(r.status === 'found' && r.record.facts.last_transfer_price_cents?.value).toBe(25_000_000);
  });

  it('R-HOME-10 E565: zero address matches is no_record (one request); several are ambiguous; several parcels are ambiguous', async () => {
    const none = live({ Addresses: [{ fixture: 'address_none' }] });
    expect(await none.p.lookupHomeowner(HOME)).toEqual({ status: 'not_available', detail: 'no_record' });
    expect(none.m.calls).toHaveLength(1);
    const many = live({ Addresses: [{ fixture: 'address_multiple' }] });
    expect(await many.p.lookupHomeowner(HOME)).toEqual({ status: 'not_available', detail: 'ambiguous' });
    expect(many.m.calls).toHaveLength(1);
    const parcels = live({ EnerGov: [{ fixture: 'parcel_multiple' }] });
    expect(await parcels.p.lookupHomeowner(HOME)).toEqual({ status: 'not_available', detail: 'ambiguous' });
  });

  it('R-HOME-10 E578: an address whose tokens fail the strict patterns is ADDRESS_INVALID before any request; quotes never reach the query', async () => {
    for (const line1 of ['Sample Lane', '1234567 Sample Ln', `10 ${'Long'.repeat(20)} Ln`, '']) {
      const { p, m } = live();
      expect(await rejection(p.lookupHomeowner({ ...HOME, line1 })), line1).toMatch(/^rejected:ADDRESS_INVALID$/);
      expect(m.calls, line1).toEqual([]);
    }
    const parts = streetParts({ ...HOME, line1: "10 O'Brien St N", line2: 'Apt 4' });
    expect(parts).toMatchObject({ number: '10', name: 'O BRIEN', type: 'ST', postDirection: 'N', unit: '4' });
    const where = addressWhere(streetParts({ ...HOME, line1: "1' OR '1'='1 Sample Ln" }));
    expect(where).toMatchSnapshot();
    // only the delimiting quotes of each value remain
    expect(where.match(/'/g)!.length % 2).toBe(0);
    expect(where.replace(/= ''\)/g, '').match(/''/)).toBeNull();
    expect(where).toContain("STREETNAME = 'OR 1 1 SAMPLE'");
  });

  it('R-HOME-2 R-HOME-5 E575 E576 E577: a shared ZIP is tried at Beaufort; a Jasper ZIP or an address outside the table is not available with no request', async () => {
    const shared = live();
    expect((await shared.p.lookupHomeowner({ ...HOME, postalCode: '29910' })).status).toBe('found');
    expect(shared.m.calls.length).toBeGreaterThan(0);
    for (const a of [{ ...HOME, postalCode: '29936' }, { ...HOME, region: 'GA', postalCode: '31401' }]) {
      const x = live();
      expect(await x.p.lookupHomeowner(a)).toEqual({ status: 'not_available', detail: 'no_record' });
      expect(x.m.calls).toEqual([]);
    }
    const sc = live();
    expect((await sc.p.lookupHomeowner({ ...HOME, region: 'South Carolina' })).status).toBe('found');
  });
});

describe('Beaufort connector: failures (R-HOME-10; E572, E579)', () => {
  const cases: [string, MockAnswer, string][] = [
    ['an ArcGIS error at 200', { fixture: 'arcgis_error' }, 'unavailable:COUNTY_ARCGIS_ERROR'],
    ['a 5xx', { status: 503, body: 'busy' }, 'unavailable:COUNTY_HTTP_503'],
    ['a 4xx', { status: 404, body: 'nope' }, 'rejected:COUNTY_HTTP_404'],
    ['a redirect', { status: 302, headers: { location: 'https://evil.example/' } }, 'rejected:COUNTY_REDIRECT'],
    ['non-JSON', { body: '<html>maintenance</html>' }, 'unavailable:COUNTY_NOT_JSON'],
    ['a JSON array', { body: '[]' }, 'unavailable:COUNTY_NOT_JSON'],
    ['a declared oversize body', { body: '{}', headers: { 'content-length': String(3 * 1024 * 1024) } }, 'unavailable:COUNTY_RESPONSE_TOO_LARGE'],
    ['a streamed oversize body', { body: `{"features":[],"pad":"${'x'.repeat(3 * 1024 * 1024)}"}` }, 'unavailable:COUNTY_RESPONSE_TOO_LARGE'],
    ['a network error', { throws: new TypeError('fetch failed') }, 'unavailable:COUNTY_UNREACHABLE'],
  ];
  for (const [label, answer, expected] of cases) {
    it(`R-HOME-10 E572 E579: ${label} is ${expected}`, async () => {
      const { p } = live({ Addresses: [answer] });
      expect(await rejection(p.lookupHomeowner(HOME))).toBe(expected);
    });
  }

  it('R-HOME-10 E572: a hung county times out (the timeout is configurable; 15 s by default)', async () => {
    const { p } = live({ Addresses: [{ hang: true }] }, { timeoutMs: 20 });
    expect(await rejection(p.lookupHomeowner(HOME))).toBe('timeout:COUNTY_TIMEOUT');
  });

  it('R-HOME-10 R-TEN-7: nothing is logged and no error carries the address, an owner, the PIN or the payload', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    const errors: string[] = [];
    await live().p.lookupHomeowner(HOME);
    for (const a of [{ fixture: 'arcgis_error' } as MockAnswer, { status: 500 }, { body: 'x' }]) {
      try {
        await live({ EnerGov: [a] }).p.lookupHomeowner(HOME);
      } catch (e) {
        errors.push(String(e), JSON.stringify(e));
      }
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect(e).not.toMatch(/Sample|SAMPLE|TEST-0001|PO BOX|29902|Exampleton/i);
  });
});

describe('the county rate limiter (R-HOME-10)', () => {
  it('R-HOME-10: requests of one instance are at least 1000 ms apart across lookups (shared by all tenants)', async () => {
    const { p, m, c } = live();
    await p.lookupHomeowner(HOME);
    await p.lookupHomeowner(HOME);
    expect(m.calls).toHaveLength(4);
    expect(c.sleeps).toEqual([1000, 1000, 1000]);
  });

  it('R-HOME-10: no wait when the interval has already passed; waits are served in order', async () => {
    const c = manualClock();
    const l = new CountyRateLimiter(() => c.clock.now(), c.sleep, 1000);
    await l.acquire();
    c.advance(1500);
    await l.acquire();
    expect(c.sleeps).toEqual([]);
    await Promise.all([l.acquire(), l.acquire()]);
    expect(c.sleeps).toEqual([1000, 1000]);
  });
});

describe('module 50\'s fake and the shared interface (R-PRED-2)', () => {
  const PAYLOAD = {
    address: HOME, ownerNames: ['SAMPLE OWNER A'], source: 'County Assessor', providerRef: 'TEST-0001', lastSaleDate: '2015-06-01', assessedValueCents: 1,
    homeowner: { owner_mailing_address: 'PO BOX 1, EXAMPLETON SC 29902', annual_tax_cents: 123_400 },
  };

  it('R-PRED-2 E588: the property lookup drops the homeowner block; lookupHomeowner reads it from the same payload', async () => {
    const f = new FakePublicRecords();
    f.today = () => '2026-11-12';
    f.put(HOME, PAYLOAD);
    const prop = await f.lookup(HOME);
    expect(JSON.stringify(prop)).not.toMatch(/PO BOX|123400|homeowner/);
    expect(parsePublicRecord(PAYLOAD)).toEqual(prop);
    const h = await f.lookupHomeowner(HOME);
    expect(h.status === 'found' && h.record.facts).toEqual({
      owner_mailing_address: { value: 'PO BOX 1, EXAMPLETON SC 29902', source: 'County Assessor', asOf: null },
      annual_tax_cents: { value: 123_400, source: 'County Assessor', asOf: null },
    });
    expect(await f.lookupHomeowner({ ...HOME, line1: '11 Sample Lane' })).toEqual({ status: 'not_available', detail: 'no_record' });
  });

  // b11 api-ui/F5: the fake is configured, so only its test flag tells the panel that no county was asked.
  it('R-HOME-4 R-HOME-5: only the fake is a test source, and its status says no county was asked; the county connector and the stand-in are not', () => {
    const f = new FakePublicRecords();
    expect([f.configured, f.test, f.statusText]).toEqual([true, true, PUBLIC_RECORDS_TEST_TEXT]);
    expect(f.statusText).toMatch(/no county was asked/);
    expect(new UnconfiguredPublicRecords().test).toBe(false);
    expect(new BeaufortGisRecords({ liveCalls: false, allowedHosts: HOSTS, clock: manualClock().clock }).test).toBe(false);
    expect(live().p.test).toBe(false);
  });

  it('R-INT-1 E588: homeownerCalls holds normalized addresses only; any other key on the argument is refused', async () => {
    const f = new FakePublicRecords();
    await f.lookupHomeowner(HOME);
    expect(f.homeownerCalls).toEqual(['10 sample ln||exampleton|sc|29902']);
    expect(f.calls).toEqual([]);
    await expect(f.lookupHomeowner({ ...HOME, contactId: 'x' } as never)).rejects.toThrow(/only an address may be sent/);
  });

  it('R-HOME-6 E574: the unconfigured stand-in throws not_configured for both methods', async () => {
    const u = new UnconfiguredPublicRecords();
    expect(await rejection(u.lookupHomeowner())).toBe('not_configured:PUBLIC_RECORDS_NOT_CONFIGURED');
    expect(await rejection(u.lookup())).toBe('not_configured:PUBLIC_RECORDS_NOT_CONFIGURED');
  });
});
