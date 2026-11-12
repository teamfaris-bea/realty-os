// Review sync (module 53; DATA_MODEL R-GBP-3, R-GBP-4, R-GBP-5; E460, E461, E465, E467, E468).
//
// One pass per tenant (gbp.reconcile, every 5 minutes, as the system via 'provider'), over the live GBP locations whose
// stored next_sync_at is due (R-OWN-27). While platform:gbp is uncleared or the adapter is not configured it does
// nothing and calls nothing (E460). For each due location:
//   - the token is decrypted as the system, in memory only (R-INT-4);
//   - listReviews runs outside any transaction, at most MAX_PAGES pages per pass, resuming from sync_cursor (NULL
//     starts a sweep). Each page is applied in its own system transaction behind the cursor fence (only the pass that
//     read the cursor advances it): new reviews are inserted; an edited one takes Google's rating, text, reviewer and
//     time; an owner reply seen marks it replied (outside Realty OS: no action) and supersedes a waiting draft (E461);
//     a reply Realty OS posted that Google no longer shows goes back to "needs a reply" unless it was posted less than
//     REPLIED_GRACE_MS ago (E468);
//   - a reply approved more than SETTLE_AFTER_MS ago with no answer (E465) is settled when its review is read: posted
//     when Google shows the approved text (whitespace-normalised, VERIFY), otherwise back to a draft waiting for a tap;
//   - a sweep that reaches complete=true resets the cursor to NULL. Reviews are blanked "Removed at Google" (and their
//     waiting drafts invalidated) only after a sweep that started at NULL and completed within this pass, without an
//     error and with every review readable (E467). A failed page, a list longer than the pass, or an unreadable review
//     (last_error_code GBP_REVIEW_UNREADABLE) removes nothing.
// Reviews are publishing data, not contact data: nothing here reads or writes contacts, contact points, touches or
// consent, and reviewers are never matched to contacts (R-GBP-5, R-GATE-15).
import { type IdGenerator, type Instant, type TenantId, plusMs } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { audit, redactSnapshot } from '../audit.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { ProviderError } from '../providers/types.js';
import type { StandaloneJobContext } from '../worker/types.js';
import { type GbpProvider, type GbpReview, parseGbpReview, sameReplyText } from './provider.js';
import * as R from './repos/gbp.js';

export const GBP_SYNC_EVERY_MS = 5 * 60_000;
export const MAX_PAGES = 5;
/** an approved reply with no answer for this long is settled from what Google shows (E465) */
export const SETTLE_AFTER_MS = 5 * 60_000;
/** a reply Realty OS posted this recently that Google does not show yet is not undone (E468; Google may lag, VERIFY) */
export const REPLIED_GRACE_MS = 5 * 60_000;

export interface GbpSyncDeps {
  envelope: EnvelopeService;
  gbp: GbpProvider;
  ids: IdGenerator;
}

export interface GbpSyncSummary {
  locations: number;
  pages: number;
  inserted: number;
  updated: number;
  removed: number;
  settled: number;
  errors: number;
}

const CODE_RE = /^[A-Z][A-Z0-9_]*$/;
const codeOf = (e: unknown) => {
  const c = e instanceof ProviderError ? (e.providerCode ?? `PROVIDER_${e.kind.toUpperCase()}`) : 'GBP_SYNC_FAILED';
  return CODE_RE.test(c) ? c.slice(0, 60) : 'GBP_SYNC_FAILED';
};

async function tokenOf(tx: Tx, envelope: EnvelopeService, tenantId: TenantId, credentialId: string): Promise<string | null> {
  const secret = await R.credentialSecret(tx, credentialId);
  if (!secret) return null;
  const pt = await envelope.inTx(tx, tenantId).decrypt(tenantId, { table: 'provider_credentials', column: 'secret_enc', rowId: credentialId }, new Uint8Array(secret));
  const parsed = JSON.parse(new TextDecoder().decode(pt)) as { accessToken?: unknown };
  return typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0 ? parsed.accessToken : null;
}

