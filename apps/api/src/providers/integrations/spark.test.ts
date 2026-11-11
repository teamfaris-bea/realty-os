// Read-only Spark RESO adapter against a mock Spark server only (R-INT-1). A network tripwire fails any
// real outbound call. Nothing here talks to Spark.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SPARK_PATHS, SparkConfigError, SparkError, SparkResoClient, SparkResoMlsFeed, type SparkOptions, checkSparkBaseUrl, decodeCursor, mediaOf, permissionGrantsRead, sanitizeRecord, toResoListing } from './spark.js';
import { CANARY_KEY_ID, CANARY_TOKEN, type MockSpark, REPLICATION_HOST, type Tripwire, installNetworkTripwire, liveProperty, liveSpark, mockSpark, property } from './spark.testing.js';

let wire: Tripwire;
beforeAll(() => {
  wire = installNetworkTripwire();
});
afterEach(() => {
  expect(wire.attempts).toEqual([]); // no test may reach the network
});
afterAll(() => wire.restore());

const BASE = 'https://sparkapi.com';
function make(m: MockSpark, o: Partial<SparkOptions> = {}) {
  const sleeps: number[] = [];
  const feed = new SparkResoMlsFeed({
    baseUrl: BASE,
    allowedHosts: ['sparkapi.com'],
    authScheme: 'Bearer',
    liveCalls: true,
    accessToken: CANARY_TOKEN,
    fetch: m.fetch,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    ...o,
  });
  return { feed, sleeps };
}
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SparkError);
    expect(String((e as Error).message)).not.toContain(CANARY_TOKEN);
    expect(JSON.stringify(e)).not.toContain(CANARY_TOKEN);
    return (e as SparkError).code;
  }
  return 'resolved';
}

