// The demo seed on a fresh createTestDb database: runDemoSeed is exactly what `pnpm seed` runs (main.ts adds only
// the guards and --reset), here with the RLS-bound app_user, deterministic fakes and a throwaway credentials file.
// The demo tenant must come with tags on people, custom fields with values (Sophia Nguyen among them) and one lead
// email waiting in Needs review, all written by the real writers (routes, the signed inbound webhook), so their
// audit rows, RLS and invariants are the real ones; and the seed must refuse a second run without changing anything.
// Slow: the whole seed runs once (beforeAll).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instant, uuidv7Generator } from '@realty/core/foundation';
import { classifyProtected } from '@realty/core/parity/tags';
import { configureDatabase, createDatabase, withTenantTx } from '@realty/db';
import { type TestDb, createTestDb } from '@realty/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_ORIGIN, testConfig } from '../auth/testHarness.js';
import { noAutomatedContact } from '../leads/automatedContact.js';
import { HOLD_SENTENCES } from '../leadEmail/trust.js';
import { createFakeProviders } from '../providers/index.js';
import { buildServer } from '../server.js';
import { systemActor } from '../worker/systemActor.js';
import { SeedClient } from './client.js';
import { DEMO_PASSWORD, DEMO_SLUG, type DemoSeedOptions, runDemoSeed } from './demo.js';

let db: TestDb;
let su: pg.Pool;
let dir: string;
let opts: DemoSeedOptions;
let tenantId: string;
const lines: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  su = new pg.Pool({ connectionString: db.ownerUrl, max: 2 });
  su.on('error', () => {});
  dir = mkdtempSync(join(tmpdir(), 'seed-demo-'));
  opts = { config: testConfig({ databaseUrl: db.appUserUrl }), credentialsPath: join(dir, '.demo', 'credentials.json'), log: (m) => void lines.push(m) };
  expect(await runDemoSeed(su, opts)).toBe('seeded');
  tenantId = (await su.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [DEMO_SLUG])).rows[0]!.id;
}, 600_000);

afterAll(async () => {
  await su?.end();
  await db?.drop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const q = async <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) => (await su.query<T>(text, values)).rows;
const userId = async (email: string) => (await q<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]))[0]!.id;
const contactId = async (name: string) => {
  const rows = await q<{ id: string }>('SELECT id FROM contacts WHERE tenant_id = $1 AND display_name = $2', [tenantId, name]);
  expect(rows, name).toHaveLength(1);
  return rows[0]!.id;
};

/** What a person carries, as the database holds it (the writer's kind, and whether it was the person's owner). */
async function tagsOf(name: string) {
  return q<{ tag: string; added_by_kind: string; by_owner: boolean }>(
    `SELECT t.name AS tag, l.added_by_kind, l.added_by_user_id = c.owner_user_id AS by_owner
       FROM contact_tags l JOIN tags t ON t.tenant_id = l.tenant_id AND t.id = l.tag_id JOIN contacts c ON c.tenant_id = l.tenant_id AND c.id = l.contact_id
      WHERE l.tenant_id = $1 AND c.display_name = $2 ORDER BY t.name`,
    [tenantId, name],
  );
}

