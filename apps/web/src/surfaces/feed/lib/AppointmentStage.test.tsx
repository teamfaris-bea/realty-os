// R-STG-2: after an appointment's outcome is logged, the same sheet shows the stage step when the server suggests a
// stage for it (only a signed agreement does: "Active client"). Any other result closes the sheet with "Outcome
// saved." exactly as before. The outcome is saved by its own tap either way; the suggestion changes nothing until
// the agent confirms it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../../shell/index.js';
import { ShellProvider } from '../../../shell/context.js';
import { FakeFetch, sessionFixture, tableWith } from '../../../shell/testing/fakeApi.js';
import { detailsFixture, guideFixture, stageFixture } from '../../people-edit/testing.js';
import { AgentSheetsProvider, useAgentSheets } from './AgentSheets.js';
import { IDS, iso } from './testing.js';

const C = IDS.jane;
const EV = '01900000-0000-7000-8000-0000000e0002';
const appointment = { id: IDS.appt, kind: 'buyer_consult', startsAt: iso(-7_200_000), endsAt: iso(-3_600_000), location: null, status: 'held', outcome: 'agreement_signed', outcomeNote: null, outcomeLoggedAt: iso(0), userId: IDS.me, contact: { id: C, name: 'Jane Doe' }, dealId: null, awaitingOutcome: false, createdByKind: 'user' };
const SIGNED = { stage: 'active', why: 'They signed an agreement, so you are working together now.', locked: false, alsoOffer: [] };

function Opener() {
  const { logAppointment } = useAgentSheets();
  return (
    <button type="button" onClick={() => logAppointment(IDS.appt, 'Buyer consult with Jane Doe')}>
      Log outcome
    </button>
  );
}

function mount(outcome: unknown) {
  const fake = new FakeFetch()
    .on('GET /auth/session', { status: 200, body: sessionFixture() })
    .on(`POST /appointments/${IDS.appt}/outcome`, { status: 200, body: outcome })
    .on(`GET /contacts/${C}/details`, { status: 200, body: { details: detailsFixture(C, 'connected') } })
    .on(`POST /contacts/${C}/stage`, (call) => ({ status: 200, body: { stage: stageFixture((call.body as { stage: string }).stage), previousStage: 'connected', rowVersion: 2, eventId: EV, automation: { started: 'Buyer plan' }, stillRunning: null } }));
  for (const s of guideFixture()) fake.on(`GET /contacts/${C}/stage/preview?to=${s.key}`, { status: 200, body: { allowed: true, lockedReason: null, sameStage: s.key === 'connected', starts: s.key === 'active' ? { plan: 'Buyer plan', firstStep: null } : null, wontStart: null, keepsRunning: null, stops: [], aiCare: 'unchanged', tasks: 'unchanged' } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ShellProvider api={new ApiClient({ fetch: fake.fetch })} table={tableWith()}>
        <MemoryRouter>
          <AgentSheetsProvider>
            <Opener />
          </AgentSheetsProvider>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>,
  );
  return { fake, u: userEvent.setup() };
}

describe('the appointment outcome sheet and the stage step (R-STG-2)', () => {
  it('Signed: the outcome is saved by its tap, then the same sheet suggests "Active client" with why and what it will start; the agent confirms', async () => {
    const { fake, u } = mount({ appointment, suggestedStage: SIGNED });
    await u.click(screen.getByRole('button', { name: 'Log outcome' }));
    await u.click(within(await screen.findByRole('dialog', { name: 'Buyer consult with Jane Doe' })).getByRole('button', { name: 'Signed' }));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('Outcome saved.'));
    const step = await screen.findByRole('dialog', { name: 'Stage for Jane Doe' });
    expect(within(step).getByRole('status')).toHaveTextContent('Outcome saved: Signed');
    const active = await within(step).findByRole('radio', { name: 'Active client Suggested' });
    expect(active).toBeChecked();
    expect(active).toHaveAccessibleDescription(/We are working together now\..*They signed an agreement, so you are working together now\./);
    expect(within(step).getByRole('radio', { name: 'Keep Connected' })).toBeInTheDocument();
    expect(await within(within(step).getByTestId('stage-preview')).findByText('Will start: Buyer plan. No message is due from it yet.')).toBeInTheDocument();
    expect(within(step).getByTestId('stage-step-effect')).toHaveTextContent('Will start: Buyer plan. No message is due from it yet.');
    expect(fake.callsTo(`POST /contacts/${C}/stage`)).toHaveLength(0);
    const confirm = within(step).getByRole('button', { name: 'Change to Active client' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await u.click(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake.callsTo(`POST /contacts/${C}/stage`).map((c) => c.body)).toEqual([{ stage: 'active' }]);
    expect(fake.callsTo(`POST /appointments/${IDS.appt}/outcome`)).toHaveLength(1);
    expect(await within(screen.getByTestId('people-toast')).findByText('Stage: Active client. Started Buyer plan')).toBeInTheDocument();
  });

  it.each([
    ['a result that suggests nothing', { appointment: { ...appointment, outcome: 'follow_up' }, suggestedStage: null }],
    ['an API that answers no suggestion at all', { appointment: { ...appointment, outcome: 'follow_up' } }],
    ['an appointment with no person', { appointment: { ...appointment, contact: null }, suggestedStage: SIGNED }],
  ])('%s closes the sheet with "Outcome saved." as before: one tap, no stage step', async (_name, body) => {
    const { fake, u } = mount(body);
    await u.click(screen.getByRole('button', { name: 'Log outcome' }));
    await u.click(within(await screen.findByRole('dialog', { name: 'Buyer consult with Jane Doe' })).getByRole('button', { name: 'Follow up' }));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('Outcome saved.'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake.calls.filter((c) => c.path.includes('/details') || c.path.includes('/stage'))).toHaveLength(0);
  });
});
