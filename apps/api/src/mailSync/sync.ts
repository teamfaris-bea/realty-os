// mail.sync: module 68's per-tenant reconcile handler (R-OWN-27, R-GMAIL-1, -5, -7..-13; PHASE2_3_PLAN §5.4 #68 steps 1-6;
// ARCHITECTURE §21.10). Standalone: provider calls happen OUTSIDE any transaction; each page commits in its own
// system transaction, and the history cursor advances only after the page's rows commit.
//
//   1 revoke live links whose member is inactive, whose tenant switched sync off, or while platform:gmail is uncleared;
//     refresh() invalid_grant ⇒ PROVIDER_REVOKED (E217). The refresh token is revoked at Google best effort.
//   2 delete copies of revoked links, excluded threads, removed points, withdrawn confirmations (S-D2-2), addresses that
//     became a live mailbox, and messages a platform row now duplicates (R-GMAIL-12); re-point a merged contact's
//     copies to the survivor's confirmed point with the same address HMAC, deleting a copy that would collide or whose
//     survivor point is unconfirmed (R-GMAIL-13, E223); purge revoked links past purge_after.
//   3 history.list from history_id (expired ⇒ bounded resync inside the backfill window, E218); removed / TRASH / SPAM
//     ⇒ delete copies (E219)
//   4 per new message: skip SPAM/TRASH/DRAFT/CHAT; a message FROM a current email point of the tenant is classified ONCE
//     with classifyInbound BEFORE and regardless of storage (R-GMAIL-9, S-D2-3, E229); outside excluded threads, one
//     row per match over the CONFIRMED points (the DB re-checks everything); a fresh live client message (≤ 1 h at
//     fetch) calls ingestSyncedMailInTx (R-GMAIL-10)
//   5 backfill pages (≤ backfill_max_messages) when requested; never pause or hand back (R-GMAIL-8)
//   6 next_sync_at = now + poll_interval_seconds
//
// Never: send, label or delete in Gmail (the adapter has no such method); a messages row; a model call; a full-mailbox
// read (only history since the cursor, and listMessages bounded by the window and the cap).
import { type InboundAddress, type InboundClassification, classifyInbound, planInboundEffects } from '@realty/core/compliance';
import type { IdGenerator, Instant, SystemActor, TenantId } from '@realty/core/foundation';
import { toIso } from '@realty/core/foundation';
import { type Tx, recordConsentEvent } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { ingestSyncedMailInTx } from '../comms/inbound.js';
import { hint } from '../comms/dispatch.js';
import { resolvedPolicy } from '../comms/gateInput.js';
import { handlerOf, notifyUser } from '../comms/repos/notify.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import type { StandaloneJobContext } from '../worker/types.js';
import { type ParticipantMatch, type RelatedEmailPoint, gmailMessageRef, header, isSkipped, matchMailParticipants, parseAddressList, rfcMessageIdSha256, stripQuoted } from './match.js';
import type { GmailMessage, GmailProvider, GmailRef } from './provider.js';
import { openRefreshToken, revokeLink } from './token.js';

export const MAIL_SYNC_KIND = 'mail.sync' as const;
export const MAIL_SYNC_EVERY_MS = 60_000;
/** R-GMAIL-10: only a live message at most this old at fetch pauses automation and hands back */
export const FRESH_MS = 60 * 60_000;
/** history pages per link per pass; a backlog drains over several passes (the cursor holds) */
export const MAX_HISTORY_PAGES = 20;
export const MAX_BACKFILL_PAGES_PER_PASS = 10;
export const BACKFILL_PAGE = 100;
const DAY_MS = 86_400_000;

export interface MailSyncDeps {
  envelope: EnvelopeService;
  ids: IdGenerator;
  /** the fetch clock (R-GMAIL-10's 1-hour rule); tests inject a later one */
  now?: () => number;
}

export interface GmailPackRules {
  cleared: boolean;
  pollIntervalSeconds: number;
  backfillMaxMessages: number;
  maxMessagesPerThread: number;
}

