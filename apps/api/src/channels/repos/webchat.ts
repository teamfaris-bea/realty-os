// Queries of module 22's web chat. Pre-tenant reads go ONLY through the three 0042 definers
// (app.resolve_webchat_widget, app.webchat_session, app.webchat_poll); every write runs as the system actor of the
// tenant a definer returned (webchat_sessions: the 0018 webchat_system policy), or of the session's tenant after the
// person's role was re-read under the system actor (widget settings).
import type { Database, Tx } from '@realty/db';
import { withPreTenant } from '@realty/db';
import { sql } from 'kysely';

export interface ResolvedWidget {
  live: boolean;
  tenantId: string | null;
  connectionId: string | null;
  leadSourceId: string | null;
  allowedOrigins: string[];
}

/** app.resolve_webchat_widget (pre-tenant definer, security review item in 0042). null = unknown key. */
export async function resolveWidget(db: Database, keyHash: Buffer): Promise<ResolvedWidget | null> {
  return withPreTenant(
    async (tx) => {
      const r = await sql<{ tenant_id: string | null; connection_id: string | null; lead_source_id: string | null; live: boolean; allowed_origins: string[] }>`
        SELECT * FROM app.resolve_webchat_widget(${keyHash})`.execute(tx);
      const x = r.rows[0];
      if (!x || r.rows.length !== 1) return null;
      return { live: x.live, tenantId: x.tenant_id, connectionId: x.connection_id, leadSourceId: x.lead_source_id, allowedOrigins: x.allowed_origins ?? [] };
    },
    { db },
  );
}

export interface ResolvedSession {
  tenantId: string;
  sessionId: string;
  connectionId: string;
  contactId: string | null;
  contactPointId: string | null;
  open: boolean;
  widgetLive: boolean;
}

/** app.webchat_session (pre-tenant definer). null = unknown token (or an inactive tenant). */
export async function resolveSession(db: Database, tokenHash: Buffer): Promise<ResolvedSession | null> {
  return withPreTenant(
    async (tx) => {
      const r = await sql<{ tenant_id: string; session_id: string; connection_id: string; contact_id: string | null; contact_point_id: string | null; open: boolean; widget_live: boolean }>`
        SELECT * FROM app.webchat_session(${tokenHash})`.execute(tx);
      const x = r.rows[0];
      if (!x || r.rows.length !== 1) return null;
      return { tenantId: x.tenant_id, sessionId: x.session_id, connectionId: x.connection_id, contactId: x.contact_id, contactPointId: x.contact_point_id, open: x.open, widgetLive: x.widget_live };
    },
    { db },
  );
}

export interface PolledMessage {
  id: string;
  body: string;
  sentAt: Date;
  /** microseconds since the epoch (the cursor keeps Postgres' precision) */
  sentAtUs: string;
  author: 'team' | 'assistant';
}

/** app.webchat_poll (pre-tenant definer, R-TEN-12): this session's delivered outbound chat messages only. */
export async function poll(db: Database, tokenHash: Buffer, after: { us: string; id: string } | null, limit: number): Promise<PolledMessage[]> {
  return withPreTenant(
    async (tx) => {
      const afterAt = after ? sql`to_timestamp(${after.us}::numeric / 1000000)` : sql`NULL::timestamptz`;
      const r = await sql<{ message_id: string; body: string; sent_at: Date; us: string; author: 'team' | 'assistant' }>`
        SELECT message_id, body, sent_at, (extract(epoch FROM sent_at) * 1000000)::bigint::text AS us, author
          FROM app.webchat_poll(${tokenHash}, ${afterAt}, ${after?.id ?? null}::uuid, ${limit})`.execute(tx);
      return r.rows.map((x) => ({ id: x.message_id, body: x.body, sentAt: x.sent_at, sentAtUs: x.us, author: x.author }));
    },
    { db },
  );
}

// ---- in a tenant (system actor) -----------------------------------------------------------------------

export async function widgetRow(tx: Tx, id: string): Promise<{ id: string; status: string; lead_source_id: string | null; display_name: string; allowed_origins: string[]; connected_at: Date | null } | null> {
  return (
    await sql<{ id: string; status: string; lead_source_id: string | null; display_name: string; allowed_origins: string[]; connected_at: Date | null }>`
      SELECT id, status, lead_source_id, display_name, allowed_origins, connected_at FROM integration_connections
       WHERE tenant_id = app.tenant_id() AND kind = 'web_chat_widget' AND id = ${id}::uuid`.execute(tx)
  ).rows[0] ?? null;
}

