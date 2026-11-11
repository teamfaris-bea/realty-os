// message_templates persistence (parity module 63; R-PAR-23..26). Every query runs under the caller's RLS:
// team templates are read by members and written by Owner/Admin; a personal template is its owner's alone
// (Owner/Admin do not read it). The DB guard keeps scope/owner/channel and bumps the version with content.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface TemplateRow {
  id: string;
  scope: 'team' | 'personal';
  ownerUserId: string | null;
  channel: 'sms' | 'email';
  name: string;
  subject: string | null;
  body: string;
  version: number;
  mergeFields: string[];
  updatedByUserId: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface Raw {
  id: string;
  scope: TemplateRow['scope'];
  owner_user_id: string | null;
  channel: TemplateRow['channel'];
  name: string;
  subject: string | null;
  body: string;
  version: number;
  merge_fields: string[];
  updated_by_user_id: string;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLS = sql`id, scope, owner_user_id, channel, name, subject, body, version, merge_fields, updated_by_user_id, archived_at, created_at, updated_at`;

const row = (x: Raw): TemplateRow => ({
  id: x.id,
  scope: x.scope,
  ownerUserId: x.owner_user_id,
  channel: x.channel,
  name: x.name,
  subject: x.subject,
  body: x.body,
  version: Number(x.version),
  mergeFields: x.merge_fields,
  updatedByUserId: x.updated_by_user_id,
  archivedAt: x.archived_at,
  createdAt: x.created_at,
  updatedAt: x.updated_at,
});

/** Live templates the caller can read (team + own personal), team first, then by name. */
export async function listTemplates(tx: Tx, o: { channel?: 'sms' | 'email' | undefined; includeArchived?: boolean }): Promise<TemplateRow[]> {
  const r = await sql<Raw>`
    SELECT ${COLS} FROM message_templates
     WHERE tenant_id = app.tenant_id()
       AND (${o.channel ?? null}::text IS NULL OR channel = ${o.channel ?? null}::text)
       AND (${o.includeArchived === true} OR archived_at IS NULL)
     ORDER BY scope DESC, lower(name), id
     LIMIT 500`.execute(tx);
  return r.rows.map(row);
}

export async function templateById(tx: Tx, id: string, o: { lock?: boolean } = {}): Promise<TemplateRow | null> {
  const r = o.lock
    ? await sql<Raw>`SELECT ${COLS} FROM message_templates WHERE tenant_id = app.tenant_id() AND id = ${id} FOR UPDATE`.execute(tx)
    : await sql<Raw>`SELECT ${COLS} FROM message_templates WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  return r.rows[0] ? row(r.rows[0]) : null;
}

export interface TemplateInsert {
  id: string;
  scope: 'team' | 'personal';
  channel: 'sms' | 'email';
  name: string;
  subject: string | null;
  body: string;
  mergeFields: string[];
}

/** false when the live name is taken in that scope/owner/channel (the unique index). */
export async function insertTemplate(tx: Tx, t: TemplateInsert): Promise<boolean> {
  const r = await sql<{ id: string }>`
    INSERT INTO message_templates (tenant_id, id, scope, owner_user_id, channel, name, subject, body, merge_fields, updated_by_user_id)
    VALUES (app.tenant_id(), ${t.id}, ${t.scope}, ${t.scope === 'personal' ? sql`app.user_id()` : null}, ${t.channel}, ${t.name}, ${t.subject},
            ${t.body}, ${t.mergeFields}::text[], app.user_id())
    ON CONFLICT DO NOTHING RETURNING id`.execute(tx);
  return r.rows.length === 1;
}

/** Content and/or name update; the version moves by one exactly when the content changes (DB guard). */
export async function updateTemplate(tx: Tx, id: string, t: { name: string; subject: string | null; body: string; mergeFields: string[]; bumpVersion: boolean }): Promise<boolean> {
  const r = await sql<{ id: string }>`
    UPDATE message_templates
       SET name = ${t.name}, subject = ${t.subject}, body = ${t.body}, merge_fields = ${t.mergeFields}::text[],
           version = version + ${t.bumpVersion ? 1 : 0}, updated_by_user_id = app.user_id()
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND archived_at IS NULL
    RETURNING id`.execute(tx);
  return r.rows.length === 1;
}

export async function archiveTemplate(tx: Tx, id: string): Promise<boolean> {
  const r = await sql<{ id: string }>`
    UPDATE message_templates SET archived_at = now(), updated_by_user_id = app.user_id()
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND archived_at IS NULL RETURNING id`.execute(tx);
  return r.rows.length === 1;
}

/** Live and archived custom field keys (merge fields `field.<key>` must name a live one). */
export async function customFieldKeys(tx: Tx): Promise<{ live: Set<string>; archived: Set<string> }> {
  const r = await sql<{ key: string; archived: boolean }>`
    SELECT key, archived_at IS NOT NULL AS archived FROM custom_field_defs WHERE tenant_id = app.tenant_id()`.execute(tx);
  const live = new Set<string>();
  const archived = new Set<string>();
  for (const x of r.rows) (x.archived ? archived : live).add(x.key);
  return { live, archived };
}
