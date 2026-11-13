import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  AUDIT_ACTIONS,
  AUDIT_ACTION_RE,
  type Action,
  type Actor,
  type DenyCode,
  REAUTH_WINDOW_MS,
  ROLES,
  type ResourceFacts,
  type Role,
  type SystemVia,
  actorAuditColumns,
  can,
  canOwnLeads,
  isAction,
  isAuditAction,
  isHumanActor,
  isRole,
  requiresReauth,
} from './authz.js';
import type { TenantId, UserId } from './ids.js';
import { type Instant, MINUTE_MS, at, instant } from './time.js';

// =================================================================================================
// DATA_MODEL §3 capability matrix, copied VERBATIM (core tests may not read files: the core purity
// lint bans Node built-ins in packages/core, tests included). If §3 changes, paste the new table
// here: every cell below is interpreted from this text, so an unmapped or changed cell fails.
// =================================================================================================
const MATRIX_MD = `
| Capability | Owner | Admin | Team Lead | Agent | ISA | TC |
|---|---|---|---|---|---|---|
| View contact card | ✅ | ✅ | T + P | O + P + Off + D | O + P + Off | D |
| View phones, emails, timeline, history | ✅ | ✅ | T + pond | O + D | O | D |
| Create contact (owned by self) | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Accept/decline own offer | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Claim from pond (5/day, 72 h cooldown, capacity 5) | — (assigns) | — (assigns) | ✅ | ✅ | ✅ | — |
| Release own lead (reason required) | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Reassign | ✅ | ✅ | within team | — | handoff own → agent/TL | — |
| Text/email/call (gate applies) | ✅ | ✅ | T | O | O | D (informational) |
| Approve own drafts and handbacks | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Approve playbooks | team + own | team + own | own | own | own | — |
| Play recording / read transcript | ✅ | ✅ | T (setting on) | O / on-call | O / on-call | D (setting off) |
| Record consent (agent entry ≤ express) | ✅ | ✅ | T | O (setting on) | O (setting on) | — |
| Lift suppression (not spam complaint) | ✅ | ✅ | — | — | — | — |
| Reinstate an opt-out | person's own action only (START, new disclosed form, signed document) |
| Deals: view / edit | ✅ / ✅ | ✅ / ✅ | T / T | O+D / O | D / — | D / dates |
| Commission (deal_financials) | ✅ | ✅ | T | own deals | — | — |
| Listings: view / edit | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ | ✅ / own | ✅ / — | ✅ / — |
| Imports (CSV, FUB) | ✅ 🔒 | ✅ 🔒 | — | — | — | — |
| Routing, ponds, teams, numbers, domains | ✅ | ✅ | — | — | — | — |
| Compliance policy | ✅ (looser needs 🔒 + attestation) | stricter only | — | — | — | — |
| Brokerage identity, recording settings, MFA roles | ✅ 🔒 | — | — | — | — | — |
| Invite/remove users, change roles | ✅ 🔒 | ✅ 🔒 (not Owners) | — | — | — | — |
| TL exception queue: view / resolve / reassign / verify | ✅ | ✅ | T | own / own / — / — | own / own / — / — | — |
| Scoreboard | ✅ | ✅ | T | self | self | — |
| Audit log | ✅ | ✅ | ownership ledger for T | — | — | — |
| Erase a contact (privacy) | ✅ 🔒 | ✅ 🔒 | — | — | — | — |
| Grant support access | ✅ 🔒 | — | — | — | — | — |
`;

const ROLE_COLUMNS: readonly Role[] = ['owner', 'admin', 'team_lead', 'agent', 'isa', 'tc'];

interface Row {
  capability: string;
  cells: Record<Role, string>;
}

function parseMatrix(md: string): Row[] {
  const lines = md.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
  const header = lines[0]!.split('|').slice(1, -1).map((c) => c.trim());
  expect(header).toEqual(['Capability', 'Owner', 'Admin', 'Team Lead', 'Agent', 'ISA', 'TC']);
  return lines.slice(2).map((line) => {
    const parts = line.split('|').slice(1, -1).map((c) => c.trim());
    const capability = parts[0]!;
    // A row with a single merged cell ("Reinstate an opt-out") applies that text to every role.
    const values = parts.length === 2 ? ROLE_COLUMNS.map(() => parts[1]!) : parts.slice(1);
    expect(values, capability).toHaveLength(6);
    return { capability, cells: Object.fromEntries(ROLE_COLUMNS.map((r, i) => [r, values[i]!])) as Record<Role, string> };
  });
}

// ---- scenario vocabulary --------------------------------------------------------------------------

const TENANT = '00000000-0000-7000-8000-00000000000a' as TenantId;
const NOW = at('2026-11-10T15:00:00Z');
const FRESH = { reauthenticatedAt: instant(NOW - 5 * MINUTE_MS), now: NOW };
const STALE = { reauthenticatedAt: instant(NOW - REAUTH_WINDOW_MS - 1), now: NOW };

/** The actor's possible relations to a resource. `none` = no relation at all. */
const RELS = {
  none: {},
  own: { own: true },
  collab: { collaborator: true },
  team: { team: true },
  pond: { pond: true },
  offer: { offer: true },
  deal: { deal: true },
  onCall: { onCall: true },
} satisfies Record<string, ResourceFacts>;
type Rel = keyof typeof RELS;
const ALL_RELS = Object.keys(RELS) as Rel[];

function user(role: Role): Actor {
  return { kind: 'user', userId: '00000000-0000-7000-8000-000000000001' as UserId, tenantId: TENANT, role, sessionId: 's1' };
}

