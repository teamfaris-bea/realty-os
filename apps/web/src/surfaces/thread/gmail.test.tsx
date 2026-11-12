// Module 69 in the thread (jsdom, scripted API): synced Gmail merged into the conversation by time, tagged
// "Gmail (read-only)", the contact's role and "and N others" (never other addresses), "Older messages stay in
// Gmail" when the thread is capped, attachment names only, no reply button, the empty-body sentence, the
// coverage line, and the mailbox owner's "Remove this thread from Realty OS" in 2 taps.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, decision, err, fullContact, iso, timelineItem } from '../feed/lib/testing.js';
import { GMAIL_NOT_FIRST_CONTACT, GMAIL_TAG, type MailMessageView, lastInboundAcross, NO_TEXT, OLDER_GMAIL, REMOVE_THREAD, REMOVE_THREAD_CONSEQUENCE, THREAD_CAPPED, THREAD_REMOVED, coverageLines, mergeByTime, participantsWords } from './gmail.js';

const mid = (n: number) => `01900000-0000-7000-8000-0000000a${String(7000 + n).padStart(4, '0')}`;

function mail(over: Partial<MailMessageView> = {}): MailMessageView {
  return {
    id: mid(1),
    threadId: 'thr-1',
    internalAt: iso(-3_600_000),
    sender: 'contact',
    contactRole: 'from',
    otherRecipientCount: 0,
    subject: 'Offer on 12 Oak St',
    body: 'We would like to go in at 950.',
    bodyTruncated: false,
    attachments: [],
    origin: 'live',
    mine: true,
    mailboxOwnerName: 'Ava Agent',
    threadCapped: false,
    ...over,
  };
}

const MAIL_PATH = `GET /contacts/${IDS.jane}/mail-messages?limit=100`;

function fake(items: MailMessageView[], coverage = [{ address: 'jane@example.test', since: '2026-10-12T00:00:00.000Z' }], nextBefore: string | null = null) {
  return new FakeFetch()
    .on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact: fullContact() } })
    .on(`GET /contacts/${IDS.jane}/timeline?limit=100`, {
      status: 200,
      body: {
        items: [
          timelineItem({ id: '01900000-0000-7000-8000-0000000e0002', detail: 'sms:inbound', preview: 'see you at 5', occurredAt: iso(-60_000) }),
          timelineItem({ id: '01900000-0000-7000-8000-0000000e0001', detail: 'sms:inbound', preview: 'does saturday work?', occurredAt: iso(-7_200_000) }),
        ],
        nextCursor: null,
      },
    })
    .on(`POST /contacts/${IDS.jane}/messages/preview`, { status: 200, body: { decision: decision({ id: null, phase: 'preview' }), body: '' } })
    .on(MAIL_PATH, { status: 200, body: { items, coverage, nextBefore } });
}

async function convo() {
  const list = await screen.findByRole('list', { name: 'Conversation' });
  await within(list).findByText('see you at 5');
  return list;
}

describe('mergeByTime', () => {
  it('interleaves timeline items (oldest first) and Gmail copies (newest first) by time, oldest first', () => {
    const t = [timelineItem({ id: 'a', occurredAt: '2026-11-10T10:00:00.000Z' }), timelineItem({ id: 'c', occurredAt: '2026-11-10T12:00:00.000Z' })];
    const m = [mail({ id: 'd', internalAt: '2026-11-10T13:00:00.000Z' }), mail({ id: 'b', internalAt: '2026-11-10T11:00:00.000Z' }), mail({ id: 'z', internalAt: '2026-11-10T09:00:00.000Z' })];
    expect(mergeByTime(t, m).map((e) => `${e.kind}:${e.item.id}`)).toEqual(['gmail:z', 'timeline:a', 'gmail:b', 'timeline:c', 'gmail:d']);
  });

  it('ties keep the timeline item first, then Gmail oldest first; empty inputs are fine', () => {
    const at = '2026-11-10T10:00:00.000Z';
    const t = [timelineItem({ id: 'a', occurredAt: at })];
    expect(mergeByTime(t, [mail({ id: 'm2', internalAt: at }), mail({ id: 'm1', internalAt: at })]).map((e) => e.item.id)).toEqual(['a', 'm1', 'm2']);
    expect(mergeByTime([], [])).toEqual([]);
    expect(mergeByTime(t, []).map((e) => e.item.id)).toEqual(['a']);
  });

  it('keeps the timeline order as given and puts an unparseable time first', () => {
    const t = [timelineItem({ id: 'a', occurredAt: '2026-11-10T10:00:00.000Z' }), timelineItem({ id: 'b', occurredAt: '2026-11-10T10:00:00.000Z' })];
    expect(mergeByTime(t, [mail({ id: 'x', internalAt: 'not a date' })]).map((e) => e.item.id)).toEqual(['x', 'a', 'b']);
  });
});

