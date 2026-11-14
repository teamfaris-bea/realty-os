// Invite a client to the portal (R-PORTAL-13; E690-E693). One transaction as the person, serialized on the contact
// (app.lock_contact: two taps make one account and one live grant): the visible deal or listing (else 404), the contact
// not merged away (CONTACT_MERGED), a deal that is not lost (else PORTAL_DEAL_LOST, resend included: portal.sync ends a
// lost deal's grant at once, so each tap made another grant and another note about a purchase the client could never
// see; b15 review L1), a party (else PORTAL_NOT_A_PARTY), the live account reused or created (login point:
// the one asked for, else the first active email, else the first active phone, else PORTAL_LOGIN_POINT_MISSING), the
// unrevoked, unexpired grant reused or created with its display copy, and a portal.sync pass enqueued.
//
// After commit, the invite NOTICE: the inviter's own message through composeHumanMessage (dispatch-gated, D1 opt-outs
// apply, a touch; with no open deal or recent inbound compose makes it marketing, and a marketing opt-out blocks it).
// No token in it. Nothing is sent while platform:portal is not cleared, and the answer says so (E693). A blocked
// notice returns its decision; the invite stands. A repeat invite (no new account or grant, no resend) answers from
// what became of the grant's earlier notes (b14 audit F7): sent ⇒ "already invited"; still on its way ⇒ says so; none
// sent by this inviter yet (an invite while the portal was off) ⇒ the note goes now; else ⇒ none reached them, Resend.
// A note this request did not send itself (the other of two taps at once, an unknown outcome) is answered from its
// status, never "not sent" while it is being sent (noticeFromNote; b14 F7 regression).
// VERIFY WITH COUNSEL (Q-PORTAL-7).
import type { ContactId, UserActor } from '@realty/core/foundation';
import { type Tx, lockContact } from '@realty/db';
import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { audit } from '../../audit.js';
import { composeHumanMessage } from '../../comms/compose.js';
import { refuseMergedAway } from '../../comms/merged.js';
import { detailVisibleContact } from '../../comms/repos/contacts.js';
import { asSystem, depsFromPlatform } from '../../comms/runtime.js';
import { AppError } from '../../errors.js';
import { platformOf } from '../../workspace/common.js';
import { enqueueTyped } from '../../worker/registry.js';
import { INVITE_EMAIL_SUBJECT, inviteBlocked, inviteBody, inviteNoNotice, inviteNoteInFlight, inviteNoteNotReached, inviteNotSent, inviteSent, portalSignInUrl, sentenceFor } from '../shared/copy.js';
import { PORTAL_SYNC_NOW } from '../sync/jobs.js';
import { cardFor, type PartyRole, titleAndScope } from './display.js';
import { portalClearedInTx, staffTx } from './common.js';
import { type AccountView, type GrantStaffView, accountViews, grantStaffViews } from './views.js';

export interface InviteInput {
  contactId: string;
  loginPointId?: string | undefined;
  title?: string | undefined;
  resend?: boolean | undefined;
  idempotencyKey: string;
}

interface Scope {
  kind: 'deal' | 'listing';
  id: string;
}

interface Invited {
  accountId: string;
  grantId: string;
  pointId: string;
  pointKind: 'email' | 'phone';
  createdAccount: boolean;
  createdGrant: boolean;
  first: string;
  scope: 'purchase' | 'sale';
  cleared: boolean;
  slug: string;
}

