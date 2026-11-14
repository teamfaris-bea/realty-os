// module 46 (R-PORTALWEB-3, R-PORTALWEB-4; E700-E703, E719): the link is read once, before the first render.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEAM_STORAGE_KEY, classifyHash, dropToken, linkToken, readLink, resetLinkForTests, teamFromSearch } from './link.js';
import { TOKEN } from './test/fixtures.js';

function memoryStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: vi.fn((k: string) => m.get(k) ?? null), setItem: vi.fn((k: string, v: string) => void m.set(k, v)), m };
}
const hist = () => ({ state: { keep: 1 }, replaceState: vi.fn() });

beforeEach(() => resetLinkForTests());
afterEach(() => resetLinkForTests());

describe('link.ts (R-PORTALWEB-3)', () => {
  it('R-PORTALWEB-3: a well-formed #token= is taken, stripped from the address bar and the current entry, and kept in memory only', () => {
    const h = hist();
    const store = memoryStore();
    const r = readLink({ pathname: '/portal.html', search: '', hash: `#token=${TOKEN}` }, h, store);
    expect(r.link).toBe('token');
    expect(h.replaceState).toHaveBeenCalledWith({ keep: 1 }, '', '/portal.html');
    expect(linkToken()).toBe(TOKEN);
    expect(store.setItem).not.toHaveBeenCalled();
    expect(JSON.stringify([...store.m])).not.toContain(TOKEN);
    dropToken();
    expect(linkToken()).toBeNull();
  });

  it('E702: anything but exactly 43 base64url characters is "incomplete": no token, and the fragment is still stripped', () => {
    const cases = [
      `#token=${TOKEN.slice(0, 42)}`,
      `#token=${TOKEN}x`,
      `#token=${TOKEN.slice(0, 42)}+`,
      `#token=${TOKEN.slice(0, 42)}/`,
      `#token=${TOKEN.slice(0, 42)}=`,
      `#token=${encodeURIComponent(TOKEN.slice(0, 40) + '+/=')}`,
      `#token%3D${TOKEN}`,
      `#token=${TOKEN} `,
      `#token=%20${TOKEN}`,
      `#token=${TOKEN}&next=//evil.example.test`,
      `#token=${TOKEN}&token=${TOKEN}`,
      `#next=/x&token=${TOKEN}`,
      '#token=',
      '#TOKEN=' + TOKEN,
    ];
    for (const hash of cases) {
      expect(classifyHash(hash).kind, hash).toBe('incomplete');
      expect(classifyHash(hash).token, hash).toBeNull();
    }
    expect(classifyHash('').kind).toBe('none');
    expect(classifyHash('#main').kind).toBe('none');
    const h = hist();
    resetLinkForTests();
    expect(readLink({ pathname: '/portal.html', search: '?team=harbor', hash: `#token=${TOKEN}&next=x` }, h, memoryStore()).link).toBe('incomplete');
    expect(h.replaceState).toHaveBeenCalledWith({ keep: 1 }, '', '/portal.html?team=harbor');
    expect(linkToken()).toBeNull();
  });

  it('R-PORTALWEB-3: the link is read once; a second read never looks at the address again', () => {
    const h = hist();
    readLink({ pathname: '/portal.html', search: '', hash: `#token=${TOKEN}` }, h, memoryStore());
    const again = readLink({ pathname: '/portal.html', search: '', hash: '#token=other' }, h, memoryStore());
    expect(again.link).toBe('token');
    expect(h.replaceState).toHaveBeenCalledTimes(1);
  });

  it('R-PORTALWEB-4: ?team= is lowercased, checked against the slug pattern, and remembered (the slug only)', () => {
    expect(teamFromSearch('?team=Harbor')).toEqual({ present: true, slug: 'harbor' });
    for (const bad of ['?team=', '?team=a', '?team=-x', '?team=x_y', '?team=' + 'a'.repeat(42), '?team=harbor%0a', '?team=../x']) expect(teamFromSearch(bad).slug, bad).toBeNull();
    const store = memoryStore();
    expect(readLink({ pathname: '/portal.html', search: '?team=Harbor', hash: '' }, hist(), store).team).toBe('harbor');
    expect(store.m.get(TEAM_STORAGE_KEY)).toBe('harbor');
    expect([...store.m.keys()]).toEqual([TEAM_STORAGE_KEY]);
  });

  it('R-PORTALWEB-4: the token link (no team) uses the remembered slug; an invalid remembered or given slug is never used (E719)', () => {
    expect(readLink({ pathname: '/portal.html', search: '', hash: `#token=${TOKEN}` }, hist(), memoryStore({ [TEAM_STORAGE_KEY]: 'harbor' })).team).toBe('harbor');
    resetLinkForTests();
    expect(readLink({ pathname: '/portal.html', search: '', hash: '' }, hist(), memoryStore({ [TEAM_STORAGE_KEY]: 'BAD SLUG' })).team).toBeNull();
    resetLinkForTests();
    expect(readLink({ pathname: '/portal.html', search: '?team=no_way', hash: '' }, hist(), memoryStore({ [TEAM_STORAGE_KEY]: 'harbor' })).team).toBeNull();
    resetLinkForTests();
    expect(readLink({ pathname: '/portal.html', search: '', hash: '' }, hist(), null).team).toBeNull();
  });

  it('storage that throws (private mode) never breaks the read: the query alone decides', () => {
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readLink({ pathname: '/portal.html', search: '?team=harbor', hash: `#token=${TOKEN}` }, hist(), throwing).team).toBe('harbor');
    expect(linkToken()).toBe(TOKEN);
    resetLinkForTests();
    expect(readLink({ pathname: '/portal.html', search: '', hash: '' }, hist(), throwing).team).toBeNull();
  });
});
