// The FUB adapter (interface + deterministic fake + HTTP adapter). The HTTP adapter is exercised
// against a recorded stand-in `fetch` only: it has not been run against the live FUB API from this
// environment (no account) — VERIFY with a real account before the first production migration.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../config.js';
import { FakeFub, FubAccessError, FubConfigError, MAX_API_PAGE_BYTES, httpFubConnector, readCollection } from './fub.js';
import { defaultFubConnector } from './handlers.js';

/** The stand-in FUB host the adapter tests use, allow-listed like FUB_ALLOWED_HOSTS would in config. */
const FUB_TEST = { baseUrl: 'https://fub.test/v1', allowedHosts: ['fub.test'] } as const;

function standIn(pages: Record<string, unknown>, status: Record<string, number> = {}) {
  const seen: { url: string; auth: string | null; system: string | null }[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    seen.push({ url, auth: h.get('authorization'), system: h.get('x-system') });
    const key = Object.keys(pages).find((k) => url.includes(k));
    const st = Object.entries(status).find(([k]) => url.includes(k))?.[1];
    if (st) return new Response('{}', { status: st });
    if (key === undefined) return new Response('{}', { status: 404 });
    const body = pages[key];
    return body instanceof Uint8Array ? new Response(body, { status: 200, headers: { 'content-type': 'audio/mpeg' } }) : Response.json(body);
  }) as typeof fetch;
  return { f, seen };
}

describe('httpFubConnector', () => {
  it('uses HTTP Basic with the API key as user name and sends the registered-system headers', async () => {
    const { f, seen } = standIn({ '/people?limit=1&offset=0': { _metadata: { total: 3 }, people: [{ id: 1 }] } });
    const c = httpFubConnector({ fetch: f, ...FUB_TEST, system: { name: 'RealtyOS', key: 'sys-key' } })('k-123');
    const page = (await c.countPage('people')) as { _metadata: { total: number } };
    expect(page._metadata.total).toBe(3);
    expect(seen[0]).toEqual({ url: 'https://fub.test/v1/people?limit=1&offset=0', auth: `Basic ${Buffer.from('k-123:').toString('base64')}`, system: 'RealtyOS' });
  });

  it('pages by offset, then by the `next` cursor FUB returns, until the end', async () => {
    const { f, seen } = standIn({
      '/notes?limit=2&offset=0': { _metadata: { total: 5, offset: 0 }, notes: [{ id: 1 }, { id: 2 }] },
      '/notes?limit=2&offset=2': { _metadata: { total: 5, offset: 2, next: 'abc' }, notes: [{ id: 3 }, { id: 4 }] },
      '/notes?limit=2&next=abc': { _metadata: { total: 5 }, notes: [{ id: 5 }] },
    });
    const c = httpFubConnector({ fetch: f, ...FUB_TEST })('k');
    const p1 = await c.list('notes', null, 2);
    expect([p1.items.length, p1.next]).toEqual([2, '2']);
    const p2 = await c.list('notes', p1.next, 2);
    expect(p2.next).toBe('abc');
    const p3 = await c.list('notes', p2.next, 2);
    expect([p3.items.length, p3.next]).toEqual([1, null]);
    expect(seen.map((s) => s.url.replace('https://fub.test/v1', ''))).toEqual(['/notes?limit=2&offset=0', '/notes?limit=2&offset=2', '/notes?limit=2&next=abc']);
  });

  it('maps 401/403 to FUB_UNAUTHORIZED, other failures to FUB_UNAVAILABLE, malformed bodies to FUB_BAD_RESPONSE', async () => {
    const { f } = standIn({ '/calls': { nope: true } }, { '/people': 401, '/emails': 404, '/notes': 503 });
    const c = httpFubConnector({ fetch: f, ...FUB_TEST })('k');
    await expect(c.countPage('people')).rejects.toMatchObject({ code: 'FUB_UNAUTHORIZED', status: 401 });
    await expect(c.countPage('emails')).rejects.toMatchObject({ code: 'FUB_UNAVAILABLE', status: 404 });
    await expect(c.list('notes', null, 10)).rejects.toMatchObject({ code: 'FUB_UNAVAILABLE', status: 503 });
    await expect(c.list('calls', null, 10)).rejects.toBeInstanceOf(FubAccessError);
  });

  it('sends the key only to the FUB API host when downloading a recording; refuses non-https URLs', async () => {
    const audio = new Uint8Array([1, 2, 3]);
    const { f, seen } = standIn({ 'fub.test/v1/rec/1': audio, 'cdn.example/rec/2': audio });
    const c = httpFubConnector({ fetch: f, ...FUB_TEST })('k');
    expect((await c.fetchRecording('https://fub.test/v1/rec/1'))?.bytes).toEqual(audio);
    expect((await c.fetchRecording('https://cdn.example/rec/2?sig=x'))?.contentType).toBe('audio/mpeg');
    expect(await c.fetchRecording('http://cdn.example/rec/2')).toBeNull();
    expect(await c.fetchRecording('not a url')).toBeNull();
    expect(seen.map((s) => s.auth !== null)).toEqual([true, false]);
  });

  it('never fetches a recording URL (FUB data) that names an internal host: IP literals, localhost, single-label names', async () => {
    const { f, seen } = standIn({});
    const c = httpFubConnector({ fetch: f, ...FUB_TEST })('k');
    for (const u of ['https://127.0.0.1/rec', 'https://10.0.0.5/rec', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/rec', 'https://localhost/rec', 'https://db.localhost/rec', 'https://metadata/rec', 'https://2130706433/rec', 'https://user:pw@cdn.example/rec']) {
      expect([u, await c.fetchRecording(u)]).toEqual([u, null]);
    }
    expect(seen).toEqual([]);
  });

  it('a redirect from the FUB API host is followed without the credential headers; an oversized recording is refused', async () => {
    const seen: { url: string; auth: string | null; system: string | null; redirect: string | undefined }[] = [];
    const f = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const h = new Headers(init?.headers);
      seen.push({ url, auth: h.get('authorization'), system: h.get('x-system-key'), redirect: init?.redirect });
      if (url.includes('fub.test/v1/rec/1')) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/signed/1?sig=x' } });
      if (url.includes('fub.test/v1/rec/2')) return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/steal' } });
      if (url.includes('cdn.example/big')) return new Response(new Uint8Array(16), { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(600 * 1024 * 1024) } });
      return new Response(new Uint8Array([7, 7]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }) as typeof fetch;
    const c = httpFubConnector({ fetch: f, ...FUB_TEST, system: { name: 'realty', key: 'sys-secret' } })('k');
    expect((await c.fetchRecording('https://fub.test/v1/rec/1'))?.bytes).toEqual(new Uint8Array([7, 7]));
    expect(seen.map((s) => [new URL(s.url).host, s.auth !== null, s.system !== null, s.redirect])).toEqual([
      ['fub.test', true, true, 'manual'],
      ['cdn.example', false, false, 'manual'],
    ]);
    expect(await c.fetchRecording('https://fub.test/v1/rec/2')).toBeNull();
    expect(seen.some((s) => s.url.includes('127.0.0.1'))).toBe(false);
    await expect(c.fetchRecording('https://cdn.example/big')).rejects.toMatchObject({ code: 'FUB_BAD_RESPONSE' });
  });
});