type Expect = 'allow' | DenyCode;
interface Scenario {
  name: string;
  action: Action;
  facts: ResourceFacts;
  expect: Expect;
}

/** Scope expressions used in §3 cells → the relations they allow. */
function relsOf(expr: string, base: readonly Rel[] = ALL_RELS): Set<Rel> {
  const out = new Set<Rel>();
  for (const raw of expr.split('+').map((t) => t.trim())) {
    switch (raw) {
      case '✅':
        base.forEach((r) => out.add(r));
        break;
      case 'T': // own + team members' (collaborating counts as own)
        ['own', 'collab', 'team'].forEach((r) => out.add(r as Rel));
        break;
      case 'O': // own / collaborating
        ['own', 'collab'].forEach((r) => out.add(r as Rel));
        break;
      case 'D':
        out.add('deal');
        break;
      case 'P':
      case 'pond':
        out.add('pond');
        break;
      case 'Off':
        out.add('offer');
        break;
      case 'own':
      case 'self':
      case 'own deals':
        out.add('own');
        break;
      case '—':
        break;
      default:
        throw new Error(`unmapped §3 scope token: ${JSON.stringify(raw)} in ${JSON.stringify(expr)}`);
    }
  }
  return out;
}

/** One scenario per relation, plus re-auth probes. */
function scoped(actions: readonly Action[], allowed: Set<Rel>, o: { extra?: ResourceFacts; reauth?: boolean } = {}): Scenario[] {
  const out: Scenario[] = [];
  for (const action of actions) {
    for (const rel of ALL_RELS) {
      out.push({ name: `${action} rel=${rel}`, action, facts: { ...o.extra, ...RELS[rel], reauth: FRESH }, expect: allowed.has(rel) ? 'allow' : 'NOT_FOUND' });
    }
    const first = ALL_RELS.find((r) => allowed.has(r));
    if (first === undefined) continue;
    const facts = { ...o.extra, ...RELS[first] };
    if (o.reauth) {
      out.push({ name: `${action} 🔒 stale re-auth`, action, facts: { ...facts, reauth: STALE }, expect: 'REAUTH_REQUIRED' });
      out.push({ name: `${action} 🔒 no re-auth`, action, facts, expect: 'REAUTH_REQUIRED' });
      out.push({ name: `${action} 🔒 never re-authenticated`, action, facts: { ...facts, reauth: { reauthenticatedAt: null, now: NOW } }, expect: 'REAUTH_REQUIRED' });
    } else {
      out.push({ name: `${action} needs no re-auth`, action, facts, expect: 'allow' });
    }
  }
  return out;
}

/** A plain scope cell, optionally "✅ 🔒". `base` is what ✅ means in this row (e.g. "own offer"). */
function plain(actions: readonly Action[], base?: readonly Rel[], extra?: ResourceFacts) {
  return (_role: Role, cell: string): Scenario[] => {
    const reauth = cell.includes('🔒');
    const expr = cell.replace('🔒', '').replace(/\s*\((?:assigns)\)\s*$/, '').trim();
    return scoped(actions, relsOf(expr, base), { reauth, ...(extra ? { extra } : {}) });
  };
}

/** "view / edit"-style cells: one expression per action, in order. */
function split(actions: readonly Action[], base?: readonly Rel[]) {
  return (role: Role, cell: string): Scenario[] => {
    // A single value ("✅", "T", "—") applies to every action of the row.
    const raw = cell.split('/').map((p) => p.trim());
    const parts = raw.length === 1 ? actions.map(() => raw[0]!) : raw;
    expect(parts, `${role}: ${cell}`).toHaveLength(actions.length);
    return parts.flatMap((p, i) => (p === 'dates' ? tcDealDates() : plain([actions[i]!], base)(role, p)));
  };
}

function tcDealDates(): Scenario[] {
  return [
    ...ALL_RELS.filter((r) => r !== 'deal').map((rel) => ({ name: `deal.edit dates rel=${rel}`, action: 'deal.edit' as const, facts: { ...RELS[rel], datesOnly: true }, expect: 'NOT_FOUND' as const })),
    { name: 'deal.edit dates on own deal', action: 'deal.edit', facts: { deal: true, datesOnly: true }, expect: 'allow' },
    { name: 'deal.edit other fields', action: 'deal.edit', facts: { deal: true }, expect: 'FIELDS_NOT_PERMITTED' },
    { name: 'deal.edit explicit non-date fields', action: 'deal.edit', facts: { deal: true, datesOnly: false }, expect: 'FIELDS_NOT_PERMITTED' },
  ];
}

const REC_ACTIONS = ['recording.play', 'transcript.view'] as const;
const MEMBER_ACTIONS = ['member.invite', 'member.role', 'member.suspend', 'member.remove'] as const;

