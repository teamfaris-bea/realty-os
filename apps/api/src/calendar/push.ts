// calendar.push (module 34; R-CAL-2, R-CAL-4, R-INT-5; E102, E103). One appointment, the system actor, one
// transaction:
//   1. the appointment's push lock (pushes of one appointment never overlap), then a fresh read
//   2. nothing to do when it is detached (E103: never touched again), already pushed at this version (the
//      fence), or its person has no live calendar (R-CAL-4: sync stopped, in-app unaffected)
//   3. the person was removed ⇒ their link is revoked and purged (R-INT-5); suspended ⇒ sync pauses, link kept
//   4. the token is decrypted and refreshed lazily (tokens.ts); a refused grant revokes and purges the link (E102)
//   5. the push is conditional on the stored etag: an event edited or deleted in the calendar comes back
//      `detached` and the appointment is detached, never overwritten (E103)
//   6. the accepted version is recorded only if it is newer than what was recorded (recordPushed)
// A transient provider failure retries (the job's attempts); on the last attempt the link is marked degraded
// and the appointment's sync `failed`, both in words on the settings page.
import type { SystemActor, TenantId } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import type { EnvelopeService } from '../crypto/envelope.js';
import type { CalendarEvent, IntegrationAdapters } from '../providers/integrations/types.js';
import { audit, redactSnapshot } from '../audit.js';
import { CALENDAR_SERVICES, refProvider } from './catalog.js';
import { enqueuePendingPushes } from './hooks.js';
import * as repo from './repos/links.js';
import { revokeLinkAsSystem } from './service.js';
import { GrantRevokedError, liveAuth, tokenForRevoke, withAuth } from './tokens.js';

export type PushOutcome = 'missing' | 'detached_already' | 'up_to_date' | 'no_calendar' | 'member_removed' | 'member_inactive' | 'not_pushable' | 'grant_revoked' | 'pushed' | 'stale' | 'detached' | 'failed';

const KIND_LABEL: Record<repo.PushRow['kind'], string> = { buyer_consult: 'Buyer consult', listing_appointment: 'Listing appointment', consult: 'Consult', other: 'Appointment' };

/** The event title, reduced to the tenant's calendar_title_detail: "Buyer consult · Jane D." or just "Buyer consult". */
export function eventTitle(kind: repo.PushRow['kind'], contactName: string | null, detail: repo.PushRow['title_detail']): string {
  const label = KIND_LABEL[kind];
  if (detail === 'none' || !contactName) return label;
  const parts = contactName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return label;
  const first = parts[0]!;
  const last = parts.length > 1 ? ` ${[...parts.at(-1)!][0]!.toUpperCase()}.` : '';
  return `${label} · ${first}${last}`;
}

export interface PushDeps {
  envelope: EnvelopeService;
  adapters: IntegrationAdapters;
  now: () => number;
}

