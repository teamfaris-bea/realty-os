// DATA_MODEL §8 row "Coaching settings" (module 36's coaching.settings), cell by cell. Owner decision 2026-11-11 (the
// Gmail sync rule, E283): only the Owner turns call reviews on, or lets Team Leads see them, and re-authenticates to
// do it ("loosening"); an Admin may act only when nothing loosens, which is turning call reviews off, with no
// re-auth, because turning off only tightens. This is the core half: the API refuses an Admin anything but turning
// call reviews off, and tenant_settings_p23_guard (0059) is the backstop.
import { describe, expect, it } from 'vitest';
import { type Actor, MINUTE_MS, REAUTH_WINDOW_MS, type Role, type TenantId, type UserId, at, can, instant, requiresReauth } from '../foundation/index.js';

const TENANT = '00000000-0000-7000-8000-00000000000a' as TenantId;
const NOW = at('2026-11-11T15:00:00Z');
const FRESH = { reauthenticatedAt: instant(NOW - 5 * MINUTE_MS), now: NOW };
const STALE = { reauthenticatedAt: instant(NOW - REAUTH_WINDOW_MS - 1), now: NOW };
const user = (role: Role): Actor => ({ kind: 'user', userId: '00000000-0000-7000-8000-0000000000b1' as UserId, tenantId: TENANT, role, sessionId: 's' });
const SUPPORT: Actor = { kind: 'support', userId: '00000000-0000-7000-8000-0000000000c1' as UserId, tenantId: TENANT, grantId: 'g' };
const SYSTEM: Actor = { kind: 'system', tenantId: TENANT, via: 'worker' };

describe('coaching.settings: Owner ✅ 🔒 (on needs the platform pack cleared) | Admin off only | nobody else', () => {
  it('E283 R-COACH-1: an Admin may change coaching settings only when nothing loosens (turning call reviews off), with no re-auth: off only tightens', () => {
    expect(can(user('admin'), 'coaching.settings', { loosening: false })).toEqual({ ok: true });
    expect(can(user('admin'), 'coaching.settings', { loosening: false, reauth: STALE })).toEqual({ ok: true });
    expect(requiresReauth('admin', 'coaching.settings')).toBe(false);
    // turning call reviews or Team Lead visibility on is the Owner's alone, a fresh re-auth or not
    expect(can(user('admin'), 'coaching.settings', { loosening: true, reauth: FRESH })).toEqual({ ok: false, code: 'OWNER_REQUIRED' });
    expect(can(user('admin'), 'coaching.settings', { loosening: true })).toEqual({ ok: false, code: 'OWNER_REQUIRED' });
    // a change of unknown direction fails closed
    expect(can(user('admin'), 'coaching.settings', {})).toEqual({ ok: false, code: 'OWNER_REQUIRED' });
  });

  it('R-COACH-1: the Owner keeps re-auth when loosening (call reviews or Team Lead visibility on) and needs none when not', () => {
    // the same 15-minute re-auth window as R-PERM-13's actions (REAUTH_REQUIRED), though coaching is not one of them
    expect(can(user('owner'), 'coaching.settings', { loosening: true })).toEqual({ ok: false, code: 'REAUTH_REQUIRED', reauth: true });
    expect(can(user('owner'), 'coaching.settings', { loosening: true, reauth: STALE })).toEqual({ ok: false, code: 'REAUTH_REQUIRED', reauth: true });
    expect(can(user('owner'), 'coaching.settings', { loosening: true, reauth: FRESH })).toEqual({ ok: true });
    expect(can(user('owner'), 'coaching.settings', {})).toEqual({ ok: false, code: 'REAUTH_REQUIRED', reauth: true });
    expect(can(user('owner'), 'coaching.settings', { loosening: false })).toEqual({ ok: true });
    expect(can(user('owner'), 'coaching.settings', { loosening: false, reauth: STALE })).toEqual({ ok: true });
    expect(requiresReauth('owner', 'coaching.settings')).toBe(true);
  });

  it('R-COACH-3: Team Leads, agents, ISAs, TCs, support and the system never change coaching settings, and learn nothing more than NOT_FOUND', () => {
    for (const role of ['team_lead', 'agent', 'isa', 'tc'] as Role[]) {
      for (const loosening of [false, true]) expect(can(user(role), 'coaching.settings', { loosening, reauth: FRESH })).toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(requiresReauth(role, 'coaching.settings')).toBe(false);
    }
    for (const actor of [SUPPORT, SYSTEM]) expect(can(actor, 'coaching.settings', { loosening: false })).toEqual({ ok: false, code: 'NOT_FOUND' });
  });
});
