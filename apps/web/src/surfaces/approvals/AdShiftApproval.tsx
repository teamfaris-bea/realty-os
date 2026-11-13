// The ad-shift card of the approvals inbox (PHASE2_3_PLAN module 55 item 11; R-STAFF-2, R-STAFF-4, R-STAFF-6). The
// pending weekly Google Ads proposal, through the Ads page's own ProposalCard: Approve or Reject go only to
// /ads/proposals/:id (never a generic /assistant route). Owner and Admin only: GET /ads is never requested for another
// role (Phase3Approvals passes `enabled`). While platform:ads is not cleared nothing shows (E667).
// Tap table: Approvals (1) → Approve (2).
import { useId } from 'react';
import { Notice } from '../../design/index.js';
import { messageFor } from '../../shell/index.js';
import { ProposalList, type useKeptProposals } from '../ads/ProposalCard.js';
import type { OverviewResponse } from '../ads/types.js';
import { ADS_MESSAGES } from '../ads/words.js';
import type { ApiError } from '../../shell/index.js';

export interface AdShiftSource {
  overview: OverviewResponse | undefined;
  error: ApiError | null;
  kept: ReturnType<typeof useKeptProposals>;
}

export function AdShiftApproval({ source }: { source: AdShiftSource }) {
  const headingId = useId();
  if (source.error) return <Notice tone="error">{`Google Ads proposals didn't load. ${messageFor(source.error, ADS_MESSAGES)}`}</Notice>;
  if (source.kept.shown.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
        Google Ads budget to approve
      </h2>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ProposalList shown={source.kept.shown} keep={source.kept.keep} campaigns={source.overview?.campaigns ?? []} headingLevel={3} />
      </div>
    </section>
  );
}
