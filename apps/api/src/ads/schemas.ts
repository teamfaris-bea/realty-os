// Zod schemas of the api/ads routes (module 52). Bodies are strict: a budget, status or targeting field is refused (422).
import { z } from 'zod';

const Cents = z.number().int().min(0).max(100_000_000_00);

export const CapBody = z.object({ monthlyCapCents: Cents, dailyCeilingCents: Cents, attestation: z.string().min(10).max(300) }).strict();
export const LinkBody = z.object({ listingId: z.uuid(), creativePieceId: z.uuid() }).strict();
export const IdParams = z.object({ id: z.uuid() }).strict();
export const LedgerQuery = z.object({ before: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).strict();

const LedgerEvent = z.object({
  id: z.string(), runId: z.string(), campaignId: z.string(), kind: z.string(), fromDailyCents: z.number(), toDailyCents: z.number(),
  reasonCode: z.string(), providerRef: z.string().nullable(), occurredAt: z.string(),
});

const Cap = z.object({ id: z.string(), versionNo: z.number(), monthlyCapCents: z.number(), dailyCeilingCents: z.number(), effectiveFrom: z.string() });

export const CapResponse = z.object({ cap: Cap, reconcileQueued: z.boolean() });

const Campaign = z.object({
  id: z.string(), name: z.string(), externalCampaignId: z.string(), connectionId: z.string(), status: z.string(), managed: z.boolean(), why: z.string(),
  dailyBudgetCents: z.number(), budgetNote: z.string().nullable(), countedDailyCents: z.number(), listingId: z.string().nullable(), creativePieceId: z.string().nullable(),
  outcomes: z.object({ agreements: z.number(), closings: z.number(), spendCents: z.number(), windowDays: z.number(), asOf: z.string() }).nullable(),
  ledger: z.array(LedgerEvent),
});

const Shown = z.object({ id: z.string(), status: z.string(), explanation: z.string(), createdAt: z.string(), payload: z.record(z.string(), z.unknown()) }).nullable();

export const OverviewResponse = z.object({
  state: z.enum(['not_cleared', 'no_connection', 'connection_not_live', 'no_lead_source', 'no_cap', 'ready']),
  stateSentence: z.string(),
  packKey: z.string(),
  packSentence: z.string(),
  cleared: z.boolean(),
  cap: Cap.nullable(),
  monthToDate: z.object({ month: z.string(), zone: z.string(), spentCents: z.number(), capCents: z.number().nullable(), sentence: z.string() }),
  dailyTotal: z.object({ countedCents: z.number(), ceilingCents: z.number().nullable(), sentence: z.string() }),
  overspendNote: z.string(),
  asOf: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  uncheckedSentence: z.string().nullable(),
  campaigns: z.array(Campaign),
  unmanagedDailyCents: z.number(),
  unmanagedSentence: z.string(),
  doubleCount: z.object({ leadSourceIds: z.array(z.string()), sentence: z.string() }).nullable(),
  pendingProposal: Shown,
  latestHold: Shown,
});

export const LedgerResponse = z.object({ events: z.array(LedgerEvent), next: z.string().nullable() });

export const CampaignResponse = z.object({
  campaign: z.object({ id: z.string(), status: z.string(), listingId: z.string().nullable(), creativePieceId: z.string().nullable(), dailyBudgetCents: z.number() }),
});

export const RunResponse = z.object({
  actionId: z.string(),
  status: z.string(),
  runId: z.string().nullable(),
  rows: z.array(z.object({
    campaignId: z.string(), fromDailyCents: z.number(), toDailyCents: z.number(), reasonCode: z.string(),
    outcome: z.enum(['pending', 'applied', 'failed']), outcomeCode: z.string().nullable(), providerRef: z.string().nullable(),
  })),
});

export const DecisionResponse = z.object({ actionId: z.string(), status: z.string() });
