// api/calendar service (PHASE2_3_PLAN §5.4 #34; R-CAL-1..4, R-INT-4, R-INT-5; E102, E103, E151).
//
//   calendarView    the person's own links in plain words (connected, needs reconnect, not configured), what
//                   syncs, and their detached appointments (E103). Self only: no input names another person.
//   startConnect    OAuth start for the signed-in person: minimal scopes, PKCE, a signed state bound to them
//   connectCallback the provider redirect. The SAME signed-in person must finish it (the state names them);
//                   the code is exchanged, the granted scopes must be exactly the requested ones, and the token
//                   is encrypted and stored by the system actor (R-INT-4). At most one live calendar per person.
//   disconnect      revoked AND purged locally in one transaction, then revoked at the provider (best effort)
//   busy            live free/busy (R-CAL-3): read per request, never stored
//   bookSlot        booking under the person's advisory lock (E151): re-reads in-app appointments and live
//                   free/busy after taking the lock; a taken slot returns the next free one instead
import type { IdGenerator, TenantId, UserActor } from '@realty/core/foundation';
import { type Database, type Tx, withTenantTx } from '@realty/db';
import { randomBytes } from 'node:crypto';
import { audit, redactDiff, redactSnapshot } from '../audit.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { AppError } from '../errors.js';
import type { Busy, IntegrationAdapters, OAuthToken } from '../providers/integrations/types.js';
import { systemActor } from '../worker/systemActor.js';
import { CALENDAR_PROVIDER_KEYS, CALENDAR_SERVICES, type CalendarProviderKey, type CalendarService, type LinkState, PRIVACY_SENTENCE, SYNC_SENTENCE, calendarService, detachedSentence, linkSentence, shortOfRef } from './catalog.js';
import { enqueueCalendarPushLocked, enqueuePendingPushes } from './hooks.js';
import { CALENDAR_STATE_TTL_MS, type CalendarOAuthState, calendarPkceVerifier, pkceChallenge, signCalendarState, verifyCalendarState } from './oauthState.js';
import * as repo from './repos/links.js';
import { GrantRevokedError, liveAuth, sealToken, tokenForRevoke, withAuth } from './tokens.js';

