// R-STG-4: "What happens next" on the contact: the agent's next task, the automated playbook and AI follow-up are
// three separate rows that always render. The playbook row says only what GET /contacts/:id/playbook-status says:
// the plan and its state, its next real step or why it is not moving, a delivery nobody could confirm (never as
// sent), and Pause / Resume / Stop exactly when the server's can* flag is true. jsdom against a scripted API.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../shell/index.js';
import { ShellProvider } from '../../shell/context.js';
import { FakeFetch, err, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { panel } from '../aiCare/testing.js';
import { IDS, fullContact, iso, reachability, stopReason } from '../feed/lib/testing.js';
import type { TaskView } from '../feed/lib/types.js';
import { NextPanel, PersonChips } from './NextPanel.js';
import { ToastProvider } from './hooks.js';
import { type PlaybookStatus, originLine, playbookStatusKey, statusPollMs } from './stageFlow.js';
import { guideFixture } from './testing.js';

const C = IDS.jane;
const E = '01900000-0000-7000-8000-0000000e0001';
const EV = '01900000-0000-7000-8000-0000000e0002';
const OTHER = '01900000-0000-7000-8000-0000000000bb';

type Plan = NonNullable<PlaybookStatus['plan']>;
const plan = (over: Partial<Plan> = {}): Plan => ({
  enrollmentId: E,
  name: 'Buyer follow-up',
  state: 'active',
  startedBy: { how: 'stage_change', userId: IDS.me, displayName: 'Ava Agent' },
  startedAt: iso(-60_000),
  next: { kind: 'message', channel: 'sms', dueAt: tomorrowAt9().toISOString() },
  blocked: null,
  deliveryUnconfirmed: null,
  canPause: true,
  canResume: false,
  canStop: true,
  ...over,
});
function tomorrowAt9(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}
const change = (over: Partial<NonNullable<PlaybookStatus['lastStageChange']>> = {}): NonNullable<PlaybookStatus['lastStageChange']> => ({ eventId: EV, to: 'active', at: iso(-60_000), pending: false, decision: { outcome: 'started', plan: 'Buyer follow-up', reason: null, sentence: 'Buyer follow-up started.' }, ...over });
const task = (id: string, title: string, dueAt: string | null): TaskView => ({ id, kind: 'follow_up', title, notes: null, dueAt, dueAllDay: false, dueTz: null, status: 'open', completedAt: null, assigneeUserId: IDS.me, contact: { id: C, name: 'Jane Doe' }, dealId: null, listingId: null, createdByKind: 'user', needsReview: false, source: null, createdAt: iso(-1000) });

function mount(o: { status?: PlaybookStatus; tasks?: TaskView[]; ai?: ReturnType<typeof panel> | null; role?: 'agent' | 'tc'; extra?: (f: FakeFetch) => FakeFetch } = {}) {
  const s = sessionFixture();
  const tenant = { ...s.tenant!, role: o.role ?? ('agent' as const) };
  const fake = new FakeFetch()
    .on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } })
    .on(`GET /contacts/${C}/playbook-status`, { status: 200, body: o.status ?? { plan: null, lastStageChange: null } })
    .on(`GET /tasks?contactId=${C}&scope=visible&status=open`, { status: 200, body: { tasks: o.tasks ?? [] } })
    .on(`GET /contacts/${C}/ai-isa`, o.ai === null ? err(404, 'NOT_FOUND') : { status: 200, body: o.ai ?? panel({ state: 'none' }) })
    .on('GET /stage-labels', { status: 200, body: { labels: {}, stages: guideFixture() } });
  o.extra?.(fake);
  const on = { task: vi.fn(), appointment: vi.fn() };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ShellProvider api={new ApiClient({ fetch: fake.fetch })} table={tableWith()}>
        <MemoryRouter>
          <ToastProvider>
            <NextPanel contact={fullContact()} onAddTask={on.task} onAddAppointment={on.appointment} />
          </ToastProvider>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>,
  );
  return { fake, on, u: userEvent.setup(), qc };
}
const row = (name: string) => within(screen.getByRole('region', { name: 'What happens next' })).getByRole('group', { name });

