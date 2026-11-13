// b13 integration: the AI ISA API tests that need an initiated-tier send (a first outreach, a facts message, a
// follow-up) used to fail on a Sunday from 06:00 to 21:59 UTC or on a US federal holiday, because the guard, core's
// gate and the send window read the database's now() (there is no fake clock). initiatedDayNow() (testing.ts) opens
// today for one case and puts everything back, as packages/db/test's initiatedDayNow does for the DB cases. These
// cases force today to be a refused day (a Sunday: today's weekday out of the pack and the policy; a holiday: today in
// app.ai_isa_us_federal_holiday and the API's calendar) and check that the first outreach waits outside the helper,
// goes out inside it, and that each piece is restored. Fakes only.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { holidaysAround, setIsaHolidayTestCalendar } from './coreSeam.js';
import { aiMessages, forceRefusedToday, grantInitiated, initiatedDayNow, isaLead, isaWorld, type IsaWorld, openZone, runIsa, startCare } from './testing.js';

let h: ApiHarness;
let w: IsaWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await isaWorld(h);
});
afterAll(async () => {
  await h?.close();
});

const today = async (zone: string) => (await h.su.query<{ d: string; dow: number; now: Date }>(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d,
  extract(isodow FROM now() AT TIME ZONE $1)::int AS dow, now() AS now`, [zone])).rows[0]!;
const packDays = async () => (await h.su.query<{ days: number[] | null }>(`SELECT rules->'initiated_days' AS days FROM jurisdiction_packs WHERE key = 'platform:ai_isa'`)).rows[0]!.days;
const policyDays = async () => (await h.su.query<{ days: number[] }>(`SELECT steps->'initiatedDays' AS days FROM playbook_versions WHERE id = $1`, [w.versionId])).rows[0]!.days;
const holidayDef = async () => (await h.su.query<{ def: string }>(`SELECT pg_get_functiondef('app.ai_isa_us_federal_holiday(date)'::regprocedure) AS def`)).rows[0]!.def;
const dbHoliday = async (d: string) => (await h.su.query<{ x: boolean }>(`SELECT app.ai_isa_us_federal_holiday($1::date) AS x`, [d])).rows[0]!.x;

/** A lead with the initiated tier (own-form written consent) put in care; the start turn and its dispatch run. */
async function started() {
  const l = await isaLead(h, w.agents[0]!);
  await grantInitiated(h, w.tenantId, l);
  expect((await startCare(w.agents[0]!, l.id)).status).toBe(200);
  await runIsa(h, w.tenantId);
  return aiMessages(h, l.id);
}

/** Runs `fn` with the pack, the policy, the holiday function and the API calendar as they are now, and puts them back. */
async function restoring(fn: () => Promise<void>) {
  const rules = (await h.su.query<{ rules: unknown }>(`SELECT rules FROM jurisdiction_packs WHERE key = 'platform:ai_isa'`)).rows[0]!.rules;
  const steps = (await h.su.query<{ steps: unknown }>(`SELECT steps FROM playbook_versions WHERE id = $1`, [w.versionId])).rows[0]!.steps;
  const def = await holidayDef();
  try {
    await fn();
  } finally {
    setIsaHolidayTestCalendar({});
    await h.su.query(def);
    await h.su.query(`DROP FUNCTION IF EXISTS app.ai_isa_us_federal_holiday_forced(date)`);
    await h.su.query(`UPDATE jurisdiction_packs SET rules = $1::jsonb WHERE key = 'platform:ai_isa'`, [JSON.stringify(rules)]);
    const c = await h.su.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('UPDATE playbook_versions SET steps = $2::jsonb WHERE id = $1', [w.versionId, JSON.stringify(steps)]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  }
}

describe('b13 integration: initiatedDayNow opens today for an initiated AI send and puts everything back (R-ISA-10)', () => {
  it('the baseline the forced days break: the first outreach of a lead with the initiated tier goes out today (on a real Sunday or holiday, through the helper)', async () => {
    expect((await initiatedDayNow(h, w.tenantId, openZone(), () => started())).some((m) => m.status === 'sent')).toBe(true);
  });

  it('a forced Sunday (today\'s weekday out of the pack\'s initiated_days and the policy\'s initiatedDays): the first outreach waits; inside initiatedDayNow it goes out; both lists are put back', async () => {
    await restoring(async () => {
      const zone = openZone();
      const t = await today(zone);
      await forceRefusedToday(h, 'sunday', w.tenantId);
      const forcedPack = await packDays();
      expect(forcedPack).not.toContain(t.dow);
      expect(await policyDays()).not.toContain(t.dow);
      const waiting = await started();
      expect(waiting.some((m) => m.status === 'sent')).toBe(false);
      expect(waiting.some((m) => m.status === 'scheduled')).toBe(true);
      const inside = await initiatedDayNow(h, w.tenantId, zone, async () => ({ pack: await packDays(), policy: await policyDays(), msgs: await started() }));
      expect(inside.pack).toContain(t.dow);
      expect(inside.policy).toContain(t.dow);
      expect(inside.msgs.some((m) => m.status === 'sent')).toBe(true);
      expect(await packDays()).toEqual(forcedPack);
      expect(await policyDays()).not.toContain(t.dow);
    });
  });

  it('a forced federal holiday (today in app.ai_isa_us_federal_holiday and in the API\'s holiday calendar): the first outreach waits; inside initiatedDayNow it goes out; the function and the calendar are put back', async () => {
    await restoring(async () => {
      const zone = openZone();
      const t = await today(zone);
      await forceRefusedToday(h, 'holiday', w.tenantId);
      const forcedDef = await holidayDef();
      expect(await dbHoliday(t.d)).toBe(true);
      expect(holidaysAround(t.now.getTime() as never)).toContain(t.d);
      const waiting = await started();
      expect(waiting.some((m) => m.status === 'sent')).toBe(false);
      expect(waiting.some((m) => m.status === 'scheduled')).toBe(true);
      const inside = await initiatedDayNow(h, w.tenantId, zone, async () => ({ db: await dbHoliday(t.d), api: holidaysAround(t.now.getTime() as never).includes(t.d), msgs: await started() }));
      expect(inside.db).toBe(false);
      expect(inside.api).toBe(false);
      expect(inside.msgs.some((m) => m.status === 'sent')).toBe(true);
      expect(await holidayDef()).toBe(forcedDef);
      expect(await dbHoliday(t.d)).toBe(true);
      expect(holidaysAround(t.now.getTime() as never)).toContain(t.d);
      expect((await h.su.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'ai_isa_us_federal_holiday_api_orig'`)).rows[0]).toEqual({ n: 0 });
    });
  });

  it('the API\'s holiday calendar is core\'s outside a test, its setter refuses outside Vitest, and only test code calls it', () => {
    const at = Date.parse('2026-11-26T15:00:00Z') as never;
    expect(holidaysAround(at)).toContain('2026-11-26');
    const was = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => setIsaHolidayTestCalendar({ except: ['2026-11-26'] })).toThrow(/test-only/);
    } finally {
      process.env.VITEST = was;
    }
    expect(holidaysAround(at)).toContain('2026-11-26');
    const SRC = fileURLToPath(new URL('..', import.meta.url));
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : files(p)) : /\.ts$/.test(n) ? [p] : [];
    });
    const callers = files(SRC).filter((p) => !/\.test\.ts$/.test(p) && /setIsaHolidayTestCalendar\(/.test(readFileSync(p, 'utf8'))).map((p) => relative(SRC, p).replaceAll('\\', '/')).sort();
    expect(callers).toEqual(['isa/coreSeam.ts', 'isa/testing.ts']);
  });
});
