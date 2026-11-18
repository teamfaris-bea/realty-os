// R-LSRC-9 A5 (owner decision 2026-11-14): what migration 0101 does to a database that already holds imported people.
//
// A database migrated up to 0100 is populated (two tenants; imported people with a running plan, a pending trigger
// draft with its run and card, and a queued automated message; one label an Owner already mapped to an unmarked source
// and one to a marked source, as 0099 allowed), then 0101 and everything after it is applied. Afterwards:
//   - every already-imported person reads as unclassified unless their label was already Owner-mapped; a person with no
//     label too; a native person is untouched; the marked source still wins;
//   - the migration changed NO plan, message, draft, run, card or import row (it says so in its header): the refusals
//     hold from that moment, and the API stops what is running when the Owner next acts or a step, turn or dispatch runs.
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/client.js';
import { MIGRATIONS_DIR } from '../src/dbConfig.js';
import { migrate } from '../src/migrate.js';
import { withTenantTx } from '../src/tenantTx.js';
import { createTestDb } from '../src/testing/index.js';
import { type Harness, type World, createWorld, selfCreated, uuid } from './world.js';

let h: Harness;
let dir: string;

interface Person {
  world: World;
  contact: string;
  expected: string | null;
  what: string;
}
const people: Person[] = [];
const WATCHED = ['playbook_enrollments', 'messages', 'assistant_actions', 'playbook_step_runs', 'priority_feed_items', 'import_records', 'conversations', 'contacts'] as const;