/** Is GBP live for this tenant at all? (platform:gbp cleared and a configured adapter) */
export async function gbpLive(ctx: Pick<StandaloneJobContext, 'withTx'>, gbp: GbpProvider | undefined): Promise<boolean> {
  if (!gbp?.configured) return false;
  return ctx.withTx(async (tx) => (await R.packState(tx)).cleared);
}

export async function syncReviews(ctx: StandaloneJobContext, deps: GbpSyncDeps): Promise<GbpSyncSummary> {
  const out: GbpSyncSummary = { locations: 0, pages: 0, inserted: 0, updated: 0, removed: 0, settled: 0, errors: 0 };
  // E460: dark while uncleared or not set up: no provider call, no row
  if (!(await gbpLive(ctx, deps.gbp))) return out;
  const tenantId = ctx.actor.tenantId as TenantId;
  const due = await ctx.withTx((tx, now) => R.dueLocations(tx, now));
  for (const loc of due) {
    out.locations++;
    let error: string | null = null;
    try {
      const token = await ctx.withTx((tx) => tokenOf(tx, deps.envelope, tenantId, loc.credential_id!)).catch(() => null);
      if (!token) {
        await ctx.withTx((tx, now) => R.finishPass(tx, loc.id, plusMs(now, GBP_SYNC_EVERY_MS), 'CREDENTIAL_UNAVAILABLE'));
        out.errors++;
        continue;
      }
      const startedAtNull = loc.sync_cursor === null;
      const seen = new Set<string>();
      let clean = true;
      let completed = false;
      let cursor = loc.sync_cursor;
      for (let page = 0; page < MAX_PAGES; page++) {
        let res;
        try {
          res = await deps.gbp.listReviews({ externalAccountId: loc.external_account_id!, accessToken: token, cursor });
        } catch (e) {
          error = codeOf(e);
          clean = false;
          break;
        }
        out.pages++;
        const parsed: GbpReview[] = [];
        let unreadable = false;
        for (const raw of res.reviews) {
          const p = parseGbpReview(raw);
          if (p.ok) {
            parsed.push(p.review);
            seen.add(p.review.externalReviewId);
          } else {
            unreadable = true;
            if (p.externalReviewId) seen.add(p.externalReviewId); // never removed for being unreadable
          }
        }
        if (unreadable) {
          clean = false;
          error = 'GBP_REVIEW_UNREADABLE';
        }
        const next = res.complete ? null : res.cursor;
        const applied = await ctx.withTx(async (tx, now) => {
          // the cursor fence: only the pass that read this cursor may advance it
          const cur = await R.locationById(tx, loc.id, { forUpdate: true });
          if (!cur || (cur.status !== 'connected' && cur.status !== 'degraded') || cur.sync_cursor !== cursor) return null;
          const counts = { inserted: 0, updated: 0, settled: 0 };
          for (const r of parsed) {
            const k = await applyReview(tx, ctx, deps, loc.id, r, now);
            if (k.inserted) counts.inserted++;
            if (k.updated) counts.updated++;
            if (k.settled) counts.settled++;
          }
          await R.advanceCursor(tx, loc.id, next, error);
          return counts;
        });
        if (applied === null) {
          clean = false;
          break;
        }
        out.inserted += applied.inserted;
        out.updated += applied.updated;
        out.settled += applied.settled;
        if (res.complete) {
          completed = true;
          break;
        }
        if (next === null || next === cursor) {
          clean = false;
          break;
        }
        cursor = next;
      }
      const removed = await ctx.withTx(async (tx, now) => {
        let n = 0;
        // E467: only a sweep that started at the top and completed within this pass, cleanly, removes anything
        if (startedAtNull && completed && clean) {
          for (const r of await R.unseenReviews(tx, loc.id, [...seen])) {
            await R.blankReview(tx, r.id);
            if (r.reply_status === 'drafted' && r.reply_action_id) {
              const a = await R.actionById(tx, r.reply_action_id, { forUpdate: true });
              if (a?.status === 'proposed') {
                await R.setActionStatus(tx, a.id, 'invalidated');
                await R.setReply(tx, r.id, 'none', null);
              }
            }
            n++;
          }
        }
        await R.finishPass(tx, loc.id, plusMs(now, GBP_SYNC_EVERY_MS), error);
        if (out.pages > 0) await audit(tx, ctx.actor, { action: 'gbp.reviews_synced', entity: { type: 'integration_connection', id: loc.id }, changes: redactSnapshot({ removed: n, error }), reason: completed ? 'SWEEP_COMPLETE' : 'SWEEP_PARTIAL' });
        return n;
      });
      out.removed += removed;
      if (error) out.errors++;
    } catch (e) {
      out.errors++;
      await ctx.withTx((tx, now) => R.finishPass(tx, loc.id, plusMs(now, GBP_SYNC_EVERY_MS), codeOf(e))).catch(() => undefined);
    }
  }
  return out;
}

