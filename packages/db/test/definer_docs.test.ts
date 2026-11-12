// b7 db-public/F3: every SECURITY DEFINER a migration adds since the batch 6 review is named in docs/ARCHITECTURE.md
// (the §21.1 definer catalog or a §21 security note), so a lane cannot add one the security review never sees.
// The start is found by content (the migration that adds app.webchat_sessions_follow_merge), never by file name.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dir = resolve(repo, 'packages/db/migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const text = (f: string) => readFileSync(resolve(dir, f), 'utf8');
const architecture = readFileSync(resolve(repo, 'docs/ARCHITECTURE.md'), 'utf8');

/** The functions a migration creates or replaces as SECURITY DEFINER. */
function definers(sql: string): string[] {
  const out: string[] = [];
  const re = /CREATE (?:OR REPLACE )?FUNCTION\s+([a-z_]+\.[a-z_0-9]+)\s*\(([^$]*?)\bAS\s+\$/gi;
  for (let m = re.exec(sql); m; m = re.exec(sql)) if (/SECURITY DEFINER/i.test(m[2]!)) out.push(m[1]!);
  return out;
}

describe('the definer catalog (ARCHITECTURE §21; b7 db-public/F3)', () => {
  it('b7 db-public/F3: every SECURITY DEFINER added since the batch 6 review is named in docs/ARCHITECTURE.md, the 0049 calendar trigger included', () => {
    const start = files.findIndex((f) => definers(text(f)).includes('app.webchat_sessions_follow_merge'));
    expect(start).toBeGreaterThanOrEqual(0);
    const added = files.slice(start).flatMap((f) => definers(text(f)).map((d) => `${d} (${f})`));
    expect(added.map((a) => a.split(' ')[0])).toContain('app.calendar_links_revoke_on_member_removed');
    expect(added.filter((a) => !architecture.includes(a.split(' ')[0]!))).toEqual([]);
  });
});
