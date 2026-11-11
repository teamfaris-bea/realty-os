// Test fixtures for the list compiler (used by core and api/lists tests). Not part of the runtime API.
import { at, type IanaZone, zone } from '../../../foundation/index.js';
import type { FieldDef } from '../../fields/types.js';
import type { ListViewer } from '../compile.js';

export const F_BIRTHDAY = '00000000-0000-4000-8000-0000000000b1';
export const F_BUDGET = '00000000-0000-4000-8000-0000000000b2';
export const F_AREA = '00000000-0000-4000-8000-0000000000b3';
export const F_TIMELINE = '00000000-0000-4000-8000-0000000000b4';
export const F_FEATURES = '00000000-0000-4000-8000-0000000000b5';
export const F_CLOSED_ON = '00000000-0000-4000-8000-0000000000b6';
export const T_BUYER = '00000000-0000-4000-8000-0000000000c1';
export const T_HOT = '00000000-0000-4000-8000-0000000000c2';
export const T_VA = '00000000-0000-4000-8000-0000000000c3';

export const FIXTURE_FIELDS: FieldDef[] = [
  { id: F_BIRTHDAY, key: 'birthday', label: 'Birthday', fieldType: 'date', options: [], annual: true, archived: false },
  { id: F_BUDGET, key: 'budget', label: 'Budget', fieldType: 'number', options: [], annual: false, archived: false },
  { id: F_AREA, key: 'area', label: 'Area', fieldType: 'text', options: [], annual: false, archived: false },
  { id: F_TIMELINE, key: 'timeline', label: 'Timeline', fieldType: 'single_select', options: [{ id: 'now', label: 'Now' }, { id: 'later', label: 'Later' }], annual: false, archived: false },
  { id: F_FEATURES, key: 'features', label: 'Features', fieldType: 'multi_select', options: [{ id: 'pool', label: 'Pool' }, { id: 'garage', label: 'Garage' }], annual: false, archived: false },
  { id: F_CLOSED_ON, key: 'closed_on', label: 'Closed on', fieldType: 'date', options: [], annual: false, archived: false },
];

export function fixtureViewer(o: Partial<ListViewer> = {}): ListViewer {
  return {
    userId: '00000000-0000-4000-8000-00000000aaaa',
    role: 'agent',
    now: at('2026-11-11T15:00:00Z'),
    zone: zone('America/New_York') as IanaZone,
    fields: FIXTURE_FIELDS,
    tags: [
      { id: T_BUYER, protectedProxy: false },
      { id: T_HOT, protectedProxy: false },
      { id: T_VA, protectedProxy: true },
    ],
    ...o,
  };
}