describe('pnpm seed: the demo tenant', () => {
  it('finished: the demo logins were written', () => {
    expect(existsSync(opts.credentialsPath)).toBe(true);
    expect(lines.at(-1)).toMatch(/^done\./);
  });

  it('tags: Pre-approved, First-time buyer, Investor, Past client and Relocating, none a fair-housing protected proxy, typed onto people by the agent who owns them (the real writer)', async () => {
    const tags = await q<{ name: string; protected_proxy: boolean; created_by_kind: string; created_by_user_id: string | null }>(
      'SELECT name, protected_proxy, created_by_kind, created_by_user_id FROM tags WHERE tenant_id = $1 ORDER BY name',
      [tenantId],
    );
    expect(tags.map((t) => t.name)).toEqual(['First-time buyer', 'Investor', 'Past client', 'Pre-approved', 'Relocating']);
    for (const t of tags) {
      expect(classifyProtected(t.name), t.name).toBe(false);
      expect([t.protected_proxy, t.created_by_kind, t.created_by_user_id !== null], t.name).toEqual([false, 'user', true]);
    }
    expect(await tagsOf('Sophia Nguyen')).toEqual([
      { tag: 'First-time buyer', added_by_kind: 'user', by_owner: true },
      { tag: 'Pre-approved', added_by_kind: 'user', by_owner: true },
    ]);
    const links = await q<{ tag: string; people: number; by_owner: boolean }>(
      `SELECT t.name AS tag, count(*)::int AS people, bool_and(l.added_by_kind = 'user' AND l.added_by_user_id = c.owner_user_id) AS by_owner
         FROM contact_tags l JOIN tags t ON t.tenant_id = l.tenant_id AND t.id = l.tag_id JOIN contacts c ON c.tenant_id = l.tenant_id AND c.id = l.contact_id
        WHERE l.tenant_id = $1 GROUP BY t.name ORDER BY t.name`,
      [tenantId],
    );
    expect(links.map((l) => l.tag)).toEqual(tags.map((t) => t.name));
    expect(links.every((l) => l.people >= 1 && l.by_owner)).toBe(true);
    expect(links.reduce((n, l) => n + l.people, 0)).toBeGreaterThanOrEqual(10);
  });

  it('custom fields: Budget (a number), Timeline (choices), Pre-approval expires (a date) and Birthday (an annual date), defined by the Owner and audited', async () => {
    const owner = await userId('owner@demo.realty-os.test');
    const defs = await q<{ id: string; label: string; field_type: string; annual: boolean; options: { id: string; label: string }[]; origin: string; created_by_user_id: string }>(
      'SELECT id, label, field_type, annual, options, origin, created_by_user_id FROM custom_field_defs WHERE tenant_id = $1 AND archived_at IS NULL ORDER BY position',
      [tenantId],
    );
    expect(defs.map((d) => [d.label, d.field_type, d.annual])).toEqual([
      ['Budget', 'number', false],
      ['Timeline', 'single_select', false],
      ['Pre-approval expires', 'date', false],
      ['Birthday', 'date', true],
    ]);
    expect(defs[1]!.options.map((o) => o.label)).toEqual(['Within 3 months', '3 to 6 months', '6 to 12 months', 'More than a year']);
    expect(defs.every((d) => d.origin === 'manual' && d.created_by_user_id === owner)).toBe(true);
    const audited = await q<{ entity_id: string; actor_kind: string; actor_user_id: string }>("SELECT entity_id, actor_kind, actor_user_id FROM audit_log WHERE tenant_id = $1 AND action = 'custom_field.created'", [tenantId]);
    expect(audited.map((a) => a.entity_id).sort()).toEqual(defs.map((d) => d.id).sort());
    expect(audited.every((a) => a.actor_kind === 'user' && a.actor_user_id === owner)).toBe(true);
  });

  it('field values on several people, Sophia Nguyen with all four, each set by the agent who owns the person', async () => {
    const sophia = await q<{ label: string; value_number: string | null; value_date: string | null; value_options: string[] | null }>(
      `SELECT d.label, v.value_number::text, to_char(v.value_date, 'YYYY-MM-DD') AS value_date, v.value_options
         FROM contact_field_values v JOIN custom_field_defs d ON d.tenant_id = v.tenant_id AND d.id = v.field_id
        WHERE v.tenant_id = $1 AND v.contact_id = $2 ORDER BY d.position`,
      [tenantId, await contactId('Sophia Nguyen')],
    );
    expect(sophia).toEqual([
      { label: 'Budget', value_number: '750000', value_date: null, value_options: null },
      { label: 'Timeline', value_number: null, value_date: null, value_options: ['within_3_months'] },
      { label: 'Pre-approval expires', value_number: null, value_date: '2027-01-15', value_options: null },
      { label: 'Birthday', value_number: null, value_date: '1991-04-22', value_options: null },
    ]);
    const all = await q<{ people: number; by_owner: boolean }>(
      `SELECT count(DISTINCT v.contact_id)::int AS people, bool_and(v.updated_by_kind = 'user' AND v.updated_by_user_id = c.owner_user_id) AS by_owner
         FROM contact_field_values v JOIN contacts c ON c.tenant_id = v.tenant_id AND c.id = v.contact_id WHERE v.tenant_id = $1`,
      [tenantId],
    );
    expect(all[0]!.people).toBeGreaterThanOrEqual(5);
    expect(all[0]!.by_owner).toBe(true);
  });

  it('Needs review has an example: the "Zillow" source takes lead email (zillow.com allowed); one email from leads@zillow.com signed by another domain was held by the real trust rule, and no lead was made', async () => {
    const inboxes = await q<{ source: string; status: string; allowed_sender_domains: string[] }>(
      `SELECT s.name AS source, i.status, i.allowed_sender_domains FROM integration_connections i JOIN lead_sources s ON s.tenant_id = i.tenant_id AND s.id = i.lead_source_id
        WHERE i.tenant_id = $1 AND i.kind = 'lead_email'`,
      [tenantId],
    );
    // only Zillow: the website form's email intake stays off, so "Turn on lead email" can still be tried
    expect(inboxes).toEqual([{ source: 'Zillow', status: 'connected', allowed_sender_domains: ['zillow.com'] }]);
    const held = await q<{ source: string; status: string; hold_code: string; sender_domain: string; dkim_pass_domains: string[]; contact_id: string | null; content: boolean }>(
      `SELECT s.name AS source, m.status, m.hold_code, m.sender_domain, m.dkim_pass_domains, m.contact_id, m.content_enc IS NOT NULL AS content
         FROM lead_email_messages m JOIN lead_sources s ON s.tenant_id = m.tenant_id AND s.id = m.lead_source_id WHERE m.tenant_id = $1`,
      [tenantId],
    );
    expect(held).toEqual([{ source: 'Zillow', status: 'needs_review', hold_code: 'DKIM_UNALIGNED', sender_domain: 'zillow.com', dkim_pass_domains: ['mailer.example.test'], contact_id: null, content: true }]);
    expect(await q('SELECT 1 FROM contact_points WHERE tenant_id = $1 AND lower(address) = $2', [tenantId, 'elena.marsh@example.com'])).toEqual([]);
    expect(await q('SELECT 1 FROM contacts WHERE tenant_id = $1 AND display_name = $2', [tenantId, 'Elena Marsh'])).toEqual([]);
  });

  it('read back through the API as the people who use it (app_user, RLS): Avery sees Sophia’s tags and fields; Taylor (Team Lead) sees the held email with its reason and what was read from it', async () => {
    const database = createDatabase({ url: db.appUserUrl, max: 3, applicationName: 'seed-readback' });
    configureDatabase(database);
    const clock = { now: () => instant(Date.now()) };
    const ids = uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n)));
    const app = buildServer(opts.config, { providers: createFakeProviders({ clock }), clock, ids, db: database });
    await app.ready();
    try {
      const signIn = async (email: string, ip: string) => {
        const c = new SeedClient(app, TEST_ORIGIN, ip, email);
        await c.must('POST', '/auth/login', { email, password: DEMO_PASSWORD });
        return c;
      };
      const avery = await signIn('avery@demo.realty-os.test', '203.0.113.71');
      const sophia = await contactId('Sophia Nguyen');
      const tags = await avery.must<{ tags: { name: string; protected: boolean }[] }>('GET', `/contacts/${sophia}/tags`);
      expect(tags.tags.map((t) => [t.name, t.protected]).sort()).toEqual([
        ['First-time buyer', false],
        ['Pre-approved', false],
      ]);
      const fields = await avery.must<{ values: { number: number | null; date: string | null; optionIds: string[] | null }[] }>('GET', `/contacts/${sophia}/fields`);
      expect(fields.values).toHaveLength(4);
      const catalog = await avery.must<{ tags: { name: string }[] }>('GET', '/tags');
      expect(catalog.tags.map((t) => t.name).sort()).toEqual(['First-time buyer', 'Investor', 'Past client', 'Pre-approved', 'Relocating']);

      const taylor = await signIn('lead@demo.realty-os.test', '203.0.113.72');
      const reviews = await taylor.must<{ items: { holdCode: string; holdSentence: string; leadSourceName: string; senderDomain: string; canAccept: boolean; fields: { name: { value: string } | null } | null }[]; pendingCount: number }>(
        'GET',
        '/lead-email/reviews?status=needs_review',
      );
      expect(reviews.pendingCount).toBe(1);
      expect(reviews.items).toHaveLength(1);
      expect(reviews.items[0]).toMatchObject({ holdCode: 'DKIM_UNALIGNED', holdSentence: HOLD_SENTENCES.DKIM_UNALIGNED, leadSourceName: 'Zillow', senderDomain: 'zillow.com', canAccept: true });
      expect(reviews.items[0]!.fields?.name?.value).toBe('Elena Marsh');
    } finally {
      await app.close();
      await database.close();
    }
  });

  // R-LSRC-9, R-LSRC-10 (owner decision 2026-11-14): the seed's own file import, and the Owner's source review as an
  // explicit seed step. Nothing automatic may go to an imported person until the Owner reviews their source, so the seed
  // confirms the mappings of its own invented labels the way an Owner does, and leaves two rows in review to show.
  it('R-LSRC-10 E739 E741: four people came in from a file; the Owner confirmed the one suggested source and mapped one label by choosing, both recorded and audited in the Owner\'s name; "Old spreadsheet" and the person with no source label are in review and get no automated contact', async () => {
    const owner = await userId('owner@demo.realty-os.test');
    const rows = await q<{ label: string | null; unlabeled: boolean; kind: string; source: string | null; by: string | null }>(
      `SELECT l.import_label AS label, l.unlabeled_batch_id IS NOT NULL AS unlabeled, l.first_seen_kind AS kind, s.name AS source, l.mapped_by_user_id AS by
         FROM import_source_labels l LEFT JOIN lead_sources s ON s.tenant_id = l.tenant_id AND s.id = l.lead_source_id WHERE l.tenant_id = $1 ORDER BY l.import_label NULLS LAST`, [tenantId]);
    expect(rows).toEqual([
      { label: 'Harbor open house sign-in', unlabeled: false, kind: 'csv', source: 'Open houses', by: owner },
      { label: 'Old spreadsheet', unlabeled: false, kind: 'csv', source: null, by: null },
      { label: 'website inquiry form', unlabeled: false, kind: 'csv', source: 'Website inquiry form', by: owner },
      { label: null, unlabeled: true, kind: 'csv', source: null, by: null },
    ]);
    // the mapping every check reads, and what it means for each person (asked as the system of the demo team)
    expect(await q('SELECT name, import_labels FROM lead_sources WHERE tenant_id = $1 AND cardinality(import_labels) > 0 ORDER BY name', [tenantId])).toEqual([
      { name: 'Open houses', import_labels: ['Harbor open house sign-in'] },
      { name: 'Website inquiry form', import_labels: ['website inquiry form'] },
    ]);
    const refusals: Record<string, string | null> = {};
    const app = createDatabase({ url: db.appUserUrl });
    try {
      for (const name of ['Iris Bell', 'Omar Reyes', 'Tess Lund', 'Milo Hart']) {
        const id = await contactId(name);
        refusals[name] = await withTenantTx(systemActor(tenantId, 'worker'), (tx) => noAutomatedContact(tx, id), { db: app });
      }
    } finally {
      await app.close();
    }
    expect(refusals).toEqual({ 'Iris Bell': null, 'Omar Reyes': null, 'Tess Lund': 'SOURCE_UNCLASSIFIED', 'Milo Hart': 'SOURCE_UNCLASSIFIED' });
    const audited = await q<{ reason: string; actor_user_id: string; label: string }>(
      `SELECT reason, actor_user_id, changes -> 'importLabel' ->> 'to' AS label FROM audit_log WHERE tenant_id = $1 AND reason LIKE 'LEAD_SOURCE_IMPORT_%' ORDER BY seq`, [tenantId]);
    expect(audited).toEqual([
      { reason: 'LEAD_SOURCE_IMPORT_LABEL_SUGGESTION_CONFIRMED', actor_user_id: owner, label: 'website inquiry form' },
      { reason: 'LEAD_SOURCE_IMPORT_LABEL_MAPPED', actor_user_id: owner, label: 'Harbor open house sign-in' },
    ]);
    expect(lines.some((l) => l.includes('wait in the source review'))).toBe(true);
  });

  // b17: one invited portal client on one deal, so the staff "What {name} sees" preview has a grant to show. platform:portal
  // stays uncleared (D11: only counsel's recorded review clears it), so the invite stands and its notice is not sent.
  it('b17: Noah Bennett is invited to the portal on Avery’s purchase: one account and one live grant, platform:portal not cleared, no notice sent; Avery’s preview shows the grant and why Noah can’t see it', async () => {
    const noah = await contactId('Noah Bennett');
    const avery = await userId('avery@demo.realty-os.test');
    const grants = await q<{ grant_id: string; deal_id: string | null; status: string; invited_by: string; granted_by: string; revoked: boolean; contact_id: string; side: string; stage: string }>(
      `SELECT g.id AS grant_id, g.deal_id, a.status, a.invited_by_user_id AS invited_by, g.granted_by_user_id AS granted_by, g.revoked_at IS NOT NULL AS revoked, a.contact_id, d.side, d.stage
         FROM portal_grants g JOIN portal_accounts a ON a.tenant_id = g.tenant_id AND a.id = g.portal_account_id JOIN deals d ON d.tenant_id = g.tenant_id AND d.id = g.deal_id
        WHERE g.tenant_id = $1`,
      [tenantId],
    );
    expect(grants).toEqual([{ grant_id: expect.any(String), deal_id: expect.any(String), status: 'invited', invited_by: avery, granted_by: avery, revoked: false, contact_id: noah, side: 'buy', stage: 'under_contract' }]);
    expect((await q<{ ok: boolean }>(`SELECT app.platform_cleared('platform:portal') AS ok`))[0]!.ok).toBe(false);
    // nothing was sent to Noah about the portal (no message names it), and no sign-in link exists
    expect(await q(`SELECT 1 FROM messages WHERE tenant_id = $1 AND contact_id = $2 AND direction = 'outbound' AND body ILIKE '%portal%'`, [tenantId, noah])).toEqual([]);
    expect(await q(`SELECT 1 FROM portal_login_tokens WHERE tenant_id = $1`, [tenantId])).toEqual([]);
    expect(lines).toContain('portal: Noah Bennett invited on his purchase (one grant); platform:portal is not cleared, so nothing was sent');

    const database = createDatabase({ url: db.appUserUrl, max: 3, applicationName: 'seed-portal-preview' });
    configureDatabase(database);
    const clock = { now: () => instant(Date.now()) };
    const ids = uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n)));
    const app = buildServer(opts.config, { providers: createFakeProviders({ clock }), clock, ids, db: database });
    await app.ready();
    try {
      const c = new SeedClient(app, TEST_ORIGIN, '203.0.113.73', 'avery@demo.realty-os.test');
      await c.must('POST', '/auth/login', { email: 'avery@demo.realty-os.test', password: DEMO_PASSWORD });
      const preview = await c.must<{ visibleNow: boolean; why: string[]; grant: { id: string; title: string } }>('GET', `/portal-grants/${grants[0]!.grant_id}/preview`);
      expect(preview.grant.id).toBe(grants[0]!.grant_id);
      expect(preview.visibleNow).toBe(false);
      expect(preview.why.join(' ')).toMatch(/not turned on/);
    } finally {
      await app.close();
      await database.close();
    }
  });

  it('b17 (B17R-2): every phone number the demo holds, logs or writes to the credentials file is fictional (+1 NXX 555-0100 to 555-0199)', async () => {
    const tables = await q<{ table_name: string }>(
      `SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE' ORDER BY 1`,
    );
    const found: [where: string, ten: string][] = [];
    const read = (where: string, text: string) => {
      for (const m of text.matchAll(/\+1[\s.-]?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)/g)) found.push([where, `${m[1]}${m[2]}${m[3]}`]);
    };
    for (const { table_name: t } of tables) {
      for (const r of await q<{ j: string }>(`SELECT row_to_json(x)::text AS j FROM public.${t} x WHERE tenant_id = $1`, [tenantId])) read(t, r.j);
    }
    read('log', lines.join('\n'));
    read('credentials file', readFileSync(opts.credentialsPath, 'utf8'));
    expect([...new Set(found.map(([where]) => where))]).toEqual(expect.arrayContaining(['contact_points', 'phone_numbers', 'messages', 'calls', 'portal_grants', 'log']));
    expect(new Set(found.map(([, ten]) => ten)).size).toBeGreaterThan(10);
    expect(found.filter(([, ten]) => !/^[2-9]\d{2}55501\d{2}$/.test(ten)).map(([where, ten]) => `${where}: ${ten}`)).toEqual([]);
  });

  it('refuses a second run: it says how to start over and changes nothing', async () => {
    const counts = async () =>
      (
        await q(
          `SELECT (SELECT count(*) FROM tenants)::int AS tenants, (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM contacts)::int AS contacts,
                  (SELECT count(*) FROM tags)::int AS tags, (SELECT count(*) FROM contact_tags)::int AS tag_links, (SELECT count(*) FROM custom_field_defs)::int AS fields,
                  (SELECT count(*) FROM contact_field_values)::int AS field_values, (SELECT count(*) FROM lead_email_messages)::int AS lead_emails,
                  (SELECT count(*) FROM audit_log)::int AS audit`,
        )
      )[0];
    const before = await counts();
    lines.length = 0;
    expect(await runDemoSeed(su, opts)).toBe('exists');
    expect(lines).toEqual([`the demo tenant "${DEMO_SLUG}" already exists. Run \`pnpm seed --reset\` to rebuild the dev database from scratch.`]);
    expect(await counts()).toEqual(before);
  });
});
