// Re-runs the self-check block of 0001_init.sql (§22) against a database with ALL migrations applied,
// so a later migration that adds a table without FORCE RLS, without the RESTRICTIVE tenant_isolation
// policy, without tenant_id leading the PK, or a SECURITY DEFINER function without a pinned
// search_path / reviewed owner fails the test suite (R-TEN-1 R-TEN-4 R-TEN-5 R-AUDIT-7 invariants).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/dbConfig.js';
import { createTestDb, type TestDb } from '../src/testing/index.js';

const init = readFileSync(`${MIGRATIONS_DIR}/0001_init.sql`, 'utf8');
const marker = init.indexOf('-- 22. Self-checks');
const selfCheck = init.slice(init.indexOf('DO $$', marker));

describe('schema invariants after all migrations', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('extracts the 0001 self-check block', () => {
    expect(marker).toBeGreaterThan(0);
    expect(selfCheck).toMatch(/SCHEMA SELF-CHECK FAILED/);
  });

  it('0001 §22 self-check holds for the whole migrated schema (R-TEN-5)', async () => {
    const c = new pg.Client({ connectionString: db.ownerUrl });
    await c.connect();
    try {
      await expect(c.query(selfCheck)).resolves.toBeDefined();
    } finally {
      await c.end();
    }
  });

  it('detects a violating table (the check is live, not vacuous)', async () => {
    const c = new pg.Client({ connectionString: db.ownerUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('CREATE TABLE public.bad_tenant_table (tenant_id uuid NOT NULL, id uuid, PRIMARY KEY (tenant_id, id))');
      await expect(c.query(selfCheck)).rejects.toThrow(/rls:bad_tenant_table.*tenant_policy:bad_tenant_table/);
    } finally {
      await c.query('ROLLBACK');
      await c.end();
    }
  });

  // R-TEN-5 / §22: a pinned search_path that does not list pg_temp still searches the session's temporary schema
  // FIRST for relation names. A function body that names a public table without `public.` therefore writes to (or
  // reads) a TEMP table of the same name if the calling session made one, and a trigger on that temp table runs the
  // session's own code as whoever runs the function (inside a definer: app_definer or app_retention, BYPASSRLS).
  // Every function body must name public tables schema-qualified (transition tables and CTEs are not relations).
  const UNQUALIFIED = `
    WITH rels AS (
      SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','v','m','f','S')
    ), fns AS (
      SELECT p.oid::regprocedure::text AS fn,
             -- comments and string literals removed: a table name inside a message is not a reference
             regexp_replace(regexp_replace(regexp_replace(p.prosrc, '--[^\\n]*', ' ', 'g'), '/\\*.*?\\*/', ' ', 'g'), '''([^'']|'''')*''', ' ', 'g') AS body
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('app','auth','portal','public')
         AND p.prolang IN (SELECT l.oid FROM pg_language l WHERE l.lanname IN ('sql','plpgsql'))
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    )
    SELECT f.fn || ': ' || string_agg(DISTINCT r.relname, ',' ORDER BY r.relname) AS hit
      FROM fns f JOIN rels r
        ON f.body ~* ('\\m(from|join|into|update|table|only|truncate|using|lock)\\s+' || r.relname || '\\M(?!\\s*\\.)')
        OR f.body ~* (',\\s*' || r.relname || '\\s+(as\\s+)?[a-z_][a-z0-9_]*\\s+(join|where|on|left|cross|inner|,)')
     GROUP BY f.fn ORDER BY 1`;

  it('R-TEN-5: no SQL or PL/pgSQL function names a public table without its schema (a temp table cannot shadow it)', async () => {
    const c = new pg.Client({ connectionString: db.ownerUrl });
    await c.connect();
    try {
      const n = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
                                                        WHERE s.nspname IN ('app','auth','portal') AND p.prolang IN (SELECT oid FROM pg_language WHERE lanname IN ('sql','plpgsql'))`)).rows[0]!.n);
      expect(n).toBeGreaterThan(150); // the scan covers the whole schema
      expect((await c.query<{ hit: string }>(UNQUALIFIED)).rows.map((r) => r.hit)).toEqual([]);
      // the scan is live: an unqualified INSERT INTO, JOIN and comma join are each found
      await c.query('BEGIN');
      await c.query(`CREATE FUNCTION app.bad_unqualified() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO feed_dirty (tenant_id, user_id, group_key) SELECT n.tenant_id, m.user_id, '!full' FROM new_rows n, memberships m WHERE m.tenant_id = n.tenant_id; RETURN NULL; END $$`);
      await c.query(`CREATE FUNCTION app.bad_unqualified_sql(uuid) RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT count(*) FROM public.contacts c JOIN tasks t ON t.contact_id = c.id WHERE c.id = $1 $$`);
      expect((await c.query<{ hit: string }>(UNQUALIFIED)).rows.map((r) => r.hit)).toEqual(['app.bad_unqualified(): feed_dirty,memberships', 'app.bad_unqualified_sql(uuid): tasks']);
    } finally {
      await c.query('ROLLBACK');
      await c.end();
    }
  });

  it('R-TEN-5: a session\'s TEMP TABLE feed_dirty captures no feed mark, neither from its own writes nor inside a definer', async () => {
    const owner = randomUUID();
    const tenant = randomUUID();
    const c = new pg.Client({ connectionString: db.appUserUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      // the shadow table records who wrote into it (a trigger here is code the session chose, run as the writer)
      await c.query(`CREATE TEMP TABLE feed_dirty (tenant_id uuid, user_id uuid, group_key text, written_by text) ON COMMIT DROP`);
      await c.query(`GRANT INSERT ON pg_temp.feed_dirty TO PUBLIC`);
      await c.query(`CREATE FUNCTION pg_temp.shadow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.written_by := current_user; RETURN NEW; END $$`);
      await c.query(`CREATE TRIGGER shadow BEFORE INSERT ON pg_temp.feed_dirty FOR EACH ROW EXECUTE FUNCTION pg_temp.shadow()`);
      // 1. a definer writes a marked table: app.provision_tenant (app_definer) inserts the owner's team membership
      await c.query(`SELECT set_config('app.tenant_id', '', true), set_config('app.user_id', $1, true), set_config('app.actor_kind', 'user', true),
                            set_config('app.principal_type', 'staff', true), set_config('app.ownership_command', '', true)`, [owner]);
      await c.query(`INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, 'Shadow Owner', '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA')`, [owner, `shadow-${owner.slice(0, 8)}@example.test`]);
      await c.query(`SELECT app.provision_tenant($1, $2, 'Shadow Team', 'America/New_York', 'Shadow Realty LLC', $3, $4, $5, $6, '\\x01', '\\x02', '\\x03', 'kek-test')`,
        [tenant, `shadow-${owner.slice(0, 8)}`, owner, randomUUID(), randomUUID(), randomUUID()]);
      // 2. the session's own write of a marked table (an invoker trigger, as app_user)
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
      await c.query(`INSERT INTO tasks (tenant_id, id, assignee_user_id, kind, title, due_at, created_by_kind, created_by_user_id)
                     VALUES ($1, $2, $3, 'follow_up', 'Shadow check', now() + interval '1 hour', 'user', $3)`, [tenant, randomUUID(), owner]);
      const shadow = (await c.query<{ g: string; by: string }>(`SELECT group_key AS g, written_by AS by FROM pg_temp.feed_dirty`)).rows;
      expect(shadow).toEqual([]);
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    // the marks went where they belong
    const su = new pg.Client({ connectionString: db.ownerUrl });
    await su.connect();
    try {
      const marks = (await su.query<{ g: string }>(`SELECT DISTINCT left(group_key, 2) AS g FROM public.feed_dirty WHERE tenant_id = $1 AND user_id = $2 ORDER BY 1`, [tenant, owner])).rows.map((r) => r.g);
      expect(marks).toEqual(['!f', 't:']);
    } finally {
      await su.end();
    }
  });
});
