// The working flow on the person's page (owner brief 2026-11-19): call or text, log what happened, confirm the
// suggested stage and see what happens next, in ONE sheet and without leaving the page. jsdom mounts the whole app on
// a scripted API; with no matchMedia it lays out as a phone, so the working bar (Call · Text · Log · Next · Note) is
// there. The real API, the tap sizes and the 320 px layout are covered by e2e/journeys/j10-stage-flow.spec.ts.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, allow, decision, fullContact, iso, reachability } from '../feed/lib/testing.js';
import { detailsFixture, guideFixture, stageFixture } from '../people-edit/testing.js';

const C = IDS.jane;
const EV = '01900000-0000-7000-8000-0000000e0002';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PREVIEW = { allowed: true, lockedReason: null, sameStage: false, starts: null, wontStart: null, keepsRunning: null, stops: [], aiCare: 'unchanged', tasks: 'unchanged' };
const VOICEMAIL = { stage: 'attempting', why: 'You left a voicemail. That is a try, not a conversation yet.', locked: false, alsoOffer: [] };

function page(stage = 'new') {
  const c = fullContact({ stage });
  const fake = new FakeFetch()
    .on(`GET /contacts/${C}`, { status: 200, body: { contact: c } })
    .on(`GET /contacts/${C}/details`, { status: 200, body: { details: detailsFixture(C, stage) } })
    .on(`GET /contacts/${C}/reachability`, { status: 200, body: { reachability: reachability(C) } })
    .on(`GET /contacts/${C}/timeline?limit=100`, { status: 200, body: { items: [], nextCursor: null } })
    .on(`GET /contacts/${C}/playbook-status`, { status: 200, body: { plan: null, lastStageChange: null } })
    .on(`GET /contacts/${C}/notes`, { status: 200, body: { notes: [], nextCursor: null, audience: 'everyone' } })
    .on('GET /stage-labels', { status: 200, body: { labels: {}, stages: guideFixture() } })
    .on('GET /assistant/inbox', { status: 200, body: { items: [] } })
    .on(`GET /tasks?contactId=${C}&scope=visible&status=open`, { status: 200, body: { tasks: [] } })
    .on(`GET /deals?contactId=${C}`, { status: 200, body: { deals: [] } })
    .on(`GET /contacts/${C}/saved-searches`, { status: 200, body: { searches: [] } })
    .on(`POST /contacts/${C}/calls`, { status: 200, body: { result: 'dialing', callId: IDS.call, bridgeToken: null, reason: null, decision: allow } })
    .on(`POST /contacts/${C}/messages/preview`, { status: 200, body: { decision: decision({ id: null, phase: 'preview' }), body: '' } })
    .on(`POST /contacts/${C}/stage`, (call) => ({ status: 200, body: { stage: stageFixture((call.body as { stage: string }).stage), previousStage: stage, rowVersion: 2, eventId: EV, automation: null, stillRunning: null } }));
  for (const s of guideFixture()) fake.on(`GET /contacts/${C}/stage/preview?to=${s.key}`, { status: 200, body: { ...PREVIEW, sameStage: s.key === stage } });
  return fake;
}
const bar = () => screen.findByTestId('person-phone-bar');
const step = () => screen.findByRole('dialog', { name: 'Stage for Jane Doe' });

