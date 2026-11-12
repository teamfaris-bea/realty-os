// docs/AI_ISA.md §3.5 role table, cell by cell, against core can() (module 75; D12 proposed). The DB guards are
// the backstop (rls_smoke_ai_isa.test.ts): only the Owner turns the switch on, only the owner starts and resumes.
import { type Action, can, type ResourceFacts, type Role, type UserActor } from '@realty/core/foundation';
import { describe, expect, it } from 'vitest';

const actor = (role: Role): UserActor => ({ kind: 'user', userId: '00000000-0000-0000-0000-000000000001', tenantId: '00000000-0000-0000-0000-0000000000aa', role } as UserActor);
const NOW = Date.now();
const fresh = { reauth: { reauthenticatedAt: NOW, now: NOW } } as Partial<ResourceFacts>;
const ok = (role: Role, a: Action, f: Partial<ResourceFacts>) => can(actor(role), a, { ...fresh, ...f } as ResourceFacts).ok;

describe('AI ISA authorization matrix (R-ISA-32, R-ISA-15; §3.5)', () => {
  it('R-ISA-32: settings.ai_isa: the Owner turns it on with an attestation; an Admin only turns it off; nobody else', () => {
    expect(ok('owner', 'settings.ai_isa', { loosening: true, attested: true })).toBe(true);
    expect(ok('owner', 'settings.ai_isa', { loosening: true, attested: false })).toBe(false);
    expect(ok('admin', 'settings.ai_isa', { loosening: true, attested: true })).toBe(false);
    expect(ok('admin', 'settings.ai_isa', { loosening: false })).toBe(true);
    for (const r of ['team_lead', 'agent', 'isa', 'tc'] as Role[]) expect(ok(r, 'settings.ai_isa', { loosening: false }), r).toBe(false);
  });

  it('R-ISA-32 Q-ISA-8: opt-in for owner, admin, team lead and agent (re-auth when widening); never TC or the human ISA role', () => {
    for (const r of ['owner', 'admin', 'team_lead', 'agent'] as Role[]) expect(ok(r, 'ai_isa.optin', { loosening: true }), r).toBe(true);
    for (const r of ['isa', 'tc'] as Role[]) expect(ok(r, 'ai_isa.optin', { loosening: true }), r).toBe(false);
    expect(can(actor('agent'), 'ai_isa.optin', { loosening: true, reauth: { reauthenticatedAt: NOW - 3_600_000, now: NOW } } as ResourceFacts)).toMatchObject({ ok: false, code: 'REAUTH_REQUIRED' });
  });

  it('R-ISA-15 Q-ISA-9: start and resume are the lead owner\'s only, whatever the role', () => {
    for (const a of ['ai_isa.start', 'ai_isa.resume'] as Action[]) {
      for (const r of ['owner', 'admin', 'team_lead', 'agent'] as Role[]) {
        expect(ok(r, a, { own: true }), `${r} ${a} own`).toBe(true);
        expect(ok(r, a, { own: false, collaborator: true, team: true }), `${r} ${a} not own`).toBe(false);
      }
      for (const r of ['isa', 'tc'] as Role[]) expect(ok(r, a, { own: true }), r).toBe(false);
    }
  });

  it('R-ISA-15 Q-ISA-18: pause: Owner/Admin all, Team Lead the team, agent own and collaborated, human ISA own; never TC', () => {
    expect(ok('owner', 'ai_isa.pause', {})).toBe(true);
    expect(ok('admin', 'ai_isa.pause', {})).toBe(true);
    expect(ok('team_lead', 'ai_isa.pause', { team: true })).toBe(true);
    expect(ok('agent', 'ai_isa.pause', { collaborator: true })).toBe(true);
    expect(ok('agent', 'ai_isa.pause', { own: false })).toBe(false);
    expect(ok('isa', 'ai_isa.pause', { own: true })).toBe(true);
    expect(ok('tc', 'ai_isa.pause', { own: true })).toBe(false);
  });

  it('R-ISA-15: take over and end: Owner/Admin all, Team Lead the team, agent own only (a collaborator pauses only)', () => {
    expect(ok('agent', 'ai_isa.control', { own: true })).toBe(true);
    expect(ok('agent', 'ai_isa.control', { collaborator: true })).toBe(false);
    expect(ok('team_lead', 'ai_isa.control', { team: true })).toBe(true);
    expect(ok('isa', 'ai_isa.control', { own: true })).toBe(false);
  });
});
