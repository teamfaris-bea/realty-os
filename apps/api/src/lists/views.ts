// Row → response views of api/lists.
import { compileList, type ListViewer, type SmartListDefinition, validateDefinition } from '@realty/core/parity/lists';
import type { FieldValueRow, FieldDefRow, TagRow, ContactTagRow } from './repos/catalog.js';
import type { PersonRow } from './repos/people.js';
import type { SmartListRow } from './repos/smartLists.js';

type Color = 'gray' | 'red' | 'orange' | 'amber' | 'green' | 'teal' | 'blue' | 'indigo' | 'purple' | 'pink' | 'brown' | 'slate';
const iso = (d: Date | null): string | null => (d === null ? null : new Date(d).toISOString());

export function tagView(t: TagRow, usage: number | null = null) {
  return { id: t.id, name: t.name, color: t.color as Color | null, protected: t.protected_proxy, createdByKind: t.created_by_kind, usage };
}

export function contactTagView(t: ContactTagRow) {
  return { id: t.id, name: t.name, color: t.color as Color | null, protected: t.protected_proxy };
}

export function fieldView(d: FieldDefRow) {
  return {
    id: d.id,
    key: d.key,
    label: d.label,
    fieldType: d.field_type,
    options: d.options.map((o) => ({ id: o.id, label: o.label, archived: o.archived === true })),
    annual: d.annual,
    position: d.position,
    origin: d.origin,
    archived: d.archived_at !== null,
  };
}

export function valueView(v: FieldValueRow) {
  return {
    fieldId: v.field_id,
    text: v.value_text,
    number: v.value_number === null ? null : Number(v.value_number),
    date: v.value_date,
    optionIds: v.value_options,
    updatedByKind: v.updated_by_kind,
    updatedAt: new Date(v.updated_at).toISOString(),
  };
}

export function listView(l: SmartListRow, me: string, viewer: ListViewer | null) {
  let audienceProtected = false;
  if (viewer) {
    const v = validateDefinition(l.definition, l.scope);
    if (v.ok) {
      const c = compileList(v.definition as SmartListDefinition, viewer);
      audienceProtected = c.ok && c.plan.audienceProtected;
    }
  }
  return {
    id: l.id,
    scope: l.scope,
    mine: l.owner_user_id === me,
    name: l.name,
    definition: l.definition,
    sort: l.sort,
    position: l.position,
    updatedAt: new Date(l.updated_at).toISOString(),
    audienceProtected,
  };
}

export function personView(p: PersonRow) {
  return {
    id: p.id,
    displayName: p.display_name,
    stage: p.stage,
    intent: p.intent,
    contactType: p.contact_type,
    owner: p.owner_user_id ? { userId: p.owner_user_id, displayName: p.owner_display_name } : null,
    sourceName: p.source_name,
    lastActivityAt: iso(p.last_activity_at),
    createdAt: new Date(p.created_at).toISOString(),
    nextTaskDueAt: iso(p.next_task_due_at),
    tags: p.tags.map((t) => ({ id: t.id, name: t.name, color: t.color as Color | null })),
  };
}
