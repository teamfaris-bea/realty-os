// api/mail-sync service (module 68; R-GMAIL-1..8, -13, -14; PHASE2_3_PLAN §5.4 #68 routes).
//
// Self only: every /me/* function runs as the calling person under RLS (user_mail_links, mail_sync_points and
// mail_thread_exclusions are self-and-system only), so an Owner, Admin or Team Lead reads no one else's link, token,
// sync state, confirmations or exclusions. The OAuth callback runs as the SYSTEM actor of the tenant named by the
// verified state (never request input). The refresh token is read only in token.ts and never returned.
import type { IdGenerator, TenantId, UserActor } from "@realty/core/foundation";
import { normalizeEmail } from "@realty/core/foundation";
import { type Database, type Tx, withTenantTx } from "@realty/db";
import { sql } from "kysely";
import { audit } from "../audit.js";
import type { EnvelopeService } from "../crypto/envelope.js";
import { AppError } from "../errors.js";
import { systemActor } from "../worker/systemActor.js";
import {
  ACCEPTED_DISCLOSURE_SHA256,
  CURRENT_DISCLOSURE_SHA256,
} from "./disclosure.js";
import {
  MAIL_STATE_TTL_MS,
  binderMatches,
  mailPkceVerifier,
  newBinder,
  newNonce,
  pkceChallenge,
  signMailState,
  stateReplayKey,
  verifyMailState,
} from "./oauthState.js";
import {
  GMAIL_READONLY_SCOPE,
  GMAIL_SCOPES,
  type GmailProvider,
} from "./provider.js";
import { gmailRules } from "./sync.js";
import {
  insertLink,
  openRefreshToken,
  revokeLink,
  sealRefreshToken,
} from "./token.js";

export interface MailSyncServiceDeps {
  db: Database;
  envelope: EnvelopeService;
  ids: IdGenerator;
  gmail: GmailProvider;
  secret: Uint8Array;
  publicBaseUrl: string;
  webOrigin: string;
  now: () => number;
}

const iso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString() : null;

export const redirectUri = (publicBaseUrl: string): string =>
  `${publicBaseUrl.replace(/\/+$/, "")}/api/me/mail-link/callback`;

// ---- availability and the caller's own link -------------------------------------------------------------

export interface Availability {
  cleared: boolean;
  enabled: boolean;
  configured: boolean;
  canConnect: boolean;
  sentence: string;
}

async function availability(
  tx: Tx,
  gmail: GmailProvider,
): Promise<
  Availability & { backfillDays: number; pollIntervalSeconds: number }
