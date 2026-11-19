// R-STG-3: before a stage change is saved the screen says what it will do, from GET /contacts/:id/stage/preview:
// the plan it will start and its first step, or the plan it will not start and why, the plan that keeps running
// (a stage change never stops one) with Stop only when the server says this viewer may stop it, and that AI follow-up
// and the agent's own tasks are left alone. jsdom against a scripted API.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../shell/index.js';
import { ShellProvider } from '../../shell/context.js';
import { FakeFetch, err, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { reachability } from '../feed/lib/testing.js';
import { StagePill } from './StagePill.js';
import { NeverNote, StagePreviewBlock } from './StagePreview.js';
import { ToastProvider } from './hooks.js';
import { type StagePreview, effectLabel, effectLine, whenWords, willStartText } from './stageFlow.js';
import { detailsFixture, guideFixture, stageFixture } from './testing.js';

const C = '01900000-0000-7000-8000-0000000c0001';
const E = '01900000-0000-7000-8000-0000000e0001';

export function preview(over: Partial<StagePreview> = {}): StagePreview {
  return { allowed: true, lockedReason: null, sameStage: false, starts: null, wontStart: null, keepsRunning: null, stops: [], aiCare: 'unchanged', tasks: 'unchanged', ...over };
}
const at = (daysAhead: number, h: number, m = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(h, m, 0, 0);
  return d;
};
const STOP_SENTENCE = 'Buyer plan will not start: they opted out, are marked do not contact, or have no phone or email this plan could use.';

function wrap(fake: FakeFetch, ui: React.ReactElement) {
  fake.on('GET /auth/session', { status: 200, body: sessionFixture() });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ShellProvider api={new ApiClient({ fetch: fake.fetch })} table={tableWith()}>
        <MemoryRouter>
          <ToastProvider>{ui}</ToastProvider>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

describe('R-STG-3 words', () => {
  it('when a step is due reads short and local: now, today, tomorrow, a weekday within the week, then the date', () => {
    const now = at(0, 8).getTime();
    const time = (d: Date) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(d);
    expect(whenWords(new Date(now - 5_000).toISOString(), now)).toBe('now');
    expect(whenWords(at(0, 9).toISOString(), now)).toBe(`today ${time(at(0, 9))}`);
    expect(whenWords(at(1, 9).toISOString(), now)).toBe(`tomorrow ${time(at(1, 9))}`);
    expect(whenWords(at(3, 9).toISOString(), now)).toBe(`${new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(at(3, 9))} ${time(at(3, 9))}`);
    expect(whenWords(at(10, 9).toISOString(), now)).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, 9:00 AM$/);
  });

  it('"Will start" names the plan and its first step; a plan with no step due says so; the row line never says started', () => {
    const now = at(0, 8).getTime();
    expect(willStartText({ plan: 'Buyer plan', firstStep: { channel: 'sms', dueAt: at(1, 9).toISOString() } }, now)).toBe('Will start: Buyer plan, first step text tomorrow 9:00 AM');
    expect(willStartText({ plan: 'Buyer plan', firstStep: { channel: 'email', dueAt: at(0, 7).toISOString() } }, now)).toBe('Will start: Buyer plan, first step email now');
    expect(willStartText({ plan: 'Buyer plan', firstStep: null }, now)).toBe('Will start: Buyer plan. No message is due from it yet.');
    expect(effectLine(preview({ wontStart: { plan: 'Buyer plan', reason: 'cannot_be_reached', sentence: STOP_SENTENCE, alreadyIn: null } }), now)).toBe(STOP_SENTENCE);
    expect(effectLine(preview(), now)).toBe('No plan starts on this stage.');
    expect(effectLine(preview({ sameStage: true }), now)).toBe('They are in this stage now. Nothing starts.');
    for (const p of [preview(), preview({ starts: { plan: 'P', firstStep: null } }), preview({ sameStage: true })]) expect(effectLine(p, now)).not.toMatch(/\bstarted\b/i);
  });

  it('L7 (E781): a stage the rule refuses says it is locked, before anything about a plan: never "No plan starts on this stage."', () => {
    const locked = preview({ allowed: false, lockedReason: 'STAGE_NEEDS_CONTACT' });
    expect(effectLine(locked)).toBe('Locked for now: reach them first.');
    // even when the answer also carried plan fields, the lock is what is true of the tap
    expect(effectLine({ ...locked, wontStart: { plan: 'Buyer plan', reason: 'cannot_be_reached', sentence: STOP_SENTENCE, alreadyIn: null } })).toBe('Locked for now: reach them first.');
    expect(effectLine(locked)).not.toMatch(/No plan starts/);
  });

  it('the primary button is named for its effect', () => {
    const labelOf = (k: string) => guideFixture().find((s) => s.key === k)!.label;
    expect(effectLabel('connected', 'attempting', labelOf)).toBe('Change to Connected');
    expect(effectLabel('attempting', 'attempting', labelOf)).toBe('Keep Trying to reach');
  });
});

describe('R-STG-3 the preview block', () => {
  const block = (p: StagePreview | 'error', extra: (f: FakeFetch) => FakeFetch = (f) => f) => {
    const fake = extra(new FakeFetch().on(`GET /contacts/${C}/stage/preview?to=active`, p === 'error' ? err(500, 'INTERNAL_ERROR') : { status: 200, body: p }));
    const u = wrap(fake, <StagePreviewBlock contactId={C} to="active" />);
    return { fake, u };
  };

  it('a plan that will start: its name and first step, AI follow-up and tasks unchanged, and that a stage change stops nothing', async () => {
    const fake = new FakeFetch().on(`GET /contacts/${C}/stage/preview?to=active`, { status: 200, body: preview({ starts: { plan: 'Buyer plan', firstStep: { channel: 'sms', dueAt: at(1, 9).toISOString() } } }) });
    wrap(
      fake,
      <>
        <StagePreviewBlock contactId={C} to="active" />
        <NeverNote />
      </>,
    );
    // M4: the effect is ONE line (the sheet's button is described by it); what no stage change does is the footnote
    expect(await screen.findByText('Will start: Buyer plan, first step text tomorrow 9:00 AM')).toBeInTheDocument();
    expect(screen.getByTestId('stage-step-effect')).toHaveTextContent(/^Will start: Buyer plan, first step text tomorrow 9:00 AM$/);
    expect(screen.getAllByText(/Will start/)).toHaveLength(1);
    const note = within(screen.getByTestId('stage-never-note'));
    expect(note.getByText('AI follow-up: unchanged')).toBeInTheDocument();
    expect(note.getByText('Your tasks: unchanged')).toBeInTheDocument();
    expect(note.getByText('Changing the stage does not stop a running plan.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull();
  });

  it('a plan that will not start says the server\'s sentence, and never "Will start"', async () => {
    block(preview({ wontStart: { plan: 'Buyer plan', reason: 'cannot_be_reached', sentence: STOP_SENTENCE, alreadyIn: null } }));
    expect(await screen.findByText(STOP_SENTENCE)).toBeInTheDocument();
    expect(screen.queryByText(/Will start/)).toBeNull();
  });

  it('a stage no plan names says so', async () => {
    block(preview());
    expect(await screen.findByText('No plan starts on this stage.')).toBeInTheDocument();
  });

  it('L7 (E781): the block of a locked stage says locked, and does not say "No plan starts on this stage."', async () => {
    wrap(new FakeFetch().on(`GET /contacts/${C}/stage/preview?to=connected`, { status: 200, body: preview({ allowed: false, lockedReason: 'STAGE_NEEDS_CONTACT' }) }), <StagePreviewBlock contactId={C} to="connected" />);
    const block = within(await screen.findByTestId('stage-preview'));
    expect(await block.findByText('Locked for now: reach them first.')).toBeInTheDocument();
    expect(block.queryByText('No plan starts on this stage.')).toBeNull();
  });

  it('a running plan keeps running; Stop is offered only when the server says this viewer may stop it, and calls the stop route', async () => {
    const running = (canStop: boolean) => preview({ keepsRunning: { enrollmentId: E, plan: 'Seller plan', state: 'active', canStop } });
    const { fake, u } = block(running(true), (f) => f.on(`POST /enrollments/${E}/stop`, { status: 200, body: { enrollment: { id: E, state: 'stopped' } } }));
    expect(await screen.findByText('Keeps running: Seller plan')).toBeInTheDocument();
    // the plan is gone from the next preview once it is stopped
    fake.on(`GET /contacts/${C}/stage/preview?to=active`, { status: 200, body: preview() });
    await u.click(screen.getByRole('button', { name: 'Stop Seller plan' }));
    await waitFor(() => expect(fake.callsTo(`POST /enrollments/${E}/stop`)).toHaveLength(1));
    expect(await screen.findByText('Stopped Seller plan.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Keeps running: Seller plan')).toBeNull());
  });

  it('no Stop for a viewer the server would refuse; a paused plan stays paused', async () => {
    block(preview({ keepsRunning: { enrollmentId: E, plan: 'Seller plan', state: 'paused', canStop: false } }));
    expect(await screen.findByText('Stays paused: Seller plan')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull();
  });

  it('a refused Stop shows the server\'s reason and never says the plan stopped', async () => {
    const { u } = block(preview({ keepsRunning: { enrollmentId: E, plan: 'Seller plan', state: 'active', canStop: true } }), (f) => f.on(`POST /enrollments/${E}/stop`, err(404, 'NOT_FOUND')));
    await u.click(await screen.findByRole('button', { name: 'Stop Seller plan' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("This isn't available. It may have moved, or you may not have access to it.");
    expect(screen.queryByText(/Stopped Seller plan/)).toBeNull();
    expect(screen.getByText('Keeps running: Seller plan')).toBeInTheDocument();
  });

  it('while the answer is not in, and when it fails, the block says so and claims nothing', async () => {
    block('error');
    expect(await screen.findByText("We couldn't check what this change would start. The change is still checked when you save it.")).toBeInTheDocument();
    expect(screen.queryByText(/Will start|No plan starts/)).toBeNull();
  });
});

describe('R-STG-3 the stage pill: every stage says what it will do BEFORE the tap (the change stays 2 taps)', () => {
  function pill(d = detailsFixture(C, 'attempting'), previews: Record<string, StagePreview> = {}) {
    const fake = new FakeFetch().on(`GET /contacts/${C}/reachability`, { status: 200, body: { reachability: reachability(C) } });
    for (const s of guideFixture()) fake.on(`GET /contacts/${C}/stage/preview?to=${s.key}`, { status: 200, body: previews[s.key] ?? preview() });
    const u = wrap(fake, <StagePill contactId={C} name="Dana Reyes" details={d} onCall={vi.fn()} onText={vi.fn()} onReplyChat={vi.fn()} />);
    return { fake, u };
  }

  it('the row of a stage whose plan will start says so with its first step; a stage whose plan will not start says why; the others say nothing starts', async () => {
    const { u, fake } = pill(undefined, {
      active: preview({ starts: { plan: 'Buyer plan', firstStep: { channel: 'sms', dueAt: at(1, 9).toISOString() } } }),
      nurture: preview({ wontStart: { plan: 'Keep in touch', reason: 'plan_not_approved', sentence: 'Keep in touch will not start: it has no approved version yet, and only an approved plan runs.', alreadyIn: null } }),
    });
    await u.click(screen.getByRole('button', { name: 'Stage: Trying to reach. Change stage' }));
    const sheet = screen.getByRole('dialog');
    const active = await within(sheet).findByRole('button', { name: 'Active client' });
    await waitFor(() => expect(active).toHaveAccessibleDescription(/Will start: Buyer plan, first step text tomorrow 9:00 AM/));
    expect(within(sheet).getByRole('button', { name: 'Long-term follow-up' })).toHaveAccessibleDescription(/Keep in touch will not start: it has no approved version yet/);
    expect(within(sheet).getByRole('button', { name: 'Connected' })).toHaveAccessibleDescription(/No plan starts on this stage\./);
    // the person's own stage is not asked about: picking it changes nothing
    expect(fake.callsTo(`GET /contacts/${C}/stage/preview?to=attempting`)).toHaveLength(0);
    expect(within(sheet).getByText('Changing the stage does not stop a running plan.')).toBeInTheDocument();
    expect(within(sheet).getByText('AI follow-up: unchanged')).toBeInTheDocument();
    expect(within(sheet).getByText('Your tasks: unchanged')).toBeInTheDocument();
  });

  it('a stage cannot be picked before its preview is in (nobody saves a change they were not shown), and a locked stage is never asked about', async () => {
    let release: (() => void) | null = null;
    const d = detailsFixture(C, 'new', { stage: stageFixture('new', { locked: ['connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'], lockedReason: 'STAGE_NEEDS_CONTACT' }) });
    const fake = new FakeFetch()
      .on(`GET /contacts/${C}/reachability`, { status: 200, body: { reachability: reachability(C) } })
      .on(`GET /contacts/${C}/stage/preview?to=attempting`, () => new Promise((r) => (release = () => r({ status: 200, body: preview() }))));
    const u = wrap(fake, <StagePill contactId={C} name="Dana Reyes" details={d} onCall={vi.fn()} onText={vi.fn()} onReplyChat={vi.fn()} />);
    await u.click(screen.getByRole('button', { name: 'Stage: New lead. Change stage' }));
    const sheet = screen.getByRole('dialog');
    const trying = within(sheet).getByRole('button', { name: 'Trying to reach' });
    expect(trying).toBeDisabled();
    expect(trying).toHaveAccessibleDescription(/Checking what this will start/);
    await waitFor(() => expect(release).not.toBeNull());
    release!();
    await waitFor(() => expect(trying).toBeEnabled());
    for (const k of ['connected', 'nurture', 'active', 'under_contract', 'closed', 'lost']) expect(fake.callsTo(`GET /contacts/${C}/stage/preview?to=${k}`)).toHaveLength(0);
  });

  it('a preview that could not be read does not lock the picker: the row says so and the change is still the server\'s to decide', async () => {
    const fake = new FakeFetch().on(`GET /contacts/${C}/reachability`, { status: 200, body: { reachability: reachability(C) } });
    const u = wrap(fake, <StagePill contactId={C} name="Dana Reyes" details={detailsFixture(C, 'attempting')} onCall={vi.fn()} onText={vi.fn()} onReplyChat={vi.fn()} />);
    await u.click(screen.getByRole('button', { name: 'Stage: Trying to reach. Change stage' }));
    const connected = within(screen.getByRole('dialog')).getByRole('button', { name: 'Connected' });
    await waitFor(() => expect(connected).toBeEnabled());
    expect(connected).toHaveAccessibleDescription(/We couldn't check what this would start/);
  });

  it('a running plan is named once, above the stages, with Stop when the server allows it', async () => {
    const k = { enrollmentId: E, plan: 'Seller plan', state: 'active' as const, canStop: true };
    const all = Object.fromEntries(guideFixture().map((s) => [s.key, preview({ keepsRunning: k })]));
    const { u } = pill(undefined, all);
    await u.click(screen.getByRole('button', { name: 'Stage: Trying to reach. Change stage' }));
    const sheet = screen.getByRole('dialog');
    expect(await within(sheet).findByText('Keeps running: Seller plan')).toBeInTheDocument();
    expect(within(sheet).getAllByRole('button', { name: 'Stop Seller plan' })).toHaveLength(1);
  });
});