export async function gmailRules(tx: Tx): Promise<GmailPackRules> {
  const r = (
    await sql<{ rules: Record<string, unknown> | null; cleared: boolean }>`
      SELECT (SELECT j.rules FROM jurisdiction_packs j WHERE j.key = 'platform:gmail' AND j.status = 'published' ORDER BY j.version DESC LIMIT 1) AS rules,
             app.platform_cleared('platform:gmail', true) AS cleared`.execute(tx)
  ).rows[0];
  const num = (k: string, d: number) => {
    const v = Number((r?.rules ?? {})[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return { cleared: r?.cleared === true, pollIntervalSeconds: num('poll_interval_seconds', 120), backfillMaxMessages: num('backfill_max_messages', 5000), maxMessagesPerThread: num('max_messages_per_thread', 200) };
}

interface LinkRow {
  id: string;
  user_id: string;
  status: string;
  mailbox_address_hmac: Buffer;
  history_id: string | null;
  connected_at: Date;
  next_sync_at: Date | null;
  backfill_requested_at: Date | null;
  backfill_page_token: string | null;
  backfill_done_at: Date | null;
  last_synced_at: Date | null;
  member_active: boolean;
}

export interface MailSyncSummary {
  revoked: number;
  purged: number;
  repointed: number;
  synced: number;
  stored: number;
  optOuts: number;
  handbacks: number;
  errors: number;
}

let savepointSeq = 0;
async function attempt<T>(tx: Tx, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const sp = `mail_sp_${++savepointSeq}`;
  await sql.raw(`SAVEPOINT ${sp}`).execute(tx);
  try {
    const value = await fn();
    await sql.raw(`RELEASE SAVEPOINT ${sp}`).execute(tx);
    return { ok: true, value };
  } catch (error) {
    await sql.raw(`ROLLBACK TO SAVEPOINT ${sp}`).execute(tx);
    return { ok: false, error };
  }
}

const errCode = (e: unknown): string => {
  const m = /^([A-Z][A-Z0-9_]+):/.exec(String((e as { message?: string })?.message ?? ''));
  return m ? m[1]! : 'MAIL_SYNC_ERROR';
};

/** One reconcile pass for the job's tenant. */
export async function syncTenant(ctx: StandaloneJobContext, deps: MailSyncDeps): Promise<MailSyncSummary> {
  const out: MailSyncSummary = { revoked: 0, purged: 0, repointed: 0, synced: 0, stored: 0, optOuts: 0, handbacks: 0, errors: 0 };
  const gmail = ctx.providers.gmail;
  const toRevokeAtGoogle: string[] = [];

  // 1 revoke what may no longer be live (R-GMAIL-1, -13)
  const state = await ctx.withTx(async (tx) => {
    const rules = await gmailRules(tx);
    const enabled = (await sql<{ e: boolean }>`SELECT mail_sync_enabled AS e FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]?.e === true;
    const links = await liveLinks(tx);
    for (const l of links) {
      const reason = !rules.cleared ? 'PLATFORM_NOT_CLEARED' : !enabled ? 'SYNC_TURNED_OFF' : !l.member_active ? 'MEMBER_INACTIVE' : null;
      if (!reason) continue;
      const r = await revokeLink(tx, deps.envelope, ctx.actor, l.id, reason);
      if (r.revoked) {
        out.revoked++;
        if (r.refreshToken) toRevokeAtGoogle.push(r.refreshToken);
        await audit(tx, ctx.actor, { action: 'mail.link_revoked', entity: { type: 'user_mail_link', id: l.id }, reason });
      }
    }
    return { rules, enabled };
  });
  for (const t of toRevokeAtGoogle.splice(0)) await revokeQuietly(gmail, t);

  // 2 deletes and merge re-points (one transaction; idempotent)
  await ctx.withTx(async (tx, now) => {
    const p = await purgeCopies(tx, now);
    out.purged += p.deleted;
    out.repointed += p.repointed;
  });

  if (!state.rules.cleared || !state.enabled || !gmail.configured) return out;

  // 3-6 every due live link
  const due = await ctx.withTx(async (tx, now) => (await liveLinks(tx)).filter((l) => l.member_active && (l.next_sync_at === null || l.next_sync_at.getTime() <= now)));
  for (const link of due) {
    try {
      const r = await syncLink(ctx, deps, gmail, link, state.rules);
      out.synced++;
      out.stored += r.stored;
      out.optOuts += r.optOuts;
      out.handbacks += r.handbacks;
      if (r.revoked) out.revoked++;
    } catch (e) {
      // revoked while the pass ran: stop quietly (the access token is dropped with this frame)
      if (e instanceof LinkNotLive) continue;
      out.errors++;
      const code = errCode(e);
      await ctx.withTx(async (tx) => {
        await sql`UPDATE user_mail_links SET last_error_code = ${code.slice(0, 60)}, status = CASE WHEN status = 'connected' THEN 'degraded' ELSE status END,
                         next_sync_at = now() + make_interval(secs => ${state.rules.pollIntervalSeconds})
                   WHERE tenant_id = app.tenant_id() AND id = ${link.id}::uuid AND status <> 'revoked'`.execute(tx);
      });
      ctx.log.warn('mail.sync link failed', { code });
    }
  }
  return out;
}

async function liveLinks(tx: Tx): Promise<LinkRow[]> {
  return (
    await sql<LinkRow>`
      SELECT l.id, l.user_id, l.status, l.mailbox_address_hmac, l.history_id, l.connected_at, l.next_sync_at, l.backfill_requested_at,
             l.backfill_page_token, l.backfill_done_at, l.last_synced_at,
             EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = l.tenant_id AND m.user_id = l.user_id AND m.status = 'active') AS member_active
        FROM user_mail_links l WHERE l.tenant_id = app.tenant_id() AND l.status <> 'revoked' ORDER BY l.id`.execute(tx)
  ).rows;
}

async function revokeQuietly(gmail: GmailProvider, refreshToken: string): Promise<void> {
  for (let i = 0; i < 2; i++) {
    try {
      if ((await gmail.revoke(refreshToken)).revoked) return;
    } catch {
      /* best effort (R-GMAIL-4): the token is already deleted here */
    }
  }
}

/**
 * Step 2. Deletes every copy that may no longer be kept and re-points merged contacts' copies. Run as the system, which
 * sees hidden rows (mail_messages_live short-circuits for it).
 */
export async function purgeCopies(tx: Tx, now: Instant): Promise<{ deleted: number; repointed: number }> {
  let deleted = 0;
  const n = (r: { numAffectedRows?: bigint }) => Number(r.numAffectedRows ?? 0n);
  // merge re-point first (R-GMAIL-13, E223): to the survivor's current, confirmed email point with the same HMAC,
  // unless the survivor already holds its own copy of the same Gmail message on this link
  // at most ONE copy per (link, Gmail message, survivor) moves (two merged duplicates may both hold the same message;
  // moving both would collide on the unique key and stall every pass); the rest are deleted just below
  const rep = await sql`
    WITH cand AS (
      SELECT DISTINCT ON (mm.link_id, mm.gmail_message_id, c.merged_into_contact_id)
             mm.id, c.merged_into_contact_id AS survivor, p.id AS point_id
        FROM mail_messages mm
        JOIN contacts c ON c.tenant_id = mm.tenant_id AND c.id = mm.contact_id AND c.merged_into_contact_id IS NOT NULL
        JOIN contact_points p ON p.tenant_id = mm.tenant_id AND p.contact_id = c.merged_into_contact_id AND p.kind = 'email'
                             AND p.removed_at IS NULL AND p.address_hmac = mm.contact_address_hmac
        JOIN mail_sync_points sp ON sp.tenant_id = mm.tenant_id AND sp.link_id = mm.link_id AND sp.contact_point_id = p.id
       WHERE mm.tenant_id = app.tenant_id()
         AND NOT EXISTS (SELECT 1 FROM mail_messages o WHERE o.tenant_id = mm.tenant_id AND o.link_id = mm.link_id
                           AND o.gmail_message_id = mm.gmail_message_id AND o.contact_id = c.merged_into_contact_id)
       ORDER BY mm.link_id, mm.gmail_message_id, c.merged_into_contact_id, mm.id, p.id)
    UPDATE mail_messages mm SET contact_id = cand.survivor, contact_point_id = cand.point_id
      FROM cand WHERE mm.tenant_id = app.tenant_id() AND mm.id = cand.id`.execute(tx);
  const repointed = n(rep);
  deleted += n(
    await sql`
      DELETE FROM mail_messages mm USING contacts c
       WHERE mm.tenant_id = app.tenant_id() AND c.tenant_id = mm.tenant_id AND c.id = mm.contact_id
         AND (c.merged_into_contact_id IS NOT NULL OR c.deleted_at IS NOT NULL)`.execute(tx),
  );
  // revoked links (R-GMAIL-13, E215, E222), excluded threads (R-GMAIL-7, E212)
  deleted += n(
    await sql`
      DELETE FROM mail_messages mm USING user_mail_links l
       WHERE mm.tenant_id = app.tenant_id() AND l.tenant_id = mm.tenant_id AND l.id = mm.link_id AND l.status = 'revoked'`.execute(tx),
  );
  deleted += n(
    await sql`
      DELETE FROM mail_messages mm USING mail_thread_exclusions x
       WHERE mm.tenant_id = app.tenant_id() AND x.tenant_id = mm.tenant_id AND x.link_id = mm.link_id AND x.gmail_thread_id = mm.gmail_thread_id`.execute(tx),
  );
  // removed points: their confirmations go too (the system after the point was removed); withdrawn confirmations (S-D2-2)
  await sql`
    DELETE FROM mail_sync_points sp USING contact_points p
     WHERE sp.tenant_id = app.tenant_id() AND p.tenant_id = sp.tenant_id AND p.id = sp.contact_point_id AND p.removed_at IS NOT NULL`.execute(tx);
  deleted += n(
    await sql`
      DELETE FROM mail_messages mm
       WHERE mm.tenant_id = app.tenant_id()
         AND (NOT EXISTS (SELECT 1 FROM contact_points p WHERE p.tenant_id = mm.tenant_id AND p.id = mm.contact_point_id AND p.removed_at IS NULL)
              OR NOT EXISTS (SELECT 1 FROM mail_sync_points sp WHERE sp.tenant_id = mm.tenant_id AND sp.link_id = mm.link_id AND sp.contact_point_id = mm.contact_point_id)
              OR EXISTS (SELECT 1 FROM user_mail_links ml WHERE ml.tenant_id = mm.tenant_id AND ml.status <> 'revoked' AND ml.mailbox_address_hmac = mm.contact_address_hmac))`.execute(tx),
  );
  // R-GMAIL-12: the platform row wins (E201, either arrival order): the contact, contacts merged into it, its merge target
  deleted += n(
    await sql`
      DELETE FROM mail_messages mm
       WHERE mm.tenant_id = app.tenant_id() AND mm.rfc_message_id_sha256 IS NOT NULL
         AND EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = mm.tenant_id AND m.rfc_message_id_sha256 = mm.rfc_message_id_sha256
                       AND (m.contact_id = mm.contact_id
                            OR m.contact_id IN (SELECT c.id FROM contacts c WHERE c.tenant_id = mm.tenant_id AND c.merged_into_contact_id = mm.contact_id)
                            OR m.contact_id = (SELECT c.merged_into_contact_id FROM contacts c WHERE c.tenant_id = mm.tenant_id AND c.id = mm.contact_id)))`.execute(tx),
  );
  // the link and its exclusions are purged at purge_after (≤ 30 days, R-GMAIL-13)
  await sql`DELETE FROM user_mail_links WHERE tenant_id = app.tenant_id() AND status = 'revoked' AND purge_after <= ${toIso(now)}::timestamptz`.execute(tx);
  return { deleted, repointed };
}

interface LinkPassResult {
  stored: number;
  optOuts: number;
  handbacks: number;
  revoked: boolean;
}

async function syncLink(ctx: StandaloneJobContext, deps: MailSyncDeps, gmail: GmailProvider, link: LinkRow, rules: GmailPackRules): Promise<LinkPassResult> {
  const res: LinkPassResult = { stored: 0, optOuts: 0, handbacks: 0, revoked: false };
  const refreshToken = await ctx.withTx((tx) => openRefreshToken(tx, deps.envelope, ctx.actor, link.id));
  if (!refreshToken) return res;
  const r = await gmail.refresh(refreshToken);
  if ('invalidGrant' in r) {
    // E217: the person removed access in their Google account
    await ctx.withTx(async (tx) => {
      const v = await revokeLink(tx, null, ctx.actor, link.id, 'PROVIDER_REVOKED');
      if (v.revoked) await audit(tx, ctx.actor, { action: 'mail.link_revoked', entity: { type: 'user_mail_link', id: link.id }, reason: 'PROVIDER_REVOKED' });
    });
    res.revoked = true;
    return res;
  }
  const access = r.accessToken; // memory only (R-GMAIL-4): never stored, never logged

  const tally = (p: PageResult) => {
    res.stored += p.stored;
    res.optOuts += p.optOuts;
    res.handbacks += p.handbacks;
  };

  // 3 history since the cursor
  let cursor = link.history_id;
  if (cursor === null) {
    cursor = (await gmail.profile(access)).historyId;
    await ctx.withTx((tx) => sql`UPDATE user_mail_links SET history_id = ${cursor} WHERE tenant_id = app.tenant_id() AND id = ${link.id}::uuid AND status <> 'revoked'`.execute(tx));
  }
  let pageToken: string | undefined;
  let finalHistoryId: string | null = null;
  for (let i = 0; i < MAX_HISTORY_PAGES; i++) {
    const page = await gmail.listHistory(access, cursor, pageToken);
    if ('expired' in page) {
      // E218: a bounded resync inside the backfill window, never a full-mailbox read; the new cursor is read FIRST so
      // nothing that arrives during the scan is missed
      const fresh = (await gmail.profile(access)).historyId;
      const days = await backfillDays(ctx);
      const after = ctx.now - Math.max(days, 1) * DAY_MS;
      let tok: string | undefined;
      let seen = 0;
      do {
        const lm = await gmail.listMessages(access, { after, max: BACKFILL_PAGE, ...(tok ? { pageToken: tok } : {}) });
        const msgs = await fetchAll(gmail, access, lm.refs, deps);
        tally(await ctx.withTx((tx) => processPage(tx, ctx.actor, deps, link, rules, msgs, [], 'resync')));
        seen += lm.refs.length;
        tok = lm.nextPageToken;
      } while (tok && seen < rules.backfillMaxMessages);
      finalHistoryId = fresh;
      break;
    }
    const removed = [...page.removed, ...page.labelChanges.filter((c) => isSkipped(c.labelIds))];
    const msgs = await fetchAll(gmail, access, dedupeRefs(page.added), deps);
    tally(
      await ctx.withTx(async (tx) => {
        const p = await processPage(tx, ctx.actor, deps, link, rules, msgs, removed, 'live');
        // the cursor moves with the page, in the same transaction (a crash replays at most the next page; a backlog
        // longer than MAX_HISTORY_PAGES makes progress every pass instead of replaying the same pages)
        if (page.pageHistoryId !== null && page.nextPageToken) await setCursor(tx, link.id, page.pageHistoryId);
        return p;
      }),
    );
    if (!page.nextPageToken) {
      finalHistoryId = page.historyId;
      break;
    }
    pageToken = page.nextPageToken;
  }
  // 6 the cursor advances only after the page's rows committed (a crash replays: unique keys make it a no-op)
  if (finalHistoryId !== null) {
    const fin = finalHistoryId;
    await ctx.withTx((tx) => setCursor(tx, link.id, fin));
  }

  // 5 backfill (at connect and on "import again"): the window and the cap only
  const wanted = link.backfill_requested_at !== null && (link.backfill_done_at === null || link.backfill_done_at.getTime() < link.backfill_requested_at.getTime());
  if (wanted) {
    const days = await backfillDays(ctx);
    const requested = link.backfill_requested_at!;
    // a request made since the last pass ("import again") re-runs the window from the start, not from an old page token
    const fresh = link.last_synced_at === null || requested.getTime() > link.last_synced_at.getTime();
    let tok = fresh ? undefined : (link.backfill_page_token ?? undefined);
    let done = days === 0;
    for (let i = 0; !done && i < MAX_BACKFILL_PAGES_PER_PASS; i++) {
      const already = await ctx.withTx(async (tx) => Number((await sql<{ n: string }>`
          SELECT count(DISTINCT gmail_message_id)::text AS n FROM mail_messages WHERE tenant_id = app.tenant_id() AND link_id = ${link.id}::uuid
             AND origin = 'backfill' AND created_at >= ${requested.toISOString()}::timestamptz`.execute(tx)).rows[0]!.n));
      const remaining = rules.backfillMaxMessages - already;
      if (remaining <= 0) {
        done = true;
        break;
      }
      const after = requested.getTime() - days * DAY_MS;
      const lm = await gmail.listMessages(access, { after, max: Math.min(BACKFILL_PAGE, remaining), ...(tok ? { pageToken: tok } : {}) });
      const msgs = (await fetchAll(gmail, access, lm.refs, deps)).filter((m) => m.internalDate >= after);
      const next = lm.nextPageToken ?? null;
      tally(
        await ctx.withTx(async (tx) => {
          const p = await processPage(tx, ctx.actor, deps, link, rules, msgs, [], 'backfill');
          await sql`UPDATE user_mail_links SET backfill_page_token = ${next}, backfill_done_at = CASE WHEN ${next}::text IS NULL THEN now() ELSE backfill_done_at END
                     WHERE tenant_id = app.tenant_id() AND id = ${link.id}::uuid AND status <> 'revoked'`.execute(tx);
          return p;
        }),
      );
      tok = next ?? undefined;
      if (!next) done = true;
    }
    if (done) {
      await ctx.withTx((tx) => sql`UPDATE user_mail_links SET backfill_page_token = NULL, backfill_done_at = now() WHERE tenant_id = app.tenant_id() AND id = ${link.id}::uuid AND status <> 'revoked'`.execute(tx));
    }
  }

  await ctx.withTx((tx) =>
    sql`UPDATE user_mail_links SET last_synced_at = now(), last_error_code = NULL, status = CASE WHEN status = 'degraded' THEN 'connected' ELSE status END,
               next_sync_at = now() + make_interval(secs => ${rules.pollIntervalSeconds})
         WHERE tenant_id = app.tenant_id() AND id = ${link.id}::uuid AND status <> 'revoked'`.execute(tx),
  );
  return res;
}

class LinkNotLive extends Error {
  override readonly name = 'LinkNotLive';
}

async function setCursor(tx: Tx, linkId: string, historyId: string): Promise<void> {
  await sql`UPDATE user_mail_links SET history_id = ${historyId} WHERE tenant_id = app.tenant_id() AND id = ${linkId}::uuid AND status <> 'revoked'
              AND (history_id IS NULL OR history_id::numeric < ${historyId}::numeric)`.execute(tx);
}

async function backfillDays(ctx: StandaloneJobContext): Promise<number> {
  return ctx.withTx(async (tx) => Number((await sql<{ d: number }>`SELECT mail_backfill_days AS d FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]?.d ?? 0));
}

function dedupeRefs(refs: readonly GmailRef[]): GmailRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

async function fetchAll(gmail: GmailProvider, access: string, refs: readonly GmailRef[], deps: MailSyncDeps): Promise<(GmailMessage & { fetchedAt: number })[]> {
  const out: (GmailMessage & { fetchedAt: number })[] = [];
  for (const ref of refs) {
    try {
      const m = await gmail.getMessage(access, ref.id, 'full');
      out.push({ ...m, fetchedAt: (deps.now ?? Date.now)() });
    } catch (e) {
      // a message deleted between history and fetch: nothing to store
      if ((e as { providerCode?: string }).providerCode === 'NOT_FOUND') continue;
      throw e;
    }
  }
  return out;
}

interface PageResult {
  stored: number;
  optOuts: number;
  handbacks: number;
}

type Mode = 'live' | 'resync' | 'backfill';

/** Steps 3-4 for one page, in ONE system transaction (the caller commits it before the cursor moves). */
export async function processPage(tx: Tx, actor: SystemActor, deps: MailSyncDeps, link: LinkRow, rules: GmailPackRules, msgs: readonly (GmailMessage & { fetchedAt: number })[], removed: readonly GmailRef[], mode: Mode): Promise<PageResult> {
  const out: PageResult = { stored: 0, optOuts: 0, handbacks: 0 };
  // the link may have been revoked while this page was fetched (a disconnect, the switch off): nothing fetched after
  // that is processed, opt-outs included (they are recorded again from platform email or the next link)
  const live = await sql<{ live: boolean }>`
    SELECT app.mail_link_live(app.tenant_id(), ${link.id}::uuid) AS live FROM user_mail_links
     WHERE tenant_id = app.tenant_id() AND id = ${link.id}::uuid FOR SHARE`.execute(tx);
  if (live.rows[0]?.live !== true) throw new LinkNotLive();
  const tenantId = actor.tenantId as TenantId;
  const env = deps.envelope.inTx(tx, tenantId);
  // E219: trashed, spammed or deleted in Gmail ⇒ its copies go
  if (removed.length > 0) {
    await sql`DELETE FROM mail_messages WHERE tenant_id = app.tenant_id() AND link_id = ${link.id}::uuid AND gmail_message_id = ANY (${removed.map((r) => r.id)}::text[])`.execute(tx);
  }
  if (msgs.length === 0) return out;
  const { policy } = await resolvedPolicy(tx);
  const mailboxHmac = link.mailbox_address_hmac.toString('hex');
  const confirmed = (
    await sql<{ contact_id: string; point_id: string; hmac: Buffer }>`
      SELECT sp.contact_id, sp.contact_point_id AS point_id, p.address_hmac AS hmac
        FROM mail_sync_points sp JOIN contact_points p ON p.tenant_id = sp.tenant_id AND p.id = sp.contact_point_id AND p.contact_id = sp.contact_id
        JOIN contacts c ON c.tenant_id = p.tenant_id AND c.id = p.contact_id
       WHERE sp.tenant_id = app.tenant_id() AND sp.link_id = ${link.id}::uuid AND p.kind = 'email' AND p.removed_at IS NULL
         AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL`.execute(tx)
  ).rows.map((x): RelatedEmailPoint => ({ contactId: x.contact_id, pointId: x.point_id, hmac: x.hmac.toString('hex') }));
  const excluded = new Set(
    (await sql<{ t: string }>`SELECT gmail_thread_id AS t FROM mail_thread_exclusions WHERE tenant_id = app.tenant_id() AND link_id = ${link.id}::uuid`.execute(tx)).rows.map((x) => x.t),
  );

  for (const m of msgs) {
    if (isSkipped(m.labelIds)) {
      await sql`DELETE FROM mail_messages WHERE tenant_id = app.tenant_id() AND link_id = ${link.id}::uuid AND gmail_message_id = ${m.id}`.execute(tx);
      continue;
    }
    const from = parseAddressList(header(m.headers, 'From')).slice(0, 1);
    const to = parseAddressList(header(m.headers, 'To'));
    const cc = parseAddressList(header(m.headers, 'Cc'));
    const bcc = parseAddressList(header(m.headers, 'Bcc'));
    const hmacs = new Map<string, string>();
    for (const a of new Set([...from, ...to, ...cc, ...bcc])) hmacs.set(a, Buffer.from(await env.hmacAddress(tenantId, a)).toString('hex'));
    const hmacOf = (a: string) => hmacs.get(a)!;
    const own = stripQuoted(m.textPlain ?? '');

    // R-GMAIL-9 (S-D2-3): classify ONCE, before and regardless of storage, a message FROM a current email point of the tenant
    let classification: InboundClassification = { kind: 'none', needsReview: false };
    let senderContacts: string[] = [];
    if (from[0] !== undefined && hmacOf(from[0]) !== mailboxHmac) {
      senderContacts = (
        await sql<{ contact_id: string }>`
          SELECT DISTINCT p.contact_id FROM contact_points p JOIN contacts c ON c.tenant_id = p.tenant_id AND c.id = p.contact_id
           WHERE p.tenant_id = app.tenant_id() AND p.kind = 'email' AND p.removed_at IS NULL AND p.address_hmac = ${Buffer.from(hmacOf(from[0]), 'hex')}
             AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL ORDER BY p.contact_id`.execute(tx)
      ).rows.map((x) => x.contact_id);
      if (senderContacts.length > 0) classification = classifyInbound(own.text, policy.keywords, 'email');
    }

    // store (outside excluded threads), over the CONFIRMED points only (S-D2-1); the DB re-checks every rule
    const stored: { match: ParticipantMatch; id: string }[] = [];
    if (!excluded.has(m.threadId)) {
      const matches = matchMailParticipants({ from, to, cc, bcc }, confirmed, hmacOf, mailboxHmac);
      const rfc = rfcMessageIdSha256(header(m.headers, 'Message-ID'));
      const subject = header(m.headers, 'Subject');
      const attachments = m.attachments.slice(0, 20).map((a) => ({ name: String(a.name).slice(0, 255), mime_type: String(a.mimeType).slice(0, 255), size_bytes: Math.max(0, Math.floor(Number(a.sizeBytes) || 0)) }));
      for (const match of matches) {
        const id = deps.ids.next<'MailMessageId'>();
        const r = await attempt(tx, async () =>
          (
            await sql<{ id: string }>`
              INSERT INTO mail_messages (tenant_id, id, link_id, contact_id, contact_point_id, contact_address_hmac, gmail_message_id, gmail_thread_id,
                rfc_message_id_sha256, sender, contact_role, other_recipient_count, subject, body, body_truncated, attachments, internal_at, origin)
              VALUES (app.tenant_id(), ${id}::uuid, ${link.id}::uuid, ${match.contactId}::uuid, ${match.pointId}::uuid, ${Buffer.from(match.hmac, 'hex')},
                ${m.id}, ${m.threadId}, ${rfc}, ${match.sender}, ${match.role}, ${match.otherRecipientCount}, ${subject === null ? null : subject.slice(0, 998)},
                ${own.text}, ${own.truncated}, ${JSON.stringify(attachments)}::jsonb, ${new Date(m.internalDate).toISOString()}::timestamptz, 'live')
              ON CONFLICT (tenant_id, link_id, gmail_message_id, contact_id) DO NOTHING RETURNING id`.execute(tx)
          ).rows[0]?.id ?? null,
        );
        // a refusal (duplicate of platform email, thread cap, older than the window, …) stores nothing for this match
        if (r.ok && r.value) {
          stored.push({ match, id: r.value });
          out.stored++;
        }
      }
    }

    // record the opt-out exactly as platform email does, citing the stored copy or the message (R-GMAIL-9, E213, E214, E229)
    if (classification.kind === 'stop' || classification.kind === 'opt_out_language' || classification.kind === 'wrong_number') {
      if (await recordSyncedOptOut(tx, actor, deps, link, m, from[0]!, hmacOf(from[0]!), senderContacts, stored, classification, confirmed)) out.optOuts++;
    }

    // R-GMAIL-10, E226: a fresh LIVE client message pauses and hands back once; backfill copies and older mail never
    // do. Decided by the copy's origin (the DB's) and its age, in every mode: a live reply a backfill page happens to
    // see first still pauses
    {
      for (const s of stored) {
        if (s.match.sender !== 'contact') continue;
        const origin = (await sql<{ o: string }>`SELECT origin AS o FROM mail_messages WHERE tenant_id = app.tenant_id() AND id = ${s.id}::uuid`.execute(tx)).rows[0]?.o;
        if (origin !== 'live' || m.fetchedAt - m.internalDate > FRESH_MS) continue;
        const h = await ingestSyncedMailInTx(tx, s.match.contactId, s.id, classification.kind, { ids: deps.ids });
        if (h.handbackId) out.handbacks++;
      }
    }
  }
  return out;
}

async function recordSyncedOptOut(
  tx: Tx,
  actor: SystemActor,
  deps: MailSyncDeps,
  link: LinkRow,
  m: GmailMessage,
  fromAddress: string,
  fromHmac: string,
  senderContacts: readonly string[],
  stored: readonly { match: ParticipantMatch; id: string }[],
  classification: InboundClassification,
  confirmed: readonly RelatedEmailPoint[],
): Promise<boolean> {
  // the contact the event is recorded on: the one a copy was stored for as sender, else one of this mailbox's confirmed
  // clients on that address, else the first contact holding the address (deterministic; address-keyed either way)
  const sentCopy = stored.find((s) => s.match.sender === 'contact');
  const target = sentCopy?.match.contactId ?? confirmed.find((p) => p.hmac === fromHmac && senderContacts.includes(p.contactId))?.contactId ?? senderContacts[0]!;
  const ref = gmailMessageRef(link.id, m.id);
  // idempotent: a replayed message records nothing twice
  const copyIds = (await sql<{ id: string }>`SELECT id FROM mail_messages WHERE tenant_id = app.tenant_id() AND link_id = ${link.id}::uuid AND gmail_message_id = ${m.id}`.execute(tx)).rows.map((x) => x.id);
  const seen = await sql`
    SELECT 1 FROM consent_events WHERE tenant_id = app.tenant_id() AND evidence->>'kind' = 'synced_gmail'
       AND (evidence->>'synced_key' = ${ref} OR evidence->>'gmail_message_ref' = ${ref} OR evidence->>'mail_message_id' = ANY (${copyIds}::text[])) LIMIT 1`.execute(tx);
  if (seen.rows.length > 0) return false;
  const citation = sentCopy && sentCopy.match.contactId === target ? { mail_message_id: sentCopy.id } : { gmail_message_ref: ref };
  const otherEmails = (
    await sql<{ address: string; hmac: Buffer }>`
      SELECT address, address_hmac AS hmac FROM contact_points WHERE tenant_id = app.tenant_id() AND contact_id = ${target}::uuid AND kind = 'email' AND removed_at IS NULL`.execute(tx)
  ).rows
    .filter((p) => p.hmac.toString('hex') !== fromHmac)
    .map((p): InboundAddress => ({ kind: 'email', hmac: p.hmac.toString('hex'), hint: hint(p.address) }));
  const now = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx)).rows[0]!.now.getTime() as Instant;
  const fx = planInboundEffects({
    classification,
    channel: 'email',
    address: { kind: 'email', hmac: fromHmac, hint: hint(fromAddress) },
    otherPhones: [],
    otherEmails,
    occurredAt: now,
    contactId: target,
    messageId: null,
    policy: { optOutConfirmationSender: 'provider' },
    ids: deps.ids,
  });
  // synced mail is only ever a cited system EMAIL revoke (consent_events_synced_gmail); everything a person-level
  // opt-out reaches beyond email is the do-not-contact below, exactly as platform email records it
  const events = fx.consentEvents.filter((e) => e.eventType === 'revoke' && e.channel === 'email' && e.addressKind === 'email');
  for (const e of events) await recordConsentEvent(tx, { ...e, evidenceMessageId: null, evidence: { kind: 'synced_gmail', ...citation, synced_key: ref, ...(classification.matched ? { matched: classification.matched.slice(0, 80) } : {}) } });
  const firstRevoke = events.find((e) => e.contactId === target);
  if (fx.personDoNotContact && firstRevoke) await sql`SELECT app.record_person_opt_out(${target}::uuid, ${firstRevoke.id}::uuid)`.execute(tx);
  if (fx.markWrongNumber) {
    await sql`UPDATE contact_points SET status = 'wrong_number' WHERE tenant_id = app.tenant_id() AND address_hmac = ${Buffer.from(fromHmac, 'hex')} AND kind = 'email' AND removed_at IS NULL`.execute(tx);
  }
  await audit(tx, actor, { action: 'consent.opt_out_received', entity: { type: 'contact', id: target }, reason: `${classification.kind.toUpperCase()}_SYNCED_GMAIL` });
  if (fx.notifyOwner) {
    const h = await handlerOf(tx, target);
    if (h.userId) {
      await notifyUser(tx, deps.ids, { userId: h.userId, kind: 'opt_out', priority: 'normal', title: classification.kind === 'wrong_number' ? 'A contact’s email may be a wrong address' : 'A contact opted out', body: null, subjectType: 'contact', subjectId: target, dedupeKey: `opt_out:gmail:${ref.slice(0, 32)}` }, now);
    }
  }
  return events.length > 0;
}

