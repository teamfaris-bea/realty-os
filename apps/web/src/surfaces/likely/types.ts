// The shape of GET /likely (apps/api/src/predict/routes.ts LikelyResponse). Types only: the web app never imports API
// code. R-PRED-3/R-STAFF-3: a band in words and the card's reasons; no probability, confidence, score, points or rank
// field exists to show. The back-test is counts with their denominator, said once per model.
export type LikelyBand = 'likely_90d' | 'watch';

export interface LikelyModelView {
  version: string;
  backtest: { flagged: number; transacted: number; windowDays: number };
  /** "Of N people flagged in the back-test, M transacted within D days." */
  sentence: string;
}

export interface LikelyItemView {
  contactId: string;
  contactName: string;
  modelVersion: string;
  band: LikelyBand;
  bandWords: string;
  reasons: string[];
}

export interface LikelyView {
  state: 'no_model' | 'ready';
  sentence: string;
  models: LikelyModelView[];
  items: LikelyItemView[];
  /** more than the first 200 open cards */
  more: boolean;
}