describe('FakeFub', () => {
  it('reads whole collections through paging; an unknown key is unauthorized; mutate changes live data only', async () => {
    const fake = new FakeFub().add('key', { people: Array.from({ length: 250 }, (_, i) => ({ id: i })) });
    const all = await readCollection(fake.connector('key'), 'people');
    expect(all).toHaveLength(250);
    expect(fake.calls.filter((c) => c.op === 'list')).toHaveLength(3);
    await expect(fake.connector('other').countPage('people')).rejects.toMatchObject({ code: 'FUB_UNAUTHORIZED' });
    fake.mutate('key', (d) => d.people!.push({ id: 999 }));
    expect(all).toHaveLength(250);
    expect(await readCollection(fake.connector('key'), 'people')).toHaveLength(251);
  });
});

describe('httpFubConnector SSRF guards', () => {
  it('the API base URL must be https on the default port, with no credentials, query or fragment, naming an allow-listed public host', () => {
    const bad = [
      'http://api.followupboss.com/v1',
      'https://user:pw@api.followupboss.com/v1',
      'https://api.followupboss.com:8443/v1',
      'https://api.followupboss.com/v1?x=1',
      'https://api.followupboss.com/v1#frag',
      'https://169.254.169.254/latest',
      'https://127.0.0.1/v1',
      'https://[::1]/v1',
      'https://2130706433/v1',
      'https://localhost/v1',
      'https://metadata.google.internal/v1',
      'https://fub/v1',
      'https://api.followupboss.com.evil.example/v1',
      'file:///etc/passwd',
      'not a url',
    ];
    // even when the allow-list names the host: the shape checks are not configurable
    const allowedHosts = ['api.followupboss.com', '169.254.169.254', '127.0.0.1', 'localhost', 'metadata.google.internal', 'fub'];
    for (const baseUrl of bad) expect([baseUrl, (() => { try { httpFubConnector({ baseUrl, allowedHosts }); return 'accepted'; } catch (e) { return e instanceof FubConfigError ? 'refused' : String(e); } })()]).toEqual([baseUrl, 'refused']);
    // the default allow-list is FUB's own API host: any other host needs explicit configuration
    expect(() => httpFubConnector({ baseUrl: 'https://fub.test/v1' })).toThrow(FubConfigError);
    expect(() => httpFubConnector()).not.toThrow();
    expect(() => httpFubConnector({ baseUrl: 'https://API.FollowUpBoss.com/v1/' })).not.toThrow();
  });

  it('FUB_BASE_URL comes from server config only and is checked at startup against FUB_ALLOWED_HOSTS (default api.followupboss.com)', () => {
    const env = (o: Record<string, string>) => ({ DATABASE_URL: 'postgres://x', KEK_BASE64: randomBytes(32).toString('base64'), SESSION_SECRET_BASE64: randomBytes(32).toString('base64'), FUB_PROVIDER: 'real', ...o });
    // loadConfig refuses at startup (ConfigError, naming the key) ...
    expect(() => loadConfig(env({ FUB_BASE_URL: 'https://169.254.169.254/latest' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ FUB_BASE_URL: 'https://fub.test/v1' }))).toThrow(/FUB_BASE_URL host must be listed in FUB_ALLOWED_HOSTS/);
    expect(() => loadConfig(env({ FUB_ALLOWED_HOSTS: '10.0.0.1' }))).toThrow(/FUB_ALLOWED_HOSTS/);
    // ... a valid config builds the real adapter ...
    expect(() => defaultFubConnector(loadConfig(env({ FUB_BASE_URL: 'https://fub.test/v1', FUB_ALLOWED_HOSTS: 'api.followupboss.com, fub.test' })).fub)).not.toThrow();
    expect(() => defaultFubConnector(loadConfig(env({})).fub)).not.toThrow();
    // ... and the adapter re-checks a hand-built one (defence in depth)
    expect(() => defaultFubConnector({ provider: 'real', baseUrl: 'https://169.254.169.254/latest', allowedHosts: ['api.followupboss.com'] })).toThrow(FubConfigError);
    expect(() => defaultFubConnector({ provider: 'real', baseUrl: 'https://fub.test/v1', allowedHosts: ['api.followupboss.com'] })).toThrow(FubConfigError);
  });

  it('API requests never follow a redirect: a 3xx is FUB_UNAVAILABLE and its Location is never requested (with or without the key)', async () => {
    const seen: { url: string; redirect: string | undefined }[] = [];
    const f = (async (input: string | URL, init?: RequestInit) => {
      seen.push({ url: String(input), redirect: init?.redirect });
      if (String(input).includes('fub.test')) return new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } });
      return Response.json({ _metadata: { total: 1 }, people: [{ id: 1 }] });
    }) as typeof fetch;
    const c = httpFubConnector({ fetch: f, ...FUB_TEST })('k');
    await expect(c.countPage('people')).rejects.toMatchObject({ code: 'FUB_UNAVAILABLE', status: 302 });
    await expect(c.list('people', null, 10)).rejects.toMatchObject({ code: 'FUB_UNAVAILABLE', status: 302 });
    expect(seen.every((s) => s.redirect === 'manual')).toBe(true);
    expect(seen.some((s) => s.url.includes('169.254'))).toBe(false);
  });

  it('an API page larger than MAX_API_PAGE_BYTES is FUB_BAD_RESPONSE, by declared length or by the bytes actually sent', async () => {
    const f = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/people')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(MAX_API_PAGE_BYTES + 1) } });
      const chunk = new Uint8Array(1024 * 1024).fill(0x20);
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(ctl) {
          if (sent > MAX_API_PAGE_BYTES + chunk.byteLength) return ctl.close();
          sent += chunk.byteLength;
          ctl.enqueue(chunk);
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const c = httpFubConnector({ fetch: f, ...FUB_TEST })('k');
    await expect(c.countPage('people')).rejects.toMatchObject({ code: 'FUB_BAD_RESPONSE' });
    await expect(c.list('notes', null, 10)).rejects.toMatchObject({ code: 'FUB_BAD_RESPONSE' });
  });

  it('a recording URL (FUB data) on a custom port, a hex/octal IP form or an internal-only suffix is never fetched', async () => {
    const seen: string[] = [];
    const f = (async (input: string | URL) => {
      seen.push(String(input));
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as typeof fetch;
    const c = httpFubConnector({ fetch: f, ...FUB_TEST })('k');
    for (const u of ['https://cdn.example:8443/rec', 'https://cdn.example:443x/rec', 'https://0x7f000001/rec', 'https://0177.0.0.1/rec', 'https://127.1/rec', 'https://files.corp/rec', 'https://nas.intranet/rec', 'https://printer.home/rec', 'https://[fd00::1]/rec', 'https://[::ffff:169.254.169.254]/rec']) {
      expect([u, await c.fetchRecording(u)]).toEqual([u, null]);
    }
    expect(seen).toEqual([]);
    // a redirect to a custom port is refused too
    const g = (async (input: string | URL) => {
      seen.push(String(input));
      return String(input).includes('cdn.example/r') ? new Response(null, { status: 302, headers: { location: 'https://cdn.example:6379/' } }) : new Response(new Uint8Array([1]), { status: 200 });
    }) as typeof fetch;
    expect(await httpFubConnector({ fetch: g, ...FUB_TEST })('k').fetchRecording('https://cdn.example/r')).toBeNull();
    expect(seen).toEqual(['https://cdn.example/r']);
  });
});
