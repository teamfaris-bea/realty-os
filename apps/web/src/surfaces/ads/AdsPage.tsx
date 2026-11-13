// The Google Ads page (PHASE2_3_PLAN module 55 item 10; module 52's API; R-STAFF-1, R-STAFF-3, R-STAFF-4, R-STAFF-6;
// E667-E671). Owner/Admin only: the registry opens it for no other role, so an agent, Team Lead, ISA or TC who types
// /ads gets "Not available" and the page never mounts (no /ads request, E671).
//
// Every state and sentence comes from GET /ads as the API wrote it: the state sentence, the pack (named through
// packName, never its key) with its sentence, month-to-date against the cap, the daily total against the ceiling, the
// over-delivery note, "not checked", unmanaged budgets and the double count. While platform:ads is not cleared the
// stored spend and campaigns still show, read-only: no Resume, no proposal and no Approve (E667). The cap form (the
// Owner's) and campaign linking stay.
import { useId } from 'react';
import { Card, Notice } from '../../design/index.js';
import { messageFor, useSession } from '../../shell/index.js';
import { formatDate, formatStamp } from '../admin/lib/format.js';
import { Loading, Section } from '../admin/lib/ui.js';
import { packName } from '../admin/integrations/words.js';
import { CampaignCard } from './Campaigns.js';
import { CapForm } from './CapForm.js';
import { useAdsOverview } from './hooks.js';
import { Ledger } from './Ledger.js';
import { HoldCard, ProposalList, useKeptProposals } from './ProposalCard.js';
import type { OverviewResponse } from './types.js';
import { ADS_MESSAGES, dollars } from './words.js';

export default function AdsPage() {
  const { session } = useSession();
  const isOwner = session?.tenant?.role === 'owner';
  const q = useAdsOverview();
  // E667: no proposal while platform:ads is not cleared
  const kept = useKeptProposals(q.data?.cleared ? q.data.pendingProposal : null);
  if (q.isPending) return <Loading />;
  if (q.isError) return <Notice tone="error">{messageFor(q.error, ADS_MESSAGES)}</Notice>;
  const o = q.data;
  return (
    <div className="flex w-full max-w-4xl flex-col gap-8">
      <Status o={o} />
      <Spend o={o} />
      <Section title="Monthly cap" description={o.cap ? `Version ${o.cap.versionNo}, in force since ${formatDate(o.cap.effectiveFrom)}.` : 'No cap is set yet.'}>
        {o.cap ? (
          <p className="text-[16px] text-ink" data-testid="cap">{`${dollars(o.cap.monthlyCapCents)} a month and ${dollars(o.cap.dailyCeilingCents)} a day.`}</p>
        ) : null}
        {isOwner ? <CapForm cap={o.cap} /> : <p className="text-[15px] text-ink-muted">Only the Owner sets the cap.</p>}
      </Section>
      {kept.shown.length > 0 || o.latestHold ? (
        <Section title="This week’s proposal">
          <ProposalList shown={kept.shown} keep={kept.keep} campaigns={o.campaigns} headingLevel={3} />
          {o.latestHold ? <HoldCard hold={o.latestHold} campaigns={o.campaigns} /> : null}
        </Section>
      ) : null}
      {o.campaigns.length > 0 ? (
        <Section title="Campaigns" description={o.cleared ? undefined : 'Shown as last read. Nothing here can be changed until budget changes are turned on.'}>
          <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {o.campaigns.map((c) => (
              <li key={c.id} className="min-w-0">
                <CampaignCard c={c} cleared={o.cleared} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {o.campaigns.length > 0 ? <Ledger campaigns={o.campaigns} /> : null}
    </div>
  );
}

function Status({ o }: { o: OverviewResponse }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="sr-only">
        Status
      </h2>
      <Notice tone={o.state === 'ready' ? 'ok' : 'info'}>{o.stateSentence}</Notice>
      <Card className="flex flex-col gap-1">
        <p className="text-[15px] font-semibold text-ink">{packName(o.packKey)}</p>
        <p className="text-[15px] text-ink">{o.packSentence}</p>
      </Card>
      {o.uncheckedSentence ? <Notice tone="warn">{o.uncheckedSentence}</Notice> : null}
    </section>
  );
}

function Spend({ o }: { o: OverviewResponse }) {
  return (
    <Section title="Spend" description={o.lastSyncedAt ? `As reported by Google Ads at ${formatStamp(o.lastSyncedAt)}.` : undefined}>
      <ul className="flex flex-col gap-2 text-[16px] text-ink">
        <li data-testid="month-to-date">{o.monthToDate.sentence}</li>
        <li data-testid="daily-total">{o.dailyTotal.sentence}</li>
        <li>{o.unmanagedSentence}</li>
      </ul>
      <p className="text-[15px] text-ink-muted">{o.overspendNote}</p>
      {o.doubleCount ? <Notice tone="warn">{o.doubleCount.sentence}</Notice> : null}
    </Section>
  );
}
