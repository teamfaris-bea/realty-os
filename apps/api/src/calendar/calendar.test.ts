// api/calendar through the real server, the real worker and Postgres (module 34; R-CAL-1..4, R-INT-5; E102, E103,
// E151). The provider side is the deterministic fake Google/Microsoft calendar and OAuth provider.
import type { TenantId, UserActor } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditRows, call, freshReauth, inviteViaApi } from '../admin/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { ownedContact } from '../comms/testing.js';
import { createUnconfiguredIntegrations } from '../providers/integrations/index.js';
import { systemActor } from '../worker/systemActor.js';
import { CALENDAR_SERVICES, FORBIDDEN_CALENDAR_SCOPES, GOOGLE_CALENDAR_SCOPES, MICROSOFT_CALENDAR_SCOPES } from './catalog.js';
import { signCalendarState } from './oauthState.js';
import { eventTitle, pushAppointment } from './push.js';
import { bookSlot, calendarView, mergeBusy, scopesExact } from './service.js';
import { calendarDeps } from './routes.js';
import { apptSync, calendarCallback, connectCalendar, inHours, linkRow, newAppointment, runCalendarJobs, startCalendarFlow } from './testing.js';

let h: ApiHarness;
let owner: TestClient;
let admin: TestClient;
let agent: TestClient;
let agent2: TestClient;

const google = () => h.providers.integrations.calendar.google;
const gOAuth = () => h.providers.integrations.oauth.google;
const actorOf = (c: TestClient): UserActor => c.actor();

/** the decrypted current access token of a link (test read-back through the real system path) */
async function currentAccessToken(c: TestClient): Promise<string> {
  const { liveAuth } = await import('./tokens.js');
  const { linkOf } = await import('./repos/links.js');
  return withTenantTx(
    systemActor(c.tenantId!, 'provider'),
    async (tx) => {
      const link = (await linkOf(tx, c.userId!, 'google_calendar'))!;
      return (await liveAuth({ envelope: h.app.platform.envelope, adapters: h.providers.integrations, now: () => Date.now() }, tx, c.tenantId! as TenantId, link)).auth.accessToken;
    },
    { db: h.database },
  );
}

async function refreshTokenOf(c: TestClient): Promise<string> {
  const { tokenForRevoke } = await import('./tokens.js');
  const row = (await linkRow(h, c.userId!))!;
  return withTenantTx(systemActor(c.tenantId!, 'provider'), async (tx) => (await tokenForRevoke(h.app.platform.envelope, tx, c.tenantId! as TenantId, row.id))!.refreshToken!, { db: h.database });
}

async function pushNow(c: TestClient, appointmentId: string, lastAttempt = false) {
  const actor = systemActor(c.tenantId!, 'provider');
  return withTenantTx(actor, (tx) => pushAppointment({ envelope: h.app.platform.envelope, adapters: h.providers.integrations, now: () => Date.now() }, tx, actor, appointmentId, { lastAttempt }), { db: h.database });
}

