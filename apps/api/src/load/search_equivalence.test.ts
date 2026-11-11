// The search token tables (migration *_search_visibility.sql, lane perf-misses) let GET /search find notes and
// messages through an index under RLS. These tests prove the answer is unchanged:
//
//   * for every kind of member (Owner, Admin, Team Lead, Agent, ISA, TC) and the system actor, and for a long
//     list of tricky terms (prefixes, several words, punctuation, non-ASCII, one-letter words, terms that match
//     thousands of rows, terms of an edited or removed body), the new notes / messages queries return exactly
//     the rows, in exactly the order, of the pre-change `search_tsv @@ to_tsquery(...)` query under the same
//     RLS: with the API's limit of 10 and with no limit at all;
//   * over a generated tenant with every row variant: own, team, pond / offered (messages hidden by
//     R-PERM-6), unassigned, closed, collaborated, deal contact (TC visibility), deal-only notes, a
//     soft-deleted contact, rows moved by the caller's current ownership command, edited and removed
//     bodies, imported rows, and a second tenant;
//   * a caller sees a token row exactly when they see its parent row (the token tables reveal nothing new);
//   * the triggers keep the token tables exactly equal to the parents' lexemes after bulk inserts, edits and
//     deletes; app_user cannot write them.
//
// The old query is run once per actor and table as ONE statement over all terms (same FROM, WHERE and ORDER
// BY as the pre-change branch, per term): running it term by term would scan every row under RLS each time.
// Pre-change, ties on the timestamp had no order; both sides here break ties by id DESC (the new query does).
import { randomUUID } from 'node:crypto';
import type { Actor, ContactId, Role, TenantId, UserId } from '@realty/core/foundation';
import { type Database, applyOwnershipCommand, createDatabase, withTenantTx } from '@realty/db';
import { type TestDb, createTestDb } from '@realty/db/testing';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TextStrategy, prefixTsQuery, searchMessages, searchNotes } from '../workspace/search.js';
import { defaultSpec, generateLoad, loadUuid } from './generate.js';
import { FIRST_NAMES } from './names.js';
import { kekFromEnv } from './seed.js';

const PH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA';
const SLUG = 'load-big';
const T = loadUuid(SLUG, 'tenant');
const CMD = loadUuid(SLUG, 'ownership-command:load');
const ALL = 1_000_000;

const SPECIAL = [
  'Café crème at the Ünïcode naïve bistro — 日本語のテスト',
  "O'Neil-Smith re: pre-approval (3/4) #urgent @home",
  'Zebra zebras zebrafish ZEBRA',
  'Ⅷ ½ ① ß straße STRASSE',
  'email jane.doe@example.com or call +1 (415) 555-0123',
  'a b c d e i o u',
  'the the the lender lenders lending',
  'Ελληνικά κείμενο Ωμέγα',
  'Quimperlé was the old wording',
];

const TERMS = [
  'can', 'ca', 'c', 'pre', 'pre-appr', 'pre-approval', 'the lender', 'lend', 'rockridge', 'hoa dues', 'zzqxv', "o'neil", 'oneil',
  'neil smith', 'café', 'cafe', 'crème', 'ünï', '日本', 'テスト', 'ß', 'straße', 'strasse', '½', 'ⅷ', '①', 'zebra', 'zebrafish', 'ZEB',
  'edited', 'quimper', 'quimperlé', 'wording', 'a b', 'a', 'i', '1.2m', '1.2', '3 bed', 'call 5', 'th', 'thanks talk', 'Saturday!!',
  'jane.doe@ex', 'example.com', '415 555', '555-0123', '12 oak', 'va', '$1.1M', 'otherword', 'ελλ', 'ωμέγα', '#urgent', '@home',
  'x y z', 'hi is this', 'pre approval letter', 'holidays', 'dog yard', 'removedword', 'importedword', 'dealnote',
  ...FIRST_NAMES.slice(0, 40).map((n) => n.slice(0, 3).toLowerCase()),
];

let db: TestDb;
let appDb: Database;
let su: pg.Client;
let actors: { label: string; actor: Actor }[] = [];

