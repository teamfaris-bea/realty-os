// The Owner's ad cap (module 52; R-ADS-1, E124): POST /ads/caps. An append-only version inserted by the Owner, as
// themselves, re-authenticated, with the attestation sentence rebuilt from the amounts. The DB refuses anyone else
// (OWNER_ONLY_AD_CAP) and a concurrent duplicate version (UNIQUE (tenant_id, version_no)): 409 AD_CAP_CHANGED here.
// A cap below month-to-date spend queues a reconcile pass now, which pauses every campaign (still a tap to resume);
// plans citing the old version are refused (the approve path's ADS_PROPOSAL_STALE and the DB's AD_CAP_VERSION_STALE).
import type { IdGenerator, UserActor } from '@realty/core/foundation';
import { ianaZone, localDateOf, type Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { audit, redactSnapshot } from '../audit.js';
import { AppError } from '../errors.js';
import { tenantZone } from '../insights/common.js';
import { enqueueTyped } from '../worker/registry.js';
import { ADS_RECONCILE_JOB } from './jobs.js';
import { monthsOf } from './mirror.js';
import * as repo from './repo.js';
import { capAttestation } from './settings.js';

export interface CapInput {
  monthlyCapCents: number;
  dailyCeilingCents: number;
  attestation: string;
}

/** The account-zone month (first day) of `now`: the first live connection's zone at its last sync, else the tenant's. */
export async function spendMonth(tx: Tx, now: Instant): Promise<{ month: string; zone: string }> {
  const live = (await repo.adsConnections(tx)).find((c) => c.snapshot !== null && (c.status === 'connected' || c.status === 'degraded'));
  const z = (live?.snapshot ? ianaZone(live.snapshot.zone) : null) ?? (await tenantZone(tx));
  return { month: monthsOf(localDateOf(now, z) as string).current, zone: z };
}

/** Month-to-date Google Ads spend as last synced (this month's ads_sync rows, every lead source). */
export async function monthToDateCents(tx: Tx, now: Instant): Promise<number> {
  const { month } = await spendMonth(tx, now);
  return (await repo.adsSyncCosts(tx, month)).reduce((s, c) => s + c.amountCents, 0);
}

export async function setCap(tx: Tx, actor: UserActor, ids: IdGenerator, now: Instant, input: CapInput): Promise<{ cap: repo.CapRow; reconcileQueued: boolean }> {
  if (input.dailyCeilingCents > input.monthlyCapCents) throw new AppError('AD_CAP_INVALID', { reason: 'DAILY_ABOVE_MONTHLY' });
  if (input.attestation.trim() !== capAttestation(input.monthlyCapCents, input.dailyCeilingCents)) {
    throw new AppError('ATTESTATION_REQUIRED', { expected: capAttestation(input.monthlyCapCents, input.dailyCeilingCents) });
  }
  const versionNo = await repo.nextCapVersionNo(tx);
  const id = ids.next<'AdBudgetCapId'>();
  try {
    await repo.insertCap(tx, { id, versionNo, monthlyCapCents: input.monthlyCapCents, dailyCeilingCents: input.dailyCeilingCents, userId: actor.userId, attestation: input.attestation.trim() });
  } catch (e) {
    const pe = (e && typeof e === 'object' ? e : {}) as { code?: string; constraint?: string; message?: string };
    if (pe.code === '23505' && (pe.constraint ?? '').startsWith('ad_budget_caps_')) throw new AppError('AD_CAP_CHANGED');
    if ((pe.message ?? '').startsWith('OWNER_ONLY_AD_CAP')) throw new AppError('NOT_FOUND');
    throw e;
  }
  await audit(tx, actor, {
    action: 'ads.cap_set', entity: { type: 'ad_budget_cap', id },
    changes: redactSnapshot({ version_no: versionNo, monthly_cap_cents: input.monthlyCapCents, daily_ceiling_cents: input.dailyCeilingCents }),
  });
  const cap = (await repo.capInForce(tx))!;
  let reconcileQueued = false;
  // E124: a cap at or below month-to-date spend pauses everything within the next pass, queued now
  if ((await monthToDateCents(tx, now)) >= input.monthlyCapCents) {
    await enqueueTyped(tx, ADS_RECONCILE_JOB, {}, { dedupeKey: 'ads_reconcile:cap_lowered' });
    reconcileQueued = true;
  }
  return { cap, reconcileQueued };
}
