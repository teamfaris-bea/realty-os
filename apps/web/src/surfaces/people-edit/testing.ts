// Fixtures for tests of the person-page sections: a contact's stage as GET /contacts/:id/details answers it
// (apps/api people/schemas.ts DetailsResponse). The words are the API's own defaults (core's stage guide), so a
// fixture never restates a label.
import { DEFAULT_GUIDE, type StageGuideRow } from '../people/stageGuide.js';
import type { Details, StageInfo } from './api.js';

/** The eight stages as the API sends them for a team with these label overrides. */
export function guideFixture(labels: Record<string, string> = {}): StageGuideRow[] {
  return DEFAULT_GUIDE.map((s) => ({ ...s, label: labels[s.key] ?? s.label }));
}

/** `details.stage` for a person in `stage`. */
export function stageFixture(stage: string, over: Partial<StageInfo> = {}, labels: Record<string, string> = {}): StageInfo {
  const g = guideFixture(labels).find((s) => s.key === stage)!;
  return { stage, label: g.label, definition: g.definition, notThis: g.notThis, locked: [], lockedReason: null, ...over };
}

/** `details` of a person nobody shares, in `stage`. */
export function detailsFixture(contactId: string, stage = 'new', over: Partial<Details> = {}, labels: Record<string, string> = {}): Details {
  return {
    contactId,
    rowVersion: 1,
    doNotContact: false,
    stage: stageFixture(stage, {}, labels),
    stageLabels: labels,
    stageGuide: guideFixture(labels),
    addresses: [],
    collaborators: [],
    relationships: [],
    removedPoints: [],
    canEdit: true,
    canManageCollaborators: false,
    ...over,
  };
}