/** Every watched table's rows, as text, so "nothing changed" is checked row by row. */
async function snapshot(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const t of WATCHED) out[t] = (await h.su.query<{ r: string }>(`SELECT to_jsonb(x)::text AS r FROM public.${t} x ORDER BY 1`)).rows.map((x) => x.r);
  return out;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'realty-0101-upgrade-'));
  for (const name of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql') && n < '0101')) copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
  const db = await createTestDb({ migrationsDir: dir });
  const app = createDatabase({ url: db.appUserUrl });
  const su = new pg.Pool({ connectionString: db.ownerUrl, max: 2 });
  su.on('error', () => {});
  h = { db, app, su, async close() { await app.close(); await su.end(); await db.drop(); } };
  for (let tenant = 0; tenant < 2; tenant++) {
    const w = await createWorld(app, { agents: 1 });
    const agent = w.agents[0]!;
    const pb = uuid();
    const version = uuid();
    await su.query("INSERT INTO playbooks (tenant_id, id, kind, scope, name) VALUES ($1, $2, 'nurture', 'team', 'Upgrade plan (test)')", [w.tenantId, pb]);
    await su.query("INSERT INTO playbook_versions (tenant_id, id, playbook_id, version_no, steps, content_sha256, created_by_user_id) VALUES ($1, $2, $3, 1, '[]', repeat('ab', 32), $4)", [w.tenantId, version, pb, w.owner.id]);
    await withTenantTx(w.owner.actor, async (tx) => {
      await sql`INSERT INTO playbook_approvals (tenant_id, id, playbook_version_id, decision, decided_by_user_id, decided_by_role, content_sha256, attestation, decided_at)
        VALUES (${w.tenantId}, ${uuid()}, ${version}, 'approve', ${w.owner.id}, 'owner', ${'ab'.repeat(32)}, 'I reviewed these messages and approve them (upgrade test).', now())`.execute(tx);
      await sql`UPDATE playbook_versions SET status = 'approved' WHERE tenant_id = ${w.tenantId} AND id = ${version}`.execute(tx);
    }, { db: app });
    // as 0099 and 0100 allowed: the Owner mapped one label to an unmarked source and one to a marked source
    const markedSource = uuid();
    await withTenantTx(w.owner.actor, async (tx) => {
      await sql`INSERT INTO lead_sources (tenant_id, id, name, kind, no_ai_care, import_labels) VALUES (${w.tenantId}, ${markedSource}, 'Partner referrals (test)', 'referral', true, ARRAY['Partner label (upgrade test)'])`.execute(tx);
      await sql`UPDATE lead_sources SET import_labels = ARRAY['Mapped label (upgrade test)'] WHERE tenant_id = app.tenant_id() AND id = ${w.leadSourceId}::uuid`.execute(tx);
    }, { db: app });
    const emailIdentity = uuid();
    await su.query("INSERT INTO email_identities (tenant_id, id, from_address, display_name, status) VALUES ($1, $2, 'team@upgrade.test', 'Team', 'active')", [w.tenantId, emailIdentity]);
    const batch = uuid();
    const stage = uuid();
    await su.query("INSERT INTO import_batches (tenant_id, id, source, status, source_snapshot_sha256, source_snapshot_at, created_by_user_id) VALUES ($1, $2, 'fub_api', 'dry_run', repeat('a', 64), now(), $3)", [w.tenantId, batch, w.owner.id]);
    await su.query("INSERT INTO import_stages (tenant_id, id, batch_id, category, seq, status) VALUES ($1, $2, $3, 'contacts', 1, 'pending')", [w.tenantId, stage, batch]);
    const cases: [string, string | null | undefined, string | null][] = [
      ['an imported person whose label nobody mapped', 'Unmapped label (upgrade test)', 'SOURCE_UNCLASSIFIED'],
      ['an imported person with no label', null, 'SOURCE_UNCLASSIFIED'],
      ['an imported person whose label the Owner already mapped to an unmarked source', 'Mapped label (upgrade test)', null],
      ['an imported person whose label the Owner already mapped to a marked source', 'Partner label (upgrade test)', 'SOURCE_NO_AUTOMATED_CONTACT'],
      ['a native person', undefined, null],
    ];
    for (const [what, label, expected] of cases) {
      const contact = await selfCreated(app, w, agent);
      if (label !== undefined) {
        await su.query(
          `INSERT INTO import_records (tenant_id, id, stage_id, source_ref, raw_purged_at, normalized, outcome, target_table, target_id)
           VALUES ($1, $2, $3, $4, now(), $5::jsonb, 'imported', 'contacts', $6)`,
          [w.tenantId, uuid(), stage, `fub:${contact}`, JSON.stringify({ category: 'contacts', leadSourceLabel: label }), contact],
        );
      }
      const action = uuid();
      const conv = uuid();
      await su.query("INSERT INTO playbook_enrollments (tenant_id, id, playbook_id, playbook_version_id, contact_id, enrolled_by, state) VALUES ($1, $2, $3, $4, $5, 'new_lead', 'active')", [w.tenantId, uuid(), pb, version, contact]);
      await su.query(
        `INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, trigger_ref)
         VALUES ($1, $2, $3, 'message_draft', 'nurture_step', 'requires_approval', 'proposed', $4, 'A trigger draft (upgrade test)', '{}', '{"kind":"trigger_run"}')`,
        [w.tenantId, action, contact, agent.id],
      );
      await su.query(
        `INSERT INTO playbook_step_runs (tenant_id, id, playbook_version_id, step_key, status, scheduled_for, assistant_action_id, contact_id, trigger_key, trigger_ref)
         VALUES ($1, $2, $3, 'upgrade', 'converted_to_draft', now(), $4, $5, $5::uuid::text, $6::jsonb)`,
        [w.tenantId, uuid(), version, action, contact, JSON.stringify({ kind: 'birthday', key: contact })],
      );
      await su.query(
        `INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, assistant_action_id, reasons, dedupe_key)
         VALUES ($1, $2, $3, 'assistant_draft', 'scored', $4, 'assistant_action', $5::uuid, $5::uuid, '["upgrade test"]', $5::uuid::text)`,
        [w.tenantId, uuid(), agent.id, contact, action],
      );
      await su.query('INSERT INTO conversations (tenant_id, id, contact_id) VALUES ($1, $2, $3)', [w.tenantId, conv, contact]);
      await su.query(
        `INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, email_identity_id, from_address, to_address, body, status, initiator, purpose, action_category, occurred_at)
         VALUES ($1, $2, $3, $4, 'email', 'outbound', $5, 'team@upgrade.test', 'person@example.test', 'A queued alert (upgrade test).', 'queued', 'system', 'marketing', 'search_alert', now())`,
        [w.tenantId, uuid(), conv, contact, emailIdentity],
      );
      people.push({ world: w, contact, expected, what });
    }
  }
}, 240_000);

