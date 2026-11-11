// api/lists client types and React Query hooks (PARITY_PLAN module 61). Types mirror
// apps/api/src/lists/schemas.ts (apps/web imports no api code).
import { type QueryKey, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { type ApiError, useApi } from '../../shell/index.js';

export type TagColor = 'gray' | 'red' | 'orange' | 'amber' | 'green' | 'teal' | 'blue' | 'indigo' | 'purple' | 'pink' | 'brown' | 'slate';
export const TAG_COLORS: TagColor[] = ['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink', 'brown', 'slate'];

export interface TagView {
  id: string;
  name: string;
  color: TagColor | null;
  protected: boolean;
  createdByKind: 'user' | 'import';
  usage: number | null;
}
export interface ContactTagView {
  id: string;
  name: string;
  color: TagColor | null;
  protected: boolean;
}
export interface PersonView {
  id: string;
  displayName: string;
  stage: string;
  intent: string | null;
  contactType: string;
  owner: { userId: string; displayName: string | null } | null;
  sourceName: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  nextTaskDueAt: string | null;
  tags: { id: string; name: string; color: TagColor | null }[];
}
export type ListSort = 'last_activity_desc' | 'created_desc' | 'name_asc' | 'next_task_asc' | 'stage_entered_desc';
export interface PeoplePage {
  people: PersonView[];
  nextCursor: string | null;
  sort: ListSort;
  list: { id: string; name: string; scope: 'team' | 'personal' } | null;
  scope: 'people_you_can_see';
  audienceProtected: boolean;
}
export interface SmartListView {
  id: string;
  scope: 'team' | 'personal';
  mine: boolean;
  name: string;
  definition: Definition;
  sort: ListSort;
  position: number;
  updatedAt: string;
  audienceProtected: boolean;
}
export type FieldType = 'text' | 'number' | 'date' | 'single_select' | 'multi_select';
export interface FieldDefView {
  id: string;
  key: string;
  label: string;
  fieldType: FieldType;
  options: { id: string; label: string; archived: boolean }[];
  annual: boolean;
  position: number;
  origin: 'manual' | 'fub_import' | 'csv_import';
  archived: boolean;
}

/** SmartListDefinition v1 (core module 59); the server validates it. */
export interface Definition {
  v: 1;
  all?: Clause[];
  any?: Clause[];
}
export type Clause = { kind: string; [k: string]: unknown };

/** Where the People page's rows come from. */
export type Source = { kind: 'all' } | { kind: 'list'; listId: string } | { kind: 'definition'; definition: Definition; label: string };

export const EVERYONE: Source = { kind: 'all' };
export const tagSource = (t: { id: string; name: string }): Source => ({ kind: 'definition', definition: { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [t.id] }] }, label: `Tag: ${t.name}` });

export function sourceKey(s: Source): string {
  return s.kind === 'all' ? 'all' : s.kind === 'list' ? `list:${s.listId}` : `def:${JSON.stringify(s.definition)}`;
}

/** The bulk selection for a source (resolveSelection's input shape, PARITY_PLAN §4.2); also the audienceSource of people checked in it. */
export function selectionOf(s: Source): { listId: string } | { definition: Definition } {
  return s.kind === 'list' ? { listId: s.listId } : { definition: s.kind === 'definition' ? s.definition : { v: 1 } };
}

export const PEOPLE_KEY = ['people'] as const;
export const TAGS_KEY = ['lists', 'tags'] as const;
export const LISTS_KEY = ['lists', 'smart'] as const;
export const FIELDS_KEY = ['lists', 'fields'] as const;

export function fetchPage(api: ReturnType<typeof useApi>, s: Source, cursor: string | null, signal?: AbortSignal): Promise<PeoplePage> {
  if (s.kind === 'definition') return api.post<PeoplePage>('/people/query', { definition: s.definition, ...(cursor ? { cursor } : {}) }, { signal });
  const qs = new URLSearchParams();
  if (s.kind === 'list') qs.set('list', s.listId);
  if (cursor) qs.set('cursor', cursor);
  const q = qs.toString();
  return api.get<PeoplePage>(`/people${q ? `?${q}` : ''}`, { signal });
}

