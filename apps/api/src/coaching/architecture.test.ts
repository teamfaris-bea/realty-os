// R-COACH-5 architecture test (module 36): call scores and tips never feed routing, ownership, prediction,
// the scoreboard or any automatic consequence.
//   1. No file in the routing, ownership, offers/ponds, feed scoring, scoreboard, exceptions, assistant
//      automation or prediction code imports api/coaching or core/coaching (core's own test covers core).
//   2. Outside api/coaching (and the schema, migrations and tests), no source file names call_scores at all,
//      so no other path can read a review.
//   3. api/coaching itself writes nothing but its own rows: no SQL in it inserts into or updates routing,
//      ownership, offers, ponds, contacts, tasks, messages or the scoreboard, and it never calls the
//      ownership engine, the outbound paths or the routing engine.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = resolve(here, '..');
const repo = resolve(apiSrc, '../../..');

function files(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__snapshots__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(files(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const isTest = (f: string) => /\.test\.tsx?$/.test(f) || /\/testing(\.ts|\/)/.test(f) || f.endsWith('/testing.ts');
const specs = (src: string) => [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
const COACHING = /(^|[/@])coaching(\/|\.js$|$)/;

/** Code that routes leads, moves ownership, scores the feed, keeps the scoreboard or acts on its own. */
const GUARDED = ['leads', 'accountability', 'ownership', 'imports', 'bulk', 'stageAutomation', 'predict', 'comms', 'channels', 'leadEmail', 'people', 'duplicates'].map((d) => join(apiSrc, d));
const GUARDED_FILES = ['workspace/feed.ts', 'workspace/feedJob.ts', 'workspace/repos/feedInputs.ts', 'assistant/firstResponse.ts', 'assistant/enrollments.ts', 'assistant/playbooks.ts', 'assistant/steps.ts'].map((f) => join(apiSrc, f));

describe('R-COACH-5 nothing from coaching reaches routing or ownership', () => {
  it('R-COACH-5: no routing, ownership, feed-scoring, scoreboard, automation or prediction file imports coaching', () => {
    const present = GUARDED.filter((d) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
    expect(present.map((d) => relative(apiSrc, d))).toEqual(expect.arrayContaining(['leads', 'accountability', 'comms']));
    const scanned = [...present.flatMap(files), ...GUARDED_FILES];
    expect(scanned.length).toBeGreaterThan(50);
    const offenders = scanned.flatMap((f) => specs(readFileSync(f, 'utf8')).filter((s) => COACHING.test(s)).map((s) => `${relative(repo, f)}: ${s}`));
    expect(offenders).toEqual([]);
  });

  it('R-COACH-5: outside api/coaching no source file reads or writes call_scores', () => {
    const offenders = files(apiSrc)
      .filter((f) => !f.startsWith(join(apiSrc, 'coaching') + '/') && !isTest(f))
      .filter((f) => /\bcall_scores\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(repo, f));
    expect(offenders).toEqual([]);
  });

  it('R-COACH-5: api/coaching writes only its own rows and never calls the ownership engine, routing or an outbound path', () => {
    const src = files(join(apiSrc, 'coaching')).filter((f) => !isTest(f));
    expect(src.length).toBeGreaterThanOrEqual(8);
    const bad: string[] = [];
    const WRITE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/gi;
    const ALLOWED_WRITES = new Set(['call_scores', 'ai_runs', 'priority_feed_items', 'tenant_settings']);
    const FORBIDDEN_CALLS = /\b(applyOwnershipCommand|dispatchOutbound|dialOutbound|routeLead|offerLead|createOffer|recomputeScoreboard|enqueueStep)\b/;
    for (const f of src) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(WRITE)) if (!ALLOWED_WRITES.has((m[1] as string).toLowerCase()) && !/^(set|the|its|a)$/i.test(m[1] as string)) bad.push(`${relative(repo, f)}: writes ${m[1]}`);
      const call = FORBIDDEN_CALLS.exec(text);
      if (call) bad.push(`${relative(repo, f)}: calls ${call[1]}`);
      for (const s of specs(text)) if (/\/(leads|ownership|accountability|imports|bulk|stageAutomation)\//.test(s) || /@realty\/core\/(ownership|priority|predict)/.test(s)) bad.push(`${relative(repo, f)}: imports ${s}`);
    }
    expect(bad).toEqual([]);
  });

  it('the checks catch what they are meant to catch', () => {
    expect(specs("import { x } from '../coaching/fix.js';\nconst m = await import('@realty/core/coaching');").filter((s) => COACHING.test(s))).toEqual(['../coaching/fix.js', '@realty/core/coaching']);
    expect([...'INSERT INTO lead_offers (x) UPDATE contacts SET'.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/gi)].map((m) => m[1])).toEqual(['lead_offers', 'contacts']);
  });
});
