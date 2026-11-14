// AI care in the feed and around sends (R-ISA-14, R-ISA-30, R-ISA-3, R-ISA-15; E496, E521, E533; V1, V9, V13, V17).
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { card, draftAction, feed } from '../feed/lib/testing.js';
import { FakeFetch, IDS, ISA_IDS, contactReads, handoffView, isaApp, iso, panel, row } from './testing.js';
import { ackWhoWords } from './words.js';

const handoffCard = (over = {}) =>
  card({ itemType: 'ai_isa_handoff', band: 'pinned', dueAt: iso(900_000), subjectType: 'ai_isa_handoff', subjectId: ISA_IDS.handoff, reasons: [{ code: 'AI_ISA_HANDOFF:escalated', label: 'AI care handed back to you' }], primaryAction: { kind: 'open_contact', label: 'Open', contactId: IDS.jane }, ...over });

function feedOf(cards: ReturnType<typeof card>[], o: { live?: boolean; handoff?: ReturnType<typeof handoffView>; hold?: string } = {}) {
  return contactReads(new FakeFetch())
    .on('GET /feed', { status: 200, body: feed(cards.filter((c) => c.band === 'pinned'), cards.filter((c) => c.band !== 'pinned')) })
    .on('GET /ai-isa/assignments?scope=all&state=live', { status: 200, body: { rows: o.live ? [row()] : [], holdSentence: o.hold ?? null } })
    .on(`GET /ai-isa/handoffs/${ISA_IDS.handoff}`, { status: 200, body: o.handoff ?? handoffView() })
    .on(`GET /contacts/${IDS.jane}/ai-isa`, { status: 200, body: panel() });
}

