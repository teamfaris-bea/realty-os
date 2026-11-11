// Needs review (Owner/Admin/Team Lead): held lead emails newest first with the server's sentence (never the
// hold code), what was read from each, the email text on request; Accept (one tap when there is a contact
// point, a small form for the reviewer's typing otherwise), Discard behind a confirm, "Lead created" with a
// link to the contact, the Decided tab, the waiting count and the empty state; error codes as sentences.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LEAD_EMAIL_ERROR_MESSAGES } from './messages.js';
import { newestFirst } from './NeedsReviewPage.js';
import { FakeFetch, err, leadEmailApp, review } from './testing.js';
import type { ReviewItem } from './types.js';

const CONTACT = '01900000-0000-7000-8000-00000000c0c1';
const older = review({ id: '01900000-0000-7000-8000-0000000e1000', receivedAt: '2026-11-10T09:00:00.000Z', subject: 'Older lead', holdCode: 'SENDER_NOT_ALLOWED', holdSentence: 'The sender is not on this lead source’s allowed list.' });
const unreadable = review({
  id: '01900000-0000-7000-8000-0000000e1002',
  receivedAt: '2026-11-11T16:00:00.000Z',
  subject: 'Inquiry',
  holdCode: 'NO_CONTACT_POINT',
  holdSentence: 'No phone number or email address could be read from this email.',
  canAccept: false,
  fields: { name: { value: 'Rae Unknown', span: { start: 0, end: 11 } }, phones: [], emails: [], message: null, property: null, listingId: null, leadType: 'general' },
});

function fake(items: ReviewItem[] = [review(), older], decided: ReviewItem[] = []) {
  return new FakeFetch()
    .on('GET /lead-email/reviews?status=needs_review', { status: 200, body: { items, pendingCount: items.length } })
    .on('GET /lead-email/reviews?status=decided', { status: 200, body: { items: decided, pendingCount: items.length } });
}

const card = (name: string | RegExp) => screen.getAllByRole('article').find((a) => within(a).queryByRole('heading', { level: 2, name }))!;

