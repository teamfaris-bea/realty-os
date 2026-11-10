// api/admin compliance policy versions: the pure loosening comparison (unit + property), and the API:
// stricter by Owner/Admin, looser only by the Owner with re-auth and the exact attestation
// (R-PERM-1 §3 "Compliance policy", R-PERM-13), activation of a loosened policy Owner-only (R-PERM-3),
// versions append-only (R-AUDIT-7), audited (R-AUDIT-5), honest counsel status.
import fc from 'fast-check';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { ATTESTATION_TEXT, DEFAULT_POLICY, type PolicyValues, attestationRequiredFields, looserFields, policyLoosening } from './policy.js';
import { auditRows, call, freshReauth, inviteViaApi, staleReauth } from './testing.js';

describe('policyLoosening (pure)', () => {
  const base = { ...DEFAULT_POLICY, autonomousCategories: [...DEFAULT_POLICY.autonomousCategories] };

  it('the defaults compared with themselves are not loosening', () => {
    expect(policyLoosening(base, base)).toEqual({ loosening: false, fields: [] });
  });

  it('each field is judged in its own direction', () => {
    const cases: [Partial<PolicyValues>, string[]][] = [
      [{ contactWindowStart: '08:30' }, ['contactWindowStart']],
      [{ contactWindowEnd: '20:30' }, ['contactWindowEnd']],
      [{ contactWindowStart: '10:00', contactWindowEnd: '19:00' }, []],
      [{ humanReplyWindowMinutes: 10 }, []],
      [{ autoSmsPer24h: 0, autoSmsPer7d: 1 }, []],
      [{ maxDeferrals: 5 }, ['maxDeferrals']],
      [{ autonomousCategories: [...base.autonomousCategories, 'document_chase'] }, ['autonomousCategories']],
      [{ autonomousCategories: ['reminder'] }, []],
      [{ recordingMode: 'one_party_where_permitted' }, ['recordingMode']],
      [{ recordingEnabled: false }, []],
      [{ emailQuietHours: true }, []],
      [{ optOutConfirmationSender: 'platform' }, []],
    ];
    for (const [delta, want] of cases) expect({ delta, fields: policyLoosening(base, { ...base, ...delta }).fields }).toEqual({ delta, fields: want });
    const strict = { ...base, emailQuietHours: true, recordingEnabled: false, humanReplyWindowMinutes: 5, callAttemptsPer24h: 1 };
    expect(looserFields(strict, base).sort()).toEqual(['callAttemptsPer24h', 'emailQuietHours', 'humanReplyWindowMinutes', 'recordingEnabled']);
  });

  it('beyond the shipped defaults always needs the attestation, even when it is no looser than the active version', () => {
    const wide = { ...base, contactWindowStart: '08:00', contactWindowEnd: '21:00' };
    expect(looserFields(wide, { ...wide, autoSmsPer7d: 1 })).toEqual([]);
    expect(attestationRequiredFields({ ...wide, autoSmsPer7d: 1 })).toEqual(['contactWindowStart', 'contactWindowEnd']);
    expect(policyLoosening(wide, { ...wide, autoSmsPer7d: 1 })).toEqual({ loosening: true, fields: ['contactWindowEnd', 'contactWindowStart'] });
  });

  it('property: a draft that is equal or stricter in every field, within the defaults, is never loosening; relaxing one numeric cap always is', () => {
    const caps = ['humanReplyWindowMinutes', 'autoSmsPer24h', 'autoSmsPer7d', 'autoEmailPer24h', 'autoEmailPer7d', 'autoCrossChannelPer24h', 'manualSmsConfirmAfter24h', 'callAttemptsPer24h', 'maxDeferrals'] as const;
    const minOf: Record<(typeof caps)[number], number> = { humanReplyWindowMinutes: 0, autoSmsPer24h: 0, autoSmsPer7d: 0, autoEmailPer24h: 0, autoEmailPer7d: 0, autoCrossChannelPer24h: 0, manualSmsConfirmAfter24h: 1, callAttemptsPer24h: 1, maxDeferrals: 1 };
    fc.assert(
      fc.property(
        fc.record(Object.fromEntries(caps.map((c) => [c, fc.integer({ min: minOf[c], max: base[c] as number })])) as Record<(typeof caps)[number], fc.Arbitrary<number>>),
        fc.integer({ min: 9 * 60, max: 12 * 60 }),
        fc.integer({ min: 13 * 60, max: 20 * 60 }),
        fc.subarray([...base.autonomousCategories]),
        fc.boolean(),
        fc.constantFrom(...caps),
        (vals, startMin, endMin, cats, quiet, relax) => {
          const t = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
          const stricter: PolicyValues = { ...base, ...vals, contactWindowStart: t(startMin), contactWindowEnd: t(endMin), autonomousCategories: cats, emailQuietHours: quiet || base.emailQuietHours };
          expect(policyLoosening(base, stricter).loosening).toBe(false);
          if ((stricter[relax] as number) < (base[relax] as number)) {
            expect(policyLoosening(stricter, { ...stricter, [relax]: base[relax] }).fields).toContain(relax);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

interface Version {
  id: string;
  versionNo: number;
  attested: boolean;
  active: boolean;
  autoSmsPer7d: number;
  contactWindowStart: string;
}

let h: ApiHarness;
let owner: TestClient;
let admin: TestClient;

const policies = async () => (await call<{ activePolicyId: string; versions: Version[]; attestationText: string; counsel: { allReviewed: boolean; packs: unknown[] } }>(owner, 'GET', '/compliance-policies')).body;

beforeAll(async () => {
  h = await createApiHarness();
  owner = await h.signup();
  admin = await inviteViaApi(h, owner, 'admin');
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('compliance policy versions through the API', () => {
  it('GET shows v1 active, the exact attestation sentence, and says plainly that the packs are not counsel-reviewed', async () => {
    const p = await policies();
    expect(p.versions.map((v) => [v.versionNo, v.active, v.attested])).toEqual([[1, true, false]]);
    expect(p.attestationText).toBe(ATTESTATION_TEXT);
    expect(p.counsel.allReviewed).toBe(false);
  });

  it('R-PERM-1: an Admin may make the policy stricter (no re-auth) and activate it; both are audited', async () => {
    await staleReauth(h, admin);
    const r = await call<{ id: string; versionNo: number; loosening: boolean; active: boolean }>(admin, 'POST', '/compliance-policies', { autoSmsPer7d: 2, activate: true });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ versionNo: 2, loosening: false, active: true });
    expect((await policies()).activePolicyId).toBe(r.body.id);
    const stored = (await h.su.query<{ loosening_attestation: string | null; created_by_user_id: string }>('SELECT loosening_attestation, created_by_user_id FROM compliance_policy_versions WHERE id = $1', [r.body.id])).rows[0]!;
    expect(stored).toEqual({ loosening_attestation: null, created_by_user_id: admin.userId });
    const rows = await auditRows(h, owner.tenantId!, 'policy.');
    expect(rows.map((x) => x.action)).toEqual(['policy.version_created', 'policy.activated']);
    expect(rows[1]!.changes).toMatchObject({ policy_version: { from: 1, to: 2 } });
  });

  it('R-PERM-1: an Admin cannot loosen (stricter only): OWNER_REQUIRED naming the loosened fields; nothing is written', async () => {
    await freshReauth(h, admin);
    const n = (await policies()).versions.length;
    for (const body of [{ autoSmsPer7d: 3 }, { contactWindowStart: '08:00' }, { recordingMode: 'one_party_where_permitted' }, { autonomousCategories: ['document_chase'] }]) {
      const r = await call(admin, 'POST', '/compliance-policies', { ...body, attestation: ATTESTATION_TEXT });
      expect([r.status, r.code]).toEqual([403, 'OWNER_REQUIRED']);
    }
    expect((await policies()).versions.length).toBe(n);
  });

  it('R-PERM-13: looser needs the Owner with the exact attestation AND a re-auth within 15 minutes', async () => {
    await freshReauth(h, owner);
    const none = await call(owner, 'POST', '/compliance-policies', { autoSmsPer7d: 3 });
    expect([none.status, none.code]).toEqual([403, 'ATTESTATION_REQUIRED']);
    const wrong = await call(owner, 'POST', '/compliance-policies', { autoSmsPer7d: 3, attestation: 'I agree' });
    expect(wrong.code).toBe('ATTESTATION_REQUIRED');
    await staleReauth(h, owner);
    const stale = await call(owner, 'POST', '/compliance-policies', { autoSmsPer7d: 3, attestation: ATTESTATION_TEXT });
    expect([stale.status, stale.code]).toEqual([401, 'REAUTH_REQUIRED']);
    // a stricter change by the Owner needs no re-auth
    expect((await call(owner, 'POST', '/compliance-policies', { callAttemptsPer24h: 2 })).status).toBe(201);
    await freshReauth(h, owner);
    const ok = await call<{ id: string; loosening: boolean; loosenedFields: string[] }>(owner, 'POST', '/compliance-policies', { autoSmsPer7d: 3, contactWindowStart: '08:00', attestation: ATTESTATION_TEXT });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ loosening: true, loosenedFields: ['autoSmsPer7d', 'contactWindowStart'] });
    const stored = (await h.su.query<{ loosening_attestation: string }>('SELECT loosening_attestation FROM compliance_policy_versions WHERE id = $1', [ok.body.id])).rows[0]!;
    expect(stored.loosening_attestation).toBe(ATTESTATION_TEXT);
    const row = (await auditRows(h, owner.tenantId!, 'policy.version_created')).at(-1)!;
    expect(row.reason).toBe('LOOSENING_ATTESTED');
    expect(row.changes).toMatchObject({ loosened_field_codes: { from: null, to: ['autoSmsPer7d', 'contactWindowStart'] } });
  });

  it('R-PERM-3: activating a loosened policy is Owner-only (API, then the tenant_settings_guard trigger) and 🔒 + attested for the Owner', async () => {
    await freshReauth(h, owner);
    const loose = (await policies()).versions.find((v) => v.attested && !v.active)!;
    expect(loose).toBeDefined();
    await freshReauth(h, admin);
    const byAdmin = await call(admin, 'POST', `/compliance-policies/${loose.id}/activate`, { attestation: ATTESTATION_TEXT });
    expect([byAdmin.status, byAdmin.code]).toEqual([403, 'OWNER_REQUIRED']);
    await expect(
      withTenantTx(admin.actor(), async (tx) => {
        await sql`UPDATE tenant_settings SET active_policy_id = ${loose.id}::uuid WHERE tenant_id = app.tenant_id()`.execute(tx);
      }, { db: h.database }),
    ).rejects.toThrow(/OWNER_ONLY_SETTING/);
    expect((await call(owner, 'POST', `/compliance-policies/${loose.id}/activate`, {})).code).toBe('ATTESTATION_REQUIRED');
    await staleReauth(h, owner);
    expect((await call(owner, 'POST', `/compliance-policies/${loose.id}/activate`, { attestation: ATTESTATION_TEXT })).code).toBe('REAUTH_REQUIRED');
    await freshReauth(h, owner);
    const ok = await call<{ activePolicyId: string; loosening: boolean; changed: boolean }>(owner, 'POST', `/compliance-policies/${loose.id}/activate`, { attestation: ATTESTATION_TEXT });
    expect(ok.body).toEqual({ activePolicyId: loose.id, loosening: true, changed: true });
    const row = (await auditRows(h, owner.tenantId!, 'policy.activated')).at(-1)!;
    expect(row.reason).toBe('LOOSENING_ATTESTED');
    // re-activating the active version changes nothing
    expect((await call(owner, 'POST', `/compliance-policies/${loose.id}/activate`, { attestation: ATTESTATION_TEXT })).body).toMatchObject({ changed: false });
    // going back to a stricter version is allowed for an Admin
    const strict = (await policies()).versions.find((v) => v.versionNo === 2)!;
    expect((await call(admin, 'POST', `/compliance-policies/${strict.id}/activate`, {})).status).toBe(200);
  });

  it('the DB backs the attestation rules: an Admin cannot insert an attested version; a widened window without attestation violates the CHECK', async () => {
    const insert = (actor: ReturnType<TestClient['actor']>, start: string, att: string | null) =>
      withTenantTx(actor, async (tx) => {
        await sql`INSERT INTO compliance_policy_versions (tenant_id, id, version_no, contact_window_start, loosening_attestation, created_by_user_id)
                  VALUES (app.tenant_id(), ${randomUUID()}::uuid, 900, ${start}::time, ${att}, app.user_id())`.execute(tx);
      }, { db: h.database });
    await expect(insert(admin.actor(), '08:00', ATTESTATION_TEXT)).rejects.toThrow(/OWNER_ONLY_LOOSENING/);
    await expect(insert(owner.actor(), '08:00', null)).rejects.toThrow(/check constraint/);
  });

  it('R-AUDIT-7: versions are append-only; an UPDATE or DELETE of a version is refused even for the Owner', async () => {
    const v = (await policies()).versions[0]!;
    await expect(
      withTenantTx(owner.actor(), async (tx) => {
        await sql`UPDATE compliance_policy_versions SET auto_sms_per_7d = 0 WHERE tenant_id = app.tenant_id() AND id = ${v.id}::uuid`.execute(tx);
      }, { db: h.database }),
    ).rejects.toThrow(/permission denied|APPEND_ONLY/);
    await expect(
      withTenantTx(owner.actor(), async (tx) => {
        await sql`DELETE FROM compliance_policy_versions WHERE tenant_id = app.tenant_id() AND id = ${v.id}::uuid`.execute(tx);
      }, { db: h.database }),
    ).rejects.toThrow(/permission denied|APPEND_ONLY/);
  });

  it('validation: the window stays inside the 08:00–21:00 floor and before its end; categories only from the allow-list; caps never above the defaults', async () => {
    await freshReauth(h, owner);
    for (const body of [
      { contactWindowStart: '07:30', attestation: ATTESTATION_TEXT },
      { contactWindowEnd: '21:30', attestation: ATTESTATION_TEXT },
      { contactWindowStart: '12:00', contactWindowEnd: '11:00' },
      { autonomousCategories: ['cold_outreach'] },
      { autoSmsPer24h: 2 },
      { callAttemptsPer24h: 4 },
    ]) {
      const r = await call(owner, 'POST', '/compliance-policies', body);
      expect({ body, status: r.status, code: r.code }).toEqual({ body, status: 422, code: 'VALIDATION_FAILED' });
    }
  });

  it('two sessions proposing at the same time get distinct, consecutive version numbers', async () => {
    await freshReauth(h, owner);
    await freshReauth(h, admin);
    const before = Math.max(...(await policies()).versions.map((v) => v.versionNo));
    const rs = await Promise.all([
      call<{ versionNo: number }>(owner, 'POST', '/compliance-policies', { maxDeferrals: 2 }),
      call<{ versionNo: number }>(admin, 'POST', '/compliance-policies', { maxDeferrals: 1 }),
    ]);
    expect(rs.map((r) => r.status)).toEqual([201, 201]);
    expect(rs.map((r) => r.body.versionNo).sort()).toEqual([before + 1, before + 2]);
  });

  it('R-PERM-5: agents and Team Leads see no policy route (404)', async () => {
    const tl = await inviteViaApi(h, owner, 'team_lead');
    expect((await call(tl, 'GET', '/compliance-policies')).status).toBe(404);
    expect((await call(tl, 'POST', '/compliance-policies', { autoSmsPer7d: 1 })).status).toBe(404);
    expect((await call(tl, 'POST', `/compliance-policies/${randomUUID()}/activate`, {})).status).toBe(404);
  });
});