describe('Spark adapter: read-only and allow-listed', () => {
  it('refuses every method but GET at the adapter layer, before any request', async () => {
    const m = mockSpark();
    const { feed } = make(m);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'get']) {
      expect(await codeOf(feed.client.request(method, `${BASE}/Reso/OData/Property`))).toBe('METHOD_NOT_ALLOWED');
    }
    expect(m.calls).toHaveLength(0);
    await feed.client.request('GET', `${BASE}/Reso/OData/Property?$top=1`);
    expect(m.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('only the allow-listed paths, exactly', async () => {
    const m = mockSpark();
    const { feed } = make(m);
    for (const p of ['/Reso/OData/Member', '/Reso/OData/Office', '/Reso/OData/OpenHouse', '/v1/listings', '/Reso/OData/Property/../Member', '/Reso/OData/Property/', '/reso/odata/property', '/Reso/OData/Property(%27x%27)']) {
      expect(await codeOf(feed.client.request('GET', `${BASE}${p}`)), p).toBe('PATH_NOT_ALLOWED');
    }
    expect(m.calls).toHaveLength(0);
    for (const p of SPARK_PATHS) await feed.client.request('GET', `${BASE}${p}`);
    expect(m.calls.map((c) => c.url.pathname)).toEqual([...SPARK_PATHS]);
  });

  it('https only, default port, no userinfo, host on the allow-list', async () => {
    const m = mockSpark();
    const { feed } = make(m);
    for (const u of ['http://sparkapi.com/Reso/OData/Property', 'https://sparkapi.com:8443/Reso/OData/Property', 'https://u:p@sparkapi.com/Reso/OData/Property', 'https://evil.example/Reso/OData/Property', 'https://sparkapi.com.evil.example/Reso/OData/Property', 'https://127.0.0.1/Reso/OData/Property']) {
      expect(await codeOf(feed.client.request('GET', u)), u).toBe('HOST_NOT_ALLOWED');
    }
    expect(m.calls).toHaveLength(0);
  });

  it('the base URL must be an allow-listed https origin (checked when the adapter is built)', () => {
    expect(checkSparkBaseUrl('https://sparkapi.com', ['sparkapi.com'])).toBe('https://sparkapi.com');
    for (const u of ['http://sparkapi.com', 'https://sparkapi.com:444', 'https://other.example', 'https://sparkapi.com/Reso', 'https://sparkapi.com?x=1', 'not a url']) {
      expect(() => checkSparkBaseUrl(u, ['sparkapi.com']), u).toThrow(SparkConfigError);
    }
  });

  it('sends the token only in the Authorization header with the configured scheme (VERIFY: Bearer or OAuth)', async () => {
    for (const authScheme of ['Bearer', 'OAuth'] as const) {
      const m = mockSpark();
      await make(m, { authScheme }).feed.probe();
      expect(m.calls[0]!.headers.authorization).toBe(`${authScheme} ${CANARY_TOKEN}`);
      expect(m.calls[0]!.url.href).not.toContain(CANARY_TOKEN);
    }
    expect(() => make(mockSpark(), { accessToken: 'has space in it 1234567' })).toThrow(SparkConfigError);
    try {
      make(mockSpark(), { accessToken: `${CANARY_TOKEN}\r\nx: y` });
    } catch (e) {
      expect(String(e)).not.toContain(CANARY_TOKEN);
    }
  });

  it('never follows a redirect: redirect is manual and any 3xx is REDIRECT_REFUSED (no retry)', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const m = mockSpark(() => ({ status, headers: { location: 'https://evil.example/steal' } }));
      expect(await codeOf(make(m).feed.changes(null, 10))).toBe('REDIRECT_REFUSED');
      expect(m.calls).toHaveLength(1);
      expect(m.calls[0]!.redirect).toBe('manual');
    }
  });

  it('a nextLink to another host or path is refused before it is fetched', async () => {
    for (const link of ['https://evil.example/Reso/OData/Property?$skip=1', 'http://sparkapi.com/Reso/OData/Property?$skip=1', 'https://sparkapi.com/Reso/OData/Member?$skip=1']) {
      const m = mockSpark(() => ({ status: 200, body: { value: [property(1)], '@odata.nextLink': link } }));
      expect(await codeOf(make(m).feed.changes(null, 10))).toMatch(/HOST_NOT_ALLOWED|PATH_NOT_ALLOWED/);
      expect(m.calls).toHaveLength(1);
    }
  });

  it('caps the response size and refuses a non-JSON body', async () => {
    const big = mockSpark(() => ({ status: 200, raw: 'x'.repeat(2048) }));
    expect(await codeOf(make(big, { maxBytes: 1024 }).feed.changes(null, 1))).toBe('BAD_RESPONSE');
    const declared = mockSpark(() => ({ status: 200, raw: '{"value":[]}', headers: { 'content-length': '99999999' } }));
    expect(await codeOf(make(declared, { maxBytes: 1024 }).feed.changes(null, 1))).toBe('BAD_RESPONSE');
    const html = mockSpark(() => ({ status: 200, raw: '<html>' }));
    expect(await codeOf(make(html).feed.changes(null, 1))).toBe('BAD_RESPONSE');
  });

  it('a network error or timeout is UNREACHABLE and never echoes the URL or token', async () => {
    const m = mockSpark(() => {
      throw new Error(`connect ECONNREFUSED ${BASE} ${CANARY_TOKEN}`);
    });
    expect(await codeOf(make(m, { retry: { attempts: 1 } }).feed.changes(null, 1))).toBe('UNREACHABLE');
    const slow = make(mockSpark(() => new Promise(() => undefined)), { timeoutMs: 20, retry: { attempts: 1 }, fetch: (url, init) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))) });
    expect(await codeOf(slow.feed.changes(null, 1))).toBe('UNREACHABLE');
  });
});

