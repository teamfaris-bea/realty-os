// Incoming call settings on the Phone and email page: the ring timeout and greeting are saved with the
// version read; the fixed recording notice is shown and cannot be edited; out-of-range timeouts are refused.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, leadAdminApp, member } from './lib/testing.js';

const SETTINGS = { ringTimeoutSeconds: 20, voicemailGreeting: null, defaultGreeting: "You have reached Harbor. We can't take your call right now.", recordingNotice: 'After the tone, your message will be recorded.', version: 0 };

function fake() {
  return new FakeFetch()
    .on('GET /numbers', { status: 200, body: { numbers: [] } })
    .on('GET /members', { status: 200, body: { members: [member()], invites: [] } })
    .on('GET /voice-settings', { status: 200, body: { settings: SETTINGS } })
    .on('PUT /voice-settings', (c) => ({ status: 200, body: { settings: { ...SETTINGS, ...(c.body as object), version: 1 } } }));
}

describe('Incoming calls settings', () => {
  it('saves the ring timeout and the greeting with the version read, and shows the fixed recording notice', async () => {
    const f = fake();
    leadAdminApp(f, '/admin/numbers', 'admin');
    const u = userEvent.setup();
    const seconds = await screen.findByLabelText('Ring the agent for (seconds)');
    expect(screen.getByText(/Callers always hear this after it: “After the tone, your message will be recorded\.”/)).toBeInTheDocument();
    await u.clear(seconds);
    await u.type(seconds, '35');
    await u.type(screen.getByLabelText('Voicemail greeting'), 'Thanks for calling Harbor.');
    await u.click(screen.getByRole('button', { name: 'Save incoming call settings' }));
    await waitFor(() => expect(f.callsTo('PUT /voice-settings')).toHaveLength(1));
    expect(f.callsTo('PUT /voice-settings')[0]!.body).toEqual({ version: 0, ringTimeoutSeconds: 35, voicemailGreeting: 'Thanks for calling Harbor.' });
  });

  it('refuses a timeout outside 5–60 seconds before sending anything; an empty greeting means the default', async () => {
    const f = fake();
    leadAdminApp(f, '/admin/numbers', 'owner');
    const u = userEvent.setup();
    const seconds = await screen.findByLabelText('Ring the agent for (seconds)');
    await u.clear(seconds);
    await u.type(seconds, '90');
    expect(screen.getByText('Enter a number from 5 to 60.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save incoming call settings' })).toBeDisabled();
    await u.clear(seconds);
    await u.type(seconds, '15');
    await u.click(screen.getByRole('button', { name: 'Save incoming call settings' }));
    await waitFor(() => expect(f.callsTo('PUT /voice-settings')).toHaveLength(1));
    expect(f.callsTo('PUT /voice-settings')[0]!.body).toMatchObject({ ringTimeoutSeconds: 15, voicemailGreeting: null });
  });
});
