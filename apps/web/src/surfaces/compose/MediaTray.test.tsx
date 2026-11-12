// D5a in jsdom: photos and videos sent by text from the compose box (the whole app, the thread page, a scripted API).
// jsdom has no canvas and no object URLs, so the JPEG encoder and the thumbnail URLs are injected (prepareMedia.ts
// mediaDeps); everything else is the real box, tray, hook and client.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { providerCodeSentence, messageStatus } from '../../reasons/sentences.js';
import { FakeFetch, IDS, agentApp, decision, draftAction, err, findToast, fullContact, iso, reachability, stopReason, timelineItem } from '../feed/lib/testing.js';
import { MEDIA_UPLOAD_LIMIT_WORDS } from './mediaApi.js';
import { type MediaDeps, mediaDeps } from './prepareMedia.js';

// applyAccept off: a desktop file picker can choose any file ("All files"), so the refusals are tested as such
const user = () => userEvent.setup({ applyAccept: false });
const UP = (n: number) => `01900000-0000-7000-8000-0000000f${String(n).padStart(4, '0')}`;
const MEDIA = `/contacts/${IDS.jane}/outbound-media`;

const real: MediaDeps = { ...mediaDeps };
let encoded = 400_000;
let encodeGate: Promise<void> | null = null;
let revoked: string[] = [];
let made = 0;
beforeEach(() => {
  encoded = 400_000;
  encodeGate = null;
  revoked = [];
  mediaDeps.encodeJpeg = async (f) => {
    if (encodeGate) await encodeGate;
    if ((f as File).name?.startsWith('broken')) throw new Error('cannot decode');
    return new Blob([new Uint8Array(encoded)], { type: 'image/jpeg' });
  };
  mediaDeps.objectUrl = () => `blob:test/${++made}`;
  mediaDeps.revokeUrl = (u) => {
    revoked.push(u);
  };
});
afterEach(() => {
  Object.assign(mediaDeps, real);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => (resolve = ok));
  return { promise, resolve };
}

const file = (name: string, size: number, type: string) => new File([new Uint8Array(size)], name, { type });
const photo = (name = 'house.jpg', size = 2_000_000) => file(name, size, 'image/jpeg');

const staged = (c: { body: unknown }, n: number) => {
  const b = c.body as { contentType: string; data: string };
  return { status: 201, body: { upload: { id: UP(n), contentType: b.contentType, byteSize: atob(b.data).length, expiresAt: iso(86_400_000) } } };
};

const sentMessage = (status = 'sent', result = 'sent') => ({ status: 200, body: { message: { id: IDS.message, channel: 'mms', status, statusReason: status === 'blocked' ? 'CONSENT_REVOKED' : null, purpose: 'informational', body: '', subject: null, scheduledFor: null, dispatchedAt: status === 'sent' ? iso(0) : null }, decision: decision({}), result } });

function threadFake(items = [timelineItem()]) {
  return new FakeFetch()
    .on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact: fullContact() } })
    .on(`GET /contacts/${IDS.jane}/timeline?limit=100`, { status: 200, body: { items, nextCursor: null } })
    .on(`POST /contacts/${IDS.jane}/messages/preview`, (c) => ({ status: 200, body: { decision: decision({ id: null, phase: 'preview' }), body: (c.body as { body: string }).body, textSender: 'local' } }))
    .on(`POST ${MEDIA}`, staged);
}

const deletes = (fake: FakeFetch) => fake.calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
const input = () => document.querySelector<HTMLInputElement>('[data-testid="media-input"]')!;
const tray = () => screen.getByTestId('media-tray');
const tiles = () => {
  const t = screen.queryByTestId('media-tray');
  return t ? within(t).queryAllByRole('listitem') : [];
};
const live = () => document.querySelector('[data-testid="media-live"]')!;
const LINES = 'Up to 10 photos or videos, 5 MB in all; videos up to 500 KB. Location is removed from photos and videos before they\'re sent.';

async function openText(fake: FakeFetch, path = `/contacts/${IDS.jane}/thread?compose=sms`) {
  agentApp(fake, path);
  const box = await screen.findByRole('textbox', { name: 'Text message' });
  await screen.findByRole('button', { name: 'Photo or video' });
  return box;
}

async function attach(...files: File[]) {
  await user().upload(input(), files);
}