beforeAll(async () => {
  h = await createApiHarness();
  owner = await h.signup();
  admin = await inviteViaApi(h, owner, 'admin');
  agent = await inviteViaApi(h, owner, 'agent');
  agent2 = await inviteViaApi(h, owner, 'agent');
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('connect: minimal scopes, PKCE, a signed state bound to the person (R-CAL-1)', () => {
  it('requests exactly the minimal scopes per provider and never a forbidden one', async () => {
    const g = await startCalendarFlow(agent2, 'google_calendar');
    expect(g.scopes.sort()).toEqual([...GOOGLE_CALENDAR_SCOPES].sort());
    const m = await startCalendarFlow(agent2, 'microsoft_calendar');
    expect(m.scopes.sort()).toEqual([...MICROSOFT_CALENDAR_SCOPES].sort());
    for (const s of [...g.scopes, ...m.scopes]) expect(FORBIDDEN_CALENDAR_SCOPES as readonly string[]).not.toContain(s);
    expect(new URL(g.authorizeUrl).searchParams.get('code_challenge_method')).toBe('S256');
    expect(new URL(g.authorizeUrl).searchParams.get('redirect_uri')).toMatch(/\/api\/me\/calendar\/google_calendar\/callback$/);
  });

  it('refuses a token granted with wider (or fewer) scopes than requested, revokes it and stores nothing', async () => {
    const before = gOAuth().revoked.length;
    const f = await startCalendarFlow(agent2, 'google_calendar');
    const code = gOAuth().issueCode({ codeChallenge: f.challenge, accounts: [], token: { scopes: [...GOOGLE_CALENDAR_SCOPES, 'https://www.googleapis.com/auth/calendar'], refresh: true } });
    expect((await calendarCallback(agent2, 'google_calendar', { state: f.state, code })).result).toBe('SCOPE_MISMATCH');
    expect(gOAuth().revoked.length).toBe(before + 1);
    expect(await linkRow(h, agent2.userId!)).toBeUndefined();
    expect(scopesExact(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(scopesExact(['a', 'b'], ['a'])).toBe(false);
  });

  it('a state is single use, is refused in another person\'s session, when tampered, from another tenant, or cancelled', async () => {
    const f = await startCalendarFlow(agent2, 'google_calendar');
    const code = gOAuth().issueCode({ codeChallenge: f.challenge, accounts: [], token: { scopes: [...GOOGLE_CALENDAR_SCOPES], refresh: true } });
    // another person's session can never finish this person's link (login-CSRF / account injection)
    expect((await calendarCallback(agent, 'google_calendar', { state: f.state, code })).result).toBe('STATE_INVALID');
    expect((await calendarCallback(agent2, 'microsoft_calendar', { state: f.state, code })).result).toBe('STATE_INVALID');
    expect((await calendarCallback(agent2, 'google_calendar', { state: `${f.state.slice(0, -2)}AA`, code })).result).toBe('STATE_INVALID');
    expect((await calendarCallback(agent2, 'google_calendar', { state: f.state, error: 'access_denied' })).result).toBe('CANCELLED');
    expect((await calendarCallback(agent2, 'google_calendar', { state: f.state, code })).result).toBe('CONNECTED');
    // replay: the link row moved, the state is stale
    expect((await calendarCallback(agent2, 'google_calendar', { state: f.state, code })).result).toBe('STATE_STALE');
    // an unauthenticated browser is refused before anything runs
    const anon = h.client();
    expect((await anon.request('GET', `/api/me/calendar/google_calendar/callback?state=${f.state}&code=${code}`)).statusCode).toBe(401);
    const expired = signCalendarState(h.config.sessionSecret, { tenantId: agent2.tenantId!, userId: agent2.userId!, provider: 'google_calendar', fence: '0', expiresAt: Date.now() - 1, nonce: 'n'.repeat(22) });
    expect((await calendarCallback(agent2, 'google_calendar', { state: expired, code: 'x' })).result).toBe('STATE_EXPIRED');
    await call(agent2, 'POST', '/me/calendar/google_calendar/disconnect');
  });

  it('one calendar at a time: connecting Outlook while Google is connected is refused, and the page says why', async () => {
    const c = await inviteViaApi(h, owner, 'agent');
    expect((await connectCalendar(h, c, 'google_calendar')).result).toBe('CONNECTED');
    const r = await call(c, 'POST', '/me/calendar/microsoft_calendar/connect');
    expect(r.status).toBe(409);
    expect(r.code).toBe('CALENDAR_ALREADY_CONNECTED');
    const v = (await call<{ providers: { provider: string; canConnect: boolean; blockedSentence: string | null }[] }>(c, 'GET', '/me/calendar')).body;
    expect(v.providers.find((p) => p.provider === 'microsoft_calendar')).toMatchObject({ canConnect: false, blockedSentence: expect.stringMatching(/^Disconnect Google Calendar first/) });
  });

  it('strict inputs: no route accepts another person, a token or a status', async () => {
    expect((await call(agent, 'POST', '/me/calendar/google_calendar/connect', { userId: owner.userId })).status).toBe(422);
    expect((await call(agent, 'POST', '/me/calendar/google_calendar/disconnect', { userId: owner.userId })).status).toBe(422);
    expect((await call(agent, 'GET', `/me/busy?from=${inHours(1)}&to=${inHours(2)}&userId=${owner.userId}`)).status).toBe(422);
    expect((await call(agent, 'POST', '/me/calendar/icloud/connect')).status).toBe(422);
  });
});

describe('push: one-way, fenced by sync_version (R-CAL-2)', () => {
  it('R-CAL-2 accept: an in-app appointment appears in the fake Google calendar with the reduced title, and the fence records the accepted version', async () => {
    expect((await connectCalendar(h, agent, 'google_calendar')).result).toBe('CONNECTED');
    const row = (await linkRow(h, agent.userId!))!;
    expect(row).toMatchObject({ status: 'connected', scopes: [...GOOGLE_CALENDAR_SCOPES] });
    const contact = await ownedContact(agent, { firstName: 'Jane', consent: false });
    const startsAt = inHours(30);
    const id = await newAppointment(agent, { startsAt, contactId: contact.id });
    const job = (await h.su.query("SELECT dedupe_key FROM jobs WHERE kind = 'calendar.push' AND payload->>'appointmentId' = $1", [id])).rows[0];
    expect(job.dedupe_key).toBe(`calendar.push:${id}:1`);
    await runCalendarJobs(h, agent.tenantId!);
    const ev = google().events.get(id)!;
    expect(ev).toMatchObject({ title: 'Buyer consult · Jane D.', startsAt, status: 'confirmed', calendarRef: 'primary' });
    const s = await apptSync(h, id);
    expect(s).toMatchObject({ external_sync_status: 'synced', sync_version: 1, external_pushed_version: 1, external_event_ref: `google:${ev.externalEventRef}`, external_etag: ev.externalEtag });
    // R-CAL-2: one way; the event title never carries more than the tenant's detail level
    expect(eventTitle('consult', 'Jane Q Public', 'none')).toBe('Consult');
    expect(eventTitle('other', null, 'first_name_initial')).toBe('Appointment');
    // a canceled appointment cancels its event
    expect((await call(agent, 'PATCH', `/appointments/${id}`, { status: 'canceled' })).status).toBe(200);
    await runCalendarJobs(h, agent.tenantId!);
    expect(google().events.get(id)!.status).toBe('cancelled');
    expect((await apptSync(h, id)).external_pushed_version).toBe(2);
  });

  it('R-CAL-2: two quick edits never land out of order (concurrent pushes serialize; an older push after a newer one is a no-op)', async () => {
    const id = await newAppointment(agent, { startsAt: inHours(48) });
    await runCalendarJobs(h, agent.tenantId!);
    // two quick edits: each version gets its own job (a running push never swallows a newer edit)
    const t2 = inHours(50);
    const t3 = inHours(52);
    await call(agent, 'PATCH', `/appointments/${id}`, { startsAt: t2, endsAt: inHours(51) });
    await call(agent, 'PATCH', `/appointments/${id}`, { startsAt: t3, endsAt: inHours(53) });
    const keys = (await h.su.query("SELECT dedupe_key FROM jobs WHERE kind = 'calendar.push' AND payload->>'appointmentId' = $1 AND status = 'pending' ORDER BY id", [id])).rows.map((r) => r.dedupe_key);
    expect(keys).toEqual([`calendar.push:${id}:2`, `calendar.push:${id}:3`]);

    // A push reads v3, the provider is slow; a second push of the same appointment runs at the same time.
    const fake = google();
    const original = fake.pushEvent.bind(fake);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    fake.pushEvent = async (a, e, f) => {
      if (first) {
        first = false;
        await gate;
      }
      return original(a, e, f);
    };
    try {
      const p1 = pushNow(agent, id);
      await new Promise((r) => setTimeout(r, 200));
      const p2 = pushNow(agent, id); // waits on the appointment's push lock
      await new Promise((r) => setTimeout(r, 200));
      release();
      expect(await p1).toBe('pushed');
      expect(await p2).toBe('up_to_date');
    } finally {
      fake.pushEvent = original;
    }
    expect(fake.events.get(id)!.startsAt).toBe(t3);
    expect(await apptSync(h, id)).toMatchObject({ sync_version: 3, external_pushed_version: 3 });
    // the jobs of the older versions now find nothing to do and never move the event back
    await runCalendarJobs(h, agent.tenantId!);
    expect(fake.events.get(id)!.startsAt).toBe(t3);
    // the DB fence alone refuses an older version, whatever a caller tries
    const { recordPushed } = await import('./repos/links.js');
    expect(await withTenantTx(systemActor(agent.tenantId!, 'provider'), (tx) => recordPushed(tx, id, { ref: 'google:x', etag: 'old', version: 2 }), { db: h.database })).toBe(0);
  });

  it('E103: an event edited in Google is detected at the next push, the appointment is detached, never overwritten, and the app says so in words', async () => {
    const startsAt = inHours(60);
    const id = await newAppointment(agent, { startsAt });
    await runCalendarJobs(h, agent.tenantId!);
    google().editExternally(id, { startsAt: inHours(61), title: 'Moved by me' });
    const edited = { ...google().events.get(id)! };
    // an in-app edit is pushed next: the etag no longer matches
    await call(agent, 'PATCH', `/appointments/${id}`, { startsAt: inHours(62), endsAt: inHours(63) });
    await runCalendarJobs(h, agent.tenantId!);
    expect(google().events.get(id)).toEqual(edited); // the person's change is kept
    const s = await apptSync(h, id);
    expect(s.external_sync_status).toBe('detached');
    expect(s.external_detached_at).not.toBeNull();
    const v = (await call<{ detached: { appointmentId: string; sentence: string }[] }>(agent, 'GET', '/me/calendar')).body;
    expect(v.detached.find((d) => d.appointmentId === id)?.sentence).toBe('Edited in Google Calendar; times may differ. Realty OS stopped updating this event so your change is kept.');
    // detached is final: later edits are never pushed
    const calls = google().calls.length;
    await call(agent, 'PATCH', `/appointments/${id}`, { startsAt: inHours(64), endsAt: inHours(65) });
    await runCalendarJobs(h, agent.tenantId!);
    expect(google().calls.length).toBe(calls);
    expect(google().events.get(id)).toEqual(edited);
  });

  it('E103: an event deleted in the calendar detaches its appointment too', async () => {
    const id = await newAppointment(agent, { startsAt: inHours(70) });
    await runCalendarJobs(h, agent.tenantId!);
    google().deleteExternally(id);
    await call(agent, 'PATCH', `/appointments/${id}`, { startsAt: inHours(71), endsAt: inHours(72) });
    await runCalendarJobs(h, agent.tenantId!);
    expect((await apptSync(h, id)).external_sync_status).toBe('detached');
    expect(google().events.has(id)).toBe(false);
  });

  it('R-CAL-2: tokens refresh lazily inside the push (expiring soon, or refused once by the provider)', async () => {
    const c = await inviteViaApi(h, owner, 'agent');
    expect((await connectCalendar(h, c, 'google_calendar', { expiresAt: new Date(Date.now() + 30_000).toISOString() })).result).toBe('CONNECTED');
    const before = (await linkRow(h, c.userId!))!.access_enc!;
    const n = gOAuth().refreshes.length;
    const id = await newAppointment(c, { startsAt: inHours(80) });
    await runCalendarJobs(h, c.tenantId!);
    expect(gOAuth().refreshes.length).toBe(n + 1);
    expect((await apptSync(h, id)).external_sync_status).toBe('synced');
    expect(Buffer.compare((await linkRow(h, c.userId!))!.access_enc!, before)).not.toBe(0); // the fresh token is stored (encrypted)
    // the provider refuses the stored access token once: one refresh, one retry
    gOAuth().expireAccessToken(await currentAccessToken(c));
    await call(c, 'PATCH', `/appointments/${id}`, { startsAt: inHours(81), endsAt: inHours(82) });
    await runCalendarJobs(h, c.tenantId!);
    expect(gOAuth().refreshes.length).toBe(n + 2);
    expect(await apptSync(h, id)).toMatchObject({ external_sync_status: 'synced', external_pushed_version: 2 });
  });

  it('E102 R-CAL-4: the agent revokes the app in Google: the link is revoked and its token purged, in-app appointments are unaffected, the page says reconnect, and reconnecting works', async () => {
    const c = await inviteViaApi(h, owner, 'agent');
    expect((await connectCalendar(h, c, 'google_calendar')).result).toBe('CONNECTED');
    const id = await newAppointment(c, { startsAt: inHours(90) });
    await runCalendarJobs(h, c.tenantId!);
    gOAuth().revokeGrantAtProvider(await refreshTokenOf(c));
    await call(c, 'PATCH', `/appointments/${id}`, { startsAt: inHours(91), endsAt: inHours(92) });
    await runCalendarJobs(h, c.tenantId!);
    const row = (await linkRow(h, c.userId!))!;
    expect(row).toMatchObject({ status: 'revoked', last_error_code: 'GRANT_REVOKED', access_enc: null, refresh_enc: null, key_version: null });
    expect(row.purge_after).not.toBeNull();
    const appt = (await call<{ appointment: { status: string; startsAt: string } }>(c, 'PATCH', `/appointments/${id}`, {})).body.appointment;
    expect(appt).toMatchObject({ status: 'scheduled', startsAt: inHours(91) });
    const v = (await call<{ providers: { provider: string; state: string; sentence: string; canConnect: boolean }[] }>(c, 'GET', '/me/calendar')).body;
    expect(v.providers.find((p) => p.provider === 'google_calendar')).toMatchObject({ state: 'needs_reconnect', canConnect: true, sentence: expect.stringMatching(/^Needs reconnect: Google Calendar stopped accepting Realty OS/) });
    expect((await auditRows(h, c.tenantId!, 'calendar.link_revoked')).at(-1)).toMatchObject({ reason: 'GRANT_REVOKED' });
    // sync stopped: nothing more reaches the calendar while revoked
    const calls = google().calls.length;
    await call(c, 'PATCH', `/appointments/${id}`, { startsAt: inHours(93), endsAt: inHours(94) });
    await runCalendarJobs(h, c.tenantId!);
    expect(google().calls.length).toBe(calls);
    expect((await connectCalendar(h, c, 'google_calendar')).result).toBe('CONNECTED');
    expect((await linkRow(h, c.userId!))!.status).toBe('connected');
    // the edits made while the calendar needed a reconnect reach it after the reconnect
    await runCalendarJobs(h, c.tenantId!);
    expect(google().events.get(id)!.startsAt).toBe(inHours(93));
    expect((await apptSync(h, id)).external_pushed_version).toBe((await apptSync(h, id)).sync_version);
  });

  it('R-CAL-2: a push the calendar applied but whose transaction rolled back is adopted on retry, never detached', async () => {
    const id = await newAppointment(agent, { startsAt: inHours(140) });
    await runCalendarJobs(h, agent.tenantId!);
    await call(agent, 'PATCH', `/appointments/${id}`, { startsAt: inHours(141), endsAt: inHours(142) });
    const fake = google();
    const original = fake.pushEvent.bind(fake);
    const { ProviderError } = await import('../providers/types.js');
    fake.pushEvent = async (a, e, f) => {
      await original(a, e, f); // the calendar applied it...
      throw new ProviderError('timeout'); // ...and the answer was lost: the job's transaction rolls back
    };
    try {
      await expect(pushNow(agent, id)).rejects.toThrow(/timeout/);
    } finally {
      fake.pushEvent = original;
    }
    expect((await apptSync(h, id)).external_pushed_version).toBe(1);
    expect(await pushNow(agent, id)).toBe('pushed');
    expect(await apptSync(h, id)).toMatchObject({ external_sync_status: 'synced', external_pushed_version: 2 });
    expect(fake.events.get(id)!.startsAt).toBe(inHours(141));
  });

  it('a provider outage retries; on the last attempt the link is degraded and the page says so', async () => {
    const c = await inviteViaApi(h, owner, 'agent');
    await connectCalendar(h, c, 'google_calendar');
    const id = await newAppointment(c, { startsAt: inHours(95) });
    // these direct runs stand for that job's attempts: the job itself is spent (dead) once they fail
    await h.su.query("UPDATE jobs SET status = 'dead', finished_at = now() WHERE kind = 'calendar.push' AND payload->>'appointmentId' = $1 AND status = 'pending'", [id]);
    const fake = google();
    const original = fake.pushEvent.bind(fake);
    const { ProviderError } = await import('../providers/types.js');
    fake.pushEvent = async () => {
      throw new ProviderError('unavailable', 'HTTP_503');
    };
    try {
      await expect(pushNow(c, id)).rejects.toThrow(/unavailable/);
      expect(await pushNow(c, id, true)).toBe('failed');
    } finally {
      fake.pushEvent = original;
    }
    expect((await linkRow(h, c.userId!))!.status).toBe('degraded');
    const v = (await call<{ providers: { provider: string; state: string; sentence: string }[] }>(c, 'GET', '/me/calendar')).body;
    expect(v.providers.find((p) => p.provider === 'google_calendar')!.sentence).toMatch(/^Connected, but the last update to your Google Calendar did not go through/);
    expect((await apptSync(h, id)).external_sync_status).toBe('failed');
    // recovery: the next successful push marks the link connected and re-pushes what failed meanwhile
    await newAppointment(c, { startsAt: inHours(96) });
    await runCalendarJobs(h, c.tenantId!, 3);
    expect((await linkRow(h, c.userId!))!.status).toBe('connected');
    expect(await apptSync(h, id)).toMatchObject({ external_sync_status: 'synced', external_pushed_version: 1 });
  });
});

describe('tokens and privacy (R-CAL-1, R-INT-4)', () => {
  it('tokens are encrypted at rest, never logged, never returned and never audited', async () => {
    const token = await currentAccessToken(agent);
    const refresh = await refreshTokenOf(agent);
    const row = (await linkRow(h, agent.userId!))!;
    for (const b of [row.access_enc!, row.refresh_enc!]) {
      expect(b.includes(Buffer.from(token))).toBe(false);
      expect(b.includes(Buffer.from(refresh))).toBe(false);
    }
    expect(row.key_version).toBeGreaterThan(0);
    const bodies = [
      JSON.stringify((await call(agent, 'GET', '/me/calendar')).body),
      JSON.stringify((await call(agent, 'GET', `/me/busy?from=${inHours(1)}&to=${inHours(5)}`)).body),
    ];
    const audits = JSON.stringify((await h.su.query("SELECT changes, reason FROM audit_log WHERE action LIKE 'calendar.%'")).rows);
    for (const s of [...bodies, audits, h.logs.join('\n')]) {
      expect(s).not.toContain(token);
      expect(s).not.toContain(refresh);
      expect(s).not.toContain('fake-token-');
      expect(s).not.toContain('fake-refresh-');
    }
  });

  it('R-INT-4: only tokens.ts decrypts or encrypts a calendar token, and only repos read the token columns', () => {
    const dir = join(__dirname);
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'testing.ts');
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      if (f !== 'tokens.ts') expect([f, /\.(en|de)crypt\(/.test(src)]).toEqual([f, false]);
      if (f !== join('repos', 'links.ts') && f !== 'tokens.ts') expect([f, /access_enc|refresh_enc/.test(src.replace(/\/\/.*$/gm, ''))]).toEqual([f, false]);
    }
  });

  it('R-CAL-1: the Owner and Admin read nothing of an agent\'s calendar: no link row, no state, no busy times, no route that names a person', async () => {
    google().busy = [{ start: inHours(100), end: inHours(101) }];
    for (const c of [owner, admin]) {
      const n = await withTenantTx(actorOf(c), async (tx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM user_calendar_links`.execute(tx)).rows[0]!.n, { db: h.database });
      expect(n).toBe(0);
      const v = (await call<{ providers: { state: string }[]; detached: unknown[] }>(c, 'GET', '/me/calendar')).body;
      expect(v.providers.every((p) => p.state === 'not_connected')).toBe(true);
      expect(v.detached).toEqual([]);
      const b = (await call<{ calendar: string; busy: unknown[] }>(c, 'GET', `/me/busy?from=${inHours(99)}&to=${inHours(102)}`)).body;
      expect(b).toMatchObject({ calendar: 'not_connected', busy: [] });
      // a write as the Owner cannot touch the agent's link either
      const u = await withTenantTx(actorOf(c), async (tx) => Number((await sql`UPDATE user_calendar_links SET status = 'revoked' WHERE user_id = ${agent.userId}`.execute(tx)).numAffectedRows), { db: h.database });
      expect(u).toBe(0);
    }
    // the agent sees their own
    expect((await call<{ busy: unknown[] }>(agent, 'GET', `/me/busy?from=${inHours(99)}&to=${inHours(102)}`)).body.busy).toEqual([{ start: inHours(100), end: inHours(101) }]);
    // another agent cannot see it either
    expect(await withTenantTx(actorOf(agent2), async (tx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM user_calendar_links WHERE user_id = ${agent.userId}`.execute(tx)).rows[0]!.n, { db: h.database })).toBe(0);
    google().busy = [];
  });
});

describe('live free/busy (R-CAL-3)', () => {
  it('R-CAL-3: free/busy is read live per request, merged with in-app appointments, and never stored', async () => {
    const id = await newAppointment(agent, { startsAt: inHours(120), endsAt: inHours(121) });
    google().busy = [{ start: inHours(120.5), end: inHours(122) }];
    const snapshot = async () =>
      (
        await h.su.query(
          `SELECT (SELECT count(*) FROM audit_log) AS a, (SELECT count(*) FROM jobs) AS j, (SELECT updated_at FROM user_calendar_links WHERE user_id = $1) AS l,
                  (SELECT count(*) FROM pg_stat_user_tables WHERE n_tup_ins > 0) AS t`,
          [agent.userId],
        )
      ).rows[0];
    const before = await snapshot();
    const r = (await call<{ calendar: string; busy: { start: string; end: string }[]; sentence: string }>(agent, 'GET', `/me/busy?from=${inHours(119)}&to=${inHours(123)}`)).body;
    expect(r).toMatchObject({ calendar: 'connected', busy: [{ start: inHours(120), end: inHours(122) }] });
    expect(await snapshot()).toEqual(before);
    const found = await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE changes::text LIKE $1", [`%${inHours(120.5).slice(0, 16)}%`]);
    expect(found.rows[0].n).toBe(0);
    // no cache: a change at the provider is seen by the very next read
    google().busy = [];
    expect((await call<{ busy: unknown[] }>(agent, 'GET', `/me/busy?from=${inHours(119)}&to=${inHours(123)}`)).body.busy).toEqual([{ start: inHours(120), end: inHours(121) }]);
    expect((await call(agent, 'GET', `/me/busy?from=${inHours(2)}&to=${inHours(1)}`)).status).toBe(422);
    expect((await call(agent, 'GET', `/me/busy?from=${inHours(1)}&to=${inHours(24 * 40)}`)).status).toBe(422);
    expect(mergeBusy([{ start: inHours(1), end: inHours(2) }, { start: inHours(2), end: inHours(3) }])).toEqual([{ start: inHours(1), end: inHours(3) }]);
    await call(agent, 'PATCH', `/appointments/${id}`, { status: 'canceled' });
  });
});

describe('booking under the per-user advisory lock (E151)', () => {
  it('E151: two concurrent bookings of the same slot: exactly one wins, the other is offered the next free slot', async () => {
    const deps = calendarDeps(h.app.platform);
    const start = inHours(200);
    const end = inHours(201);
    const both = await Promise.all([1, 2].map(() => bookSlot(deps, agent.tenantId!, { userId: agent.userId!, kind: 'consult', startsAt: start, endsAt: end, createdByKind: 'assistant' })));
    const won = both.filter((r) => r.ok);
    const lost = both.filter((r) => !r.ok);
    expect(won).toHaveLength(1);
    expect(lost).toEqual([{ ok: false, code: 'SLOT_TAKEN', nextSlot: { startsAt: end, endsAt: inHours(202) } }]);
    const n = await h.su.query('SELECT count(*)::int AS n FROM appointments WHERE user_id = $1 AND starts_at = $2', [agent.userId, start]);
    expect(n.rows[0].n).toBe(1);
    // the booked appointment is pushed like any other
    await runCalendarJobs(h, agent.tenantId!);
    expect(google().events.get((won[0] as { appointmentId: string }).appointmentId)).toBeDefined();
  });

  it('E151: a slot booked in-app, or busy in the live calendar, blocks the booking; the next slot skips both', async () => {
    const deps = calendarDeps(h.app.platform);
    await newAppointment(agent, { startsAt: inHours(220), endsAt: inHours(221) });
    google().busy = [{ start: inHours(221), end: inHours(222) }];
    const r = await bookSlot(deps, agent.tenantId!, { userId: agent.userId!, kind: 'consult', startsAt: inHours(220), endsAt: inHours(221), createdByKind: 'assistant' });
    expect(r).toEqual({ ok: false, code: 'SLOT_TAKEN', nextSlot: { startsAt: inHours(222), endsAt: inHours(223) } });
    const r2 = await bookSlot(deps, agent.tenantId!, { userId: agent.userId!, kind: 'consult', startsAt: inHours(221.5), endsAt: inHours(222.5), createdByKind: 'assistant' });
    expect(r2).toMatchObject({ ok: false, code: 'SLOT_TAKEN' });
    google().busy = [];
  });

  it('E151: an in-app booking holding the person\'s lock makes a concurrent booking wait and then see it', async () => {
    const deps = calendarDeps(h.app.platform);
    const { lockPersonBookings } = await import('./repos/links.js');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const startsAt = inHours(240);
    // the in-app write: insert + the module 14 hook (which takes the lock), held open
    const inApp = withTenantTx(
      actorOf(agent),
      async (tx) => {
        await sql`INSERT INTO appointments (tenant_id, id, user_id, set_by_user_id, kind, starts_at, ends_at, created_by_kind)
                  VALUES (app.tenant_id(), ${h.app.platform.ids.next()}, ${agent.userId}, ${agent.userId}, 'consult', ${startsAt}::timestamptz, ${inHours(241)}::timestamptz, 'user')`.execute(tx);
        await lockPersonBookings(tx, agent.userId!);
        locked();
        await gate;
      },
      { db: h.database },
    );
    await isLocked;
    const booking = bookSlot(deps, agent.tenantId!, { userId: agent.userId!, kind: 'consult', startsAt, endsAt: inHours(241), createdByKind: 'assistant' });
    await new Promise((r) => setTimeout(r, 200));
    release();
    await inApp;
    expect(await booking).toMatchObject({ ok: false, code: 'SLOT_TAKEN', nextSlot: { startsAt: inHours(241) } });
  });

  it('refuses a booking when the calendar does not answer (never risks a double booking)', async () => {
    const deps = calendarDeps(h.app.platform);
    const fake = google();
    const original = fake.freeBusy.bind(fake);
    const { ProviderError } = await import('../providers/types.js');
    fake.freeBusy = async () => {
      throw new ProviderError('timeout');
    };
    try {
      expect(await bookSlot(deps, agent.tenantId!, { userId: agent.userId!, kind: 'consult', startsAt: inHours(260), endsAt: inHours(261), createdByKind: 'assistant' })).toEqual({ ok: false, code: 'CALENDAR_UNAVAILABLE' });
    } finally {
      fake.freeBusy = original;
    }
  });
});

describe('disconnect and removal (R-INT-5, R-CAL-4)', () => {
  it('R-INT-5 R-CAL-4: disconnect revokes and purges the token in one transaction, revokes at the provider, stops sync, and leaves in-app appointments alone', async () => {
    const c = await inviteViaApi(h, owner, 'agent');
    await connectCalendar(h, c, 'google_calendar');
    const id = await newAppointment(c, { startsAt: inHours(300) });
    await runCalendarJobs(h, c.tenantId!);
    const token = await currentAccessToken(c);
    const r = await call<{ providers: { provider: string; state: string; canConnect: boolean }[] }>(c, 'POST', '/me/calendar/google_calendar/disconnect');
    expect(r.status).toBe(200);
    expect(r.body.providers.find((p) => p.provider === 'google_calendar')).toMatchObject({ state: 'not_connected', canConnect: true });
    const row = (await linkRow(h, c.userId!))!;
    expect(row).toMatchObject({ status: 'revoked', access_enc: null, refresh_enc: null, key_version: null, last_error_code: null });
    expect(gOAuth().revoked).toContain(token);
    expect((await auditRows(h, c.tenantId!, 'calendar.disconnected')).at(-1)).toMatchObject({ actor_user_id: c.userId, reason: 'DISCONNECTED' });
    const calls = google().calls.length;
    await call(c, 'PATCH', `/appointments/${id}`, { startsAt: inHours(301), endsAt: inHours(302) });
    await runCalendarJobs(h, c.tenantId!);
    expect(google().calls.length).toBe(calls);
    expect((await call<{ appointments: { id: string }[] }>(c, 'GET', '/appointments')).body.appointments.map((a) => a.id)).toContain(id);
    expect((await call(c, 'POST', '/me/calendar/google_calendar/disconnect')).status).toBe(200); // idempotent
  });

  it('R-INT-5: removing the member revokes their link in the removal transaction; reconcile then revokes the grant at the provider and purges the token', async () => {
    const c = await inviteViaApi(h, owner, 'agent');
    await connectCalendar(h, c, 'google_calendar');
    const token = await currentAccessToken(c);
    // the Owner removes the member through the real API
    await freshReauth(h, owner);
    const m = (await call<{ members: { userId: string; version: number }[] }>(owner, 'GET', '/members')).body.members.find((x) => x.userId === c.userId)!;
    const r = await call(owner, 'PATCH', `/members/${c.userId}`, { version: m.version, status: 'removed' });
    expect(r.status).toBe(200);
    // revoked locally in that same transaction (0050 trigger): nothing can use it any more
    expect(await linkRow(h, c.userId!)).toMatchObject({ status: 'revoked', last_error_code: 'MEMBER_REMOVED' });
    expect((await linkRow(h, c.userId!))!.purge_after).not.toBeNull();
    const { reconcileLinks } = await import('./push.js');
    const actor = systemActor(c.tenantId!, 'provider');
    const run = () => withTenantTx(actor, (tx) => reconcileLinks({ envelope: h.app.platform.envelope, adapters: h.providers.integrations, now: () => Date.now() }, tx, actor), { db: h.database });
    expect(await run()).toBe(1);
    expect(await linkRow(h, c.userId!)).toMatchObject({ status: 'revoked', last_error_code: 'MEMBER_REMOVED', access_enc: null, refresh_enc: null });
    expect(gOAuth().revoked).toContain(token);
    expect((await auditRows(h, c.tenantId!, 'calendar.link_revoked')).at(-1)).toMatchObject({ reason: 'MEMBER_REMOVED' });
    expect(await run()).toBe(0);
  });

  it('R-INT-5: suspending a member is not removal: sync pauses, the link and the grant are kept, and sync resumes on reactivation', async () => {
    const c = await inviteViaApi(h, owner, 'agent');
    await connectCalendar(h, c, 'google_calendar');
    const id = await newAppointment(c, { startsAt: inHours(310) });
    const patch = async (status: string) => {
      await freshReauth(h, owner);
      const m = (await call<{ members: { userId: string; version: number }[] }>(owner, 'GET', '/members')).body.members.find((x) => x.userId === c.userId)!;
      expect((await call(owner, 'PATCH', `/members/${c.userId}`, { version: m.version, status })).status).toBe(200);
    };
    await patch('suspended');
    expect(await pushNow(c, id)).toBe('member_inactive');
    const { reconcileLinks } = await import('./push.js');
    const actor = systemActor(c.tenantId!, 'provider');
    expect(await withTenantTx(actor, (tx) => reconcileLinks({ envelope: h.app.platform.envelope, adapters: h.providers.integrations, now: () => Date.now() }, tx, actor), { db: h.database })).toBe(0);
    const row = (await linkRow(h, c.userId!))!;
    expect(row.status).toBe('connected');
    expect(row.access_enc).not.toBeNull();
    await patch('active');
    expect(await pushNow(c, id)).toBe('pushed');
    expect(google().events.has(id)).toBe(true);
  });
});

describe('cross-tenant isolation', () => {
  it('another tenant sees no link, cannot finish a state signed for this tenant, and its system actor cannot push this tenant\'s appointment', async () => {
    const other = await h.signup();
    const otherAgent = await inviteViaApi(h, other, 'agent');
    const n = await withTenantTx(systemActor(other.tenantId!, 'provider'), async (tx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM user_calendar_links`.execute(tx)).rows[0]!.n, { db: h.database });
    expect(n).toBe(0);
    const f = await startCalendarFlow(agent2, 'google_calendar');
    expect((await calendarCallback(otherAgent, 'google_calendar', { state: f.state, code: 'x' })).result).toBe('STATE_INVALID');
    const id = await newAppointment(agent, { startsAt: inHours(400) });
    expect(await pushNow(otherAgent, id)).toBe('missing'); // the other tenant's system actor cannot even read it
    expect(google().events.has(id)).toBe(false);
  });
});

describe('honest states', () => {
  it('not configured: with no platform app the page says so and offers no connect; the connect start is refused', async () => {
    const v = await withTenantTx(actorOf(agent2), (tx) => calendarView(tx, actorOf(agent2), createUnconfiguredIntegrations()), { db: h.database });
    for (const p of v.providers) {
      expect(p).toMatchObject({ state: 'not_configured', canConnect: false });
      expect(p.sentence).toMatch(/^Not set up on this platform yet/);
    }
    expect(v.syncSentence).toMatch(/^One way: appointments you make or change in Realty OS are added to your calendar/);
    expect(CALENDAR_SERVICES.google_calendar.calendarRef).toBe('primary');
  });
});