describe('one sheet, no navigation: call → outcome → confirm the stage', () => {
  it('Call → Left voicemail → "Change to Trying to reach" is 3 taps: the outcome is saved by its own tap, the same sheet then suggests the stage, and the page never changes', async () => {
    const fake = page().on(`POST /calls/${IDS.call}/outcome`, { status: 200, body: { callId: IDS.call, outcome: 'left_voicemail', recordedAs: 'call', suggestedStage: VOICEMAIL } });
    const { router } = agentApp(fake, `/contacts/${C}`);
    const u = userEvent.setup();
    let taps = 0;
    await u.click(await within(await bar()).findByRole('button', { name: 'Call Jane Doe' }));
    taps += 1;
    await u.click(await within(await screen.findByRole('dialog', { name: 'Call Jane Doe' })).findByRole('button', { name: 'Left voicemail' }));
    taps += 1;
    // saved as today (the toast says so), and nothing about the stage has been sent
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('Call outcome saved.'));
    const s = await step();
    expect(within(s).getByRole('status')).toHaveTextContent('Voicemail logged');
    expect(await within(s).findByRole('radio', { name: 'Trying to reach Suggested' })).toBeChecked();
    expect(within(s).getByRole('radio', { name: 'Keep New lead' })).toBeInTheDocument();
    expect(await within(s).findByText('No plan starts on this stage.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /contacts/${C}/stage`)).toHaveLength(0);
    const confirm = within(s).getByRole('button', { name: 'Change to Trying to reach' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await u.click(confirm);
    taps += 1;
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(taps).toBe(3);
    expect(fake.callsTo(`POST /calls/${IDS.call}/outcome`)).toHaveLength(1);
    expect(fake.callsTo(`POST /contacts/${C}/stage`).map((c) => c.body)).toEqual([{ stage: 'attempting' }]);
    expect(await within(screen.getByTestId('people-toast')).findByText('Stage: Trying to reach')).toBeInTheDocument();
    expect(screen.getAllByTestId('people-toast')).toHaveLength(1);
    expect(router.state.location.pathname).toBe(`/contacts/${C}`);
  });

  it('an outcome that suggests nothing still shows what was saved and lets the agent keep the stage and set a follow-up', async () => {
    const fake = page('connected').on(`POST /calls/${IDS.call}/outcome`, { status: 200, body: { callId: IDS.call, outcome: 'wrong_number', recordedAs: 'call', suggestedStage: null } });
    agentApp(fake, `/contacts/${C}`);
    const u = userEvent.setup();
    await u.click(await within(await bar()).findByRole('button', { name: 'Call Jane Doe' }));
    await u.click(await within(await screen.findByRole('dialog', { name: 'Call Jane Doe' })).findByRole('button', { name: 'Wrong number' }));
    const s = await step();
    expect(within(s).getByRole('status')).toHaveTextContent('Wrong number logged');
    const group = await within(s).findByRole('radiogroup', { name: 'Stage' });
    expect(within(group).getAllByRole('radio').map((r) => r.getAttribute('aria-checked'))).toEqual(['true']);
    expect(within(s).getByRole('button', { name: 'Keep Connected' })).toBeInTheDocument();
    // "Not moving forward" is never pushed for a wrong number: it is not an opt-out
    expect(within(group).queryByText('Not moving forward')).toBeNull();
  });

  it('an outcome saved as a task for the new owner (the lead moved during the call) has no stage step: the sheet closes as before', async () => {
    const fake = page().on(`POST /calls/${IDS.call}/outcome`, { status: 200, body: { callId: IDS.call, outcome: 'no_answer', recordedAs: 'task_for_current_owner', suggestedStage: null } });
    agentApp(fake, `/contacts/${C}`);
    const u = userEvent.setup();
    await u.click(await within(await bar()).findByRole('button', { name: 'Call Jane Doe' }));
    await u.click(await within(await screen.findByRole('dialog', { name: 'Call Jane Doe' })).findByRole('button', { name: 'No answer' }));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('Jane was reassigned during the call, so your outcome was saved as a task for the new owner.'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('off the person\'s page (the thread) the call sheet closes after the outcome exactly as before: 1 tap, no stage step', async () => {
    const fake = page().on(`POST /calls/${IDS.call}/outcome`, { status: 200, body: { callId: IDS.call, outcome: 'left_voicemail', recordedAs: 'call', suggestedStage: VOICEMAIL } });
    agentApp(fake, `/contacts/${C}/thread`);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Call' }));
    await u.click(await within(await screen.findByRole('dialog', { name: 'Call Jane Doe' })).findByRole('button', { name: 'Left voicemail' }));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('Call outcome saved.'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake.calls.filter((c) => c.path.includes('/stage/preview'))).toHaveLength(0);
  });
});

describe('after the confirm the page shows the truth from the server, not what the sheet hoped', () => {
  it('the "What happens next" panel is asked again after the stage change and says what the server says: the plan that started, running, with its next step', async () => {
    const fake = page('attempting').on(`POST /calls/${IDS.call}/outcome`, { status: 200, body: { callId: IDS.call, outcome: 'connected', recordedAs: 'call', suggestedStage: { stage: 'connected', why: 'You talked with them. That is a two-way conversation.', locked: false, alsoOffer: [{ stage: 'nurture', locked: false }] } } });
    const next = new Date(Date.now() + 86_400_000);
    next.setHours(9, 0, 0, 0);
    const running = {
      plan: { enrollmentId: '01900000-0000-7000-8000-0000000e0001', name: 'Stay in touch', state: 'active', startedBy: { how: 'stage_change', userId: IDS.me, displayName: 'Ava Agent' }, startedAt: iso(0), next: { kind: 'message', channel: 'sms', dueAt: next.toISOString() }, blocked: null, deliveryUnconfirmed: null, canPause: true, canResume: false, canStop: true },
      lastStageChange: { eventId: EV, to: 'connected', at: iso(0), pending: false, decision: { outcome: 'started', plan: 'Stay in touch', reason: null, sentence: 'Stay in touch started.' } },
    };
    fake.on(`POST /contacts/${C}/stage`, () => {
      // from here on the server knows the plan started
      fake.on(`GET /contacts/${C}/playbook-status`, { status: 200, body: running });
      return { status: 200, body: { stage: stageFixture('connected'), previousStage: 'attempting', rowVersion: 2, eventId: EV, automation: { started: 'Stay in touch' }, stillRunning: null } };
    });
    agentApp(fake, `/contacts/${C}`);
    const u = userEvent.setup();
    const panel = await screen.findByRole('region', { name: 'What happens next' });
    expect(await within(panel).findByText('None running')).toBeInTheDocument();
    await u.click(await within(await bar()).findByRole('button', { name: 'Call Jane Doe' }));
    await u.click(await within(await screen.findByRole('dialog', { name: 'Call Jane Doe' })).findByRole('button', { name: 'Talked' }));
    const s = await step();
    const confirm = await within(s).findByRole('button', { name: 'Change to Connected' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await u.click(confirm);
    expect(await within(screen.getByTestId('people-toast')).findByText('Stage: Connected. Started Stay in touch')).toBeInTheDocument();
    expect(await within(panel).findByText('Stay in touch')).toBeInTheDocument();
    expect(within(panel).getByText('Running')).toBeInTheDocument();
    expect(within(panel).getByText('Next: text, tomorrow 9:00 AM')).toBeInTheDocument();
    expect(within(panel).getByText('Started when you moved them to Connected')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Stop Stay in touch' })).toBeInTheDocument();
  });
});

describe('one sheet, no navigation: log → stage step', () => {
  const activity = (over: Record<string, unknown> = {}) => ({ status: 201, body: { note: { id: 'n1' }, taskId: null, suggestDoNotContact: false, suggestedStage: VOICEMAIL, replayed: false, ...over } });

  it('Log → Left voicemail → Save stays 3 taps to a saved note; the same sheet then shows the stage step with the server\'s suggestion', async () => {
    const fake = page().on(`POST /contacts/${C}/activities`, activity());
    agentApp(fake, `/contacts/${C}`);
    const u = userEvent.setup();
    await u.click(await within(await bar()).findByRole('button', { name: 'Log' }));
    const log = await screen.findByRole('dialog', { name: 'Log for Jane Doe' });
    await u.click(within(log).getByRole('button', { name: 'Left voicemail' }));
    await u.click(within(log).getByRole('button', { name: 'Save' }));
    expect(await within(screen.getByTestId('people-toast')).findByText('Call logged')).toBeInTheDocument();
    const s = await step();
    expect(within(s).getByRole('status')).toHaveTextContent('Call logged (left voicemail)');
    expect(await within(s).findByRole('radio', { name: 'Trying to reach Suggested' })).toBeChecked();
    const posts = fake.callsTo(`POST /contacts/${C}/activities`);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ kind: 'call', direction: 'outbound', outcome: 'left_voicemail', noteId: expect.stringMatching(UUID) });
    expect(fake.callsTo(`POST /contacts/${C}/stage`)).toHaveLength(0);
  });

  it('the log\'s id is made once per sheet: a retry after a lost answer sends the same noteId, and a replay is said as already saved (R-STG-6)', async () => {
    const fake = page().on(`POST /contacts/${C}/activities`, (_c, n) => (n === 1 ? 'network-error' : { ...activity({ replayed: true }), status: 200 }));
    agentApp(fake, `/contacts/${C}`);
    const u = userEvent.setup();
    await u.click(await within(await bar()).findByRole('button', { name: 'Log' }));
    const log = await screen.findByRole('dialog', { name: 'Log for Jane Doe' });
    await u.click(within(log).getByRole('button', { name: 'No answer' }));
    await u.click(within(log).getByRole('button', { name: 'Save' }));
    expect(await within(log).findByRole('alert')).toHaveTextContent("Can't reach the server. Check your connection, then try again.");
    await u.click(within(log).getByRole('button', { name: 'Save' }));
    const s = await step();
    expect(within(s).getByRole('status')).toHaveTextContent('Call logged (no answer). Your first tap had already saved it, as first written.');
    const ids = fake.callsTo(`POST /contacts/${C}/activities`).map((c) => (c.body as { noteId: string }).noteId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });
});

describe('one sheet, no navigation: text → stage step', () => {
  const message = (status: string, scheduledFor: string | null = null) => ({ id: IDS.message, channel: 'sms', status, statusReason: null, purpose: 'informational', body: 'x', subject: null, scheduledFor, dispatchedAt: scheduledFor ? null : iso(0) });

  it('Text opens a sheet with the compose box (no navigation); after the text is sent the same sheet suggests "Trying to reach" for a new lead', async () => {
    const fake = page().on(`POST /contacts/${C}/messages`, { status: 200, body: { message: message('sent'), decision: decision({}), result: 'sent' } });
    const { router } = agentApp(fake, `/contacts/${C}`);
    const u = userEvent.setup();
    await u.click(await within(await bar()).findByRole('button', { name: 'Text Jane Doe' }));
    const sheet = await screen.findByRole('dialog', { name: 'Text Jane Doe' });
    const box = await within(sheet).findByRole('textbox', { name: 'Text message' });
    await u.type(box, 'Hi Jane, saw your note about Oak St.');
    const send = within(sheet).getByRole('button', { name: 'Send' });
    await waitFor(() => expect(send).toBeEnabled());
    await u.click(send);
    const s = await step();
    expect(within(s).getByRole('status')).toHaveTextContent('Sent to Jane.');
    const suggested = await within(s).findByRole('radio', { name: 'Trying to reach Suggested' });
    expect(suggested).toBeChecked();
    expect(suggested).toHaveAccessibleDescription(/You sent a text and they have not replied yet\./);
    expect(fake.callsTo(`POST /contacts/${C}/messages`)).toHaveLength(1);
    expect(router.state.location.pathname).toBe(`/contacts/${C}`);
  });

  it('a text that is only scheduled has not been sent: the step says when it goes and suggests no stage', async () => {
    const at = iso(3 * 3_600_000);
    const fake = page().on(`POST /contacts/${C}/messages`, { status: 200, body: { message: message('scheduled', at), decision: decision({}), result: 'scheduled' } });
    agentApp(fake, `/contacts/${C}`);
    const u = userEvent.setup();
    await u.click(await within(await bar()).findByRole('button', { name: 'Text Jane Doe' }));
    const sheet = await screen.findByRole('dialog', { name: 'Text Jane Doe' });
    await u.type(await within(sheet).findByRole('textbox', { name: 'Text message' }), 'See you Saturday');
    const send = within(sheet).getByRole('button', { name: 'Send' });
    await waitFor(() => expect(send).toBeEnabled());
    await u.click(send);
    const s = await step();
    expect(within(s).getByRole('status')).toHaveTextContent(/^Sends /);
    const group = await within(s).findByRole('radiogroup', { name: 'Stage' });
    expect(within(group).getAllByRole('radio')).toHaveLength(1);
    expect(within(group).getByRole('radio', { name: 'Keep New lead' })).toBeChecked();
  });
});