/** The pre-change WHERE (tenant + RLS) evaluated once per row, then the pre-change match and order per term. */
async function oldResults(a: Actor, table: 'messages' | 'notes', tsqs: string[]): Promise<unknown[][]> {
  return withTenantTx(a, async (tx) => {
    const rows = table === 'messages'
      ? await sql<{ i: string } & Record<string, unknown>>`
          WITH v AS MATERIALIZED (SELECT * FROM messages m WHERE m.tenant_id = app.tenant_id())
          SELECT q.i, x.* FROM unnest(${tsqs}::text[]) WITH ORDINALITY q(tsq, i)
          CROSS JOIN LATERAL (
            SELECT m.id, m.contact_id, m.channel, m.direction, m.body, m.occurred_at FROM v m
             WHERE m.search_tsv @@ to_tsquery('simple', q.tsq)
             ORDER BY m.occurred_at DESC, m.id DESC) x`.execute(tx)
      : await sql<{ i: string } & Record<string, unknown>>`
          WITH v AS MATERIALIZED (SELECT * FROM notes n WHERE n.tenant_id = app.tenant_id())
          SELECT q.i, x.* FROM unnest(${tsqs}::text[]) WITH ORDINALITY q(tsq, i)
          CROSS JOIN LATERAL (
            SELECT n.id, n.contact_id, n.deal_id, n.body, n.created_at FROM v n
             WHERE n.search_tsv @@ to_tsquery('simple', q.tsq)
             ORDER BY n.created_at DESC, n.id DESC) x`.execute(tx);
    const out: unknown[][] = tsqs.map(() => []);
    for (const r of rows.rows) {
      const { i, ...rest } = r;
      out[Number(i) - 1]!.push(rest);
    }
    return out;
  }, { db: appDb, ownershipCommand: CMD });
}

async function newResults(a: Actor, table: 'messages' | 'notes', tsqs: string[], limit: number, how: TextStrategy, lexeme: number): Promise<unknown[][]> {
  return withTenantTx(a, async (tx) => {
    const out: unknown[][] = [];
    for (const q of tsqs) out.push(table === 'messages' ? await searchMessages(tx, q, limit, how, lexeme) : await searchNotes(tx, q, limit, how, lexeme));
    return out;
  }, { db: appDb, ownershipCommand: CMD });
}

const tsqs = [...new Set(TERMS.map((t) => prefixTsQuery(t)).filter((q): q is string => q !== null))];