describe('Spark adapter: status mapping and backoff', () => {
  it('maps 401/403/404/429/5xx to stable codes', async () => {
    const cases: [number, string][] = [
      [401, 'INVALID_CREDENTIALS'],
      [403, 'NOT_LICENSED_OR_ROLE_INSUFFICIENT'],
      [404, 'NOT_FOUND'],
      [429, 'RATE_LIMITED'],
      [500, 'UNREACHABLE'],
      [502, 'UNREACHABLE'],
      [503, 'BUSY'],
      [400, 'BAD_RESPONSE'],
    ];
    for (const [status, code] of cases) {
      const m = mockSpark(() => ({ status, body: { error: { message: `secret detail ${CANARY_TOKEN}` } } }));
      expect(await codeOf(make(m, { retry: { attempts: 1 } }).feed.changes(null, 1)), String(status)).toBe(code);
    }
  });

  it('401/403/404 are not retried; 429 and 5xx back off with jitter and then succeed', async () => {
    for (const status of [401, 403, 404]) {
      const m = mockSpark(() => ({ status }));
      await codeOf(make(m).feed.changes(null, 1));
      expect(m.calls).toHaveLength(1);
    }
    let n = 0;
    const m = mockSpark(() => (++n <= 2 ? { status: n === 1 ? 429 : 503 } : { status: 200, body: { value: [property(1)] } }));
    const { feed, sleeps } = make(m, { retry: { baseDelayMs: 1000, maxDelayMs: 60_000 } });
    const page = await feed.changes(null, 10);
    expect(page.listings).toHaveLength(1);
    expect(m.calls).toHaveLength(3);
    // equal jitter with random()=0.5: backoff/2 + 0.5*backoff/2 = 0.75*backoff (1000, then 2000)
    expect(sleeps).toEqual([750, 1500]);
  });

  it('jitter stays within [backoff/2, backoff] and honours Retry-After up to the cap', async () => {
    for (const r of [0, 0.999]) {
      const m = mockSpark(() => ({ status: 503 }));
      const { feed, sleeps } = make(m, { random: () => r, retry: { attempts: 3, baseDelayMs: 1000 } });
      await codeOf(feed.changes(null, 1));
      expect(sleeps[0]).toBeGreaterThanOrEqual(500);
      expect(sleeps[0]).toBeLessThanOrEqual(1000);
    }
    const ra = mockSpark(() => ({ status: 429, headers: { 'retry-after': '7' } }));
    const a = make(ra, { retry: { attempts: 2, maxDelayMs: 60_000 } });
    await codeOf(a.feed.changes(null, 1));
    expect(a.sleeps).toEqual([7000]);
    const huge = mockSpark(() => ({ status: 429, headers: { 'retry-after': '86400' } }));
    const b = make(huge, { retry: { attempts: 2, maxDelayMs: 30_000 } });
    await codeOf(b.feed.changes(null, 1));
    expect(b.sleeps).toEqual([30_000]);
  });

  it('the retry budget is shared by every page of one operation and then gives up with the last code', async () => {
    const m = mockSpark(() => ({ status: 429 }));
    const { feed, sleeps } = make(m, { retry: { attempts: 10, budget: 3 } });
    expect(await codeOf(feed.changes(null, 5))).toBe('RATE_LIMITED');
    expect(m.calls).toHaveLength(4); // first try + 3 retries
    expect(sleeps).toHaveLength(3);
  });
});

