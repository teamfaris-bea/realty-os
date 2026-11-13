// Contract test of module 76 against the API's own schemas (apps/api/src/isaWeb/webContract.json, generated from
// isa/schemas.ts and isaWeb/routes.ts; its drift test keeps it current): every fixture the component tests answer
// with is a body the API can send, and every request the surface sends is one the API's strict Zod bodies accept
// (no commandId: V2). useIsaAction: one tap is one request; REAUTH_REQUIRED re-sends once.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { err, sessionFixture } from '../../shell/testing/fakeApi.js';
import { FakeFetch, IDS, ISA_IDS, adminView, contactReads, handoffView, isaApp, isaError, isaRequestViolations, isaResponseViolations, meView, optIn, panel, row, turn } from './testing.js';

describe('the AI ISA web contract (isaWeb/webContract.json)', () => {
  it('fixtures satisfy the response schemas the API serializes with', () => {
    const cases: [string, unknown][] = [
      ['GET /contacts/:id/ai-isa', panel()],
      ['GET /contacts/:id/ai-isa', panel({ state: 'paused' })],
      ['GET /contacts/:id/ai-isa', panel({ state: 'ended', handoff: { id: ISA_IDS.handoff, reason: 'opted_out', slaClass: 'high', slaDueAt: new Date().toISOString(), slaMetAt: null, overdue: false, confirmationStatus: 'none', closedReason: null } })],
      ['GET /contacts/:id/ai-isa', panel({ state: 'none', canStart: true })],
      ['GET /ai-isa/assignments', { rows: [row(), row({ chip: { kind: 'paused', sentence: 'Paused: user (nobody is following up)' } })], holdSentence: 'AI assistant sending is off on this deployment.' }],
      ['GET /contacts/:id/ai-isa/turns', { turns: [turn(), turn({ status: 'blocked', denied: ['ISA_QUIET_HOURS:reply'] })] }],
      ['GET /admin/ai-isa', adminView()],
      ['GET /me/ai-isa', meView()],
      ['GET /me/ai-isa', meView({ optIn: optIn(), underCare: 2, sentence: 'You are opted in.' })],
      ['GET /ai-isa/handoffs/:id', handoffView()],
      ['GET /ai-isa/handoffs/:id', handoffView({ pendingMessage: { id: ISA_IDS.pending, kind: 'confirmation', channel: 'sms', status: 'scheduled', scheduledFor: new Date().toISOString() }, package: { ...handoffView().package, extraFromIsa2b: { any: 'thing' } } })],
      ['POST /contacts/:id/ai-isa/take-over', { assignmentId: ISA_IDS.assignment, state: 'paused', epoch: 1, inFlight: [], canceled: 0, undoUntil: new Date().toISOString(), sentence: 'You took over.' }],
      ['POST /contacts/:id/ai-isa/start', { assignmentId: ISA_IDS.assignment, state: 'starting', epoch: 1, inFlight: [], canceled: 0, undoUntil: null, sentence: 'AI care started.', stoppedEnrollment: false, supersededProposals: 2 }],
      ['POST /ai-isa/handoffs/:id/ack', { handoffId: ISA_IDS.handoff, acknowledgedAt: new Date().toISOString(), slaMet: false, confirmationStatus: 'none', closedReason: null }],
      // batch 13 merge (0081): a handoff with no deadline, and one the system closed
      ['GET /ai-isa/handoffs/:id', handoffView({ slaClass: 'none', closedReason: 'acknowledged' })],
      ['GET /contacts/:id/ai-isa', panel({ state: 'ended', handoff: { id: ISA_IDS.handoff, reason: 'opted_out', slaClass: 'none', slaDueAt: new Date().toISOString(), slaMetAt: null, overdue: false, confirmationStatus: 'none', closedReason: 'lead_closed' } })],
      // batch 13 isa-4 (b12 recheck R16 follow-up): an earlier handoff still open after a restart
      ['GET /contacts/:id/ai-isa', panel({ earlierHandoff: { id: ISA_IDS.handoff, reason: 'ended_by_user', slaClass: 'high', slaDueAt: new Date().toISOString(), slaMetAt: null, overdue: true, confirmationStatus: 'none', closedReason: null } })],
      // batch 13 isa-4 F6: ISA-2b's package fields, as handoff.ts and booking/book.ts write them
      ['GET /ai-isa/handoffs/:id', handoffView({ package: { ...handoffView().package, appointmentDetail: { appointmentId: ISA_IDS.optin, kind: 'buyer_consult', startsAt: new Date().toISOString(), endsAt: new Date().toISOString(), organizerUserId: IDS.me, offerId: ISA_IDS.other, acceptedMessageId: IDS.message, acceptedQuote: 'Tuesday at 3 works', linkId: null, calendarReadAt: new Date().toISOString(), calendarSentence: 'x', zones: ['America/New_York'], minNoticeHours: 2 }, savedSearch: { id: ISA_IDS.turn, status: 'proposed' }, recipientUserId: IDS.me, endedByUserId: null, inactivityReleaseAt: new Date().toISOString() } })],
      ['GET /ai-isa/handoffs/:id', handoffView({ package: { ...handoffView().package, appointmentDetail: null, savedSearch: null, recipientUserId: null, endedByUserId: ISA_IDS.tl, inactivityReleaseAt: null } })],
    ];
    for (const [key, body] of cases) expect(isaResponseViolations(key, body), key).toEqual([]);
    // and a stray score or confidence key is something the panel can never carry
    expect(isaResponseViolations('GET /ai-isa/handoffs/:id', { ...handoffView(), confidence: 0.9 })).not.toEqual([]);
    // batch 13 isa-4 F6: the ISA-2b keys are typed in the contract, so a wrong shape is caught
    expect(isaResponseViolations('GET /ai-isa/handoffs/:id', handoffView({ package: { ...handoffView().package, savedSearch: { id: 1 as unknown as string, status: 'proposed' } } }))).not.toEqual([]);
    expect(isaResponseViolations('GET /contacts/:id/ai-isa', { ...panel(), assignment: { ...panel().assignment!, state: 'nonsense' } })).not.toEqual([]);
  });

  it('V2: the strict bodies refuse a commandId; the surface sends the exact keys', () => {
    expect(isaRequestViolations('POST /contacts/:id/ai-isa/pause', { commandId: 'x' })).not.toEqual([]);
    expect(isaRequestViolations('POST /contacts/:id/ai-isa/take-over', {})).toEqual([]);
    expect(isaRequestViolations('POST /contacts/:id/ai-isa/start', { side: 'buyer' })).toEqual([]);
    expect(isaRequestViolations('POST /contacts/:id/ai-isa/start', { side: 'buyer', fromHandbackId: IDS.handback })).toEqual([]);
    expect(isaRequestViolations('PUT /admin/ai-isa', { enabled: true, dailyCap: 100, attestation: 'short' })).not.toEqual([]);
    expect(isaRequestViolations('PUT /me/ai-isa/opt-in', { versionId: ISA_IDS.version, capabilities: ['converse'], channels: ['sms'], timezone: 'America/New_York', availability: [{ weekday: 1, start: '09:00', end: '17:00' }], bookingKinds: [] })).toEqual([]);
  });

  it('R-ISA-15 useIsaAction: the body equals the strict schema keys (no commandId) and a double tap sends one request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = contactReads(new FakeFetch())
      .on(`GET /contacts/${IDS.jane}/ai-isa`, { status: 200, body: panel() })
      .on(`GET /contacts/${IDS.jane}/ai-isa/turns`, { status: 200, body: { turns: [] } })
      .on(`GET /contacts/${IDS.jane}/reachability`, { status: 404, body: { error: { code: 'NOT_FOUND', requestId: 'r' } } })
      .on(`POST /contacts/${IDS.jane}/ai-isa/pause`, async () => {
        await gate;
        return { status: 200, body: { assignmentId: ISA_IDS.assignment, state: 'paused', epoch: 1, inFlight: [], canceled: 0, undoUntil: null, sentence: 'Paused: nobody is following up automatically.' } };
      });
    isaApp(fake, `/contacts/${IDS.jane}`, 'agent');
    const strip = await screen.findByTestId('ai-strip');
    const pause = within(strip).getAllByRole('button', { name: 'Pause' })[0]!;
    const u = userEvent.setup();
    await u.click(pause);
    await u.click(pause);
    release();
    await waitFor(() => expect(fake.callsTo(`POST /contacts/${IDS.jane}/ai-isa/pause`)).toHaveLength(1));
    const [call] = fake.callsTo(`POST /contacts/${IDS.jane}/ai-isa/pause`);
    expect(call!.body).toEqual({});
    expect(isaRequestViolations('POST /contacts/:id/ai-isa/pause', call!.body)).toEqual([]);
    expect(call!.headers['x-command-id']).toBeUndefined();
  });

  it('R-PERM-13 useIsaAction: REAUTH_REQUIRED opens the password prompt once and re-sends the same request', async () => {
    let n = 0;
    const fake = new FakeFetch()
      .on('GET /me/ai-isa', { status: 200, body: meView() })
      .on('PUT /me/ai-isa/opt-in', () => (++n === 1 ? err(401, 'REAUTH_REQUIRED') : { status: 200, body: { optInId: ISA_IDS.optin, change: 'created' } }))
      .on('POST /auth/reauth', () => {
        const base = sessionFixture({ reauthenticatedAt: new Date().toISOString() });
        return { status: 200, body: { session: base } };
      });
    isaApp(fake, '/settings/ai-assistant', 'agent');
    const u = userEvent.setup();
    await u.click(await screen.findByLabelText('I have read this and agree'));
    await u.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await u.type(within(dialog).getByLabelText('Password'), 'correct horse');
    await u.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByTestId('optin-line').textContent).toBe('You are opted in.'));
    const calls = fake.callsTo('PUT /me/ai-isa/opt-in');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toEqual(calls[1]!.body);
    expect(isaRequestViolations('PUT /me/ai-isa/opt-in', calls[0]!.body)).toEqual([]);
    expect(Object.keys(calls[0]!.body as object).sort()).toEqual(['availability', 'bookingKinds', 'capabilities', 'channels', 'timezone', 'versionId']);
    // the server writes the attestation (settings.ts:127-130): the body carries none
    expect(JSON.stringify(calls[0]!.body)).not.toMatch(/responsible/);
  });

  it('errors come back as the contract says the API answers them', () => {
    expect(isaError('AI_ISA_UNDO_EXPIRED').status).toBe(409);
    expect(isaError('AI_ISA_NOT_OWNER').status).toBe(404);
  });
});
