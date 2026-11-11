// Search (BUILD_PLAN module 14; ARCHITECTURE §14; A1 "Find a contact": type-ahead, < 300 ms p95).
//
//   GET /search?q=   → { contacts, listings, deals, notes, messages, incomplete }               self (RLS)
//
// One query per entity, run IN PARALLEL, each in its own transaction under the CALLER's RLS with a 300 ms
// statement timeout and at most 10 rows. A branch that times out is returned empty and named in
// `incomplete` (honest partial results, never a silent miss). No search index lives outside Postgres.
//
//   contacts  name: prefix of the display name or last name; phone: the last 7–10 digits of the query
//             against E.164 numbers; email: prefix of the address; address: prefix of the street line.
//             These use the RLS-indexable keys of migration 0011 (leakproof btree comparisons only). The
//             0001 `search_tsv` / trigram indexes cannot serve a caller under RLS (their operators are not
//             leakproof), so contact search is prefix-based, not typo-tolerant: a fuzzy pass scanned the
//             whole tenant and missed the 300 ms budget at 250k contacts (measured), so it was removed.
//   listings  `search_tsv` + address trigram;  deals: name;
//   notes / messages: `search_tsv`, reached through the token tables of migration *_search_visibility.sql
//             (searchNotes / searchMessages): the same rows as the plain `@@` query, newest first, ties by id.
//
// R-PERM-4 / R-PERM-6: contact points, addresses, notes and messages of a contact the caller sees only
// as a pond or offer card are hidden by RLS (contact_detail_visible), so such a contact can be found by
// its name only (never by phone, email or address), and its last name is masked to an initial.
// Transcripts are encrypted and not searchable.
import type { UserActor } from '@realty/core/foundation';
import { type Database, type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import type { z } from 'zod';
import { mapWorkspaceDbError, snippet } from './common.js';
import type { SearchResponse } from './schemas.js';

export type SearchResult = z.infer<typeof SearchResponse>;
type Group = SearchResult['incomplete'][number];

export const SEARCH_LIMIT = 10;
export const SEARCH_TIMEOUT_MS = 300;

/** `simple`-config prefix tsquery from the words of the query (letters and digits only: injection-safe). */
export function prefixTsQuery(q: string): string | null {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return null;
  return words.slice(0, 8).map((w) => `${w}:*`).join(' & ');
}

/** The last 7–10 digits of a phone-like query (null when it has fewer than 7 digits). */
export function phoneSuffix(q: string): string | null {
  const d = q.replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-10) : null;
}

/** The smallest string greater than every string starting with `p` (code-point order = "C" collation). */
export function prefixUpperBound(p: string): string {
  if (p.length === 0) return '\u{10FFFF}';
  const cps = [...p];
  const last = cps.pop()!.codePointAt(0)!;
  return cps.join('') + String.fromCodePoint(Math.min(last + 1, 0x10ffff));
}

/**
 * The smallest string greater than every string that starts with `p`, in code-point ("C") order, or null
 * when there is none (p is empty or made only of U+10FFFF). Skips the surrogate gap, which text never holds.
 */
export function prefixRangeEnd(p: string): string | null {
  const cps = [...p];
  while (cps.length > 0) {
    const last = cps.pop()!.codePointAt(0)!;
    if (last < 0x10ffff) return cps.join('') + String.fromCodePoint(last + 1 === 0xd800 ? 0xe000 : last + 1);
  }
  return null;
}

/**
 * The lexemes of a tsquery as Postgres prints it (`'jane':* & 'doe':*`), or null when the query uses an
 * operator other than AND / phrase (then a token probe would not be a superset of the matches).
 */
export function tsQueryLexemes(printed: string): string[] | null {
  const lexemes: string[] = [];
  const rest = printed.replace(/'((?:[^']|'')*)'/g, (_m, lex: string) => {
    lexemes.push(lex.replace(/''/g, "'"));
    return '';
  });
  if (!/^(?:\s|&|<(?:\d+|-)>|[()]|:\*?[A-D]*\*?)*$/.test(rest) || /\\/.test(printed)) return null;
  return lexemes;
}

/**
 * The distinct lexemes of the query, longest first (every lexeme of an AND / phrase query must occur, as a
 * prefix, in every matching row, so a probe by ANY one of them finds a superset of the matches; longer ones are
 * usually more selective). `[]` means the query has no lexeme (it matches nothing); null means use the plain
 * `@@` query.
 */
async function queryLexemes(tx: Tx, tsq: string): Promise<string[] | null> {
  const r = await sql<{ q: string }>`SELECT to_tsquery('simple', ${tsq})::text AS q`.execute(tx);
  const lexemes = tsQueryLexemes(r.rows[0]!.q);
  if (lexemes === null) return null;
  return [...new Set(lexemes)].sort((a, b) => [...b].length - [...a].length);
}