> {
  const rules = await gmailRules(tx);
  const s = (
    await sql<{
      e: boolean;
      d: number;
    }>`SELECT mail_sync_enabled AS e, mail_backfill_days AS d FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(
      tx,
    )
  ).rows[0];
  const enabled = s?.e === true;
  const configured = gmail.configured;
  const sentence = !rules.cleared
    ? "Gmail sync is not available yet: it waits for counsel review and Google’s verification."
    : !enabled
      ? "Gmail sync is off for your team. The Owner can turn it on."
      : !configured
        ? "Gmail sync is not set up on this platform yet."
        : "You can connect your own Gmail, read-only.";
  return {
    cleared: rules.cleared,
    enabled,
    configured,
    canConnect: rules.cleared && enabled && configured,
    sentence,
    backfillDays: Number(s?.d ?? 30),
    pollIntervalSeconds: rules.pollIntervalSeconds,
  };
}

export interface LinkView {
  id: string;
  status: "connected" | "degraded" | "revoked";
  mailboxAddress: string;
  connectedAt: string;
  lastSyncedAt: string | null;
  lastErrorCode: string | null;
  revokeReason: string | null;
  backfillRequestedAt: string | null;
  backfillDoneAt: string | null;
  statusSentence: string;
}

export interface OwnLinkRow {
  id: string;
  status: LinkView["status"];
  mailbox_address: string;
  connected_at: Date;
  last_synced_at: Date | null;
  last_error_code: string | null;
  revoke_reason: string | null;
  backfill_requested_at: Date | null;
  backfill_done_at: Date | null;
  /** the owner's membership status: a live link of a suspended (or deactivating) member is paused, not revoked */
  member_status: string | null;
}

const REVOKE_SENTENCE: Record<string, string> = {
  USER_DISCONNECTED: "Disconnected. Your copies were removed from Realty OS.",
  MEMBER_INACTIVE: "Disconnected because your membership ended.",
  SYNC_TURNED_OFF:
    "Disconnected because Gmail sync was turned off for your team.",
  PLATFORM_NOT_CLEARED:
    "Disconnected because Gmail sync is not available right now.",
  PROVIDER_REVOKED: "Google access was removed: connect again.",
};

export function linkView(r: OwnLinkRow): LinkView {
  const sentence =
    r.status === "revoked"
      ? (REVOKE_SENTENCE[r.revoke_reason ?? ""] ?? "Disconnected.")
      : r.member_status === "suspended"
        ? "Paused while your account is suspended."
        : r.member_status !== "active"
          ? "Paused while your account is not active."
          : r.status === "degraded"
            ? `Connected: ${r.mailbox_address}. The last sync did not finish; Realty OS will try again.`
            : r.last_synced_at
              ? `Connected: ${r.mailbox_address}. Last synced ${r.last_synced_at.toISOString()}.`
              : `Connected: ${r.mailbox_address}. The first sync starts within a few minutes.`;
  return {
    id: r.id,
    status: r.status,
    mailboxAddress: r.mailbox_address,
    connectedAt: r.connected_at.toISOString(),
    lastSyncedAt: iso(r.last_synced_at),
    lastErrorCode: r.last_error_code,
    revokeReason: r.revoke_reason,
    backfillRequestedAt: iso(r.backfill_requested_at),
    backfillDoneAt: iso(r.backfill_done_at),
    statusSentence: sentence,
  };
}

/** The caller's own live link, else their most recent revoked one (RLS: their rows only). Never refresh_enc. */
async function ownLink(tx: Tx, live = false): Promise<OwnLinkRow | null> {
  const r = await sql<OwnLinkRow>`
    SELECT id, status, mailbox_address, connected_at, last_synced_at, last_error_code, revoke_reason, backfill_requested_at, backfill_done_at,
           (SELECT m.status FROM memberships m WHERE m.tenant_id = user_mail_links.tenant_id AND m.user_id = user_mail_links.user_id) AS member_status
      FROM user_mail_links WHERE tenant_id = app.tenant_id() AND user_id = app.user_id()
       ${live ? sql`AND status <> 'revoked'` : sql``}
     ORDER BY (status <> 'revoked') DESC, created_at DESC LIMIT 1`.execute(tx);
  return r.rows[0] ?? null;
}

export async function getOwnLink(tx: Tx, gmail: GmailProvider) {
  const a = await availability(tx, gmail);
  const l = await ownLink(tx);
  const { backfillDays, pollIntervalSeconds, ...available } = a;
  return {
    available,
    link: l ? linkView(l) : null,
    backfillDays,
    pollIntervalSeconds,
    disclosureSha256: CURRENT_DISCLOSURE_SHA256,
  };
}

// ---- connect (OAuth start) and the callback ------------------------------------------------------------------

export async function startConnect(
  deps: MailSyncServiceDeps,
  tx: Tx,
  actor: UserActor,
  disclosureSha256: string,
): Promise<{ authorizeUrl: string; expiresAt: string; binder: string }> {
  if (!ACCEPTED_DISCLOSURE_SHA256.includes(disclosureSha256))
    throw new AppError("MAIL_DISCLOSURE_STALE");
  const a = await availability(tx, deps.gmail);
  if (!a.cleared || !a.enabled) throw new AppError("MAIL_SYNC_OFF");
  if (!a.configured) throw new AppError("MAIL_PROVIDER_NOT_CONFIGURED");
  if (await ownLink(tx, true)) throw new AppError("MAIL_ALREADY_CONNECTED");
  const expiresAt = deps.now() + MAIL_STATE_TTL_MS;
  // the browser binder: its hash rides in the signed state, the value in an HttpOnly cookie of THIS browser only
  const b = newBinder();
  const st = {
    tenantId: actor.tenantId,
    userId: actor.userId,
    disclosureSha256,
    binderSha256: b.sha256,
    expiresAt,
    nonce: newNonce(),
  };
  const state = signMailState(deps.secret, st);
  // R-GMAIL-3: exactly gmail.readonly; Gmail's own client, never include_granted_scopes (a calendar grant never rides along)
  const authorizeUrl = deps.gmail.authorizeUrl({
    state,
    codeChallenge: pkceChallenge(mailPkceVerifier(deps.secret, st)),
    redirectUri: redirectUri(deps.publicBaseUrl),
    scopes: GMAIL_SCOPES,
  });
  return {
    authorizeUrl,
    expiresAt: new Date(expiresAt).toISOString(),
    binder: b.binder,
  };
}

export type CallbackOutcome =
  | "CONNECTED"
  | "CANCELLED"
  | "STATE_INVALID"
  | "STATE_EXPIRED"
  | "STATE_REPLAYED"
  | "SCOPE_NOT_ALLOWED"
  | "MAILBOX_LINKED_ELSEWHERE"
  | "ALREADY_CONNECTED"
  | "MAIL_SYNC_OFF"
  | "PROVIDER_REFUSED";

const landing = (deps: MailSyncServiceDeps, outcome: CallbackOutcome) => ({
  outcome,
  location: `${deps.webOrigin.replace(/\/+$/, "")}/settings/mail?result=${outcome}`,
});

function isUnique(e: unknown, constraint: string): boolean {
  const pe = (e ?? {}) as { code?: string; constraint?: string };
  return pe.code === "23505" && pe.constraint === constraint;
}

/** The provider redirect (E225, E210, E211). Stores nothing unless every check passed. */
//
// A refused connect never revokes at Google: Google's revoke ends the whole grant (user + client), so revoking a
// token issued for a mailbox that is live in another link (E210, E211, a two-tab race) would silently disconnect that
// link. The refused token is only dropped (memory); nothing is stored. VERIFY Google's revoke semantics.
export async function oauthCallback(
  deps: MailSyncServiceDeps,
  q: {
    state?: string | undefined;
    code?: string | undefined;
    error?: string | undefined;
  },
  binderCookie?: string | null,
  log?: (code: string) => void,
): Promise<{ outcome: CallbackOutcome; location: string }> {
  const v = verifyMailState(deps.secret, q.state ?? "", deps.now());
  if (!v.ok) return landing(deps, v.code);
  const st = v.state;
  if (!ACCEPTED_DISCLOSURE_SHA256.includes(st.disclosureSha256))
    return landing(deps, "STATE_INVALID");
  // bound to the browser that started the flow (review finding): checked before anything is consumed or exchanged
  if (!binderMatches(st, binderCookie)) return landing(deps, "STATE_INVALID");
  const actor = systemActor(st.tenantId, "provider");
  // single use, consumed FIRST: a replayed state is refused whatever happened the first time
  const fresh = await withTenantTx(
    actor,
    async (tx, now) => {
      const ok = (
        await sql<{
          ok: boolean;
        }>`SELECT app.record_webhook_event(${deps.ids.next()}::uuid, 'gmail_oauth_state', ${stateReplayKey(st)}, app.tenant_id(), true, NULL, ${new Date(now).toISOString()}::timestamptz) AS ok`.execute(
          tx,
        )
      ).rows[0]?.ok;
      return ok === true;
    },
    { db: deps.db, retries: 2 },
  );
  if (!fresh) return landing(deps, "STATE_REPLAYED");
  if (q.error !== undefined || !q.code) return landing(deps, "CANCELLED");
  const pre = await withTenantTx(
    actor,
    (tx) => precheck(tx, deps.gmail, st.userId),
    { db: deps.db, retries: 2 },
  );
  if (pre !== "OK") return landing(deps, pre);

  // outside any transaction: the exchange and the profile read
  let token: {
    refreshToken: string;
    accessToken: string;
    grantedScopes: string[];
  };
  try {
    token = await deps.gmail.exchangeCode({
      code: q.code,
      codeVerifier: mailPkceVerifier(deps.secret, st),
      redirectUri: redirectUri(deps.publicBaseUrl),
    });
  } catch {
    return landing(deps, "PROVIDER_REFUSED");
  }
  // E225 / R-GMAIL-3: exactly gmail.readonly, nothing more and nothing less (an incremental grant is refused)
  const granted = [...new Set(token.grantedScopes)];
  if (granted.length !== 1 || granted[0] !== GMAIL_READONLY_SCOPE) {
    return landing(deps, "SCOPE_NOT_ALLOWED");
  }
  let address: string;
  let historyId: string;
  try {
    const p = await deps.gmail.profile(token.accessToken);
    const n = normalizeEmail(p.emailAddress);
    if (!n.ok || !/^[0-9]{1,20}$/.test(p.historyId)) throw new Error("profile");
    address = n.email;
    historyId = p.historyId;
  } catch {
    return landing(deps, "PROVIDER_REFUSED");
  }

  let outcome: CallbackOutcome;
  try {
    outcome = await withTenantTx(
      actor,
      async (tx) => {
        const again = await precheck(tx, deps.gmail, st.userId);
        if (again !== "OK") return again;
        const linkId = deps.ids.next<"MailLinkId">();
        const tenantId = st.tenantId as TenantId;
        const hmac = Buffer.from(
          await deps.envelope.inTx(tx, tenantId).hmacAddress(tenantId, address),
        );
        const sealed = await sealRefreshToken(
          tx,
          deps.envelope,
          tenantId,
          linkId,
          token.refreshToken,
        );
        await insertLink(tx, {
          id: linkId,
          userId: st.userId,
          mailboxAddress: address,
          mailboxHmac: hmac,
          scopes: GMAIL_SCOPES,
          disclosureSha256: st.disclosureSha256,
          enc: sealed.enc,
          keyVersion: sealed.keyVersion,
          historyId,
        });
        await audit(tx, actor, {
          action: "mail.link_connected",
          entity: { type: "user_mail_link", id: linkId },
          reason: "GMAIL_READONLY_PROFILE_READ",
        });
        return "CONNECTED" as const;
      },
      { db: deps.db, retries: 2 },
    );
  } catch (e) {
    if (isUnique(e, "user_mail_links_live_mailbox"))
      outcome = "MAILBOX_LINKED_ELSEWHERE";
    else if (isUnique(e, "user_mail_links_one_live"))
      outcome = "ALREADY_CONNECTED";
    else if (/MAIL_SYNC_OFF/.test(String((e as Error)?.message)))
      outcome = "MAIL_SYNC_OFF";
    else {
      // never a 500 to the browser and never a half-stored link: the transaction rolled back
      log?.(String((e as { code?: string })?.code ?? "MAIL_CALLBACK_ERROR"));
      outcome = "PROVIDER_REFUSED";
    }
  }
  return landing(deps, outcome);
}

async function precheck(
  tx: Tx,
  gmail: GmailProvider,
  userId: string,
): Promise<"OK" | "MAIL_SYNC_OFF" | "ALREADY_CONNECTED"> {
  const a = await availability(tx, gmail);
  if (!a.canConnect) return "MAIL_SYNC_OFF";
  const member =
    await sql`SELECT 1 FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${userId}::uuid AND status = 'active'`.execute(
      tx,
    );
  if (member.rows.length === 0) return "MAIL_SYNC_OFF";
  const live =
    await sql`SELECT 1 FROM user_mail_links WHERE tenant_id = app.tenant_id() AND user_id = ${userId}::uuid AND status <> 'revoked'`.execute(
      tx,
    );
  return live.rows.length > 0 ? "ALREADY_CONNECTED" : "OK";
}

async function revokeQuietly(
  gmail: GmailProvider,
  refreshToken: string,
): Promise<void> {
  try {
    await gmail.revoke(refreshToken);
  } catch {
    /* best effort */
  }
}

// ---- disconnect, import again ---------------------------------------------------------------------------------

/**
 * DELETE /me/mail-link (R-GMAIL-4, -13): the person disconnects their own link. The system first reads the token
 * into memory (only to revoke it at Google afterwards); the person's own transaction then revokes the link, which
 * deletes the token in the same statement (CHECK) and hides every copy at once; the reconcile deletes them within one
 * sync interval. Google is told after the commit, best effort.
 */
export async function disconnect(
  deps: MailSyncServiceDeps,
  actor: UserActor,
): Promise<LinkView> {
  const own = await withTenantTx(actor, (tx) => ownLink(tx, true), {
    db: deps.db,
  });
  if (!own) throw new AppError("MAIL_NOT_CONNECTED");
  const token = await withTenantTx(
    systemActor(actor.tenantId, "provider"),
    (tx) =>
      openRefreshToken(
        tx,
        deps.envelope,
        systemActor(actor.tenantId, "provider"),
        own.id,
      ).catch(() => null),
    { db: deps.db },
  );
  const view = await withTenantTx(
    actor,
    async (tx) => {
      const r = await revokeLink(tx, null, actor, own.id, "USER_DISCONNECTED");
      if (r.revoked)
        await audit(tx, actor, {
          action: "mail.link_disconnected",
          entity: { type: "user_mail_link", id: own.id },
        });
      const after = await sql<OwnLinkRow>`
        SELECT id, status, mailbox_address, connected_at, last_synced_at, last_error_code, revoke_reason, backfill_requested_at, backfill_done_at
          FROM user_mail_links WHERE tenant_id = app.tenant_id() AND id = ${own.id}::uuid`.execute(
        tx,
      );
      return linkView(after.rows[0]!);
    },
    { db: deps.db },
  );
  if (token) await revokeQuietly(deps.gmail, token);
  return view;
}

export async function importAgain(tx: Tx, actor: UserActor): Promise<LinkView> {
  const own = await ownLink(tx, true);
  if (!own) throw new AppError("MAIL_NOT_CONNECTED");
  await sql`UPDATE user_mail_links SET backfill_requested_at = now() WHERE tenant_id = app.tenant_id() AND id = ${own.id}::uuid AND status <> 'revoked'`.execute(
    tx,
  );
  await audit(tx, actor, {
    action: "mail.import_again",
    entity: { type: "user_mail_link", id: own.id },
  });
  return linkView((await ownLink(tx, true))!);
}

// ---- confirmed addresses (S-D2-1) -----------------------------------------------------------------------------

interface PointRow {
  point_id: string;
  contact_id: string;
  contact_name: string;
  address: string;
  address_hmac: Buffer;
  confirmed_at: Date | null;
}

/** The caller's confirmed addresses plus suggestions: current email points of related contacts not yet confirmed. */
export async function listSyncPoints(
  deps: MailSyncServiceDeps,
  actor: UserActor,
) {
  const rows = await withTenantTx(
    actor,
    async (tx) => {
      const own = await ownLink(tx, true);
      if (!own) throw new AppError("MAIL_NOT_CONNECTED");
      return (
        await sql<PointRow>`
          SELECT p.id AS point_id, p.contact_id, c.display_name AS contact_name, p.address, p.address_hmac, sp.confirmed_at
            FROM contact_points p JOIN contacts c ON c.tenant_id = p.tenant_id AND c.id = p.contact_id
            LEFT JOIN mail_sync_points sp ON sp.tenant_id = p.tenant_id AND sp.link_id = ${own.id}::uuid AND sp.contact_point_id = p.id
           WHERE p.tenant_id = app.tenant_id() AND p.kind = 'email' AND p.removed_at IS NULL
             AND app.mail_contact_related(p.tenant_id, app.user_id(), p.contact_id)
           ORDER BY c.display_name, p.address LIMIT 2000`.execute(tx)
      ).rows;
    },
    { db: deps.db },
  );
  // never suggest a live mailbox of the team (E203): the system knows the mailboxes; only absence leaks back
  const mailboxes = await withTenantTx(
    systemActor(actor.tenantId, "provider"),
    async (tx) =>
      new Set(
        (
          await sql<{
            h: Buffer;
          }>`SELECT mailbox_address_hmac AS h FROM user_mail_links WHERE tenant_id = app.tenant_id() AND status <> 'revoked' AND mailbox_address_hmac = ANY (${rows.map((r) => r.address_hmac)}::bytea[])`.execute(
            tx,
          )
        ).rows.map((x) => x.h.toString("hex")),
      ),
    { db: deps.db },
  );
  const usable = rows.filter(
    (r) => !mailboxes.has(r.address_hmac.toString("hex")),
  );
  const v = (r: PointRow) => ({
    pointId: r.point_id,
    contactId: r.contact_id,
    contactName: r.contact_name,
    address: r.address,
  });
  return {
    confirmed: usable
      .filter((r) => r.confirmed_at !== null)
      .map((r) => ({ ...v(r), confirmedAt: r.confirmed_at!.toISOString() })),
    suggestions: usable.filter((r) => r.confirmed_at === null).map(v),
  };
}

export async function confirmSyncPoints(
  tx: Tx,
  actor: UserActor,
  pointIds: readonly string[],
): Promise<{ confirmed: number }> {
  const own = await ownLink(tx, true);
  if (!own) throw new AppError("MAIL_NOT_CONNECTED");
  const pts = (
    await sql<{
      id: string;
      contact_id: string;
    }>`SELECT id, contact_id FROM contact_points WHERE tenant_id = app.tenant_id() AND id = ANY (${[...new Set(pointIds)]}::uuid[]) AND kind = 'email'`.execute(
      tx,
    )
  ).rows;
  if (pts.length !== new Set(pointIds).size)
    throw new AppError("MAIL_POINT_NOT_ALLOWED");
  let n = 0;
  for (const p of pts) {
    try {
      const r = await sql`
        INSERT INTO mail_sync_points (tenant_id, link_id, contact_point_id, contact_id) VALUES (app.tenant_id(), ${own.id}::uuid, ${p.id}::uuid, ${p.contact_id}::uuid)
        ON CONFLICT DO NOTHING`.execute(tx);
      n += Number(r.numAffectedRows ?? 0n);
    } catch (e) {
      if (
        /^MAIL_(POINT_OWNER_ONLY|CONTACT_NOT_RELATED|ADDRESS_NOT_A_CONTACT_POINT|ADDRESS_IS_A_MAILBOX)/.test(
          String((e as Error)?.message),
        )
      )
        throw new AppError("MAIL_POINT_NOT_ALLOWED");
      throw e;
    }
  }
  // a newly confirmed address gets the window's earlier mail too: confirming asks for the backfill again (the person
  // path the link guard allows, like "import again"; replays of what is already stored are no-ops)
  if (n > 0)
    await sql`UPDATE user_mail_links SET backfill_requested_at = now() WHERE tenant_id = app.tenant_id() AND id = ${own.id}::uuid AND status <> 'revoked'`.execute(
      tx,
    );
  if (n > 0)
    await audit(tx, actor, {
      action: "mail.sync_points_confirmed",
      entity: { type: "user_mail_link", id: own.id },
      reason: `COUNT_${n}`,
    });
  return { confirmed: n };
}

export async function removeSyncPoint(
  tx: Tx,
  actor: UserActor,
  pointId: string,
): Promise<{ removed: boolean }> {
  const own = await ownLink(tx, true);
  if (!own) throw new AppError("MAIL_NOT_CONNECTED");
  const r =
    await sql`DELETE FROM mail_sync_points WHERE tenant_id = app.tenant_id() AND link_id = ${own.id}::uuid AND contact_point_id = ${pointId}::uuid`.execute(
      tx,
    );
  const removed = Number(r.numAffectedRows ?? 0n) > 0;
  if (removed)
    await audit(tx, actor, {
      action: "mail.sync_point_removed",
      entity: { type: "user_mail_link", id: own.id },
    });
  return { removed };
}

// ---- "Remove this thread from Realty OS" (R-GMAIL-7) -------------------------------------------------------------

export async function excludeThread(
  tx: Tx,
  actor: UserActor,
  threadId: string,
): Promise<{ excluded: true }> {
  const own = await ownLink(tx, true);
  if (!own) throw new AppError("MAIL_NOT_CONNECTED");
  // only a thread this link holds a (visible) copy of: another person's thread id is "not found" (no oracle)
  const has =
    await sql`SELECT 1 FROM mail_messages WHERE tenant_id = app.tenant_id() AND link_id = ${own.id}::uuid AND gmail_thread_id = ${threadId} LIMIT 1`.execute(
      tx,
    );
  const already =
    await sql`SELECT 1 FROM mail_thread_exclusions WHERE tenant_id = app.tenant_id() AND link_id = ${own.id}::uuid AND gmail_thread_id = ${threadId}`.execute(
      tx,
    );
  if (has.rows.length === 0 && already.rows.length === 0)
    throw new AppError("NOT_FOUND");
  await sql`INSERT INTO mail_thread_exclusions (tenant_id, link_id, gmail_thread_id) VALUES (app.tenant_id(), ${own.id}::uuid, ${threadId}) ON CONFLICT DO NOTHING`.execute(
    tx,
  );
  await audit(tx, actor, {
    action: "mail.thread_excluded",
    entity: { type: "user_mail_link", id: own.id },
  });
  return { excluded: true };
}

// ---- the contact's synced copies (RLS decides who reads them) -------------------------------------------------

interface CopyRow {
  id: string;
  link_id: string;
  gmail_thread_id: string;
  internal_at: Date;
  sender: string;
  contact_role: string;
  other_recipient_count: number;
  subject: string | null;
  body: string;
  body_truncated: boolean;
  attachments: { name: string; mime_type: string; size_bytes: number }[];
  origin: string;
  mine: boolean;
  owner_name: string | null;
  thread_count: number;
}

export async function contactMailMessages(
  tx: Tx,
  contactId: string,
  q: { before?: string | undefined; limit: number },
) {
  const rules = await gmailRules(tx);
  const rows = (
    await sql<CopyRow>`
      SELECT mm.id, mm.link_id, mm.gmail_thread_id, mm.internal_at, mm.sender, mm.contact_role, mm.other_recipient_count, mm.subject, mm.body,
             mm.body_truncated, mm.attachments, mm.origin,
             EXISTS (SELECT 1 FROM user_mail_links l WHERE l.tenant_id = mm.tenant_id AND l.id = mm.link_id AND l.user_id = app.user_id()) AS mine,
             (SELECT u.display_name FROM user_mail_links l JOIN users u ON u.id = l.user_id WHERE l.tenant_id = mm.tenant_id AND l.id = mm.link_id) AS owner_name,
             (SELECT count(*)::int FROM mail_messages t WHERE t.tenant_id = mm.tenant_id AND t.link_id = mm.link_id AND t.gmail_thread_id = mm.gmail_thread_id) AS thread_count
        FROM mail_messages mm
       WHERE mm.tenant_id = app.tenant_id() AND mm.contact_id = ${contactId}::uuid
         ${q.before ? sql`AND mm.internal_at < ${q.before}::timestamptz` : sql``}
       ORDER BY mm.internal_at DESC, mm.id DESC LIMIT ${q.limit + 1}`.execute(
      tx,
    )
  ).rows;
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const coverage = (
    await sql<{ address: string; since: Date }>`
      SELECT p.address, min(mm.internal_at) AS since FROM mail_messages mm
        JOIN contact_points p ON p.tenant_id = mm.tenant_id AND p.id = mm.contact_point_id
       WHERE mm.tenant_id = app.tenant_id() AND mm.contact_id = ${contactId}::uuid GROUP BY p.address ORDER BY p.address`.execute(
      tx,
    )
  ).rows;
  return {
    items: page.map((r) => ({
      id: r.id,
      threadId: r.gmail_thread_id,
      internalAt: r.internal_at.toISOString(),
      sender: r.sender as "contact" | "mailbox" | "other",
      contactRole: r.contact_role as "from" | "to" | "cc" | "bcc",
      otherRecipientCount: r.other_recipient_count,
      subject: r.subject,
      body: r.body,
      bodyTruncated: r.body_truncated,
      attachments: (r.attachments ?? []).map((a) => ({
        name: a.name,
        mimeType: a.mime_type,
        sizeBytes: a.size_bytes,
      })),
      origin: r.origin as "live" | "backfill",
      mine: r.mine,
      mailboxOwnerName: r.owner_name ?? "A teammate",
      threadCapped: r.thread_count >= rules.maxMessagesPerThread,
    })),
    coverage: coverage.map((c) => ({
      address: c.address,
      since: c.since.toISOString(),
    })),
    nextBefore: more ? page[page.length - 1]!.internal_at.toISOString() : null,
  };
}

// ---- Admin → Mail (the Owner switch and the window) ---------------------------------------------------------------

export async function adminSettings(tx: Tx, actor: UserActor) {
  const s = (
    await sql<{
      e: boolean;
      d: number;
    }>`SELECT mail_sync_enabled AS e, mail_backfill_days AS d FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(
      tx,
    )
  ).rows[0];
  const pack = (
    await sql<{ reviewed: boolean; vendor: boolean; cleared: boolean }>`
      SELECT COALESCE((SELECT j.reviewed_by_counsel_at IS NOT NULL FROM jurisdiction_packs j WHERE j.key = 'platform:gmail' AND j.status = 'published' ORDER BY j.version DESC LIMIT 1), false) AS reviewed,
             COALESCE((SELECT (j.rules ? 'vendor_ready_at') FROM jurisdiction_packs j WHERE j.key = 'platform:gmail' AND j.status = 'published' ORDER BY j.version DESC LIMIT 1), false) AS vendor,
             app.platform_cleared('platform:gmail', true) AS cleared`.execute(
      tx,
    )
  ).rows[0]!;
  const sentence = pack.cleared
    ? "Cleared: counsel reviewed it and Google verified the read-only access."
    : [
        !pack.reviewed ? "not reviewed by counsel" : null,
        !pack.vendor ? "waiting for Google verification" : null,
      ]
        .filter(Boolean)
        .join("; ")
        .replace(/^./, (c) => c.toUpperCase()) +
      ". Gmail sync stays off until both are done.";
  const role = actor.role === "owner" ? "owner" : "admin";
  return {
    enabled: s?.e === true,
    backfillDays: Number(s?.d ?? 30),
    pack: {
      cleared: pack.cleared,
      reviewedByCounsel: pack.reviewed,
      vendorReady: pack.vendor,
      sentence,
    },
    canTurnOn: pack.cleared && role === "owner",
    role: role as "owner" | "admin",
  };
}

