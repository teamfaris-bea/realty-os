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
import type { Details } from './api.js';
import { ToastProvider } from './hooks.js';
import { StageStep, type StageStepProps, morningIn, suggestionFromSignal } from './StageStep.js';
import type { StagePreview, StageResponse, SuggestedStage } from './stageFlow.js';
import { detailsFixture, guideFixture, stageFixture } from './testing.js';

const C = '01900000-0000-7000-8000-0000000c0001';
const EV = '01900000-0000-7000-8000-0000000e0002';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const preview = (over: Partial<StagePreview> = {}): StagePreview => ({ allowed: true, lockedReason: null, sameStage: false, starts: null, wontStart: null, keepsRunning: null, stops: [], aiCare: 'unchanged', tasks: 'unchanged', ...over });
const VOICEMAIL: SuggestedStage = { stage: 'attempting', why: 'You left a voicemail. That is a try, not a conversation yet.', locked: false, alsoOffer: [] };
const TALKED: SuggestedStage = { stage: 'connected', why: 'You talked with them. That is a two-way conversation.', locked: false, alsoOffer: [{ stage: 'nurture', locked: false }] };
const LOCKED = ['connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'];

function mount(o: { details?: Details; props?: Partial<StageStepProps>; previews?: Record<string, StagePreview>; extra?: (f: FakeFetch) => void } = {}) {
  const details = o.details ?? detailsFixture(C, 'new');
  const fake = new FakeFetch().on('GET /auth/session', { status: 200, body: sessionFixture() }).on(`GET /contacts/${C}/details`, { status: 200, body: { details } });
  for (const s of guideFixture()) fake.on(`GET /contacts/${C}/stage/preview?to=${s.key}`, { status: 200, body: o.previews?.[s.key] ?? preview({ sameStage: s.key === details.stage.stage }) });
  fake
    .on(`POST /contacts/${C}/stage`, (call) => {
      const to = (call.body as { stage: string }).stage;
      return { status: 200, body: { stage: stageFixture(to), previousStage: details.stage.stage, rowVersion: 2, eventId: EV, automation: null, stillRunning: null } satisfies StageResponse };
    })
    .on('POST /tasks', (call, n) => ({ status: n === 1 ? 201 : 200, body: { task: { id: (call.body as { id: string }).id }, replayed: n > 1 } }));
  o.extra?.(fake);
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

describe('the stage step after an outcome', () => {
  it('a voicemail on a new lead: what was saved; "Trying to reach" suggested with its definition and why, preselected; "Keep New lead"; the preview of the selected choice; one tap confirms', async () => {
    const { fake, onClose, u } = mount();
    const group = await stages();
    expect(within(await sheet()).getByRole('status')).toHaveTextContent('Voicemail logged');
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-labelledby')!.split(' ').map((id) => document.getElementById(id)!.textContent).join(' '))).toEqual(['Trying to reach Suggested', 'Keep New lead']);
    expect(radios[0]).toBeChecked();
    expect(radios[0]).toHaveAccessibleDescription(/We tried to reach them but have not had a two-way conversation yet\. A voicemail or an unanswered text is not a conversation\. You left a voicemail\. That is a try, not a conversation yet\./);
    // nothing is offered that the outcome does not suggest
    expect(within(group).queryByText('Long-term follow-up')).toBeNull();
    expect(await within(await sheet()).findByText('No plan starts on this stage.')).toBeInTheDocument();
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

  it('"Keep New lead" changes nothing: the button is named for it, the preview says nothing starts, and no stage request is sent', async () => {
    const { fake, onClose, u } = mount();
    await u.click(within(await stages()).getByRole('radio', { name: 'Keep New lead' }));
    expect(await within(await sheet()).findByText('They are in this stage now. Nothing starts.')).toBeInTheDocument();
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
    expect(await within(await sheet()).findByText('Will start: Stay in touch, first step text tomorrow 9:00 AM')).toBeInTheDocument();
    await u.click(longTerm);
    expect(await within(await sheet()).findByRole('button', { name: 'Change to Long-term follow-up' })).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByTestId('stage-preview')).getByText('No plan starts on this stage.')).toBeInTheDocument());
  });

  it('"Another stage…" opens all eight with their definitions; the current one is marked and a locked one cannot be selected', async () => {
    const details = detailsFixture(C, 'new', { stage: stageFixture('new', { locked: LOCKED, lockedReason: 'STAGE_NEEDS_CONTACT' }) });
    const { u } = mount({ details });
    const group = await stages();
    await u.click(within(await sheet()).getByRole('button', { name: 'Another stage…' }));
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(8);
    for (const s of guideFixture()) {
      expect(within(group).getByText(s.definition)).toBeInTheDocument();
      expect(within(group).getByText(s.notThis)).toBeInTheDocument();
    }
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

  it('the server\'s preview refuses the selected stage (it locked since): the button is disabled and says why; nothing is sent', async () => {
    const { fake } = mount({ previews: { attempting: preview({ allowed: false, lockedReason: 'STAGE_NEEDS_CONTACT' }) } });
    await stages();
    const confirm = within(await sheet()).getByRole('button', { name: 'Change to Trying to reach' });
    expect(await within(await sheet()).findByText(/This stage is locked for now: reach Dana first/)).toBeInTheDocument();
    expect(confirm).toBeDisabled();
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
    expect(within(s).getByTestId('follow-up-line')).toHaveTextContent(/^A task for you: “Follow up with Dana”, due .+9:00 AM\.$/);
    const confirm = within(s).getByRole('button', { name: 'Change to Trying to reach + follow-up' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await u.click(confirm);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const tasks = fake.callsTo('POST /tasks');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.body).toEqual({ id: expect.stringMatching(UUID), title: 'Follow up with Dana', kind: 'follow_up', contactId: C, dueAt: morningIn(1).toISOString() });
    expect(stagePosts(fake)).toHaveLength(1);
    expect(await within(screen.getByTestId('people-toast')).findByText(/^Stage: Trying to reach\. Follow-up added for .+9:00 AM$/)).toBeInTheDocument();
  });

  it('a double tap on the button sends one stage change and one task (R-STG-6)', async () => {
    const { fake, onClose, u } = mount();
    const s = await sheet();
    await stages();
    await u.click(within(s).getByRole('button', { name: '3 days' }));
    const confirm = within(s).getByRole('button', { name: 'Change to Trying to reach + follow-up' });
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
    let fail = true;
    const { fake, onClose, u } = mount({ extra: (f) => f.on('POST /tasks', (call) => (fail ? 'network-error' : { status: 200, body: { task: { id: (call.body as { id: string }).id }, replayed: true } })) });
    const s = await sheet();
    await stages();
    await u.click(within(s).getByRole('button', { name: '1 week' }));
    const confirm = within(s).getByRole('button', { name: 'Change to Trying to reach + follow-up' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await u.click(confirm);
    expect(await within(s).findByRole('alert')).toHaveTextContent("Can't reach the server. Check your connection, then try again.");
    // nothing was claimed, the sheet is still open, and the stage was not changed ahead of the follow-up
    expect(onClose).not.toHaveBeenCalled();
    expect(stagePosts(fake)).toHaveLength(0);
    fail = false;
    await u.click(confirm);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const ids = fake.callsTo('POST /tasks').map((c) => (c.body as { id: string }).id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(stagePosts(fake)).toHaveLength(1);
  });

  it('"Pick a date" shows a date and time field; with Keep the button is "Keep New lead + follow-up" and only the task is made', async () => {
    const { fake, onClose, u } = mount({ props: { suggested: null, saved: 'Wrong number logged' } });
    const s = await sheet();
    expect(within(await stages()).getAllByRole('radio')).toHaveLength(1);
    await u.click(within(s).getByRole('button', { name: 'Pick a date' }));
    const field = within(s).getByLabelText('Follow up on');
    expect(field).toHaveAttribute('type', 'datetime-local');
    await u.click(within(s).getByRole('button', { name: 'Keep New lead + follow-up' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(fake.callsTo('POST /tasks')).toHaveLength(1);
    expect(stagePosts(fake)).toHaveLength(0);
    expect(await within(screen.getByTestId('people-toast')).findByText(/^Follow-up added for /)).toBeInTheDocument();
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