/** Row interpreters, keyed by the §3 capability text. Every §3 row must have one. */
const ROWS: Record<string, (role: Role, cell: string) => Scenario[]> = {
  'View contact card': plain(['contact.view']),
  'View phones, emails, timeline, history': plain(['contact.view_detail']),
  'Create contact (owned by self)': plain(['contact.create']),
  'Accept/decline own offer': plain(['lead.accept', 'lead.decline'], ['offer']),
  'Claim from pond (5/day, 72 h cooldown, capacity 5)': plain(['lead.claim'], ['pond']),
  'Release own lead (reason required)': plain(['lead.release'], ['own']),

  Reassign: (_role, cell) => {
    const agentTarget = { role: 'agent' as Role, inMyTeam: true };
    if (cell === '✅') {
      return [
        ...scoped(['lead.reassign'], relsOf('✅'), { extra: { target: agentTarget } }),
        { name: 'never to a TC', action: 'lead.reassign', facts: { target: { role: 'tc' } }, expect: 'TARGET_NOT_ELIGIBLE' },
        { name: 'no target fails closed', action: 'lead.reassign', facts: {}, expect: 'TARGET_NOT_ELIGIBLE' },
      ];
    }
    if (cell === 'within team') {
      return [
        ...scoped(['lead.reassign'], new Set<Rel>(['own', 'team']), { extra: { target: agentTarget } }),
        { name: 'target outside my team', action: 'lead.reassign', facts: { team: true, target: { role: 'agent', inMyTeam: false } }, expect: 'TARGET_NOT_ELIGIBLE' },
        { name: 'target team unknown', action: 'lead.reassign', facts: { team: true, target: { role: 'agent' } }, expect: 'TARGET_NOT_ELIGIBLE' },
        { name: 'TC in my team', action: 'lead.reassign', facts: { team: true, target: { role: 'tc', inMyTeam: true } }, expect: 'TARGET_NOT_ELIGIBLE' },
      ];
    }
    if (cell === 'handoff own → agent/TL') {
      return [
        ...scoped(['lead.reassign'], new Set<Rel>(['own']), { extra: { target: { role: 'agent' } } }),
        { name: 'handoff own → team lead', action: 'lead.reassign', facts: { own: true, target: { role: 'team_lead' } }, expect: 'allow' },
        ...(['owner', 'admin', 'isa', 'tc'] as Role[]).map((r) => ({ name: `handoff own → ${r}`, action: 'lead.reassign' as const, facts: { own: true, target: { role: r } }, expect: 'TARGET_NOT_ELIGIBLE' as const })),
      ];
    }
    expect(cell).toBe('—');
    return scoped(['lead.reassign'], new Set(), { extra: { target: agentTarget } });
  },

  'Text/email/call (gate applies)': (role, cell) => {
    if (cell === 'D (informational)') {
      return [
        ...scoped(['comms.send', 'comms.call'], relsOf('D'), { extra: { purpose: 'informational' } }),
        ...(['comms.send', 'comms.call'] as const).flatMap((action) => [
          { name: `${action} marketing`, action, facts: { deal: true, purpose: 'marketing' as const }, expect: 'PURPOSE_NOT_PERMITTED' as const },
          { name: `${action} unknown purpose`, action, facts: { deal: true }, expect: 'PURPOSE_NOT_PERMITTED' as const },
        ]),
      ];
    }
    return plain(['comms.send', 'comms.call'], undefined, { purpose: 'marketing' })(role, cell);
  },

  'Approve own drafts and handbacks': plain(['draft.approve'], ['own']),

  'Approve playbooks': (_role, cell) => {
    const a = 'playbook.approve' as const;
    const team = { name: 'team playbook', action: a, facts: { teamPlaybook: true } };
    const mine = { name: 'my personal playbook', action: a, facts: { own: true } };
    const others = { name: "someone else's personal playbook", action: a, facts: { team: true } };
    const nothing = { name: 'no relation', action: a, facts: {} };
    if (cell === 'team + own') return [{ ...team, expect: 'allow' }, { ...mine, expect: 'allow' }, { ...others, expect: 'NOT_FOUND' }, { ...nothing, expect: 'NOT_FOUND' }];
    if (cell === 'own') return [{ ...team, expect: 'NOT_FOUND' }, { ...mine, expect: 'allow' }, { ...others, expect: 'NOT_FOUND' }, { ...nothing, expect: 'NOT_FOUND' }];
    expect(cell).toBe('—');
    return [team, mine, others, nothing].map((s) => ({ ...s, expect: 'NOT_FOUND' as const }));
  },

  // Recording scope follows R-PERM-8 / app.recording_scope(): `own` = contact owner or the agent on
  // the call (no collaborator branch); TL adds the team when team_lead_recording_access is on; TC
  // adds deal contacts when tc_recording_access is on (default off).
  'Play recording / read transcript': (_role, cell) => {
    const on = { teamLeadRecordingAccess: true, tcRecordingAccess: true };
    const off = { teamLeadRecordingAccess: false, tcRecordingAccess: false };
    const recOwn = new Set<Rel>(['own', 'onCall']);
    if (cell === '✅') return scoped(REC_ACTIONS, relsOf('✅'), { extra: { settings: off } });
    if (cell === 'T (setting on)') {
      return [
        ...scoped(REC_ACTIONS, new Set<Rel>([...recOwn, 'team']), { extra: { settings: on } }),
        ...scoped(REC_ACTIONS, recOwn, { extra: { settings: off } }),
        ...scoped(REC_ACTIONS, recOwn, {}), // settings unknown: fail closed to `own`
      ];
    }
    if (cell === 'O / on-call') return [...scoped(REC_ACTIONS, recOwn, { extra: { settings: on } }), ...scoped(REC_ACTIONS, recOwn, { extra: { settings: off } })];
    expect(cell).toBe('D (setting off)');
    return [
      ...scoped(REC_ACTIONS, recOwn, { extra: { settings: off } }), // the default: off
      ...scoped(REC_ACTIONS, new Set<Rel>([...recOwn, 'deal']), { extra: { settings: on } }),
    ];
  },

  'Record consent (agent entry ≤ express)': (role, cell) => {
    if (cell === 'O (setting on)') {
      return [
        ...scoped(['consent.record'], relsOf('O'), { extra: { settings: { agentConsentEntryAllowed: true } } }),
        ...scoped(['consent.record'], new Set(), { extra: { settings: { agentConsentEntryAllowed: false } } }),
        ...scoped(['consent.record'], new Set(), {}),
      ];
    }
    return plain(['consent.record'])(role, cell);
  },

  'Lift suppression (not spam complaint)': (_role, cell) => {
    const a = 'suppression.lift' as const;
    if (cell === '✅') {
      return [
        ...scoped([a], relsOf('✅'), { extra: { suppressionReason: 'manual' } }),
        { name: 'spam complaint is never liftable (R-CONSENT-9)', action: a, facts: { suppressionReason: 'spam_complaint' }, expect: 'SUPPRESSION_NOT_LIFTABLE' },
        { name: 'unknown reason fails closed', action: a, facts: {}, expect: 'SUPPRESSION_NOT_LIFTABLE' },
      ];
    }
    expect(cell).toBe('—');
    return [...scoped([a], new Set(), { extra: { suppressionReason: 'manual' } }), { name: 'spam complaint', action: a, facts: { suppressionReason: 'spam_complaint' }, expect: 'NOT_FOUND' }];
  },

  // R-CONSENT-10: no staff role can override an opt-out; only the person's own action, processed
  // by the system from the provider (see the system-actor tests below).
  'Reinstate an opt-out': (_role, cell) => {
    expect(cell).toMatch(/^person's own action only/);
    return scoped(['consent.reinstate'], new Set());
  },

  'Deals: view / edit': split(['deal.view', 'deal.edit']),

  // R-PERM-10: the deal owner, Owner/Admin, or the deal owner's Team Lead (no collaborator branch).
  'Commission (deal_financials)': (role, cell) => (cell === 'T' ? scoped(['deal.financials'], new Set<Rel>(['own', 'team'])) : plain(['deal.financials'])(role, cell)),

  'Listings: view / edit': split(['listing.view', 'listing.edit']),
  'Imports (CSV, FUB)': plain(['import.run']),
  'Routing, ponds, teams, numbers, domains': plain(['settings.routing', 'settings.numbers']),

  'Compliance policy': (_role, cell) => {
    const a = 'settings.compliance' as const;
    if (cell === '✅ (looser needs 🔒 + attestation)') {
      return [
        { name: 'stricter, no re-auth', action: a, facts: { loosening: false }, expect: 'allow' },
        { name: 'looser + attested + fresh re-auth', action: a, facts: { loosening: true, attested: true, reauth: FRESH }, expect: 'allow' },
        { name: 'looser + attested + stale re-auth', action: a, facts: { loosening: true, attested: true, reauth: STALE }, expect: 'REAUTH_REQUIRED' },
        { name: 'looser without attestation', action: a, facts: { loosening: true, reauth: FRESH }, expect: 'ATTESTATION_REQUIRED' },
        { name: 'unknown direction is treated as looser', action: a, facts: { attested: true }, expect: 'REAUTH_REQUIRED' },
        { name: 'unknown direction without attestation', action: a, facts: { reauth: FRESH }, expect: 'ATTESTATION_REQUIRED' },
      ];
    }
    if (cell === 'stricter only') {
      return [
        { name: 'stricter', action: a, facts: { loosening: false }, expect: 'allow' },
        { name: 'looser (even attested, re-authenticated)', action: a, facts: { loosening: true, attested: true, reauth: FRESH }, expect: 'OWNER_REQUIRED' },
        { name: 'unknown direction', action: a, facts: {}, expect: 'OWNER_REQUIRED' },
      ];
    }
    expect(cell).toBe('—');
    return [
      { name: 'stricter', action: a, facts: { loosening: false, reauth: FRESH }, expect: 'NOT_FOUND' },
      { name: 'looser', action: a, facts: { loosening: true, attested: true, reauth: FRESH }, expect: 'NOT_FOUND' },
    ];
  },

  'Brokerage identity, recording settings, MFA roles': plain(['settings.identity']),

  'Invite/remove users, change roles': (role, cell) => {
    if (cell === '✅ 🔒 (not Owners)') {
      return [
        ...scoped(MEMBER_ACTIONS, relsOf('✅'), { extra: { target: { role: 'agent' } }, reauth: true }),
        ...MEMBER_ACTIONS.flatMap((action) => [
          { name: `${action} on an Owner`, action, facts: { target: { role: 'owner' as Role }, reauth: FRESH }, expect: 'OWNER_REQUIRED' as const },
          { name: `${action} granting Owner`, action, facts: { target: { role: 'admin' as Role, newRole: 'owner' as Role }, reauth: FRESH }, expect: 'OWNER_REQUIRED' as const },
          { name: `${action} without a target`, action, facts: { reauth: FRESH }, expect: 'TARGET_NOT_ELIGIBLE' as const },
        ]),
      ];
    }
    if (cell === '✅ 🔒') {
      return [
        ...scoped(MEMBER_ACTIONS, relsOf('✅'), { extra: { target: { role: 'owner' } }, reauth: true }),
        ...MEMBER_ACTIONS.map((action) => ({ name: `${action} granting Owner`, action, facts: { target: { role: 'agent' as Role, newRole: 'owner' as Role }, reauth: FRESH }, expect: 'allow' as const })),
      ];
    }
    return plain(MEMBER_ACTIONS, undefined, { target: { role: 'agent' } })(role, cell);
  },

  'TL exception queue: view / resolve / reassign / verify': split(['exception.view', 'exception.resolve', 'exception.reassign', 'exception.verify']),
  Scoreboard: plain(['scoreboard.view']),

  'Audit log': (role, cell) => {
    if (cell === 'ownership ledger for T') return [...scoped(['audit.view'], new Set()), ...scoped(['ownership_ledger.view'], relsOf('T'))];
    return plain(['audit.view', 'ownership_ledger.view'])(role, cell);
  },

  'Erase a contact (privacy)': plain(['contact.erase']),
  'Grant support access': plain(['support.grant']),
};

const MATRIX = parseMatrix(MATRIX_MD);

describe('R-PERM-1 generated can() matrix: one case per DATA_MODEL §3 cell', () => {
  it('R-PERM-1 every §3 row has an interpreter and every interpreter a row', () => {
    expect(MATRIX.map((r) => r.capability).sort()).toEqual(Object.keys(ROWS).sort());
    expect(MATRIX.length * ROLE_COLUMNS.length).toBe(27 * 6);
  });

  for (const row of MATRIX) {
    for (const role of ROLE_COLUMNS) {
      const cell = row.cells[role];
      it(`R-PERM-1 ${row.capability} × ${role} = "${cell}"`, () => {
        const interpret = ROWS[row.capability];
        expect(interpret, row.capability).toBeDefined();
        const scenarios = interpret!(role, cell);
        expect(scenarios.length).toBeGreaterThan(0);
        for (const s of scenarios) {
          const r = can(user(role), s.action, s.facts);
          const got: Expect = r.ok ? 'allow' : r.code;
          expect(got, `${role} ${s.name}`).toBe(s.expect);
          if (!r.ok) expect(r.reauth === true, `${role} ${s.name}: reauth flag`).toBe(r.code === 'REAUTH_REQUIRED');
        }
      });
    }
  }

  it('R-PERM-1 every Action is exercised by at least one §3 cell (data.export, number.release, support.revoke are covered below)', () => {
    const exercised = new Set<Action>();
    for (const row of MATRIX) for (const role of ROLE_COLUMNS) for (const s of ROWS[row.capability]!(role, row.cells[role])) exercised.add(s.action);
    const notInMatrix = ACTIONS.filter((a) => !exercised.has(a));
    // Phase 2-3 actions are DATA_MODEL §8 rows (not §3); each module tests its own row.
    const PHASE_2_3: Action[] = ['integration.view', 'integration.manage'];
    // FUB parity actions are DATA_MODEL §12 rows; each module tests its own (module 57: apps/api/src/people/matrix.test.ts;
    // modules 59-60: packages/core/src/parity/lists/authz.test.ts).
    PHASE_2_3.push('contact.edit', 'note.write', 'note.delete', 'activity.log', 'collaborator.manage', 'settings.stage_labels');
    PHASE_2_3.push('template.personal', 'template.team_manage', 'bulk.run', 'bulk.assign', 'bulk.text', 'settings.batch_text'); // parity L3: DATA_MODEL §12 rows, tested in parity/bulk/authz.test.ts
    PHASE_2_3.push('lead_email_review.view', 'lead_email_review.decide'); // module 22 lead-email slice: DATA_MODEL §8 row, tested in apps/api/src/leadEmail/leadEmail.test.ts (role × route vs can())
    PHASE_2_3.push('mail_sync.manage'); // module 68 (D2): DATA_MODEL §8 Gmail rows, tested in apps/api/src/mailSync/mailSync.test.ts (role × route)
    PHASE_2_3.push('owner_view.view', 'source_cost.edit', 'goal.view', 'goal.manage'); // module 33: DATA_MODEL §8 rows, tested in apps/api/src/insights/authz.test.ts (role × route vs can())
    PHASE_2_3.push('milestone.confirm', 'milestone_template.manage'); // module 31: DATA_MODEL §8 row (and a flagged settings action), tested in apps/api/src/transactions/authz.test.ts (role × route vs can())
    PHASE_2_3.push('playbook.auto_enroll_stage'); // parity module 67: DATA_MODEL §12 row, tested in apps/api/src/stageAutomation/stageAutomation.test.ts (role × route vs can())
    PHASE_2_3.push('coaching.view', 'coaching.team_view', 'coaching.settings'); // module 36: DATA_MODEL Part 2 row "Call reviews" / "Coaching settings", tested in apps/api/src/coaching/matrix.test.ts (role × route vs can())
    PHASE_2_3.push('cma.prepare'); // module 71 (D9): DATA_MODEL §8 row, tested in apps/api/src/cma/authz.test.ts (role × route vs can())
    PHASE_2_3.push('document.upload', 'document.upload_listing', 'document.upload_contact', 'document.view', 'document.download', 'document.share', 'document.hold'); // module 42: tested in apps/api/src/documents/authz.test.ts (role × route vs can())
    PHASE_2_3.push('gbp.view', 'gbp.reply'); // module 53: DATA_MODEL Part 2 gbp_reviews (members read) and the reply rule R-GBP-1, tested in apps/api/src/gbp/adversarial.test.ts (role × route vs can())
    PHASE_2_3.push('portal.view', 'portal.manage'); // module 45: DATA_MODEL §8 "Client portal" row (split), tested in apps/api/src/portal/staff/authz.test.ts (role × route vs can())
    PHASE_2_3.push('listing.reassign'); // b7 review ownership-data/F2: DATA_MODEL §8 row, tested in apps/api/src/workspace/listingAgent.test.ts (role × route vs can())
    PHASE_2_3.push('ads.view', 'ads.cap_set', 'ads.shift_decide', 'ads.campaign_manage'); // module 52: DATA_MODEL §8 ads rows, tested in apps/api/src/ads/adversarial.test.ts (role × action vs can()) and the ads route tests
    PHASE_2_3.push('settings.ai_isa', 'ai_isa.optin', 'ai_isa.view', 'ai_isa.start', 'ai_isa.pause', 'ai_isa.resume', 'ai_isa.control', 'ai_isa.handoff'); // module 75 (D12 proposed): docs/AI_ISA.md §3.5, tested in apps/api/src/isa/authz.test.ts (role × action vs can())
    const PARITY_LISTS: Action[] = ['contact.edit', 'tag.create', 'tag.manage', 'custom_field.manage', 'smart_list.personal', 'smart_list.team_manage'];
    expect(notInMatrix.filter((a) => !PHASE_2_3.includes(a) && !PARITY_LISTS.includes(a)).sort()).toEqual(['data.export', 'number.release', 'support.revoke', 'system.jobs', 'system.view']);
  });

  it('system.view and system.jobs (System page, not a §3 row): Owner and Admin only, no re-auth; never support or the system', () => {
    for (const a of ['system.view', 'system.jobs'] as Action[]) {
      expect(can(user('owner'), a, {})).toEqual({ ok: true });
      expect(can(user('admin'), a, {})).toEqual({ ok: true });
      for (const role of ['team_lead', 'agent', 'isa', 'tc'] as Role[]) expect(can(user(role), a, {})).toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(can({ kind: 'support', userId: 'u' as never, tenantId: user('owner').tenantId, grantId: 'g' }, a, {})).toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(can({ kind: 'system', tenantId: user('owner').tenantId, via: 'worker' }, a, {})).toEqual({ ok: false, code: 'NOT_FOUND' });
    }
  });
});

describe('R-PERM-13 sensitive actions need re-authentication within 15 minutes', () => {
  // exports, role changes, imports, compliance loosening, erasure, support grants, number release
  const cases: { action: Action; facts: ResourceFacts }[] = [
    { action: 'data.export', facts: {} },
    { action: 'member.role', facts: { target: { role: 'agent', newRole: 'team_lead' } } },
    { action: 'import.run', facts: {} },
    { action: 'settings.compliance', facts: { loosening: true, attested: true } },
    { action: 'contact.erase', facts: {} },
    { action: 'support.grant', facts: {} },
    { action: 'number.release', facts: {} },
  ];
  const owner = user('owner');

  for (const c of cases) {
    it(`R-PERM-13 ${c.action}: exactly 15 min is fresh, 15 min + 1 ms is stale`, () => {
      expect(can(owner, c.action, { ...c.facts, reauth: { reauthenticatedAt: instant(NOW - REAUTH_WINDOW_MS), now: NOW } })).toEqual({ ok: true });
      expect(can(owner, c.action, { ...c.facts, reauth: { reauthenticatedAt: instant(NOW - REAUTH_WINDOW_MS - 1), now: NOW } })).toEqual({
        ok: false,
        code: 'REAUTH_REQUIRED',
        reauth: true,
      });
      expect(can(owner, c.action, c.facts)).toEqual({ ok: false, code: 'REAUTH_REQUIRED', reauth: true });
      // A re-auth stamp from the future (clock skew, forged input) is not fresh.
      expect(can(owner, c.action, { ...c.facts, reauth: { reauthenticatedAt: instant(NOW + 1), now: NOW } })).toMatchObject({ code: 'REAUTH_REQUIRED' });
      expect(requiresReauth('owner', c.action)).toBe(true);
    });
  }

  it('R-PERM-13 Admins need re-auth for exports and number release too; revoking support access does not', () => {
    expect(can(user('admin'), 'data.export', {})).toMatchObject({ code: 'REAUTH_REQUIRED' });
    expect(can(user('admin'), 'number.release', { reauth: FRESH })).toEqual({ ok: true });
    expect(can(user('owner'), 'support.revoke', {})).toEqual({ ok: true });
    expect(can(user('admin'), 'support.revoke', {})).toEqual({ ok: false, code: 'NOT_FOUND' });
    for (const role of ['team_lead', 'agent', 'isa', 'tc'] as Role[]) {
      for (const a of ['data.export', 'number.release', 'support.revoke'] as Action[]) expect(can(user(role), a, { reauth: FRESH })).toEqual({ ok: false, code: 'NOT_FOUND' });
    }
    expect(requiresReauth('owner', 'contact.view')).toBe(false);
    expect(requiresReauth('agent', 'import.run')).toBe(false);
  });

  // R-PERM-5 (core half: denials are NOT_FOUND; the HTTP 404 mapping is api/platform's)
  it('R-PERM-13 an unauthorized role never learns that re-auth (or an Owner) would be needed: plain NOT_FOUND', () => {
    for (const role of ['team_lead', 'agent', 'isa', 'tc'] as Role[]) {
      expect(can(user(role), 'member.role', { target: { role: 'owner' }, reauth: STALE })).toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(can(user(role), 'settings.compliance', { loosening: true })).toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(can(user(role), 'contact.erase', {})).toEqual({ ok: false, code: 'NOT_FOUND' });
    }
  });
});

describe('R-PERM-15 TCs never own or claim leads', () => {
  it('R-PERM-15 a TC cannot create, accept, decline, claim, release or receive a lead', () => {
    const tc = user('tc');
    for (const [action, facts] of [
      ['contact.create', {}],
      ['lead.accept', { offer: true }],
      ['lead.decline', { offer: true }],
      ['lead.claim', { pond: true }],
      ['lead.release', { own: true }],
      ['lead.reassign', { own: true, target: { role: 'agent' } }],
    ] as [Action, ResourceFacts][]) {
      expect(can(tc, action, facts)).toEqual({ ok: false, code: 'NOT_FOUND' });
    }
    for (const role of ROLES) {
      expect(can(user(role), 'lead.reassign', { own: true, team: true, target: { role: 'tc', inMyTeam: true } }).ok).toBe(false);
    }
    expect(can({ kind: 'system', tenantId: TENANT, via: 'worker' }, 'lead.reassign', { target: { role: 'tc' } })).toEqual({ ok: false, code: 'TARGET_NOT_ELIGIBLE' });
    expect(canOwnLeads('tc')).toBe(false);
    for (const role of ['owner', 'admin', 'team_lead', 'agent', 'isa'] as Role[]) expect(canOwnLeads(role)).toBe(true);
  });
});

describe('system and support actors', () => {
  const sys = (via: SystemVia): Actor => ({ kind: 'system', tenantId: TENANT, via, jobId: 'j1' });
  const support: Actor = { kind: 'support', userId: '00000000-0000-7000-8000-0000000000ff' as UserId, tenantId: TENANT, grantId: 'g1' };

  // R-GATE-9 and R-PERM-10 (core half; both are DB-enforced and smoke-tested)
  it('the system never places calls, never touches commission, never approves anything', () => {
    for (const via of ['timer', 'provider', 'assistant', 'import', 'worker'] as SystemVia[]) {
      for (const action of ['comms.call', 'deal.financials', 'draft.approve', 'playbook.approve', 'suppression.lift', 'settings.compliance', 'import.run', 'member.role', 'recording.play', 'exception.verify'] as Action[]) {
        expect(can(sys(via), action, {}), `${via} ${action}`).toEqual({ ok: false, code: 'NOT_FOUND' });
      }
    }
  });

  it('the assistant may send through the gate; imports never send (history only)', () => {
    expect(can(sys('assistant'), 'comms.send', {})).toEqual({ ok: true });
    expect(can(sys('timer'), 'comms.send', {})).toEqual({ ok: true });
    expect(can(sys('import'), 'comms.send', {})).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  // R-CONSENT-10 (authorization half; projectConsent and DB policies are compliance/db's)
  it('an opt-out is reinstated only through the person’s own inbound action (provider), never by staff or the assistant', () => {
    expect(can(sys('provider'), 'consent.reinstate', {})).toEqual({ ok: true });
    for (const via of ['timer', 'assistant', 'import', 'worker'] as SystemVia[]) expect(can(sys(via), 'consent.reinstate', {})).toEqual({ ok: false, code: 'NOT_FOUND' });
    for (const role of ROLES) expect(can(user(role), 'consent.reinstate', { own: true, reauth: FRESH })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(can(support, 'consent.reinstate', {})).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  // R-PERM-11 (authorization half; grant expiry is enforced by the DB and session resolution)
  it('support is read-only: tenant-wide reads, no writes, no recordings, no commission', () => {
    for (const a of ['contact.view', 'contact.view_detail', 'deal.view', 'listing.view', 'exception.view', 'scoreboard.view', 'audit.view', 'ownership_ledger.view'] as Action[]) {
      expect(can(support, a, {}), a).toEqual({ ok: true });
    }
    const writes = ACTIONS.filter((a) => !/\.(view|view_detail)$/.test(a));
    for (const a of writes) expect(can(support, a, { own: true, reauth: FRESH, target: { role: 'agent' } }), a).toEqual({ ok: false, code: 'NOT_FOUND' });
    for (const a of ['recording.play', 'transcript.view', 'deal.financials'] as Action[]) expect(can(support, a, {})).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('an action string outside the registry (untyped caller) is NOT_FOUND', () => {
    expect(can(user('owner'), 'contact.delete_everything' as Action, {})).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('a resource from another tenant is NOT_FOUND for every actor, whatever the other facts say', () => {
    const other = '00000000-0000-7000-8000-00000000000b' as TenantId;
    for (const actor of [user('owner'), sys('worker'), support]) {
      expect(can(actor, 'contact.view', { tenantId: other, own: true })).toEqual({ ok: false, code: 'NOT_FOUND' });
    }
    expect(can(user('owner'), 'contact.view', { tenantId: TENANT })).toEqual({ ok: true });
  });
});

describe('can() is total and fails closed (property)', () => {
  const arbRole = fc.constantFrom(...ROLES);
  const arbActor: fc.Arbitrary<Actor> = fc.oneof(
    arbRole.map((role) => user(role)),
    fc.constantFrom<SystemVia>('timer', 'provider', 'assistant', 'import', 'worker').map((via) => ({ kind: 'system', tenantId: TENANT, via }) as Actor),
    fc.constant<Actor>({ kind: 'support', userId: '00000000-0000-7000-8000-0000000000ff' as UserId, tenantId: TENANT, grantId: 'g' }),
  );
  const arbFacts: fc.Arbitrary<ResourceFacts> = fc.record(
    {
      own: fc.boolean(),
      collaborator: fc.boolean(),
      team: fc.boolean(),
      pond: fc.boolean(),
      offer: fc.boolean(),
      deal: fc.boolean(),
      onCall: fc.boolean(),
      teamPlaybook: fc.boolean(),
      purpose: fc.constantFrom('informational' as const, 'marketing' as const),
      target: fc.record({ role: arbRole, inMyTeam: fc.boolean(), newRole: arbRole }, { requiredKeys: ['role'] }),
      loosening: fc.boolean(),
      attested: fc.boolean(),
      suppressionReason: fc.constantFrom('manual', 'spam_complaint', 'bounce'),
      datesOnly: fc.boolean(),
      settings: fc.record({ teamLeadRecordingAccess: fc.boolean(), tcRecordingAccess: fc.boolean(), agentConsentEntryAllowed: fc.boolean() }),
      reauth: fc.constantFrom(FRESH, STALE),
    },
    { requiredKeys: [] },
  );
  const NO_RELATION_FACTS: (keyof ResourceFacts)[] = ['own', 'collaborator', 'team', 'pond', 'offer', 'deal', 'onCall', 'teamPlaybook'];

  it('returns a well-formed decision for every input; REAUTH_REQUIRED always carries reauth: true', () => {
    fc.assert(
      fc.property(arbActor, fc.constantFrom(...ACTIONS), arbFacts, (actor, action, facts) => {
        const r = can(actor, action, facts);
        if (r.ok) return Object.keys(r).length === 1;
        return (r.code === 'REAUTH_REQUIRED') === (r.reauth === true);
      }),
      { numRuns: 3000 },
    );
  });

  it('adding a relationship never turns an allow into a deny for a user (monotone in relations)', () => {
    fc.assert(
      fc.property(arbRole, fc.constantFrom(...ACTIONS), arbFacts, fc.constantFrom(...NO_RELATION_FACTS.filter((k) => k !== 'teamPlaybook')), (role, action, facts, extraRel) => {
        const before = can(user(role), action, facts);
        if (!before.ok) return true;
        return can(user(role), action, { ...facts, [extraRel]: true }).ok;
      }),
      { numRuns: 3000 },
    );
  });

  it('removing the re-auth stamp never allows anything that needed it', () => {
    fc.assert(
      fc.property(arbRole, fc.constantFrom(...ACTIONS), arbFacts, (role, action, facts) => {
        const fresh = can(user(role), action, { ...facts, reauth: FRESH });
        const none = can(user(role), action, { ...facts, reauth: undefined });
        return !none.ok || fresh.ok;
      }),
      { numRuns: 2000 },
    );
  });
});

describe('registries and actor shape', () => {
  it('Action and AuditAction lists have no duplicates; audit actions satisfy the audit_log CHECK', () => {
    expect(new Set(ACTIONS).size).toBe(ACTIONS.length);
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    for (const a of AUDIT_ACTIONS) expect(a).toMatch(AUDIT_ACTION_RE);
    for (const a of ACTIONS) expect(a).toMatch(AUDIT_ACTION_RE);
    expect(isAction('contact.view')).toBe(true);
    expect(isAction('contact.delete_everything')).toBe(false);
    expect(isAuditAction('contact.erase')).toBe(true); // literal written by app.erase_contact
    expect(isAuditAction('recording.play')).toBe(true);
    expect(isAuditAction('nope')).toBe(false);
    expect(isRole('tc')).toBe(true);
    expect(isRole('superuser')).toBe(false);
  });

  // R-AUDIT-5 (registry half: the union exists; auditing each action is api's)
  it('every always-audited kind has an AuditAction', () => {
    const required = [
      'session.login', 'session.logout', 'session.tenant_switched',
      'member.invited', 'member.role_changed', 'member.suspended', 'member.removed',
      'ownership.accept', 'ownership.claim', 'ownership.release', 'ownership.reassign', 'ownership.isa_handoff',
      'consent.recorded', 'suppression.lifted', 'consent.opt_out_received',
      'recording.play', 'transcript.view',
      'import.approved', 'import.committed', 'import.verified', 'import.reverted',
      'contact.deleted', 'contact.restored', 'contact.merged', 'contact.erase',
      'settings.changed', 'policy.version_created', 'routing.changed', 'pond.changed',
      'number.acquired', 'number.released', 'playbook.approved', 'playbook.revoked',
      'draft.approved_with_edits', 'exception.resolved', 'exception.verified',
      'support.granted', 'support.revoked', 'definer.maintenance',
    ];
    for (const a of required) expect(isAuditAction(a), a).toBe(true);
  });

  it('actorAuditColumns maps each actor kind onto audit_log columns', () => {
    expect(actorAuditColumns(user('agent'))).toEqual({ actorKind: 'user', actorVia: 'api', actorUserId: '00000000-0000-7000-8000-000000000001', actorRole: 'agent', supportGrantId: null });
    expect(actorAuditColumns({ kind: 'system', tenantId: TENANT, via: 'timer' })).toEqual({ actorKind: 'system', actorVia: 'timer', actorUserId: null, actorRole: null, supportGrantId: null });
    expect(actorAuditColumns({ kind: 'support', userId: 'u' as UserId, tenantId: TENANT, grantId: 'g' })).toEqual({ actorKind: 'support', actorVia: 'api', actorUserId: 'u', actorRole: null, supportGrantId: 'g' });
    expect(isHumanActor(user('tc'))).toBe(true);
    expect(isHumanActor({ kind: 'system', tenantId: TENANT, via: 'assistant' })).toBe(false);
  });

  it('time constants used by the matrix', () => {
    const t: Instant = NOW;
    expect(REAUTH_WINDOW_MS).toBe(15 * MINUTE_MS);
    expect(typeof t).toBe('number');
  });
});
