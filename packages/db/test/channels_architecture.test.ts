// R-GATE-13 architecture test (module 19, core/compliance-v3; E80): core's Channel union, the `messages.channel` CHECK,
// the consent/suppression channel CHECKs, the point-kind CHECKs and the explicit map inside `app.messages_dispatch_guard`
// are the same lists. They are read from a freshly migrated database's catalog (whatever migration last defined them),
// so adding a channel in one place and not the others fails here.
import { CHANNELS, MESSAGE_CHANNEL_MAP, MESSAGE_CHANNELS, PLATFORM_CHANNELS, POINT_KINDS, channelsOfKind, pointKindOf } from '@realty/core/compliance';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../src/testing/index.js';

let db: TestDb;
let client: pg.Client;
beforeAll(async () => {
  db = await createTestDb();
  client = new pg.Client({ connectionString: db.ownerUrl });
  await client.connect();
});
afterAll(async () => {
  await client.end();
  await db.drop();
});

const quoted = (s: string): string[] => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
async function checkValues(table: string, constraint: string): Promise<string[]> {
  const r = await client.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = $1 AND t.relnamespace = 'public'::regnamespace AND c.conname = $2`,
    [table, constraint],
  );
  expect(r.rows, `${table}.${constraint}`).toHaveLength(1);
  return quoted(r.rows[0]!.def).sort();
}

describe('R-GATE-13 E80 the channel lists are equal (architecture test)', () => {
  it('core Channel union = the consent_events / consent_state channel CHECKs; + all = the suppressions CHECK', async () => {
    expect(await checkValues('consent_events', 'consent_events_channel_check')).toEqual([...CHANNELS].sort());
    expect(await checkValues('consent_state', 'consent_state_channel_check')).toEqual([...CHANNELS].sort());
    expect(await checkValues('suppressions', 'suppressions_channel_check')).toEqual([...CHANNELS, 'all'].sort());
  });

  it('core message channels = the messages.channel CHECK = the guard map, with the same consent channel and no fallthrough', async () => {
    expect(await checkValues('messages', 'messages_channel_check')).toEqual([...MESSAGE_CHANNELS].sort());
    const r = await client.query<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE oid = 'app.messages_dispatch_guard()'::regprocedure`);
    const body = r.rows[0]!.src;
    const map: Record<string, string> = {};
    for (const m of body.matchAll(/WHEN '([a-z_]+)'\s+THEN ch := '([a-z_]+)';\s*pk := '([a-z_]+)';/g)) {
      map[m[1]!] = m[2]!;
      expect(m[3], `point kind of ${m[1]}`).toBe(pointKindOf(m[2] as never));
    }
    expect(map).toEqual({ ...MESSAGE_CHANNEL_MAP });
    expect(body).toMatch(/ELSE RAISE EXCEPTION 'CHANNEL_UNKNOWN/);
  });

  it('core point kinds = the contact_points / consent_events / suppressions kind CHECKs; a platform identity carries only its own channel', async () => {
    expect(await checkValues('contact_points', 'contact_points_kind_check')).toEqual([...POINT_KINDS].sort());
    expect(await checkValues('consent_events', 'consent_events_address_kind_check')).toEqual([...POINT_KINDS].sort());
    expect(await checkValues('suppressions', 'suppressions_address_kind_check')).toEqual([...POINT_KINDS].sort());
    for (const ch of CHANNELS) expect(channelsOfKind(pointKindOf(ch))).toContain(ch);
    for (const ch of PLATFORM_CHANNELS) expect(channelsOfKind(ch)).toEqual([ch]);
  });
});