describe('Spark adapter: paging and the ModificationTimestamp cursor', () => {
  /** A mock that serves `all` ordered by (ts, key), honouring $filter / $top, and pages with nextLink. */
  function feedServer(all: Record<string, unknown>[], pageSize: number) {
    const sorted = [...all].sort((a, b) => (`${a.ModificationTimestamp}|${a.ListingKey}` < `${b.ModificationTimestamp}|${b.ListingKey}` ? -1 : 1));
    return mockSpark((c) => {
      const p = c.url.searchParams;
      const skip = Number(p.get('$skip') ?? '0');
      let rows = sorted;
      const f = p.get('$filter');
      if (f) {
        const m = /^ModificationTimestamp gt (\S+) or \(ModificationTimestamp eq (\S+) and ListingKey gt '([^']*)'\)$/.exec(f);
        if (!m || m[1] !== m[2]) return { status: 400 };
        rows = rows.filter((r) => new Date(String(r.ModificationTimestamp)).toISOString() > m[1]! || (new Date(String(r.ModificationTimestamp)).toISOString() === m[1] && String(r.ListingKey) > m[3]!));
      }
      if (p.get('$orderby') !== 'ModificationTimestamp asc,ListingKey asc') return { status: 400 };
      const top = Number(p.get('$top'));
      const take = rows.slice(skip, skip + Math.min(top, pageSize));
      const rest = skip + take.length < Math.min(rows.length, top) ? `${BASE}/Reso/OData/Property?${new URLSearchParams({ ...Object.fromEntries(p), $skip: String(skip + take.length) }).toString()}` : undefined;
      return { status: 200, body: { value: take, ...(rest ? { '@odata.nextLink': rest } : {}) } };
    });
  }

  it('follows @odata.nextLink until the limit, and resumes from the cursor without gaps or repeats', async () => {
    // records 1..25 with several sharing a timestamp (ties broken by ListingKey)
    const all = Array.from({ length: 25 }, (_, i) => property(i + 1, { ModificationTimestamp: `2026-11-01T00:00:0${Math.floor(i / 6)}Z` }));
    const m = feedServer(all, 4);
    const { feed } = make(m);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page = await feed.changes(cursor, 7);
      seen.push(...page.listings.map((l) => l.listingKey));
      if (page.listings.length === 0) {
        expect(page.cursor).toBe(cursor);
        break;
      }
      cursor = page.cursor;
    }
    expect(seen).toEqual(all.map((r) => r.ListingKey));
    expect(m.calls.every((c) => c.method === 'GET' && c.url.host === 'sparkapi.com')).toBe(true);
    expect(m.calls.length).toBeGreaterThan(4); // paging happened inside changes()
    expect(decodeCursor(cursor!)).toEqual({ ts: '2026-11-01T00:00:04.000Z', key: 'LK0025' });
  });

  it('records missing a required field are skipped but still advance the cursor', async () => {
    const all = [property(1), property(2, { ListOfficeName: null }), property(3, { StandardStatus: 'Mystery' }), property(4, { ListPrice: -1 })];
    const { feed } = make(feedServer(all, 10));
    const page = await feed.changes(null, 10);
    expect(page.listings.map((l) => l.listingKey)).toEqual(['LK0001']);
    expect(page.skipped).toBe(3);
    expect(decodeCursor(page.cursor!).key).toBe('LK0004');
  });

  it('normalises into the existing ResoListing shape', () => {
    expect(toResoListing(property(7, { StandardStatus: 'Active Under Contract', ListPrice: '1,250,000.50', UnitNumber: '2B' }))).toEqual({
      listingKey: 'LK0007',
      listingId: 'MLS7',
      standardStatus: 'Pending',
      listPriceCents: 125_000_050,
      unparsedAddress: '107 Example St #2B',
      city: 'Exampleton',
      stateOrProvince: 'ZZ',
      postalCode: '00000',
      bedroomsTotal: 3,
      bathroomsTotalX10: 20,
      livingAreaSqft: 1500,
      propertyType: 'Residential',
      listOfficeName: 'Example Brokerage',
      modificationTimestamp: '2026-11-01T00:00:07.000Z',
    });
    expect(toResoListing(property(1, { ModificationTimestamp: '2026-11-01 00:00' }))).toBeNull();
  });

  it('a malformed cursor is refused, never sent', async () => {
    const m = mockSpark();
    const { feed } = make(m);
    for (const c of ['nope', "2026-11-01T00:00:00Z|x' or 1 eq 1", '|LK1']) expect(await codeOf(feed.changes(c, 1))).toBe('BAD_RESPONSE');
    expect(m.calls).toHaveLength(0);
  });

  it('media: $expand=Media on the Property request (no Media entity set), https photo URLs only, ordered; the licence pack stays the strictest placeholder', async () => {
    const m = mockSpark(() => ({ status: 200, body: { value: [{ ListingKey: 'LK0001', Media: [{ MediaURL: 'https://cdn.example/b.jpg', Order: 2, MimeType: 'image/jpeg' }, { MediaURL: 'http://insecure.example/a.jpg', Order: 1 }, { MediaURL: 'https://cdn.example/a.jpg', Order: '1' }] }] } }));
    const { feed } = make(m);
    expect((await feed.media('LK0001')).map((x) => x.url)).toEqual(['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg']);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.url.pathname).toBe('/Reso/OData/Property');
    expect(m.calls[0]!.url.searchParams.get('$filter')).toBe("ListingKey eq 'LK0001'");
    expect(m.calls[0]!.url.searchParams.get('$expand')).toBe('Media');
    expect(feed.describeLicense()).toMatchObject({ reviewed: false, rules: { displayToPublic: false, displayToClients: false } });
  });
});