describe('D5a compose: photos and videos by text', () => {
  it('R-MMS-8: a photo goes Preparing → Uploading → Ready with its thumbnail, decimal size and one announcement; Remove deletes the staged upload once and revokes the thumbnail', async () => {
    const prep = deferred();
    encodeGate = prep.promise;
    const up = deferred();
    const fake = threadFake().on(`POST ${MEDIA}`, async (c, n) => {
      await up.promise;
      return staged(c, n);
    });
    await openText(fake);
    // before anything is picked the limits and location are the button's description; nothing else is drawn (ui/F10)
    expect(screen.getByRole('button', { name: 'Photo or video' })).toHaveAccessibleDescription(LINES);
    expect(screen.queryByTestId('media-tray')).toBeNull();
    await attach(photo());
    expect(within(tray()).getByText('Up to 10 photos or videos, 5 MB in all; videos up to 500 KB.')).toBeVisible();
    expect(within(tray()).getByText("Location is removed from photos and videos before they're sent.")).toBeVisible();
    expect(screen.getByRole('button', { name: 'Photo or video' })).toHaveAccessibleDescription(LINES);
    expect(await within(tray()).findByText('Preparing')).toBeInTheDocument();
    expect(fake.callsTo(`POST ${MEDIA}`)).toHaveLength(0);
    prep.resolve();
    expect(await within(tray()).findByText('Uploading')).toBeInTheDocument();
    // the size is the re-encoded JPEG's, in decimal units
    expect(within(tray()).getByText(/400 KB/)).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription('Send waits until every photo and video is uploaded.');
    up.resolve();
    expect(await within(tray()).findByText('Ready')).toBeInTheDocument();
    expect(live()).toHaveTextContent('Photo 1 ready');
    const [call] = fake.callsTo(`POST ${MEDIA}`);
    expect(Object.keys(call!.body as object).sort()).toEqual(['contentType', 'data']);
    expect((call!.body as { contentType: string }).contentType).toBe('image/jpeg');
    const url = tiles()[0]!.querySelector('img')!.getAttribute('src')!;
    expect(url).toMatch(/^blob:test\/\d+$/);
    // a photo with no words can be sent
    expect(send).toBeEnabled();
    await user().click(within(tray()).getByRole('button', { name: 'Remove photo 1' }));
    await waitFor(() => expect(tiles()).toHaveLength(0));
    await waitFor(() => expect(deletes(fake)).toEqual([`${MEDIA}/${UP(1)}`]));
    expect(revoked).toEqual([url]);
    expect(send).toBeDisabled();
  });

  it('R-MMS-8: an upload the API refuses fails in words on its tile, is announced once, and holds Send with the reason until it is removed', async () => {
    const fake = threadFake().on(`POST ${MEDIA}`, (c, n) => (n === 2 ? err(409, 'MEDIA_UPLOAD_LIMIT') : staged(c, n)));
    await openText(fake);
    await attach(photo('a.jpg'));
    await within(tray()).findByText('Ready');
    await attach(photo('b.jpg'));
    expect(await within(tray()).findByText(MEDIA_UPLOAD_LIMIT_WORDS)).toBeInTheDocument();
    expect(live()).toHaveTextContent(`Photo 2 couldn't be uploaded: ${MEDIA_UPLOAD_LIMIT_WORDS}`);
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription("Remove the photo or video that couldn't be attached, then send.");
    await user().click(within(tray()).getByRole('button', { name: 'Remove photo 2' }));
    await waitFor(() => expect(send).toBeEnabled());
    // the failed one was never staged: nothing to delete
    expect(deletes(fake)).toEqual([]);
  });

  it('R-MMS-8: refusals before upload are an alert in exact words: a 500,001-byte video (500.1 KB), a file that is not a photo or video, a photo that cannot be read, more than 10, more than 5 MB in all', async () => {
    const fake = threadFake();
    await openText(fake);
    const alert = () => within(tray()).getByRole('alert');
    await attach(file('tour.mp4', 500_001, 'video/mp4'));
    expect(alert()).toHaveTextContent('This video is 500.1 KB. A text can carry a video of at most 500 KB. For a longer video, send a link instead.');
    await attach(file('contract.pdf', 1000, 'application/pdf'));
    expect(alert()).toHaveTextContent('Only photos and videos can be sent by text.');
    await attach(file('broken.heic', 1000, 'image/heic'));
    await waitFor(() => expect(alert()).toHaveTextContent("This photo can't be read here. Try a JPEG or PNG."));
    expect(tiles()).toHaveLength(0);
    await attach(...Array.from({ length: 11 }, (_, i) => photo(`p${i}.jpg`, 1000)));
    expect(alert()).toHaveTextContent('Up to 10 photos or videos per text.');
    await waitFor(() => expect(tiles()).toHaveLength(10));
    for (let i = 10; i >= 1; i -= 1) await user().click(within(tray()).getByRole('button', { name: `Remove photo ${i}` }));
    await waitFor(() => expect(tiles()).toHaveLength(0));
    encoded = 3_000_000;
    await attach(photo('big1.jpg'));
    await within(tray()).findByText('Ready');
    await attach(photo('big2.jpg'));
    await waitFor(() => expect(alert()).toHaveTextContent('That would make this text larger than 5 MB in all.'));
    expect(tiles()).toHaveLength(1);
    // nothing refused was ever uploaded
    expect(fake.callsTo(`POST ${MEDIA}`)).toHaveLength(11);
  });

  it('R-MMS-8: a video goes up as it is and shows an icon and its size; Send carries the mediaIds in tray order and the tray empties without deleting once the response names the message', async () => {
    const fake = threadFake().on(`POST /contacts/${IDS.jane}/messages`, sentMessage());
    const box = await openText(fake);
    await attach(photo('a.jpg'), file('tour.mov', 420_300, 'video/quicktime'));
    await waitFor(() => expect(within(tray()).getAllByText('Ready')).toHaveLength(2));
    const video = tiles()[1]!;
    expect(video.querySelector('img')).toBeNull();
    expect(video).toHaveTextContent('Video 2420.3 KBReady');
    expect(fake.callsTo(`POST ${MEDIA}`).map((c) => (c.body as { contentType: string }).contentType).sort()).toEqual(['image/jpeg', 'video/quicktime']);
    // the counter says it is one picture message
    expect(screen.getByTestId('segment-summary')).toHaveTextContent('Picture message · 2 of 10 · 820.3 KB of 5 MB');
    expect(box).toHaveAccessibleDescription('Picture message · 2 of 10 · 820.3 KB of 5 MB');
    const attachmentsBefore = fake.callsTo(`GET /contacts/${IDS.jane}/attachments`).length;
    await user().click(screen.getByRole('button', { name: 'Send' }));
    expect(await findToast('Sent to Jane.')).toBeInTheDocument();
    const [sent] = fake.callsTo(`POST /contacts/${IDS.jane}/messages`);
    const order = fake.callsTo(`POST ${MEDIA}`).map((c, i) => ({ type: (c.body as { contentType: string }).contentType, id: UP(i + 1) }));
    expect(sent!.body).toMatchObject({ channel: 'sms', body: '', mediaIds: [order.find((o) => o.type === 'image/jpeg')!.id, order.find((o) => o.type === 'video/quicktime')!.id] });
    await waitFor(() => expect(tiles()).toHaveLength(0));
    expect(deletes(fake)).toEqual([]);
    // the thread's attachments are asked again
    await waitFor(() => expect(fake.callsTo(`GET /contacts/${IDS.jane}/attachments`).length).toBeGreaterThan(attachmentsBefore));
  });

  it('R-MMS-8 (b8 texting ui/F6): a send blocked at send time still names its message, so the tray empties without deleting and the box says the photo stayed with it; a send never created keeps the items, and MEDIA_UPLOAD_GONE marks the tile it names', async () => {
    let answer: unknown = { status: 200, body: { message: null, decision: decision({ outcome: 'deny', explanation: 'Wire instructions are never sent.' }), result: 'not_created' } };
    const fake = threadFake().on(`POST /contacts/${IDS.jane}/messages`, () => answer as never);
    const box = await openText(fake);
    await user().type(box, 'The house');
    await attach(photo('a.jpg'), photo('b.jpg'));
    await waitFor(() => expect(within(tray()).getAllByText('Ready')).toHaveLength(2));
    await user().click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Wire instructions are never sent.')).toBeInTheDocument();
    expect(tiles()).toHaveLength(2);
    answer = err(409, 'MEDIA_UPLOAD_GONE', { uploadId: UP(2) });
    await user().click(screen.getByRole('button', { name: 'Send' }));
    expect(await within(tray()).findByText('This photo is no longer available. Remove it and attach it again.')).toBeInTheDocument();
    expect(screen.getByText('Not sent: a photo or video is no longer available. Remove it and attach it again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    const failedTile = tiles().find((t) => t.dataset.state === 'failed')!;
    await user().click(within(failedTile).getByRole('button', { name: /^Remove photo/ }));
    await waitFor(() => expect(tiles()).toHaveLength(1));
    answer = sentMessage('blocked', 'blocked');
    await user().click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(tiles()).toHaveLength(0));
    // the gone one was deleted when it was removed (404 is fine), the blocked message keeps the other
    expect(deletes(fake)).toEqual([`${MEDIA}/${UP(2)}`]);
    expect(box).toHaveValue('The house');
    // the words stay but the photo went with the blocked text: the box says so plainly (b8 texting ui/F6)
    expect(screen.getByText("The photo stayed with the text that wasn't sent, so it isn't in this box any more. Attach it again to send it.")).toBeInTheDocument();
  });

  it('R-MMS-8: the tray is for Text only: with a photo attached, Email or Web chat says "Photos and videos go only by text." and holds Send until Text is chosen again or the photo is removed', async () => {
    const items = [timelineItem({ id: '01900000-0000-7000-8000-0000000e5701', detail: 'web_chat:inbound', preview: 'Is the open house still on?', occurredAt: iso(-60_000) })];
    const fake = threadFake(items).on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: { reachability: reachability(IDS.jane, {}, 'open') } });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    await screen.findByRole('textbox', { name: 'Text message' });
    await attach(photo());
    await within(tray()).findByText('Ready');
    for (const other of ['Email', 'Web chat']) {
      await user().click(screen.getByRole('radio', { name: other }));
      expect(screen.queryByRole('button', { name: 'Photo or video' })).toBeNull();
      expect(within(tray()).getByText('Photos and videos go only by text.')).toBeInTheDocument();
      expect(within(tray()).getByRole('button', { name: 'Remove photo 1' })).toBeInTheDocument();
      await user().type(screen.getByRole('textbox', { name: other === 'Email' ? 'Email message' : 'Web chat message' }), 'x');
      const send = screen.getByRole('button', { name: 'Send' });
      expect(send).toBeDisabled();
      expect(send).toHaveAccessibleDescription('Photos and videos go only by text.');
      await user().click(screen.getByRole('radio', { name: 'Text' }));
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    }
    await user().click(screen.getByRole('radio', { name: 'Email' }));
    await user().click(within(tray()).getByRole('button', { name: 'Remove photo 1' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    expect(screen.queryByTestId('media-tray')).toBeNull();
  });

  it('R-MMS-8: no Photo or video button while an assistant draft is open, nor for a person who texted STOP (the reason is said)', async () => {
    const withDraft = threadFake().on(`GET /assistant/actions/${IDS.draft}`, { status: 200, body: { action: draftAction() } });
    const { view } = agentApp(withDraft, `/contacts/${IDS.jane}/thread?compose=draft&draft=${IDS.draft}`);
    const box = await screen.findByRole('textbox', { name: 'Text message' });
    await waitFor(() => expect(box).toHaveValue('Hi Jane, Saturday at 11 works. Want me to book it?'));
    expect(screen.getByText('Drafted by the assistant.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Photo or video' })).toBeNull();
    view.unmount();
    const stopped = threadFake()
      .on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact: fullContact({ emails: [] }) } })
      .on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: { reachability: reachability(IDS.jane, { sms: [stopReason()] }) } });
    agentApp(stopped, `/contacts/${IDS.jane}/thread?compose=sms`);
    expect(await screen.findByText('Texted STOP on Nov 10')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Photo or video' })).toBeNull();
    expect(screen.queryByTestId('media-tray')).toBeNull();
  });

  it('R-MMS-8: when Text becomes blocked with a photo attached, the photo stays with Remove, the button goes, and Send stays disabled for the reason', async () => {
    let stopped = false;
    const fake = threadFake()
      .on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact: fullContact({ emails: [] }) } })
      .on(`GET /contacts/${IDS.jane}/reachability`, () => ({ status: 200, body: { reachability: stopped ? reachability(IDS.jane, { sms: [stopReason()] }) : reachability(IDS.jane) } }))
      .on(`POST /contacts/${IDS.jane}/messages`, { status: 200, body: { message: null, decision: decision({ outcome: 'deny', explanation: 'Texted STOP on Nov 10' }), result: 'not_created' } });
    await openText(fake);
    await attach(photo());
    await within(tray()).findByText('Ready');
    // the send is refused (they had just texted STOP), and the summary asked again now says so
    stopped = true;
    await user().click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Photo or video' })).toBeNull());
    expect(within(tray()).getByRole('button', { name: 'Remove photo 1' })).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    // the refused send's outcome says why (it replaces the caption Send points at until the next send)
    expect(screen.getAllByText('Texted STOP on Nov 10').length).toBeGreaterThan(0);
    expect(deletes(fake)).toEqual([]);
  });

  it('R-MMS-8: a suggested draft that arrives after a photo is attached is not adopted, and "Ask the assistant for a draft" is hidden while a photo is attached', async () => {
    const inboxGate = deferred();
    const fake = threadFake().on('GET /assistant/inbox', async () => {
      await inboxGate.promise;
      return { status: 200, body: { items: [draftAction()] } };
    });
    const box = await openText(fake);
    expect(screen.getByRole('button', { name: 'Ask the assistant for a draft' })).toBeInTheDocument();
    await attach(photo());
    await within(tray()).findByText('Ready');
    expect(screen.queryByRole('button', { name: 'Ask the assistant for a draft' })).toBeNull();
    inboxGate.resolve();
    await waitFor(() => expect(fake.callsTo('GET /assistant/inbox').length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.callsTo(`GET /assistant/actions/${IDS.draft}`)).toHaveLength(0);
    expect(box).toHaveValue('');
    expect(screen.queryByText('Drafted by the assistant.')).toBeNull();
  });

  it('R-MMS-8: the box closing (a draft opened from the feed remounts it) deletes what is staged, best effort, and revokes the thumbnails', async () => {
    const fake = threadFake();
    const { view } = agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    await screen.findByRole('button', { name: 'Photo or video' });
    await attach(photo());
    await within(tray()).findByText('Ready');
    const url = tiles()[0]!.querySelector('img')!.getAttribute('src')!;
    view.unmount();
    await waitFor(() => expect(deletes(fake)).toEqual([`${MEDIA}/${UP(1)}`]));
    expect(revoked.filter((u) => u === url)).toHaveLength(1);
  });
});

