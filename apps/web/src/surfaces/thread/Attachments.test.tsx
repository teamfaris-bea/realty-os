// Thread attachments: photos inline with a download, other files as downloads, refused media said
// plainly with why, and voicemails that play and show their transcript only after a tap.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../shell/api.js';
import { SESSION_KEY, ShellProvider } from '../../shell/context.js';
import { FakeFetch, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { type AttachmentsResponse, RowAttachments, formatBytes, skippedSentence } from './Attachments.js';

const C = '01900000-0000-7000-8000-0000000000c1';
const M = '01900000-0000-7000-8000-0000000000d1';
const CALL = '01900000-0000-7000-8000-0000000000e1';
const REC = '01900000-0000-7000-8000-0000000000f1';

const DATA: AttachmentsResponse = {
  messages: [{
    messageId: M,
    media: [
      { position: 0, contentType: 'image/png', byteSize: 2048, inline: true, url: `/api/messages/${M}/media/0` },
      { position: 2, contentType: 'application/pdf', byteSize: 3 * 1024 * 1024, inline: false, url: `/api/messages/${M}/media/2` },
    ],
    skipped: [{ position: 1, reason: 'TYPE_NOT_ALLOWED' }],
  }],
  voicemails: [{ callId: CALL, recordingId: REC, durationS: 74, transcriptReady: true }],
};

function mount(fake: FakeFetch, children: ReactNode) {
  const api = new ApiClient({ fetch: fake.fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(SESSION_KEY, sessionFixture());
  return render(
    <QueryClientProvider client={qc}>
      <ShellProvider api={api} table={tableWith({ pages: [] })}>
        <ul>{children}</ul>
      </ShellProvider>
    </QueryClientProvider>,
  );
}

describe('thread attachments', () => {
  it('R-TWL-11: shows a read MMS text part as plain text (markup never rendered) and a pending one as not read yet', async () => {
    const M2 = '01900000-0000-7000-8000-0000000000d2';
    const body: AttachmentsResponse = {
      messages: [{ messageId: M2, media: [], skipped: [], textParts: [{ position: 0, status: 'read', text: '<b>STOP</b> please' }, { position: 1, status: 'pending', text: null }] }],
      voicemails: [],
    };
    const fake = new FakeFetch().on(`GET /contacts/${C}/attachments`, { status: 200, body });
    const view = mount(fake, <li><RowAttachments contactId={C} item={{ id: M2, type: 'message' }} /></li>);
    expect(await screen.findByText('Text in this message: <b>STOP</b> please')).toBeTruthy();
    expect(view.container.querySelector('b')).toBeNull();
    expect(screen.getByText("Part of this text hasn't been read yet.")).toBeTruthy();
    const r = await axe.run(view.container);
    expect(r.violations).toEqual([]);
  });

  it('shows a photo inline with a download, a PDF as a download, and why one attachment was not saved', async () => {
    const fake = new FakeFetch().on(`GET /contacts/${C}/attachments`, { status: 200, body: DATA });
    const view = mount(fake, <li><RowAttachments contactId={C} item={{ id: M, type: 'message' }} /></li>);
    const img = await screen.findByRole('img', { name: 'Photo 1 of 3' });
    expect(img.getAttribute('src')).toBe(`/api/messages/${M}/media/0`);
    expect(screen.getByRole('link', { name: 'Download Attachment 1 of 3, photo, 2 KB' }).getAttribute('href')).toBe(`/api/messages/${M}/media/0`);
    expect(screen.getByRole('link', { name: 'Download Attachment 3 of 3, PDF, 3.0 MB' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: /Photo 3/ })).toBeNull();
    expect(screen.getByText("Attachment 2 of 3 wasn't saved: this kind of file isn't accepted.")).toBeTruthy();
    const r = await axe.run(view.container);
    expect(r.violations).toEqual([]);
  });

  it('plays a voicemail only after a tap (single-use stream token) and shows the transcript on a second tap', async () => {
    const fake = new FakeFetch()
      .on(`GET /contacts/${C}/attachments`, { status: 200, body: DATA })
      .on(`POST /recordings/${REC}/stream-token`, { status: 200, body: { token: 't', expiresAt: '2026-11-11T00:01:00Z', url: `/api/recordings/${REC}/stream?token=t` } })
      .on(`GET /recordings/${REC}/transcript`, { status: 200, body: { status: 'ready', language: 'en', segments: [{ startMs: 0, endMs: 1000, speaker: null, text: 'Hi, call me back about the house.' }] } });
    mount(fake, <li><RowAttachments contactId={C} item={{ id: CALL, type: 'call' }} /></li>);
    expect(await screen.findByText('Voicemail (1:14)')).toBeTruthy();
    expect(fake.callsTo(`POST /recordings/${REC}/stream-token`)).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Play voicemail' }));
    const audio = await screen.findByLabelText('Voicemail recording');
    expect(audio.getAttribute('src')).toBe(`/api/recordings/${REC}/stream?token=t`);
    expect(fake.callsTo(`POST /recordings/${REC}/stream-token`)[0]!.body).toEqual({ purpose: 'play' });
    await userEvent.click(screen.getByRole('button', { name: 'Read transcript' }));
    expect(await screen.findByText('Hi, call me back about the house.')).toBeTruthy();
  });

  it('renders nothing for a row without attachments, and words every refusal reason', async () => {
    const fake = new FakeFetch().on(`GET /contacts/${C}/attachments`, { status: 200, body: DATA });
    const view = mount(fake, <li><RowAttachments contactId={C} item={{ id: 'other', type: 'message' }} /></li>);
    await screen.findByRole('list');
    expect(view.container.querySelector('li')!.textContent).toBe('');
    for (const r of ['TYPE_NOT_ALLOWED', 'TOO_LARGE', 'TOO_MANY', 'CONTENT_MISMATCH', 'FETCH_FAILED', 'SOMETHING_NEW']) expect(skippedSentence(r)).toMatch(/\w/);
    expect(formatBytes(512)).toBe('512 B');
  });
});
