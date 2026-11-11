// Session settings every pooled application connection starts with (lane scale-250k).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { type TestDb, createTestDb } from '@realty/db/testing';
import { type Database, createDatabase } from '../src/client.js';

let db: TestDb;
let app: Database;
beforeAll(async () => {
  db = await createTestDb();
  app = createDatabase({ url: db.appUserUrl, max: 2 });
});
afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe('application connections', () => {
  it('run without JIT (no compile cost on short statements) and keep the statement timeout', async () => {
    const r = await sql<{ jit: string; timeout: string }>`SELECT current_setting('jit') AS jit, current_setting('statement_timeout') AS timeout`.execute(app.kysely);
    expect(r.rows[0]).toEqual({ jit: 'off', timeout: '30s' });
  });
});
