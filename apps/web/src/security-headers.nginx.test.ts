// The deployable web server (deploy/nginx.conf, run by the Dockerfile `web` stage) must send exactly
// `webSecurityHeaders` on every response it serves for the web app (SECURITY §2.1). This test parses the
// nginx config, expands its `include`s through the files the Dockerfile copies into the image, applies
// nginx's add_header inheritance rule (a level with any add_header of its own inherits none), and compares
// the effective header set of every location with the single definition in security-headers.ts.
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nginxSecurityHeadersConf, webSecurityHeaders } from '../security-headers.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8');

/** Headers a content location may add besides webSecurityHeaders (caching only). */
const EXTRA_ALLOWED = new Set(['cache-control']);

interface Directive {
  name: string;
  args: string[];
  block?: Directive[];
}

function tokenize(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) i++;
    else if (c === '#') while (i < text.length && text[i] !== '\n') i++;
    else if (c === '{' || c === '}' || c === ';') out.push(text[i++]!);
    else if (c === '"' || c === "'") {
      let s = '';
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') i++;
        s += text[i++];
      }
      if (i >= text.length) throw new Error('unterminated string in nginx config');
      i++;
      out.push(s);
    } else {
      let s = '';
      while (i < text.length && !/[\s;{}]/.test(text[i]!)) {
        if (text[i] === '$' && text[i + 1] === '{') {
          const end = text.indexOf('}', i);
          s += text.slice(i, end + 1);
          i = end + 1;
        } else s += text[i++];
      }
      out.push(s);
    }
  }
  return out;
}

/** Parses nginx config text; `include` directives are expanded with `resolveInclude`. */
function parse(text: string, resolveInclude: (path: string) => string): Directive[] {
  const tokens = tokenize(text);
  let pos = 0;
  const block = (top: boolean): Directive[] => {
    const list: Directive[] = [];
    while (pos < tokens.length) {
      if (tokens[pos] === '}') {
        if (top) throw new Error('unbalanced } in nginx config');
        pos++;
        return list;
      }
      const words: string[] = [];
      while (pos < tokens.length && tokens[pos] !== ';' && tokens[pos] !== '{' && tokens[pos] !== '}') words.push(tokens[pos++]!);
      const [name, ...args] = words;
      if (name === undefined) throw new Error('empty nginx directive');
      if (tokens[pos] === '{') {
        pos++;
        list.push({ name, args, block: block(false) });
      } else if (tokens[pos] === ';') {
        pos++;
        if (name === 'include') for (const a of args) list.push(...parse(resolveInclude(a), resolveInclude));
        else list.push({ name, args });
      } else throw new Error(`nginx directive ${name} is not terminated`);
    }
    if (!top) throw new Error('unbalanced { in nginx config');
    return list;
  };
  return block(true);
}

/** Container path → repository file, from the plain COPY lines of the Dockerfile `web` stage. */
function webImageFiles(dockerfile: string): Map<string, string> {
  const lines = dockerfile.split('\n');
  const start = lines.findIndex((l) => /^FROM\s+\S+\s+AS\s+web\s*$/i.test(l));
  if (start < 0) throw new Error('Dockerfile has no web stage');
  const files = new Map<string, string>();
  for (const l of lines.slice(start + 1)) {
    if (/^FROM\s/i.test(l)) break;
    const m = /^COPY\s+(\S+)\s+(\S+)\s*$/.exec(l);
    if (m) files.set(m[2]!, m[1]!);
  }
  return files;
}

interface Header {
  name: string;
  value: string;
  always: boolean;
}
interface LocationView {
  path: string;
  proxied: boolean;
  headers: Header[];
}

const ownHeaders = (b: Directive[]): Header[] =>
  b.filter((d) => d.name === 'add_header').map((d) => ({ name: d.args[0]!, value: d.args[1] ?? '', always: d.args[2] === 'always' }));

/** Every location (nested ones too) with the add_header set nginx actually applies there. */
function locations(server: Directive): LocationView[] {
  const out: LocationView[] = [];
  const walk = (b: Directive[], inherited: Header[]) => {
    for (const d of b) {
      if (d.name !== 'location' || !d.block) continue;
      const own = ownHeaders(d.block);
      const headers = own.length > 0 ? own : inherited;
      out.push({ path: d.args.join(' '), proxied: d.block.some((x) => /_pass$/.test(x.name)), headers });
      walk(d.block, headers);
    }
  };
  walk(server.block ?? [], ownHeaders(server.block ?? []));
  return out;
}