beforeAll(async () => {
  db = await createTestDb();
  const spec = defaultSpec(1_000, PH);
  spec.tenants = spec.tenants.slice(0, 2).map((t) => ({ ...t, contacts: t.index === 0 ? 1_000 : 200 }));
  await generateLoad(db.ownerUrl, kekFromEnv(), spec);
  su = new pg.Client({ connectionString: db.ownerUrl });
  await su.connect();
  appDb = createDatabase({ url: db.appUserUrl, max: 4, statementTimeoutMs: 0 });

  const T2 = loadUuid('load-small-1', 'tenant');
  const q = async <R extends pg.QueryResultRow>(text: string, values: unknown[] = []) => (await su.query<R>(text, values)).rows;
  // contacts of every variant, with a conversation (some have none: give them one)
  const picks = await q<{ id: string; owner: string | null; v: string }>(`
    SELECT DISTINCT ON (v) id, owner_user_id AS owner, v FROM (
      SELECT c.*, CASE WHEN EXISTS (SELECT 1 FROM contact_collaborators x WHERE x.tenant_id = c.tenant_id AND x.contact_id = c.id) THEN 'collab'
                       WHEN EXISTS (SELECT 1 FROM deal_contacts x WHERE x.tenant_id = c.tenant_id AND x.contact_id = c.id) THEN 'deal'
                       ELSE c.ownership_state || ':' || (hashtext(c.id::text) & 3) END AS v
        FROM contacts c WHERE c.tenant_id = $1) c ORDER BY v, id`, [T]);
  expect(picks.length).toBeGreaterThan(10);
  const author = (await q<{ user_id: string }>(`SELECT user_id FROM memberships WHERE tenant_id = $1 AND role = 'agent' ORDER BY user_id LIMIT 1`, [T]))[0]!.user_id;
  const special: { msg: string; note: string; contact: string }[] = [];
  for (const [k, c] of picks.entries()) {
    let conv = (await q<{ id: string }>(`SELECT id FROM conversations WHERE tenant_id = $1 AND contact_id = $2 LIMIT 1`, [T, c.id]))[0]?.id;
    if (!conv) {
      conv = randomUUID();
      await q(`INSERT INTO conversations (tenant_id, id, contact_id) VALUES ($1, $2, $3)`, [T, conv, c.id]);
    }
    const msg = randomUUID();
    const note = randomUUID();
    const body = SPECIAL[k % SPECIAL.length]!;
    // two specials share a timestamp: the order between them is decided by id on both sides
    await q(`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, subject, body, status, initiator, occurred_at)
             VALUES ($1, $2, $3, $4, 'email', 'inbound', 'a@example.com', 'b@example.com', $5, $6, 'received', 'client', now() - ($7 || ' minutes')::interval)`,
      [T, msg, conv, c.id, k % 3 === 0 ? `Subject ${k} zebra` : null, body, String(Math.floor(k / 2))]);
    await q(`INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body, created_at) VALUES ($1, $2, $3, $4, $5, now() - ($6 || ' minutes')::interval)`,
      [T, note, c.id, author, body, String(Math.floor(k / 2))]);
    special.push({ msg, note, contact: c.id });
  }
  // edited bodies: the old wording must no longer be found, the new one must
  const edited = special.filter((_, k) => SPECIAL[k % SPECIAL.length]!.startsWith('Quimperlé'));
  expect(edited.length).toBeGreaterThan(0);
  for (const e of edited) {
    await q(`UPDATE messages SET body = 'Edited: the zebra moved' WHERE tenant_id = $1 AND id = $2`, [T, e.msg]);
    await su.query('BEGIN');
    await q(`SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_kind', 'user', true), set_config('app.user_id', $2, true)`, [T, author]);
    await q(`UPDATE notes SET body = 'Edited: the zebra moved' WHERE tenant_id = $1 AND id = $2`, [T, e.note]);
    await su.query('COMMIT');
  }
  // an edit that does not touch the text (status, pin) keeps the tokens
  await q(`UPDATE notes SET pinned = true WHERE tenant_id = $1 AND id = $2`, [T, special[0]!.note]);
  // removed rows: a special message and note, and a slice of generated ones
  const removed = randomUUID();
  await q(`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body, status, initiator, occurred_at)
           SELECT tenant_id, $2, id, contact_id, 'sms', 'inbound', '+14155550100', '+14155550101', 'removedword here', 'received', 'client', now() FROM conversations WHERE tenant_id = $1 LIMIT 1`, [T, removed]);
  await q(`DELETE FROM messages WHERE tenant_id = $1 AND id = $2`, [T, removed]);
  await q(`DELETE FROM messages WHERE tenant_id = $1 AND id IN (SELECT id FROM messages WHERE tenant_id = $1 ORDER BY id LIMIT 200)`, [T]);
  await q(`DELETE FROM notes WHERE tenant_id = $1 AND id IN (SELECT id FROM notes WHERE tenant_id = $1 ORDER BY id LIMIT 30)`, [T]);
  // imported message and note
  const batch = randomUUID();
  const stage = randomUUID();
  const rec = randomUUID();
  const owner = (await q<{ user_id: string }>(`SELECT user_id FROM memberships WHERE tenant_id = $1 AND role = 'owner'`, [T]))[0]!.user_id;
  await q(`INSERT INTO import_batches (tenant_id, id, source, status, created_by_user_id, source_snapshot_sha256) VALUES ($1,$2,'csv','committed',$3,$4)`, [T, batch, owner, 'a'.repeat(64)]);
  await q(`INSERT INTO import_stages (tenant_id, id, batch_id, category, seq, status) VALUES ($1,$2,$3,'messages',4,'pending')`, [T, stage, batch]);
  await q(`INSERT INTO import_records (tenant_id, id, stage_id, source_ref, outcome, raw_purged_at, target_id) VALUES ($1,$2,$3,'file.csv#row=2','imported',now(),$4)`, [T, rec, stage, randomUUID()]);
  for (const s of special.slice(0, 6)) {
    await q(`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body, status, initiator, imported, import_record_id, occurred_at)
             SELECT tenant_id, $2, id, contact_id, 'sms', 'inbound', '+14155550100', '+14155550101', 'importedword from FUB', 'received', 'import', true, $3, now() - interval '3 days'
               FROM conversations WHERE tenant_id = $1 AND contact_id = $4 LIMIT 1`, [T, randomUUID(), rec, s.contact]);
    await q(`INSERT INTO notes (tenant_id, id, contact_id, body, source, imported, import_record_id, created_at) VALUES ($1,$2,$3,'importedword note','import',true,$4, now() - interval '3 days')`,
      [T, randomUUID(), s.contact, rec]);
  }
  // deal-only notes (visible through app.deal_visible)
  const deals = await q<{ id: string; owner_user_id: string }>(`SELECT id, owner_user_id FROM deals WHERE tenant_id = $1 ORDER BY id LIMIT 8`, [T]);
  expect(deals.length).toBeGreaterThan(0);
  for (const d of deals) {
    await q(`INSERT INTO notes (tenant_id, id, deal_id, author_user_id, body) VALUES ($1,$2,$3,$4,'dealnote: inspection zebra Friday')`, [T, randomUUID(), d.id, d.owner_user_id]);
  }
  // a soft-deleted contact (its messages and notes are hidden from all but tenant-wide roles)
  await su.query('BEGIN');
  await su.query('SET LOCAL session_replication_role = replica');
  await q(`UPDATE contacts SET deleted_at = now(), purge_after = now() + interval '30 days', ownership_state = 'closed', closed_reason = 'deleted', owner_user_id = NULL, pond_id = NULL, offer_id = NULL, offered_to_user_id = NULL, offer_expires_at = NULL WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [T, special.slice(0, 3).map((s) => s.contact)]);
  await su.query('COMMIT');
  // the other tenant: its rows exist in the token tables and must never surface
  const other = (await q<{ id: string; contact_id: string }>(`SELECT id, contact_id FROM conversations WHERE tenant_id = $1 LIMIT 1`, [T2]))[0]!;
  await q(`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body, status, initiator, occurred_at)
           VALUES ($1,$2,$3,$4,'sms','inbound','+14155550100','+14155550101','otherword zebra café','received','client', now())`, [T2, randomUUID(), other.id, other.contact_id]);
  await q('ANALYZE');

  const ms = await q<{ user_id: string; role: Role }>(`SELECT user_id, role FROM memberships WHERE tenant_id = $1 ORDER BY role, user_id`, [T]);
  actors = [
    ...ms.map((m, i) => ({ label: `${m.role}#${i}`, actor: { kind: 'user' as const, userId: m.user_id as UserId, tenantId: T as TenantId, role: m.role, sessionId: 'test' } })),
    { label: 'system', actor: { kind: 'system' as const, tenantId: T as TenantId, via: 'worker' as const } },
  ];
}, 600_000);