describe('D5a compose: no empty alert, and a failed photo text (b8 texting review)', () => {
  it('R-MMS-8 WCAG 4.1.3 (b8 texting ui/F3): a text thread mounts no role="alert" until a refusal has words; the refusal is an alert', async () => {
    await openText(threadFake());
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    await attach(file('contract.pdf', 1000, 'application/pdf'));
    expect(within(tray()).getByRole('alert')).toHaveTextContent('Only photos and videos can be sent by text.');
  });

  it('R-MMS-8 (b8 texting ui/F6): a photo text that failed at the provider keeps the words, and the box says the photos stayed with it; a later Send is never silently words-only', async () => {
    const fake = threadFake().on(`POST /contacts/${IDS.jane}/messages`, { status: 200, body: { ...sentMessage('failed', 'failed').body, message: { ...sentMessage().body.message, status: 'failed', statusReason: 'MEDIA_UNAVAILABLE', dispatchedAt: null } } });
    const box = await openText(fake);
    await user().type(box, 'The kitchen');
    await attach(photo('a.jpg'), photo('b.jpg'));
    await waitFor(() => expect(within(tray()).getAllByText('Ready')).toHaveLength(2));
    await user().click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText("The photos stayed with the text that wasn't sent, so they aren't in this box any more. Attach them again to send them.")).toBeInTheDocument();
    expect(box).toHaveValue('The kitchen');
    expect(tiles()).toHaveLength(0);
  });
});