describe('AI care feed cards (module 76)', () => {
  it('R-ISA-14 E521: a handoff card shows why, their quoted words, the line the AI wrote, what is unanswered, the next steps and the deadline; never "Review"', async () => {
    isaApp(feedOf([handoffCard()]), '/', 'agent');
    const c = await screen.findByTestId('ai-card-ai_isa_handoff');
    expect(within(c).getByText('AI care handed back')).toBeInTheDocument();
    expect(await within(c).findByText('They asked to talk to a person.')).toBeInTheDocument();
    expect(within(c).getByText(/we have cash ready/).closest('li')!.textContent).toMatch(/financing status: cash \(as stated by the client\) · “we have cash ready”/);
    expect(within(c).getByText(/“I've let Ava know you'd like to talk\.”/)).toBeInTheDocument();
    expect(within(c).getByText('1 message from them has no answer.')).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Call them' })).toBeInTheDocument();
    expect(within(c).getByText(/A message was already on its way when care stopped/)).toBeInTheDocument();
    expect(within(c).getByText(/^Respond by /)).toBeInTheDocument();
    expect(within(c).getByRole('timer')).toHaveAccessibleName(/Handoff for Jane Doe/);
    expect(within(c).getByText("Got it doesn't meet the deadline: a call, text or email to Jane from you or a collaborator does.")).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Review' })).toBeNull();
    expect(c.textContent).not.toMatch(/\b[A-Z]{2,}_[A-Z_]+\b|confidence|score/);
  });

  it('R-ISA-14 E533 R-ISA-30 (b13 review B13S-3 / F4-ui): a confirmation that did not go out to a person D1 leaves no channel says keep or cancel, never "confirm by hand"; one a person made unnecessary says so', async () => {
    const pkg = { ...handoffView().package, reason: 'appointment_booked', commitments: ['booked_confirmation'], nextSteps: ['confirm_appointment'], notes: ['CONFIRMATION_NOT_SENT'] };
    const blocked = { id: ISA_IDS.pending, kind: 'confirmation' as const, channel: 'sms', status: 'blocked', scheduledFor: null };
    const v = isaApp(feedOf([handoffCard()], { handoff: handoffView({ reason: 'appointment_booked', slaClass: 'none', confirmationStatus: 'refused', confirmationNotSent: 'unreachable', pendingMessage: blocked, package: pkg }) }), '/', 'agent');
    let c = await screen.findByTestId('ai-card-ai_isa_handoff');
    expect(await within(c).findByRole('button', { name: 'Keep or cancel the appointment' })).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Confirm the appointment' })).toBeNull();
    expect(c.textContent).not.toMatch(/confirm by hand|confirm it by hand/i);
    v.view.unmount();
    cleanup();
    isaApp(feedOf([handoffCard()], { handoff: handoffView({ reason: 'appointment_booked', confirmationStatus: 'refused', confirmationNotSent: 'not_needed', pendingMessage: blocked, package: { ...pkg, notes: [] } }) }), '/', 'agent');
    c = await screen.findByTestId('ai-card-ai_isa_handoff');
    await within(c).findByText('Why');
    expect(c.textContent).not.toMatch(/confirm by hand|confirm it by hand/i);
  });

  it('R-ISA-30: Got it opens "Seen at … The deadline still runs." with the pending message line and no Cancel (Q3)', async () => {
    const pending = { id: ISA_IDS.pending, kind: 'confirmation' as const, channel: 'sms', status: 'scheduled', scheduledFor: iso(1_800_000) };
    const fake = feedOf([handoffCard()], { handoff: handoffView({ pendingMessage: pending }) }).on(`POST /ai-isa/handoffs/${ISA_IDS.handoff}/ack`, { status: 200, body: { handoffId: ISA_IDS.handoff, acknowledgedAt: new Date().toISOString(), slaMet: false, confirmationStatus: 'queued', closedReason: null } });
    isaApp(fake, '/', 'agent');
    const c = await screen.findByTestId('ai-card-ai_isa_handoff');
    await userEvent.setup().click(await within(c).findByRole('button', { name: 'Got it' }));
    const sheet = await screen.findByRole('dialog', { name: 'Handoff seen' });
    expect(within(sheet).getByText(/^Seen at .*\. The deadline still runs\.$/)).toBeInTheDocument();
    expect(within(sheet).getByText(/An AI confirmation is scheduled for .*before then stops it\./)).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /Cancel/ })).toBeNull();
    expect(fake.callsTo(`POST /ai-isa/handoffs/${ISA_IDS.handoff}/ack`)[0]!.body).toEqual({});
  });

  it("E521 V8: without canAcknowledge there is no Got it, and the line names who can; the deadline names the owner, never \"you\"", async () => {
    isaApp(feedOf([handoffCard()], { handoff: handoffView({ canAcknowledge: false, recipientUserId: null }) }), '/', 'team_lead', { userId: ISA_IDS.tl });
    const c = await screen.findByTestId('ai-card-ai_isa_handoff');
    // b14 to-do: the lead's current owner may mark it seen too (0081 isa_update), so they are named
    expect(await within(c).findByText('Only Ava or Owner/Admin can mark this seen.')).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Got it' })).toBeNull();
    expect(within(c).getByText(/from Ava or a collaborator does\./)).toBeInTheDocument();
  });

  it('R-ISA-30 (b14 to-do, b13 review F3 wording remainder): after an owner change the line names the lead\'s current owner, never the former recipient who no longer sees the lead', async () => {
    isaApp(feedOf([handoffCard()], { handoff: handoffView({ canAcknowledge: false, recipientUserId: ISA_IDS.other }) }), '/', 'team_lead', { userId: ISA_IDS.tl });
    const c = await screen.findByTestId('ai-card-ai_isa_handoff');
    expect(await within(c).findByText('Only Ava or Owner/Admin can mark this seen.')).toBeInTheDocument();
    expect(c.textContent).not.toMatch(/Only someone else on the team/);
  });

  it('R-ISA-30 (b14 to-do): a second team lead reads both the person who took over and the lead\'s owner', () => {
    expect(ackWhoWords({ holder: 'the person who took over', ownerUserId: IDS.me, viewerUserId: ISA_IDS.other, ownerFirst: 'Ava' })).toBe('Only the person who took over, Ava or Owner/Admin can mark this seen.');
    expect(ackWhoWords({ holder: null, ownerUserId: null, viewerUserId: ISA_IDS.tl, ownerFirst: 'their agent' })).toBe('Only Owner/Admin can mark this seen.');
  });

  it('R-ISA-30 ISA-2b Q1 (batch 13 isa-4 F4): after a team lead took over, the owner without Got it reads who can mark it seen, never "Only Owner/Admin" alone', async () => {
    isaApp(feedOf([handoffCard()], { handoff: handoffView({ reason: 'taken_over', canAcknowledge: false, recipientUserId: ISA_IDS.tl }) }), '/', 'agent');
    const c = await screen.findByTestId('ai-card-ai_isa_handoff');
    expect(await within(c).findByText('Only the person who took over or Owner/Admin can mark this seen.')).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Got it' })).toBeNull();
  });

  it('R-ISA-30 (batch 13 isa-4 F4): a team lead reads that the owner or Owner/Admin can mark the owner\'s handoff seen', async () => {
    isaApp(feedOf([handoffCard()], { handoff: handoffView({ canAcknowledge: false, recipientUserId: IDS.me }) }), '/', 'team_lead', { userId: ISA_IDS.tl });
    const c = await screen.findByTestId('ai-card-ai_isa_handoff');
    expect(await within(c).findByText('Only Ava or Owner/Admin can mark this seen.')).toBeInTheDocument();
  });

  it('R-ISA-30 E521 (batch 13 merge, 0081): a handoff with no deadline says why and never "Respond by" or "Overdue"; a closed one says why it is closed', async () => {
    isaApp(feedOf([handoffCard()], { handoff: handoffView({ slaClass: 'none', slaDueAt: iso(-60_000) }) }), '/', 'agent');
    let c = await screen.findByTestId('ai-card-ai_isa_handoff');
    expect(await within(c).findByText('No deadline: no call, text or email from the team can reach Jane now, or the lead is closed.')).toBeInTheDocument();
    expect(c.textContent).not.toMatch(/Respond by|Overdue|deadline still runs|doesn't meet the deadline/);
    expect(within(c).queryByRole('timer')).toBeNull();
    cleanup();
    // Got it closes a no-deadline handoff (the ack route's close): the sheet never says a deadline still runs
    const fake = feedOf([handoffCard()], { handoff: handoffView({ slaClass: 'none', slaDueAt: iso(-60_000) }) })
      .on(`POST /ai-isa/handoffs/${ISA_IDS.handoff}/ack`, { status: 200, body: { handoffId: ISA_IDS.handoff, acknowledgedAt: new Date().toISOString(), slaMet: false, confirmationStatus: 'none', confirmationNotSent: null, closedReason: 'acknowledged' } });
    isaApp(fake, '/', 'agent');
    c = await screen.findByTestId('ai-card-ai_isa_handoff');
    await userEvent.setup().click(await within(c).findByRole('button', { name: 'Got it' }));
    const sheet = await screen.findByRole('dialog', { name: 'Handoff seen' });
    expect(within(sheet).getByText(/^Seen at .*\. Closed: it was acknowledged, and it had no deadline\.$/)).toBeInTheDocument();
    expect(sheet.textContent).not.toMatch(/deadline still runs/);
    cleanup();
    isaApp(feedOf([handoffCard()], { handoff: handoffView({ slaDueAt: iso(-60_000), closedReason: 'lead_closed' }) }), '/', 'agent');
    c = await screen.findByTestId('ai-card-ai_isa_handoff');
    expect(await within(c).findByText('Closed: the lead was closed.')).toBeInTheDocument();
    expect(c.textContent).not.toMatch(/Respond by|Overdue/);
  });

  it('R-ISA-14 (batch 13 isa-4 F5): ISA-2b\'s approve_saved_search step opens the person\'s searches for review', async () => {
    const h = handoffView();
    const v = isaApp(feedOf([handoffCard()], { handoff: { ...h, package: { ...h.package, nextSteps: ['approve_saved_search'] } } }), '/', 'agent');
    const c = await screen.findByTestId('ai-card-ai_isa_handoff');
    await userEvent.setup().click(await within(c).findByRole('button', { name: 'Approve the saved search' }));
    await waitFor(() => expect(v.router.state.location.pathname).toBe(`/contacts/${IDS.jane}`));
    expect(v.router.state.location.search).toBe('?review=searches');
    expect(v.router.state.location.hash).toBe('#searches');
  });

  it('R-ISA-22 (batch 13 isa-4 F5): an unknown next step reads "Another check" and never "not available yet"; Prepare a CMA is not available yet', async () => {
    const h = handoffView();
    isaApp(feedOf([handoffCard()], { handoff: { ...h, package: { ...h.package, nextSteps: ['prepare_cma', 'brand_new_step'] } } }), '/', 'agent');
    const c = await screen.findByTestId('ai-card-ai_isa_handoff');
    expect(await within(c).findByText('Prepare a CMA: not available yet.')).toBeInTheDocument();
    expect(within(c).getByText('Another check')).toBeInTheDocument();
    expect(c.textContent).not.toMatch(/Another check: not available yet/);
  });

  it('R-ISA-14 (batch 13 isa-4 F6): ISA-2b\'s package fields render: the appointment\'s time, kind, organizer and their words, the saved search with its review link, who got it and the pond date', async () => {
    const h = handoffView({ reason: 'appointment_booked' });
    const startsAt = iso(2 * 86_400_000);
    const pkg = {
      ...h.package,
      reason: 'appointment_booked',
      escalation: null,
      appointment: { appointmentId: ISA_IDS.optin, kind: 'buyer_consult', confirmationQueued: true },
      appointmentDetail: { appointmentId: ISA_IDS.optin, kind: 'buyer_consult', startsAt, endsAt: iso(2 * 86_400_000 + 1_800_000), organizerUserId: IDS.me, offerId: ISA_IDS.other, acceptedMessageId: IDS.message, acceptedQuote: 'Tuesday at 3 works', linkId: null, calendarReadAt: iso(-60_000), calendarSentence: 'Your calendar showed this time free at 2026-11-13T10:00:00.000Z', zones: ['America/New_York'], minNoticeHours: 2 },
      savedSearch: { id: ISA_IDS.turn, status: 'proposed' },
      recipientUserId: IDS.me,
      endedByUserId: null,
      inactivityReleaseAt: iso(10 * 86_400_000),
    };
    isaApp(feedOf([handoffCard()], { handoff: { ...h, package: pkg } }), '/', 'agent');
    const c = await screen.findByTestId('ai-card-ai_isa_handoff');
    expect(await within(c).findByText(/^A buyer consultation on .+ with you\.$/)).toBeInTheDocument();
    expect(within(c).getByText(/^Their words: “Tuesday at 3 works”/)).toBeInTheDocument();
    expect(within(c).getByText('The AI assistant suggested a saved search; it was waiting for approval when AI care ended.')).toBeInTheDocument();
    expect(within(c).getByRole('link', { name: 'Review the saved search' })).toHaveAttribute('href', `/contacts/${IDS.jane}?review=searches#searches`);
    expect(within(c).getByText('You got this handoff.')).toBeInTheDocument();
    expect(within(c).getByText(/^When AI care ended, they were set to return to the pond on .+ unless you reach them\. AI messages don't reset this\.$/)).toBeInTheDocument();
    // the API's own sentence in the second person and its UTC instant never show
    expect(c.textContent).not.toMatch(/Your calendar showed|\d{4}-\d{2}-\d{2}T/);
  });

  it('R-ISA-14 (batch 13 isa-4 F6): who ended care renders when the package says, for a team lead reading the owner\'s handoff', async () => {
    const h = handoffView({ reason: 'ended_by_user', recipientUserId: IDS.me, canAcknowledge: false });
    const pkg = { ...h.package, reason: 'ended_by_user', escalation: null, recipientUserId: IDS.me, endedByUserId: ISA_IDS.other, savedSearch: null, appointmentDetail: null, inactivityReleaseAt: null };
    isaApp(feedOf([handoffCard()], { handoff: { ...h, package: pkg } }), '/', 'team_lead', { userId: ISA_IDS.tl });
    const c = await screen.findByTestId('ai-card-ai_isa_handoff');
    expect(await within(c).findByText('Ava got this handoff.')).toBeInTheDocument();
    expect(within(c).getByText('Someone else on the team ended AI care.')).toBeInTheDocument();
    expect(c.textContent).not.toMatch(/return to the pond|saved search/);
  });

  it('R-ISA-22 R-AST-13 (batch 13 isa-4 F10): stray score or confidence keys in a handoff package never render', async () => {
    const h = handoffView();
    const pkg = { ...h.package, confidence: 0.91, score: 77, claims: h.package.claims!.map((c) => ({ ...c, confidence: 0.66 })) };
    isaApp(feedOf([handoffCard()], { handoff: { ...h, package: pkg } }), '/', 'agent');
    const c = await screen.findByTestId('ai-card-ai_isa_handoff');
    expect(await within(c).findByText('They asked to talk to a person.')).toBeInTheDocument();
    expect(c.textContent).not.toMatch(/confidence|\bscore\b|0\.91|0\.66|\b77\b|%/i);
  });

  it('V9 Q10: a met deadline reads "Done: Jane was reached at …" and the card stays', async () => {
    isaApp(feedOf([handoffCard()], { handoff: handoffView({ slaMetAt: iso(-60_000) }) }), '/', 'agent');
    const c = await screen.findByTestId('ai-card-ai_isa_handoff');
    expect(await within(c).findByText(/^Done: Jane was reached at /)).toBeInTheDocument();
  });

  it('R-ISA-23: a hold-topic escalation says the AI stays off the topic; resolve continues the conversation, never the topic', async () => {
    const esc = card({ itemType: 'ai_isa_escalation', band: 'pinned', subjectType: 'ai_isa_assignment', subjectId: ISA_IDS.assignment, reasons: [{ code: 'AI_ISA_HOLD_TOPIC:pricing_negotiation', label: 'x' }], primaryAction: { kind: 'open_contact', label: 'Open', contactId: IDS.jane } });
    const fake = feedOf([esc], { live: true }).on(`POST /ai-isa/escalations/${ISA_IDS.assignment}/resolve`, { status: 200, body: { assignmentId: ISA_IDS.assignment, cleared: 'pricing_negotiation' } });
    isaApp(fake, '/', 'agent');
    const c = await screen.findByTestId('ai-card-ai_isa_escalation');
    expect(await within(c).findByText('Waiting on you: price or value. The AI assistant is staying off this topic.')).toBeInTheDocument();
    await userEvent.setup().click(within(c).getByRole('button', { name: "I've handled it; the AI may continue" }));
    expect(await within(c).findByText('Marked handled. The AI assistant may continue the conversation, and still stays off this topic.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /ai-isa/escalations/${ISA_IDS.assignment}/resolve`)[0]!.body).toEqual({ class: 'pricing_negotiation' });
  });

  it('E521 (batch 13 isa-4 F1): a booked-after-end card says care ended and an appointment was booked, with the time and where to confirm or cancel it; never "AI care is paused"', async () => {
    const label = 'Booked Tue Nov 17, 3:00–3:30 PM ET after AI care ended; the confirmation was not sent: confirm or cancel it yourself.';
    const esc = card({ itemType: 'ai_isa_escalation', band: 'pinned', subjectType: 'ai_isa_assignment', subjectId: ISA_IDS.assignment, reasons: [{ code: 'AI_ISA_BOOKED_AFTER_END', label }], primaryAction: { kind: 'open_contact', label: 'Open', contactId: IDS.jane } });
    isaApp(feedOf([esc]).on(`GET /contacts/${IDS.jane}/ai-isa`, { status: 200, body: panel({ state: 'ended' }) }), '/', 'agent');
    const c = await screen.findByTestId('ai-card-ai_isa_escalation');
    expect(await within(c).findByText('An appointment was booked for Tue Nov 17, 3:00–3:30 PM ET after AI care ended. The confirmation was not sent: confirm or cancel it yourself.')).toBeInTheDocument();
    expect(within(c).getByRole('link', { name: 'Confirm or cancel it in Tasks' })).toHaveAttribute('href', '/tasks');
    expect(c.textContent).not.toMatch(/AI care is paused|something to check|Check this/);
    expect(c.textContent).not.toMatch(/\b[A-Z]{2,}_[A-Z_]+\b/);
  });

  it('E521 (b14 to-do, b13 review low): a booked-after-end card whose person no text, call or email can reach says keep or cancel, never "confirm it yourself"', async () => {
    const label = 'Booked Tue Nov 17, 3:00–3:30 PM ET after AI care ended; the confirmation was not sent, and no text, call or email can reach them now (they opted out): keep or cancel the appointment.';
    const esc = card({ itemType: 'ai_isa_escalation', band: 'pinned', subjectType: 'ai_isa_assignment', subjectId: ISA_IDS.assignment, reasons: [{ code: 'AI_ISA_BOOKED_AFTER_END', label }, { code: 'AI_ISA_CONFIRMATION_NOT_SENT_UNREACHABLE', label: 'No text, call or email can reach them now, so it cannot be confirmed by hand.' }], primaryAction: { kind: 'open_contact', label: 'Open', contactId: IDS.jane } });
    isaApp(feedOf([esc]).on(`GET /contacts/${IDS.jane}/ai-isa`, { status: 200, body: panel({ state: 'ended' }) }), '/', 'agent');
    const c = await screen.findByTestId('ai-card-ai_isa_escalation');
    expect(await within(c).findByText('An appointment was booked for Tue Nov 17, 3:00–3:30 PM ET after AI care ended. The confirmation was not sent, and no text, call or email can reach them now, so it cannot be confirmed by hand: keep or cancel the appointment.')).toBeInTheDocument();
    expect(within(c).getByRole('link', { name: 'Keep or cancel it in Tasks' })).toHaveAttribute('href', '/tasks');
    expect(c.textContent).not.toMatch(/confirm or cancel it yourself|Confirm or cancel it in Tasks/);
  });

  it('E521 (batch 13 isa-4 F1): a booked-not-handed-back card says an appointment was booked and the state care is in now, never that care ended', async () => {
    const label = 'Booked Tue Nov 17, 3:00–3:30 PM ET after AI care ended; the confirmation was not sent: confirm or cancel it yourself.';
    const esc = card({ itemType: 'ai_isa_escalation', band: 'pinned', subjectType: 'ai_isa_assignment', subjectId: ISA_IDS.assignment, reasons: [{ code: 'AI_ISA_BOOKED_NOT_HANDED_BACK', label }], primaryAction: { kind: 'open_contact', label: 'Open', contactId: IDS.jane } });
    isaApp(feedOf([esc]).on(`GET /contacts/${IDS.jane}/ai-isa`, { status: 200, body: panel({ state: 'paused', pauseReason: 'check_this' } as never) }), '/', 'agent');
    const c = await screen.findByTestId('ai-card-ai_isa_escalation');
    expect(await within(c).findByText('An appointment was booked for Tue Nov 17, 3:00–3:30 PM ET. The confirmation was not sent: confirm or cancel it yourself.')).toBeInTheDocument();
    expect(await within(c).findByText('AI care is paused, so nobody is following up automatically.')).toBeInTheDocument();
    expect(within(c).getByRole('link', { name: 'Confirm or cancel it in Tasks' })).toHaveAttribute('href', '/tasks');
    expect(c.textContent).not.toMatch(/after AI care ended|something to check|Check this/);
  });

  it('R-ISA-22 (batch 13 isa-4 F1): an unknown escalation code reads "Another check." with no claim that care is paused', async () => {
    const esc = card({ itemType: 'ai_isa_escalation', band: 'pinned', subjectType: 'ai_isa_assignment', subjectId: ISA_IDS.assignment, reasons: [{ code: 'AI_ISA_BRAND_NEW', label: 'x' }], primaryAction: { kind: 'open_contact', label: 'Open', contactId: IDS.jane } });
    isaApp(feedOf([esc]), '/', 'agent');
    const c = await screen.findByTestId('ai-card-ai_isa_escalation');
    expect(await within(c).findByText('Another check.')).toBeInTheDocument();
    expect(c.textContent).not.toMatch(/AI care is paused|something to check/);
  });

  it('R-ISA-3: the activity card says what happens to their reply only while care is live', async () => {
    const act = card({ itemType: 'ai_isa_activity', subjectType: 'ai_isa_assignment', subjectId: ISA_IDS.assignment, reasons: [{ code: 'AI_ISA_ACTIVITY', label: 'x' }], primaryAction: { kind: 'open_contact', label: 'Open', contactId: IDS.jane } });
    const v = isaApp(feedOf([act], { live: true }), '/', 'agent');
    expect(await screen.findByText("They replied. The AI assistant takes this turn, or hands it to you if it can't.")).toBeInTheDocument();
    v.view.unmount();
    isaApp(feedOf([act], { live: false }), '/', 'agent');
    expect(await screen.findByText("They replied while AI care was on. AI care isn't live now; open the person to see why.")).toBeInTheDocument();
  });

  it('E517 (batch 13 isa-4 F2): under a hold every AI card and the live strip carry the banner, and the activity card never says the AI takes the turn', async () => {
    const hold = 'AI assistant sending is off on this deployment.';
    const banner = 'AI assistant sending is off on this deployment. Nothing reaches Jane from this deployment.';
    const act = card({ itemType: 'ai_isa_activity', subjectType: 'ai_isa_assignment', subjectId: ISA_IDS.assignment, reasons: [{ code: 'AI_ISA_ACTIVITY', label: 'x' }], primaryAction: { kind: 'open_contact', label: 'Open', contactId: IDS.jane } });
    const other = card({ primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane } });
    isaApp(feedOf([act, other, handoffCard()], { live: true, hold }), '/', 'agent');
    const a = await screen.findByTestId('ai-card-ai_isa_activity');
    expect(await within(a).findByText(banner)).toBeInTheDocument();
    expect(within(a).getByText("They replied. Nothing the AI assistant writes reaches Jane from this deployment; if it can't answer, it hands the reply to you.")).toBeInTheDocument();
    expect(a.textContent).not.toMatch(/takes this turn/);
    const strip = await screen.findByTestId('ai-feed-strip');
    expect(within(strip).getByText(banner)).toBeInTheDocument();
    const h = await screen.findByTestId('ai-card-ai_isa_handoff');
    expect(within(h).getByText(banner)).toBeInTheDocument();
    // no panel link holds here: the replies clause is not added
    expect(document.body.textContent).not.toMatch(/Their replies (?:come|go) to/);
  });

  it('E517 (batch 13 isa-4 F2): an escalation card under a panel link hold adds the replies clause', async () => {
    const esc = card({ itemType: 'ai_isa_escalation', band: 'pinned', subjectType: 'ai_isa_assignment', subjectId: ISA_IDS.assignment, reasons: [{ code: 'AI_ISA_HOLD_TOPIC:pricing_negotiation', label: 'x' }], primaryAction: { kind: 'open_contact', label: 'Open', contactId: IDS.jane } });
    const chain = panel().chain.map((l) => (l.link === 1 ? { ...l, effect: 'hold' as const, code: 'AI_ISA_LIVE_OFF', sentence: 'x' } : l));
    isaApp(feedOf([esc], { live: true }).on(`GET /contacts/${IDS.jane}/ai-isa`, { status: 200, body: panel({ chain }) }), '/', 'agent');
    const c = await screen.findByTestId('ai-card-ai_isa_escalation');
    expect(await within(c).findByText('AI assistant sending is off on this deployment. Nothing reaches Jane from this deployment. Their replies come to you as usual.')).toBeInTheDocument();
  });

  it('R-ISA-15: another card of a contact under live care gets the strip "AI care is on" with Pause and Take over; Call says it pauses', async () => {
    const other = card({ primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane } });
    isaApp(feedOf([other], { live: true }), '/', 'agent');
    const strip = await screen.findByTestId('ai-feed-strip');
    expect(within(strip).getByText('AI care is on')).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: 'Take over' })).toBeInTheDocument();
    expect(await screen.findByText('Calling pauses AI care for Jane.')).toBeInTheDocument();
  });
});

