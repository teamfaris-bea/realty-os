// Module 64: the template picker in the composer (inserts text only; Send is unchanged), the "Send later"
// control (the existing scheduleAt), and the template library with the signature (R-PAR-23..R-PAR-25).
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, decision, fullContact, timelineItem } from '../feed/lib/testing.js';
import { renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { surface as templatesSurface } from './index.js';
import type { TemplateView } from './api.js';

const T = (over: Partial<TemplateView> = {}): TemplateView => ({
  id: '01900000-0000-7000-8000-0000000071a1',
  scope: 'team',
  mine: false,
  channel: 'sms',
  name: 'Showing follow-up',
  subject: null,
  body: 'Hi {{contact.first_name}}, how was the showing?',
  version: 1,
  mergeFields: ['contact.first_name'],
  archived: false,
  editable: false,
  updatedAt: '2026-11-10T10:00:00Z',
  ...over,
});

function threadFake() {
  return new FakeFetch()
    .on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact: fullContact() } })
    .on(`GET /contacts/${IDS.jane}/timeline?limit=100`, { status: 200, body: { items: [timelineItem()], nextCursor: null } })
    .on(`POST /contacts/${IDS.jane}/messages/preview`, { status: 200, body: { decision: decision({ id: null, phase: 'preview' }), body: '' } })
    .on('GET /templates?channel=sms', { status: 200, body: { templates: [T(), T({ id: '01900000-0000-7000-8000-0000000071a2', scope: 'personal', mine: true, name: 'Running late', body: 'Running 10 minutes late, sorry!' })] } });
}