export function usePeople(s: Source) {
  const api = useApi();
  return useInfiniteQuery<PeoplePage, ApiError, { pages: PeoplePage[] }, QueryKey, string | null>({
    queryKey: [...PEOPLE_KEY, sourceKey(s)],
    queryFn: ({ pageParam, signal }) => fetchPage(api, s, pageParam, signal),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function usePeopleCount(s: Source) {
  const api = useApi();
  return useQuery<{ count: number; capped: boolean }, ApiError>({
    queryKey: [...PEOPLE_KEY, 'count', sourceKey(s)],
    queryFn: ({ signal }) =>
      s.kind === 'definition'
        ? api.post('/people/count', { definition: s.definition }, { signal })
        : api.get(`/people/count${s.kind === 'list' ? `?list=${s.listId}` : ''}`, { signal }),
    retry: false,
  });
}

export function useTags() {
  const api = useApi();
  return useQuery<{ tags: TagView[] }, ApiError>({ queryKey: TAGS_KEY, queryFn: ({ signal }) => api.get('/tags', { signal }) });
}

export function useSmartLists() {
  const api = useApi();
  return useQuery<{ lists: SmartListView[] }, ApiError>({ queryKey: LISTS_KEY, queryFn: ({ signal }) => api.get('/smart-lists', { signal }) });
}

export function useFields(o: { archived?: boolean } = {}) {
  const api = useApi();
  return useQuery<{ fields: FieldDefView[]; liveCount: number; limit: number }, ApiError>({
    queryKey: [...FIELDS_KEY, o.archived === true],
    queryFn: ({ signal }) => api.get(`/custom-fields${o.archived ? '?archived=1' : ''}`, { signal }),
  });
}

// ---- the filter builder's catalogs (lane people-filters) ---------------------------------------------

export interface FilterOptions {
  sources: { id: string; name: string; active: boolean }[];
  members: { userId: string; name: string; role: string; active: boolean }[];
}
export const FILTER_OPTIONS_KEY = ['lists', 'filter-options'] as const;
/** module 57's stage labels key (admin/parity/StageLabelsPage.tsx), so a rename there refreshes the builder */
export const STAGE_LABELS_KEY = ['settings', 'stage-labels'] as const;

export function useFilterOptions(enabled = true) {
  const api = useApi();
  return useQuery<FilterOptions, ApiError>({ queryKey: FILTER_OPTIONS_KEY, queryFn: ({ signal }) => api.get('/people/filter-options', { signal }), enabled, staleTime: 60_000 });
}

export function useStageLabels() {
  const api = useApi();
  return useQuery<{ labels: Record<string, string>; stages: { key: string; label: string }[] }, ApiError>({ queryKey: STAGE_LABELS_KEY, queryFn: ({ signal }) => api.get('/stage-labels', { signal }), staleTime: 60_000 });
}

/** How long the builder waits after the last change before it counts (review: one count per keystroke at 250k). */
export const COUNT_DEBOUNCE_MS = 300;

/**
 * A live count of a definition the builder holds (not yet applied), counted once the definition has stopped
 * changing for COUNT_DEBOUNCE_MS. `isStale` is true while the shown number is not the count of `def` (still
 * waiting, or an earlier count shown as a placeholder), so the button never claims an old number as current.
 */
export function useDefinitionCount(def: Definition | null) {
  const api = useApi();
  const key = def === null ? null : JSON.stringify(def);
  const [settled, setSettled] = useState(key);
  useEffect(() => {
    const t = setTimeout(() => setSettled(key), COUNT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [key]);
  const q = useQuery<{ count: number; capped: boolean }, ApiError>({
    queryKey: [...PEOPLE_KEY, 'count', `def:${settled}`],
    queryFn: ({ signal }) => api.post('/people/count', { definition: JSON.parse(settled!) as Definition }, { signal }),
    enabled: settled !== null,
    retry: false,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
  return { ...q, isStale: settled !== key || q.isPlaceholderData || q.isFetching };
}

export function useContactTags(contactId: string) {
  const api = useApi();
  return useQuery<{ tags: ContactTagView[] }, ApiError>({ queryKey: ['lists', 'contact-tags', contactId], queryFn: ({ signal }) => api.get(`/contacts/${contactId}/tags`, { signal }) });
}

/** "412 people", "10,000+ people", "1 person". */
export function countText(c: { count: number; capped: boolean }): string {
  const n = c.capped ? `${c.count.toLocaleString('en-US')}+` : c.count.toLocaleString('en-US');
  return `${n} ${c.count === 1 && !c.capped ? 'person' : 'people'}`;
}

export const LEAD_STAGE_LABEL: Record<string, string> = {
  new: 'New',
  attempting: 'Attempting',
  connected: 'Connected',
  nurture: 'Nurture',
  active: 'Active',
  under_contract: 'Under contract',
  closed: 'Closed',
  lost: 'Lost',
};

/** Tag chip backgrounds from the design tokens (text stays `ink` for contrast in light and dark). */
export function chipClass(color: TagColor | null): string {
  const tone: Record<TagColor, string> = {
    gray: 'bg-surface-2',
    slate: 'bg-surface-2',
    brown: 'bg-surface-2',
    red: 'bg-danger-soft',
    pink: 'bg-danger-soft',
    orange: 'bg-warn-soft',
    amber: 'bg-warn-soft',
    green: 'bg-ok-soft',
    teal: 'bg-ok-soft',
    blue: 'bg-accent-soft',
    indigo: 'bg-accent-soft',
    purple: 'bg-accent-soft',
  };
  return `${color ? tone[color] : 'bg-surface-2'} text-ink`;
}