describe('D5a thread: outbound photos and videos', () => {
  it('R-MMS-8 (b8 texting ui/F5): a blocked, failed or held photo-only text carries the dashed outline on its photos and its status, photos before the status and actions', async () => {
    const cases = [
      { id: '01900000-0000-7000-8000-0000000e5811', status: 'blocked', statusReason: 'CONSENT_REVOKED', tone: 'failed' },
      { id: '01900000-0000-7000-8000-0000000e5812', status: 'failed', statusReason: 'MEDIA_UNAVAILABLE', tone: 'failed' },
      { id: '01900000-0000-7000-8000-0000000e5813', status: 'undelivered', statusReason: 'PROVIDER_UNDELIVERED', tone: 'failed' },
      { id: '01900000-0000-7000-8000-0000000e5814', status: 'delivered', statusReason: null, tone: null },
    ];
    const items = cases.map((c, i) => timelineItem({ id: c.id, detail: 'mms:outbound', preview: '', occurredAt: iso(-60_000 * (i + 1)), actor: { userId: IDS.me, displayName: 'Ava Agent' }, status: c.status, statusReason: c.statusReason }));
    const fake = threadFake(items).on(`GET /contacts/${IDS.jane}/attachments`, {
      status: 200,
      body: { messages: cases.map((c) => ({ messageId: c.id, media: [{ position: 0, contentType: 'image/jpeg', byteSize: 400_000, inline: true, url: `/api/messages/${c.id}/media/0` }], skipped: [] })), voicemails: [] },
    });
    agentApp(fake, `/contacts/${IDS.jane}/thread`);
    await screen.findAllByRole('img', { name: 'Photo 1 of 1' });
    for (const c of cases) {
      const row = document.getElementById(c.id)!;
      const frame = row.querySelector('img')!.closest('div[class*="flex-col"]')!.parentElement!;
      expect(frame.getAttribute('data-not-sent'), c.status).toBe(c.tone);
      if (c.tone) {
        expect(frame.className, c.status).toMatch(/border-dashed border-danger/);
        // the photos come before the meta line and the status line
        const status = [...row.querySelectorAll('p')].find((p) => /^Not (sent|delivered)/.test(p.textContent ?? ''))!;
        expect(status, c.status).toBeTruthy();
        expect(frame.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING, c.status).toBeTruthy();
      } else {
        expect(frame.className).not.toMatch(/border-dashed/);
      }
    }
  });

  it('R-MMS-8: an outbound picture message shows its photos with neutral alt text ("Photo 1 of 2") and draws no empty text bubble', async () => {
    const M = '01900000-0000-7000-8000-0000000e5801';
    const items = [timelineItem({ id: M, detail: 'mms:outbound', preview: '', occurredAt: iso(-60_000), actor: { userId: IDS.me, displayName: 'Ava Agent' }, status: 'delivered' })];
    const fake = threadFake(items).on(`GET /contacts/${IDS.jane}/attachments`, {
      status: 200,
      body: {
        messages: [{ messageId: M, media: [{ position: 0, contentType: 'image/jpeg', byteSize: 400_000, inline: true, url: `/api/messages/${M}/media/0` }, { position: 1, contentType: 'image/jpeg', byteSize: 300_000, inline: true, url: `/api/messages/${M}/media/1` }], skipped: [] }],
        voicemails: [],
      },
    });
    agentApp(fake, `/contacts/${IDS.jane}/thread`);
    expect(await screen.findByRole('img', { name: 'Photo 1 of 2' })).toBeInTheDocument();
    const row = screen.getByRole('img', { name: 'Photo 2 of 2' }).closest('li[id]')!;
    expect(row.textContent).toContain('Ava Agent');
    expect(row.textContent).toContain('SMS');
    expect([...row.querySelectorAll('p')].every((p) => (p.textContent ?? '').trim() !== '')).toBe(true);
    expect(screen.queryByRole('img', { name: /they sent/ })).toBeNull();
  });

  it('R-MMS-8: the picture-message carrier codes and a photo that was gone at send time are said in words', async () => {
    expect(providerCodeSentence('11751')).toBe('a photo or video was larger than their carrier allows');
    expect(providerCodeSentence('30019')).toBe('the photos or videos were larger than their carrier allows');
    expect(providerCodeSentence('12300')).toBe("the phone service couldn't use one of the files");
    expect(providerCodeSentence('21620')).toBe("the phone service couldn't fetch the photos");
    expect(providerCodeSentence('21623')).toBe('too many photos or videos for one text');
    expect(messageStatus({ status: 'failed', statusReason: 'MEDIA_UNAVAILABLE', channel: 'mms' }, 'Jane')).toEqual({ text: 'Not sent: the photos or videos were no longer available', tone: 'failed' });
    // the same reason on another status is not this sentence; a carrier refusal is Not delivered
    expect(messageStatus({ status: 'undelivered', statusReason: 'PROVIDER_UNDELIVERED', providerErrorCode: '30019', channel: 'mms' }, 'Jane')!.text).toBe('Not delivered: the photos or videos were larger than their carrier allows');
    const items = [timelineItem({ id: '01900000-0000-7000-8000-0000000e5802', detail: 'mms:outbound', preview: 'The kitchen', occurredAt: iso(-60_000), actor: { userId: IDS.me, displayName: 'Ava Agent' }, status: 'failed', statusReason: 'MEDIA_UNAVAILABLE' })];
    agentApp(threadFake(items), `/contacts/${IDS.jane}/thread`);
    expect(await screen.findByText('Not sent: the photos or videos were no longer available')).toBeInTheDocument();
  });
});
