// The deployable web server (deploy/nginx.conf, run by the Dockerfile `web` stage) must send exactly
// `webSecurityHeaders` on every response it serves for the web app (SECURITY §2.1), except the chat widget's
// script (/widget/chat.js, module 37), which brokerages' websites load cross-origin and so gets
// `widgetScriptHeaders` (the same set with Cross-Origin-Resource-Policy: cross-origin). This test parses the
// nginx config, expands its `include`s through the files the Dockerfile copies into the image, applies
// nginx's add_header inheritance rule (a level with any add_header of its own inherits none), and compares
// the effective header set of every location with the single definition in security-headers.ts. It also checks
// that /api/ passes the API's own CORS through untouched (module 22's public chat routes answer it per route).
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nginxSecurityHeadersConf, nginxWidgetHeadersConf, webSecurityHeaders, widgetScriptHeaders } from '../security-headers.js';

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

/** The one location that serves the chat widget's script to other websites (module 37). */
const WIDGET_SCRIPT = '= /widget/chat.js';
/** The header set a content location must send: the widget's script gets widgetScriptHeaders, every other webSecurityHeaders. */
const expectedFor = (path: string): Readonly<Record<string, string>> => (path === WIDGET_SCRIPT ? widgetScriptHeaders : webSecurityHeaders);

