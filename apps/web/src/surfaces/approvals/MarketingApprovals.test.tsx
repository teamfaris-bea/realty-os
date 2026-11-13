// The marketing drafts section's empty state (b14 to-do, staff low; the older sibling of audit R3): `whenEmpty` is said
// only when the drafts loaded and there are none, never beside the section's own "didn't load" notice. ApprovalsPage
// mounts the section without `whenEmpty` today, so this mounts it directly. Synthetic fixtures only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../shell/api.js';
import { SESSION_KEY, ShellProvider } from '../../shell/context.js';
import { FakeFetch, err, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { MarketingApprovals } from './MarketingApprovals.js';

function mount(fake: FakeFetch) {
  const api = new ApiClient({ fetch: fake.fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(SESSION_KEY, sessionFixture());
  return render(
    <QueryClientProvider client={qc}>
      <ShellProvider api={api} table={tableWith()}>
        <MarketingApprovals whenEmpty={<p>Nothing to approve</p>} />
      </ShellProvider>
    </QueryClientProvider>,
  );
}

describe('MarketingApprovals: whenEmpty is said only when the drafts loaded empty', () => {
  it('after a load error it shows the notice and never the empty state', async () => {
    mount(new FakeFetch().on('GET /marketing/approvals', err(500, 'INTERNAL_ERROR')));
    expect(await screen.findByText(/Marketing drafts didn't load/)).toBeTruthy();
    expect(screen.queryByText('Nothing to approve')).toBeNull();
  });

  it('with no drafts it shows the empty state it was given', async () => {
    mount(new FakeFetch().on('GET /marketing/approvals', { status: 200, body: { pieces: [] } }));
    expect(await screen.findByText('Nothing to approve')).toBeTruthy();
    expect(screen.queryByText(/didn't load/)).toBeNull();
  });
});
