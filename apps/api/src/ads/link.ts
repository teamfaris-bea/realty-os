// PATCH /ads/campaigns/:id (module 52; R-ADS-4, R-ADS-12): an Owner/Admin links a mirrored campaign to a listing and an
// approved or published creative of that listing. Only the two ids are written, as the person (no unlinking; budgets,
// status and targeting are never accepted: the strict body refuses them, 422). The campaign becomes active only on the
// next reconcile pass, if the live Google Ads snapshot qualifies (the deciding facts are not stored here), and the DB
// guard re-checks the creative whenever an active campaign is relinked (AD_CREATIVE_NOT_APPROVED).
import type { UserActor } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import { enqueueTyped } from '../worker/registry.js';
import { ADS_RECONCILE_JOB } from './jobs.js';
import * as repo from './repo.js';

export async function linkCampaign(tx: Tx, actor: UserActor, campaignId: string, input: { listingId: string; creativePieceId: string }): Promise<repo.CampaignRow> {
  const [row] = await repo.campaignRows(tx, { ids: [campaignId], forUpdate: true });
  if (!row) throw new AppError('NOT_FOUND');
  if (!(await repo.creativeApprovedFor(tx, input.creativePieceId, input.listingId))) throw new AppError('AD_CREATIVE_NOT_APPROVED');
  await repo.linkCampaign(tx, row.id, input.listingId, input.creativePieceId);
  await audit(tx, actor, {
    action: 'ads.campaign_linked', entity: { type: 'ad_campaign', id: row.id },
    changes: redactDiff({ listing_id: row.listingId, creative_piece_id: row.creativePieceId }, { listing_id: input.listingId, creative_piece_id: input.creativePieceId }),
  });
  await enqueueTyped(tx, ADS_RECONCILE_JOB, {}, { dedupeKey: 'ads_reconcile:linked' });
  return (await repo.campaignRows(tx, { ids: [row.id] }))[0]!;
}