describe('compose, approvals and the inbox (module 76)', () => {
  it('R-ISA-3: the compose box says sending pauses AI care, and who can resume it', async () => {
    const fake = feedOf([], { live: true }).on(`GET /contacts/${IDS.jane}/ai-isa/turns`, { status: 200, body: { turns: [] } });
    isaApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`, 'team_lead', { userId: ISA_IDS.tl });
    expect(await screen.findByText('Sending or scheduling this pauses AI care for Jane now. Ava can resume it.')).toBeInTheDocument();
  });

  it('V1: approvals, the person page and the thread prefill never list ai_isa_message or ai_isa_handoff actions', async () => {
    const items = [draftAction({ id: ISA_IDS.pending, kind: 'ai_isa_message', explanation: 'AI ISA draft' }), draftAction({ id: ISA_IDS.optin, kind: 'ai_isa_handoff', explanation: 'AI care handed back' }), draftAction()];
    const fake = feedOf([]).on('GET /assistant/inbox', { status: 200, body: { items } });
    const v = isaApp(fake, '/approvals', 'agent');
    await waitFor(() => expect(screen.getAllByRole('article').length).toBe(1));
    expect(screen.queryByText('AI ISA draft')).toBeNull();
    expect(screen.queryByText('AI care handed back')).toBeNull();
    v.view.unmount();
    isaApp(fake, `/contacts/${IDS.jane}`, 'agent');
    await screen.findAllByText('Jane Doe');
    await waitFor(() => expect(fake.callsTo('GET /assistant/inbox').length).toBeGreaterThan(1));
    expect(screen.queryByText('AI ISA draft')).toBeNull();
  });

  it('R-ISA-3 V1: a handback in my inbox offers "Let the AI assistant continue", which opens Start and posts fromHandbackId', async () => {
    const hb = draftAction({ id: IDS.handback, kind: 'handback', primaryAction: 'acknowledge', draft: null, explanation: 'They replied' });
    const fake = feedOf([])
      .on('GET /assistant/inbox', { status: 200, body: { items: [hb] } })
      .on(`GET /contacts/${IDS.jane}/ai-isa`, { status: 200, body: panel({ state: 'none', canStart: true }) })
      .on('GET /me/ai-isa', { status: 404, body: { error: { code: 'NOT_FOUND', requestId: 'r' } } })
      .on(`POST /contacts/${IDS.jane}/ai-isa/start`, { status: 409, body: { error: { code: 'AI_ISA_HANDBACK_STALE', requestId: 'r' } } });
    isaApp(fake, '/approvals', 'agent');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Let the AI assistant continue' }));
    const sheet = await screen.findByRole('dialog', { name: 'Start AI care' });
    await u.click((await within(sheet).findAllByRole('button', { name: /^Start as/ }))[0]!);
    expect(await within(sheet).findByText('They wrote again or a reply was already queued. Open the thread instead.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/ai-isa/start`)[0]!.body).toEqual({ side: 'buyer', fromHandbackId: IDS.handback });
  });

  // b14 review F1 (staff-ui): a voice handback stores no inbound message (voice/handback.ts), so the server refuses a
  // start from it (AI_ISA_HANDBACK_STALE, worded "They wrote again …", false for a call): no offer on a voice card
  const voiceClaim = (outcome: string) => ({
    id: '01900000-0000-7000-8000-0000000055d2',
    kind: 'fact',
    text: 'The call ended.',
    needsReview: false,
    reviewStatus: 'unreviewed',
    due: null,
    evidence: [{ sourceType: 'call', sourceId: '01900000-0000-7000-8000-0000000055c1', locator: { kind: 'field', field: 'voice_outcome' }, snippet: outcome, verified: true, sourceAvailable: true, label: 'x' }],
  });
  const voiceHandback = (outcome: string) => draftAction({ id: IDS.handback, kind: 'handback', primaryAction: 'acknowledge', draft: null, explanation: 'The assistant answered a missed call.', claims: [voiceClaim(outcome)] as never });

  for (const outcome of ['opted_out', 'message_taken']) {
    it(`b14 review F1: a ${outcome} voice handback I own with no live AI care offers no "Let the AI assistant continue"`, async () => {
      const fake = feedOf([])
        .on('GET /assistant/inbox', { status: 200, body: { items: [voiceHandback(outcome), draftAction({ id: ISA_IDS.optin, kind: 'handback', primaryAction: 'acknowledge', draft: null, explanation: 'They replied' })] } })
        .on(`GET /contacts/${IDS.jane}/ai-isa`, { status: 200, body: panel({ state: 'none', canStart: true }) })
        .on('GET /me/ai-isa', { status: 404, body: { error: { code: 'NOT_FOUND', requestId: 'r' } } });
      isaApp(fake, '/approvals', 'agent');
      const voice = (await screen.findByText(/The assistant answered a call/)).closest('article') as HTMLElement;
      const other = (await screen.findByText('They replied')).closest('article') as HTMLElement;
      // the ordinary handback of the same person still offers it, so the contact and the live rows have loaded
      expect(await within(other).findByRole('button', { name: 'Let the AI assistant continue' })).toBeInTheDocument();
      expect(within(voice).getByRole('button', { name: 'Mark handled' })).toBeInTheDocument();
      expect(within(voice).queryByRole('button', { name: 'Let the AI assistant continue' })).toBeNull();
    });
  }

  it('b14 review F1: an opted-out voice handback has no Send, so it never says "Sending pauses AI care", even while care is live', async () => {
    const fake = feedOf([], { live: true })
      .on('GET /assistant/inbox', { status: 200, body: { items: [voiceHandback('opted_out'), draftAction({ id: ISA_IDS.optin, kind: 'handback', primaryAction: 'acknowledge', draft: null, explanation: 'They replied' })] } })
      .on('GET /me/ai-isa', { status: 404, body: { error: { code: 'NOT_FOUND', requestId: 'r' } } });
    isaApp(fake, '/approvals', 'agent');
    const voice = (await screen.findByText(/The assistant answered a call/)).closest('article') as HTMLElement;
    const other = (await screen.findByText('They replied')).closest('article') as HTMLElement;
    // the ordinary handback in the same inbox shows the note, so the live row has loaded
    expect(await within(other).findByTestId('ai-action-note')).toHaveTextContent('Sending pauses AI care for Jane.');
    expect(within(voice).getByText('The caller asked not to be contacted, so there is no reply or call back from here.')).toBeInTheDocument();
    expect(within(voice).queryByTestId('ai-action-note')).toBeNull();
  });
});
