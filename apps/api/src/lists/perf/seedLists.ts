// Seeds the list workload into a load database (PARITY_PLAN module 60 perf test, R-PAR-29):
// a tag catalog, custom fields and, for every live contact of every tenant, a skewed number of tag
// links (≈ 4 per contact: 1M at 250k) and typed values (≈ 8 per contact: 2M at 250k). Deterministic
// (hashes of the contact id). Bulk-loaded as the owner role with every trigger ON (the per-person tag
// limit, the protected-tag bulk guard, the value type guard), then ANALYZEd.
//
//   pnpm --filter @realty/api exec tsx --env-file-if-exists=../../.env --conditions=@realty/source src/lists/perf/seedLists.ts [--db realty_load]
import { migrate } from '@realty/db/migrate';
import pg from 'pg';
import { loadUrls, MIGRATIONS_DIR } from '../../load/db.js';
import { loadUuid } from '../../load/generate.js';
import { argValue } from '../../load/seed.js';

export const PERF_TAGS = 200;
/** tags 0..4 are fair-housing proxies (never a bulk audience) */
export const PERF_PROTECTED_TAGS = 5;

export interface PerfField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'single_select' | 'multi_select';
  annual?: boolean;
  options?: string[];
}

export const PERF_FIELDS: PerfField[] = [
  { key: 'birthday', label: 'Birthday', type: 'date', annual: true },
  { key: 'home_anniversary', label: 'Home anniversary', type: 'date', annual: true },
  { key: 'budget', label: 'Budget', type: 'number' },
  { key: 'area', label: 'Area', type: 'text' },
  { key: 'timeline', label: 'Timeline', type: 'single_select', options: ['now', 'three_months', 'six_months', 'year', 'someday'] },
  { key: 'features', label: 'Features', type: 'multi_select', options: ['pool', 'garage', 'yard', 'view', 'basement', 'office'] },
  { key: 'closing_date', label: 'Closing date', type: 'date' },
  { key: 'lender', label: 'Lender', type: 'text' },
  { key: 'rating', label: 'Rating', type: 'number' },
  { key: 'financing', label: 'Financing', type: 'single_select', options: ['cash', 'conventional', 'fha', 'jumbo'] },
];

export const perfTagId = (slug: string, i: number) => loadUuid(slug, `perf-tag:${i}`);
export const perfFieldId = (slug: string, key: string) => loadUuid(slug, `perf-field:${key}`);

/** A SQL text-array literal of fixed option ids (seed data, not input). */
const arr = (xs: readonly string[]) => `ARRAY[${xs.map((x) => `'${x.replace(/[^a-z_]/g, '')}'`).join(',')}]`;

/** A value expression per field type over `h` (a non-negative per-(contact, field) hash). */
function valueSql(f: PerfField): string {
  switch (f.type) {
    case 'text':
      return `(ARRAY['Northside','Lakeview','Downtown','Hillcrest','Riverside','Old Town','Westend','Harbor'])[1 + (h % 8)::int], NULL::numeric, NULL::date, NULL::text[]`;
    case 'number':
      return f.key === 'budget' ? `NULL, (150000 + (h % 1850) * 1000)::numeric, NULL, NULL` : `NULL, (1 + h % 5)::numeric, NULL, NULL`;
    case 'date':
      return f.annual ? `NULL, NULL, (date '1950-01-01' + (h % 20000)::int), NULL` : `NULL, NULL, (date '2020-01-01' + (h % 2600)::int), NULL`;
    case 'single_select':
      return `NULL, NULL, NULL, ARRAY[(${arr(f.options!)})[1 + (h % ${f.options!.length})::int]]`;
    case 'multi_select':
      return `NULL, NULL, NULL, ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[(${arr(f.options!)})[1 + (h % ${f.options!.length})::int], (${arr(f.options!)})[1 + ((h / 7) % ${f.options!.length})::int]]) x ORDER BY x)`;
  }
}

