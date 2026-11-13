// The client's sign-in link (R-PORTAL-11; findings F2, F3, F9, F12). Called only AFTER the HTTP reply has left
// (signin/routes.ts), so the answer never waits on whether an account matched.
//
// Per link, as the system of the definer row's tenant (R-TEN-3), in one transaction: queueOutboundInTx (initiator
// system, purpose informational, category portal_login_link, to the login point) and a portal.link_redact job at
// +60 s. After commit, dispatchOutbound inline (the queued comms.dispatch races it; one TX1 wins), then the stored
// body is redacted once the send is final. Every send goes through dispatchOutbound: D1 opt-outs, suppressions,
// do-not-contact and the DB guard apply; only the automation pause does not (core check 8, R-PORTAL-11).
//
// Redaction keeps the body while the message is `dispatching` or `dispatch_unknown`: the SMS reconcile finds the
// provider's message by sender, recipient, BODY and time (dispatch.ts reconcileOutbound), for up to 10 minutes.
import { createHash } from 'node:crypto';
import type { ContactId, Instant, TenantId } from '@realty/core/foundation';
import { type PortalLoginLink, type Tx, lockContact } from '@realty/db';
import { sql } from 'kysely';
import { queueOutboundInTx } from '../../comms/compose.js';
import { dispatchOutbound } from '../../comms/dispatch.js';
import { markCanceled } from '../../comms/repos/messages.js';
import { asSystem } from '../../comms/runtime.js';
import type { CommsDeps } from '../../comms/types.js';
import { enqueueTyped } from '../../worker/registry.js';
import { LINK_EMAIL_SUBJECT, linkBody, portalLinkUrl, redactedLinkBody } from '../shared/copy.js';
import { LINK_REDACT_RETRY_MS, LINK_TTL_MS, PORTAL_LINK_REDACT } from '../sync/jobs.js';

/** Statuses after which nothing reads the body again to send or reconcile it. */
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
}

/** Sends each link (usually one; spouses sharing an email get one each, E643). Never throws: errors are logged by code. */
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
        body: linkBody({ brokerage: f.brokerage, name: f.name, url: portalLinkUrl(d.webOrigin, link.token), channel }),
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
      await enqueueTyped(tx, PORTAL_LINK_REDACT, { messageId: r.messageId }, { runAt: (now + LINK_REDACT_RETRY_MS) as Instant, dedupeKey: PORTAL_LINK_REDACT.dedupeKey({ messageId: r.messageId }) });
    }
    return { messageId: r.messageId };
  });
  if ('code' in queued) {
    d.log.warn({ code: queued.code }, 'portal: a sign-in link was not queued');
    return;
  }
  await dispatchOutbound(queued.messageId, d.comms, { tenantId: link.tenantId });
  await asSystem(d.comms, link.tenantId, 'worker', (tx) => redactLinkInTx(tx, queued.messageId));
}

/**
 * Replaces a sign-in link message's body with the fixed line once its status is final (R-PORTAL-11; F3, F9).
 * As the system (messages_update admits tenant-wide actors). Returns whether the body was replaced.
 */
export async function redactLinkInTx(tx: Tx, messageId: string): Promise<boolean> {
  const m = await sql<{ contact_id: string; status: string }>`
    SELECT contact_id, status FROM public.messages
     WHERE tenant_id = app.tenant_id() AND id = ${messageId} AND action_category = 'portal_login_link'`.execute(tx);
  const row = m.rows[0];
  if (!row || !FINAL.has(row.status)) return false;
  const f = await nameFacts(tx, row.contact_id);
  const line = redactedLinkBody({ brokerage: f?.brokerage ?? 'Your agent', name: f?.name ?? 'the client' });
  const r = await sql`
    UPDATE public.messages SET body = ${line}
     WHERE tenant_id = app.tenant_id() AND id = ${messageId} AND action_category = 'portal_login_link'
       AND status IN ('sent','delivered','failed','undelivered','bounced','blocked','canceled') AND body <> ${line}`.execute(tx);
  return Number(r.numAffectedRows ?? 0) > 0;
}

/**
 * portal.link_redact: final ⇒ redact; under 15 minutes ⇒ again in 60 s; at 15 minutes a link still queued or scheduled
 * is canceled PORTAL_LINK_EXPIRED and redacted; one dispatching or dispatch_unknown keeps its body until the reconcile
 * decides (checked again every minute; portal.sync's backstop catches any left behind).
 */
export async function linkRedactInTx(tx: Tx, messageId: string, now: Instant): Promise<{ retryAt: Instant } | void> {
  const r = await sql<{ contact_id: string; status: string; created_at: Date }>`
    SELECT contact_id, status, created_at FROM public.messages
     WHERE tenant_id = app.tenant_id() AND id = ${messageId} AND action_category = 'portal_login_link'`.execute(tx);
  const m = r.rows[0];
  if (!m) return;
  if (FINAL.has(m.status)) {
    await redactLinkInTx(tx, messageId);
    return;
  }
  const age = now - m.created_at.getTime();
  if (age < LINK_TTL_MS) return { retryAt: (now + LINK_REDACT_RETRY_MS) as Instant };
  if (m.status === 'queued' || m.status === 'scheduled') {
    await lockContact(tx, m.contact_id as ContactId);
    await markCanceled(tx, messageId, 'PORTAL_LINK_EXPIRED', null);
    await redactLinkInTx(tx, messageId);
    return;
  }
  if (age < 4 * LINK_TTL_MS) return { retryAt: (now + LINK_REDACT_RETRY_MS) as Instant };
}

/** portal.sync's backstop: final links older than 15 minutes redacted, queued ones canceled (ids of this tenant). */
export async function linkBackstopInTx(tx: Tx, limit: number): Promise<number> {
  const r = await sql<{ id: string; status: string; contact_id: string }>`
    SELECT id, status, contact_id FROM public.messages
     WHERE tenant_id = app.tenant_id() AND action_category = 'portal_login_link' AND direction = 'outbound'
       AND created_at < now() - interval '15 minutes'
       AND (status IN ('queued','scheduled') OR (status IN ('sent','delivered','failed','undelivered','bounced','blocked','canceled') AND body LIKE '%#token=%'))
     ORDER BY created_at LIMIT ${limit}`.execute(tx);
  let n = 0;
  for (const m of r.rows) {
    if (m.status === 'queued' || m.status === 'scheduled') {
      await lockContact(tx, m.contact_id as ContactId);
      await markCanceled(tx, m.id, 'PORTAL_LINK_EXPIRED', null);
    }
    if (await redactLinkInTx(tx, m.id)) n++;
  }
  return n;
}

export type { TenantId };
