// DATA_MODEL §12 rows owned by module 59/60 (tags, custom fields, smart lists; contact.edit as used by
// tag and value writes), checked cell by cell against core can().
import { describe, expect, it } from 'vitest';
import { type Action, type Actor, can, type ResourceFacts, ROLES, type Role } from '../../foundation/index.js';

const user = (role: Role): Actor => ({ kind: 'user', userId: 'u' as never, tenantId: 't' as never, role, sessionId: 's' });
const cells: Record<string, Record<Role, string>> = {
  'contact.edit': { owner: '✅', admin: '✅', team_lead: 'T', agent: 'O', isa: 'O', tc: '—' },
  'tag.create': { owner: '✅', admin: '✅', team_lead: '✅', agent: '✅', isa: '✅', tc: '—' },
  'tag.manage': { owner: '✅', admin: '✅', team_lead: '—', agent: '—', isa: '—', tc: '—' },
  'custom_field.manage': { owner: '✅', admin: '✅', team_lead: '—', agent: '—', isa: '—', tc: '—' },
  'smart_list.personal': { owner: '✅', admin: '✅', team_lead: '✅', agent: '✅', isa: '✅', tc: '✅' },
  'smart_list.team_manage': { owner: '✅', admin: '✅', team_lead: '✅', agent: '—', isa: '—', tc: '—' },
};

function expectCell(role: Role, action: Action, cell: string) {
  const facts: Record<string, ResourceFacts> = { none: {}, own: { own: true }, collab: { collaborator: true }, team: { team: true } };
  const got = Object.fromEntries(Object.entries(facts).map(([k, f]) => [k, can(user(role), action, f).ok]));
  const want =
    cell === '✅' ? { none: true, own: true, collab: true, team: true }
    : cell === 'T' ? { none: false, own: true, collab: true, team: true }
    : cell === 'O' ? { none: false, own: true, collab: true, team: false }
    : { none: false, own: false, collab: false, team: false };
  expect(got, `${action} × ${role} = ${cell}`).toEqual(want);
}

describe('DATA_MODEL §12 capability rows for tags, custom fields and smart lists', () => {
  for (const [action, row] of Object.entries(cells)) {
    for (const role of ROLES) it(`R-PAR-9 R-PAR-17 R-PAR-27 ${action} × ${role} = "${row[role]}"`, () => expectCell(role, action as Action, row[role]));
  }
  it('support actors never write tags, fields or lists; imports (system) may create tags and define fields', () => {
    const support: Actor = { kind: 'support', userId: 'u' as never, tenantId: 't' as never, grantId: 'g' };
    for (const a of Object.keys(cells) as Action[]) expect(can(support, a, {}).ok, a).toBe(false);
    const imp: Actor = { kind: 'system', tenantId: 't' as never, via: 'import' };
    expect(can(imp, 'tag.create', {}).ok).toBe(true);
    expect(can(imp, 'custom_field.manage', {}).ok).toBe(true);
    expect(can(imp, 'tag.manage', {}).ok).toBe(false);
    expect(can({ ...imp, via: 'assistant' }, 'tag.create', {}).ok).toBe(false);
  });
});