afterAll(async () => {
  await h?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('R-LSRC-9 A5: migration 0101 on a database that already holds imported people', () => {
  it('R-LSRC-9 E735: every already-imported person reads as unclassified unless their label was already Owner-mapped; the marked source still wins; a native person is untouched; and the migration changes no plan, message, draft, run, card or import row', async () => {
    // before: 0100's boolean knows only the marked source
    for (const p of people) {
      const no = await withTenantTx(p.world.system(), async (tx) => (await sql<{ no: boolean }>`SELECT app.person_no_ai_care_source(app.tenant_id(), ${p.contact}::uuid) AS no`.execute(tx)).rows[0]!.no, { db: h.app });
      expect(no, p.what).toBe(p.expected === 'SOURCE_NO_AUTOMATED_CONTACT');
    }
    const before = await snapshot();
    expect(before.playbook_enrollments).toHaveLength(people.length);

    const applied = (await migrate(h.db.ownerUrl, MIGRATIONS_DIR)).applied;
    expect(applied[0]).toBe('0101_b18_source_unclassified.sql');
    expect(applied.every((f) => f >= '0101')).toBe(true);

    // nothing was stopped, withdrawn, canceled or rewritten by the migration itself
    const after = await snapshot();
    for (const t of WATCHED) expect(after[t], t).toEqual(before[t]);

    // and from this moment the one definer every path asks refuses the unreviewed imports
    for (const p of people) {
      const r = await withTenantTx(p.world.system(), async (tx) => (await sql<{ why: string | null; no: boolean }>`
        SELECT app.person_source_refusal(app.tenant_id(), ${p.contact}::uuid) AS why, app.person_no_ai_care_source(app.tenant_id(), ${p.contact}::uuid) AS no`.execute(tx)).rows[0]!, { db: h.app });
      expect(r, p.what).toEqual({ why: p.expected, no: p.expected !== null });
    }
    // the guards hold at once (the message guard is exercised on real rows in apps/api leads/sourceUnclassified.guards.test.ts)
    const unreviewed = people.find((p) => p.expected === 'SOURCE_UNCLASSIFIED')!;
    // a plan can still be stopped, and a paused one cannot be made active again
    await withTenantTx(unreviewed.world.system(), (tx) => sql`UPDATE playbook_enrollments SET state = 'paused', pause_reason = 'manual', paused_at = now() WHERE tenant_id = app.tenant_id() AND contact_id = ${unreviewed.contact}::uuid`.execute(tx), { db: h.app });
    await expect(withTenantTx(unreviewed.world.agents[0]!.actor, (tx) => sql`UPDATE playbook_enrollments SET state = 'active', pause_reason = NULL, paused_at = NULL, resumed_by_user_id = app.user_id()
      WHERE tenant_id = app.tenant_id() AND contact_id = ${unreviewed.contact}::uuid`.execute(tx), { db: h.app })).rejects.toThrow(/SOURCE_UNCLASSIFIED/);
  }, 240_000);

  it('R-LSRC-10 E745 (migration 0102): every label and every no-label group a committed record already carried has its review row, with the import it came in and that import\'s kind; a label the Owner had already mapped keeps its mapping, and who mapped it is left blank (it was not recorded then)', async () => {
    for (const w of new Set(people.map((p) => p.world))) {
      const rows = (await h.su.query<{ label: string | null; unlabeled: string | null; batch: string; kind: string; at: Date; source: string | null; by: string | null }>(
        `SELECT import_label AS label, unlabeled_batch_id AS unlabeled, first_seen_batch_id AS batch, first_seen_kind AS kind, first_seen_at AS at, lead_source_id AS source, mapped_by_user_id AS by
           FROM import_source_labels WHERE tenant_id = $1 ORDER BY import_label NULLS LAST`, [w.tenantId])).rows;
      const batch = (await h.su.query<{ id: string }>('SELECT id FROM import_batches WHERE tenant_id = $1', [w.tenantId])).rows[0]!.id;
      expect(rows.map((r) => [r.label, r.unlabeled, r.batch, r.kind, r.source, r.by])).toEqual([
        ['Mapped label (upgrade test)', null, batch, 'fub_api', null, null],
        ['Partner label (upgrade test)', null, batch, 'fub_api', null, null],
        ['Unmapped label (upgrade test)', null, batch, 'fub_api', null, null],
        [null, batch, batch, 'fub_api', null, null],
      ]);
      for (const r of rows) expect(r.at).toBeInstanceOf(Date);
      // the mapping itself (what every check reads) is where the Owner left it
      const held = (await h.su.query<{ l: string[] }>('SELECT import_labels AS l FROM lead_sources WHERE tenant_id = $1 AND cardinality(import_labels) > 0 ORDER BY 1', [w.tenantId])).rows.map((r) => r.l);
      expect(held).toEqual([['Mapped label (upgrade test)'], ['Partner label (upgrade test)']]);
    }
  });
});
