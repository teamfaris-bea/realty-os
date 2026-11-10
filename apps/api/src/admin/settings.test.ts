// api/admin settings and brokerage identity through the real server and Postgres: R-PERM-3
// (Owner-only fields, API and DB trigger), R-PERM-13 (re-auth on identity and recording settings,
// not on lead timers), R-OWN-15 / E67 (settings never move stored deadlines), R-GATE-12 (the identity
// marketing renders), R-AUDIT-5 (settings diffs).
import type { ContactId } from '@realty/core/foundation';
import { renderedFacts } from '@realty/core/compliance';
import { applyOwnershipCommand, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { loadBrokerageIdentity } from './settings.js';
import { auditRows, call, freshReauth, inviteViaApi, registerPush, routeInquiry, staleReauth } from './testing.js';

interface Settings {
  version: number;
  offerWindowSeconds: number;
  inactivityReleaseDays: number | null;
  routingHoursStart: string;
  routingHoursEnd: string;
  teamLeadRecordingAccess: boolean;
  defaultTimezone: string;
  identity: { brokerageLegalName: string; teamName: string | null; brokeragePostalAddress: string | null; missing: string[] };
}

let h: ApiHarness;
let owner: TestClient;
let admin: TestClient;
let agent: TestClient;

async function settings(c: TestClient = owner): Promise<Settings> {
  return (await call<{ settings: Settings }>(c, 'GET', '/settings')).body.settings;
}

async function patch(c: TestClient, body: Record<string, unknown>, url = '/settings') {
  const s = await settings(owner);
  return call<{ settings: Settings }>(c, 'PATCH', url, { version: s.version, ...body });
}

beforeAll(async () => {
  h = await createApiHarness();
  owner = await h.signup();
  admin = await inviteViaApi(h, owner, 'admin');
  agent = await inviteViaApi(h, owner, 'agent');
  await registerPush(agent);
  await freshReauth(h, owner);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('lead timers and routing hours', () => {
  it('an Admin changes lead timers without re-auth; the diff is audited as {from, to}', async () => {
    await staleReauth(h, admin);
    const r = await patch(admin, { offerWindowSeconds: 120, maxOffers: 2, routingHoursStart: '07:30', notificationDetail: 'none' });
    expect(r.status).toBe(200);
    expect(r.body.settings).toMatchObject({ offerWindowSeconds: 120, routingHoursStart: '07:30' });
    const row = (await auditRows(h, owner.tenantId!, 'settings.')).at(-1)!;
    expect(row.changes).toEqual({
      max_offers: { from: 3, to: 2 },
      notification_detail: { from: 'first_name_initial', to: 'none' },
      offer_window_seconds: { from: 300, to: 120 },
      routing_hours_start: { from: '08:00:00', to: '07:30:00' },
    });
    expect(row.actor_role).toBe('admin');
  });

  it('cross-field rules are 422 with a field path; an unknown time zone is TIMEZONE_INVALID; a stale version is VERSION_CONFLICT', async () => {
    expect((await patch(owner, { routingHoursStart: '21:00', routingHoursEnd: '20:00' })).body).toMatchObject({ error: { code: 'VALIDATION_FAILED', details: { issues: [{ path: '/routingHoursEnd' }] } } });
    expect((await patch(owner, { firstTouchSlaSeconds: 900, firstTouchReleaseSeconds: 900 })).body).toMatchObject({ error: { details: { issues: [{ path: '/firstTouchReleaseSeconds' }] } } });
    expect((await patch(owner, { defaultTimezone: 'Mars/Olympus_Mons' })).code).toBe('TIMEZONE_INVALID');
    expect((await patch(owner, { tenant_id: randomUUID() })).code).toBe('VALIDATION_FAILED');
    const s = await settings();
    expect((await call(owner, 'PATCH', '/settings', { version: s.version - 1, maxOffers: 4 })).code).toBe('VERSION_CONFLICT');
    const off = await patch(owner, { firstTouchReleaseSeconds: null });
    expect([off.status, (off.body.settings as unknown as { firstTouchReleaseSeconds: number | null }).firstTouchReleaseSeconds]).toEqual([200, null]);
  });

  it('R-OWN-15 E67: lowering inactivity_release_days, changing the offer window and the time zone never move a stored deadline; new periods use the new values', async () => {
    await freshReauth(h, owner);
    await patch(owner, { inactivityReleaseDays: 30, offerWindowSeconds: 300 });
    // an offered lead (stored offer_expires_at) and an owned lead (stored inactivity deadlines)
    const rule = await call<{ rule: { id: string } }>(owner, 'POST', '/routing-rules', { name: 'To agent', strategy: 'direct', directUserId: agent.userId });
    expect(rule.status).toBe(201);
    const offered = await routeInquiry(h, owner.tenantId!, { inquiryType: 'buy' });
    expect(offered.offeredTo).toBe(agent.userId);
    const ownedId = randomUUID() as ContactId;
    const created = await applyOwnershipCommand(agent.actor(), ownedId, { kind: 'create', via: 'self' }, { commandId: randomUUID(), newContact: { displayName: 'Sam Sphere' }, db: h.database });
    expect(created.outcome.ok).toBe(true);
    const read = async (id: string) =>
      (await h.su.query<{ offer_expires_at: Date | null; inactivity_release_at: Date | null; inactivity_warn_at: Date | null }>(
        'SELECT offer_expires_at, inactivity_release_at, inactivity_warn_at FROM contacts WHERE id = $1',
        [id],
      )).rows[0]!;
    const before = { offered: await read(offered.contactId), owned: await read(ownedId) };
    expect(before.owned.inactivity_release_at).not.toBeNull();
    expect(before.offered.offer_expires_at).not.toBeNull();

    const r = await patch(owner, { inactivityReleaseDays: 14, offerWindowSeconds: 60, defaultTimezone: 'America/Los_Angeles', routingHoursStart: '06:00' });
    expect(r.status).toBe(200);
    expect(await read(offered.contactId)).toEqual(before.offered);
    expect(await read(ownedId)).toEqual(before.owned);

    // a new ownership period uses the settings now in force (14 days, not 30)
    const laterId = randomUUID() as ContactId;
    await applyOwnershipCommand(agent.actor(), laterId, { kind: 'create', via: 'self' }, { commandId: randomUUID(), newContact: { displayName: 'Lee Later' }, db: h.database });
    const later = await read(laterId);
    const days = (later.inactivity_release_at!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13);
    expect(days).toBeLessThan(15.1);
    const oldDays = (before.owned.inactivity_release_at!.getTime() - Date.now()) / 86_400_000;
    expect(oldDays).toBeGreaterThan(28);
    await call(owner, 'DELETE', `/routing-rules/${rule.body.rule.id}`);
  });
});

describe('Owner-only settings (R-PERM-3)', () => {
  it('R-PERM-3: recording retention and access are Owner-only: an Admin gets OWNER_REQUIRED naming the fields, and nothing changes', async () => {
    await freshReauth(h, admin);
    const r = await patch(admin, { teamLeadRecordingAccess: false, maxOffers: 5 });
    expect([r.status, r.code]).toEqual([403, 'OWNER_REQUIRED']);
    expect(r.body).toMatchObject({ error: { details: { fields: ['teamLeadRecordingAccess'] } } });
    expect(await settings()).toMatchObject({ teamLeadRecordingAccess: true });
  });

  it('R-PERM-3: the tenant_settings_guard trigger backs it: an Admin writing recording access or the brokerage name directly is refused', async () => {
    for (const set of [sql`team_lead_recording_access = false`, sql`brokerage_legal_name = 'Other LLC'`, sql`recording_retention_days = 31`]) {
      await expect(
        withTenantTx(admin.actor(), async (tx) => {
          await sql`UPDATE tenant_settings SET ${set} WHERE tenant_id = app.tenant_id()`.execute(tx);
        }, { db: h.database }),
      ).rejects.toThrow(/OWNER_ONLY_SETTING/);
    }
  });

  it('R-PERM-13 R-PERM-3: the Owner changes recording access only with a fresh re-auth', async () => {
    await staleReauth(h, owner);
    const stale = await patch(owner, { tcRecordingAccess: true });
    expect([stale.status, stale.code]).toEqual([401, 'REAUTH_REQUIRED']);
    await freshReauth(h, owner);
    const ok = await patch(owner, { tcRecordingAccess: true, recordingRetentionDays: 365 });
    expect(ok.status).toBe(200);
    await patch(owner, { tcRecordingAccess: false });
  });
});

describe('brokerage identity (R-GATE-12, R-PERM-3)', () => {
  it('R-PERM-3: brokerage identity is Owner-only (Admin 404 per the matrix) and 🔒 (stale Owner 401)', async () => {
    await freshReauth(h, admin);
    expect((await patch(admin, { brokerageLegalName: 'Admin Realty LLC' }, '/settings/identity')).status).toBe(404);
    await staleReauth(h, owner);
    expect((await patch(owner, { brokerageLegalName: 'Owner Realty LLC' }, '/settings/identity')).code).toBe('REAUTH_REQUIRED');
    expect((await settings()).identity.brokerageLegalName).toBe('Harbor Realty LLC');
  });

  it('R-GATE-12: the legal name can never be blank or cleared; the postal address is reported missing until set; the stored identity is what marketing renders', async () => {
    await freshReauth(h, owner);
    expect((await settings()).identity.missing).toEqual(['brokerage_postal_address']);
    expect((await patch(owner, { brokerageLegalName: '   ' }, '/settings/identity')).code).toBe('VALIDATION_FAILED');
    expect((await patch(owner, { brokerageLegalName: null }, '/settings/identity')).code).toBe('VALIDATION_FAILED');
    const r = await patch(owner, { brokerageLegalName: 'Lowcountry Homes LLC', brokeragePostalAddress: '12 Broad St, Charleston, SC 29401', brokerageLicenseNumber: 'SC-123' }, '/settings/identity');
    expect(r.status).toBe(200);
    expect(r.body.settings.identity).toMatchObject({ brokerageLegalName: 'Lowcountry Homes LLC', missing: [] });
    // any member's transaction reads the identity the outbound renderer and gate use
    const id = await withTenantTx(agent.actor(), (tx) => loadBrokerageIdentity(tx), { db: h.database });
    expect(id).toEqual({ brokerageLegalName: 'Lowcountry Homes LLC', teamName: expect.any(String), brokerageLicenseNumber: 'SC-123', brokeragePostalAddress: '12 Broad St, Charleston, SC 29401' });
    const text = 'New listing on Tradd St this weekend. Lowcountry Homes LLC. Reply STOP to opt out.';
    expect(renderedFacts(text, { channel: 'sms', brokerageLegalName: id!.brokerageLegalName }).containsBrokerageName).toBe(true);
    expect(renderedFacts(text.replace('Lowcountry Homes LLC', 'Harbor Realty LLC'), { channel: 'sms', brokerageLegalName: id!.brokerageLegalName }).containsBrokerageName).toBe(false);
    const row = (await auditRows(h, owner.tenantId!, 'settings.')).at(-1)!;
    expect(row.reason).toBe('BROKERAGE_IDENTITY');
    expect(row.changes).toMatchObject({ brokerage_legal_name: { from: 'Harbor Realty LLC', to: 'Lowcountry Homes LLC' } });
  });
});