type NoteRow = { id: string; contact_id: string | null; deal_id: string | null; body: string; created_at: Date };
type MessageRow = { id: string; contact_id: string; channel: string; direction: string; body: string; occurred_at: Date };

/**
 * How a text branch reads its token table (every path gives the same rows; the tests run each):
 *   'probe'  btree range on the token (the primary key), RLS on every matching token row, then sort. Cheap when
 *            few rows match (most type-ahead terms), slow when thousands do.
 *   'walk'   the newest-first index, testing the prefix on each index entry (leakproof, before RLS) and stopping
 *            at the first `limit` visible matches. Cheap when many rows match, a full index walk when none do.
 *            The pattern is passed as an InitPlan (`(SELECT $1)`) so the planner cannot turn it into a range
 *            on the primary key (it would: its row estimates under RLS are far too low to prefer the walk).
 *   'auto'   (GET /search) probe by each lexeme, longest first, each for at most PROBE_MS and all within
 *            PROBE_BUDGET_MS (a probe by any lexeme is complete); if none finishes, walk by the longest lexeme
 *            with the rest of the branch's SEARCH_TIMEOUT_MS. The branch's total budget is unchanged; a walk
 *            that runs out of it makes the branch `incomplete`, as before.
 * `lexeme` (tests) picks which lexeme 'probe' / 'walk' use, by index into the longest-first list.
 */
export type TextStrategy = 'auto' | 'probe' | 'walk';
export const PROBE_MS = 25;
export const PROBE_BUDGET_MS = 60;

interface TextTable {
  parent: 'notes' | 'messages';
  tokens: 'note_search_tokens' | 'message_search_tokens';
  ts: 'created_at' | 'occurred_at';
  ref: 'note_id' | 'message_id';
  cols: string;
}
const NOTES: TextTable = { parent: 'notes', tokens: 'note_search_tokens', ts: 'created_at', ref: 'note_id', cols: 'p.id, p.contact_id, p.deal_id, p.body, p.created_at' };
const MESSAGES: TextTable = { parent: 'messages', tokens: 'message_search_tokens', ts: 'occurred_at', ref: 'message_id', cols: 'p.id, p.contact_id, p.channel, p.direction, p.body, p.occurred_at' };

async function textSearch<R>(tx: Tx, t: TextTable, tsq: string, limit: number, strategy: TextStrategy, lexeme: number): Promise<R[]> {
  const parent = sql.table(t.parent);
  const tokens = sql.table(t.tokens);
  const ts = sql.ref(`t.${t.ts}`);
  const ref = sql.ref(`t.${t.ref}`);
  const cts = sql.ref(`c.${t.ts}`);
  const cref = sql.ref(`c.${t.ref}`);
  const cols = sql.raw(t.cols);
  const lexemes = await queryLexemes(tx, tsq);
  if (lexemes !== null && lexemes.length === 0) return [];
  if (lexemes === null) {
    // a query shape the token tables cannot narrow (not produced by prefixTsQuery): the plain query
    return (await sql<R>`
      SELECT ${cols} FROM ${parent} p WHERE p.tenant_id = app.tenant_id() AND p.search_tsv @@ to_tsquery('simple', ${tsq})
       ORDER BY ${sql.ref(`p.${t.ts}`)} DESC, p.id DESC LIMIT ${limit}`.execute(tx)).rows;
  }
  const run = async (how: 'probe' | 'walk', probe: string) => {
    const hi = prefixRangeEnd(probe);
    const match = how === 'probe'
      ? sql`t.token >= ${probe} AND (${hi}::text IS NULL OR t.token < ${hi}) AND starts_with(t.token, ${probe})`
      : sql`starts_with(t.token, (SELECT ${probe}::text))`;
    return (await sql<R>`
      SELECT ${cols}
        FROM (SELECT DISTINCT ${ts}, ${ref} FROM ${tokens} t
               WHERE t.tenant_id = app.tenant_id() AND ${match}
               ORDER BY ${ts} DESC, ${ref} DESC) c
        JOIN ${parent} p ON p.tenant_id = app.tenant_id() AND p.id = ${cref}
       WHERE p.search_tsv @@ to_tsquery('simple', ${tsq})
       ORDER BY ${cts} DESC, ${cref} DESC LIMIT ${limit}`.execute(tx)).rows;
  };
  if (strategy !== 'auto') return run(strategy, lexemes[Math.min(lexeme, lexemes.length - 1)]!);
  const t0 = performance.now();
  for (const probe of lexemes) {
    const budget = Math.min(PROBE_MS, Math.floor(PROBE_BUDGET_MS - (performance.now() - t0)));
    if (budget < 5) break;
    await sql`SAVEPOINT search_probe`.execute(tx);
    try {
      await sql`SELECT set_config('statement_timeout', ${String(budget)}, true)`.execute(tx);
      const rows = await run('probe', probe);
      await sql`RELEASE SAVEPOINT search_probe`.execute(tx);
      return rows;
    } catch (e) {
      if ((e as { code?: string })?.code !== '57014') throw e;
      await sql`ROLLBACK TO SAVEPOINT search_probe`.execute(tx);
    }
  }
  const left = Math.max(1, Math.floor(SEARCH_TIMEOUT_MS - (performance.now() - t0)));
  await sql`SELECT set_config('statement_timeout', ${String(left)}, true)`.execute(tx);
  return run('walk', lexemes[0]!);
}