export async function pushAppointment(deps: PushDeps, tx: Tx, actor: SystemActor, appointmentId: string, o: { lastAttempt: boolean }): Promise<PushOutcome> {
  await repo.lockAppointmentPush(tx, appointmentId);
  const a = await repo.appointmentForPush(tx, appointmentId);
  if (!a) return 'missing';
  if (a.external_sync_status === 'detached') return 'detached_already';
  const v = a.sync_version;
  if (a.external_pushed_version !== null && a.external_pushed_version >= v) return 'up_to_date';
  const member = await repo.memberStatus(tx, a.user_id);
  if (member === 'removed') {
    for (const l of await repo.linksOfUser(tx, a.user_id)) await finishRemovalRevoke(deps, tx, actor, l);
    return 'member_removed';
  }
  // suspended, deactivating or invited: sync pauses, the link and its grant are kept (R-INT-5 is removal only)
  if (member !== 'active') return 'member_inactive';
  const link = await repo.liveLinkOf(tx, a.user_id);
  if (!link) return 'no_calendar';
  const svc = CALENDAR_SERVICES[link.provider];
  // an event pushed to another provider (the person switched calendars) is not this calendar's event
  const sameProvider = refProvider(a.external_event_ref) === svc.calendar;
  const eventRef = sameProvider ? a.external_event_ref!.slice(a.external_event_ref!.indexOf(':') + 1) : null;
  const cancelled = a.status === 'canceled' || a.status === 'rescheduled';
  // never CREATE an event for a canceled appointment or one that is already over
  if (eventRef === null && (cancelled || a.ends_at.getTime() <= a.now.getTime())) return 'not_pushable';

  const event: CalendarEvent = {
    appointmentId: a.id,
    startsAt: a.starts_at.toISOString(),
    endsAt: a.ends_at.toISOString(),
    title: eventTitle(a.kind, a.contact_name, a.title_detail),
    externalEventRef: eventRef,
    externalEtag: sameProvider ? a.external_etag : null,
    status: cancelled ? 'cancelled' : 'confirmed',
  };
  let result;
  try {
    const live = await liveAuth(deps, tx, actor.tenantId as TenantId, link);
    result = await withAuth(live, (auth) => deps.adapters.calendar[svc.calendar].pushEvent(auth, event, { syncVersion: v }));
  } catch (e) {
    if (e instanceof GrantRevokedError) {
      await revokeLinkAsSystem(tx, actor, link, 'GRANT_REVOKED');
      return 'grant_revoked';
    }
    if (!o.lastAttempt) throw e;
    await repo.markDegraded(tx, link.id, 'PUSH_FAILED');
    await repo.recordFailed(tx, a.id);
    return 'failed';
  }
  if (result.kind === 'detached') {
    await repo.recordDetached(tx, a.id);
    await repo.markSynced(tx, link.id);
    if (link.status === 'degraded') await enqueuePendingPushes(tx, a.user_id);
    return 'detached';
  }
  if (result.kind === 'stale') return 'stale';
  await repo.recordPushed(tx, a.id, { ref: `${svc.calendar}:${result.externalEventRef}`, etag: result.externalEtag, version: v });
  await repo.markSynced(tx, link.id);
  // back from `degraded`: the appointments whose pushes gave up while it was failing are pushed again
  if (link.status === 'degraded') await enqueuePendingPushes(tx, a.user_id);
  return 'pushed';
}

/**
 * R-INT-5 for a removed member: the token is decrypted (system actor) only to revoke the grant at the provider,
 * best effort; the link is revoked (if the 0050 trigger has not already) and its token purged in this transaction.
 */
async function finishRemovalRevoke(deps: PushDeps, tx: Tx, actor: SystemActor, l: Pick<repo.LinkRow, 'id' | 'provider'>): Promise<void> {
  const token = await tokenForRevoke(deps.envelope, tx, actor.tenantId as TenantId, l.id);
  const revoked = await repo.revokeAndPurge(tx, l.id, 'MEMBER_REMOVED');
  const purged = revoked === 0 ? await repo.purgeRevokedTokens(tx, l.id) : 0;
  if (revoked === 0 && purged === 0) return;
  await audit(tx, actor, { action: 'calendar.link_revoked', entity: { type: 'user_calendar_link', id: l.id }, changes: redactSnapshot({ status: 'revoked', provider: l.provider, token_purged: true }), reason: 'MEMBER_REMOVED' });
  if (!token) return;
  try {
    await deps.adapters.oauth[CALENDAR_SERVICES[l.provider].oauth].revoke(token);
  } catch {
    // best effort: the token is purged locally already
  }
}

/** calendar.reconcile: R-INT-5 for people removed while no push ran for them. */
export async function reconcileLinks(deps: PushDeps, tx: Tx, actor: SystemActor): Promise<number> {
  const rows = await repo.linksToFinishRevoking(tx);
  for (const l of rows) await finishRemovalRevoke(deps, tx, actor, l);
  return rows.length;
}

