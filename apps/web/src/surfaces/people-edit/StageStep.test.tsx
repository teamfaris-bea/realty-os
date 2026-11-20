// The stage step (R-STG-2, R-STG-3, R-STG-6): after an outcome is saved, the same sheet says what was saved, offers
// the stage the outcome suggests (preselected, with what it means and why), lets the agent keep the current stage or
// pick another, shows what the selected choice will do, takes a follow-up, and has ONE primary button named for its
// effect. A suggestion changes nothing until that button is tapped. jsdom against a scripted API.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../shell/index.js';
import { ShellProvider } from '../../shell/context.js';
import { FakeFetch, err, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { type Details, detailsKey } from './api.js';
import { ToastProvider } from './hooks.js';
import { StageStep, type StageStepProps, morningIn, suggestionFromSignal } from './StageStep.js';
import type { StagePreview, StageResponse, SuggestedStage } from './stageFlow.js';
import { detailsFixture, fakeTaskStore, guideFixture, stageFixture } from './testing.js';

const C = '01900000-0000-7000-8000-0000000c0001';
const EV = '01900000-0000-7000-8000-0000000e0002';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const preview = (over: Partial<StagePreview> = {}): StagePreview => ({ allowed: true, lockedReason: null, sameStage: false, starts: null, wontStart: null, keepsRunning: null, stops: [], aiCare: 'unchanged', tasks: 'unchanged', ...over });
const VOICEMAIL: SuggestedStage = { stage: 'attempting', why: 'You left a voicemail. That is a try, not a conversation yet.', locked: false, alsoOffer: [] };
const TALKED: SuggestedStage = { stage: 'connected', why: 'You talked with them. That is a two-way conversation.', locked: false, alsoOffer: [{ stage: 'nurture', locked: false }] };
const LOCKED = ['connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'];

function mount(o: { details?: Details; cached?: Details; props?: Partial<StageStepProps>; previews?: Record<string, StagePreview>; extra?: (f: FakeFetch) => void; loseTaskAnswer?: (n: number) => boolean } = {}) {
  const details = o.details ?? detailsFixture(C, 'new');
  const fake = new FakeFetch().on('GET /auth/session', { status: 200, body: sessionFixture() }).on(`GET /contacts/${C}/details`, { status: 200, body: { details } });
  for (const s of guideFixture()) fake.on(`GET /contacts/${C}/stage/preview?to=${s.key}`, { status: 200, body: o.previews?.[s.key] ?? preview({ sameStage: s.key === details.stage.stage }) });
  fake
    .on(`POST /contacts/${C}/stage`, (call) => {
      const to = (call.body as { stage: string }).stage;
      return { status: 200, body: { stage: stageFixture(to), previousStage: details.stage.stage, rowVersion: 2, eventId: EV, automation: null, stillRunning: null } satisfies StageResponse };
    });
  // POST /tasks and PATCH /tasks/:id as the API answers them: the first body is stored, a replay answers it
  fakeTaskStore(fake, { lose: (n) => o.loseTaskAnswer?.(n) ?? false });
  o.extra?.(fake);
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  // what the page already had about the person when the sheet opened (the stage pill's details)
  if (o.cached) qc.setQueryData(detailsKey(C), { details: o.cached });
  render(
    <QueryClientProvider client={qc}>
      <ShellProvider api={new ApiClient({ fetch: fake.fetch })} table={tableWith()}>
        <MemoryRouter>
          <ToastProvider>
            <StageStep contactId={C} contactName="Dana Reyes" saved="Voicemail logged" suggested={VOICEMAIL} onClose={onClose} {...o.props} />
          </ToastProvider>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>,
  );
  return { fake, onClose, u: userEvent.setup() };
}
const sheet = () => screen.findByRole('dialog', { name: 'Stage for Dana Reyes' });
const stages = async () => within(await sheet()).findByRole('radiogroup', { name: 'Stage' });
const stagePosts = (fake: FakeFetch) => fake.callsTo(`POST /contacts/${C}/stage`);
/** the full preview in the sheet's body, and the one line above the button */
const previewBlock = () => within(screen.getByTestId('stage-preview'));
const effect = () => screen.getByTestId('stage-step-effect');

describe('the stage step after an outcome', () => {
  it('a voicemail on a new lead: what was saved; "Trying to reach" suggested with its definition and why, preselected; "Keep New lead"; the preview of the selected choice; one tap confirms', async () => {
    const { fake, onClose, u } = mount();
    const group = await stages();
    expect(within(await sheet()).getByRole('status')).toHaveTextContent('Voicemail logged');
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-labelledby')!.split(' ').map((id) => document.getElementById(id)!.textContent).join(' '))).toEqual(['Trying to reach Suggested', 'Keep New lead']);
    expect(radios[0]).toBeChecked();
    // its definition and why it is suggested. M4: the "does not mean" line is on demand, under "Another stage…"
    // (asserted below, in the test of the full list), so the effect and the follow-up stay above the fold on a phone
    expect(radios[0]).toHaveAccessibleDescription(/We tried to reach them but have not had a two-way conversation yet\. You left a voicemail\. That is a try, not a conversation yet\./);
    expect(within(group).queryByText('A voicemail or an unanswered text is not a conversation.')).toBeNull();
    // nothing is offered that the outcome does not suggest
    expect(within(group).queryByText('Long-term follow-up')).toBeNull();
    expect(await previewBlock().findByText('No plan starts on this stage.')).toBeInTheDocument();
    // the same line sits directly above the button, and the button is described by it
    expect(effect()).toHaveTextContent('No plan starts on this stage.');
    expect(within(await sheet()).getByRole('button', { name: 'Change to Trying to reach' })).toHaveAccessibleDescription('No plan starts on this stage.');
    expect(fake.callsTo(`GET /contacts/${C}/stage/preview?to=attempting`).length).toBeGreaterThanOrEqual(1);
    // the suggestion has changed nothing yet
    expect(stagePosts(fake)).toHaveLength(0);
    const confirm = within(await sheet()).getByRole('button', { name: 'Change to Trying to reach' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await u.click(confirm);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(stagePosts(fake).map((c) => c.body)).toEqual([{ stage: 'attempting' }]);
    expect(fake.callsTo('POST /tasks')).toHaveLength(0);
    expect(await within(screen.getByTestId('people-toast')).findByText('Stage: Trying to reach')).toBeInTheDocument();
  });

  it('M4 (E776): top to bottom the sheet reads what was logged, the suggested stage, "Keep", "Another stage…", ONE effect line with the running plan and Stop directly under it, the follow-up chips, then the one primary button; Close is in the header', async () => {
    const E = '01900000-0000-7000-8000-0000000e0009';
    const { onClose, u } = mount({
      details: detailsFixture(C, 'attempting'),
      props: { saved: 'Conversation logged', suggested: TALKED },
      previews: { connected: preview({ wontStart: { plan: 'Buyer plan', reason: 'already_in_a_plan', sentence: 'Buyer plan will not start: they are already in Seller plan, and a person is in one plan at a time. Stop Seller plan first if you want Buyer plan.', alreadyIn: { enrollmentId: E, plan: 'Seller plan' } }, keepsRunning: { enrollmentId: E, plan: 'Seller plan', state: 'active', canStop: true } }) },
    });
    const s = await sheet();
    await stages();
    await within(s).findByText('Keeps running: Seller plan');
    const order = [
      within(s).getByRole('status'),
      within(s).getByRole('radio', { name: 'Connected Suggested' }),
      within(s).getByRole('radio', { name: 'Keep Trying to reach' }),
      within(s).getByRole('radio', { name: 'Long-term follow-up' }),
      within(s).getByRole('button', { name: 'Another stage…' }),
      within(s).getByTestId('stage-step-effect'),
      within(s).getByText('Keeps running: Seller plan'),
      within(s).getByRole('button', { name: 'Stop Seller plan' }),
      within(s).getByRole('group', { name: 'Follow-up' }),
      within(s).getByTestId('stage-step-confirm'),
    ];
    for (let i = 1; i < order.length; i += 1) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING, `item ${i} comes after item ${i - 1}`).toBeTruthy();
    // the effect sentence is on the sheet once, and the button is described by it
    expect(within(s).getAllByText(/Buyer plan will not start/)).toHaveLength(1);
    expect(within(s).getByTestId('stage-step-confirm')).toHaveAccessibleDescription(/^Buyer plan will not start/);
    // one primary button in the footer; the way out is the header's Close, and the sheet opens on its title
    expect(within(s).getAllByRole('button', { name: /^(Change to|Keep) / })).toHaveLength(1);
    expect(s).toHaveFocus();
    await u.click(within(s).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('"Keep New lead" changes nothing: the button is named for it, the preview says nothing starts, and no stage request is sent', async () => {
    const { fake, onClose, u } = mount();
    await u.click(within(await stages()).getByRole('radio', { name: 'Keep New lead' }));
    expect(await previewBlock().findByText('They are in this stage now. Nothing starts.')).toBeInTheDocument();
    expect(effect()).toHaveTextContent('They are in this stage now. Nothing starts.');
    await u.click(within(await sheet()).getByRole('button', { name: 'Keep New lead' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(stagePosts(fake)).toHaveLength(0);
    expect(fake.callsTo('POST /tasks')).toHaveLength(0);
  });

  it('a conversation: "Connected" is suggested and "Long-term follow-up" is offered beside it because the server offers it; a plan that will start is in the preview', async () => {
    const { u } = mount({
      details: detailsFixture(C, 'attempting'),
      props: { saved: 'Conversation logged', suggested: TALKED },
      previews: { connected: preview({ starts: { plan: 'Stay in touch', firstStep: { channel: 'sms', dueAt: morningIn(1).toISOString() } } }) },
    });
    const group = await stages();
    expect(within(group).getByRole('radio', { name: 'Connected Suggested' })).toBeChecked();
    expect(within(group).getByRole('radio', { name: 'Keep Trying to reach' })).not.toBeChecked();
    const longTerm = within(group).getByRole('radio', { name: 'Long-term follow-up' });
    expect(longTerm).toHaveAccessibleDescription(/We have talked and they are months away, so we keep in touch\./);
    expect(await previewBlock().findByText('Will start: Stay in touch, first step: a text tomorrow at 9:00 AM')).toBeInTheDocument();
    expect(effect()).toHaveTextContent('Will start: Stay in touch, first step: a text tomorrow at 9:00 AM');
    await u.click(longTerm);
    expect(await within(await sheet()).findByRole('button', { name: 'Change to Long-term follow-up' })).toBeInTheDocument();
    await waitFor(() => expect(previewBlock().getByText('No plan starts on this stage.')).toBeInTheDocument());
    await waitFor(() => expect(effect()).toHaveTextContent('No plan starts on this stage.'));
  });

  it('"Another stage…" opens all eight with their definitions; the current one is marked and a locked one cannot be selected', async () => {
    const details = detailsFixture(C, 'new', { stage: stageFixture('new', { locked: LOCKED, lockedReason: 'STAGE_NEEDS_CONTACT' }) });
    const { u } = mount({ details });
    const group = await stages();
    await u.click(within(await sheet()).getByRole('button', { name: 'Another stage…' }));
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(8);
    // every stage says what it means; what it does NOT mean shows on demand, for the selected choice
    for (const s of guideFixture()) expect(within(group).getByText(s.definition)).toBeInTheDocument();
    const not = (key: string) => guideFixture().find((g) => g.key === key)!.notThis;
    expect(within(group).getByText(not('attempting'))).toBeInTheDocument();
    expect(within(group).queryByText(not('new'))).toBeNull();
    await u.click(within(group).getByRole('radio', { name: 'New lead Current' }));
    expect(within(group).getByText(not('new'))).toBeInTheDocument();
    expect(within(group).queryByText(not('attempting'))).toBeNull();
    await u.click(within(group).getByRole('radio', { name: 'Trying to reach Suggested' }));
    expect(within(group).getByRole('radio', { name: 'New lead Current' })).not.toBeDisabled();
    expect(within(group).getByRole('radio', { name: 'Trying to reach Suggested' })).toBeChecked();
    for (const s of guideFixture().filter((g) => LOCKED.includes(g.key))) {
      const r = within(group).getByRole('radio', { name: `${s.label} Locked` });
      expect(r).toBeDisabled();
      expect(r).toHaveAccessibleDescription(/Reach them first\./);
    }
  });

  it('a suggestion the server marks locked is shown locked with the reason, never selectable; "Keep" is preselected and nothing is sent for the locked stage', async () => {
    const details = detailsFixture(C, 'new', { stage: stageFixture('new', { locked: LOCKED, lockedReason: 'STAGE_NEEDS_CONTACT' }) });
    const { fake, onClose, u } = mount({ details, props: { saved: 'Call logged', suggested: { ...TALKED, locked: true, alsoOffer: [{ stage: 'nurture', locked: true }] } } });
    const group = await stages();
    const connected = within(group).getByRole('radio', { name: 'Connected Locked' });
    expect(connected).toBeDisabled();
    expect(connected).toHaveAccessibleDescription(/You talked with them\..*Reach them first\./);
    expect(within(group).getByRole('radio', { name: 'Long-term follow-up Locked' })).toBeDisabled();
    expect(within(group).getByRole('radio', { name: 'Keep New lead' })).toBeChecked();
    expect(within(await sheet()).getByText(/Something logged from outside Realty OS does not count\./)).toBeInTheDocument();
    await u.click(within(await sheet()).getByRole('button', { name: 'Keep New lead' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(stagePosts(fake)).toHaveLength(0);
    expect(fake.callsTo(`GET /contacts/${C}/stage/preview?to=connected`)).toHaveLength(0);
  });

  it('the step reads the person afresh: what the page had cached before the outcome (stages still locked) never locks a stage the outcome has just opened', async () => {
    // the first call to a routed lead: the dial was the first contact, so the server's suggestion is not locked,
    // while the page's cached details still list every later stage as locked
    const stale = detailsFixture(C, 'new', { stage: stageFixture('new', { locked: LOCKED, lockedReason: 'STAGE_NEEDS_CONTACT' }) });
    const { fake } = mount({ cached: stale, details: detailsFixture(C, 'new'), props: { saved: 'Conversation logged', suggested: TALKED } });
    const group = await stages();
    const connected = within(group).getByRole('radio', { name: 'Connected Suggested' });
    expect(connected).toBeChecked();
    expect(connected).toBeEnabled();
    expect(within(group).getByRole('radio', { name: 'Long-term follow-up' })).toBeEnabled();
    expect(within(await sheet()).queryByText(/Reach them first/)).toBeNull();
    expect(fake.callsTo(`GET /contacts/${C}/details`)).toHaveLength(1);
  });

  it('the server\'s preview refuses the selected stage (it locked since): the button is disabled and says why; nothing is sent', async () => {
    const { fake } = mount({ previews: { attempting: preview({ allowed: false, lockedReason: 'STAGE_NEEDS_CONTACT' }) } });
    await stages();
    const confirm = within(await sheet()).getByRole('button', { name: 'Change to Trying to reach' });
    expect(await within(await sheet()).findByText(/This stage is locked for now: reach Dana first/)).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    expect(effect()).toHaveTextContent('Locked for now: reach them first.');
    expect(stagePosts(fake)).toHaveLength(0);
  });

  it('follow-up chips: None by default; Tomorrow makes ONE task with an id made once for the sheet, and the button says so', async () => {
    const { fake, onClose, u } = mount();
    const s = await sheet();
    await stages();
    const chips = within(s).getByRole('group', { name: 'Follow-up' });
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['None', 'Tomorrow', '3 days', '1 week', 'Pick a date']);
    expect(within(chips).getByRole('button', { name: 'None' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(s).getByTestId('follow-up-line')).toHaveTextContent('No follow-up task.');
    await u.click(within(chips).getByRole('button', { name: 'Tomorrow' }));
    expect(within(s).getByTestId('follow-up-line')).toHaveTextContent(/^Will add a task for you: “Follow up with Dana”, due .+9:00 AM\.$/);
    // (b19 Today fix 1, R-TODAY-11: the button stays short and the task it adds is named under it, in the pinned footer)
    const confirm = within(s).getByRole('button', { name: 'Change to Trying to reach' });
    expect(within(within(s).getByTestId('dialog-footer')).getByTestId('tap-effects')).toHaveTextContent(/^Adds: Follow up with Dana, tomorrow 9:00 AM\.$/);
    expect(confirm).toHaveAccessibleDescription(/Adds: Follow up with Dana, tomorrow 9:00 AM\./);
    await waitFor(() => expect(confirm).toBeEnabled());
    await u.click(confirm);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const tasks = fake.callsTo('POST /tasks');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.body).toEqual({ id: expect.stringMatching(UUID), title: 'Follow up with Dana', kind: 'follow_up', contactId: C, dueAt: morningIn(1).toISOString() });
    expect(stagePosts(fake)).toHaveLength(1);
    expect(await within(screen.getByTestId('people-toast')).findByText(/^Stage: Trying to reach\. Follow-up saved for .+9:00 AM$/)).toBeInTheDocument();
  });

  it('a double tap on the button sends one stage change and one task (R-STG-6)', async () => {
    const { fake, onClose, u } = mount();
    const s = await sheet();
    await stages();
    await u.click(within(s).getByRole('button', { name: '3 days' }));
    const confirm = within(s).getByRole('button', { name: 'Change to Trying to reach' });
    await waitFor(() => expect(confirm).toBeEnabled());
    // two taps in the same frame: neither waits for the other
    confirm.click();
    confirm.click();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fake.callsTo('POST /tasks')).toHaveLength(1);
    expect(stagePosts(fake)).toHaveLength(1);
    expect((fake.callsTo('POST /tasks')[0]!.body as { dueAt: string }).dueAt).toBe(morningIn(3).toISOString());
  });

  it('a retry after a failed save sends the SAME task id, so the server answers the same task', async () => {
    // the first POST is stored, and its answer is lost
    const { fake, onClose, u } = mount({ loseTaskAnswer: (n) => n === 1 });
    const s = await sheet();
    await stages();
    await u.click(within(s).getByRole('button', { name: '1 week' }));
    const confirm = within(s).getByRole('button', { name: 'Change to Trying to reach' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await u.click(confirm);
    expect(await within(s).findByRole('alert')).toHaveTextContent("Can't reach the server. Check your connection, then try again.");
    // nothing was claimed, the sheet is still open, and the stage was not changed ahead of the follow-up
    expect(onClose).not.toHaveBeenCalled();
    expect(stagePosts(fake)).toHaveLength(0);
    await u.click(confirm);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const ids = fake.callsTo('POST /tasks').map((c) => (c.body as { id: string }).id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(stagePosts(fake)).toHaveLength(1);
  });

  it('L2 (E780): a retry after a lost answer is not silent: the server answers "the same stage again" with what is stored, and the toast says it (the plan that started, the follow-up, Undo)', async () => {
    // the first request changed the stage and started the plan, but its answer never arrived
    const repeat: StageResponse = { stage: stageFixture('attempting'), previousStage: 'attempting', rowVersion: 2, eventId: EV, automation: { started: 'Buyer plan' }, automationSentence: 'Buyer plan started.', stillRunning: null };
    const { fake, onClose, u } = mount({ extra: (f) => f.on(`POST /contacts/${C}/stage`, (_c, n) => (n === 1 ? 'network-error' : n === 2 ? { status: 200, body: repeat } : { status: 200, body: { stage: stageFixture('new'), previousStage: 'attempting', rowVersion: 3, eventId: '01900000-0000-7000-8000-0000000e0003', automation: null, stillRunning: null } })) });
    const s = await sheet();
    await stages();
    await u.click(within(s).getByRole('button', { name: 'Tomorrow' }));
    const confirm = within(s).getByTestId('stage-step-confirm');
    await waitFor(() => expect(confirm).toBeEnabled());
    await u.click(confirm);
    // (b19 Today fix 1, R-TODAY-11: one consistent sentence: what was saved, what could not be confirmed, the reason)
    expect(await within(s).findByRole('alert')).toHaveTextContent(/^Saved: voicemail logged and the follow-up for .+ 9:00 AM\. Not confirmed: the stage change\. Can't reach the server\. Check your connection, then try again\.$/);
    expect(onClose).not.toHaveBeenCalled();
    await u.click(confirm);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const toast = screen.getByTestId('people-toast');
    expect(toast.textContent).toMatch(/^Stage: Trying to reach\. Buyer plan started\. Follow-up saved for .+9:00 AM/);
    // Undo names the stored event and goes back to the stage the sheet knew the person was in
    // (b19 Today fix 7, L16: beside the follow-up it says what it undoes: the stage change, nothing else)
    await u.click(within(toast).getByRole('button', { name: 'Undo stage change' }));
    await waitFor(() => expect(stagePosts(fake)).toHaveLength(3));
    expect(stagePosts(fake)[2]!.body).toEqual({ stage: 'new', undoOf: EV });
  });

  it('L2 (E780): a repeat whose answer names no stage event (the person was already there by another route) still says the stage, with no Undo', async () => {
    const repeat: StageResponse = { stage: stageFixture('attempting'), previousStage: 'attempting', rowVersion: 2, eventId: null, automation: null, stillRunning: null };
    const { onClose, u } = mount({ extra: (f) => f.on(`POST /contacts/${C}/stage`, { status: 200, body: repeat }) });
    const s = await sheet();
    await stages();
    const confirm = within(s).getByTestId('stage-step-confirm');
    await waitFor(() => expect(confirm).toBeEnabled());
    await u.click(confirm);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const toast = screen.getByTestId('people-toast');
    expect(await within(toast).findByText('Stage: Trying to reach')).toBeInTheDocument();
    expect(within(toast).queryByRole('button', { name: /^Undo/ })).toBeNull();
  });

  it('"Pick a date" shows a date and time field; with Keep the button is "Keep New lead", the footer names the task it adds, and only the task is made', async () => {
    const { fake, onClose, u } = mount({ props: { suggested: null, saved: 'Wrong number logged' } });
    const s = await sheet();
    expect(within(await stages()).getAllByRole('radio')).toHaveLength(1);
    await u.click(within(s).getByRole('button', { name: 'Pick a date' }));
    const field = within(s).getByLabelText('Follow up on');
    expect(field).toHaveAttribute('type', 'datetime-local');
    expect(within(within(s).getByTestId('dialog-footer')).getByTestId('tap-effects')).toHaveTextContent(/^Adds: Follow up with Dana, tomorrow 9:00 AM\.$/);
    await u.click(within(s).getByRole('button', { name: 'Keep New lead' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(fake.callsTo('POST /tasks')).toHaveLength(1);
    expect(stagePosts(fake)).toHaveLength(0);
    expect(await within(screen.getByTestId('people-toast')).findByText(/^Follow-up saved for /)).toBeInTheDocument();
  });

  it('a refused stage change keeps the sheet open with the server\'s reason and claims nothing', async () => {
    const { onClose, u } = mount({ extra: (f) => f.on(`POST /contacts/${C}/stage`, err(422, 'STAGE_NEEDS_CONTACT')) });
    const s = await sheet();
    await stages();
    const confirm = within(s).getByRole('button', { name: 'Change to Trying to reach' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await u.click(confirm);
    expect(await within(s).findByRole('alert')).toHaveTextContent('Reach them first (a call, text, email or reply in their website chat), or close the lead.');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('people-toast').textContent).toBe('');
  });

  it('someone who may not edit the person sees what was saved and no stage control at all', async () => {
    const { fake } = mount({ details: detailsFixture(C, 'new', { canEdit: false }), props: { suggested: null } });
    const s = await sheet();
    expect(await within(s).findByText('The stage stays New lead. Only someone who can edit this person changes it.')).toBeInTheDocument();
    expect(within(s).getByRole('status')).toHaveTextContent('Voicemail logged');
    expect(within(s).queryByRole('radiogroup')).toBeNull();
    expect(within(s).getAllByRole('button').map((b) => b.textContent)).toEqual(['Done']);
    expect(fake.calls.filter((c) => c.path.includes('/stage/preview'))).toHaveLength(0);
  });

  it('a sent text has no server suggestion: the step reads the signal by core\'s own table against the fresh details (new → Trying to reach; later stages suggest nothing; a locked stage is locked)', async () => {
    mount({ props: { suggested: undefined, signal: { kind: 'message', channel: 'text', direction: 'outbound' }, saved: 'Sent to Dana.' } });
    const group = await stages();
    expect(within(group).getByRole('radio', { name: 'Trying to reach Suggested' })).toBeChecked();
    expect(within(group).getByRole('radio', { name: 'Trying to reach Suggested' })).toHaveAccessibleDescription(/You sent a text and they have not replied yet\./);
    expect(suggestionFromSignal(detailsFixture(C, 'connected'), { kind: 'message', channel: 'text', direction: 'outbound' })).toBeNull();
    expect(suggestionFromSignal(detailsFixture(C, 'new', { stage: stageFixture('new', { locked: ['attempting'] }) }), { kind: 'message', channel: 'text', direction: 'outbound' })).toMatchObject({ stage: 'attempting', locked: true });
    expect(suggestionFromSignal(detailsFixture(C, 'attempting'), { kind: 'call', outcome: 'connected' })).toEqual({ stage: 'connected', why: 'You talked with them. That is a two-way conversation.', locked: false, alsoOffer: [{ stage: 'nurture', locked: false }] });
  });
});
