// The lead-email path of a source: EmailIntake (surfaces/lead-email, which owns turning it on, the portals, the
// sender domains and a new address), then where the address goes in each portal ticked, what happens to leads
// forwarded by hand, and which emails we can read.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { type ApiError, useApi } from '../../../shell/index.js';
import { EmailIntake } from '../../lead-email/EmailIntake.js';
import { INBOX_KEY, type InboxResponse } from '../../lead-email/types.js';
import type { SourceOverview } from '../types.js';
import { Muted, Steps } from '../ui.js';
import { BEST_STEP, HAND_FORWARD_LINE, PAGES, type PortalId, READABLE_FORMATS_SENTENCE, portalStep, portalsOf } from '../words.js';

export function EmailPath({ source }: { source: SourceOverview }) {
  const api = useApi();
  // the same query (and cache entry) as EmailIntake's
  const q = useQuery<InboxResponse, ApiError>({ queryKey: INBOX_KEY(source.id), queryFn: ({ signal }) => api.get<InboxResponse>(`/lead-sources/${source.id}/lead-email`, { signal }), enabled: source.active });
  const inbox = q.data?.inbox;
  const ticked = inbox ? portalsOf(inbox.portalCatalog ?? []).filter((p) => p.domains.some((d) => inbox.allowedSenderDomains.includes(d))) : [];
  if (!source.active) return <Muted>This source is off, so it takes no leads by email. Turn it on to set this up.</Muted>;
  return (
    <>
      <EmailIntake source={source} />
      {inbox?.enabled ? (
        <section aria-label="Where this address goes" className="flex flex-col gap-2 border-t border-line pt-3">
          <h3 className="text-[17px] font-semibold text-ink">Where this address goes</h3>
          <Steps items={[BEST_STEP, ...(ticked.length > 0 ? ticked.map((p) => portalStep(p.portal as PortalId, p.label)) : ['Add this address where the portal sends new-lead emails.'])]} />
        </section>
      ) : null}
      <p className="text-[15px] text-ink">
        {HAND_FORWARD_LINE}{' '}
        <Link to={PAGES.needsReview} className="text-accent underline">
          Open Needs review
        </Link>
      </p>
      <Muted>{READABLE_FORMATS_SENTENCE}</Muted>
    </>
  );
}