export interface CalendarDeps {
  db: Database;
  envelope: EnvelopeService;
  ids: IdGenerator;
  adapters: IntegrationAdapters;
  /** server secret for the state MAC and the PKCE derivation */
  secret: Uint8Array;
  publicBaseUrl: string;
  webOrigin: string;
  now: () => number;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const sys = (tenantId: string) => systemActor(tenantId, 'provider');

// ---- view -------------------------------------------------------------------------------------------------

export interface ProviderView {
  provider: CalendarProviderKey;
  name: string;
  state: LinkState;
  sentence: string;
  canConnect: boolean;
  canDisconnect: boolean;
  /** why Connect is not offered while another calendar is connected (null otherwise) */
  blockedSentence: string | null;
  lastSyncedAt: string | null;
}

export interface CalendarView {
  adapterMode: 'fake' | 'unconfigured' | 'real';
  syncSentence: string;
  privacySentence: string;
  providers: ProviderView[];
  detached: { appointmentId: string; kind: string; startsAt: string; sentence: string }[];
}

export function stateOf(link: repo.LinkRow | undefined, configured: boolean): LinkState {
  if (link?.status === 'connected') return 'connected';
  if (link?.status === 'pending_review') return 'pending'; // its own waiting state (batch 7 review ui/F3)
  if (link?.status === 'degraded') return 'degraded';
  if (link?.status === 'revoked' && link.last_error_code === 'GRANT_REVOKED') return configured ? 'needs_reconnect' : 'not_configured';
  return configured ? 'not_connected' : 'not_configured';
}

/** Self only: RLS shows the caller nothing but their own links (R-CAL-1); `actor.userId` is the session's. */
export async function calendarView(tx: Tx, actor: UserActor, adapters: IntegrationAdapters): Promise<CalendarView> {
  const links = await repo.linksOfUser(tx, actor.userId);
  const live = links.find((l) => l.status === 'connected' || l.status === 'degraded' || l.status === 'pending_review');
  const providers = CALENDAR_PROVIDER_KEYS.map((key): ProviderView => {
    const svc = CALENDAR_SERVICES[key];
    const link = links.find((l) => l.provider === key);
    const configured = adapters.oauth[svc.oauth].configured;
    const state = stateOf(link, configured);
    const isLive = state === 'connected' || state === 'degraded' || state === 'pending';
    const other = live && live.provider !== key ? CALENDAR_SERVICES[live.provider] : null;
    return {
      provider: key,
      name: svc.name,
      state,
      sentence: linkSentence(svc, state, adapters.mode),
      canConnect: configured && !isLive && !other,
      canDisconnect: isLive || state === 'needs_reconnect',
      blockedSentence: other && !isLive ? `Disconnect ${other.name} first to use ${svc.name} instead. Realty OS adds appointments to one calendar.` : null,
      lastSyncedAt: iso(link?.last_synced_at ?? null),
    };
  });
  const detached = (await repo.detachedOf(tx, actor.userId)).map((d) => ({ appointmentId: d.id, kind: d.kind, startsAt: d.starts_at.toISOString(), sentence: detachedSentence(shortOfRef(d.external_event_ref)) }));
  return { adapterMode: adapters.mode, syncSentence: SYNC_SENTENCE, privacySentence: PRIVACY_SENTENCE, providers, detached };
}

// ---- connect ----------------------------------------------------------------------------------------------

export function calendarRedirectUri(publicBaseUrl: string, provider: CalendarProviderKey): string {
  return new URL(`/api/me/calendar/${provider}/callback`, publicBaseUrl).toString();
}

function serviceOrThrow(provider: string): CalendarService {
  const s = calendarService(provider);
  if (!s) throw new AppError('NOT_FOUND');
  return s;
}

export async function startConnect(deps: CalendarDeps, tx: Tx, actor: UserActor, provider: string): Promise<{ authorizeUrl: string; expiresAt: string }> {
  const svc = serviceOrThrow(provider);
  const connector = deps.adapters.oauth[svc.oauth];
  if (!connector.configured) throw new AppError('INTEGRATION_NOT_CONFIGURED', { provider: svc.key });
  const links = await repo.linksOfUser(tx, actor.userId);
  if (links.some((l) => l.status === 'connected' || l.status === 'degraded' || l.status === 'pending_review')) throw new AppError('CALENDAR_ALREADY_CONNECTED');
  const link = links.find((l) => l.provider === svc.key);
  const expiresAt = deps.now() + CALENDAR_STATE_TTL_MS;
  const state: CalendarOAuthState = { tenantId: actor.tenantId, userId: actor.userId, provider: svc.key, fence: link?.fence ?? '0', expiresAt, nonce: randomBytes(16).toString('base64url') };
  const authorizeUrl = connector.authorizeUrl({
    // no tenant connection kind: a calendar is the person's own. VERIFY: the real adapter sends
    // access_type=offline / prompt=consent (Google) so a refresh token is issued.
    state: signCalendarState(deps.secret, state),
    codeChallenge: pkceChallenge(calendarPkceVerifier(deps.secret, state)),
    redirectUri: calendarRedirectUri(deps.publicBaseUrl, svc.key),
    scopes: svc.scopes,
  });
  return { authorizeUrl, expiresAt: new Date(expiresAt).toISOString() };
}

export type CalendarCallbackOutcome =
  | 'CONNECTED'
  | 'CANCELLED'
  | 'STATE_INVALID'
  | 'STATE_EXPIRED'
  | 'STATE_STALE'
  | 'NOT_CONFIGURED'
  | 'ALREADY_CONNECTED'
  | 'PROVIDER_REFUSED'
  | 'SCOPE_MISMATCH';

export interface CalendarCallbackResult {
  outcome: CalendarCallbackOutcome;
  location: string;
}

function landing(deps: CalendarDeps, outcome: CalendarCallbackOutcome, provider: string | null): CalendarCallbackResult {
  const u = new URL('/settings/calendar', deps.webOrigin);
  u.searchParams.set('result', outcome);
  if (provider) u.searchParams.set('provider', provider);
  return { outcome, location: u.toString() };
}

/** The person granted exactly the scopes requested: nothing missing, nothing wider (minimal scopes). */
export function scopesExact(requested: readonly string[], granted: readonly string[]): boolean {
  const a = [...new Set(requested)].sort();
  const b = [...new Set(granted)].sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

async function revokeQuietly(deps: CalendarDeps, svc: CalendarService, token: OAuthToken): Promise<void> {
  try {
    await deps.adapters.oauth[svc.oauth].revoke(token);
  } catch {
    // best effort (R-INT-5): the token is not stored
  }
}

type Pre = { ok: true; link: repo.LinkRow | null } | { ok: false; outcome: CalendarCallbackOutcome };

async function precheck(tx: Tx, st: CalendarOAuthState, forUpdate: boolean): Promise<Pre> {
  if (!(await repo.memberActive(tx, st.userId))) return { ok: false, outcome: 'STATE_INVALID' };
  const link = await repo.linkOf(tx, st.userId, st.provider, { forUpdate });
  if ((link?.fence ?? '0') !== st.fence) return { ok: false, outcome: 'STATE_STALE' };
  const live = await repo.liveLinkOf(tx, st.userId);
  if (live) return { ok: false, outcome: 'ALREADY_CONNECTED' };
  return { ok: true, link };
}

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === '23505';
}

/**
 * The provider redirect. `session` is the signed-in person (the route is 'self'): the verified state must name
 * that same person in that same tenant, so a link can never be finished in someone else's session.
 */
export async function connectCallback(deps: CalendarDeps, session: UserActor, providerParam: string, q: { state?: string | undefined; code?: string | undefined; error?: string | undefined }): Promise<CalendarCallbackResult> {
  const v = verifyCalendarState(deps.secret, q.state ?? '', deps.now());
  if (!v.ok) return landing(deps, v.code, null);
  const st = v.state;
  if (st.provider !== providerParam || st.tenantId !== session.tenantId || st.userId !== session.userId) return landing(deps, 'STATE_INVALID', null);
  const svc = CALENDAR_SERVICES[st.provider];
  const connector = deps.adapters.oauth[svc.oauth];
  if (!connector.configured) return landing(deps, 'NOT_CONFIGURED', svc.key);
  if (q.error !== undefined || !q.code) return landing(deps, 'CANCELLED', svc.key);
  const actor = sys(st.tenantId);
  const pre = await withTenantTx(actor, (tx) => precheck(tx, st, false), { db: deps.db, retries: 2 });
  if (!pre.ok) return landing(deps, pre.outcome, svc.key);

  // Outside any transaction: the provider exchange.
  let token: OAuthToken;
  try {
    token = await connector.exchangeCode({ code: q.code, codeVerifier: calendarPkceVerifier(deps.secret, st), redirectUri: calendarRedirectUri(deps.publicBaseUrl, svc.key) });
  } catch {
    return landing(deps, 'PROVIDER_REFUSED', svc.key);
  }
  if (!scopesExact(svc.scopes, token.scopes)) {
    await revokeQuietly(deps, svc, token);
    return landing(deps, 'SCOPE_MISMATCH', svc.key);
  }

  let outcome: CalendarCallbackOutcome;
  try {
    outcome = await withTenantTx(
      actor,
      async (tx) => {
        const again = await precheck(tx, st, true);
        if (!again.ok) return again.outcome;
        const id = again.link?.id ?? deps.ids.next<'UserCalendarLinkId'>();
        const sealed = await sealToken(deps.envelope, tx, actor.tenantId, id, token);
        const fields = { scopes: [...svc.scopes], accessEnc: sealed.accessEnc, refreshEnc: sealed.refreshEnc, keyVersion: sealed.keyVersion, calendarRef: svc.calendarRef };
        if (again.link) await repo.reconnect(tx, id, fields);
        else await repo.insertConnected(tx, { id, userId: st.userId, provider: svc.key, ...fields });
        // edits made while no calendar was connected (or while it needed a reconnect) reach the calendar now
        await enqueuePendingPushes(tx, st.userId);
        await audit(tx, actor, {
          action: 'calendar.connected',
          entity: { type: 'user_calendar_link', id },
          changes: redactDiff({ status: again.link?.status ?? null }, { status: 'connected', provider: svc.key, scopes: [...svc.scopes], user_id: st.userId }),
          reason: 'PERSON_APPROVED_AT_PROVIDER',
        });
        return 'CONNECTED' as const;
      },
      { db: deps.db, retries: 2 },
    );
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    outcome = 'STATE_STALE'; // a concurrent callback of the same flow linked first
  }
  if (outcome !== 'CONNECTED') await revokeQuietly(deps, svc, token);
  return landing(deps, outcome, svc.key);
}

// ---- disconnect (R-INT-5, R-CAL-4) --------------------------------------------------------------------------

/**
 * The person disconnects their own calendar. The token is decrypted by the system actor (R-INT-4) only to revoke
 * the grant at the provider; the link is revoked AND purged in the person's transaction, with the audit; the
 * provider revocation runs after the commit, best effort. Already pushed events stay in their calendar; in-app
 * appointments are unaffected.
 */
export async function disconnect(deps: CalendarDeps, actor: UserActor, provider: string): Promise<void> {
  const svc = serviceOrThrow(provider);
  const token = await withTenantTx(
    sys(actor.tenantId),
    async (tx) => {
      const link = await repo.linkOf(tx, actor.userId, svc.key);
      if (!link || link.status === 'revoked') return null;
      return tokenForRevoke(deps.envelope, tx, actor.tenantId, link.id);
    },
    { db: deps.db, retries: 2 },
  );
  await withTenantTx(
    actor,
    async (tx) => {
      const link = await repo.linkOf(tx, actor.userId, svc.key, { forUpdate: true });
      if (!link) return;
      const needsReconnect = link.status === 'revoked' && link.last_error_code === 'GRANT_REVOKED';
      if (link.status === 'revoked' && !needsReconnect) return; // idempotent
      if (needsReconnect) {
        // "needs reconnect" → "not connected": the person dismissed it (the token was purged when it was revoked)
        await repo.clearRevokeCode(tx, link.id);
      } else {
        await repo.revokeAndPurge(tx, link.id, null);
      }
      await audit(tx, actor, {
        action: 'calendar.disconnected',
        entity: { type: 'user_calendar_link', id: link.id },
        changes: redactDiff({ status: link.status }, { status: 'revoked', provider: svc.key, token_purged: true }),
        reason: 'DISCONNECTED',
      });
    },
    { db: deps.db, retries: 2 },
  );
  if (token) await revokeQuietly(deps, svc, token);
}

/** E102 and member removal: revoked and purged as the system actor, audited with the reason code. */
export async function revokeLinkAsSystem(tx: Tx, actor: ReturnType<typeof sys>, link: Pick<repo.LinkRow, 'id' | 'provider'>, code: 'GRANT_REVOKED' | 'MEMBER_REMOVED'): Promise<void> {
  if ((await repo.revokeAndPurge(tx, link.id, code)) === 0) return;
  await audit(tx, actor, { action: 'calendar.link_revoked', entity: { type: 'user_calendar_link', id: link.id }, changes: redactSnapshot({ status: 'revoked', provider: link.provider, token_purged: true }), reason: code });
}

// ---- live free/busy (R-CAL-3) -------------------------------------------------------------------------------

export interface BusyView {
  calendar: Exclude<LinkState, 'pending'> | 'unavailable'; // a pending_review link is not live: no busy times
  provider: CalendarProviderKey | null;
  sentence: string;
  busy: Busy[];
}

export const MAX_BUSY_RANGE_MS = 31 * 86_400_000;

/** Merges overlapping or touching intervals (sorted by start). */
export function mergeBusy(xs: readonly Busy[]): Busy[] {
  const sorted = [...xs].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const out: Busy[] = [];
  for (const b of sorted) {
    const last = out.at(-1);
    if (last && Date.parse(b.start) <= Date.parse(last.end)) {
      if (Date.parse(b.end) > Date.parse(last.end)) last.end = new Date(Date.parse(b.end)).toISOString();
    } else out.push({ start: new Date(Date.parse(b.start)).toISOString(), end: new Date(Date.parse(b.end)).toISOString() });
  }
  return out;
}

type ProviderBusy = { calendar: BusyView['calendar']; provider: CalendarProviderKey | null; busy: Busy[] };

/** System actor, inside the caller's transaction: the person's live calendar busy times, read now, kept nowhere. */
async function providerBusy(deps: CalendarDeps, tx: Tx, tenantId: TenantId, userId: string, range: { start: string; end: string }): Promise<ProviderBusy> {
  const link = await repo.liveLinkOf(tx, userId);
  if (!link) {
    const links = await repo.linksOfUser(tx, userId);
    const revoked = links.find((l) => l.status === 'revoked' && l.last_error_code === 'GRANT_REVOKED');
    return { calendar: revoked ? 'needs_reconnect' : 'not_connected', provider: revoked?.provider ?? null, busy: [] };
  }
  const svc = CALENDAR_SERVICES[link.provider];
  try {
    const live = await liveAuth(deps, tx, tenantId, link);
    const busy = await withAuth(live, (a) => deps.adapters.calendar[svc.calendar].freeBusy(a, range));
    return { calendar: link.status === 'degraded' ? 'degraded' : 'connected', provider: link.provider, busy };
  } catch (e) {
    if (e instanceof GrantRevokedError) {
      await revokeLinkAsSystem(tx, sys(tenantId), link, 'GRANT_REVOKED');
      return { calendar: 'needs_reconnect', provider: link.provider, busy: [] };
    }
    return { calendar: 'unavailable', provider: link.provider, busy: [] };
  }
}

const BUSY_SENTENCES: Record<BusyView['calendar'], string> = {
  connected: 'Busy times from your calendar and your Realty OS appointments, read just now.',
  degraded: 'Busy times from your calendar and your Realty OS appointments, read just now.',
  needs_reconnect: 'Only your Realty OS appointments: your calendar needs to be reconnected.',
  not_connected: 'Only your Realty OS appointments: no calendar is connected.',
  not_configured: 'Only your Realty OS appointments: calendars are not set up on this platform yet.',
  unavailable: 'Only your Realty OS appointments: your calendar did not answer just now.',
};

/** GET /me/busy for the signed-in person. Nothing read here is written anywhere (R-CAL-3). */
export async function busy(deps: CalendarDeps, actor: UserActor, range: { from: string; to: string }): Promise<BusyView> {
  const span = Date.parse(range.to) - Date.parse(range.from);
  if (!(span > 0) || span > MAX_BUSY_RANGE_MS) throw new AppError('VALIDATION_FAILED', { reason: 'RANGE_INVALID' });
  return withTenantTx(
    sys(actor.tenantId),
    async (tx) => {
      const p = await providerBusy(deps, tx, actor.tenantId, actor.userId, { start: new Date(range.from).toISOString(), end: new Date(range.to).toISOString() });
      const own = (await repo.busyAppointments(tx, actor.userId, range.from, range.to)).map((a) => ({ start: a.starts_at.toISOString(), end: a.ends_at.toISOString() }));
      return { calendar: p.calendar, provider: p.provider, sentence: BUSY_SENTENCES[p.calendar], busy: mergeBusy([...p.busy, ...own]) };
    },
    { db: deps.db, retries: 2 },
  );
}

/**
 * Module 48 (flagged one-place export, O10): the busy times bookSlot reads for `userId` (live free/busy plus the
 * person's in-app appointments), as the system actor inside the caller's transaction. Read now, kept nowhere
 * (R-CAL-3). `calendar: 'unavailable'` means the calendar did not answer: offer nothing (bookSlot would refuse too).
 */
export async function busyForBooking(deps: CalendarDeps, tx: Tx, tenantId: TenantId, userId: string, range: { start: string; end: string }): Promise<{ calendar: BusyView['calendar']; busy: Busy[] }> {
  const p = await providerBusy(deps, tx, tenantId, userId, range);
  const own = (await repo.busyAppointments(tx, userId, range.start, range.end)).map((a) => ({ start: a.starts_at.toISOString(), end: a.ends_at.toISOString() }));
  return { calendar: p.calendar, busy: mergeBusy([...p.busy, ...own]) };
}

// ---- booking under the person's advisory lock (E151) --------------------------------------------------------

export interface BookInput {
  userId: string;
  contactId?: string | null;
  kind: repo.PushRow['kind'];
  startsAt: string;
  endsAt: string;
  createdByKind: 'assistant' | 'system';
}

export type BookResult =
  | { ok: true; appointmentId: string }
  | { ok: false; code: 'SLOT_TAKEN'; nextSlot: { startsAt: string; endsAt: string } | null }
  | { ok: false; code: 'CALENDAR_UNAVAILABLE' | 'MEMBER_NOT_ACTIVE' | 'SLOT_INVALID' };

const STEP_MS = 15 * 60_000;
const SEARCH_MS = 7 * 86_400_000;

const overlaps = (s: number, e: number, b: Busy) => Date.parse(b.start) < e && Date.parse(b.end) > s;

/**
 * Books one slot for `userId` as the system actor (the assistant or voice path, module 48). The transaction
 * takes the person's advisory lock first, then re-reads their in-app appointments and their live free/busy, so
 * of two concurrent bookings of one slot exactly one wins; the other gets SLOT_TAKEN with the next free slot of
 * the same length (15-minute steps, within 7 days). An unreachable calendar refuses the booking rather than
 * risking a double booking. The new appointment enqueues its calendar push in the same transaction.
 */
export async function bookSlot(deps: CalendarDeps, tenantId: string, input: BookInput): Promise<BookResult> {
  const s = Date.parse(input.startsAt);
  const e = Date.parse(input.endsAt);
  if (!(e > s) || e - s > 12 * 3_600_000) return { ok: false, code: 'SLOT_INVALID' };
  const actor = sys(tenantId);
  return withTenantTx(
    actor,
    async (tx, now) => {
      if (s < now) return { ok: false as const, code: 'SLOT_INVALID' as const };
      await repo.lockPersonBookings(tx, input.userId);
      if (!(await repo.memberActive(tx, input.userId))) return { ok: false as const, code: 'MEMBER_NOT_ACTIVE' as const };
      const windowEnd = new Date(e + SEARCH_MS).toISOString();
      const p = await providerBusy(deps, tx, actor.tenantId, input.userId, { start: new Date(s).toISOString(), end: windowEnd });
      if (p.calendar === 'unavailable') return { ok: false as const, code: 'CALENDAR_UNAVAILABLE' as const };
      const own = (await repo.busyAppointments(tx, input.userId, new Date(s).toISOString(), windowEnd)).map((a) => ({ start: a.starts_at.toISOString(), end: a.ends_at.toISOString() }));
      const taken = mergeBusy([...p.busy, ...own]);
      if (taken.some((b) => overlaps(s, e, b))) {
        const len = e - s;
        let next: { startsAt: string; endsAt: string } | null = null;
        for (let t = s + STEP_MS; t + len <= e + SEARCH_MS; t += STEP_MS) {
          if (!taken.some((b) => overlaps(t, t + len, b))) {
            next = { startsAt: new Date(t).toISOString(), endsAt: new Date(t + len).toISOString() };
            break;
          }
        }
        return { ok: false as const, code: 'SLOT_TAKEN' as const, nextSlot: next };
      }
      const id = deps.ids.next<'AppointmentId'>();
      await repo.insertBooked(tx, { id, userId: input.userId, contactId: input.contactId ?? null, kind: input.kind, startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString(), createdByKind: input.createdByKind, setByUserId: null });
      await enqueueCalendarPushLocked(tx, id);
      return { ok: true as const, appointmentId: id };
    },
    { db: deps.db, retries: 0 },
  );
}