async function partyRole(tx: Tx, scope: Scope, contactId: string): Promise<{ role: PartyRole; side: string; agent: string | null; line1: string } | null> {
  if (scope.kind === 'deal') {
    const r = await sql<{ side: string; stage: string; owner: string | null; primary: string | null; role: string | null }>`
      SELECT d.side, d.stage, d.owner_user_id AS owner, d.primary_contact_id AS primary,
             (SELECT dc.role FROM deal_contacts dc WHERE dc.tenant_id = d.tenant_id AND dc.deal_id = d.id AND dc.contact_id = ${contactId}
                 AND dc.role IN ('buyer','seller','co_buyer','co_seller')) AS role
        FROM deals d WHERE d.tenant_id = app.tenant_id() AND d.id = ${scope.id}`.execute(tx);
    const d = r.rows[0];
    if (!d) throw new AppError('NOT_FOUND');
    if (d.stage === 'lost') throw new AppError('PORTAL_DEAL_LOST');
    const role = (d.role as PartyRole | null) ?? (d.primary === contactId ? 'primary' : null);
    return role ? { role, side: d.side, agent: d.owner, line1: '' } : null;
  }
  const r = await sql<{ agent: string | null; line1: string; role: string | null }>`
    SELECT l.listing_agent_user_id AS agent, l.address_line1 AS line1,
           (SELECT lc.role FROM listing_contacts lc WHERE lc.tenant_id = l.tenant_id AND lc.listing_id = l.id AND lc.contact_id = ${contactId}
               AND lc.role IN ('seller','co_seller')) AS role
      FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.id = ${scope.id} AND l.source = 'team'`.execute(tx);
  const l = r.rows[0];
  if (!l) throw new AppError('NOT_FOUND');
  return l.role ? { role: l.role as PartyRole, side: 'sell', agent: l.agent, line1: l.line1 } : null;
}

/** The login point: the one asked for (this contact's current, active email or phone), else the first active email, else phone. */
async function chooseLoginPoint(tx: Tx, contactId: string, asked: string | undefined): Promise<{ id: string; kind: 'email' | 'phone' } | null> {
  const r = await sql<{ id: string; kind: 'email' | 'phone' }>`
    SELECT id, kind FROM contact_points
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND kind IN ('email','phone') AND removed_at IS NULL AND status = 'active'
     ORDER BY CASE kind WHEN 'email' THEN 0 ELSE 1 END, created_at, id`.execute(tx);
  if (asked) return r.rows.find((p) => p.id === asked) ?? null;
  return r.rows[0] ?? null;
}

async function inviteInTx(tx: Tx, actor: UserActor, deps: { linkSecret: Uint8Array; publicBaseUrl: string }, scope: Scope, input: InviteInput): Promise<Invited> {
  const c = await detailVisibleContact(tx, input.contactId);
  if (!c) throw new AppError('NOT_FOUND');
  await refuseMergedAway(tx, c);
  await lockContact(tx, input.contactId as ContactId);
  const party = await partyRole(tx, scope, input.contactId);
  if (!party) throw new AppError('PORTAL_NOT_A_PARTY');

  let createdAccount = false;
  const live = await sql<{ id: string; login_point_id: string; kind: 'email' | 'phone' }>`
    SELECT a.id, a.login_point_id, p.kind FROM portal_accounts a JOIN contact_points p ON p.tenant_id = a.tenant_id AND p.id = a.login_point_id
     WHERE a.tenant_id = app.tenant_id() AND a.contact_id = ${input.contactId} AND a.status <> 'disabled'`.execute(tx);
  let account = live.rows[0] ? { id: live.rows[0].id, pointId: live.rows[0].login_point_id, kind: live.rows[0].kind } : null;
  if (!account) {
    const point = await chooseLoginPoint(tx, input.contactId, input.loginPointId);
    if (!point) throw new AppError('PORTAL_LOGIN_POINT_MISSING');
    const id = (await sql<{ id: string }>`SELECT gen_random_uuid() AS id`.execute(tx)).rows[0]!.id;
    await sql`INSERT INTO portal_accounts (tenant_id, id, contact_id, login_point_id, status, invited_by_user_id)
              VALUES (app.tenant_id(), ${id}, ${input.contactId}, ${point.id}, 'invited', ${actor.userId})`.execute(tx);
    account = { id, pointId: point.id, kind: point.kind };
    createdAccount = true;
  }

  const col = scope.kind === 'deal' ? sql`deal_id` : sql`listing_id`;
  const existing = await sql<{ id: string }>`
    SELECT id FROM portal_grants WHERE tenant_id = app.tenant_id() AND portal_account_id = ${account.id} AND ${col} = ${scope.id}
       AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) ORDER BY granted_at LIMIT 1`.execute(tx);
  let grantId = existing.rows[0]?.id ?? null;
  const ts = titleAndScope(scope.kind === 'deal' ? { kind: 'deal', side: party.side, role: party.role, title: input.title } : { kind: 'listing', line1: party.line1, title: input.title });
  let createdGrant = false;
  if (!grantId) {
    grantId = (await sql<{ id: string }>`SELECT gen_random_uuid() AS id`.execute(tx)).rows[0]!.id;
    const card = await cardFor(tx, deps, actor.tenantId, input.contactId, party.agent);
    const display = { title: ts.title, scope: ts.scope, ...card };
    await sql`INSERT INTO portal_grants (tenant_id, id, portal_account_id, deal_id, listing_id, granted_by_user_id, granted_at, display)
              VALUES (app.tenant_id(), ${grantId}, ${account.id}, ${scope.kind === 'deal' ? scope.id : null}, ${scope.kind === 'listing' ? scope.id : null},
                      ${actor.userId}, now(), ${JSON.stringify(display)}::jsonb)`.execute(tx);
    createdGrant = true;
    await audit(tx, actor, { action: 'portal.granted', entity: { type: 'portal_grant', id: grantId } });
  }
  if (createdAccount || createdGrant) await audit(tx, actor, { action: 'portal.invited', entity: { type: 'portal_account', id: account.id } });
  if (createdGrant) await enqueueTyped(tx, PORTAL_SYNC_NOW, {}, { dedupeKey: 'portal.sync:invite' });
  const slug = (await sql<{ slug: string }>`SELECT slug FROM tenants WHERE id = app.tenant_id()`.execute(tx)).rows[0]?.slug ?? '';
  return {
    accountId: account.id,
    grantId,
    pointId: account.pointId,
    pointKind: account.kind,
    createdAccount,
    createdGrant,
    first: (c.firstName ?? '').trim() || c.displayName,
    scope: ts.scope === 'purchase' ? 'purchase' : 'sale',
    cleared: await portalClearedInTx(tx),
    slug,
  };
}