/**
 * Notes matching the prefix tsquery `tsq`, newest first (ties by id), at most `limit`, under the caller's RLS.
 *
 * Candidates come from note_search_tokens (migration *_search_visibility.sql: the lexemes of each note's own
 * search_tsv, visible exactly when the note is) through leakproof "C" prefix comparisons (starts_with, >=, <),
 * so the planner may use its indexes before RLS and run the visibility check on matching rows only;
 * the original `search_tsv @@ tsquery` is then re-checked on each candidate note, so the rows are the plain
 * query's rows (proved in apps/api/src/load/search_equivalence.test.ts).
 */
export function searchNotes(tx: Tx, tsq: string, limit = SEARCH_LIMIT, strategy: TextStrategy = 'auto', lexeme = 0): Promise<NoteRow[]> {
  return textSearch<NoteRow>(tx, NOTES, tsq, limit, strategy, lexeme);
}

/** Messages matching the prefix tsquery `tsq`, newest first (ties by id); as searchNotes, via message_search_tokens. */
export function searchMessages(tx: Tx, tsq: string, limit = SEARCH_LIMIT, strategy: TextStrategy = 'auto', lexeme = 0): Promise<MessageRow[]> {
  return textSearch<MessageRow>(tx, MESSAGES, tsq, limit, strategy, lexeme);
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Pond-card masking (R-PERM-6): "Jane D." */
export function maskedName(first: string | null, last: string | null, display: string): string {
  if (first && last) return `${first} ${last.slice(0, 1).toUpperCase()}.`;
  if (first) return first;
  const parts = display.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]!.slice(0, 1).toUpperCase()}.` : (parts[0] ?? display);
}

async function branch<T>(db: Database, actor: UserActor, name: Group, incomplete: Group[], fn: (tx: Tx) => Promise<T[]>): Promise<T[]> {
  try {
    return await withTenantTx(
      actor,
      async (tx) => {
        await sql`SELECT set_config('statement_timeout', ${String(SEARCH_TIMEOUT_MS)}, true)`.execute(tx);
        return fn(tx);
      },
      { db },
    );
  } catch (e) {
    if ((e as { code?: string })?.code === '57014') {
      incomplete.push(name);
      return [];
    }
    throw mapWorkspaceDbError(e) ?? e;
  }
}

export async function search(db: Database, actor: UserActor, rawQ: string): Promise<SearchResult> {
  const q = rawQ.trim();
  const tsq = prefixTsQuery(q);
  const like = `${likeEscape(q)}%`;
  const contains = `%${likeEscape(q)}%`;
  const digits = phoneSuffix(q);
  const email = !/\s/.test(q) && q.includes('@') ? `${likeEscape(q.toLowerCase())}%` : null;
  const incomplete: Group[] = [];

  type Hit = { id: string; matched_on: 'name' | 'phone' | 'email' | 'address'; prio: number };
  const toContacts = async (tx: Tx, hits: Hit[]) => {
    const best = new Map<string, Hit['matched_on']>();
    for (const h of hits) if (!best.has(h.id)) best.set(h.id, h.matched_on);
    const ids = [...best.keys()].slice(0, SEARCH_LIMIT * 2);
    if (ids.length === 0) return [];
    const rows = await sql<{ id: string; display_name: string; first_name: string | null; last_name: string | null; ownership_state: string; detail: boolean }>`
      SELECT c.id, c.display_name, c.first_name, c.last_name, c.ownership_state, app.contact_detail_visible(c.tenant_id, c.id) AS detail
        FROM contacts c WHERE c.tenant_id = app.tenant_id() AND c.id = ANY (${ids}::uuid[]) AND c.deleted_at IS NULL`.execute(tx);
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
      .slice(0, SEARCH_LIMIT)
      .map((r) => ({
        id: r.id,
        name: !r.detail && r.ownership_state === 'in_pond' ? maskedName(r.first_name, r.last_name, r.display_name) : r.display_name,
        view: r.detail ? ('full' as const) : ('card' as const),
        ownershipState: r.ownership_state,
        matchedOn: best.get(r.id) ?? 'name',
      }));
  };

  // Indexed first (every predicate leakproof: btree ranges / equality on "C"-collated keys, migration 0011),
  // so RLS filters a handful of candidates instead of the whole tenant.
  const lq = q.toLowerCase();
  const hi = prefixUpperBound(lq);
  const last7 = digits ? digits.slice(-7) : null;
  const emailLo = email ? q.toLowerCase() : null;
  const emailHi = emailLo ? prefixUpperBound(emailLo) : null;
  const contacts = branch(db, actor, 'contacts', incomplete, async (tx) => {
    const hits = await sql<Hit>`
      SELECT id, matched_on, prio FROM (
        (SELECT c.id, 'name' AS matched_on, 1 AS prio, c.search_name AS k FROM contacts c
          WHERE c.tenant_id = app.tenant_id() AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL
            AND ((c.search_name >= ${lq} AND c.search_name < ${hi}) OR (c.search_last >= ${lq} AND c.search_last < ${hi}))
          ORDER BY c.search_name LIMIT ${SEARCH_LIMIT})
        UNION ALL
        (SELECT p.contact_id, 'phone', 0, '' FROM contact_points p
          WHERE ${last7}::text IS NOT NULL AND p.tenant_id = app.tenant_id() AND p.phone_suffix7 = ${last7} AND p.removed_at IS NULL
            AND p.address LIKE '%' || ${digits ?? ''} LIMIT ${SEARCH_LIMIT})
        UNION ALL
        (SELECT p.contact_id, 'email', 0, '' FROM contact_points p
          WHERE ${emailLo}::text IS NOT NULL AND p.tenant_id = app.tenant_id() AND p.kind = 'email' AND p.removed_at IS NULL
            AND (p.address COLLATE "C") >= ${emailLo} AND (p.address COLLATE "C") < ${emailHi} LIMIT ${SEARCH_LIMIT})
        UNION ALL
        (SELECT a.contact_id, 'address', 2, '' FROM contact_addresses a
          WHERE length(${q}) >= 3 AND a.tenant_id = app.tenant_id() AND a.search_line1 >= ${lq} AND a.search_line1 < ${hi} LIMIT ${SEARCH_LIMIT})
      ) h ORDER BY prio, k, id`.execute(tx);
    return toContacts(tx, hits.rows);
  });
  const listings = branch(db, actor, 'listings', incomplete, async (tx) => {
    const r = await sql<{ id: string; address_line1: string; city: string; status: string; list_price_cents: string | null }>`
      SELECT l.id, l.address_line1, l.city, l.status, l.list_price_cents FROM listings l
       WHERE l.tenant_id = app.tenant_id() AND l.source = 'team'
         AND ((${tsq}::text IS NOT NULL AND l.search_tsv @@ to_tsquery('simple', ${tsq})) OR l.address_line1 ILIKE ${like} OR l.address_line1 % ${q})
       ORDER BY (l.status IN ('active','coming_soon','pending')) DESC, similarity(l.address_line1, ${q}) DESC, l.id LIMIT ${SEARCH_LIMIT}`.execute(tx);
    return r.rows.map((x) => ({ id: x.id, address: x.address_line1, city: x.city, status: x.status, listPriceCents: x.list_price_cents === null ? null : Number(x.list_price_cents) }));
  });

  const deals = branch(db, actor, 'deals', incomplete, async (tx) => {
    const r = await sql<{ id: string; name: string; stage: string }>`
      SELECT d.id, d.name, d.stage FROM deals d WHERE d.tenant_id = app.tenant_id() AND d.name ILIKE ${contains}
       ORDER BY (d.stage IN ('closed','lost')), d.created_at DESC LIMIT ${SEARCH_LIMIT}`.execute(tx);
    return r.rows.map((x) => ({ id: x.id, name: x.name, stage: x.stage }));
  });

  const notes = branch(db, actor, 'notes', incomplete, async (tx) => {
    if (tsq === null) return [];
    const rows = await searchNotes(tx, tsq);
    return rows.map((x) => ({ id: x.id, contactId: x.contact_id, dealId: x.deal_id, snippet: snippet(x.body) ?? '', createdAt: x.created_at.toISOString() }));
  });

  const messages = branch(db, actor, 'messages', incomplete, async (tx) => {
    if (tsq === null) return [];
    const rows = await searchMessages(tx, tsq);
    return rows.map((x) => ({ id: x.id, contactId: x.contact_id, channel: x.channel, direction: x.direction, snippet: snippet(x.body) ?? '', occurredAt: x.occurred_at.toISOString() }));
  });

  const [c, l, d, n, m] = await Promise.all([contacts, listings, deals, notes, messages]);
  return { contacts: c, listings: l, deals: d, notes: n, messages: m, incomplete: incomplete.sort() };
}
