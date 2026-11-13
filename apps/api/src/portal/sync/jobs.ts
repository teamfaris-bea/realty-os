// Job contracts of module 45 (kind, queue, payload schema, dedupe key), shared by the code that enqueues them
// (signin/links.ts, staff/*) and their handlers (sync/handlers.ts). Payloads are ids only (R-TEN-7).
import { jobPayload, zId } from '../../worker/payload.js';

export const PORTAL_SYNC_KIND = 'portal.sync' as const;
export const PORTAL_SYNC_EVERY_MS = 5 * 60_000;
export const PORTAL_SYNC_BATCH = 500;

/** A sign-in link's 15-minute end: a queued link is canceled and its sealed URL dropped (b14 audit F2; links.ts). */
export const LinkExpirePayload = jobPayload({ messageId: zId });
export const PORTAL_LINK_EXPIRE = {
  kind: 'portal.link_expire' as const,
  queue: 'default' as const,
  schema: LinkExpirePayload,
  dedupeKey: (p: { messageId: string }) => `portal.link_expire:${p.messageId}`,
};

/** A one-off pass of the sync for a tenant right after an invite (the periodic pass also runs every 5 minutes). */
export const SyncPayload = jobPayload({});
export const PORTAL_SYNC_NOW = { kind: PORTAL_SYNC_KIND, queue: 'default' as const, schema: SyncPayload };

/** How long a sign-in link lives (0023: 15 minutes); a link still queued after that is canceled. */
export const LINK_TTL_MS = 15 * 60_000;
export const LINK_EXPIRE_RETRY_MS = 60_000;
