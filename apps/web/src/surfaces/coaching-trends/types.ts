// Shapes of api/coaching-trends (apps/api/src/coaching/trends/schemas.ts). Types only: the web app never imports API
// code. R-COACH-7/R-STAFF-3: counts only; no score, grade, rank, percentage, rate or confidence field exists to show.
export type TrendDirection = 'improving' | 'slipping' | 'steady' | 'not_enough_data';
export type TrendsState = 'not_cleared' | 'scoring_off' | 'tl_not_allowed' | 'ready';

export interface TrendCounts {
  calls: number;
  scored: number;
  /** null: withheld (fewer than 5 scored calls, or a small week inside); never shown as 0 (E679) */
  met: number | null;
}

export interface TrendItemView {
  key: string;
  label: string;
  before: TrendCounts;
  after: TrendCounts;
  direction: TrendDirection;
  sentence: string;
}

/** whole local weeks, first and last day as YYYY-MM-DD */
export interface TrendWindow {
  from: string;
  to: string;
}

interface TrendsBase {
  state: TrendsState;
  sentence: string;
  windows: { before: TrendWindow; after: TrendWindow };
}

export interface OwnTrendsView extends TrendsBase {
  items: TrendItemView[];
}

export interface TeamTrendsView extends TrendsBase {
  team: TrendItemView[];
  members: { userId: string; name: string; items: TrendItemView[] }[];
}
