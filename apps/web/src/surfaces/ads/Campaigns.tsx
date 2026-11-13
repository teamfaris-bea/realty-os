// The campaigns of the Google Ads page (module 55 item 10; R-STAFF-1, R-STAFF-3, R-STAFF-5; E667). Each shows its
// status in words, why it is or is not managed here, its daily budget and budget note, its outcomes with their window
// and as-of date, and its latest ledger events. Names are React text only. Resume (one tap, POST
// /ads/campaigns/:id/resume, useAction) shows only for a paused campaign while platform:ads is cleared; Link (PATCH
// /ads/campaigns/:id) stays while dark (E667: the cap form and campaign linking stay).
import { useId, useState } from 'react';
import { Button, Card, Notice, announce } from '../../design/index.js';
import { formatDate, formatStamp } from '../admin/lib/format.js';
import { useAction } from '../admin/lib/hooks.js';
import { Pill } from '../admin/lib/ui.js';
import { LinkCampaign } from './LinkCampaign.js';
import { ADS_KEY, type CampaignView, type LedgerEventView, type RunResponse } from './types.js';
import { PENDING_WORDS, campaignStatusWords, dollars, ledgerKindWords, reasonWords, refusalWords, runOutcomeWords } from './words.js';

export function LedgerLine({ e, name }: { e: LedgerEventView; name?: string }) {
  const reason = reasonWords(e.reasonCode);
  return (
    <li className="text-[15px] text-ink">
      <span className="text-ink-muted">{formatStamp(e.occurredAt)}</span>
      {' · '}
      {name ? <span className="font-semibold">{name}: </span> : null}
      {`${ledgerKindWords(e.kind)}, ${dollars(e.fromDailyCents)} → ${dollars(e.toDailyCents)} a day${reason ? ` (${reason})` : ''}.`}
    </li>
  );
}

export function CampaignCard({ c, cleared }: { c: CampaignView; cleared: boolean }) {
  const titleId = useId();
  const resume = useAction<undefined, RunResponse>('POST', { invalidate: [ADS_KEY] });
  const [result, setResult] = useState<string | null>(null);
  const [tapped, setTapped] = useState(false);

  const doResume = async () => {
    setTapped(true);
    const r = await resume.run(`/ads/campaigns/${c.id}/resume`);
    if (r.ok) {
      const row = r.data.rows[0];
      const words = row ? `Resumed. ${runOutcomeWords(row)}.` : 'Resumed.';
      setResult(words);
      announce(row?.outcome === 'pending' ? `Resumed. ${PENDING_WORDS}.` : 'Resumed.');
    } else if (r.code === 'NETWORK_ERROR' || r.status >= 500) {
      setResult('We could not tell whether your tap reached the server. Nothing is sent again: the campaign shows what the server has once it answers.');
    } else setResult(refusalWords(r));
  };

  return (
    <Card as="article" aria-labelledby={titleId} className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={titleId} className="min-w-0 break-words text-[18px] font-semibold text-ink">
          {c.name}
        </h3>
        <Pill tone={c.managed ? 'ok' : c.status === 'paused' || c.status === 'rejected' ? 'warn' : 'neutral'}>{campaignStatusWords(c.status)}</Pill>
      </div>
      <p className="text-[15px] text-ink">{c.why}</p>
      <p className="text-[15px] text-ink">
        {`Daily budget ${dollars(c.dailyBudgetCents)}${c.budgetNote ? ` (${c.budgetNote})` : ''}.`}
      </p>
      {c.outcomes ? (
        <p className="text-[15px] text-ink">
          {`${c.outcomes.agreements} ${c.outcomes.agreements === 1 ? 'agreement' : 'agreements'} and ${c.outcomes.closings} ${c.outcomes.closings === 1 ? 'closing' : 'closings'} on ${dollars(c.outcomes.spendCents)} spent in ${c.outcomes.windowDays} days, as of ${formatDate(c.outcomes.asOf)}.`}
        </p>
      ) : (
        <p className="text-[15px] text-ink-muted">No outcomes counted yet: they are counted with each weekly proposal.</p>
      )}
      {c.ledger.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label={`Latest budget changes of ${c.name}`}>
          {c.ledger.map((e) => (
            <LedgerLine key={e.id} e={e} />
          ))}
        </ul>
      ) : null}
      {result ? <Notice tone="info">{result}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        {cleared && c.status === 'paused' && !tapped ? (
          <Button pending={resume.pending} pendingLabel="Resuming" onClick={() => void doResume()}>
            Resume
          </Button>
        ) : null}
        <LinkCampaign campaign={c} />
      </div>
    </Card>
  );
}
