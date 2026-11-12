// Trying to break coaching trends (module 54): tenancy, scope past the routes, the query surface, and the source rules
// (R-COACH-5, R-COACH-7, R-COACH-8; R-TEN-1).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../../auth/testHarness.js';
import { type CoachingWorld, actorOf, call, coachingWorld, scoringOn, setPackCleared } from '../testing.js';
import { trendRows } from './repos/trends.js';

let h: ApiHarness;
let a: CoachingWorld;
let b: CoachingWorld;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  a = await coachingWorld(h);
  b = await coachingWorld(h);
  await setPackCleared(h, true);
  await scoringOn(h, a.owner);
  await scoringOn(h, b.owner);
}, 240_000);
afterAll(async () => {
  await setPackCleared(h, false).catch(() => undefined);
  await h?.close();
});

describe('coaching trends: adversarial (R-COACH-8)', () => {
  it('R-TEN-1 R-COACH-8: another tenant\'s Owner never sees this tenant\'s members, and the definer refuses their ids outright', async () => {
    const t = await call<{ trends: { members: { userId: string }[] } }>(b.owner, 'GET', '/coaching/trends/team');
    const ids = t.body.trends.members.map((m) => m.userId);
    for (const m of [a.owner, ...a.agents, a.teamLead!]) expect(ids).not.toContain(m.userId);
    await expect(withTenantTx(actorOf(b.owner), (tx) => trendRows(tx, [a.agents[0]!.userId!], 1, 'rubric/1'), { db: h.database })).rejects.toThrow(/COACHING_TRENDS_SCOPE/);
  });

  it('R-COACH-8: past the routes, a Team Lead with the switch off and an agent are refused by the definer for anyone but themselves', async () => {
    const other = a.agents[0]!.userId!;
    await expect(withTenantTx(actorOf(a.teamLead!), (tx) => trendRows(tx, [other], 1, 'rubric/1'), { db: h.database })).rejects.toThrow(/COACHING_TRENDS_SCOPE/);
    await expect(withTenantTx(actorOf(a.agents[1]!), (tx) => trendRows(tx, [other], 4, 'rubric/1'), { db: h.database })).rejects.toThrow(/COACHING_TRENDS_SCOPE/);
    expect(await withTenantTx(actorOf(a.agents[1]!), (tx) => trendRows(tx, [a.agents[1]!.userId!], 4, 'rubric/1'), { db: h.database })).toEqual([]);
  });

  it('R-COACH-8: the query takes weeks only, 1 to 4; anything else is refused before any read', async () => {
    for (const q of ['weeks=1%3BDROP', 'weeks=1.5', 'weeks=-1', 'weeks=1&weeks=2', 'agentUserId=x', 'rubric=rubric%2F2']) {
      expect((await call(a.owner, 'GET', `/coaching/trends/team?${q}`)).status, q).toBe(422);
    }
    expect((await call(a.owner, 'GET', '/coaching/trends/team')).status).toBe(200);
  });

  it('R-COACH-5 R-COACH-7: trends/** never names the scores table, and only trends/repos/trends.ts calls app.coaching_trends', () => {
    const src = fileURLToPath(new URL('../..', import.meta.url));
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? (n === 'node_modules' || n === '__snapshots__' ? [] : walk(p)) : /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
    });
    const files = walk(src).map((p) => ({ rel: relative(src, p).replaceAll('\\', '/'), text: readFileSync(p, 'utf8') }));
    expect(files.filter((f) => f.rel.startsWith('coaching/trends/') && /\bcall_scores\b/.test(f.text)).map((f) => f.rel)).toEqual([]);
    expect(files.filter((f) => /app\.coaching_trends\s*\(/.test(f.text)).map((f) => f.rel)).toEqual(['coaching/trends/repos/trends.ts']);
  });
});