export async function listWidgets(tx: Tx): Promise<{ id: string; status: string; lead_source_id: string | null; display_name: string; allowed_origins: string[]; connected_at: Date | null }[]> {
  return (
    await sql<{ id: string; status: string; lead_source_id: string | null; display_name: string; allowed_origins: string[]; connected_at: Date | null }>`
      SELECT id, status, lead_source_id, display_name, allowed_origins, connected_at FROM integration_connections
       WHERE tenant_id = app.tenant_id() AND kind = 'web_chat_widget' ORDER BY created_at, id`.execute(tx)
  ).rows;
}

export async function insertWidget(tx: Tx, w: { id: string; displayName: string; leadSourceId: string; origins: readonly string[]; keyHash: Buffer; userId: string }): Promise<void> {
  await sql`INSERT INTO integration_connections (tenant_id, id, kind, display_name, lead_source_id, allowed_origins, widget_key_hash)
            VALUES (app.tenant_id(), ${w.id}::uuid, 'web_chat_widget', ${w.displayName}, ${w.leadSourceId}::uuid, ${[...w.origins]}::text[], ${w.keyHash})`.execute(tx);
  // keyed kind: no external account; switched on at once (status machine `keyed_enabled`)
  await sql`UPDATE integration_connections SET status = 'connected', status_reason = NULL, connected_at = clock_timestamp(), connected_by_user_id = ${w.userId}::uuid
             WHERE tenant_id = app.tenant_id() AND id = ${w.id}::uuid AND status = 'not_configured'`.execute(tx);
}

export async function setWidgetKey(tx: Tx, id: string, keyHash: Buffer): Promise<boolean> {
  const r = await sql`UPDATE integration_connections SET widget_key_hash = ${keyHash}
                       WHERE tenant_id = app.tenant_id() AND kind = 'web_chat_widget' AND id = ${id}::uuid AND status IN ('connected','degraded')`.execute(tx);
  return Number(r.numAffectedRows ?? 0n) === 1;
}

export async function setWidgetOrigins(tx: Tx, id: string, origins: readonly string[]): Promise<boolean> {
  const r = await sql`UPDATE integration_connections SET allowed_origins = ${[...origins]}::text[]
                       WHERE tenant_id = app.tenant_id() AND kind = 'web_chat_widget' AND id = ${id}::uuid AND status <> 'disconnected'`.execute(tx);
  return Number(r.numAffectedRows ?? 0n) === 1;
}

export async function leadSourceOf(tx: Tx, id: string): Promise<{ id: string; name: string; active: boolean; consent_disclosure_id: string | null } | null> {
  return (
    await sql<{ id: string; name: string; active: boolean; consent_disclosure_id: string | null }>`
      SELECT id, name, active, consent_disclosure_id FROM lead_sources WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx)
  ).rows[0] ?? null;
}

export async function disclosureBody(tx: Tx, id: string): Promise<{ id: string; body: string } | null> {
  return (await sql<{ id: string; body: string }>`SELECT id, body FROM consent_disclosures WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx)).rows[0] ?? null;
}

export interface SessionInsert {
  id: string;
  connectionId: string;
  tokenHash: Buffer;
  origin: string;
  ipHash: Buffer | null;
  contactId: string | null;
  contactPointId: string | null;
  claimedKind: 'phone' | 'email' | null;
  claimedAddress: string | null;
  /** sessions with no contact are purged after 30 days (R-INBOX-5) */
  purgeAfterDays: number | null;
}

export async function insertSession(tx: Tx, s: SessionInsert): Promise<void> {
  await sql`
    INSERT INTO webchat_sessions (tenant_id, id, connection_id, token_hash, origin, ip_hash, started_at, last_seen_at, contact_id, contact_point_id,
      claimed_kind, claimed_address, purge_after)
    VALUES (app.tenant_id(), ${s.id}::uuid, ${s.connectionId}::uuid, ${s.tokenHash}, ${s.origin}, ${s.ipHash}, clock_timestamp(), clock_timestamp(),
      ${s.contactId}::uuid, ${s.contactPointId}::uuid, ${s.claimedKind}, ${s.claimedAddress},
      CASE WHEN ${s.purgeAfterDays}::int IS NULL THEN NULL ELSE clock_timestamp() + make_interval(days => ${s.purgeAfterDays}::int) END)`.execute(tx);
}

