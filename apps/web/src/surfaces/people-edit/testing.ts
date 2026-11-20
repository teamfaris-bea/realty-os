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

// ---- a task store that answers as POST /tasks and PATCH /tasks/:id do (apps/api workspace/tasks.ts) -----------------

export interface FakeTask {
  id: string;
  kind: string;
  title: string;
  dueAt: string | null;
  status: 'open' | 'done' | 'canceled';
  contact: { id: string; name: string } | null;
}

interface ScriptedFetch {
  on(key: string, h: (call: { body: unknown }, n: number) => { status: number; body?: unknown } | 'network-error'): unknown;
}

/**
 * POST /tasks keeps the FIRST body an id was created with: the same id again answers that stored task with
 * `replayed: true` and never rewrites it (createTaskOnce). PATCH /tasks/:id really changes it. `lose(n)`: the n-th
 * POST is stored but its answer never arrives; `stored` is what a reload would show.
 */
export function fakeTaskStore(fake: ScriptedFetch, o: { lose?: (n: number) => boolean; failPatch?: () => boolean } = {}) {
  const stored = new Map<string, FakeTask>();
  fake.on('POST /tasks', (call, n) => {
    const b = call.body as { id: string; title: string; kind?: string; dueAt?: string | null; contactId?: string | null };
    const prior = stored.get(b.id);
    if (prior) return { status: 200, body: { task: { ...prior }, replayed: true } };
    const t: FakeTask = { id: b.id, kind: b.kind ?? 'todo', title: b.title, dueAt: b.dueAt ?? null, status: 'open', contact: b.contactId ? { id: b.contactId, name: 'Dana Reyes' } : null };
    stored.set(b.id, t);
    fake.on(`PATCH /tasks/${b.id}`, (c) => {
      if (o.failPatch?.()) return 'network-error';
      const p = c.body as { dueAt?: string | null; status?: FakeTask['status'] };
      const now = stored.get(b.id)!;
      const next = { ...now, ...(p.dueAt !== undefined ? { dueAt: p.dueAt } : {}), ...(p.status !== undefined ? { status: p.status } : {}) };
      stored.set(b.id, next);
      return { status: 200, body: { task: { ...next } } };
    });
    if (o.lose?.(n)) return 'network-error';
    return { status: 201, body: { task: { ...t }, replayed: false } };
  });
  return { stored, open: () => [...stored.values()].filter((t) => t.status === 'open') };
}