afterAll(async () => {
  await appDb?.close();
  await su?.end();
  await db?.drop();
});

describe('search token tables keep notes and messages search identical', () => {
  it('the fixture covers every role, the row variants and terms with thousands of matches', async () => {
    expect(new Set(actors.map((a) => a.label.split('#')[0]))).toEqual(new Set(['owner', 'admin', 'team_lead', 'agent', 'isa', 'tc', 'system']));
    const r = (await su.query<{ states: string[]; many: number; imported: number; dealnotes: number; deleted: number; tenants: number }>(`
      SELECT (SELECT array_agg(DISTINCT ownership_state ORDER BY ownership_state) FROM contacts WHERE tenant_id = $1) AS states,
             (SELECT count(*)::int FROM messages WHERE tenant_id = $1 AND search_tsv @@ to_tsquery('simple', 'can:*')) AS many,
             (SELECT count(*)::int FROM messages WHERE tenant_id = $1 AND imported) AS imported,
             (SELECT count(*)::int FROM notes WHERE tenant_id = $1 AND contact_id IS NULL) AS dealnotes,
             (SELECT count(*)::int FROM contacts c WHERE tenant_id = $1 AND deleted_at IS NOT NULL
                 AND EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = c.tenant_id AND m.contact_id = c.id)) AS deleted,
             (SELECT count(DISTINCT tenant_id)::int FROM message_search_tokens) AS tenants`, [T])).rows[0]!;
    expect(r.states).toEqual(['closed', 'in_pond', 'offered', 'owned', 'unassigned']);
    expect(r.many).toBeGreaterThan(1_000);
    expect(r.imported).toBeGreaterThan(0);
    expect(r.dealnotes).toBeGreaterThan(0);
    expect(r.deleted).toBeGreaterThan(0);
    expect(r.tenants).toBeGreaterThan(1);
  });

  it('the triggers keep the token tables exactly equal to the lexemes of every message and note (bulk insert, edit, delete)', async () => {
    const r = (await su.query<{ m_extra: number; m_missing: number; n_extra: number; n_missing: number; m: number }>(`
      WITH mt AS (SELECT tenant_id, token::text AS token, occurred_at, message_id FROM message_search_tokens),
           md AS (SELECT m.tenant_id, l.token, m.occurred_at, m.id AS message_id FROM messages m, unnest(tsvector_to_array(m.search_tsv)) l(token)),
           nt AS (SELECT tenant_id, token::text AS token, created_at, note_id FROM note_search_tokens),
           nd AS (SELECT n.tenant_id, l.token, n.created_at, n.id AS note_id FROM notes n, unnest(tsvector_to_array(n.search_tsv)) l(token))
      SELECT (SELECT count(*)::int FROM (SELECT * FROM mt EXCEPT SELECT * FROM md) x) AS m_extra,
             (SELECT count(*)::int FROM (SELECT * FROM md EXCEPT SELECT * FROM mt) x) AS m_missing,
             (SELECT count(*)::int FROM (SELECT * FROM nt EXCEPT SELECT * FROM nd) x) AS n_extra,
             (SELECT count(*)::int FROM (SELECT * FROM nd EXCEPT SELECT * FROM nt) x) AS n_missing,
             (SELECT count(*)::int FROM mt) AS m`)).rows[0]!;
    expect(r).toEqual({ m_extra: 0, m_missing: 0, n_extra: 0, n_missing: 0, m: expect.any(Number) });
    expect(r.m).toBeGreaterThan(10_000);
  });

  it('R-PERM-4/6: every actor sees a token row exactly when they see its message or note', async () => {
    const seen = new Set<string>();
    for (const { label, actor } of actors) {
      const r = await withTenantTx(actor, async (tx) => (await sql<{ m_diff: number; n_diff: number; msgs: number }>`
        WITH vm AS (SELECT id, length(search_tsv) AS n FROM messages WHERE length(search_tsv) > 0),
             tm AS (SELECT message_id, count(*)::int AS n FROM message_search_tokens GROUP BY 1),
             vn AS (SELECT id, length(search_tsv) AS n FROM notes WHERE length(search_tsv) > 0),
             tn AS (SELECT note_id, count(*)::int AS n FROM note_search_tokens GROUP BY 1)
        SELECT (SELECT count(*)::int FROM vm FULL JOIN tm ON tm.message_id = vm.id WHERE vm.n IS DISTINCT FROM tm.n) AS m_diff,
               (SELECT count(*)::int FROM vn FULL JOIN tn ON tn.note_id = vn.id WHERE vn.n IS DISTINCT FROM tn.n) AS n_diff,
               (SELECT count(*)::int FROM vm) AS msgs`.execute(tx)).rows[0]!,
      { db: appDb, ownershipCommand: CMD });
      expect(r.m_diff, label).toBe(0);
      expect(r.n_diff, label).toBe(0);
      seen.add(String(r.msgs));
    }
    expect(seen.size).toBeGreaterThan(3); // the actors see different sets (not vacuous)
  }, 600_000);

  for (const table of ['messages', 'notes'] as const) {
    it(`${table}: the new query returns the old query's rows in the old order, for every actor and term, by both access paths (limit 10 and unlimited)`, async () => {
      const shapes = new Set<string>();
      for (const { label, actor } of actors) {
        const oldAll = await oldResults(actor, table, tsqs);
        // every access path, by the longest lexeme (0) and by the last one (9: the shortest of a several-word term)
        for (const [limit, how, lexeme] of [[10, 'auto', 0], [10, 'probe', 0], [10, 'walk', 0], [ALL, 'probe', 0], [ALL, 'walk', 0], [10, 'probe', 9], [ALL, 'walk', 9]] as const) {
          const newR = await newResults(actor, table, tsqs, limit, how, lexeme);
          for (const [i, q] of tsqs.entries()) {
            expect(newR[i], `${label} ${table} "${q}" limit ${limit} ${how} lexeme ${lexeme}`).toEqual(oldAll[i]!.slice(0, limit));
            if (limit === ALL) shapes.add(`${q}:${Math.min(oldAll[i]!.length, 2)}`);
          }
        }
      }
      // the terms include no-match, few-match and many-match cases
      const counts = new Set([...shapes].map((s) => s.split(':').pop()));
      expect(counts).toEqual(new Set(['0', '1', '2']));
    }, 1_200_000);
  }

  it('app_user cannot write the token tables', async () => {
    const a = actors.find((x) => x.label.startsWith('owner'))!.actor;
    for (const stmt of [
      sql`INSERT INTO message_search_tokens (tenant_id, token, occurred_at, message_id) VALUES (app.tenant_id(), 'forged', now(), ${randomUUID()})`,
      sql`DELETE FROM message_search_tokens WHERE tenant_id = app.tenant_id()`,
      sql`UPDATE note_search_tokens SET token = 'x' WHERE tenant_id = app.tenant_id()`,
      sql`INSERT INTO note_search_tokens (tenant_id, token, created_at, note_id) VALUES (app.tenant_id(), 'forged', now(), ${randomUUID()})`,
    ]) {
      await expect(withTenantTx(a, (tx) => stmt.execute(tx), { db: appDb })).rejects.toMatchObject({ code: '42501' });
    }
  });
});

