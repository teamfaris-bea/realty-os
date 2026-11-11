// @vitest-environment node
// Cross-cutting checks of the web/agent module:
// - A1 tap-count proxy: every primary agent job is reachable in ≤ 2 taps on a phone and 1 click on
//   desktop for every role that may open it (the shell's nav model, from the real registry). The
//   per-job tap counts inside pages are asserted in the component tests and e2e/agent/jobs.spec.ts.
// - Copy lint (BUILD_PLAN module 17): no "AI-powered", no typing indicators, no confidence or score
//   wording, no persona name for the assistant, no fake activity (no randomness in UI code), and no
//   client-side assistant message templates (sign-offs and STOP hints are rendered server-side).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@realty/core/foundation';
import { describe, expect, it } from 'vitest';
import { defaultPageTable } from '../../shell/App.js';
import { navFor, pagesFor, tapsTo, validateRegistry } from '../../shell/pages.js';
import { surfaces } from '../../shell/registry.js';

const ROLES: Role[] = ['owner', 'admin', 'team_lead', 'agent', 'isa', 'tc'];
const JOBS: { path: string; job: string; roles: Role[] }[] = [
  { path: '/', job: 'See what is due (Priority Feed)', roles: ROLES },
  { path: '/approvals', job: 'Approve a draft or handback', roles: ROLES },
  { path: '/search', job: 'Find a contact', roles: ROLES },
  { path: '/tasks', job: 'Tasks and appointment outcomes', roles: ROLES },
  { path: '/pond', job: 'Claim from the pond', roles: ['owner', 'admin', 'team_lead', 'agent', 'isa'] },
  { path: '/deals', job: 'Deals', roles: ROLES },
  { path: '/listings', job: 'Listings', roles: ROLES },
];

describe('web/agent registration', () => {
  it('the registry with the agent surfaces is valid (no duplicate paths, sentences or evidence openers)', () => {
    expect(validateRegistry(surfaces)).toEqual([]);
  });

  it('A1: every primary agent job is ≤ 2 taps on a phone and 1 click on desktop, for every role that may open it', () => {
    const table = defaultPageTable();
    for (const role of ROLES) {
      const nav = navFor(pagesFor(table, role));
      for (const j of JOBS) {
        if (!j.roles.includes(role)) {
          expect(tapsTo(nav, j.path, 'phone'), `${role} ${j.path}`).toBeNull();
          continue;
        }
        const phone = tapsTo(nav, j.path, 'phone');
        expect(phone, `${role}: ${j.job} on a phone`).not.toBeNull();
        expect(phone!, `${role}: ${j.job} on a phone`).toBeLessThanOrEqual(2);
        expect(tapsTo(nav, j.path, 'desktop'), `${role}: ${j.job} on desktop`).toBe(1);
      }
    }
  });

  it('an agent’s phone tab bar holds the daily jobs: Home, People, Approvals, Search, Tasks (Pond, Deals, Listings under More)', () => {
    const nav = navFor(pagesFor(defaultPageTable(), 'agent'));
    // PARITY_PLAN §5: the People tab (module 61) joins Home, Approvals, Search and Tasks
    expect(nav.tabs.map((t) => t.label)).toEqual(['Home', 'People', 'Approvals', 'Search', 'Tasks']);
    expect(nav.more.map((t) => t.path)).toEqual(expect.arrayContaining(['/pond', '/deals', '/listings']));
  });

  it('the home page is the Priority Feed (0 taps after opening the app)', () => {
    const home = defaultPageTable().pages.find((p) => p.path === '/');
    expect(home?.title).toBe('Home');
    expect(home?.nav?.phone).toBe('tab');
    expect(home?.nav?.order).toBe(0);
  });
});

// ---- copy lint -------------------------------------------------------------------------------------

const here = fileURLToPath(new URL('.', import.meta.url));
const SURFACES_DIR = join(here, '..');
const MINE = ['feed', 'contact', 'thread', 'compose', 'approvals', 'pond', 'search', 'tasks', 'deals', 'listings'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'testing.ts') out.push(p);
  }
  return out;
}

/** Source without comments (so design notes that say "no confidence" don't count as copy). */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('copy lint (genuineness)', () => {
  const files = MINE.flatMap((d) => sourceFiles(join(SURFACES_DIR, d)));
  it('scans every agent surface source file', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  const BANNED: [RegExp, string][] = [
    [/AI[- ]powered/i, 'no "AI-powered"'],
    [/is typing|typing…|typing\.\.\./i, 'no fake typing indicators'],
    [/confiden/i, 'no confidence anywhere (R-AST-13)'],
    [/\bscore\b/i, 'no scores in agent UI'],
    [/\b(?:Aria|Ava the|Sophie|Jarvis|Max the)\b/, 'the assistant has no persona name'],
    [/Math\.random|crypto\.getRandomValues/, 'no randomness in UI (no fake activity)'],
    [/Reply STOP|STOP to opt out/i, 'sign-offs and STOP hints are rendered server-side, never by the web'],
    [/\bthe AI\b|\bour AI\b/, 'the AI is "the assistant"'],
  ];
  for (const [re, why] of BANNED) {
    it(why, () => {
      const hits = files.filter((f) => re.test(code(readFileSync(f, 'utf8')))).map((f) => f.slice(SURFACES_DIR.length + 1));
      expect(hits).toEqual([]);
    });
  }

  it('the assistant is always "the assistant" in copy (no "AI" as a name)', () => {
    const literals = files.flatMap((f) => [...code(readFileSync(f, 'utf8')).matchAll(/(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g)].map((m) => m[2] ?? ''));
    const mentions = literals.filter((s) => /\bAI\b/.test(s));
    expect(mentions).toEqual([]);
    expect(literals.some((s) => /the assistant/.test(s))).toBe(true);
  });
});