/** One review as Google shows it now, applied to the stored row (inside the page's system transaction). */
async function applyReview(tx: Tx, ctx: StandaloneJobContext, deps: GbpSyncDeps, connectionId: string, r: GbpReview, now: Instant): Promise<{ inserted?: boolean; updated?: boolean; settled?: boolean }> {
  const cur = await R.reviewByExternal(tx, connectionId, r.externalReviewId);
  if (!cur) {
    await R.insertReview(tx, deps.ids.next<'GbpReviewId'>(), connectionId, r);
    return { inserted: true };
  }
  const out: { updated?: boolean; settled?: boolean } = {};
  if (cur.rating !== r.rating || cur.body !== r.body || cur.reviewer_display !== r.reviewerDisplay || cur.reviewed_at.toISOString() !== r.reviewedAt) {
    await R.updateFacts(tx, cur.id, r);
    out.updated = true;
  }
  const action = cur.reply_action_id ? await R.actionById(tx, cur.reply_action_id, { forUpdate: true }) : null;
  let actionStatus = action?.status ?? null;
  // E465: a reply approved long ago with no answer, settled from what Google shows
  if (cur.reply_status === 'drafted' && action && action.status === 'approved' && action.decided_at && action.decided_at.getTime() < now - SETTLE_AFTER_MS) {
    const approvedText = action.edited_payload?.text ?? action.payload.text ?? '';
    if (r.ownerReply && sameReplyText(r.ownerReply.text, approvedText)) {
      await R.setActionStatus(tx, action.id, 'executed');
      await R.setReply(tx, cur.id, 'replied', action.id);
      await audit(tx, ctx.actor, { action: 'gbp.reply_posted', entity: { type: 'gbp_review', id: cur.id }, changes: redactSnapshot({ action_id: action.id }), reason: 'SEEN_AT_GOOGLE' });
      return { ...out, settled: true };
    }
    await R.revertToProposed(tx, action.id);
    actionStatus = 'proposed';
    out.settled = true;
  }
  if (r.ownerReply) {
    if (cur.reply_status === 'none') await R.setReply(tx, cur.id, 'replied', null);
    // E461: answered at Google outside Realty OS: the waiting draft is no longer wanted
    else if (cur.reply_status === 'drafted' && action && actionStatus === 'proposed') {
      await R.setActionStatus(tx, action.id, 'superseded');
      await R.setReply(tx, cur.id, 'replied', null);
    }
  } else if (cur.reply_status === 'replied') {
    // E468: the owner reply is gone at Google; a reply we posted moments ago may not show yet
    const recent = action?.status === 'executed' && action.decided_at !== null && action.decided_at.getTime() >= now - REPLIED_GRACE_MS;
    if (!recent) await R.setReply(tx, cur.id, 'none', null);
  }
  return out;
}
