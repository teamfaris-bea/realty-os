// The web's one source of stage words (R-STG-1). A stage's label (the team's own, else the default), its one-line
// definition and its "does not mean" line come from the API: GET /stage-labels here, and `details.stageGuide` on a
// person's page. Until that answer is in (and when it fails) the words are core's own stage guide, which is what the
// API answers for a team that renamed nothing; nothing in the web restates a label (stageGuide.test.tsx scans for
// one). The eight keys are the model; a label is display only.
import { STAGES, stageGuide as coreStageGuide } from '@realty/core/parity/people';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { type ApiError, useApi } from '../../shell/index.js';

export const STAGE_KEYS = STAGES;

/** One stage as the API describes it (apps/api people/schemas.ts StageGuideRow). */
export interface StageGuideRow {
  key: string;
  label: string;
  definition: string;
  notThis: string;
}

/** GET /stage-labels (apps/api people/schemas.ts StageLabelsResponse): `labels` are the team's overrides only. */
export interface StageLabelsResponse {
  labels: Record<string, string>;
  stages: StageGuideRow[];
}

/** The cache key every reader of the labels shares, so a rename under Admin → Stage labels refreshes them all. */
export const STAGE_LABELS_KEY = ['settings', 'stage-labels'] as const;

/** Core's guide with no team labels: the API's answer for a team that renamed nothing. */
export const DEFAULT_GUIDE: readonly StageGuideRow[] = coreStageGuide();

/** A stage's label in a guide; a key the guide does not know reads as words, never as a raw key. */
export function labelIn(stages: readonly { key: string; label: string }[], key: string): string {
  return stages.find((s) => s.key === key)?.label ?? key.replace(/_/g, ' ');
}

/** The guide a response carries, or the default one (an answer from an API older than the guide has no rows). */
export function guideOf(stages: readonly Partial<StageGuideRow>[] | null | undefined): readonly StageGuideRow[] {
  if (!Array.isArray(stages) || stages.length === 0) return DEFAULT_GUIDE;
  return stages.map((s) => {
    const d = DEFAULT_GUIDE.find((x) => x.key === s.key);
    return { key: s.key ?? '', label: s.label ?? d?.label ?? (s.key ?? '').replace(/_/g, ' '), definition: s.definition ?? d?.definition ?? '', notThis: s.notThis ?? d?.notThis ?? '' };
  });
}

export function useStageLabels(enabled = true) {
  const api = useApi();
  return useQuery<StageLabelsResponse, ApiError>({ queryKey: STAGE_LABELS_KEY, queryFn: ({ signal }) => api.get('/stage-labels', { signal }), staleTime: 60_000, retryOnMount: false, enabled });
}

/** The eight stages as this team reads them, and a label lookup. `fromApi` is false until the API has answered. */
export function useStageGuide(enabled = true): { stages: readonly StageGuideRow[]; labelOf: (key: string) => string; fromApi: boolean } {
  const q = useStageLabels(enabled);
  const rows = q.data?.stages;
  return useMemo(() => {
    const stages = guideOf(rows);
    return { stages, labelOf: (key: string) => labelIn(stages, key), fromApi: rows !== undefined };
  }, [rows]);
}
