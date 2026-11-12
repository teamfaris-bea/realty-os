// Open-house invites (module 29; DATA_MODEL R-MKT-8, R-PAR-12, D1; E94, E152).
//
// POST /marketing-pieces/:id/invite/send {recipientContactIds}: from an APPROVED (or published) open-house invite only,
// one email per recipient, each through the one human send path (comms/compose.ts composeHumanMessage → dispatchOutbound,
// owned by module 22): canContact at send time and the DB dispatch guard decide every message; the guard also refuses
// any invite whose piece is not an approved invite version (MARKETING_PIECE_NOT_APPROVED). There is no bulk exemption
// and no override: an opted-out, unsubscribed, do-not-contact or suppressed recipient is blocked and counted on the
// send ("Sent 41 of 45; 4 opted out"), and raises no failed_send exception (module 18a excludes marketing_piece_id rows).
// A recipient without an email address is skipped and counted. The same recipient is never sent the same version twice
// (idempotency key per piece and contact). An invite is never a touch (b7 sends/F1, R-OWN-14): dispatch records no
// first contact for a marketing_piece_id row and no scoreboard or waiting-client check counts one. A merged-away
// recipient (b7 sends/F5, R-OWN-24) is not sent to (the person lives on the survivor) and is reported as such: outcome
// 'merged', "merged into <name>" when the caller sees the survivor, and counted on its own in the summary.
import { inviteSendSummary, renderPiece } from '@realty/core/marketing';
import type { UserActor } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactSnapshot } from '../audit.js';
import { composeHumanMessage } from '../comms/compose.js';
import { visibleSurvivorOf } from '../comms/repos/contacts.js';
import type { CommsDeps } from '../comms/types.js';
import { AppError } from '../errors.js';
import { assertLivePasses } from './pieces.js';
import * as repo from './repo.js';

export const MAX_INVITE_RECIPIENTS = 1000;
const CONCURRENCY = 4;

/** The send-time check's and the DB guard's reasons that mean the person said no (D1 opt-outs; counted as "opted out"). */
const OPT_OUT_REASONS: ReadonlySet<string> = new Set(['CONSENT_REVOKED', 'PERSON_DO_NOT_CONTACT', 'SUPPRESSED', 'RECIPIENT_OPTED_OUT', 'RECIPIENT_SUPPRESSED']);

export interface InviteSendResult {
  sent: number;
  total: number;
  optedOut: number;
  blocked: number;
  noEmail: number;
  text: string;
  alreadyInvited: number;
  merged: number;
  recipients: {
    contactId: string;
    outcome: 'sent' | 'opted_out' | 'blocked' | 'no_email' | 'already_invited' | 'merged';
    messageId: string | null;
    mergedInto?: { contactId: string; name: string } | null;
  }[];
}