export interface InviteResult {
  account: AccountView;
  grant: GrantStaffView;
  created: { account: boolean; grant: boolean };
  notice: { sent: boolean; text: string; channel: 'sms' | 'email' | null; decision: { outcome: string; reasons: string[]; explanation: string } | null };
}

type NoticeDecision = InviteResult['notice']['decision'];

/**
 * The answer when this request did not send the note itself (b14 F7 regression). Mostly the second of two taps at once:
 * it read priorNotices before the first tap's note existed, and compose returned that note (same key, result noop).
 * Also a note whose own send ended unknown or failed. It answers from the note's status: sent or delivered ⇒ already
 * invited, nothing more sent; queued, scheduled, dispatching or dispatch_unknown ⇒ still on its way; blocked with its
 * stored decision ⇒ not sent, with the reason; anything else (failed, undelivered, bounced, canceled, a block with no
 * stored decision) ⇒ none reached them, Resend. Never "not sent" while the note is being sent.
 */
export function noticeFromNote(first: string, channel: 'sms' | 'email', status: string, decision: NoticeDecision): InviteResult['notice'] {
  if (status === 'sent' || status === 'delivered') return { sent: false, text: inviteNoNotice(first), channel: null, decision: null };
  if (['queued', 'scheduled', 'dispatching', 'dispatch_unknown'].includes(status)) return { sent: false, text: inviteNoteInFlight(first), channel: null, decision: null };
  if (status === 'blocked' && decision !== null) return { sent: false, text: inviteBlocked(first), channel, decision };
  return { sent: false, text: inviteNoteNotReached(first), channel: null, decision: null };
}

/**
 * What became of the invite notes of a grant (b14 audit F7), read as the system (statuses only, any inviter's): a repeat
 * invite says a note was sent only when one was; a note still on its way is said to be; a grant none of whose notes
 * arrived gets its note now when this inviter's key is still unused, else is told so and offered Resend.
 */
