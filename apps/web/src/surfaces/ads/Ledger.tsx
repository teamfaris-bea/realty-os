// Every budget change, newest first (GET /ads/ledger; "Show older" asks for the page before the last event shown).
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button, Notice } from '../../design/index.js';
import { type ApiError, useApi } from '../../shell/index.js';
import { Section } from '../admin/lib/ui.js';
import { LedgerLine } from './Campaigns.js';
import type { CampaignView, LedgerResponse } from './types.js';
import { ADS_MESSAGES } from './words.js';
import { messageFor } from '../../shell/index.js';

export function Ledger({ campaigns }: { campaigns: readonly CampaignView[] }) {
  const api = useApi();
  const q = useInfiniteQuery<LedgerResponse, ApiError, { pages: LedgerResponse[] }, readonly unknown[], string | null>({
    queryKey: ['ads', 'ledger'],
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) => api.get<LedgerResponse>(pageParam ? `/ads/ledger?before=${encodeURIComponent(pageParam)}` : '/ads/ledger', { signal }),
    getNextPageParam: (last) => last.next,
  });
  const events = q.data?.pages.flatMap((p) => p.events) ?? [];
  const nameOf = (id: string) => campaigns.find((c) => c.id === id)?.name ?? 'A campaign no longer listed';
  return (
    <Section title="Budget changes" description="Every approved change, its result at Google Ads, and each pause at the monthly cap, newest first.">
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, ADS_MESSAGES)}</Notice> : null}
      {q.isSuccess && events.length === 0 ? <p className="text-[15px] text-ink-muted">No budget changes yet.</p> : null}
      {events.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {events.map((e) => (
            <LedgerLine key={e.id} e={e} name={nameOf(e.campaignId)} />
          ))}
        </ul>
      ) : null}
      {q.hasNextPage ? (
        <div>
          <Button variant="secondary" pending={q.isFetchingNextPage} pendingLabel="Loading" onClick={() => void q.fetchNextPage()}>
            Show older
          </Button>
        </div>
      ) : null}
    </Section>
  );
}
