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
//   listings  `search_tsv` + address trigram;  deals: name;  notes / messages: `search_tsv`
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
    const r = await sql<{ id: string; contact_id: string | null; deal_id: string | null; body: string; created_at: Date }>`
      SELECT n.id, n.contact_id, n.deal_id, n.body, n.created_at FROM notes n
       WHERE n.tenant_id = app.tenant_id() AND n.search_tsv @@ to_tsquery('simple', ${tsq})
       ORDER BY n.created_at DESC LIMIT ${SEARCH_LIMIT}`.execute(tx);
    return r.rows.map((x) => ({ id: x.id, contactId: x.contact_id, dealId: x.deal_id, snippet: snippet(x.body) ?? '', createdAt: x.created_at.toISOString() }));
  });

  const messages = branch(db, actor, 'messages', incomplete, async (tx) => {
    if (tsq === null) return [];
    const r = await sql<{ id: string; contact_id: string; channel: string; direction: string; body: string; occurred_at: Date }>`
      SELECT m.id, m.contact_id, m.channel, m.direction, m.body, m.occurred_at FROM messages m
       WHERE m.tenant_id = app.tenant_id() AND m.search_tsv @@ to_tsquery('simple', ${tsq})
       ORDER BY m.occurred_at DESC LIMIT ${SEARCH_LIMIT}`.execute(tx);
    return r.rows.map((x) => ({ id: x.id, contactId: x.contact_id, channel: x.channel, direction: x.direction, snippet: snippet(x.body) ?? '', occurredAt: x.occurred_at.toISOString() }));
  });

  const [c, l, d, n, m] = await Promise.all([contacts, listings, deals, notes, messages]);
  return { contacts: c, listings: l, deals: d, notes: n, messages: m, incomplete: incomplete.sort() };
}