/** Where a merged-away record's person lives now, when the caller's RLS shows it (R-PERM-5); null otherwise. */
async function mergedIntoOf(deps: CommsDeps, actor: UserActor, contactId: string): Promise<{ contactId: string; name: string } | null> {
  return withTenantTx(
    actor,
    async (tx) => {
      const id = await visibleSurvivorOf(tx, contactId);
      if (!id) return null;
      const r = await sql<{ display_name: string }>`SELECT display_name FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
      return r.rows[0] ? { contactId: id, name: r.rows[0].display_name } : null;
    },
    { db: deps.db },
  );
}

function isOptOut(reasons: readonly string[] | undefined, statusReason: string | null | undefined): boolean {
  return [...(reasons ?? []), ...(statusReason ? [statusReason] : [])].some((r) => OPT_OUT_REASONS.has(r));
}

export async function sendInvites(deps: CommsDeps, actor: UserActor, pieceId: string, recipientContactIds: readonly string[]): Promise<InviteSendResult> {
  const unique = [...new Set(recipientContactIds)];
  if (unique.length === 0) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/recipientContactIds', code: 'empty' }] });
  if (unique.length > MAX_INVITE_RECIPIENTS) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/recipientContactIds', code: 'too_many' }] });
  const prep = await withTenantTx(
    actor,
    async (tx) => {
      const p = await repo.pieceById(tx, pieceId);
      if (!p) throw new AppError('NOT_FOUND');
      if (p.kind !== 'open_house_invite') throw new AppError('MARKETING_NOT_INVITE');
      if (p.status !== 'approved' && p.status !== 'published') throw new AppError('MARKETING_PIECE_NOT_APPROVED');
      const writable = await sql<{ ok: boolean }>`SELECT app.listing_writable(app.tenant_id(), ${p.listing_id}) AS ok`.execute(tx);
      if (writable.rows[0]?.ok !== true) throw new AppError('NOT_FOUND');
      const [assets, facts, identity] = await Promise.all([repo.assetsOf(tx, pieceId), repo.listingFacts(tx, p.listing_id), repo.identityOf(tx)]);
      if (!facts) throw new AppError('NOT_FOUND');
      if (['sold', 'withdrawn', 'expired'].includes(facts.status)) throw new AppError('LISTING_OFF_MARKET');
      const advertising = await repo.advertisingPacks(tx, identity.jurisdictions);
      const r = renderPiece(repo.versionOf(p, assets), facts, identity, { advertising });
      if (!r.ok) throw new AppError('MARKETING_GUARD_FAILED');
      await assertLivePasses(tx, p);
      const subject = String((p.prose as { subject?: unknown }).subject ?? 'Open house').slice(0, 300);
      // which recipients have an email the caller can see (RLS: only contacts they may see; others count as no email)
      const withEmail = await sql<{ contact_id: string }>`SELECT DISTINCT cp.contact_id FROM contact_points cp
         WHERE cp.tenant_id = app.tenant_id() AND cp.contact_id = ANY (${unique}::uuid[]) AND cp.kind = 'email' AND cp.removed_at IS NULL`.execute(tx);
      // b7 sends/F5: merged-away records are never sent to; they get their own outcome below
      const merged = await sql<{ id: string }>`SELECT id FROM contacts WHERE tenant_id = app.tenant_id() AND id = ANY (${unique}::uuid[]) AND merged_into_contact_id IS NOT NULL`.execute(tx);
      // one invite per recipient and version, whoever on the team sends it (the send path's idempotency key is per sender)
      const already = await sql<{ contact_id: string }>`SELECT DISTINCT contact_id FROM messages WHERE tenant_id = app.tenant_id() AND marketing_piece_id = ${pieceId}
         AND contact_id = ANY (${unique}::uuid[]) AND status NOT IN ('canceled','blocked','failed','undelivered','bounced')`.execute(tx);
      const mergedIds = new Set(merged.rows.map((x) => x.id));
      return {
        subject,
        body: r.text,
        withEmail: new Set(withEmail.rows.map((x) => x.contact_id).filter((x) => !mergedIds.has(x))),
        merged: mergedIds,
        already: new Set(already.rows.map((x) => x.contact_id)),
      };
    },
    { db: deps.db },
  );

  const recipients: InviteSendResult['recipients'] = [];
  const queue = [...unique];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (prep.merged.has(id)) {
        recipients.push({ contactId: id, outcome: 'merged', messageId: null, mergedInto: await mergedIntoOf(deps, actor, id) });
        continue;
      }
      if (prep.already.has(id)) {
        recipients.push({ contactId: id, outcome: 'already_invited', messageId: null });
        continue;
      }
      if (!prep.withEmail.has(id)) {
        recipients.push({ contactId: id, outcome: 'no_email', messageId: null });
        continue;
      }
      try {
        const out = await composeHumanMessage(actor, id, { channel: 'email', subject: prep.subject, body: prep.body, idempotencyKey: `invite:${pieceId}:${id}`, purposeOverride: 'marketing', marketingPieceId: pieceId }, deps);
        const status = out.message?.status ?? null;
        if (status && ['sent', 'delivered', 'dispatching'].includes(status)) recipients.push({ contactId: id, outcome: 'sent', messageId: out.message!.id });
        else if (isOptOut(out.decision?.reasons, out.message?.statusReason)) recipients.push({ contactId: id, outcome: 'opted_out', messageId: out.message?.id ?? null });
        else recipients.push({ contactId: id, outcome: 'blocked', messageId: out.message?.id ?? null });
      } catch (e) {
        if (e instanceof AppError && e.code === 'CONTACT_MERGED') recipients.push({ contactId: id, outcome: 'merged', messageId: null, mergedInto: await mergedIntoOf(deps, actor, id) });
        else if (e instanceof AppError && (e.code === 'NOT_FOUND' || e.code === 'CONTACT_POINT_MISSING')) recipients.push({ contactId: id, outcome: 'no_email', messageId: null });
        else if ((e instanceof AppError && e.code === 'MARKETING_PIECE_NOT_APPROVED') || (e instanceof Error && e.message.startsWith('MARKETING_PIECE_NOT_APPROVED'))) throw new AppError('MARKETING_PIECE_NOT_APPROVED');
        else recipients.push({ contactId: id, outcome: 'blocked', messageId: null });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
  const alreadyInvited = recipients.filter((r) => r.outcome === 'already_invited').length;
  const counted = recipients.filter((r) => r.outcome !== 'no_email' && r.outcome !== 'already_invited' && r.outcome !== 'merged').map((r) => ({ outcome: r.outcome as 'sent' | 'opted_out' | 'blocked' }));
  const s = inviteSendSummary(counted);
  const noEmail = recipients.filter((r) => r.outcome === 'no_email').length;
  const merged = recipients.filter((r) => r.outcome === 'merged').length;
  // core's words ("Sent 41 of 45; 4 opted out"); recipients without an email address and merged-away records count in the total too
  let text = noEmail + merged > 0 ? s.text.replace(/^Sent (\d+) of \d+/, `Sent $1 of ${s.total + noEmail + merged}`) : s.text;
  if (noEmail > 0) text = `${text}; ${noEmail} without an email address`;
  if (merged > 0) text = `${text}; ${merged} merged into another record (invite the record they were merged into)`;
  if (alreadyInvited > 0) text = `${text}; ${alreadyInvited} already invited earlier`;
  await withTenantTx(actor, (tx) => audit(tx, actor, { action: 'marketing.invites_sent', entity: { type: 'marketing_piece', id: pieceId }, changes: redactSnapshot({ sent: s.sent, total: s.total, opted_out: s.optedOut, blocked: s.blocked, no_email: noEmail }), reason: 'SENT' }), { db: deps.db });
  return { sent: s.sent, total: s.total + noEmail + merged, optedOut: s.optedOut, blocked: s.blocked, noEmail, merged, alreadyInvited, text, recipients };
}
