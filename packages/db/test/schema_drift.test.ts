// The Kysely interfaces (src/schema.ts) match information_schema of a fully migrated database
// (BUILD_PLAN module 7 acceptance: "generated drift test").
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TABLE_NAMES, VIEW_NAMES } from '../src/schema.js';
import { SCHEMA_FILE, generateSchema, renderSchema } from '../src/schemaGen.js';
import { createTestDb, type TestDb } from '../src/testing/index.js';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.drop();
});

describe('schema.ts drift', () => {
  it('src/schema.ts is exactly what the migrations produce (run `pnpm --filter @realty/db gen-schema` after a migration)', async () => {
    const generated = await generateSchema(db.ownerUrl);
    expect(readFileSync(SCHEMA_FILE, 'utf8')).toBe(generated);
  });

  it('covers every public table and view', async () => {
    const c = new pg.Client({ connectionString: db.ownerUrl });
    await c.connect();
    try {
      const t = await c.query<{ n: string; k: string }>(`SELECT table_name AS n, table_type AS k FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`);
      expect([...TABLE_NAMES]).toEqual(t.rows.filter((r) => r.k === 'BASE TABLE').map((r) => r.n));
      expect([...VIEW_NAMES]).toEqual(t.rows.filter((r) => r.k === 'VIEW').map((r) => r.n));
      expect(TABLE_NAMES.length).toBeGreaterThanOrEqual(94);
      expect(VIEW_NAMES.length).toBe(5); // + v_owner_source_dollars (M33, module 33)
    } finally {
      await c.end();
    }
  });

  it('the drift check is live: a column change is detected', () => {
    const base = { table_name: 't', table_type: 'BASE TABLE', column_name: 'a', data_type: 'text', udt_name: 'text', is_nullable: 'NO', column_default: null, is_generated: 'NEVER', is_identity: 'NO', identity_generation: null };
    expect(renderSchema([base])).not.toBe(renderSchema([{ ...base, is_nullable: 'YES' }]));
    expect(renderSchema([base])).toContain('a: string;');
    expect(renderSchema([{ ...base, column_default: "'x'" }])).toContain('a: Generated<string>;');
    expect(() => renderSchema([{ ...base, udt_name: 'mystery' }])).toThrow(/no TypeScript mapping/);
  });
});
