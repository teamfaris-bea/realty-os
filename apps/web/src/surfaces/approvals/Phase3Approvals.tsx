// The module 55 approval cards (PHASE2_3_PLAN module 55 item 11), mounted by the approvals inbox beside the marketing
// drafts: the pending Google Ads proposal (Owner/Admin), Google review replies waiting with a draft (Owner/Admin) and
// pointers to contract extractions (every role). Each kind keeps its one decision path (R-STAFF-2): ad shifts via
// /ads/proposals, review replies via /gbp/reviews, extractions only on the document; nothing here calls /assistant.
// Owner/Admin reads are never requested for another role (R-STAFF-6). With every source empty it renders `whenEmpty`,
// so the inbox says "Nothing to approve" only when there is nothing of any kind. A source that failed to load is not
// known to be empty: then only its "didn't load" notice shows (brief item 11; batch 14 audit R3).
import { type ReactNode, useState } from 'react';
import { Notice } from '../../design/index.js';
import { messageFor, useSession } from '../../shell/index.js';
import { mayReadAds, useAdsOverview } from '../ads/hooks.js';
import { useKeptProposals } from '../ads/ProposalCard.js';
import { ADMIN_MESSAGES } from '../admin/lib/messages.js';
import { AdShiftApproval } from './AdShiftApproval.js';
import { ExtractionPointers, useOpenExtractions } from './ExtractionPointers.js';
import type { ReviewView } from '../gbp/types.js';
import { ReviewReplyApproval, useReviewsToReply } from './ReviewReplyApproval.js';

export function Phase3Approvals({ whenEmpty = null }: { whenEmpty?: ReactNode }) {
  const { session } = useSession();
  const admin = mayReadAds(session?.tenant?.role);
  const ads = useAdsOverview({ enabled: admin });
  // E667: no proposal while platform:ads is not cleared
  const kept = useKeptProposals(admin && ads.data?.cleared ? ads.data.pendingProposal : null);
  const reviews = useReviewsToReply(admin);
  const [keptReviews, setKeptReviews] = useState<ReviewView[]>([]);
  const extractions = useOpenExtractions();

  if ((admin && (ads.isPending || reviews.pending)) || extractions.isPending) return null;
  const shownReviews = [...keptReviews.filter((k) => !reviews.list.some((r) => r.id === k.id)), ...reviews.list];
  const pointers = extractions.data?.extractions ?? [];
  const failed = (admin && ads.error !== null) || reviews.error !== null || extractions.isError;
  const empty = !failed && kept.shown.length === 0 && shownReviews.length === 0 && pointers.length === 0;
  const keepReview = (r: ReviewView) => setKeptReviews((k) => (k.some((x) => x.id === r.id) ? k : [...k, r]));

  return (
    <>
      {admin ? <AdShiftApproval source={{ overview: ads.data, error: ads.error, kept }} /> : null}
      {reviews.error ? <Notice tone="error">{`Review replies didn't load. ${messageFor(reviews.error, ADMIN_MESSAGES)}`}</Notice> : null}
      {shownReviews.length > 0 ? (
        <section aria-label="Review replies to approve" className="flex flex-col gap-3">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">Review replies to approve</h2>
          <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {shownReviews.map((r) => (
              <li key={r.id} id={`review-${r.id}`} className="min-w-0 scroll-mt-20">
                <ReviewReplyApproval review={r} onTapped={() => keepReview(r)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {extractions.isError ? <Notice tone="error">{`Contract dates didn't load. ${messageFor(extractions.error, ADMIN_MESSAGES)}`}</Notice> : null}
      <ExtractionPointers list={pointers} />
      {empty ? whenEmpty : null}
    </>
  );
}
