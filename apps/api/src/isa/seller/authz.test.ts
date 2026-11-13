// The seller part's two actions against core can() (ISA-3; R-ISA-18; DATA_MODEL Part 2). Pure.
import { type Actor, type Role, type TenantId, can } from '@realty/core/foundation';
import { describe, expect, it } from 'vitest';

const T = '00000000-0000-4000-8000-000000000001' as TenantId;
const user = (role: Role): Actor => ({ kind: 'user', tenantId: T, userId: 'u', role } as unknown as Actor);
const sys = (via: 'assistant' | 'worker' | 'timer' | 'provider'): Actor => ({ kind: 'system', tenantId: T, via } as unknown as Actor);

describe('ai_isa.seller_facts and ai_isa.subject_confirm (R-ISA-18)', () => {
  it('R-ISA-18: seller facts are the assistant’s only: no role, no other system via, no support', () => {
    for (const r of ['owner', 'admin', 'team_lead', 'agent', 'isa', 'tc'] as Role[]) expect(can(user(r), 'ai_isa.seller_facts', { own: true }).ok, r).toBe(false);
    expect(can(sys('assistant'), 'ai_isa.seller_facts', {}).ok).toBe(true);
    for (const v of ['worker', 'timer', 'provider'] as const) expect(can(sys(v), 'ai_isa.seller_facts', {}).ok, v).toBe(false);
    expect(can({ kind: 'support', tenantId: T, userId: 'u', grantId: 'g' } as unknown as Actor, 'ai_isa.seller_facts', {}).ok).toBe(false);
  });

  it('R-ISA-18 R-ISA-15: confirming the subject is the lead owner’s own (owner, admin, team lead, agent: own only); isa, tc and the system never', () => {
    for (const r of ['owner', 'admin', 'team_lead', 'agent'] as Role[]) {
      expect(can(user(r), 'ai_isa.subject_confirm', { own: true }).ok, r).toBe(true);
      expect(can(user(r), 'ai_isa.subject_confirm', { own: false, team: true }).ok, r).toBe(false);
    }
    for (const r of ['isa', 'tc'] as Role[]) expect(can(user(r), 'ai_isa.subject_confirm', { own: true }).ok, r).toBe(false);
    expect(can(sys('assistant'), 'ai_isa.subject_confirm', { own: true }).ok).toBe(false);
  });
});