describe('R-PAR-24 the template picker in the composer', () => {
  it('Templates → a template → Send: the text rendered for this person lands in the box, and only Send sends it (3 taps)', async () => {
    const fake = threadFake()
      .on('POST /templates/01900000-0000-7000-8000-0000000071a1/render', { status: 200, body: { rendered: { templateId: T().id, version: 1, channel: 'sms', subject: null, body: 'Hi Jane, how was the showing?', preview: 'Hi Jane, how was the showing?', missing: [] } } })
      .on(`POST /contacts/${IDS.jane}/messages`, { status: 200, body: { message: { id: IDS.message, channel: 'sms', status: 'sent', statusReason: null, purpose: 'informational', body: 'x', subject: null, scheduledFor: null, dispatchedAt: null }, decision: decision({}), result: 'sent' } });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    const u = userEvent.setup();
    let taps = 0;
    await u.click(await screen.findByRole('button', { name: 'Templates' }));
    taps += 1;
    const sheet = await screen.findByRole('dialog', { name: 'Text templates' });
    expect(within(sheet).getByRole('region', { name: 'Team templates' })).toBeInTheDocument();
    expect(within(sheet).getByRole('region', { name: 'Your templates' })).toBeInTheDocument();
    await u.click(within(sheet).getByRole('button', { name: /Showing follow-up/ }));
    taps += 1;
    const box = screen.getByRole('textbox', { name: 'Text message' });
    await waitFor(() => expect(box).toHaveValue('Hi Jane, how was the showing?'));
    expect(fake.callsTo('POST /templates/01900000-0000-7000-8000-0000000071a1/render')[0]!.body).toEqual({ contactId: IDS.jane });
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages`)).toHaveLength(0); // inserting never sends
    await u.click(screen.getByRole('button', { name: 'Send' }));
    taps += 1;
    await waitFor(() => expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages`)).toHaveLength(1));
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages`)[0]!.body).toMatchObject({ channel: 'sms', body: 'Hi Jane, how was the showing?' });
    expect(taps).toBe(3);
  });

  it('R-PAR-24 a template that needs a value this person lacks is named before sending; nothing is inserted', async () => {
    const fake = threadFake().on('POST /templates/01900000-0000-7000-8000-0000000071a1/render', { status: 200, body: { rendered: { templateId: T().id, version: 1, channel: 'sms', subject: null, body: 'Hi , how was the showing?', preview: '', missing: ['contact.first_name'] } } });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Templates' }));
    await u.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /Showing follow-up/ }));
    expect(await screen.findByText(/needs their first name, which this person doesn't have/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Text message' })).toHaveValue('');
  });

  it('typing a name and Enter picks the first match (desktop: Templates → type → ↵)', async () => {
    const fake = threadFake().on('POST /templates/01900000-0000-7000-8000-0000000071a2/render', { status: 200, body: { rendered: { templateId: '01900000-0000-7000-8000-0000000071a2', version: 1, channel: 'sms', subject: null, body: 'Running 10 minutes late, sorry!', preview: '', missing: [] } } });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Templates' }));
    await u.type(await screen.findByRole('textbox', { name: 'Find a template' }), 'late{Enter}');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Text message' })).toHaveValue('Running 10 minutes late, sorry!'));
  });

  it('R-PAR-25 Send later sends the existing scheduleAt for a future time; a past time is refused before sending', async () => {
    const fake = threadFake().on(`POST /contacts/${IDS.jane}/messages`, { status: 200, body: { message: { id: IDS.message, channel: 'sms', status: 'scheduled', statusReason: null, purpose: 'informational', body: 'x', subject: null, scheduledFor: '2030-01-01T10:00:00Z', dispatchedAt: null }, decision: null, result: 'scheduled' } });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    const u = userEvent.setup();
    await u.type(await screen.findByRole('textbox', { name: 'Text message' }), 'See you tomorrow');
    await u.click(screen.getByRole('button', { name: 'Send later' }));
    const when = screen.getByLabelText('Send at');
    fireEvent.change(when, { target: { value: '2000-01-01T10:00' } });
    await u.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(await screen.findByText('Pick a time in the future, or turn off Send later.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages`)).toHaveLength(0);
    fireEvent.change(when, { target: { value: '2030-01-01T10:00' } });
    await u.click(screen.getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages`)).toHaveLength(1));
    expect((fake.callsTo(`POST /contacts/${IDS.jane}/messages`)[0]!.body as { scheduleAt: string }).scheduleAt).toBe(new Date('2030-01-01T10:00').toISOString());
  });
});

function libraryApp(fake: FakeFetch, role: 'owner' | 'agent' | 'team_lead') {
  const s = sessionFixture();
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
  return renderApp({ fake, path: '/templates', table: tableWith(templatesSurface) });
}

describe('R-PAR-23 the template library', () => {
  const lib = () =>
    new FakeFetch()
      .on('GET /templates', { status: 200, body: { templates: [T(), T({ id: '01900000-0000-7000-8000-0000000071a3', scope: 'personal', mine: true, editable: true, name: 'Mine', channel: 'email', subject: 'Hello' })] } })
      .on('GET /email-signature', { status: 200, body: { signature: null } });

  it('R-PAR-23 an agent sees team templates read-only with "Copy to mine", and edits only their own', async () => {
    const fake = lib().on('POST /templates/01900000-0000-7000-8000-0000000071a1/copy', { status: 201, body: { template: T({ scope: 'personal', mine: true }) } });
    libraryApp(fake, 'agent');
    const team = await screen.findByRole('region', { name: 'Team templates' });
    expect(within(team).queryByRole('button', { name: /Edit/ })).toBeNull();
    await userEvent.setup().click(within(team).getByRole('button', { name: 'Copy to mine: Showing follow-up' }));
    expect(await screen.findByText('Copied “Showing follow-up” to your templates.')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Your templates' })).getByRole('button', { name: 'Edit Mine' })).toBeInTheDocument();
  });

  it('R-PAR-24 a new template inserts merge fields from the closed list and shows the server\'s reason when refused', async () => {
    const fake = lib().on('POST /templates', { status: 422, body: { error: { code: 'MERGE_FIELD_UNKNOWN', requestId: 'r' } } });
    libraryApp(fake, 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'New template' }));
    const d = await screen.findByRole('dialog', { name: 'New template' });
    await u.click(within(d).getByRole('radio', { name: 'Whole team' }));
    await u.type(within(d).getByLabelText('Name'), 'Welcome');
    await u.click(within(d).getByRole('button', { name: 'Their first name' }));
    expect(within(d).getByLabelText('Message')).toHaveValue('{{contact.first_name}}');
    await u.click(within(d).getByRole('button', { name: 'Save' }));
    expect(await within(d).findByText("That merge field isn't one we can fill in. Pick one from the list.")).toBeInTheDocument();
    expect(fake.callsTo('POST /templates')[0]!.body).toEqual({ scope: 'team', channel: 'sms', name: 'Welcome', body: '{{contact.first_name}}', subject: null });
  });

  it('R-PAR-25 the signature is plain text saved with PUT /email-signature', async () => {
    const fake = lib().on('PUT /email-signature', { status: 200, body: { signature: 'Ava Agent\nHarbor' } });
    libraryApp(fake, 'agent');
    const u = userEvent.setup();
    const box = await screen.findByLabelText('Plain text, added to every email you send.');
    await u.type(box, 'Ava Agent{Enter}Harbor');
    await u.click(screen.getByRole('button', { name: 'Save signature' }));
    expect(await screen.findByText(/Signature saved/)).toBeInTheDocument();
    expect(fake.callsTo('PUT /email-signature')[0]!.body).toEqual({ signature: 'Ava Agent\nHarbor' });
  });
});