/** Problems with one nginx config: an empty list means every location sends exactly webSecurityHeaders. */
function headerProblems(conf: Directive[]): string[] {
  const problems: string[] = [];
  const servers = conf.filter((d) => d.name === 'server');
  if (servers.length === 0) problems.push('no server block');
  if (ownHeaders(conf).length > 0) problems.push('add_header at http level');
  const want = new Map(Object.entries(webSecurityHeaders).map(([k, v]) => [k.toLowerCase(), v]));
  for (const s of servers) {
    // server-level add_header lines would be inherited by /api/ (a second, conflicting CSP on API responses)
    if (ownHeaders(s.block ?? []).length > 0) problems.push('server-level add_header (would reach /api/)');
    const locs = locations(s);
    if (!locs.some((l) => l.path === '/')) problems.push('no catch-all location /');
    for (const l of locs) {
      if (l.proxied) {
        if (l.headers.length > 0) problems.push(`${l.path}: proxied location adds ${l.headers.map((h) => h.name).join(', ')}`);
        continue;
      }
      const seen = new Map<string, Header>();
      for (const h of l.headers) {
        const k = h.name.toLowerCase();
        if (seen.has(k)) problems.push(`${l.path}: ${h.name} sent twice`);
        seen.set(k, h);
        if (!want.has(k) && !EXTRA_ALLOWED.has(k)) problems.push(`${l.path}: unexpected header ${h.name}`);
      }
      for (const [k, v] of want) {
        const h = seen.get(k);
        if (!h) problems.push(`${l.path}: missing ${k}`);
        else {
          if (h.value !== v) problems.push(`${l.path}: ${k} differs from webSecurityHeaders`);
          if (!h.always) problems.push(`${l.path}: ${k} lacks "always" (error responses would miss it)`);
        }
      }
    }
  }
  return problems;
}

const files = webImageFiles(read('Dockerfile'));
const includeFromImage = (path: string) => {
  const src = files.get(path);
  if (!src) throw new Error(`nginx includes ${path}, which the Dockerfile web stage does not copy into the image`);
  return read(src);
};

describe('deploy/nginx.conf sends exactly webSecurityHeaders (SECURITY §2.1)', () => {
  const conf = parse(read('deploy/nginx.conf'), includeFromImage);

  it('the Dockerfile web stage installs deploy/nginx.conf and the generated header snippet', () => {
    expect(files.get('/etc/nginx/templates/default.conf.template')).toBe('deploy/nginx.conf');
    expect([...files.values()]).toContain('deploy/security-headers.conf');
  });

  it('deploy/security-headers.conf is exactly the text generated from security-headers.ts (node deploy/render-security-headers.mjs)', () => {
    expect(read('deploy/security-headers.conf')).toBe(nginxSecurityHeadersConf());
  });

  it('every content location (HTML, assets, SPA fallback, health) has the full header set, names and values, with always', () => {
    expect(headerProblems(conf)).toEqual([]);
    const locs = locations(conf.find((d) => d.name === 'server')!);
    const content = locs.filter((l) => !l.proxied);
    expect(content.map((l) => l.path).sort()).toEqual(['/', '/assets/', '= /healthz']);
    for (const l of content) {
      const csp = l.headers.find((h) => h.name === 'Content-Security-Policy')!.value;
      expect(csp).toBe(webSecurityHeaders['Content-Security-Policy']);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    }
  });

  it('/api/ responses carry only the API’s own headers (no second CSP from nginx)', () => {
    const api = locations(conf.find((d) => d.name === 'server')!).filter((l) => l.proxied);
    expect(api.map((l) => l.path)).toEqual(['/api/']);
    expect(api[0]!.headers).toEqual([]);
  });

  it('keeps the caching rules: hashed assets immutable, everything else (index.html) no-store; the SPA falls back to /index.html', () => {
    const server = conf.find((d) => d.name === 'server')!;
    const loc = (p: string) => locations(server).find((l) => l.path === p)!;
    expect(loc('/assets/').headers.find((h) => h.name === 'Cache-Control')?.value).toBe('public, max-age=31536000, immutable');
    expect(loc('/').headers.find((h) => h.name === 'Cache-Control')?.value).toBe('no-store');
    const root = server.block!.find((d) => d.name === 'location' && d.args.join(' ') === '/')!;
    expect(root.block!.find((d) => d.name === 'try_files')?.args.at(-1)).toBe('/index.html');
  });

  it('the checker catches drift: a location with its own add_header and no include, a changed value, a server-level header', () => {
    const snippet = nginxSecurityHeadersConf();
    const inc = () => snippet;
    const dropped = parse('server { location / { add_header Cache-Control "no-store"; } }', inc);
    expect(headerProblems(dropped)).toContain('/: missing content-security-policy');
    const changed = parse(`server { location / { include x; add_header X-Frame-Options "SAMEORIGIN" always; } }`, () => snippet.replace(/^add_header X-Frame-Options.*$/m, ''));
    expect(headerProblems(changed)).toContain('/: x-frame-options differs from webSecurityHeaders');
    const leaky = parse('server { include x; location /api/ { proxy_pass http://api; } location / { include x; } }', inc);
    expect(headerProblems(leaky)).toEqual(expect.arrayContaining(['server-level add_header (would reach /api/)', expect.stringMatching(/^\/api\/: proxied location adds Content-Security-Policy/)]));
    const noAlways = parse(`server { location / { include x; } }`, () => snippet.replace(/ always;$/gm, ';'));
    expect(headerProblems(noAlways)).toContain('/: content-security-policy lacks "always" (error responses would miss it)');
  });
});
