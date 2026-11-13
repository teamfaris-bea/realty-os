// The client's sign-in link (R-PORTAL-11; findings F2, F3, F9, F12; b14 audit F2). Called only AFTER the HTTP reply has
// left (signin/routes.ts), so the answer never waits on whether an account matched.
//
// Per link, as the system of the definer row's tenant (R-TEN-3), in one transaction: queueOutboundInTx (initiator
// system, purpose informational, category portal_login_link, to the login point) with a FIXED LINE as its body, the URL
// sealed beside it (portal.seal_link: envelope-encrypted under the tenant field key, AAD = the message id; 0088), and a
// portal.link_expire job at +60 s. After commit, dispatchOutbound inline (the queued comms.dispatch races it; one TX1
// wins). Every send goes through dispatchOutbound: D1 opt-outs, suppressions, do-not-contact and the DB guard apply;
// only the automation pause does not (core check 8, R-PORTAL-11).
//
// The URL never enters messages.body, at any status (b14 audit F2, orchestrator decision (a)): comms/dispatch.ts
// renders it from the seal after the stored line, at the provider send and in the SMS reconcile's lookup, and nowhere
// else. The seal goes at the first final status (a trigger on messages), at 15 minutes (portal.link_expire, and
// portal.sync's backstop) and with the message (erasure).
import { createHash } from 'node:crypto';
import type { ContactId, Instant, TenantId } from '@realty/core/foundation';
import { type PortalLoginLink, type Tx, lockContact } from '@realty/db';
import { sql } from 'kysely';
import { queueOutboundInTx } from '../../comms/compose.js';
import { dispatchOutbound, portalLinkSealAad } from '../../comms/dispatch.js';
import { markCanceled } from '../../comms/repos/messages.js';
import { asSystem } from '../../comms/runtime.js';
import type { CommsDeps } from '../../comms/types.js';
import { enqueueTyped } from '../../worker/registry.js';
import { LINK_EMAIL_SUBJECT, linkLine, portalLinkUrl } from '../shared/copy.js';
import { LINK_EXPIRE_RETRY_MS, LINK_TTL_MS, PORTAL_LINK_EXPIRE } from '../sync/jobs.js';

/** Statuses after which nothing sends or reconciles the link again (its seal goes at the first of them). */
export const FINAL_STATUSES = ['sent', 'delivered', 'failed', 'undelivered', 'bounced', 'blocked', 'canceled'] as const;
const FINAL = new Set<string>(FINAL_STATUSES);

export interface LinkLog {
  warn(o: Record<string, unknown>, msg: string): void;
  error(o: Record<string, unknown>, msg: string): void;
}

/** The message idempotency key of a link: its token's hash, never the token. */
export const linkIdempotencyKey = (token: string): string => `portal_link:${createHash('sha256').update(token, 'utf8').digest('hex')}`;

interface NameFacts {
  brokerage: string;
  name: string;
}

async function nameFacts(tx: Tx, contactId: string): Promise<NameFacts | null> {
  const r = await sql<{ brokerage: string | null; team: string | null; first_name: string | null; display_name: string }>`
    SELECT s.brokerage_legal_name AS brokerage, s.team_name AS team, c.first_name, c.display_name
      FROM public.contacts c JOIN public.tenant_settings s ON s.tenant_id = c.tenant_id
     WHERE c.tenant_id = app.tenant_id() AND c.id = ${contactId}`.execute(tx);
  const row = r.rows[0];
  if (!row) return null;
  const first = (row.first_name ?? '').trim();
  return { brokerage: (row.brokerage ?? row.team ?? '').trim() || 'Your agent', name: first !== '' ? first : row.display_name.trim() };
}

export interface DeliverDeps {
  comms: CommsDeps;
  webOrigin: string;
  log: LinkLog;
  /** Test seam (never set in production): runs once the link is queued, before the inline dispatch, so a test can let
   *  the queued comms.dispatch win TX1 (the worker-wins race, b14 audit F2). */
  beforeInlineDispatch?: (messageId: string) => Promise<void>;
}

/** Sends each link (usually one; spouses sharing an email get one each, E683). Never throws: errors are logged by code. */
export async function deliverLinks(d: DeliverDeps, links: readonly PortalLoginLink[]): Promise<void> {
  for (const link of links) {
    try {
      await deliverOne(d, link);
    } catch (e) {
      d.log.error({ code: codeOf(e) }, 'portal: a sign-in link could not be delivered');
    }
  }
}

const codeOf = (e: unknown): string => {
  const m = String((e as { code?: unknown; message?: unknown })?.code ?? (e as { message?: unknown })?.message ?? 'UNKNOWN');
  return (/^[A-Z][A-Z0-9_]{2,60}/.exec(m)?.[0] ?? (/^[0-9A-Z]{5}$/.test(m) ? m : 'UNEXPECTED'));
};