/** The visitor is still here (E77: idle 30 minutes ends the session). */
export async function touchSession(tx: Tx, id: string): Promise<void> {
  await sql`UPDATE webchat_sessions SET last_seen_at = GREATEST(last_seen_at, clock_timestamp())
             WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND closed_at IS NULL`.execute(tx);
}

export async function pointIdOf(tx: Tx, contactId: string, address: string): Promise<string | null> {
  return (
    await sql<{ id: string }>`SELECT id FROM contact_points WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}::uuid AND kind = 'web_chat' AND address = ${address}`.execute(tx)
  ).rows[0]?.id ?? null;
}

export async function pointAddress(tx: Tx, pointId: string): Promise<string | null> {
  return (await sql<{ address: string }>`SELECT address FROM contact_points WHERE tenant_id = app.tenant_id() AND id = ${pointId}::uuid AND kind = 'web_chat'`.execute(tx)).rows[0]?.address ?? null;
}

export interface ChatRoute {
  pointId: string;
  address: string;
  hmac: string;
  connectionId: string;
  connectionStatus: string;
  sessionOpen: boolean;
}

/**
 * The chat a reply to this contact goes to: its web-chat identities with their session and widget, the open session
 * first, then the most recent one. Read in the caller's transaction (a person sees sessions of contacts they may see
 * in detail, 0018 webchat_staff_read; the system sees all).
 */
export async function chatRoutes(tx: Tx, contactId: string): Promise<ChatRoute[]> {
  const r = await sql<{ point_id: string; address: string; hmac: Buffer; connection_id: string; status: string; open: boolean }>`
    SELECT p.id AS point_id, p.address, p.address_hmac AS hmac, s.connection_id, c.status,
           (s.closed_at IS NULL AND s.last_seen_at > now() - interval '30 minutes') AS open
      FROM contact_points p
      JOIN webchat_sessions s ON s.tenant_id = p.tenant_id AND s.contact_point_id = p.id
      JOIN integration_connections c ON c.tenant_id = s.tenant_id AND c.id = s.connection_id
     WHERE p.tenant_id = app.tenant_id() AND p.contact_id = ${contactId}::uuid AND p.kind = 'web_chat' AND p.removed_at IS NULL
     ORDER BY open DESC, s.last_seen_at DESC, p.id`.execute(tx);
  return r.rows.map((x) => ({ pointId: x.point_id, address: x.address, hmac: x.hmac.toString('hex'), connectionId: x.connection_id, connectionStatus: x.status, sessionOpen: x.open }));
}

/** The session behind a chat identity (dispatch's CHANNEL_NOT_CONNECTED check, E77, R-INBOX-7). */
export async function routeOfAddress(tx: Tx, contactId: string, address: string): Promise<ChatRoute | null> {
  return (await chatRoutes(tx, contactId)).find((x) => x.address === address) ?? null;
}

/** Contacts whose live point carries this HMAC (E138: a typed address matching someone: a suggestion only). */
export async function contactsWithHmac(tx: Tx, hmac: Buffer): Promise<{ contact_id: string; owner_user_id: string | null }[]> {
  return (
    await sql<{ contact_id: string; owner_user_id: string | null }>`
      SELECT DISTINCT p.contact_id, c.owner_user_id FROM contact_points p JOIN contacts c ON c.tenant_id = p.tenant_id AND c.id = p.contact_id
       WHERE p.tenant_id = app.tenant_id() AND p.address_hmac = ${hmac} AND p.removed_at IS NULL AND c.deleted_at IS NULL
         AND c.merged_into_contact_id IS NULL
       ORDER BY p.contact_id LIMIT 5`.execute(tx)
  ).rows;
}

export async function activeRole(tx: Tx, userId: string): Promise<string | null> {
  return (await sql<{ role: string }>`SELECT role FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${userId}::uuid AND status = 'active'`.execute(tx)).rows[0]?.role ?? null;
}