describe('Spark adapter: MLS_LIVE_CALLS kill switch', () => {
  it('with live calls off nothing leaves the process, even with a token', async () => {
    const m = mockSpark();
    const { feed } = make(m, { liveCalls: false });
    expect(await codeOf(feed.probe())).toBe('LIVE_CALLS_DISABLED');
    expect(await codeOf(feed.changes(null, 10))).toBe('LIVE_CALLS_DISABLED');
    expect(await codeOf(feed.media('LK0001'))).toBe('LIVE_CALLS_DISABLED');
    expect(await codeOf(feed.metadata())).toBe('LIVE_CALLS_DISABLED');
    expect(m.calls).toHaveLength(0);
    // and without an injected transport the global fetch is not touched either (the tripwire records it)
    const g = new SparkResoClient({ baseUrl: BASE, allowedHosts: ['sparkapi.com'], authScheme: 'Bearer', liveCalls: false, accessToken: CANARY_TOKEN });
    expect(await codeOf(g.request('GET', `${BASE}/Reso/OData/Property`))).toBe('LIVE_CALLS_DISABLED');
  });

  it('the probe is exactly one GET /Reso/OData/Property?$top=1&$select=ListingKey,ModificationTimestamp, never retried', async () => {
    const ok = mockSpark(() => ({ status: 200, body: { value: [] } }));
    await make(ok).feed.probe();
    expect(ok.calls).toHaveLength(1);
    expect(`${ok.calls[0]!.url.pathname}${ok.calls[0]!.url.search}`).toBe('/Reso/OData/Property?$top=1&$select=ListingKey%2CModificationTimestamp');
    const busy = mockSpark(() => ({ status: 503 }));
    expect(await codeOf(make(busy).feed.probe())).toBe('BUSY');
    expect(busy.calls).toHaveLength(1);
  });
});

