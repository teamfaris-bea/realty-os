// api/coaching role × route matrix against core.can(), the route table, and the response-schema snapshot
// (module 36; DATA_MODEL Part 2 rows "Call reviews" and "Coaching settings"; R-COACH-6, R-AST-13, R-TEN-3).
import { type Action, type Role, can } from '@realty/core/foundation';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import * as S from './schemas.js';
import { actorOf, call, coachingWorld, freshReauth, setPackCleared } from './testing.js';

let h: ApiHarness;
const users = {} as Record<Role, TestClient>;

beforeAll(async () => {
  h = await createApiHarness();
  await setPackCleared(h, false);
  const w = await coachingWorld(h);
  users.owner = w.owner;
  users.agent = w.agents[0]!;
  users.team_lead = w.teamLead!;
  for (const role of ['admin', 'isa', 'tc'] as const) users[role] = await h.invite(w.owner, role);
  for (const c of Object.values(users)) await freshReauth(h, c);
});
afterAll(async () => {
  await h?.close();
});

const ROUTES: { method: 'GET' | 'POST' | 'PUT'; url: string; action: Action; facts: Record<string, unknown>; body?: unknown }[] = [
  { method: 'GET', url: '/coaching/today', action: 'coaching.view', facts: { own: true } },
  { method: 'GET', url: '/coaching/team', action: 'coaching.team_view', facts: { team: true } },
  { method: 'GET', url: '/admin/coaching', action: 'coaching.settings', facts: { loosening: false } },
  // the one request every role that may change these settings may make: call reviews off (already off: a no-op)
  { method: 'PUT', url: '/admin/coaching', action: 'coaching.settings', facts: { loosening: false }, body: { scoringEnabled: false } },
];

describe('coaching routes × roles', () => {
  it('R-COACH-3 E283: every coaching route answers each role exactly as core.can() decides (Call reviews: own calls; team view Owner/Admin/TL; settings Owner, and Admins only to turn call reviews off)', async () => {
    const got: string[] = [];
    for (const role of Object.keys(users) as Role[]) {
      for (const r of ROUTES) {
        const want = can(actorOf(users[role]), r.action, { ...r.facts, reauth: { reauthenticatedAt: Date.now() as never, now: Date.now() as never } }).ok;
        const res = await call(users[role], r.method, r.url, r.body);
        expect({ role, url: `${r.method} ${r.url}`, ok: res.status === 200 }).toEqual({ role, url: `${r.method} ${r.url}`, ok: want });
        if (!want) expect(res.status).toBe(404);
        got.push(`${role} ${r.method} ${r.url} ${res.status}`);
      }
    }
    expect(got.filter((g) => g.startsWith('tc ')).every((g) => g.endsWith('404'))).toBe(true);
    expect(got.filter((g) => g.includes('/admin/coaching') && g.endsWith(' 200')).map((g) => g.split(' ')[0])).toEqual(['owner', 'owner', 'admin', 'admin']);
  });

  it('every coaching route carries authorize(<its action>)', () => {
    const rows = h.app.platform.routeTable.filter((r) => r.method !== 'HEAD' && /^\/api\/(coaching|admin\/coaching)/.test(r.url));
    expect(rows.map((r) => `${r.method} ${r.url} → ${r.auth}`).sort()).toEqual([
      'GET /api/admin/coaching → coaching.settings',
      'GET /api/coaching/team → coaching.team_view',
      'GET /api/coaching/today → coaching.view',
      'POST /api/coaching/today/dismiss → coaching.view',
      'PUT /api/admin/coaching → coaching.settings',
    ]);
    for (const r of rows) expect(r.authorizes).toBe(r.auth);
  });
});

describe('response schemas', () => {
  const schemas = { TodayResponse: S.TodayResponse, TeamResponse: S.TeamResponse, SettingsResponse: S.SettingsResponse, SettingsBody: S.SettingsBody };
  const keys = (v: unknown, out = new Set<string>()): Set<string> => {
    if (Array.isArray(v)) for (const x of v) keys(x, out);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      if (k === 'properties' && x && typeof x === 'object') for (const p of Object.keys(x)) out.add(p);
      keys(x, out);
    }
    return out;
  };

  it('R-COACH-6 R-AST-13 R-TEN-3: no score, grade, rank, percentage, tone, sentiment, confidence or tenant id field in any coaching schema (snapshot)', () => {
    const json = Object.fromEntries(Object.entries(schemas).map(([k, s]) => [k, z.toJSONSchema(s)]));
    const fields = [...keys(json)].sort();
    // metCount/scoredCount are not even exposed: the pages show calls counted, never checks per call
    expect(fields.filter((f) => /score|grade|rank|percent|sentiment|tone|overall|leader|confidence|tenant/i.test(f) && f !== 'scoringEnabled' && f !== 'tlSeesCallScores' && f !== 'scoringSentence')).toEqual([]);
    expect(fields).toMatchSnapshot();
  });
});
