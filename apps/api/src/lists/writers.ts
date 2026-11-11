// Tag and custom-field writers (PARITY_PLAN §4.2: "60 api/lists → tag/field writers", consumed by
// module 65 api/import-parity and module 63's bulk tag/untag). They run inside the CALLER'S
// transaction and under its RLS: a user actor writes as themselves (contact_tags/contact_field_values
// policies: detail visible, not a TC), an import writes as the system actor with its batch id. They
// never decide visibility or permissions themselves; the database refuses what the actor may not do.
//
//   ensureTags(tx, ids, names, by)                    catalog upsert, first spelling wins (R-PAR-6, R-PAR-46)
//   addContactTags(tx, contactId, tagIds, by)         new links only (≤ 100 per person; protected never in bulk)
//   removeContactTags(tx, contactId, tagIds)          never lifts an opt-out (R-PAR-7)
//   ensureFieldDef(tx, ids, input, origin, byUserId)  a typed definition (R-PAR-17/18); reuses an existing key
//   setFieldValue(tx, contactId, def, raw, by, opts)  one typed value; `fillEmptyOnly` for imports (E41)
import type { IdGenerator } from '@realty/core/foundation';
import { type FieldDef, type NewFieldDefInput, validateFieldValue, validateNewFieldDef } from '@realty/core/parity/fields';
import { classifyProtected, normalizeTagName, type TagNameIssueCode } from '@realty/core/parity/tags';
import type { Tx } from '@realty/db';
import * as catalog from './repos/catalog.js';

export type TagWriter = { kind: 'user'; userId: string } | { kind: 'import' };
export type TagLinkBy = catalog.TagLinkBy;
export type ValueBy = catalog.ValueBy;

export interface EnsuredTag {
  id: string;
  name: string;
  protectedProxy: boolean;
  created: boolean;
}

export interface EnsureTagsResult {
  /** one entry per input name that resolved (same order; duplicates resolve to the same tag) */
  tags: (EnsuredTag & { asked: string })[];
  issues: { asked: string; code: TagNameIssueCode | 'TAG_LIMIT' }[];
}

/**
 * Resolves names to catalog tags, creating the missing ones (first spelling wins, E165). A name that
 * matches the fair-housing proxy lexicon creates a protected tag (R-PAR-8). The 1,000-tag limit is
 * reported per name as TAG_LIMIT (the database counts under an advisory lock).
 */
export async function ensureTags(tx: Tx, ids: IdGenerator, names: readonly string[], by: TagWriter): Promise<EnsureTagsResult> {
  const out: EnsureTagsResult = { tags: [], issues: [] };
  const normalized: { asked: string; name: string }[] = [];
  for (const asked of names) {
    const n = normalizeTagName(asked);
    if (!n.ok) out.issues.push({ asked, code: n.code });
    else normalized.push({ asked, name: n.name });
  }
  const existing = new Map((await catalog.tagsByNames(tx, normalized.map((x) => x.name))).map((t) => [t.asked, t]));
  for (const { asked, name } of normalized) {
    const hit = existing.get(name);
    if (hit) {
      out.tags.push({ asked, id: hit.id, name: hit.name, protectedProxy: hit.protected_proxy, created: false });
      continue;
    }
    let row: catalog.TagRow | null;
    try {
      row = await catalog.withSavepoint(tx, () => catalog.insertTag(tx, { id: ids.next(), name, color: null, protectedProxy: classifyProtected(name), byUserId: by.kind === 'user' ? by.userId : null }));
    } catch (e) {
      if (String((e as { message?: string }).message ?? '').startsWith('TAG_LIMIT')) {
        out.issues.push({ asked, code: 'TAG_LIMIT' });
        continue;
      }
      throw e;
    }
    let created = true;
    if (row === null) {
      // a concurrent writer (or an earlier name in this call) took the key: use that tag
      row = (await catalog.tagsByNames(tx, [name]))[0] ?? null;
      created = false;
      if (row === null) throw new Error('tag vanished during upsert');
    }
    existing.set(name, { ...row, name_key: '', asked: name });
    out.tags.push({ asked, id: row.id, name: row.name, protectedProxy: row.protected_proxy, created });
  }
  return out;
}

/** Adds tags to a person; returns the ids that were new. Errors: CONTACT_TAG_LIMIT, AUDIENCE_PROTECTED_PROXY (bulk). */
export async function addContactTags(tx: Tx, contactId: string, tagIds: readonly string[], by: TagLinkBy): Promise<{ added: string[] }> {
  return { added: await catalog.addTagLinks(tx, contactId, tagIds, by) };
}

/** Removes tags from a person; returns the ids that were removed. Removing an opt-out-like tag lifts nothing. */
export async function removeContactTags(tx: Tx, contactId: string, tagIds: readonly string[]): Promise<{ removed: string[] }> {
  return { removed: await catalog.removeTagLinks(tx, contactId, tagIds) };
}

export type EnsureFieldResult = { ok: true; def: FieldDef; created: boolean } | { ok: false; code: string; path?: string };

/**
 * A custom field definition for an import mapping or the admin sheet. A key that already exists is
 * reused when its type matches (an import maps onto it), else refused. Core refuses protected traits.
 */
export async function ensureFieldDef(tx: Tx, ids: IdGenerator, input: NewFieldDefInput, origin: 'manual' | 'fub_import' | 'csv_import', byUserId: string | null): Promise<EnsureFieldResult> {
  if (input.key !== undefined) {
    const rows = await catalog.listFieldDefs(tx, { includeArchived: true });
    const same = rows.find((r) => r.key === input.key);
    if (same) return same.field_type === input.fieldType && same.archived_at === null ? { ok: true, def: catalog.fieldDefOf(same), created: false } : { ok: false, code: 'CUSTOM_FIELD_KEY_INVALID', path: '/key' };
  }
  const v = validateNewFieldDef(input, await catalog.fieldKeys(tx));
  if (!v.ok) return { ok: false, code: v.code, ...(v.path ? { path: v.path } : {}) };
  const row = await catalog.insertFieldDef(tx, { id: ids.next(), ...v.def, position: await catalog.nextFieldPosition(tx), origin, byUserId });
  return { ok: true, def: catalog.fieldDefOf(row), created: true };
}

export type SetValueResult = { ok: true; changed: boolean; skipped?: 'not_empty' } | { ok: false; code: string };

/** Sets (or, with an empty raw value, clears) one person's value. `fillEmptyOnly` never overwrites (E41). */
export async function setFieldValue(tx: Tx, contactId: string, def: FieldDef, raw: unknown, by: ValueBy, opts: { fillEmptyOnly?: boolean } = {}): Promise<SetValueResult> {
  const v = validateFieldValue(def, raw);
  if (!v.ok) return { ok: false, code: v.code };
  const current = await catalog.fieldValue(tx, contactId, def.id);
  if (opts.fillEmptyOnly && current !== null) return { ok: true, changed: false, skipped: 'not_empty' };
  if (v.value === null) return { ok: true, changed: current === null ? false : await catalog.deleteFieldValue(tx, contactId, def.id) };
  await catalog.upsertFieldValue(tx, contactId, def.id, v.value, by);
  return { ok: true, changed: true };
}