/** Problems with one nginx config: an empty list means every location sends exactly its expected header set. */
function headerProblems(conf: Directive[]): string[] {
  const problems: string[] = [];
  const servers = conf.filter((d) => d.name === 'server');
  if (servers.length === 0) problems.push('no server block');
  if (ownHeaders(conf).length > 0) problems.push('add_header at http level');
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
      const want = new Map(Object.entries(expectedFor(l.path)).map(([k, v]) => [k.toLowerCase(), v]));
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
          if (h.value !== v) problems.push(`${l.path}: ${k} differs from ${l.path === WIDGET_SCRIPT ? 'widgetScriptHeaders' : 'webSecurityHeaders'}`);
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

  it('the Dockerfile web stage installs deploy/nginx.conf, the generated header snippets and the client-address snippet', () => {
    expect(files.get('/etc/nginx/templates/default.conf.template')).toBe('deploy/nginx.conf');
    expect([...files.values()]).toContain('deploy/security-headers.conf');
    expect([...files.values()]).toContain('deploy/widget-security-headers.conf');
    expect(files.get('/etc/nginx/snippets/real-ip.conf')).toBe('deploy/real-ip.conf');
  });

  it('deploy/security-headers.conf and deploy/widget-security-headers.conf are exactly the text generated from security-headers.ts (node deploy/render-security-headers.mjs)', () => {
    expect(read('deploy/security-headers.conf')).toBe(nginxSecurityHeadersConf());
    expect(read('deploy/widget-security-headers.conf')).toBe(nginxWidgetHeadersConf());
  });

  it('every content location (HTML, assets, SPA fallback, health) has the full header set, names and values, with always', () => {
    expect(headerProblems(conf)).toEqual([]);
    const locs = locations(conf.find((d) => d.name === 'server')!);
    const content = locs.filter((l) => !l.proxied);
    expect(content.map((l) => l.path).sort()).toEqual(['/', '/assets/', '= /healthz', WIDGET_SCRIPT]);
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

  it('module 37: only /widget/chat.js is Cross-Origin-Resource-Policy: cross-origin (brokerages\' websites load it); every other location stays same-origin; the script is served as itself, never the SPA fallback', () => {
    const server = conf.find((d) => d.name === 'server')!;
    const corp = (l: LocationView) => l.headers.find((h) => h.name.toLowerCase() === 'cross-origin-resource-policy')?.value;
    const content = locations(server).filter((l) => !l.proxied);
    expect(Object.fromEntries(content.map((l) => [l.path, corp(l)]))).toEqual({ '= /healthz': 'same-origin', [WIDGET_SCRIPT]: 'cross-origin', '/assets/': 'same-origin', '/': 'same-origin' });
    expect(widgetScriptHeaders).toEqual({ ...webSecurityHeaders, 'Cross-Origin-Resource-Policy': 'cross-origin' });
    const widget = server.block!.find((d) => d.name === 'location' && d.args.join(' ') === WIDGET_SCRIPT)!.block!;
    // a missing script is a 404, never index.html served as a script
    expect(widget.find((d) => d.name === 'try_files')?.args).toEqual(['$uri', '=404']);
    expect(locations(server).find((l) => l.path === WIDGET_SCRIPT)!.headers.find((h) => h.name === 'Cache-Control')?.value).toBe('public, max-age=300');
  });

  it('module 22: /api/ passes the API\'s CORS through unchanged: nginx adds, hides or rewrites no Access-Control-* header, answers no preflight itself, and keeps the Origin the API checks', () => {
    const server = conf.find((d) => d.name === 'server')!;
    const api = server.block!.find((d) => d.name === 'location' && d.args.join(' ') === '/api/')!.block!;
    const flat = (b: Directive[]): Directive[] => b.flatMap((d) => [d, ...flat(d.block ?? [])]);
    const all = flat(api);
    expect(all.filter((d) => /^(add_header|more_set_headers|more_clear_headers|proxy_hide_header|proxy_ignore_headers|proxy_pass_header)$/.test(d.name))).toEqual([]);
    expect(all.filter((d) => /^(if|return|limit_except)$/.test(d.name))).toEqual([]);
    expect(all.filter((d) => d.name === 'proxy_set_header' && /^origin$/i.test(d.args[0] ?? ''))).toEqual([]);
    expect(JSON.stringify(flat(server.block!))).not.toMatch(/access-control/i);
    expect(all.some((d) => d.name === 'proxy_pass')).toBe(true);
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

/** Directives of a block and of every block nested in it. */
const flatten = (b: Directive[]): Directive[] => b.flatMap((d) => [d, ...flatten(d.block ?? [])]);

/** An IPv4 or IPv6 CIDR (or single address) lies inside the private, loopback or link-local ranges. */
function privateRange(v: string): boolean {
  const [addr = '', bits] = v.split('/');
  const n = bits === undefined ? null : Number(bits);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) {
    const [a = 0, b = 0] = addr.split('.').map(Number);
    const min = a === 10 ? 8 : a === 172 && b >= 16 && b <= 31 ? 12 : a === 192 && b === 168 ? 16 : a === 127 ? 8 : a === 169 && b === 254 ? 16 : null;
    return min !== null && (n === null || n >= min);
  }
  const lower = addr.toLowerCase();
  if (lower === '::1') return n === null || n === 128;
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return n === null || n >= 7;
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return n === null || n >= 10;
  return false;
}

describe('the client address the API counts (finding chat-xff-ratelimit-bypass)', () => {
  const conf = parse(read('deploy/nginx.conf'), includeFromImage);
  const server = conf.find((d) => d.name === 'server')!;
  const all = flatten(conf);

  it('nginx states the client in X-Forwarded-For, replacing whatever the client sent: it never appends to a client-written header ($proxy_add_x_forwarded_for)', () => {
    const api = server.block!.find((d) => d.name === 'location' && d.args.join(' ') === '/api/')!.block!;
    const xff = flatten(api).filter((d) => d.name === 'proxy_set_header' && /^x-forwarded-for$/i.test(d.args[0] ?? ''));
    expect(xff.map((d) => d.args[1])).toEqual(['$remote_addr']);
    expect(JSON.stringify(all)).not.toContain('proxy_add_x_forwarded_for');
  });

  it('behind the TLS load balancer the client is the right-most address no trusted hop added (real_ip, recursive), and only private-network hops are trusted: never every address', () => {
    expect(all.filter((d) => d.name === 'real_ip_header').map((d) => d.args)).toEqual([['X-Forwarded-For']]);
    expect(all.filter((d) => d.name === 'real_ip_recursive').map((d) => d.args)).toEqual([['on']]);
    const from = all.filter((d) => d.name === 'set_real_ip_from').map((d) => d.args[0]!);
    expect(from.length).toBeGreaterThan(0);
    for (const r of from) expect(privateRange(r), r).toBe(true);
    // the checker refuses ranges that would trust the internet
    for (const r of ['0.0.0.0/0', '::/0', '8.0.0.0/8', '172.0.0.0/8', 'unix:']) expect(privateRange(r), r).toBe(false);
  });
});

/** The map that names what the access log writes for a path (`map $uri $log_uri { ... }`), applied like nginx does. */
function logUri(conf: Directive[], uri: string): string {
  const map = conf.find((d) => d.name === 'map' && d.args[0] === '$uri' && d.args[1] === '$log_uri');
  if (!map?.block) throw new Error('no map $uri $log_uri');
  for (const d of map.block) {
    if (d.name === 'default') continue;
    if (!d.name.startsWith('~')) throw new Error(`map entry ${d.name} is not a regular expression`);
    const m = new RegExp(d.name.slice(1)).exec(uri);
    if (!m) continue;
    return (d.args[0] ?? '').replace(/\$\{([a-z_]+)\}|\$([a-z_]+)/g, (_, a: string | undefined, b: string | undefined) => m.groups?.[(a ?? b)!] ?? '');
  }
  const def = map.block.find((d) => d.name === 'default')?.args[0];
  if (def !== '$uri') throw new Error('the map must default to $uri');
  return uri;
}

describe('the access log carries no capability (finding chat-token-in-access-log)', () => {
  const conf = parse(read('deploy/nginx.conf'), includeFromImage);
  const server = conf.find((d) => d.name === 'server')!;
  // Capability URLs: a secret in the PATH is the request's only authority (module 22's chat session token, polled
  // every few seconds; the RFC 8058 one-click unsubscribe ref; a lead source's intake token).
  const SECRET = 'TF6MynTkfd1czegmGiWVTVMYLhFWd6UJwMOXyzDEWxM';
  const capability = [
    [`/api/public/chat/session/${SECRET}/poll`, '/api/public/chat/session/-/poll'],
    [`/api/public/chat/session/${SECRET}/messages`, '/api/public/chat/session/-/messages'],
    [`/api/public/chat/session/${SECRET}`, '/api/public/chat/session/-'],
    [`/api/email/unsubscribe/${SECRET}`, '/api/email/unsubscribe/-'],
    [`/api/intake/${SECRET}`, '/api/intake/-'],
  ] as const;

  it('every access_log writes the format whose path is $log_uri, never the raw path or the query string', () => {
    const logs = flatten(conf).filter((d) => d.name === 'access_log' && d.args[0] !== 'off');
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) expect(l.args[1]).toBe('combined_noquery');
    const format = conf.find((d) => d.name === 'log_format' && d.args[0] === 'combined_noquery')!.args.slice(1).join(' ');
    expect(format).toContain('$log_uri');
    expect(format).not.toMatch(/\$(uri|request_uri|request|args|query_string|arg_[a-z_]+)\b/);
    expect(server.block!.some((d) => d.name === 'access_log')).toBe(true);
  });

  it('a chat session token, an unsubscribe ref and an intake token are logged as "-"; other paths as they are', () => {
    for (const [uri, logged] of capability) {
      expect(logUri(conf, uri), uri).toBe(logged);
      expect(logUri(conf, uri)).not.toContain(SECRET);
    }
    for (const uri of ['/', '/assets/app.3f2a.js', '/api/contacts/018f0000-0000-7000-8000-000000000001/thread', '/api/public/chat/wk_0123456789abcdef0123456789abcdef01234567', '/widget/chat.js']) expect(logUri(conf, uri), uri).toBe(uri);
  });
});

// Deploy rehearsal (docker-compose.prod.yml with fakes): each of these broke the running stack.
describe('the container stack (Dockerfile, docker-compose.prod.yml, deploy/nginx.conf)', () => {
  const conf = parse(read('deploy/nginx.conf'), includeFromImage);
  const server = conf.find((d) => d.name === 'server')!;
  const block = (p: string) => server.block!.find((d) => d.name === 'location' && d.args.join(' ') === p)!.block!;
  const stage = (name: string) => {
    const lines = read('Dockerfile').split('\n');
    const start = lines.findIndex((l) => new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${name}\\s*$`, 'i').test(l));
    const end = lines.findIndex((l, i) => i > start && /^FROM\s/i.test(l));
    return lines.slice(start, end < 0 ? undefined : end).join('\n');
  };

  it('/api/ re-resolves the API name: a variable upstream plus a resolver (a literal upstream kept a recreated api container’s old address: 502 until web restarted)', () => {
    const api = block('/api/');
    const pass = api.find((d) => d.name === 'proxy_pass')!.args[0]!;
    expect(pass).toMatch(/^\$[a-z_]+$/);
    expect(api.find((d) => d.name === 'set' && d.args[0] === pass)?.args[1]).toBe('http://${API_UPSTREAM}');
    expect(api.find((d) => d.name === 'resolver')?.args[0]).toBe('${NGINX_RESOLVER}');
    expect(stage('web')).toMatch(/^ENV .*NGINX_RESOLVER=127\.0\.0\.11/m);
  });

  it('hashed assets send Cache-Control once (no `expires`, which added a second Cache-Control header)', () => {
    for (const d of server.block!) if (d.name === 'location') expect(d.block!.some((x) => x.name === 'expires'), d.args.join(' ')).toBe(false);
  });

  it('module 37: the image holds the chat widget script: the build stage builds vite.widget.config.ts (dist/widget/chat.js) after the app, and the web stage serves apps/web/dist', () => {
    const build = stage('build');
    const app = build.indexOf('exec vite build \\');
    const widget = build.indexOf('exec vite build -c vite.widget.config.ts');
    expect(app).toBeGreaterThan(0);
    // after the app build, which empties dist/ (the widget build empties only dist/widget)
    expect(widget).toBeGreaterThan(app);
    const cfg = read('apps/web/vite.widget.config.ts');
    expect(cfg).toMatch(/outDir: resolve\(here, 'dist\/widget'\)/);
    expect(cfg).toMatch(/fileName: \(\) => 'chat\.js'/);
    expect(stage('web')).toMatch(/^COPY --from=build \/app\/apps\/web\/dist \/usr\/share\/nginx\/html$/m);
  });

  it('the web image serves no source maps (/assets/*.js.map was public: the whole client source)', () => {
    expect(stage('web')).toMatch(/^RUN find \/usr\/share\/nginx\/html -name '\*\.map' -delete$/m);
  });

  it('STORAGE_PROVIDER=local has a writable, persistent STORAGE_DIR: owned by node in the api image and a named volume on api and worker', () => {
    const dir = '/var/lib/realty/storage';
    expect(stage('api')).toContain(`RUN mkdir -p ${dir} && chown node:node ${dir}`);
    const compose = read('docker-compose.prod.yml');
    for (const svc of ['api', 'worker']) {
      const body = new RegExp(`^  ${svc}:\\n((?:    .*\\n|\\s*\\n)*)`, 'm').exec(compose)?.[1] ?? '';
      expect(body, svc).toContain(`- storage:${dir}`);
    }
    expect(compose).toMatch(/^volumes:\n(?: {2}\S+:\n)*? {2}storage:$/m);
    for (const f of ['deploy/env.production.example', 'deploy/env.staging.example']) expect(read(f), f).toMatch(new RegExp(`^STORAGE_DIR=${dir}$`, 'm'));
  });
});
