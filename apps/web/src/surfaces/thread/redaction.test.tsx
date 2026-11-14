// b18 item a (Q-PORTAL-16, R-PORTAL-20): the thread labels a message whose quoted sign-in token is not shown, honestly:
// removed before it was stored ('stored'), or hidden on screen only ('display'). Synthetic fixtures only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../shell/api.js';
import { SESSION_KEY, ShellProvider } from '../../shell/context.js';
import { FakeFetch, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { ToastProvider } from '../people-edit/hooks.js';
import type { TimelineItem } from '../feed/lib/types.js';
import { type AttachmentsResponse, RowAttachments } from './Attachments.js';
import { MessageRow, REDACTION_NOTE } from './ThreadPage.js';

const item = (redaction: TimelineItem['redaction']): TimelineItem => ({
  id: '01900000-0000-7000-8000-0000000000e1',
  type: 'message',
  occurredAt: '2026-11-14T15:00:00Z',
  actor: null,
  detail: 'sms:inbound',
  preview: 'Thanks https://app.realty-os.invalid/portal.html#token=[sign-in token removed]',
  redaction,
  note: null,
  provenance: 'native',
});

function mount(children: ReactNode, fake: FakeFetch = new FakeFetch()) {
  const api = new ApiClient({ fetch: fake.fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(SESSION_KEY, sessionFixture());
  return render(
    <QueryClientProvider client={qc}>
      <ShellProvider api={api} table={tableWith({ pages: [] })}>
        <ToastProvider>
          <ol>{children}</ol>
        </ToastProvider>
      </ShellProvider>
    </QueryClientProvider>,
  );
}

describe('R-PORTAL-20 the thread says when a sign-in link token is not shown', () => {
  it('R-PORTAL-20: a message stored redacted says it is not the exact original', () => {
    mount(<MessageRow item={item('stored')} />);
    expect(screen.getByText(REDACTION_NOTE.stored)).toBeTruthy();
    expect(REDACTION_NOTE.stored).toMatch(/removed before the message was saved, so this is not the exact original/);
  });

  it('R-PORTAL-20: an older message hidden on screen only says it is hidden here, never that it was not kept', () => {
    mount(<MessageRow item={item('display')} />);
    expect(screen.getByText(REDACTION_NOTE.display)).toBeTruthy();
    expect(screen.queryByText(REDACTION_NOTE.stored)).toBeNull();
  });

  it('R-PORTAL-20: a message with no redaction carries no label', () => {
    mount(<MessageRow item={item(null)} />);
    expect(screen.queryByText(REDACTION_NOTE.stored)).toBeNull();
    expect(screen.queryByText(REDACTION_NOTE.display)).toBeNull();
  });
});

// b18 review F4: an MMS text part carries its own label (message_text_parts.content_redacted); the message row's label
// is null when only the part quoted the link, so the thread labels the part where it is shown
describe('R-PORTAL-20 the thread labels an MMS text part whose sign-in link token is not shown', () => {
  const C = '01900000-0000-7000-8000-0000000000c9';
  const M = '01900000-0000-7000-8000-0000000000d9';
  const withPart = (part: NonNullable<AttachmentsResponse['messages'][number]['textParts']>[number]) => {
    const body: AttachmentsResponse = { messages: [{ messageId: M, media: [], skipped: [], textParts: [part] }], voicemails: [] };
    return new FakeFetch().on(`GET /contacts/${C}/attachments`, { status: 200, body });
  };

  it('R-PORTAL-20 (b18 review F4): a part stored redacted says it is not the exact original', async () => {
    mount(<li><RowAttachments contactId={C} item={{ id: M, type: 'message' }} /></li>, withPart({ position: 0, status: 'read', text: 'See https://app.realty-os.invalid/portal.html#token=[sign-in token removed]', redaction: 'stored' }));
    expect(await screen.findByText(REDACTION_NOTE.stored)).toBeTruthy();
    expect(screen.queryByText(REDACTION_NOTE.display)).toBeNull();
  });

  it('R-PORTAL-20 (b18 review F4): an older part hidden on screen only says it is hidden here, never that it was not kept', async () => {
    mount(<li><RowAttachments contactId={C} item={{ id: M, type: 'message' }} /></li>, withPart({ position: 0, status: 'read', text: 'Earlier: https://app.realty-os.invalid/portal.html#token=[sign-in token hidden]', redaction: 'display' }));
    expect(await screen.findByText(REDACTION_NOTE.display)).toBeTruthy();
    expect(screen.queryByText(REDACTION_NOTE.stored)).toBeNull();
  });

  it('R-PORTAL-20 (b18 review F4): a part with no redaction (or from an older server) carries no label', async () => {
    mount(<li><RowAttachments contactId={C} item={{ id: M, type: 'message' }} /></li>, withPart({ position: 0, status: 'read', text: 'Saturday works.', redaction: null }));
    expect(await screen.findByText('Text in this message: Saturday works.')).toBeTruthy();
    expect(screen.queryByText(REDACTION_NOTE.stored)).toBeNull();
    expect(screen.queryByText(REDACTION_NOTE.display)).toBeNull();
  });
});
