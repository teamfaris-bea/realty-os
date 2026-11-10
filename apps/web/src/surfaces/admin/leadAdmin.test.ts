// @vitest-environment node
// Cross-cutting checks of the web/lead-admin module (team, admin, imports, settings surfaces):
// - Tap-count proxy: every lead-admin page is 1 click on desktop and ≤ 2 taps on a phone (More → page)
//   for every role that may open it, and is not in navigation for roles that may not (the server
//   still answers 404 for them, R-PERM-5). In-page job counts (reassign = 2 taps from the exception)
//   are asserted in the component tests and e2e/lead-admin.
// - Copy lint (BUILD_PLAN module 17 genuineness): no "AI-powered", no typing indicators, no confidence
//   or score wording, no persona name, no randomness in UI code, the assistant is "the assistant", and
//   every legal-parameter page carries the counsel wording.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@realty/core/foundation';
import { describe, expect, it } from 'vitest';
import { defaultPageTable } from '../../shell/App.js';
import { navFor, pagesFor, tapsTo, validateRegistry } from '../../shell/pages.js';
import { surfaces } from '../../shell/registry.js';

const ROLES: Role[] = ['owner', 'admin', 'team_lead', 'agent', 'isa', 'tc'];
const ADMINS: Role[] = ['owner', 'admin'];
const PAGES: { path: string; job: string; roles: Role[] }[] = [
  { path: '/team', job: 'Team Lead exception queue', roles: ['owner', 'admin', 'team_lead'] },
  { path: '/team/scoreboard', job: 'Scoreboard and momentum', roles: ['owner', 'admin', 'team_lead', 'agent', 'isa'] },
  { path: '/settings/playbooks', job: 'Playbooks', roles: ['owner', 'admin', 'team_lead', 'agent', 'isa'] },
  { path: '/admin/members', job: 'Members, invites and teams', roles: ADMINS },
  { path: '/admin/routing', job: 'Routing rules, ponds, lead timers', roles: ADMINS },
  { path: '/admin/numbers', job: 'Numbers and domains', roles: ADMINS },
  { path: '/settings/compliance', job: 'Compliance policy', roles: ADMINS },
  { path: '/settings/team', job: 'Brokerage identity and team settings', roles: ADMINS },
  { path: '/imports', job: 'Imports', roles: ADMINS },
];

describe('web/lead-admin registration', () => {
  it('the registry with the lead-admin surfaces is valid (no duplicate paths, sentences or evidence openers)', () => {
    expect(validateRegistry(surfaces)).toEqual([]);
  });

  it('every lead-admin page is 1 click on desktop and ≤ 2 taps on a phone for each role that may open it, and absent for the others', () => {
    const table = defaultPageTable();
    for (const role of ROLES) {
      const nav = navFor(pagesFor(table, role));
      for (const p of PAGES) {
        if (!p.roles.includes(role)) {
          expect(tapsTo(nav, p.path, 'phone'), `${role} ${p.path}`).toBeNull();
          expect(tapsTo(nav, p.path, 'desktop'), `${role} ${p.path}`).toBeNull();
          continue;
        }
        const phone = tapsTo(nav, p.path, 'phone');
        expect(phone, `${role}: ${p.job} on a phone`).not.toBeNull();
        expect(phone!, `${role}: ${p.job} on a phone`).toBeLessThanOrEqual(2);
        expect(tapsTo(nav, p.path, 'desktop'), `${role}: ${p.job} on desktop`).toBe(1);
      }
    }
  });

  it("the lead-admin pages never take an agent's daily phone tabs", () => {
    for (const role of ROLES) expect(navFor(pagesFor(defaultPageTable(), role)).tabs.map((t) => t.label)).toEqual(['Home', 'Approvals', 'Search', 'Tasks']);
  });

  it('desktop groups them: Team (queue, scoreboard, playbooks) and Admin (members … imports)', () => {
    const nav = navFor(pagesFor(defaultPageTable(), 'owner'));
    const group = (s: string) => nav.sidebar.find((g) => g.section === s)?.items.map((i) => i.path) ?? [];
    expect(group('team')).toEqual(['/team', '/team/scoreboard', '/settings/playbooks']);
    expect(group('admin')).toEqual(['/admin/members', '/admin/routing', '/admin/numbers', '/settings/compliance', '/settings/team', '/imports']);
  });
});

// ---- copy lint -------------------------------------------------------------------------------------

const here = fileURLToPath(new URL('.', import.meta.url));
const SURFACES_DIR = join(here, '..');
const MINE = ['team', 'admin', 'imports', 'settings'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/^testing\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Source without comments (so design notes that say "no confidence" don't count as copy). */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('copy lint (genuineness)', () => {
  const files = MINE.flatMap((d) => sourceFiles(join(SURFACES_DIR, d)));
  const read = (suffix: string) => code(readFileSync(files.find((f) => f.endsWith(suffix))!, 'utf8'));

  it('scans every lead-admin source file', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  const BANNED: [RegExp, string][] = [
    [/AI[- ]powered/i, 'no "AI-powered"'],
    [/is typing|typing…|typing\.\.\./i, 'no fake typing indicators'],
    [/confiden/i, 'no confidence anywhere (assistant evidence over scores)'],
    [/\bscores?\b/i, 'no scores'],
    [/\b(?:Aria|Ava the|Sophie|Jarvis|Max the)\b/, 'the assistant has no persona name'],
    [/Math\.random|crypto\.getRandomValues/, 'no randomness in UI (no fake activity)'],
    [/\bthe AI\b|\bour AI\b/, 'the AI is "the assistant"'],
    [/\blive now\b|\breal[- ]time\b/i, 'no claims of live activity the page does not have'],
  ];
  for (const [re, why] of BANNED) {
    it(why, () => {
      const hits = files.filter((f) => re.test(code(readFileSync(f, 'utf8')))).map((f) => f.slice(SURFACES_DIR.length + 1));
      expect(hits).toEqual([]);
    });
  }

  it('the assistant is always "the assistant" in copy (no "AI" as a name)', () => {
    const literals = files.flatMap((f) => [...code(readFileSync(f, 'utf8')).matchAll(/(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g)].map((m) => m[2] ?? ''));
    expect(literals.filter((s) => /\bAI\b/.test(s))).toEqual([]);
    expect(literals.some((s) => /the assistant/.test(s))).toBe(true);
  });

  it('the legal-parameter pages say plainly that counsel has not reviewed them (VERIFY WITH COUNSEL)', () => {
    expect(read('admin/lib/ui.tsx')).toContain('Not reviewed by counsel');
    expect(read('settings/CompliancePage.tsx')).toContain('CounselBanner');
    expect(read('settings/CompliancePage.tsx')).toContain('This wording has not been reviewed by counsel.');
    expect(read('settings/TeamSettingsPage.tsx')).toMatch(/Check with counsel/);
  });

  it('the queue does not pretend to be live: it says when it was updated', () => {
    expect(read('team/TeamPage.tsx')).toContain('Updated {formatStamp(q.data.generatedAt)}');
  });
});