describe('R-STG-4 the "What happens next" panel', () => {
  it('three rows always render, each saying plainly when there is nothing: no task, no plan running, AI follow-up not on', async () => {
    mount();
    expect(screen.getByRole('heading', { level: 2, name: 'What happens next' })).toBeInTheDocument();
    expect(await within(row('Your next task')).findByText('No open task.')).toBeInTheDocument();
    expect(await within(row('Automated playbook')).findByText('None running')).toBeInTheDocument();
    expect(await within(row('AI follow-up')).findByText('Not on for this person.')).toBeInTheDocument();
    expect(within(row('Automated playbook')).queryByRole('button')).toBeNull();
  });

  it('your next task is the earliest open task with its due time; Add follow-up and Add appointment are here', async () => {
    const soon = tomorrowAt9();
    const later = new Date(soon.getTime() + 3 * 86_400_000);
    const { on, u } = mount({ tasks: [task('01900000-0000-7000-8000-00000000a002', 'Send comps', later.toISOString()), task('01900000-0000-7000-8000-00000000a003', 'No date yet', null), task('01900000-0000-7000-8000-00000000a001', 'Call Jane back', soon.toISOString())] });
    const r = row('Your next task');
    expect(await within(r).findByText('Call Jane back')).toBeInTheDocument();
    // the task itself is opened from the page's Tasks section (one link per task on the page, not two)
    expect(within(r).queryByRole('link', { name: 'Call Jane back' })).toBeNull();
    expect(within(r).getByRole('link', { name: 'See open tasks' })).toHaveAttribute('href', '/#tasks');
    expect(r).toHaveTextContent(new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(soon));
    expect(r).toHaveTextContent('2 more open');
    expect(within(r).queryByText('Send comps')).toBeNull();
    await u.click(within(r).getByRole('button', { name: 'Add follow-up' }));
    await u.click(within(r).getByRole('button', { name: 'Add appointment' }));
    expect(on.task).toHaveBeenCalledTimes(1);
    expect(on.appointment).toHaveBeenCalledTimes(1);
  });

  it('a running plan: its name, Running, its next real step, and where it came from; Pause and Stop only because the server allows them', async () => {
    mount({ status: { plan: plan(), lastStageChange: change() } });
    const r = row('Automated playbook');
    expect(await within(r).findByText('Buyer follow-up')).toBeInTheDocument();
    expect(within(r).getByText('Running')).toBeInTheDocument();
    expect(within(r).getByText('Next: text, tomorrow 9:00 AM')).toBeInTheDocument();
    expect(within(r).getByText('Started when you moved them to Active client')).toBeInTheDocument();
    expect(within(r).getByRole('button', { name: 'Pause Buyer follow-up' })).toBeInTheDocument();
    expect(within(r).getByRole('button', { name: 'Stop Buyer follow-up' })).toBeInTheDocument();
    expect(within(r).queryByRole('button', { name: /Resume/ })).toBeNull();
  });

  it('Pause calls the pause route and the row then says what the server says: Paused, why, and Resume when allowed; Resume and Stop work the same way', async () => {
    const paused = plan({ state: 'paused', next: null, blocked: { code: 'manual', sentence: 'Paused by hand. Resume it when you are ready.' }, canPause: false, canResume: true });
    const stopped = plan({ state: 'stopped', next: null, blocked: { code: 'manual', sentence: 'Stopped by hand.' }, canPause: false, canResume: false, canStop: false });
    const { fake, u } = mount({ status: { plan: plan(), lastStageChange: change() } });
    const r = row('Automated playbook');
    fake.on(`POST /enrollments/${E}/pause`, () => {
      fake.on(`GET /contacts/${C}/playbook-status`, { status: 200, body: { plan: paused, lastStageChange: change() } });
      return { status: 200, body: { enrollment: { id: E, state: 'paused' } } };
    });
    await u.click(await within(r).findByRole('button', { name: 'Pause Buyer follow-up' }));
    expect(await within(r).findByText('Paused')).toBeInTheDocument();
    expect(within(r).getByText('Paused by hand. Resume it when you are ready.')).toBeInTheDocument();
    expect(within(r).queryByText(/^Next:/)).toBeNull();
    expect(within(r).queryByRole('button', { name: /Pause/ })).toBeNull();

    fake.on(`POST /enrollments/${E}/resume`, () => {
      fake.on(`GET /contacts/${C}/playbook-status`, { status: 200, body: { plan: plan(), lastStageChange: change() } });
      return { status: 200, body: { enrollment: { id: E, state: 'active' } } };
    });
    await u.click(within(r).getByRole('button', { name: 'Resume Buyer follow-up' }));
    expect(await within(r).findByText('Running')).toBeInTheDocument();

    fake.on(`POST /enrollments/${E}/stop`, () => {
      fake.on(`GET /contacts/${C}/playbook-status`, { status: 200, body: { plan: stopped, lastStageChange: change() } });
      return { status: 200, body: { enrollment: { id: E, state: 'stopped' } } };
    });
    await u.click(within(r).getByRole('button', { name: 'Stop Buyer follow-up' }));
    expect(await within(r).findByText('Stopped')).toBeInTheDocument();
    expect(within(r).getByText('Stopped by hand.')).toBeInTheDocument();
    expect(within(r).queryByRole('button')).toBeNull();
    expect(fake.callsTo(`POST /enrollments/${E}/pause`)).toHaveLength(1);
    expect(fake.callsTo(`POST /enrollments/${E}/resume`)).toHaveLength(1);
    expect(fake.callsTo(`POST /enrollments/${E}/stop`)).toHaveLength(1);
  });

  it('a refused Pause shows the server\'s reason; the row keeps saying Running, never Paused', async () => {
    const { u } = mount({ status: { plan: plan(), lastStageChange: change() }, extra: (f) => f.on(`POST /enrollments/${E}/pause`, err(409, 'ENROLLMENT_NOT_LIVE')) });
    const r = row('Automated playbook');
    await u.click(await within(r).findByRole('button', { name: 'Pause Buyer follow-up' }));
    expect(await within(r).findByRole('alert')).toHaveTextContent('This plan has already ended, so there is nothing to pause or resume.');
    expect(within(r).getByText('Running')).toBeInTheDocument();
    expect(within(r).queryByText('Paused')).toBeNull();
  });

  it('L9 (E785): when the status cannot be read again, the row does not keep saying "Running" with its buttons beside the error: it says it could not check, shows nothing that may be out of date, and offers to try again', async () => {
    const { fake, u, qc } = mount({ status: { plan: plan(), lastStageChange: change() } });
    const r = row('Automated playbook');
    expect(await within(r).findByText('Running')).toBeInTheDocument();
    expect(within(r).getByRole('button', { name: 'Stop Buyer follow-up' })).toBeInTheDocument();
    // the next read fails (the plan may have been stopped by a teammate meanwhile: nobody can say)
    fake.on(`GET /contacts/${C}/playbook-status`, err(500, 'INTERNAL_ERROR'));
    await qc.invalidateQueries({ queryKey: playbookStatusKey(C) });
    expect(await within(r).findByRole('alert')).toHaveTextContent('We couldn’t check this plan just now, so nothing is shown that may be out of date.');
    expect(within(r).queryByText('Running')).toBeNull();
    expect(within(r).queryByText('Buyer follow-up')).toBeNull();
    expect(within(r).queryByText(/^Next:/)).toBeNull();
    expect(within(r).queryByText(/^Started when/)).toBeNull();
    expect(within(r).queryByText('None running')).toBeNull();
    expect(within(r).queryByRole('button', { name: /^(Pause|Resume|Stop) / })).toBeNull();
    // one way forward: ask again; the row then says what the server says now
    fake.on(`GET /contacts/${C}/playbook-status`, { status: 200, body: { plan: plan({ state: 'stopped', next: null, blocked: { code: 'manual', sentence: 'Stopped by hand.' }, canPause: false, canStop: false }), lastStageChange: change() } });
    await u.click(within(r).getByRole('button', { name: 'Try again' }));
    expect(await within(r).findByText('Stopped')).toBeInTheDocument();
    expect(within(r).queryByRole('alert')).toBeNull();
  });

  it('L9 (E785): a first read that fails says the same and claims nothing, not even "None running"', async () => {
    mount({ extra: (f) => f.on(`GET /contacts/${C}/playbook-status`, err(500, 'INTERNAL_ERROR')) });
    const r = row('Automated playbook');
    expect(await within(r).findByRole('alert')).toHaveTextContent('We couldn’t check this plan just now');
    expect(within(r).queryByText('None running')).toBeNull();
    expect(within(r).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('no control is shown to a viewer the server would refuse (every can* flag false)', async () => {
    mount({ status: { plan: plan({ canPause: false, canResume: false, canStop: false }), lastStageChange: change() } });
    const r = row('Automated playbook');
    expect(await within(r).findByText('Running')).toBeInTheDocument();
    expect(within(r).queryByRole('button')).toBeNull();
  });

  it('a finished plan says Finished; a plan with no step due says so instead of inventing a time', async () => {
    mount({ status: { plan: plan({ state: 'completed', next: null, canPause: false, canStop: false }), lastStageChange: null } });
    expect(await within(row('Automated playbook')).findByText('Finished')).toBeInTheDocument();
    expect(within(row('Automated playbook')).queryByText(/^Next:/)).toBeNull();
  });

  it('a delivery that could not be confirmed is its own line, in the server\'s words, and is never called sent', async () => {
    const sentence = "Delivery of the plan's last text could not be confirmed yet: it may have reached them. We're still checking, and the plan does not submit it a second time. Check with them before sending it again yourself.";
    mount({ status: { plan: plan({ deliveryUnconfirmed: { channel: 'sms', at: iso(-120_000), checking: true, sentence } }), lastStageChange: change() } });
    const r = row('Automated playbook');
    const line = await within(r).findByTestId('delivery-unconfirmed');
    expect(line).toHaveTextContent(sentence);
    expect(r.textContent).not.toMatch(/\bsent\b|\bdelivered\b/i);
  });

  it('a plan that did not start: "None running", and the server\'s sentence says why (an opt-out)', async () => {
    const sentence = 'Buyer follow-up did not start: they opted out, are marked do not contact, or have no phone or email this plan could use.';
    mount({ status: { plan: null, lastStageChange: change({ decision: { outcome: 'skipped', plan: 'Buyer follow-up', reason: 'cannot_be_reached', sentence } }) } });
    const r = row('Automated playbook');
    expect(await within(r).findByText('None running')).toBeInTheDocument();
    expect(within(r).getByText(sentence)).toBeInTheDocument();
    expect(r.textContent).not.toMatch(/\bstarted\b/i);
  });

  it('a stage change still being decided says "Checking…", never started and never that nothing happened; it is asked again every 15 s only while pending', async () => {
    mount({ status: { plan: null, lastStageChange: change({ pending: true, decision: null }) } });
    const r = row('Automated playbook');
    expect(await within(r).findByText('Checking…')).toBeInTheDocument();
    expect(r.textContent).not.toMatch(/\bstarted\b|None running/i);
    expect(statusPollMs({ plan: null, lastStageChange: change({ pending: true, decision: null }) })).toBe(15_000);
    expect(statusPollMs({ plan: plan(), lastStageChange: change() })).toBe(false);
    expect(statusPollMs({ plan: null, lastStageChange: null })).toBe(false);
    expect(statusPollMs(undefined)).toBe(false);
  });

  it('where a plan came from, in words: your stage change, a teammate\'s, by hand, a new lead', () => {
    const labelOf = (k: string) => guideFixture().find((s) => s.key === k)!.label;
    const me = IDS.me;
    expect(originLine({ plan: plan(), lastStageChange: change() }, labelOf, me)).toBe('Started when you moved them to Active client');
    expect(originLine({ plan: plan({ startedBy: { how: 'stage_change', userId: OTHER, displayName: 'Sam Lee' } }), lastStageChange: change() }, labelOf, me)).toBe('Started when Sam Lee moved them to Active client');
    expect(originLine({ plan: plan({ startedBy: { how: 'user', userId: OTHER, displayName: 'Sam Lee' } }), lastStageChange: null }, labelOf, me)).toBe('Started by Sam Lee');
    expect(originLine({ plan: plan({ startedBy: { how: 'new_lead', userId: null, displayName: null } }), lastStageChange: null }, labelOf, me)).toBe('Started when they came in as a new lead');
    // the last stage change named a plan that did not start, while an older plan is still shown: the server's sentence
    expect(originLine({ plan: plan({ name: 'Older plan', startedBy: { how: 'user', userId: me, displayName: 'Ava Agent' } }), lastStageChange: change({ decision: { outcome: 'skipped', plan: 'Buyer follow-up', reason: 'already_in_a_plan', sentence: 'Buyer follow-up did not start: they are already in a plan, and a person is in one plan at a time.' } }) }, labelOf, me)).toBe(
      'Buyer follow-up did not start: they are already in a plan, and a person is in one plan at a time.',
    );
    expect(originLine({ plan: null, lastStageChange: change({ pending: true, decision: null }) }, labelOf, me)).toBe('Checking…');
    expect(originLine({ plan: null, lastStageChange: change({ decision: null }) }, labelOf, me)).toBeNull();
  });

  it('AI follow-up is one honest line from the AI care data, linking to the AI care section only when that section is on the page', async () => {
    mount({ ai: panel({ state: 'live' }) });
    const r = row('AI follow-up');
    expect(await within(r).findByText('On: the AI assistant is handling this conversation.')).toBeInTheDocument();
    expect(within(r).getByRole('link', { name: 'Open AI care' })).toHaveAttribute('href', '/#ai-care');
  });

  it('AI follow-up paused says nobody is following up automatically', async () => {
    mount({ ai: panel({ state: 'paused' }) });
    expect(await within(row('AI follow-up')).findByText(/^Paused: nobody is following up automatically\./)).toBeInTheDocument();
  });

  it('AI follow-up not on, with no AI care section to open, has no link', async () => {
    mount({ ai: null });
    expect(await within(row('AI follow-up')).findByText('Not on for this person.')).toBeInTheDocument();
    expect(within(row('AI follow-up')).queryByRole('link')).toBeNull();
  });

  it('a role that never sees AI care is told so, and nothing about it is requested', async () => {
    const tc = mount({ role: 'tc' });
    expect(await within(row('AI follow-up')).findByText('Not shown for your role.')).toBeInTheDocument();
    await waitFor(() => expect(tc.fake.callsTo(`GET /contacts/${C}/playbook-status`)).toHaveLength(1));
    expect(tc.fake.callsTo(`GET /contacts/${C}/ai-isa`)).toHaveLength(0);
  });
});

describe('R-STG-1 buyer or seller and texting permission are their own chips, never part of the stage', () => {
  function chips(reach = reachability(C), contact = fullContact()) {
    const fake = new FakeFetch().on('GET /auth/session', { status: 200, body: sessionFixture() }).on(`GET /contacts/${C}/reachability`, { status: 200, body: { reachability: reach } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ShellProvider api={new ApiClient({ fetch: fake.fetch })} table={tableWith()}>
          <MemoryRouter>
            <PersonChips contact={contact} />
          </MemoryRouter>
        </ShellProvider>
      </QueryClientProvider>,
    );
  }

  it('a buyer who can be texted: two chips', async () => {
    chips();
    const list = screen.getByRole('list', { name: 'About Jane Doe' });
    expect(within(list).getByText('Buyer')).toBeInTheDocument();
    expect(await within(list).findByText('Texting OK')).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('a person who texted STOP: the texting chip says so with the reason; no intent says "not set"', async () => {
    chips(reachability(C, { sms: [stopReason()] }), fullContact({ intent: null }));
    const list = screen.getByRole('list', { name: 'About Jane Doe' });
    expect(await within(list).findByText(/^No texting: Texted STOP on /)).toBeInTheDocument();
    expect(within(list).getByText('Buyer or seller: not set')).toBeInTheDocument();
  });

  it('a person with no phone: the chip says there is nothing to text', async () => {
    chips(reachability(C), fullContact({ phones: [] }));
    expect(await within(screen.getByRole('list', { name: 'About Jane Doe' })).findByText('No phone to text')).toBeInTheDocument();
  });
});