export async function updateAdminSettings(
  tx: Tx,
  actor: UserActor,
  b: { enabled: boolean; backfillDays: number },
) {
  const before = await adminSettings(tx, actor);
  if (b.enabled && !before.enabled && actor.role !== "owner")
    throw new AppError("OWNER_REQUIRED");
  if (b.backfillDays !== before.backfillDays && actor.role !== "owner")
    throw new AppError("OWNER_REQUIRED");
  if (b.enabled && !before.enabled && !before.pack.cleared)
    throw new AppError("MAIL_SYNC_NOT_CLEARED");
  try {
    await sql`UPDATE tenant_settings SET mail_sync_enabled = ${b.enabled}, mail_backfill_days = ${b.backfillDays} WHERE tenant_id = app.tenant_id()`.execute(
      tx,
    );
  } catch (e) {
    const m = String((e as Error)?.message ?? "");
    if (m.startsWith("MAIL_SYNC_NOT_CLEARED"))
      throw new AppError("MAIL_SYNC_NOT_CLEARED");
    if (m.startsWith("OWNER_ONLY_MAIL_SYNC"))
      throw new AppError("OWNER_REQUIRED");
    throw e;
  }
  if (b.enabled !== before.enabled || b.backfillDays !== before.backfillDays) {
    await audit(tx, actor, {
      action: "mail.settings_changed",
      entity: { type: "tenant", id: actor.tenantId },
      reason: `${b.enabled ? "ON" : "OFF"}_${b.backfillDays}D`,
    });
  }
  return adminSettings(tx, actor);
}