export async function seedLists(o: { ownerUrl: string; log: (s: string) => void; slugs?: string[] }): Promise<{ tags: number; links: number; values: number; seconds: number }> {
  const t0 = performance.now();
  const su = new pg.Client({ connectionString: o.ownerUrl });
  await su.connect();
  try {
    await su.query("SET statement_timeout = '0'");
    const tenants = (await su.query<{ id: string; slug: string; owner: string }>(
      `SELECT t.id, t.slug, (SELECT m.user_id FROM memberships m WHERE m.tenant_id = t.id AND m.role = 'owner' ORDER BY m.user_id LIMIT 1) AS owner FROM tenants t ORDER BY t.slug`,
    )).rows.filter((t) => !o.slugs || o.slugs.includes(t.slug));
    let tags = 0;
    for (const t of tenants) {
      await su.query('BEGIN');
      // the catalog: 200 tags, the first five fair-housing proxies (protected)
      const names = Array.from({ length: PERF_TAGS }, (_, i) => (i < PERF_PROTECTED_TAGS ? `Proxy ${i}` : `Tag ${String(i).padStart(3, '0')}`));
      await su.query(
        `INSERT INTO tags (tenant_id, id, name, protected_proxy, created_by_kind)
         SELECT $1, x.id, x.name, x.p, 'import' FROM unnest($2::uuid[], $3::text[], $4::boolean[]) AS x(id, name, p) ON CONFLICT DO NOTHING`,
        [t.id, names.map((_, i) => perfTagId(t.slug, i)), names, names.map((_, i) => i < PERF_PROTECTED_TAGS)],
      );
      tags += names.length;
      for (const [pos, f] of PERF_FIELDS.entries()) {
        await su.query(
          `INSERT INTO custom_field_defs (tenant_id, id, key, label, field_type, options, annual, position, origin, created_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'manual', $9) ON CONFLICT DO NOTHING`,
          [t.id, perfFieldId(t.slug, f.key), f.key, f.label, f.type, JSON.stringify((f.options ?? []).map((id) => ({ id, label: id.replace(/_/g, ' ') }))), f.annual === true, pos, t.owner],
        );
      }
      await su.query('COMMIT');
    }
    // links: 0..8 per live contact (≈ 4), tag popularity skewed (rank ≈ 200·r²); protected tags are user-added
    o.log('seeding contact_tags …');
    // in chunks of 2,000 people: the per-person limit trigger takes one advisory lock per person, and a
    // single statement over 250k people would exceed max_locks_per_transaction
    const links = { rowCount: 0 };
    const seeded = Number((await su.query<{ n: string }>('SELECT count(*) AS n FROM contact_tags')).rows[0]!.n) > 0;
    for (const t of seeded ? [] : tenants) {
      let after = '00000000-0000-0000-0000-000000000000';
      for (;;) {
        // keyset on the (tenant_id, id) primary key
        const chunk = await su.query<{ id: string }>(
          `SELECT c.id FROM contacts c WHERE c.tenant_id = $1 AND c.id > $2 AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL
            ORDER BY c.tenant_id, c.id LIMIT 2000`, [t.id, after]);
        if (chunk.rows.length === 0) break;
        after = chunk.rows[chunk.rows.length - 1]!.id;
        const r = await su.query(`
          INSERT INTO contact_tags (tenant_id, contact_id, tag_id, added_by_kind, added_by_user_id)
          SELECT $1::uuid, u.id, tg.id, 'user', $3::uuid
            FROM unnest($2::uuid[]) AS u(id)
            CROSS JOIN LATERAL generate_series(1, abs(hashtext(u.id::text || ':n')) % 9) AS g(k)
            CROSS JOIN LATERAL (SELECT floor(${PERF_TAGS} * power((abs(hashtext(u.id::text || ':' || g.k)) % 1000000) / 1000000.0, 2))::int AS ix) rr
            JOIN tags tg ON tg.tenant_id = $1::uuid AND tg.id = ($4::uuid[])[rr.ix + 1]
          ON CONFLICT DO NOTHING`, [t.id, chunk.rows.map((x) => x.id), t.owner, Array.from({ length: PERF_TAGS }, (_, i) => perfTagId(t.slug, i))]);
        links.rowCount += r.rowCount ?? 0;
      }
      o.log(`contact_tags ${t.slug}: ${links.rowCount} so far`);
    }
    o.log(`contact_tags: ${links.rowCount}`);
    let values = 0;
    for (const f of PERF_FIELDS) {
      const r = await su.query(`
        INSERT INTO contact_field_values (tenant_id, contact_id, field_id, value_text, value_number, value_date, value_options, updated_by_kind, updated_by_user_id)
        SELECT c.tenant_id, c.id, d.id, ${valueSql(f)}, 'user', d.created_by_user_id
          FROM contacts c
          JOIN tenants tn ON tn.id = c.tenant_id
          JOIN custom_field_defs d ON d.tenant_id = c.tenant_id AND d.key = $1
          CROSS JOIN LATERAL (SELECT abs(hashtext(c.id::text || ':' || $1))::bigint AS h) hh
         WHERE c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL AND hh.h % 10 < 8 ${o.slugs ? 'AND tn.slug = ANY ($2::text[])' : ''}
        ON CONFLICT DO NOTHING`, o.slugs ? [f.key, o.slugs] : [f.key]);
      values += r.rowCount ?? 0;
      o.log(`contact_field_values ${f.key}: ${r.rowCount}`);
    }
    await su.query('ANALYZE tags, contact_tags, custom_field_defs, contact_field_values, contacts, tasks');
    return { tags, links: links.rowCount, values, seconds: (performance.now() - t0) / 1000 };
  } finally {
    await su.end();
  }
}

/** Applies any migration the load database is missing (a load seeded before this lane's migration). */
export async function migrateLoad(ownerUrl: string): Promise<number> {
  return (await migrate(ownerUrl, MIGRATIONS_DIR)).applied.length;
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!);
if (isMain) {
  const db = argValue(process.argv.slice(2), 'db') ?? 'realty_load';
  const urls = loadUrls(db);
  migrateLoad(urls.ownerUrl)
    .then((n) => (console.log(`migrations applied: ${n}`), seedLists({ ownerUrl: urls.ownerUrl, log: (s) => console.log(s) })))
    .then((r) => console.log(JSON.stringify(r)))
    .catch((e: unknown) => {
      console.error(e);
      process.exitCode = 1;
    });
}