async function priorNotices(tx: Tx, grantId: string, inviterId: string, contactId: string): Promise<{ sent: boolean; inFlight: boolean; mineUsed: boolean }> {
  // b14: anchored by the invitee (every invite note goes to them; messages has contact indexes), so the key pattern only
  // filters that person's outbound messages, never a scan of the tenant's, and a key on someone else's message never counts
  const r = await sql<{ status: string; mine: boolean }>`
    SELECT status, idempotency_key = ${`h:${inviterId}:portal_invite:${grantId}`} AS mine FROM public.messages
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND direction = 'outbound'
       AND idempotency_key ~ ${`^h:[0-9a-f-]{36}:portal_invite:${grantId}(:|$)`}`.execute(tx);
  return {
    sent: r.rows.some((m) => m.status === 'sent' || m.status === 'delivered'),
    inFlight: r.rows.some((m) => ['queued', 'scheduled', 'dispatching', 'dispatch_unknown'].includes(m.status)),
    mineUsed: r.rows.some((m) => m.mine),
  };
}

export async function invite(req: FastifyRequest, scope: Scope, input: InviteInput): Promise<InviteResult> {
  const p = platformOf(req);
  const deps = depsFromPlatform(p);
  const r = await staffTx(req, (tx, actor) => inviteInTx(tx, actor, { linkSecret: deps.linkSecret, publicBaseUrl: deps.publicBaseUrl }, scope, input));
  const channel = r.pointKind === 'email' ? 'email' : 'sms';
  let notice: InviteResult['notice'] | null = null;
  if (!r.cleared) notice = { sent: false, text: inviteNotSent(r.first), channel: null, decision: null };
  else if (!r.createdGrant && !r.createdAccount && input.resend !== true) {
    // b14 audit F7: never "no second note" when no first note went (an invite while the portal was off, a blocked note)
    const prior = await asSystem(deps, req.actor!.tenantId, 'worker', (tx) => priorNotices(tx, r.grantId, req.actor!.userId, input.contactId));
    if (prior.sent) notice = { sent: false, text: inviteNoNotice(r.first), channel: null, decision: null };
    else if (prior.inFlight) notice = { sent: false, text: inviteNoteInFlight(r.first), channel: null, decision: null };
    else if (prior.mineUsed) notice = { sent: false, text: inviteNoteNotReached(r.first), channel: null, decision: null };
    // else: no note of this inviter for the grant yet, so its key is unused: the note goes now (below)
  }
  if (notice === null) {
    const actorName = (await staffTx(req, (tx, actor) => sql<{ n: string }>`SELECT display_name AS n FROM users WHERE id = ${actor.userId}`.execute(tx))).rows[0]?.n ?? 'Your agent';
    const body = inviteBody({ agent: actorName, scope: r.scope, url: portalSignInUrl(p.config.webOrigins[0]!, r.slug), kind: r.pointKind });
    try {
      const sent = await composeHumanMessage(req.actor!, input.contactId, {
        channel,
        body,
        ...(channel === 'email' ? { subject: INVITE_EMAIL_SUBJECT(r.scope) } : {}),
        idempotencyKey: input.resend === true ? `portal_invite:${r.grantId}:${input.idempotencyKey}` : `portal_invite:${r.grantId}`,
        toPointId: r.pointId,
      }, deps);
      const d = sent.decision;
      const decision: NoticeDecision = d ? { outcome: d.outcome, reasons: d.reasons, explanation: d.explanation } : null;
      if (sent.result === 'sent') notice = { sent: true, text: inviteSent(r.first, r.pointKind), channel, decision: null };
      // b14 F7 regression: the note as it stands answers (another tap's note under the same key, a send whose outcome
      // is unknown, a block with its decision), never "not sent" while it is being sent
      else if (sent.message) notice = noticeFromNote(r.first, channel, sent.message.status, decision);
      else notice = { sent: false, text: inviteBlocked(r.first), channel, decision };   // refused before a note was made
    } catch (e) {
      const code = e instanceof AppError ? e.code : 'INTERNAL_ERROR';
      if (!(e instanceof AppError)) req.log.error({ code: 'PORTAL_INVITE_NOTICE' }, 'portal: the invite notice failed');
      notice = { sent: false, text: `${inviteBlocked(r.first)} ${sentenceFor(code)}`, channel, decision: null };
    }
  }
  const views = await staffTx(req, async (tx) => ({ accounts: await accountViews(tx, [r.accountId]), grants: await grantStaffViews(tx, [r.grantId]) }));
  return { account: views.accounts[0]!, grant: views.grants[0]!, created: { account: r.createdAccount, grant: r.createdGrant }, notice: notice! };
}
