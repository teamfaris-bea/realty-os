// The System page in jsdom on the scripted API: every section from a realistic overview, "All clear"
// only when nothing needs a look, Retry / Cancel ask first then post and refetch, error codes come back
// as sentences, and nothing that could identify a client is ever rendered.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { FakeFetch, ID, err, leadAdminApp } from '../lib/testing.js';
import { LEAD_ADMIN_ERROR_MESSAGES } from '../lib/messages.js';
import type { JobView, SystemOverview } from './types.js';
import { connectionKindWords, summaryWords } from './words.js';

const job = (over: Partial<JobView> = {}): JobView => ({
  id: '41',
  kind: 'comms.dispatch',
  kindLabel: 'Send a message',
  queue: 'default',
  state: 'dead',
  attempts: 10,
  maxAttempts: 10,
  reason: { code: 'CONNECTION', sentence: 'A connection to the database or a provider failed. Retry once the connection is back.', retryHelps: true },
  detail: 'ECONNREFUSED 127.0.0.1:5432',
  nextRunAt: null,
  finishedAt: '2026-11-11T15:00:00.000Z',
  createdAt: '2026-11-11T14:00:00.000Z',
  canRetry: true,
  canCancel: false,
  ...over,
});

const retrying = job({ id: '42', kind: 'ownership.offer_expiry', kindLabel: 'Lead offer timer', state: 'retrying', attempts: 3, maxAttempts: 10, reason: { code: 'DB_40001', sentence: 'The database was busy with a conflicting change at the same moment. Retrying usually works.', retryHelps: true }, detail: '40001', finishedAt: null, nextRunAt: '2026-11-11T15:10:00.000Z', canCancel: true });

function overview(over: Partial<SystemOverview> = {}): SystemOverview {
  return {
    generatedAt: '2026-11-11T15:05:00.000Z',
    jobs: { counts: { dead: 1, retrying: 1 }, dead: [job()], retrying: [retrying] },
    messages: [{ id: ID.message, contactId: ID.pat, channel: 'sms', status: 'dispatch_unknown', dispatchedAt: '2026-11-11T14:40:00.000Z', ageSeconds: 1500, reconcile: { state: 'unresolved', sentence: 'The provider has no record of it. It will be marked failed so someone can decide to send it again by hand.', nextStepAt: null } }],
    timers: { windowHours: 24, thresholdSeconds: 60, fired: 40, lateCount: 2, late: [{ contactId: ID.pat, kind: 'first_touch_breached', label: 'First-touch deadline missed', dueAt: '2026-11-11T10:00:00.000Z', firedAt: '2026-11-11T10:04:00.000Z', lateSeconds: 240 }] },
    connections: [{ id: 'c1', kind: 'zillow_feed', name: 'Harbor Zillow', status: 'degraded', statusReason: 'TOKEN_EXPIRED', lastErrorCode: 'HTTP_401', lastSyncedAt: '2026-11-11T12:00:00.000Z' }],
    registrations: [{ id: 'r1', kind: 'a2p_campaign', status: 'approved', changedAt: '2026-11-01T00:00:00.000Z' }],
    channels: [{ channel: 'sms', sent: 12, failed: 1, inFlight: 0 }, { channel: 'email', sent: 4, failed: 0, inFlight: 1 }],
    ...over,
  };
}

const empty = (): SystemOverview => overview({ jobs: { counts: { dead: 0, retrying: 0 }, dead: [], retrying: [] }, messages: [], timers: { windowHours: 24, thresholdSeconds: 60, fired: 0, lateCount: 0, late: [] }, connections: [], registrations: [], channels: [] });

function systemFake(o: SystemOverview | (() => SystemOverview) = overview()) {
  return new FakeFetch().on('GET /system/overview', () => ({ status: 200, body: typeof o === 'function' ? o() : o }));
}

