// Saved v1 definitions of every shape that existed before the exclusions (lane people-filters), used to prove
// backward compatibility: each still parses and compiles to the very plan the pre-exclusion compiler produced
// (v1Plans.golden.json, generated from commit 1781638 and never regenerated from the new code).
import { F_AREA, F_BIRTHDAY, F_BUDGET, F_CLOSED_ON, F_FEATURES, F_TIMELINE, T_BUYER, T_HOT, T_VA } from './index.js';

const U1 = '00000000-0000-4000-8000-00000000bbb1';
const U2 = '00000000-0000-4000-8000-00000000bbb2';
const S1 = '00000000-0000-4000-8000-00000000ddd1';
const S2 = '00000000-0000-4000-8000-00000000ddd2';

export const V1_FIXTURE_DEFINITIONS: { name: string; scope: 'team' | 'personal'; definition: unknown }[] = [
  { name: 'everyone', scope: 'team', definition: { v: 1 } },
  { name: 'Hot buyers (e2e)', scope: 'personal', definition: { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [T_BUYER] }] } },
  { name: 'New leads (e2e team list)', scope: 'team', definition: { v: 1, all: [{ kind: 'stage', in: ['new'] }] } },
  { name: 'stage + active in 30 days (bench)', scope: 'team', definition: { v: 1, all: [{ kind: 'stage', in: ['nurture', 'active'] }, { kind: 'last_activity', op: 'within_days', days: 30 }] } },
  { name: 'my new leads with a tag (bench)', scope: 'personal', definition: { v: 1, all: [{ kind: 'owner', is: 'me' }, { kind: 'stage', in: ['new', 'attempting'] }, { kind: 'tag', op: 'any', tagIds: [T_HOT, T_BUYER] }] } },
  { name: 'tag none / all', scope: 'team', definition: { v: 1, all: [{ kind: 'tag', op: 'none', tagIds: [T_VA] }, { kind: 'tag', op: 'all', tagIds: [T_BUYER, T_HOT] }] } },
  { name: 'source, owner in, owner none', scope: 'team', definition: { v: 1, all: [{ kind: 'source', in: [S2, S1] }, { kind: 'owner', in: [U2, U1] }], any: [{ kind: 'owner', is: 'none' }, { kind: 'owner', is: 'me' }] } },
  { name: 'intent and contact type', scope: 'team', definition: { v: 1, all: [{ kind: 'intent', in: ['seller', 'buyer'] }, { kind: 'contact_type', in: ['lead', 'sphere'] }] } },
  { name: 'activity never / older', scope: 'team', definition: { v: 1, any: [{ kind: 'last_activity', op: 'never' }, { kind: 'last_activity', op: 'older_than_days', days: 90 }] } },
  { name: 'created', scope: 'team', definition: { v: 1, all: [{ kind: 'created', op: 'within_days', days: 7 }, { kind: 'created', op: 'older_than_days', days: 1 }] } },
  { name: 'next task', scope: 'team', definition: { v: 1, any: [{ kind: 'next_task', op: 'overdue' }, { kind: 'next_task', op: 'none' }, { kind: 'next_task', op: 'any' }, { kind: 'next_task', op: 'due_within_days', days: 3 }] } },
  { name: 'name contains (personal)', scope: 'personal', definition: { v: 1, all: [{ kind: 'name', contains: 'O\'Brien_50%' }] } },
  { name: 'fields: set, empty, text', scope: 'personal', definition: { v: 1, all: [{ kind: 'field', fieldId: F_AREA, op: 'set' }, { kind: 'field', fieldId: F_BUDGET, op: 'empty' }, { kind: 'field', fieldId: F_AREA, op: 'text_eq', value: 'Lakeview' }, { kind: 'field', fieldId: F_AREA, op: 'text_contains', value: 'view' }] } },
  { name: 'fields: numbers', scope: 'team', definition: { v: 1, all: [{ kind: 'field', fieldId: F_BUDGET, op: 'num_gte', value: 1500000 }, { kind: 'field', fieldId: F_BUDGET, op: 'num_lt', value: 3000000.5 }] } },
  { name: 'fields: dates', scope: 'team', definition: { v: 1, all: [{ kind: 'field', fieldId: F_CLOSED_ON, op: 'date_before', value: '2026-03-01' }, { kind: 'field', fieldId: F_CLOSED_ON, op: 'date_after', value: '2025-12-31' }, { kind: 'field', fieldId: F_CLOSED_ON, op: 'date_on', value: '2026-01-15' }, { kind: 'field', fieldId: F_CLOSED_ON, op: 'date_within_last_days', days: 30 }, { kind: 'field', fieldId: F_CLOSED_ON, op: 'date_within_next_days', days: 30 }] } },
  { name: 'fields: coming up (annual)', scope: 'team', definition: { v: 1, all: [{ kind: 'field', fieldId: F_BIRTHDAY, op: 'coming_up', days: 14 }] } },
  { name: 'fields: options', scope: 'team', definition: { v: 1, all: [{ kind: 'field', fieldId: F_FEATURES, op: 'opt_all', optionIds: ['pool', 'garage'] }, { kind: 'field', fieldId: F_TIMELINE, op: 'opt_none', optionIds: ['later'] }, { kind: 'field', fieldId: F_TIMELINE, op: 'opt_any', optionIds: ['now'] }] } },
];