describe('participantsWords', () => {
  it('names only the contact and the mailbox owner, with a count for everyone else', () => {
    expect(participantsWords(mail(), 'Jane Doe')).toBe('From Jane Doe to Ava Agent');
    expect(participantsWords(mail({ otherRecipientCount: 1 }), 'Jane Doe')).toBe('From Jane Doe to Ava Agent and 1 other');
    expect(participantsWords(mail({ sender: 'mailbox', contactRole: 'to', otherRecipientCount: 3 }), 'Jane Doe')).toBe('From Ava Agent to Jane Doe and 3 others');
    expect(participantsWords(mail({ sender: 'other', contactRole: 'cc', otherRecipientCount: 2 }), 'Jane Doe')).toBe('From someone else to Jane Doe (Cc) and 2 others');
    expect(participantsWords(mail({ sender: 'mailbox', contactRole: 'bcc' }), 'Jane Doe')).toBe('From Ava Agent to Jane Doe (Bcc)');
  });
});

describe('synced Gmail in the thread', () => {
  it('merges entries by time, tagged "Gmail (read-only)", with role and "and N others", no addresses, no reply button', async () => {
    agentApp(fake([mail({ id: mid(2), sender: 'mailbox', contactRole: 'cc', otherRecipientCount: 2, internalAt: iso(-1_800_000), subject: 'Re: Offer', body: 'Sending it now.' }), mail()]), `/contacts/${IDS.jane}/thread`);
    const list = await convo();
    await within(list).findByText('Sending it now.');
    const rows = within(list)
      .getAllByRole('listitem')
      .filter((li) => li.parentElement === list)
      .map((li) => li.textContent ?? '');
    const order = ['does saturday work?', 'We would like to go in at 950.', 'Sending it now.', 'see you at 5'].map((t) => rows.findIndex((r) => r.includes(t)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...list.querySelectorAll('[data-gmail-tag]')].map((e) => e.textContent)).toEqual([GMAIL_TAG, GMAIL_TAG]);
    expect(within(list).getByText(/From Ava Agent to Jane Doe \(Cc\) and 2 others/)).toBeVisible();
    expect(within(list).getByText(/From Jane Doe to Ava Agent ·/)).toBeVisible();
    const entries = [...list.querySelectorAll('[data-gmail-entry]')] as HTMLElement[];
    for (const e of entries) {
      expect(e.textContent).not.toContain('@');
      expect(within(e).queryByRole('button', { name: /reply/i })).toBeNull();
    }
    expect(screen.getByText('Showing Gmail with jane@example.test since Oct 12, 2026; other mail stays in Gmail.')).toBeVisible();
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it('a capped thread says older messages stay in Gmail; attachments are names only, open in Gmail; an empty body says so', async () => {
    agentApp(fake([mail({ threadCapped: true, body: '', attachments: [{ name: 'preapproval.pdf', mimeType: 'application/pdf', sizeBytes: 120_000 }, { name: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 5 }] })]), `/contacts/${IDS.jane}/thread`);
    const list = await convo();
    const entry = (await within(list).findByText(NO_TEXT)).closest('li')!;
    expect(within(entry).getByText(THREAD_CAPPED)).toBeVisible();
    expect(within(entry).getByText('Attachments, open in Gmail:')).toBeVisible();
    expect(within(entry).getByText('preapproval.pdf')).toBeVisible();
    expect(within(entry).getByText('photo.jpg')).toBeVisible();
    expect(within(entry).queryByRole('link')).toBeNull();
  });

  it('only the mailbox owner sees Remove this thread; it is 2 taps, states the final consequence, and the thread leaves', async () => {
    const f = fake([mail(), mail({ id: mid(3), threadId: 'thr-2', internalAt: iso(-1_000_000), body: 'Other thread', mine: true })]);
    f.on(`POST /me/mail-threads/thr-1/exclude`, { status: 200, body: { excluded: true } });
    agentApp(f, `/contacts/${IDS.jane}/thread`);
    const list = await convo();
    const entry = (await within(list).findByText('We would like to go in at 950.')).closest('li')!;
    f.on(MAIL_PATH, { status: 200, body: { items: [mail({ id: mid(3), threadId: 'thr-2', internalAt: iso(-1_000_000), body: 'Other thread', mine: true })], coverage: [], nextBefore: null } });
    await userEvent.click(within(entry).getByRole('button', { name: REMOVE_THREAD }));
    const sheet = await screen.findByRole('dialog', { name: 'Remove this thread from Realty OS?' });
    expect(sheet).toHaveAccessibleDescription(REMOVE_THREAD_CONSEQUENCE);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Remove thread' }));
    await waitFor(() => expect(within(list).queryByText('We would like to go in at 950.')).toBeNull());
    expect(within(list).getByText('Other thread')).toBeVisible();
    // the opener left with the entry: focus lands on the conversation, not <body>, and the removal is announced
    await waitFor(() => expect(document.activeElement).toBe(list));
    expect((await screen.findAllByText(THREAD_REMOVED)).length).toBeGreaterThan(0);
    expect(screen.getByTestId('announcer')).toHaveTextContent(THREAD_REMOVED);
    expect(f.callsTo('POST /me/mail-threads/thr-1/exclude')).toHaveLength(1);
  });

  it('someone who is not the mailbox owner (a Team Lead reading the timeline) gets no Remove button', async () => {
    agentApp(fake([mail({ mine: false })]), `/contacts/${IDS.jane}/thread`, 'team_lead');
    const list = await convo();
    await within(list).findByText('We would like to go in at 950.');
    expect(within(list).queryByRole('button', { name: REMOVE_THREAD })).toBeNull();
  });

  it('a refused removal says why and keeps the thread', async () => {
    const f = fake([mail()]);
    f.on(`POST /me/mail-threads/thr-1/exclude`, err(404, 'NOT_FOUND'));
    agentApp(f, `/contacts/${IDS.jane}/thread`);
    const list = await convo();
    await userEvent.click(await within(list).findByRole('button', { name: REMOVE_THREAD }));
    const sheet = await screen.findByRole('dialog', { name: 'Remove this thread from Realty OS?' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Remove thread' }));
    expect(await within(sheet).findByRole('alert')).toBeVisible();
    expect(within(list).getByText('We would like to go in at 950.')).toBeInTheDocument();
  });

  it('without the mail route (404) the thread is exactly as before: no Gmail, no coverage line', async () => {
    const f = fake([]);
    f.on(MAIL_PATH, err(404, 'NOT_FOUND'));
    agentApp(f, `/contacts/${IDS.jane}/thread`);
    const list = await convo();
    expect(list.querySelector('[data-gmail-entry]')).toBeNull();
    expect(screen.queryByText(/Showing Gmail with/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('with more pages (nextBefore), "since" is the oldest copy shown and older Gmail is said to stay in Gmail', async () => {
    const shownOldest = '2026-11-01T12:00:00.000Z';
    agentApp(fake([mail({ internalAt: shownOldest })], [{ address: 'jane@example.test', since: '2026-08-01T00:00:00.000Z' }], shownOldest), `/contacts/${IDS.jane}/thread`);
    await convo();
    expect(await screen.findByText('Showing Gmail with jane@example.test since Nov 1, 2026; other mail stays in Gmail.')).toBeVisible();
    expect(screen.getByText(OLDER_GMAIL)).toBeVisible();
    expect(screen.queryByText(/since Aug 1, 2026/)).toBeNull();
  });
});

describe('coverageLines', () => {
  const cov = [{ address: 'jane@example.test', since: '2026-08-01T00:00:00.000Z' }];
  it('uses the API date when every copy is shown', () => {
    expect(coverageLines({ coverage: cov, items: [mail({ internalAt: '2026-11-01T00:00:00.000Z' })], nextBefore: null })).toEqual({ lines: cov, older: false });
  });
  it('never claims earlier than the oldest copy shown while more pages exist, and never earlier than the API date', () => {
    expect(coverageLines({ coverage: cov, items: [mail({ internalAt: '2026-11-02T00:00:00.000Z' }), mail({ internalAt: '2026-11-01T00:00:00.000Z' })], nextBefore: '2026-11-01T00:00:00.000Z' })).toEqual({
      lines: [{ address: 'jane@example.test', since: '2026-11-01T00:00:00.000Z' }],
      older: true,
    });
    const late = [{ address: 'jane@example.test', since: '2026-11-05T00:00:00.000Z' }];
    expect(coverageLines({ coverage: late, items: [mail({ internalAt: '2026-11-01T00:00:00.000Z' })], nextBefore: 'x' }).lines).toEqual(late);
    expect(coverageLines(undefined)).toEqual({ lines: [], older: false });
  });
});

// ---- batch 7 interaction review (web UI group) -------------------------------------------------------------

/** Jane's thread with only the given timeline items (newest first) and the given Gmail copies. */
function fakeWith(timeline: ReturnType<typeof timelineItem>[], items: MailMessageView[], contact = fullContact()) {
  return fake(items)
    .on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact } })
    .on(`GET /contacts/${IDS.jane}/timeline?limit=100`, { status: 200, body: { items: timeline, nextCursor: null } });
}

describe('b7 ui/F1: the compose box counts synced Gmail as where the client wrote last (R-INBOX-1, R-GMAIL-5)', () => {
  it('lastInboundAcross: a newer Gmail from the contact is email; an older one, or one from the mailbox, is not', () => {
    const sms = [timelineItem({ detail: 'sms:inbound', occurredAt: '2026-11-10T10:00:00.000Z' })];
    expect(lastInboundAcross(sms, [mail({ internalAt: '2026-11-10T11:00:00.000Z' })], true)).toBe('email');
    expect(lastInboundAcross(sms, [mail({ internalAt: '2026-11-10T09:00:00.000Z' })], true)).toBe('sms');
    expect(lastInboundAcross(sms, [mail({ sender: 'mailbox', internalAt: '2026-11-10T11:00:00.000Z' })], true)).toBe('sms');
    expect(lastInboundAcross([], [mail()], true)).toBe('email');
    // no email address to reply to: no claim about where they wrote last rather than a false one
    expect(lastInboundAcross(sms, [mail({ internalAt: '2026-11-10T11:00:00.000Z' })], false)).toBeNull();
    expect(lastInboundAcross(sms, [], true)).toBe('sms');
  });

  it('b7 ui/F1: an inbound text 2 h ago and a Gmail from Jane 1 min ago: the box replies by email and never says she wrote last by text', async () => {
    const timeline = [timelineItem({ id: '01900000-0000-7000-8000-0000000e0011', detail: 'sms:inbound', preview: 'does saturday work?', occurredAt: iso(-7_200_000) })];
    agentApp(fakeWith(timeline, [mail({ internalAt: iso(-60_000), body: 'Newest from Jane by Gmail' })]), `/contacts/${IDS.jane}/thread`);
    const list = await screen.findByRole('list', { name: 'Conversation' });
    await within(list).findByText('Newest from Jane by Gmail');
    const email = await screen.findByRole('radio', { name: 'Email' });
    await waitFor(() => expect(email).toBeChecked());
    expect(screen.getByTestId('channel-why')).toHaveTextContent('Replying by email, where Jane wrote last.');
    expect(document.body.textContent).not.toContain('Replying by text, where Jane wrote last.');
  });
});

describe('b7 ui/F6: the empty line waits for the synced mail; a merged-away record shows no Gmail (R-GMAIL-5, R-PAR-45)', () => {
  it('b7 ui/F6: while the mail is still loading, "No messages or calls yet." is not shown; with no mail at all it is', async () => {
    let release: (r: { status: number; body: unknown }) => void = () => {};
    const f = fakeWith([], []).on(MAIL_PATH, () => new Promise((res) => (release = res)));
    agentApp(f, `/contacts/${IDS.jane}/thread`);
    await screen.findByRole('list', { name: 'Conversation' });
    await waitFor(() => expect(f.callsTo(MAIL_PATH).length).toBeGreaterThan(0));
    await waitFor(() => expect(f.callsTo(`GET /contacts/${IDS.jane}/timeline?limit=100`).length).toBeGreaterThan(0));
    // give the timeline time to settle while the mail stays pending
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('No messages or calls yet.')).toBeNull();
    release({ status: 200, body: { items: [mail({ body: 'Only Gmail here' })], coverage: [], nextBefore: null } });
    expect(await screen.findByText('Only Gmail here')).toBeVisible();
    expect(screen.queryByText('No messages or calls yet.')).toBeNull();
  });

  it('b7 ui/F6: with no messages and no Gmail the empty line shows once the mail answered', async () => {
    agentApp(fakeWith([], []), `/contacts/${IDS.jane}/thread`);
    expect(await screen.findByText('No messages or calls yet.')).toBeVisible();
  });

  it('b7 ui/F6: a merged-away record does not ask for or show its Gmail (the copies move to the current record), and offers no Remove', async () => {
    const f = fakeWith([], [mail({ body: 'Mail on the merged-away record' })], fullContact({ merged: true, mergedIntoContactId: IDS.jane.replace(/.$/, 'f') }));
    agentApp(f, `/contacts/${IDS.jane}/thread`);
    expect(await screen.findByText(/This record was merged into another contact/)).toBeVisible();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Mail on the merged-away record')).toBeNull();
    expect(screen.queryByRole('button', { name: REMOVE_THREAD })).toBeNull();
    expect(f.callsTo(MAIL_PATH)).toHaveLength(0);
  });
});

describe('b7 sends/F4: Gmail replies are never first contact, and the thread says so (R-GMAIL-14, D8)', () => {
  const open = fullContact({ ownership: { ...fullContact().ownership, firstTouchDueAt: iso(600_000), firstTouchAt: null, firstTouchBreachedAt: null } });

  it("b7 sends/F4: while Jane's first-contact deadline is open, the mailbox owner's own Gmail reply says it does not count", async () => {
    agentApp(fakeWith([], [mail({ sender: 'mailbox', contactRole: 'to', body: 'Replied from Gmail' })], open), `/contacts/${IDS.jane}/thread`);
    const entry = (await screen.findByText('Replied from Gmail')).closest('li')!;
    expect(within(entry).getByText(GMAIL_NOT_FIRST_CONTACT)).toBeVisible();
    expect(GMAIL_NOT_FIRST_CONTACT).toBe("Replies you send from Gmail don't count as first contact. Reply here to stop the clock.");
  });

  it('b7 sends/F4: not on mail from Jane, not on someone else’s mailbox, and not once the deadline is met', async () => {
    agentApp(fakeWith([], [mail({ id: mid(5), body: 'From Jane' }), mail({ id: mid(6), sender: 'mailbox', mine: false, body: 'From a colleague mailbox' })], open), `/contacts/${IDS.jane}/thread`);
    await screen.findByText('From a colleague mailbox');
    expect(screen.queryByText(GMAIL_NOT_FIRST_CONTACT)).toBeNull();
  });

  it('b7 sends/F4: not to a mailbox owner who does not own the lead (their reply here would not stop the clock)', async () => {
    const notMine = fullContact({ ownership: { ...open.ownership, ownedByMe: false, ownerUserId: IDS.jane } });
    agentApp(fakeWith([], [mail({ sender: 'mailbox', contactRole: 'to', body: 'Replied from Gmail' })], notMine), `/contacts/${IDS.jane}/thread`);
    await screen.findByText('Replied from Gmail');
    expect(screen.queryByText(GMAIL_NOT_FIRST_CONTACT)).toBeNull();
  });

  it('b7 sends/F4: after first contact (firstTouchAt set) the sentence is gone', async () => {
    agentApp(fakeWith([], [mail({ sender: 'mailbox', contactRole: 'to', body: 'Replied from Gmail' })]), `/contacts/${IDS.jane}/thread`);
    await screen.findByText('Replied from Gmail');
    expect(screen.queryByText(GMAIL_NOT_FIRST_CONTACT)).toBeNull();
  });
});
