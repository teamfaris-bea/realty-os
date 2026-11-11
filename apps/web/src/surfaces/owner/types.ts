// Response shapes of api/insights' owner view (apps/api/src/insights/schemas.ts). No confidence, probability or
// score field exists in any of them (R-OWNER-4); every number travels with its denominator.
export const OWNER_KEY = ['owner'] as const;

export interface SourceRowView {
  leadSourceId: string;
  leadSourceName: string;
  closings: number;
  dealsWithCommission: number;
  missingCommission: number;
  commissionCents: number;
  commissionWords: string;
  costCents: number;
  costManualCents: number;
  costAdsSyncCents: number;
  costRows: number;
  costWords: string;
  costPerClosingCents: number | null;
  costPerClosingWords: string;
}

export interface DealRef {
  dealId: string;
  name: string;
}

export interface SourcesResponse {
  period: { from: string; to: string; zone: string };
  method: string;
  closedInPeriod: number;
  rows: SourceRowView[];
  excluded: { missingCommission: { count: number; deals: DealRef[] }; noSource: { count: number; deals: DealRef[] } };
}

export interface VelocityResponse {
  method: string;
  minSample: number;
  rows: { stage: string; medianDays: number; sampleSize: number; words: string }[];
  excluded: { thinStages: { stage: string; sampleSize: number }[] };
}

export interface ForecastUnitView {
  unit: 'closings' | 'commission_cents';
  horizonDays: 90;
  low: number;
  expected: number;
  high: number;
  rangeWords: string;
  method: string;
  countedDeals: number;
  notEnoughHistory: boolean;
  samples: { stage: string; n: number; k: number }[];
  excluded: { thinStages: string[]; thinStageDeals: number; noCommission: number; noSource: number };
}

export interface ForecastResponse {
  asOf: string;
  minSample: number;
  openDeals: number;
  closings: ForecastUnitView;
  commission: ForecastUnitView;
}

export interface CostRowView {
  id: string;
  leadSourceId: string;
  month: string;
  amountCents: number;
  origin: 'manual' | 'ads_sync';
  note: string | null;
  enteredByUserId: string | null;
  updatedAt: string;
}

export interface CostsResponse {
  sources: { id: string; name: string; active: boolean }[];
  costs: CostRowView[];
}

export interface PutCostResponse {
  cost: { id: string; month: string; closedMonth: boolean; previousCents: number | null; amountCents: number };
}

export const STAGE_LABEL: Record<string, string> = {
  prospect: 'Prospect',
  agreement_signed: 'Agreement signed',
  active: 'Active',
  under_contract: 'Under contract',
  closed: 'Closed',
  lost: 'Lost',
};

export const stageLabel = (s: string): string => STAGE_LABEL[s] ?? s.replace(/_/g, ' ');
