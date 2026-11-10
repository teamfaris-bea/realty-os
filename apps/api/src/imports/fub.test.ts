// The FUB adapter (interface + deterministic fake + HTTP adapter). The HTTP adapter is exercised
// against a recorded stand-in `fetch` only: it has not been run against the live FUB API from this
// environment (no account) — VERIFY with a real account before the first production migration.
import { describe, expect, it } from 'vitest';
import { FakeFub, FubAccessError, httpFubConnector, readCollection } from './fub.js';

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
    const c = httpFubConnector({ fetch: f, baseUrl: 'https://fub.test/v1', system: { name: 'RealtyOS', key: 'sys-key' } })('k-123');
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
    const c = httpFubConnector({ fetch: f, baseUrl: 'https://fub.test/v1' })('k');
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
    const c = httpFubConnector({ fetch: f, baseUrl: 'https://fub.test/v1' })('k');
    await expect(c.countPage('people')).rejects.toMatchObject({ code: 'FUB_UNAUTHORIZED', status: 401 });
    await expect(c.countPage('emails')).rejects.toMatchObject({ code: 'FUB_UNAVAILABLE', status: 404 });
    await expect(c.list('notes', null, 10)).rejects.toMatchObject({ code: 'FUB_UNAVAILABLE', status: 503 });
    await expect(c.list('calls', null, 10)).rejects.toBeInstanceOf(FubAccessError);
  });

  it('sends the key only to the FUB API host when downloading a recording; refuses non-https URLs', async () => {
    const audio = new Uint8Array([1, 2, 3]);
    const { f, seen } = standIn({ 'fub.test/v1/rec/1': audio, 'cdn.example/rec/2': audio });
    const c = httpFubConnector({ fetch: f, baseUrl: 'https://fub.test/v1' })('k');
    expect((await c.fetchRecording('https://fub.test/v1/rec/1'))?.bytes).toEqual(audio);
    expect((await c.fetchRecording('https://cdn.example/rec/2?sig=x'))?.contentType).toBe('audio/mpeg');
    expect(await c.fetchRecording('http://cdn.example/rec/2')).toBeNull();
    expect(await c.fetchRecording('not a url')).toBeNull();
    expect(seen.map((s) => s.auth !== null)).toEqual([true, false]);
  });

  it('never fetches a recording URL (FUB data) that names an internal host: IP literals, localhost, single-label names', async () => {
    const { f, seen } = standIn({});
    const c = httpFubConnector({ fetch: f, baseUrl: 'https://fub.test/v1' })('k');
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
    const c = httpFubConnector({ fetch: f, baseUrl: 'https://fub.test/v1', system: { name: 'realty', key: 'sys-secret' } })('k');
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