describe('Needs review', () => {
  it('lists held emails newest first with the reason sentence, received time, source, sender domain, subject and what was read; the count is in the header; codes never show', async () => {
    leadEmailApp(fake(), '/team/lead-email', 'team_lead');
    expect(await screen.findByRole('heading', { level: 1, name: 'Needs review' })).toBeInTheDocument();
    expect(await screen.findByText('2 emails waiting for review')).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['New lead for 12 Elm St', 'Older lead']);
    const c = within(card('New lead for 12 Elm St'));
    expect(c.getByText(/may not really be from the portal/)).toBeInTheDocument();
    expect(c.getByText(/· Portal · from zillow\.com/)).toBeInTheDocument();
    expect(c.getByText('Dana Field')).toBeInTheDocument();
    expect(c.getByText('(415) 555-0134')).toBeInTheDocument();
    expect(c.getByText('dana@example.test')).toBeInTheDocument();
    expect(c.getByText('12 Elm St')).toBeInTheDocument();
    expect(c.getByText('Can I tour Saturday?')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/DKIM_UNALIGNED|SENDER_NOT_ALLOWED|LEAD_EMAIL_/);
    expect(newestFirst([older, review()]).map((i) => i.subject)).toEqual(['New lead for 12 Elm St', 'Older lead']);
  });

  it('the email text is behind "Show the email" and opens on request', async () => {
    leadEmailApp(fake([review()]), '/team/lead-email', 'admin');
    const u = userEvent.setup();
    const summary = await screen.findByText('Show the email');
    const details = summary.closest('details')!;
    expect(details).not.toHaveAttribute('open');
    await u.click(summary);
    expect(details).toHaveAttribute('open');
    expect(within(details).getByText(/Message: Can I tour Saturday\?/)).toBeInTheDocument();
  });

  it('Accept is one tap when the email has a contact point; "Lead created" links to the contact', async () => {
    const f = fake([review()]).on(`POST /lead-email/reviews/${review().id}/accept`, { status: 200, body: { review: review({ status: 'accepted', contactId: CONTACT, canAccept: false }), contactId: CONTACT } });
    leadEmailApp(f, '/team/lead-email', 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Accept: New lead for 12 Elm St' }));
    expect(await screen.findByText('Lead created')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Dana Field' })).toHaveAttribute('href', `/contacts/${CONTACT}`);
    expect(f.callsTo(`POST /lead-email/reviews/${review().id}/accept`)[0]!.body).toEqual({});
  });

  it('without a usable phone or email, Accept opens a form; nothing is sent until one is typed; the typing goes as the overrides', async () => {
    const f = fake([unreadable]).on(`POST /lead-email/reviews/${unreadable.id}/accept`, { status: 200, body: { review: { ...unreadable, status: 'accepted', contactId: CONTACT }, contactId: CONTACT } });
    leadEmailApp(f, '/team/lead-email', 'team_lead');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Accept: Inquiry' }));
    const form = screen.getByRole('form', { name: 'Accept as a lead' });
    expect(within(form).getByLabelText('Name')).toHaveValue('Rae Unknown');
    await u.click(within(form).getByRole('button', { name: 'Create lead' }));
    expect(within(form).getByText(LEAD_EMAIL_ERROR_MESSAGES.LEAD_EMAIL_NO_CONTACT_POINT!)).toBeInTheDocument();
    expect(f.callsTo(`POST /lead-email/reviews/${unreadable.id}/accept`)).toHaveLength(0);
    await u.clear(within(form).getByLabelText('Name'));
    await u.type(within(form).getByLabelText('Name'), 'Rae Smith');
    await u.type(within(form).getByLabelText('Phone'), '415 555 0199');
    await u.click(within(form).getByRole('button', { name: 'Create lead' }));
    expect(await screen.findByRole('link', { name: 'Open Rae Smith' })).toHaveAttribute('href', `/contacts/${CONTACT}`);
    expect(f.callsTo(`POST /lead-email/reviews/${unreadable.id}/accept`)[0]!.body).toEqual({ name: 'Rae Smith', phone: '415 555 0199' });
  });

  it('the server refusing for lack of a contact point is a sentence and opens the form', async () => {
    const f = fake([review()]).on(`POST /lead-email/reviews/${review().id}/accept`, err(422, 'LEAD_EMAIL_NO_CONTACT_POINT'));
    leadEmailApp(f, '/team/lead-email', 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Accept: New lead for 12 Elm St' }));
    expect(await screen.findByText(LEAD_EMAIL_ERROR_MESSAGES.LEAD_EMAIL_NO_CONTACT_POINT!)).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Accept as a lead' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/LEAD_EMAIL_/);
  });

  it('someone else decided first: the sentence says so and the list is fetched again', async () => {
    const f = fake([review()]).on(`POST /lead-email/reviews/${review().id}/accept`, err(409, 'LEAD_EMAIL_NOT_PENDING', { review: review({ status: 'discarded' }) }));
    leadEmailApp(f, '/team/lead-email', 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Accept: New lead for 12 Elm St' }));
    expect(await screen.findByText(LEAD_EMAIL_ERROR_MESSAGES.LEAD_EMAIL_NOT_PENDING!)).toBeInTheDocument();
    await waitFor(() => expect(f.callsTo('GET /lead-email/reviews?status=needs_review').length).toBeGreaterThan(1));
  });

  it('Discard asks first; Keep it sends nothing; Discard email discards', async () => {
    const f = fake([review()]).on(`POST /lead-email/reviews/${review().id}/discard`, { status: 200, body: { review: review({ status: 'discarded', text: null }), contactId: null } });
    leadEmailApp(f, '/team/lead-email', 'admin');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Discard: New lead for 12 Elm St' }));
    let dialog = screen.getByRole('dialog', { name: 'Discard this email?' });
    await u.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(f.callsTo(`POST /lead-email/reviews/${review().id}/discard`)).toHaveLength(0);
    await u.click(screen.getByRole('button', { name: 'Discard: New lead for 12 Elm St' }));
    dialog = screen.getByRole('dialog', { name: 'Discard this email?' });
    await u.click(within(dialog).getByRole('button', { name: 'Discard email' }));
    expect(await screen.findByText('Email discarded. No lead was made.')).toBeInTheDocument();
    expect(f.callsTo(`POST /lead-email/reviews/${review().id}/discard`)).toHaveLength(1);
  });

  it('the Decided tab lists accepted (with a link to the lead) and discarded emails, without buttons', async () => {
    const decided = [review({ status: 'accepted', contactId: CONTACT, decidedAt: '2026-11-11T16:30:00.000Z', canAccept: false }), review({ id: '01900000-0000-7000-8000-0000000e1009', subject: null, fields: null, senderDomain: 'prizes.example.test', status: 'discarded', text: null, decidedAt: '2026-11-11T16:40:00.000Z', canAccept: false })];
    leadEmailApp(fake([], decided), '/team/lead-email', 'owner');
    const u = userEvent.setup();
    expect(await screen.findByText('Nothing needs review')).toBeInTheDocument();
    expect(screen.getByText('No emails are waiting for review.')).toBeInTheDocument();
    await u.click(screen.getByRole('radio', { name: 'Decided' }));
    expect(await screen.findByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText('Discarded')).toBeInTheDocument();
    // the server deletes a decided email's content: the card is named by its sender and says so
    expect(screen.getByRole('heading', { level: 2, name: 'Email from prizes.example.test' })).toBeInTheDocument();
    expect(screen.getByText('The email itself was deleted once it was decided.')).toBeInTheDocument();
    expect(screen.queryByText('Nothing could be read from this email.')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open the lead' })).toHaveAttribute('href', `/contacts/${CONTACT}`);
    expect(screen.queryByRole('button', { name: /^Accept/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Discard/ })).toBeNull();
  });

  it('roles: an Agent, ISA or TC is not shown the page', async () => {
    for (const role of ['agent', 'isa', 'tc'] as const) {
      const f = fake();
      const { view } = leadEmailApp(f, '/team/lead-email', role);
      expect(await screen.findByText("This page isn't available")).toBeInTheDocument();
      expect(f.callsTo('GET /lead-email/reviews?status=needs_review')).toHaveLength(0);
      view.unmount();
    }
  });
});
