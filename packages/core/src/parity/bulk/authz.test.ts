// DATA_MODEL §12 capability rows of module 63 (template.*, bulk.*, settings.batch_text), cell by cell.
import { describe, expect, it } from 'vitest';
import { type Action, type ResourceFacts, type Role, ROLES, can, instant, requiresReauth } from '../../foundation/index.js';
import { NOW, user } from './testing.js';

type Cell = 'all' | 'T' | 'O' | '—';
const ROWS: Record<string, Record<Role, Cell>> = {
  'template.personal': { owner: 'all', admin: 'all', team_lead: 'all', agent: 'all', isa: 'all', tc: 'all' },
  'template.team_manage': { owner: 'all', admin: 'all', team_lead: '—', agent: '—', isa: '—', tc: '—' },
  'bulk.run': { owner: 'all', admin: 'all', team_lead: 'T', agent: 'O', isa: 'O', tc: '—' },
  'bulk.text': { owner: 'all', admin: 'all', team_lead: 'T', agent: 'O', isa: 'O', tc: '—' },
};

const REL: Record<string, ResourceFacts> = { own: { own: true }, collab: { collaborator: true }, team: { team: true }, pond: { pond: true }, none: {} };
const allows = (cell: Cell, rel: string): boolean =>
  cell === 'all' || (cell === 'T' && ['own', 'collab', 'team'].includes(rel)) || (cell === 'O' && ['own', 'collab'].includes(rel));

describe('R-PAR-23 R-PAR-33 §12 capability rows (template.*, bulk.*)', () => {
  for (const [action, cells] of Object.entries(ROWS)) {
    for (const role of ROLES) {
      it(`${action} × ${role} = ${cells[role]}`, () => {
        for (const [rel, facts] of Object.entries(REL)) expect(can(user(role), action as Action, facts).ok, `${role} ${rel}`).toBe(allows(cells[role], rel));
        expect(can({ kind: 'system', tenantId: user(role).tenantId, via: 'worker' }, action as Action, { own: true }).ok).toBe(false);
      });
    }
  }

  it('R-PAR-35 bulk.assign: Owner/Admin any; TL only to members of their team; never to a TC; no one else', () => {
    const toAgent = (inMyTeam: boolean): ResourceFacts => ({ team: true, target: { role: 'agent', inMyTeam } });
    expect(can(user('owner'), 'bulk.assign', { target: { role: 'agent' } }).ok).toBe(true);
    expect(can(user('admin'), 'bulk.assign', { target: { role: 'isa' } }).ok).toBe(true);
    expect(can(user('team_lead'), 'bulk.assign', toAgent(true)).ok).toBe(true);
    expect(can(user('team_lead'), 'bulk.assign', toAgent(false))).toEqual({ ok: false, code: 'TARGET_NOT_ELIGIBLE' });
    expect(can(user('owner'), 'bulk.assign', { target: { role: 'tc' } })).toEqual({ ok: false, code: 'TARGET_NOT_ELIGIBLE' });
    for (const r of ['agent', 'isa', 'tc'] as Role[]) expect(can(user(r), 'bulk.assign', { own: true, target: { role: 'agent', inMyTeam: true } }).ok).toBe(false);
  });

  it('R-PAR-40 settings.batch_text: only the Owner turns it on (re-auth + attestation); Owner or Admin turn it off', () => {
    const fresh = { reauthenticatedAt: instant(NOW - 1000), now: NOW };
    expect(can(user('owner'), 'settings.batch_text', { loosening: true, attested: true, reauth: fresh })).toEqual({ ok: true });
    expect(can(user('owner'), 'settings.batch_text', { loosening: true, attested: true })).toMatchObject({ ok: false, code: 'REAUTH_REQUIRED' });
    expect(can(user('owner'), 'settings.batch_text', { loosening: true, reauth: fresh })).toEqual({ ok: false, code: 'ATTESTATION_REQUIRED' });
    expect(can(user('owner'), 'settings.batch_text', { loosening: false })).toEqual({ ok: true });
    expect(can(user('admin'), 'settings.batch_text', { loosening: false })).toEqual({ ok: true });
    expect(can(user('admin'), 'settings.batch_text', { loosening: true, attested: true, reauth: fresh })).toEqual({ ok: false, code: 'OWNER_REQUIRED' });
    expect(can(user('admin'), 'settings.batch_text', {})).toEqual({ ok: false, code: 'OWNER_REQUIRED' }); // unknown direction fails closed
    for (const r of ['team_lead', 'agent', 'isa', 'tc'] as Role[]) expect(can(user(r), 'settings.batch_text', { loosening: false }).ok).toBe(false);
    expect(requiresReauth('owner', 'settings.batch_text')).toBe(true);
  });
});
