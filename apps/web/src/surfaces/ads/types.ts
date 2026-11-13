// Response shapes of api/ads (module 52; apps/api/src/ads/schemas.ts), as the web reads them. The web never imports
// api code: these mirror the Zod schemas, and the staff contract (src/test/staffContract.ts) checks every fixture.

export const ADS_KEY = ['ads'] as const;

export type AdsState = 'not_cleared' | 'no_connection' | 'connection_not_live' | 'no_lead_source' | 'no_cap' | 'ready';

export interface LedgerEventView {
  id: string;
  runId: string;
  campaignId: string;
  kind: string;
  fromDailyCents: number;
  toDailyCents: number;
  reasonCode: string;
  providerRef: string | null;
  occurredAt: string;
}

export interface CapView {
  id: string;
  versionNo: number;
  monthlyCapCents: number;
  dailyCeilingCents: number;
  effectiveFrom: string;
}

export interface CampaignView {
  id: string;
  name: string;
  externalCampaignId: string;
  connectionId: string;
  status: string;
  managed: boolean;
  why: string;
  dailyBudgetCents: number;
  budgetNote: string | null;
  countedDailyCents: number;
  listingId: string | null;
  creativePieceId: string | null;
  outcomes: { agreements: number; closings: number; spendCents: number; windowDays: number; asOf: string } | null;
  ledger: LedgerEventView[];
}

/** A stored weekly proposal or hold (the API types its payload loosely: proposal.ts parses it defensively). */
export interface ShownAction {
  id: string;
  status: string;
  explanation: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface OverviewResponse {
  state: AdsState;
  stateSentence: string;
  packKey: string;
  packSentence: string;
  cleared: boolean;
  cap: CapView | null;
  monthToDate: { month: string; zone: string; spentCents: number; capCents: number | null; sentence: string };
  dailyTotal: { countedCents: number; ceilingCents: number | null; sentence: string };
  overspendNote: string;
  asOf: string | null;
  lastSyncedAt: string | null;
  uncheckedSentence: string | null;
  campaigns: CampaignView[];
  unmanagedDailyCents: number;
  unmanagedSentence: string;
  doubleCount: { leadSourceIds: string[]; sentence: string } | null;
  pendingProposal: ShownAction | null;
  latestHold: ShownAction | null;
}

export interface LedgerResponse {
  events: LedgerEventView[];
  next: string | null;
}

export interface RunRowView {
  campaignId: string;
  fromDailyCents: number;
  toDailyCents: number;
  reasonCode: string;
  outcome: 'pending' | 'applied' | 'failed';
  outcomeCode: string | null;
  providerRef: string | null;
}

export interface RunResponse {
  actionId: string;
  status: string;
  runId: string | null;
  rows: RunRowView[];
}

export interface DecisionResponse {
  actionId: string;
  status: string;
}

export interface CapResponse {
  cap: CapView;
  reconcileQueued: boolean;
}

export interface CampaignResponse {
  campaign: { id: string; status: string; listingId: string | null; creativePieceId: string | null; dailyBudgetCents: number };
}