describe('Spark adapter: the live shape (findings 1-9, against a mock that reproduces it)', () => {
  const REPL = `https://${REPLICATION_HOST}`;
  const live = (m: MockSpark, o: Partial<SparkOptions> = {}) => make(m, { baseUrl: REPL, allowedHosts: [REPLICATION_HOST], ...o });

  it('finding 1: a replication key on the standard host is REPLICATION_ENDPOINT_REQUIRED (its own code, not unauthorized); the replication host works', async () => {
    const m = liveSpark({ records: () => [liveProperty(1)] });
    expect(await codeOf(make(m, { allowedHosts: ['sparkapi.com', REPLICATION_HOST] }).feed.probe())).toBe('REPLICATION_ENDPOINT_REQUIRED');
    expect(m.calls).toHaveLength(1); // a 403 is never retried
    // a generic 403 stays NOT_LICENSED_OR_ROLE_INSUFFICIENT
    expect(await codeOf(make(mockSpark(() => ({ status: 403, body: { error: { code: 403, message: 'Forbidden' } } }))).feed.probe())).toBe('NOT_LICENSED_OR_ROLE_INSUFFICIENT');
    await live(m).feed.probe();
    expect(m.calls.at(-1)!.url.hostname).toBe(REPLICATION_HOST);
  });

  it('finding 1: every nextLink stays on an allowed host (a replication nextLink with only the standard host allowed is refused)', async () => {
    const recs = Array.from({ length: 5 }, (_, i) => liveProperty(i + 1));
    const m = liveSpark({ records: () => recs, pageSize: 2 });
    const ok = await live(m).feed.records(null, 5);
    expect(ok.records).toHaveLength(5);
    expect(new Set(m.calls.map((c) => c.url.hostname))).toEqual(new Set([REPLICATION_HOST]));
    const evil = mockSpark(() => ({ status: 200, body: { value: [liveProperty(1)], '@odata.nextLink': 'https://sparkapi.com.evil.example/Reso/OData/Property?$skip=1' } }));
    expect(await codeOf(live(evil).feed.records(null, 5))).toBe('HOST_NOT_ALLOWED');
    expect(evil.calls).toHaveLength(1);
  });

  it('finding 2: there is no Media entity set; photos come from $expand=Media on the Property page request (no extra request per listing)', async () => {
    expect(SPARK_PATHS as readonly string[]).not.toContain('/Reso/OData/Media');
    const m = liveSpark({ records: () => [liveProperty(1), liveProperty(2)] });
    const { feed } = live(m);
    const meta = await feed.metadata();
    expect(meta).not.toMatch(/EntitySet Name="Media"/);
    expect((meta.match(/<EntitySet /g) ?? []).length).toBe(5);
    expect(await codeOf(feed.client.request('GET', `${REPL}/Reso/OData/Media`))).toBe('PATH_NOT_ALLOWED');
    m.calls.length = 0;
    const page = await feed.records(null, 10);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.url.searchParams.get('$expand')).toBe('Media');
    expect(mediaOf(page.records[0]!).map((x) => x.url)).toEqual(['https://photos.example.invalid/LK0001/1.jpg', 'https://photos.example.invalid/LK0001/2.jpg']);
  });

  it('finding 2 (VERIFY): $select inside $expand is opt-in; either way the request count stays bounded by maxPages', async () => {
    const recs = Array.from({ length: 30 }, (_, i) => liveProperty(i + 1));
    for (const honour of [false, true]) {
      const m = liveSpark({ records: () => recs, pageSize: 2, honourExpandSelect: honour });
      const page = await live(m, { expandSelect: true, maxPages: 3, pageSize: 100 }).feed.records(null, 1000);
      expect(m.calls).toHaveLength(3);
      expect(m.calls[0]!.url.searchParams.get('$expand')).toMatch(/^Media\(\$select=MediaKey,MediaURL,Order/);
      expect(page.records).toHaveLength(6);
      expect(page.more).toBe(true);
      expect(mediaOf(page.records[0]!)).toHaveLength(2);
    }
  });

  it('finding 3: Media fields as served; Order is Edm.Int64 (number or string), photos ordered by it', () => {
    const rec = sanitizeRecord({ ListingKey: 'LK1', Media: [{ MediaURL: 'https://p.example.invalid/3.jpg', Order: '3' }, { MediaURL: 'https://p.example.invalid/1.jpg', Order: 1 }, { MediaURL: 'https://p.example.invalid/x.jpg', Order: 'x' }] });
    expect(mediaOf(rec).map((x) => x.order)).toEqual([1, 3, Number.MAX_SAFE_INTEGER]);
  });

  it('finding 4: unknown keys are ignored, annotation keys never fail the parse, and a field whose permission withholds it is removed', async () => {
    const m = liveSpark({ records: () => [liveProperty(1), liveProperty(2, { 'ListOfficeName@Core.Permissions': 'None' })] });
    const page = await live(m).feed.records(null, 10);
    const r = page.records[0]!;
    expect(Object.keys(r).some((k) => k.includes('@'))).toBe(false);
    expect(r['PublicRemarks']).toBeUndefined(); // withheld by its annotation
    expect(JSON.stringify(page.records)).not.toContain('WITHHELD-REMARKS-MARKER');
    expect(r['ZZ_SyntheticLocalFlag']).toBe('Y'); // granted Read
    expect(r['ListPrice']).toBe(400001);
    // the second record's brokerage is withheld, so it cannot be stored (required, R-MLS-1): skipped, cursor still advances
    const changes = await live(m).feed.changes(null, 10);
    expect(changes.listings.map((l) => l.listingKey)).toEqual(['LK0001']);
    expect(changes.skipped).toBe(1);
    expect(decodeCursor(changes.cursor!).key).toBe('LK0002');
    for (const v of ['Read', 'ReadWrite', 'Read,Write', ['Read'], 'Org.OData.Core.V1.Permission/Read']) expect(permissionGrantsRead(v), JSON.stringify(v)).toBe(true);
    for (const v of ['None', 'Write', '', null, 1, {}, ['None'], 'read']) expect(permissionGrantsRead(v), JSON.stringify(v)).toBe(false);
  });

  it('finding 5: there is no LivingArea; the size is BuildingAreaTotal; an empty AboveGradeFinishedArea is not used', () => {
    const l = toResoListing(liveProperty(3, { BuildingAreaTotal: 2100 }))!;
    expect(l.livingAreaSqft).toBe(2100);
    expect(toResoListing(liveProperty(3, { BuildingAreaTotal: null, LivingArea: 999 }))!.livingAreaSqft).toBeNull();
  });

  it('finding 6: StandardStatus is free text from the Lookup resource; known values map, unknown ones are skipped; YN flags are JSON booleans', () => {
    expect(toResoListing(liveProperty(4, { StandardStatus: 'Active Under Contract' }))!.standardStatus).toBe('Pending');
    expect(toResoListing(liveProperty(4, { StandardStatus: 'Hold' }))).toBeNull();
    expect(sanitizeRecord(liveProperty(4))['InternetEntireListingDisplayYN']).toBe(true);
  });

  it('finding 7: a transient 503 is BUSY; the sync read retries it inside its budget; the probe (no retry) reports BUSY', async () => {
    const m = liveSpark({ records: () => [liveProperty(1)], busyNext: 1 });
    expect(await codeOf(live(m).feed.probe())).toBe('BUSY');
    expect(m.calls).toHaveLength(1);
    m.opts.busyNext = 2;
    const { feed, sleeps } = live(m);
    expect((await feed.records(null, 5)).records).toHaveLength(1);
    expect(sleeps).toHaveLength(2);
    m.opts.busyNext = 100;
    expect(await codeOf(live(m, { retry: { budget: 2 } }).feed.records(null, 5))).toBe('BUSY');
  });

  it('finding 8: the X-Api-Key response header is never read into a result or an error', async () => {
    const m = liveSpark({ records: () => [liveProperty(1)] });
    const { feed } = live(m);
    const page = await feed.records(null, 5);
    expect(JSON.stringify(page)).not.toContain(CANARY_KEY_ID);
    const e = await feed.client.request('GET', `${REPL}/Reso/OData/Media`).catch((x: unknown) => x);
    expect(JSON.stringify(e) + String(e)).not.toContain(CANARY_KEY_ID);
    const e403 = await make(m, { allowedHosts: ['sparkapi.com'] }).feed.probe().catch((x: unknown) => x);
    expect(JSON.stringify(e403) + String(e403)).not.toContain(CANARY_KEY_ID);
    expect(JSON.stringify(e403)).not.toContain('restricted');
  });

  it('finding 9: the one-record probe has no nextLink and no count, and that is a success', async () => {
    const m = liveSpark({ records: () => [liveProperty(1), liveProperty(2)] });
    await live(m).feed.probe();
    const c = m.calls[0]!;
    expect(Object.fromEntries(c.url.searchParams)).toEqual({ $top: '1', $select: 'ListingKey,ModificationTimestamp' });
  });
});
