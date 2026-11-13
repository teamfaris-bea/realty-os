// deploy/restore-roles.sql (docs/DEPLOY.md §8) recreates the cluster roles before a pg_dump backup is restored
// into a NEW instance. Deploy rehearsal: without them pg_restore failed 385 statements (owner and grant to
// app_definer, app_retention, app_user), and the SECURITY DEFINER functions were left owned by the superuser.
// It must stay the role block of 0001_init.sql verbatim, and running it where the roles exist changes nothing.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/dbConfig.js';
import { roleBlockOf } from '../src/roleBlock.js';
import { createTestDb, type TestDb } from '../src/testing/index.js';

const script = readFileSync(resolve(MIGRATIONS_DIR, '../../../deploy/restore-roles.sql'), 'utf8');
const init = readFileSync(join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8');
/** the first DO block that creates the cluster roles */
const roleBlock = (text: string) => /DO \$\$\nBEGIN\n {2}IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'app_user'\)[\s\S]*?\nEND \$\$;/.exec(text)?.[0];

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.drop();
});

describe('deploy/restore-roles.sql', () => {
  it('is the role block of 0001_init.sql, verbatim, and nothing else runs', () => {
    const block = roleBlock(init);
    expect(block).toBeDefined();
    expect(roleBlock(script)).toBe(block);
    const code = script.split('\n').filter((l) => !l.startsWith('--')).join('\n').trim();
    expect(code).toBe(block);
    for (const r of ['app_user', 'app_definer', 'app_retention']) expect(code).toContain(`CREATE ROLE ${r} NOLOGIN NOSUPERUSER`);
  });

  it('R-DEPLOY-4: roleBlockOf (the block the release step runs for a non-superuser owner) is the same block, read from 0001_init.sql, and throws on text without it', () => {
    expect(roleBlockOf(init)).toBe(roleBlock(script));
    expect(roleBlockOf(script)).toBe(roleBlockOf(init));
    expect(() => roleBlockOf('CREATE TABLE x (id int);')).toThrow(/cluster-role block of 0001_init.sql was not found/);
  });

  it('is idempotent: on a cluster that has the roles it changes none of them', async () => {
    const c = new pg.Client({ connectionString: db.ownerUrl });
    await c.connect();
    try {
      const q = `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolinherit FROM pg_roles WHERE rolname IN ('app_user','app_definer','app_retention') ORDER BY 1`;
      const before = (await c.query(q)).rows;
      expect(before).toHaveLength(3);
      await c.query(script);
      expect((await c.query(q)).rows).toEqual(before);
    } finally {
      await c.end();
    }
  });
});