// The token tables hold message and note text (their `token` column is PII). Rows are removed only by the
// AFTER DELETE statement triggers, which must also fire for the FK cascades of erasure and retention, for the
// import revert definer, and must leave nothing behind when a merge re-points notes. An orphan token row would be
// invisible to every member (its EXISTS-over-parent policy is false), so only the superuser can see the leak.
describe('search token tables after erasure, retention, a merge and an import revert', () => {
  const ownerOf = () => actors.find((a) => a.label.startsWith('owner'))!.actor;
  const tokensOf = async (messageIds: string[], noteIds: string[]) => (await su.query<{ m: number; n: number }>(`
    SELECT (SELECT count(*)::int FROM message_search_tokens WHERE message_id = ANY ($1::uuid[])) AS m,
           (SELECT count(*)::int FROM note_search_tokens WHERE note_id = ANY ($2::uuid[])) AS n`, [messageIds, noteIds])).rows[0]!;
  const orphans = async () => (await su.query<{ m: number; n: number }>(`
    SELECT (SELECT count(*)::int FROM message_search_tokens t WHERE NOT EXISTS (SELECT 1 FROM messages p WHERE p.tenant_id = t.tenant_id AND p.id = t.message_id)) AS m,
           (SELECT count(*)::int FROM note_search_tokens t WHERE NOT EXISTS (SELECT 1 FROM notes p WHERE p.tenant_id = t.tenant_id AND p.id = t.note_id)) AS n`)).rows[0]!;
  /** a contact of the large tenant on no deal, with messages and notes that have tokens; its message and note ids */
  const taken: string[] = [];
  const pick = async () => {
    const c = (await su.query<{ id: string; owner: string | null }>(`
      SELECT c.id, c.owner_user_id AS owner FROM contacts c WHERE c.tenant_id = $1 AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL
         AND c.ownership_state = 'owned' AND NOT (c.id = ANY ($2::uuid[]))
         AND NOT EXISTS (SELECT 1 FROM deal_contacts d WHERE d.tenant_id = c.tenant_id AND d.contact_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.tenant_id = c.tenant_id AND d.primary_contact_id = c.id)
         AND EXISTS (SELECT 1 FROM message_search_tokens t JOIN messages m ON m.tenant_id = t.tenant_id AND m.id = t.message_id WHERE m.tenant_id = c.tenant_id AND m.contact_id = c.id)
         AND EXISTS (SELECT 1 FROM note_search_tokens t JOIN notes n ON n.tenant_id = t.tenant_id AND n.id = t.note_id WHERE n.tenant_id = c.tenant_id AND n.contact_id = c.id)
       ORDER BY md5(c.id::text) LIMIT 1`, [T, taken])).rows[0]!;
    taken.push(c.id);
    const messageIds = (await su.query<{ id: string }>(`SELECT id FROM messages WHERE tenant_id = $1 AND contact_id = $2`, [T, c.id])).rows.map((r) => r.id);
    const noteIds = (await su.query<{ id: string }>(`SELECT id FROM notes WHERE tenant_id = $1 AND contact_id = $2`, [T, c.id])).rows.map((r) => r.id);
    const before = await tokensOf(messageIds, noteIds);
    expect(before.m).toBeGreaterThan(0);
    expect(before.n).toBeGreaterThan(0);
    return { ...c, messageIds, noteIds };
  };
  const exact = async () => {
    const r = (await su.query<{ m_extra: number; m_missing: number; n_extra: number; n_missing: number }>(`
      WITH mt AS (SELECT tenant_id, token::text AS token, occurred_at, message_id FROM message_search_tokens),
           md AS (SELECT m.tenant_id, l.token, m.occurred_at, m.id AS message_id FROM messages m, unnest(tsvector_to_array(m.search_tsv)) l(token)),
           nt AS (SELECT tenant_id, token::text AS token, created_at, note_id FROM note_search_tokens),
           nd AS (SELECT n.tenant_id, l.token, n.created_at, n.id AS note_id FROM notes n, unnest(tsvector_to_array(n.search_tsv)) l(token))
      SELECT (SELECT count(*)::int FROM (SELECT * FROM mt EXCEPT SELECT * FROM md) x) AS m_extra,
             (SELECT count(*)::int FROM (SELECT * FROM md EXCEPT SELECT * FROM mt) x) AS m_missing,
             (SELECT count(*)::int FROM (SELECT * FROM nt EXCEPT SELECT * FROM nd) x) AS n_extra,
             (SELECT count(*)::int FROM (SELECT * FROM nd EXCEPT SELECT * FROM nt) x) AS n_missing`)).rows[0]!;
    expect(r).toEqual({ m_extra: 0, m_missing: 0, n_extra: 0, n_missing: 0 });
    expect(await orphans()).toEqual({ m: 0, n: 0 });
  };

  it('R-DATA-4 R-DATA-7: erasure (app.erase_contact, FK cascade) leaves no token row of the contact\'s messages and notes', async () => {
    const c = await pick();
    await withTenantTx(ownerOf(), (tx) => sql`SELECT app.erase_contact(${c.id}::uuid, ${randomUUID()}::uuid, 'search token erasure check')`.execute(tx), { db: appDb });
    expect((await su.query(`SELECT 1 FROM contacts WHERE tenant_id = $1 AND id = $2`, [T, c.id])).rowCount).toBe(0);
    expect(await tokensOf(c.messageIds, c.noteIds)).toEqual({ m: 0, n: 0 });
    await exact();
  });

  it('R-DATA-3 R-DATA-5: the retention sweep\'s purge of a soft-deleted contact leaves no token row behind', async () => {
    const c = await pick();
    await su.query('BEGIN');
    await su.query('SET LOCAL session_replication_role = replica');
    await su.query(`UPDATE contacts SET deleted_at = now() - interval '31 days', purge_after = now() - interval '1 minute', ownership_state = 'closed', closed_reason = 'deleted',
                           owner_user_id = NULL, owned_at = NULL, first_touch_due_at = NULL, first_touch_at = NULL, first_touch_breached_at = NULL, release_due_at = NULL,
                           inactivity_warn_at = NULL, inactivity_release_at = NULL, ownership_period_seq = NULL WHERE tenant_id = $1 AND id = $2`, [T, c.id]);
    await su.query('COMMIT');
    const app = new pg.Client({ connectionString: db.appUserUrl });
    await app.connect();
    try {
      const r = (await app.query<{ r: { contacts_purged: number } }>(`SELECT app.retention_sweep(now()) AS r`)).rows[0]!.r;
      expect(r.contacts_purged).toBe(1);
    } finally {
      await app.end();
    }
    expect((await su.query(`SELECT 1 FROM contacts WHERE tenant_id = $1 AND id = $2`, [T, c.id])).rowCount).toBe(0);
    expect(await tokensOf(c.messageIds, c.noteIds)).toEqual({ m: 0, n: 0 });
    await exact();
  });

  it('R-PAR-45: a merge re-points the loser\'s notes with their tokens (nothing orphaned, nothing lost)', async () => {
    const loser = await pick();
    const survivor = (await su.query<{ id: string }>(`
      SELECT id FROM contacts WHERE tenant_id = $1 AND owner_user_id = $2 AND ownership_state = 'owned' AND deleted_at IS NULL AND merged_into_contact_id IS NULL
         AND id <> $3 AND NOT (id = ANY ($4::uuid[])) ORDER BY md5(id::text) LIMIT 1`, [T, loser.owner, loser.id, taken])).rows[0]!.id;
    taken.push(survivor);
    const before = await tokensOf(loser.messageIds, loser.noteIds);
    const r = await applyOwnershipCommand(ownerOf(), survivor as ContactId, { kind: 'merge', survivorId: survivor as ContactId, loserId: loser.id as ContactId, ownerChoice: null },
      { commandId: randomUUID(), db: appDb });
    expect(r.outcome.ok, JSON.stringify(r.outcome)).toBe(true);
    const moved = (await su.query<{ n: number }>(`SELECT count(*)::int AS n FROM notes WHERE tenant_id = $1 AND contact_id = $2 AND id = ANY ($3::uuid[])`, [T, survivor, loser.noteIds])).rows[0]!.n;
    expect(moved).toBe(loser.noteIds.length);
    expect(await tokensOf(loser.messageIds, loser.noteIds)).toEqual(before);
    await exact();
  });

  it('an import revert (app.import_revert_delete) removes the reverted messages\' and notes\' tokens', async () => {
    const owner = ownerOf() as Extract<Actor, { kind: 'user' }>;
    const c = await pick();
    const batch = randomUUID();
    const stage = randomUUID();
    const rec = randomUUID();
    await su.query(`INSERT INTO import_batches (tenant_id, id, source, status, created_by_user_id, source_snapshot_sha256) VALUES ($1, $2, 'csv', 'committed', $3, $4)`, [T, batch, owner.userId, 'c'.repeat(64)]);
    await su.query(`INSERT INTO import_stages (tenant_id, id, batch_id, category, seq, status) VALUES ($1, $2, $3, 'messages', 4, 'reverting')`, [T, stage, batch]);
    await su.query(`INSERT INTO import_records (tenant_id, id, stage_id, source_ref, outcome, raw_purged_at, target_id) VALUES ($1, $2, $3, 'file.csv#row=9', 'imported', now(), $4)`, [T, rec, stage, randomUUID()]);
    const messageIds = [randomUUID(), randomUUID()];
    const noteIds = [randomUUID(), randomUUID()];
    for (const id of messageIds) {
      await su.query(`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body, status, initiator, imported, import_record_id, occurred_at)
                      SELECT tenant_id, $2, id, contact_id, 'sms', 'inbound', '+14155550100', '+14155550101', 'revertword imported from FUB', 'received', 'import', true, $3, now() - interval '5 days'
                        FROM conversations WHERE tenant_id = $1 AND contact_id = $4 LIMIT 1`, [T, id, rec, c.id]);
    }
    for (const id of noteIds) {
      await su.query(`INSERT INTO notes (tenant_id, id, contact_id, body, source, imported, import_record_id, created_at) VALUES ($1, $2, $3, 'revertword imported note', 'import', true, $4, now() - interval '5 days')`, [T, id, c.id, rec]);
    }
    const inserted = await tokensOf(messageIds, noteIds);
    expect(inserted.m).toBeGreaterThan(0);
    expect(inserted.n).toBeGreaterThan(0);
    const reverted = await withTenantTx(owner, async (tx) => [
      ...(await sql<{ id: string }>`SELECT x::text AS id FROM app.import_revert_delete(${stage}::uuid, 'messages', ${messageIds}::uuid[]) AS x`.execute(tx)).rows,
      ...(await sql<{ id: string }>`SELECT x::text AS id FROM app.import_revert_delete(${stage}::uuid, 'notes', ${noteIds}::uuid[]) AS x`.execute(tx)).rows,
    ], { db: appDb });
    expect(reverted.map((r) => r.id).sort()).toEqual([...messageIds, ...noteIds].sort());
    expect(await tokensOf(messageIds, noteIds)).toEqual({ m: 0, n: 0 });
    // the contact's own messages and notes keep theirs
    expect((await tokensOf(c.messageIds, c.noteIds)).m).toBeGreaterThan(0);
    await exact();
  });
});