async function violations(): Promise<string[]> {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

describe('System page', () => {
  it('shows every section from the overview in order, in plain words', async () => {
    leadAdminApp(systemFake(), '/admin/system', 'owner');
    expect(await screen.findByRole('heading', { level: 1, name: 'System' })).toBeInTheDocument();
    expect(await screen.findByText('Needs a look: 1 job stopped retrying, 1 job waiting to try again, 1 message stuck while sending and 2 timers fired late.')).toBeInTheDocument();
    expect(screen.queryByText(/All clear/)).toBeNull();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Jobs that need attention', 'Messages stuck while sending', 'Timers that fired late (last 24 hours)', 'Provider health']);

    const jobs = screen.getByRole('region', { name: 'Jobs that need attention' });
    const dead = within(jobs).getAllByRole('listitem')[0]!;
    expect(within(dead).getByText('Send a message')).toBeInTheDocument();
    expect(within(dead).getByText('Stopped retrying')).toBeInTheDocument();
    expect(within(dead).getByText(/A connection to the database or a provider failed/)).toBeInTheDocument();
    expect(dead.textContent).toContain('10 of 10 allowed');
    expect(dead.textContent).toMatch(/Last failed Nov 11/);
    expect(within(dead).getByRole('button', { name: 'Retry: Send a message' })).toBeInTheDocument();
    expect(within(dead).queryByRole('button', { name: /Cancel/ })).toBeNull();
    // the technical detail is there for support, collapsed
    const details = within(dead).getByText('Technical detail').closest('details')!;
    expect(details.open).toBe(false);
    expect(within(details).getByText('CONNECTION')).toBeInTheDocument();
    expect(within(details).getByText('ECONNREFUSED 127.0.0.1:5432')).toBeInTheDocument();

    const waiting = within(jobs).getAllByRole('listitem')[1]!;
    expect(waiting.textContent).toContain('3 of 10 allowed');
    expect(waiting.textContent).toMatch(/Next try Nov 11/);
    expect(within(waiting).getByRole('button', { name: 'Cancel job: Lead offer timer' })).toBeInTheDocument();

    const msgs = screen.getByRole('region', { name: 'Messages stuck while sending' });
    expect(within(msgs).getByText('Text messages')).toBeInTheDocument();
    expect(within(msgs).getByText('Not known yet whether it left')).toBeInTheDocument();
    expect(within(msgs).getByText(/Started sending 25 min ago/)).toBeInTheDocument();
    expect(within(msgs).getByText(/The provider has no record of it/)).toBeInTheDocument();
    expect(within(msgs).getByRole('link', { name: 'Open conversation' })).toHaveAttribute('href', `/contacts/${ID.pat}/thread`);

    const timers = screen.getByRole('region', { name: 'Timers that fired late (last 24 hours)' });
    expect(timers.textContent).toContain('2 of 40 timers fired more than 60 seconds late');
    expect(within(timers).getByText('First-touch deadline missed')).toBeInTheDocument();
    expect(within(timers).getByText(/4 min late/)).toBeInTheDocument();
    expect(within(timers).getByText('Showing 1 of 2 late timers.')).toBeInTheDocument();
    expect(within(timers).getByRole('link', { name: 'Open contact' })).toHaveAttribute('href', `/contacts/${ID.pat}`);

    const health = screen.getByRole('region', { name: 'Provider health' });
    expect(health.textContent).toContain('Text messages: 12 sent, 1 failed in the last hour');
    expect(health.textContent).toContain('Email: 4 sent, 0 failed in the last hour, 1 not confirmed yet');
    expect(within(health).getByText('Texting approved')).toBeInTheDocument();
    expect(within(health).getByText('Connected, but having problems')).toBeInTheDocument();
    // stored status codes are not shown as words on the page
    expect(document.body.textContent).not.toContain('TOKEN_EXPIRED');
    expect(document.body.textContent).not.toContain('HTTP_401');
  });

  it('says "All clear" only when there truly is nothing to look at, with honest empty sentences', async () => {
    expect(summaryWords(empty()).clear).toBe(true);
    expect(summaryWords({ ...empty(), timers: { ...empty().timers, fired: 5, lateCount: 1 } }).clear).toBe(false);
    expect(summaryWords({ ...empty(), jobs: { counts: { dead: 0, retrying: 1 }, dead: [], retrying: [] } }).clear).toBe(false);
    expect(summaryWords({ ...empty(), messages: overview().messages }).clear).toBe(false);

    leadAdminApp(systemFake(empty()), '/admin/system', 'admin');
    expect(await screen.findByText(/^All clear/)).toBeInTheDocument();
    expect(screen.getByText('No background jobs have failed. Nothing is waiting to be retried.')).toBeInTheDocument();
    expect(screen.getByText('No messages are stuck while sending.')).toBeInTheDocument();
    expect(screen.getByText('No lead timers fired in the last 24 hours.')).toBeInTheDocument();
    expect(screen.getByText('No messages were sent in the last hour, so there is nothing to report.')).toBeInTheDocument();
    expect(screen.getByText(/No texting registration has been started/)).toBeInTheDocument();
    expect(screen.getByText('No integrations are set up.')).toBeInTheDocument();
  });

  it('retry asks first, says it never sends twice, posts, refetches and announces the result', async () => {
    let retried = false;
    const fake = systemFake(() => (retried ? overview({ jobs: { counts: { dead: 0, retrying: 1 }, dead: [], retrying: [retrying] } }) : overview()));
    fake.on('POST /system/jobs/41/retry', () => ((retried = true), { status: 200, body: { result: 'retried', job: job({ state: 'retrying', attempts: 0 }) } }));
    leadAdminApp(fake, '/admin/system', 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Retry: Send a message' }));
    const dialog = screen.getByRole('dialog', { name: 'Retry this job?' });
    expect(within(dialog).getByText(/Retrying never sends a message twice/)).toBeInTheDocument();
    expect(fake.callsTo('POST /system/jobs/41/retry')).toHaveLength(0);
    await u.click(within(dialog).getByRole('button', { name: 'Retry now' }));
    await waitFor(() => expect(fake.callsTo('POST /system/jobs/41/retry')).toHaveLength(1));
    const said = await screen.findByText('Send a message: retried. It runs again as soon as a worker is free.');
    expect(said).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry: Send a message' })).toBeNull());
  });

  it('going back from the confirmation sends nothing', async () => {
    const fake = systemFake();
    leadAdminApp(fake, '/admin/system', 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Retry: Send a message' }));
    await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Go back' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fake.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('cancel asks first, says a due timer is picked up again, posts, refetches and announces', async () => {
    let cancelled = false;
    const fake = systemFake(() => (cancelled ? overview({ jobs: { counts: { dead: 1, retrying: 0 }, dead: [job()], retrying: [] } }) : overview()));
    fake.on('POST /system/jobs/42/cancel', () => ((cancelled = true), { status: 200, body: { result: 'cancelled', job: null } }));
    leadAdminApp(fake, '/admin/system', 'admin');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Cancel job: Lead offer timer' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel this job?' });
    expect(within(dialog).getByText(/picks that deadline up again automatically/)).toBeInTheDocument();
    expect(fake.callsTo('POST /system/jobs/42/cancel')).toHaveLength(0);
    await u.click(within(dialog).getByRole('button', { name: 'Cancel the job' }));
    await waitFor(() => expect(fake.callsTo('POST /system/jobs/42/cancel')).toHaveLength(1));
    expect(await screen.findByText('Lead offer timer: cancelled.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel job: Lead offer timer' })).toBeNull());
  });

  it('a refused retry shows the sentence, never the code, and keeps the dialog open', async () => {
    const fake = systemFake().on('POST /system/jobs/41/retry', err(409, 'JOB_ALREADY_QUEUED'));
    leadAdminApp(fake, '/admin/system', 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Retry: Send a message' }));
    await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry now' }));
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText(LEAD_ADMIN_ERROR_MESSAGES.JOB_ALREADY_QUEUED!)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('JOB_ALREADY_QUEUED');
  });

  it('D2: Facebook and Instagram connections are named as publishing; the old Meta kinds say they are not offered', async () => {
    const connections = [
      { id: 'c2', kind: 'facebook_page', name: 'Harbor Page', status: 'connected', statusReason: null, lastErrorCode: null, lastSyncedAt: null },
      { id: 'c3', kind: 'instagram_business', name: 'Harbor Instagram', status: 'pending_review', statusReason: 'PLATFORM_REVIEW_PENDING', lastErrorCode: null, lastSyncedAt: null },
      { id: 'c4', kind: 'messenger_page', name: 'Old Page', status: 'disconnected', statusReason: 'DISCONNECTED_BY_USER', lastErrorCode: null, lastSyncedAt: null },
    ];
    leadAdminApp(systemFake(overview({ connections })), '/admin/system', 'owner');
    const health = await screen.findByRole('region', { name: 'Provider health' });
    expect(await within(health).findByText('Facebook Page (publishing) · Harbor Page')).toBeInTheDocument();
    expect(within(health).getByText('Instagram business account (publishing) · Harbor Instagram')).toBeInTheDocument();
    expect(within(health).getByText('Facebook Messenger (not offered) · Old Page')).toBeInTheDocument();
    expect(connectionKindWords('instagram_account')).toBe('Instagram direct messages (not offered)');
    expect(connectionKindWords('meta_lead_ads')).toBe('Meta lead ads (not offered)');
    expect(connectionKindWords('ads_meta')).toBe('Meta ads (not offered)');
  });

  it('a failed load says so in words', async () => {
    leadAdminApp(new FakeFetch().on('GET /system/overview', err(500, 'INTERNAL_ERROR')), '/admin/system', 'owner');
    expect(await screen.findByText(/Something went wrong on our side/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('INTERNAL_ERROR');
  });

  it('never renders a message body, an address, a phone number or an email', async () => {
    // even if a later API version added such fields, the page has no place that shows them
    const leaky = overview();
    const m = { ...leaky.messages[0]!, body: 'Hi Pat, the comps are attached', toAddress: '+14155550100', fromAddress: 'agent@harbor.test', contactName: 'Pat Lead' };
    leadAdminApp(systemFake({ ...leaky, messages: [m] }), '/admin/system', 'owner');
    await screen.findByText('Open conversation');
    const text = document.body.textContent ?? '';
    for (const s of ['comps are attached', '4155550100', '(415) 555-0100', 'agent@harbor.test', 'Pat Lead']) expect(text).not.toContain(s);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });

  it('has no axe violations (with the confirmation open, too)', async () => {
    leadAdminApp(systemFake(), '/admin/system', 'owner');
    await screen.findByRole('button', { name: 'Retry: Send a message' });
    expect(await violations()).toEqual([]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel job: Lead offer timer' }));
    expect(await violations()).toEqual([]);
  });
});
