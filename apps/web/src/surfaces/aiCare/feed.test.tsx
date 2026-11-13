// AI care in the feed and around sends (R-ISA-14, R-ISA-30, R-ISA-3, R-ISA-15; E496, E521, E533; V1, V9, V13, V17).
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { card, draftAction, feed } from '../feed/lib/testing.js';
import { FakeFetch, IDS, ISA_IDS, contactReads, handoffView, isaApp, iso, panel, row } from './testing.js';

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
    expect(await within(c).findByText('Only Owner/Admin can mark this seen.')).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Got it' })).toBeNull();
    expect(within(c).getByText(/from Ava or a collaborator does\./)).toBeInTheDocument();
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
      .on(`POST /ai-isa/handoffs/${ISA_IDS.handoff}/ack`, { status: 200, body: { handoffId: ISA_IDS.handoff, acknowledgedAt: new Date().toISOString(), slaMet: false, confirmationStatus: 'none', closedReason: 'acknowledged' } });
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
});