async function deliverOne(d: DeliverDeps, link: PortalLoginLink): Promise<void> {
  const channel = link.loginKind === 'email' ? 'email' : 'sms';
  const queued = await asSystem(d.comms, link.tenantId, 'worker', async (tx, now) => {
    const f = await nameFacts(tx, link.contactId);
    if (!f) return { code: 'CONTACT_NOT_FOUND' as const };
    const r = await queueOutboundInTx(
      tx,
      d.comms,
      {
        contactId: link.contactId,
        channel,
        body: linkLine({ brokerage: f.brokerage, name: f.name, channel }),
        ...(channel === 'email' ? { subject: LINK_EMAIL_SUBJECT } : {}),
        initiator: 'system',
        purpose: 'informational',
        category: 'portal_login_link',
        toPointId: link.loginPointId,
        idempotencyKey: linkIdempotencyKey(link.token),
      },
      now,
    );
    if (!r.ok) return { code: r.code };
    if (r.created) {
      // the URL is sealed beside the message, never written to it (b14 audit F2)
      const url = Buffer.from(portalLinkUrl(d.webOrigin, link.token), 'utf8');
      const sealed = await d.comms.envelope.inTx(tx, link.tenantId).encrypt(link.tenantId, portalLinkSealAad(r.messageId), url);
      url.fill(0);
      await sql`SELECT portal.seal_link(${r.messageId}::uuid, ${Buffer.from(sealed)})`.execute(tx);
      await enqueueTyped(tx, PORTAL_LINK_EXPIRE, { messageId: r.messageId }, { runAt: (now + LINK_EXPIRE_RETRY_MS) as Instant, dedupeKey: PORTAL_LINK_EXPIRE.dedupeKey({ messageId: r.messageId }) });
    }
    return { messageId: r.messageId };
  });
  if ('code' in queued) {
    d.log.warn({ code: queued.code }, 'portal: a sign-in link was not queued');
    return;
  }
  await d.beforeInlineDispatch?.(queued.messageId);
  await dispatchOutbound(queued.messageId, d.comms, { tenantId: link.tenantId });
}

/** Drops a link's seal (the system only; a no-op for anyone else, or when it is already gone). */
async function unsealInTx(tx: Tx, messageId: string): Promise<void> {
  await sql`SELECT portal.unseal_link(${messageId}::uuid)`.execute(tx);
}

/**
 * portal.link_expire: final ⇒ the seal is gone (the trigger dropped it; dropped again here for certainty); under 15
 * minutes ⇒ again in 60 s (or at the 15-minute mark); at 15 minutes a link still queued or scheduled is canceled
 * PORTAL_LINK_EXPIRED, and the seal of any link still not final (dispatching, dispatch_unknown) is dropped: the link has
 * expired, so nothing renders it again (a reconcile then matches nothing and ends DISPATCH_UNKNOWN_UNRESOLVED).
 */
export async function linkExpireInTx(tx: Tx, messageId: string, now: Instant): Promise<{ retryAt: Instant } | void> {
  const r = await sql<{ contact_id: string; status: string; created_at: Date }>`
    SELECT contact_id, status, created_at FROM public.messages
     WHERE tenant_id = app.tenant_id() AND id = ${messageId} AND action_category = 'portal_login_link'`.execute(tx);
  const m = r.rows[0];
  if (!m) return; // erased: the seal went with the message
  if (FINAL.has(m.status)) return unsealInTx(tx, messageId);
  const expiresAt = m.created_at.getTime() + LINK_TTL_MS;
  if (now < expiresAt) return { retryAt: Math.min(now + LINK_EXPIRE_RETRY_MS, expiresAt) as Instant };
  if (m.status === 'queued' || m.status === 'scheduled') {
    await lockContact(tx, m.contact_id as ContactId);
    await markCanceled(tx, messageId, 'PORTAL_LINK_EXPIRED', null);
  }
  await unsealInTx(tx, messageId);
}

/** portal.sync's backstop: links still queued after 15 minutes are canceled, and this tenant's expired seals and the
 *  seals of final messages are dropped. Returns how many links it canceled plus how many seals it dropped. */
export async function linkBackstopInTx(tx: Tx, limit: number): Promise<number> {
  const r = await sql<{ id: string; contact_id: string }>`
    SELECT id, contact_id FROM public.messages
     WHERE tenant_id = app.tenant_id() AND action_category = 'portal_login_link' AND direction = 'outbound'
       AND created_at < now() - interval '15 minutes' AND status IN ('queued','scheduled')
     ORDER BY created_at LIMIT ${limit}`.execute(tx);
  for (const m of r.rows) {
    await lockContact(tx, m.contact_id as ContactId);
    await markCanceled(tx, m.id, 'PORTAL_LINK_EXPIRED', null);
  }
  const swept = await sql<{ n: number }>`SELECT portal.sweep_link_seals() AS n`.execute(tx);
  return r.rows.length + Number(swept.rows[0]?.n ?? 0);
}

export type { TenantId };
