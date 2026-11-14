// The person page's AI care (R-ISA-22, R-ISA-15, R-ISA-16, R-ISA-29; E496, E513, E516, E517, E539): the strip, the
// panel section, Start, refusals, the hold banner and the Undo toast, as each reader sees them.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { err } from '../../shell/testing/fakeApi.js';
import type { PanelResponse } from './api.js';
import { FakeFetch, IDS, ISA_IDS, contactReads, fullContact, handoffView, isaApp, isaError, iso, meView, optIn, panel, row } from './testing.js';
import { localTime } from './time.js';
import { UNDO_MS, windowFromPanel, windowFromResponse } from './undoStore.js';

const CONTROL = { assignmentId: ISA_IDS.assignment, state: 'paused', epoch: 1, inFlight: [], canceled: 0, undoUntil: null, sentence: 'Paused: nobody is following up automatically.' };

function person(p: PanelResponse, o: { live?: boolean; hold?: string | null } = {}) {
  const fake = contactReads(new FakeFetch())
    .on(`GET /contacts/${IDS.jane}/ai-isa`, { status: 200, body: p })
    .on(`GET /contacts/${IDS.jane}/ai-isa/turns`, { status: 200, body: { turns: [] } })
    .on('GET /ai-isa/assignments?scope=all&state=live', { status: 200, body: { rows: o.live === false ? [] : [row()], holdSentence: o.hold ?? null } })
    .on('GET /me/ai-isa', { status: 200, body: meView({ optIn: optIn(), sentence: 'You are opted in.' }) });
  return fake;
}
const announced = () => screen.getByTestId('announcer').textContent ?? '';

describe('the AI care panel and strip (module 76)', () => {
  it('R-ISA-22: live care for the owner: the strip says so with Pause and Take over; the panel says what it may do and needs, in words', async () => {
    isaApp(person(panel()), `/contacts/${IDS.jane}`, 'agent');
    const strip = await screen.findByTestId('ai-strip');
    expect(within(strip).getByText('AI assistant is handling this conversation')).toBeInTheDocument();
    expect(within(strip).getByText('Calling or texting them yourself pauses AI care.')).toBeInTheDocument();
    expect(within(strip).getAllByRole('button', { name: 'Pause' }).length).toBeGreaterThan(0);
    expect(within(strip).getAllByRole('button', { name: 'Take over' }).length).toBeGreaterThan(0);
    expect(await screen.findByText('What it may do')).toBeInTheDocument();
    expect(screen.getByText('Talk with them by text and email: yes.')).toBeInTheDocument();
    // b13 review B13S-2: every capability this tree builds is said as allowed or not in the opt-in, never "not available yet"
    expect(screen.getByText('Share listings that fit their search: no. Not in your opt-in or the team policy.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/not available yet|not built/i);
    expect(screen.getByText('2 of 6 AI messages in the last 24 hours')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/on file\b.*consent|consent.*on file/i);
    expect(document.body.textContent).not.toMatch(/\b[A-Z]{2,}_[A-Z_]+\b/);
  });

  it('R-ISA-22 (b13 review F3-ui): on a phone with care live, the AI care bar stacks above the Note · Log bar (never over it), Note stays reachable, and each bar has its page-end spacer', async () => {
    const details = { contactId: IDS.jane, rowVersion: 1, doNotContact: false, stage: { stage: 'new', label: 'New', locked: [], lockedReason: null }, stageLabels: {}, addresses: [], collaborators: [], relationships: [], removedPoints: [], canEdit: true, canManageCollaborators: false };
    isaApp(person(panel()).on(`GET /contacts/${IDS.jane}/details`, { status: 200, body: { details } }), `/contacts/${IDS.jane}`, 'agent');
    const aiBar = await screen.findByTestId('ai-phone-bar');
    const note = await screen.findByRole('button', { name: 'Note' });
    const noteBar = note.closest('[data-sticky]')!;
    expect(noteBar).not.toBe(aiBar);
    // the Note · Log bar publishes its own height; the AI bar sits that far above the tab bar
    expect(noteBar.getAttribute('data-testid')).toBe('person-phone-bar');
    expect(aiBar.className).toContain('bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+var(--person-bar-h,0px))]');
    expect(noteBar.className).toContain('bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))]');
    expect(document.documentElement.style.getPropertyValue('--person-bar-h')).not.toBe('');
    expect(document.querySelectorAll('main [data-sticky-spacer]').length).toBe(2);
    await userEvent.setup().click(note);
    expect(await screen.findByRole('dialog', { name: 'Note on Jane Doe' })).toBeInTheDocument();
  });

  it('R-ISA-30 E521 (batch 13 merge, 0081): the panel never gives a no-deadline handoff a "Respond by" or "Overdue", and says why a closed one is closed', async () => {
    const ended = (h: Partial<NonNullable<PanelResponse['handoff']>>) => panel({ state: 'ended', handoff: { id: ISA_IDS.handoff, reason: 'opted_out', slaClass: 'high', slaDueAt: new Date(Date.now() - 60_000).toISOString(), slaMetAt: null, overdue: false, confirmationStatus: 'none', confirmationNotSent: null, closedReason: null, ...h } });
    const v = isaApp(person(ended({ slaClass: 'none' }), { live: false }), `/contacts/${IDS.jane}`, 'agent');
    expect(await screen.findByText('No deadline: no call, text or email from the team can reach Jane now, or the lead is closed.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Respond by|Overdue/);
    v.view.unmount();
    isaApp(person(ended({ closedReason: 'care_continued' }), { live: false }), `/contacts/${IDS.jane}`, 'agent');
    expect(await screen.findByText('Closed: AI care was continued.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Respond by|Overdue/);
  });

  it('R-ISA-30 E521 (b12 recheck R13; b13 e2e a7): once a touch met the deadline the system closed the card, so the panel says Done with the time and the strip never sends the recipient to the feed', async () => {
    const metAt = iso(-120_000);
    const ended = panel({ state: 'ended', handoff: { id: ISA_IDS.handoff, reason: 'escalated', slaClass: 'critical', slaDueAt: iso(600_000), slaMetAt: metAt, overdue: false, confirmationStatus: 'none', confirmationNotSent: null, closedReason: 'deadline_met' } });
    const fake = person(ended, { live: false }).on(`GET /ai-isa/handoffs/${ISA_IDS.handoff}`, { status: 200, body: handoffView({ slaMetAt: metAt, closedReason: 'deadline_met', acknowledgedAt: iso(-300_000), acknowledgedByUserId: IDS.me }) });
    isaApp(fake, `/contacts/${IDS.jane}`, 'agent');
    const strip = await screen.findByTestId('ai-strip');
    expect(await within(strip).findByText('You got the handoff.')).toBeInTheDocument();
    expect(strip.textContent).not.toMatch(/in your feed/);
    expect(within(strip).queryByRole('link', { name: /handoff/ })).toBeNull();
    const care = screen.getByRole('region', { name: 'AI care' });
    expect(within(care).getByText(`Done: Jane was reached at ${localTime(metAt)}.`)).toBeInTheDocument();
    expect(care.textContent).not.toMatch(/Respond by|Overdue/);
  });

  it('R-ISA-30 E521: while the handoff is open its recipient is sent to the card in the feed', async () => {
    const open = panel({ state: 'ended', handoff: { id: ISA_IDS.handoff, reason: 'escalated', slaClass: 'critical', slaDueAt: iso(600_000), slaMetAt: null, overdue: false, confirmationStatus: 'none', confirmationNotSent: null, closedReason: null } });
    isaApp(person(open, { live: false }).on(`GET /ai-isa/handoffs/${ISA_IDS.handoff}`, { status: 200, body: handoffView() }), `/contacts/${IDS.jane}`, 'agent');
    const strip = await screen.findByTestId('ai-strip');
    expect(await within(strip).findByRole('link', { name: 'The handoff is in your feed.' })).toHaveAttribute('href', '/');
  });

  it('R-ISA-14 E533 R-ISA-30 (b13 review B13S-3 / F4-ui): the panel never asks for a hand confirmation D1 blocks, nor after a person reached them first', async () => {
    const ended = (h: Partial<NonNullable<PanelResponse['handoff']>>) => panel({ state: 'ended', handoff: { id: ISA_IDS.handoff, reason: 'appointment_booked', slaClass: 'none', slaDueAt: iso(0), slaMetAt: null, overdue: false, confirmationStatus: 'refused', confirmationNotSent: 'unreachable', closedReason: null, ...h } });
    const v = isaApp(person(ended({}), { live: false }), `/contacts/${IDS.jane}`, 'agent');
    expect(await screen.findByText('Confirmation not sent, and no text, call or email can reach them now, so it cannot be confirmed by hand: keep or cancel the appointment.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/confirm by hand\./);
    v.view.unmount();
    isaApp(person(ended({ slaClass: 'critical', slaMetAt: iso(-60_000), confirmationNotSent: 'not_needed' }), { live: false }), `/contacts/${IDS.jane}`, 'agent');
    expect(await screen.findByText('Confirmation not needed: someone on the team reached them first.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/confirm by hand/);
  });

  it('V3 E533 (b13 review F8-ui): under the AI_ISA_LIVE_SENDS hold the strip says AI messages are held; after care ended, a scheduled confirmation keeps the hold banner on the panel and says to confirm it yourself', async () => {
    const hold = 'AI assistant sending is off on this deployment.';
    const v = isaApp(person(panel(), { hold }), `/contacts/${IDS.jane}`, 'agent');
    const strip = await screen.findByTestId('ai-strip');
    expect(await within(strip).findByText(/^AI messages are held: nothing reaches Jane from this deployment\.$/)).toBeInTheDocument();
    v.view.unmount();
    const ended = panel({ state: 'ended', handoff: { id: ISA_IDS.handoff, reason: 'appointment_booked', slaClass: 'critical', slaDueAt: iso(3_600_000), slaMetAt: null, overdue: false, confirmationStatus: 'scheduled', confirmationNotSent: null, closedReason: null } });
    isaApp(person(ended, { live: false, hold }), `/contacts/${IDS.jane}`, 'agent');
    const s = await screen.findByRole('region', { name: 'Handoff' });
    expect(await screen.findByTestId('ai-hold')).toHaveTextContent(hold);
    expect(within(s).getByText('A confirmation would go out if sending were allowed. AI messages are held, so confirm it yourself.')).toBeInTheDocument();
    expect(s.textContent).not.toMatch(/A confirmation is scheduled\./);
  });

  it('V3 E533 (b14 to-do, b13 review F8-ui low): under the hold a pending holding line is said as a holding message to reach them yourself, never a confirmation to confirm; without the hold it is a holding message too', async () => {
    const hold = 'AI assistant sending is off on this deployment.';
    const ho = { id: ISA_IDS.handoff, reason: 'escalated', slaClass: 'high', slaDueAt: iso(3_600_000), slaMetAt: null, overdue: false, confirmationStatus: 'scheduled', confirmationNotSent: null, closedReason: null, pendingKind: 'holding_line' } as const;
    const v = isaApp(person(panel({ state: 'ended', handoff: ho }), { live: false, hold }), `/contacts/${IDS.jane}`, 'agent');
    let s = await screen.findByRole('region', { name: 'Handoff' });
    expect(within(s).getByText('A holding message would go out if sending were allowed. AI messages are held, so reach Jane yourself.')).toBeInTheDocument();
    expect(s.textContent).not.toMatch(/confirm|A confirmation/i);
    v.view.unmount();
    isaApp(person(panel({ state: 'ended', handoff: { ...ho, confirmationStatus: 'queued' } }), { live: false }), `/contacts/${IDS.jane}`, 'agent');
    s = await screen.findByRole('region', { name: 'Handoff' });
    expect(within(s).getByText('A holding message is queued.')).toBeInTheDocument();
    expect(s.textContent).not.toMatch(/A confirmation/);
  });

  it('R-ISA-30 E521 (batch 13 isa-4, b12 recheck R16 follow-up): after a restart with no touch, the panel shows the earlier handoff that is still open and overdue', async () => {
    const p = panel({ earlierHandoff: { id: ISA_IDS.handoff, reason: 'ended_by_user', slaClass: 'high', slaDueAt: new Date(Date.now() - 60_000).toISOString(), slaMetAt: null, overdue: true, confirmationStatus: 'none', confirmationNotSent: null, closedReason: null } });
    isaApp(person(p), `/contacts/${IDS.jane}`, 'agent');
    const s = await screen.findByRole('region', { name: 'An earlier handoff is still open' });
    expect(within(s).getByText('Someone on the team ended it.')).toBeInTheDocument();
    expect(within(s).getByText(/^Respond by .+ · Overdue\. A call, text or email to Jane from you or a collaborator meets it\.$/)).toBeInTheDocument();
  });

  it('E516 (batch 13 isa-4 F10): Continue AI care shows for the owner only; the owner\'s tap posts an empty body and says the result', async () => {
    const paused = panel({ state: 'paused' });
    paused.assignment!.pauseReason = 'reinquiry';
    const started = { assignmentId: ISA_IDS.assignment2, state: 'starting', epoch: 1, inFlight: [], canceled: 0, undoUntil: null, sentence: 'AI care continued as a new period.', stoppedEnrollment: false, supersededProposals: 0 };
    const fake = person(paused).on(`POST /contacts/${IDS.jane}/ai-isa/continue`, { status: 200, body: started });
    const v = isaApp(fake, `/contacts/${IDS.jane}`, 'agent');
    expect(await screen.findByText('Jane inquired again. AI care is paused so you can see the new inquiry.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Continue AI care' }));
    expect(await screen.findByText('AI care continued as a new period.', { selector: 'p' })).toBeInTheDocument();
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/ai-isa/continue`)[0]!.body).toEqual({});
    v.view.unmount();
    isaApp(person(paused), `/contacts/${IDS.jane}`, 'team_lead', { userId: ISA_IDS.tl });
    expect(await screen.findByText('Jane inquired again. AI care is paused so you can see the new inquiry.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue AI care' })).toBeNull();
  });

  it('E534 (b13 review B13S-2): a seller assignment says competing listings go with their asking prices and recent sales wait for counsel review, once; an allowed capability reads yes; booking and listings never read "not available yet"', async () => {
    const p = panel();
    p.assignment!.side = 'seller';
    p.capabilities = p.capabilities.map((c) => (['seller_competition', 'seller_sold_comps', 'book_appointments'].includes(c.capability) ? { ...c, allowed: true } : c));
    isaApp(person(p), `/contacts/${IDS.jane}`, 'agent');
    expect(await screen.findByText('Seller facts: competing listings go out with their asking prices only. Recent sales wait for counsel review of platform:cma and platform:ai_isa_seller_data, and for the MLS licence to allow the AI seller-data use.')).toBeInTheDocument();
    expect(screen.getByText('Share competing listings with sellers: yes.')).toBeInTheDocument();
    expect(screen.getByText('Share recent sales with sellers: allowed, but none go out until counsel review of platform:cma and platform:ai_isa_seller_data is recorded and the MLS licence allows it.')).toBeInTheDocument();
    expect(screen.getByText('Book appointments on your calendar: yes.')).toBeInTheDocument();
    expect(screen.getByText('None offered.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/not available yet|not built|Booking is not available/i);
  });

  it('E534 (b14 to-do, B13S-2 low): booking allowed while the calendar is not connected never reads "yes": it says no times are offered', async () => {
    const p = panel();
    p.capabilities = p.capabilities.map((c) => (c.capability === 'book_appointments' ? { ...c, allowed: true, calendarConnected: false } : c));
    isaApp(person(p), `/contacts/${IDS.jane}`, 'agent');
    expect(await screen.findByText('Book appointments on your calendar: allowed, but your calendar is not connected, so no times are offered.')).toBeInTheDocument();
    expect(screen.queryByText('Book appointments on your calendar: yes.')).toBeNull();
  });

  it('E496 (batch 13 isa-4 F10): Take over is offered while care is paused because someone on the team wrote (human_contact)', async () => {
    const p = panel({ state: 'paused' });
    p.assignment!.pauseReason = 'human_contact';
    isaApp(person(p), `/contacts/${IDS.jane}`, 'team_lead', { userId: ISA_IDS.tl });
    const strip = await screen.findByTestId('ai-strip');
    expect(within(strip).getByText(/Someone on the team texted, emailed or called them\./)).toBeInTheDocument();
    expect(within(strip).getAllByRole('button', { name: 'Take over' }).length).toBeGreaterThan(0);
    expect(within(strip).queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it('R-ISA-22 R-AST-13 (batch 13 isa-4 F10): stray score or confidence keys in the panel never render, and a consent sentence "on file" is never shown as "on file"', async () => {
    const p = { ...panel(), score: 0.93, confidence: 0.81, consent: [{ channel: 'sms' as const, sentence: 'Texts: written consent on file from their own form.', confidence: 0.7 }] };
    p.capabilities = p.capabilities.map((c) => ({ ...c, score: 12 }));
    isaApp(person(p as never), `/contacts/${IDS.jane}`, 'agent');
    expect(await screen.findByText('Texts: written consent recorded from their own form.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/on file|confidence|\bscore\b|0\.93|0\.81|93%|81%/i);
  });

  it('R-ISA-29 (batch 13 isa-4 F14): the times offered show their time beside the viewer\'s when their zone is explicit', async () => {
    const at = new Date(Date.now() + 2 * 86_400_000);
    at.setUTCHours(15, 0, 0, 0);
    const p = panel({ openOffer: { id: ISA_IDS.optin, status: 'open', slots: [{ startsAt: at.toISOString(), endsAt: new Date(at.getTime() + 1_800_000).toISOString() }], expiresAt: iso(86_400_000) } });
    isaApp(person(p), `/contacts/${IDS.jane}`, 'agent');
    const s = await screen.findByRole('region', { name: 'Times offered' });
    expect(within(s).getByText(/^.+ \(.+ CST, their time\)$/)).toBeInTheDocument();
  });

  it('R-ISA-22 V5: a team lead never reads "You opted in", "You own" or "Waiting on you"; the owner is named instead', async () => {
    const p = panel({ heldTopics: [{ class: 'pricing_negotiation', since: new Date().toISOString(), sentence: 'Waiting on Ava: pricing negotiation.' }] });
    isaApp(person(p), `/contacts/${IDS.jane}`, 'team_lead', { userId: ISA_IDS.tl });
    await screen.findByText('What it may do');
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/You opted in|You own|Waiting on you/);
    expect(screen.getByText(/Ava opted in\./)).toBeInTheDocument();
    expect(screen.getByText('Waiting on Ava')).toBeInTheDocument();
    expect(screen.getByText(/Ava owns this lead/)).toBeInTheDocument();
  });

  it('R-ISA-23: a held pricing topic never says the AI may discuss it after it is marked handled', async () => {
    const p = panel({ heldTopics: [{ class: 'pricing_negotiation', since: new Date().toISOString(), sentence: 'x' }] });
    isaApp(person(p), `/contacts/${IDS.jane}`, 'agent');
    expect(await screen.findByRole('button', { name: "I've handled it; the AI may continue" })).toBeInTheDocument();
    expect(screen.getByText(/never discusses price/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/may (?:then )?discuss (?:price|value)|until you mark it handled/);
  });

  it('R-ISA-16 V4: a team lead whose own opt-in is missing reads "Only Ava can start AI care for this lead"', async () => {
    const p = panel({ state: 'none', startRefusal: { code: 'AI_ISA_NO_OPTIN', sentence: 'Opt in first.' } });
    isaApp(person(p, { live: false }), `/contacts/${IDS.jane}`, 'team_lead', { userId: ISA_IDS.tl });
    expect(await screen.findByText('Only Ava can start AI care for this lead.')).toBeInTheDocument();
  });

  it('R-ISA-16 E516: the owner with the first touch pending gets the words and Call and Text', async () => {
    const p = panel({ state: 'none', startRefusal: { code: 'AI_ISA_FIRST_TOUCH_PENDING', sentence: 'x' } });
    isaApp(person(p, { live: false }), `/contacts/${IDS.jane}`, 'agent');
    const r = await screen.findByTestId('ai-refusal');
    expect(within(r).getByText("Text or call them yourself first. AI messages don't count as your first contact.")).toBeInTheDocument();
    expect(within(r).getByRole('button', { name: 'Call' })).toBeInTheDocument();
    expect(within(r).getByRole('button', { name: 'Text' })).toBeInTheDocument();
  });

  it('R-ISA-1: an uncleared pack is said to everyone, with the one fix for Owner/Admin', async () => {
    const p = panel({ state: 'none', startRefusal: { code: 'AI_ISA_NOT_CLEARED', sentence: 'x' } });
    isaApp(person(p, { live: false }), `/contacts/${IDS.jane}`, 'owner');
    expect(await screen.findByText(/Waiting on counsel review \(platform:ai_isa\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open AI assistant (ISA) settings' })).toBeInTheDocument();
  });

  it('R-ISA-16: Start is 2 taps: Start AI care, then the side; it names the opt-in and says what it withdrew', async () => {
    const fake = person(panel({ state: 'none', canStart: true }), { live: false }).on(`POST /contacts/${IDS.jane}/ai-isa/start`, {
      status: 200,
      body: { ...CONTROL, state: 'starting', sentence: 'AI care started.', stoppedEnrollment: true, supersededProposals: 2 },
    });
    isaApp(fake, `/contacts/${IDS.jane}`, 'agent');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Start AI care' }));
    const sheet = await screen.findByRole('dialog', { name: 'Start AI care' });
    expect(await within(sheet).findByText(/Jane gets texts and emails from your AI assistant under your opt-in of .*You stay responsible for this lead\./)).toBeInTheDocument();
    const sides = within(sheet).getAllByRole('button', { name: /^Start as/ });
    expect(sides.map((b) => b.textContent)).toEqual(['Start as a buyer', 'Start as a seller', 'Start as both']);
    await u.click(sides[0]!);
    expect(await within(sheet).findByText('AI care started. Withdrew 2 drafts and handbacks.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/ai-isa/start`)[0]!.body).toEqual({ side: 'buyer' });
  });

  it('R-ISA-16: a seller intent puts "Start as a seller" first; ALREADY_ACTIVE refetches the panel', async () => {
    const contact = fullContact({ intent: 'seller' });
    const fake = person(panel({ state: 'none', canStart: true }), { live: false }).on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact } }).on(`POST /contacts/${IDS.jane}/ai-isa/start`, isaError('AI_ISA_ALREADY_ACTIVE'));
    isaApp(fake, `/contacts/${IDS.jane}`, 'agent');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Start AI care' }));
    const sheet = await screen.findByRole('dialog', { name: 'Start AI care' });
    const first = (await within(sheet).findAllByRole('button', { name: /^Start as/ }))[0]!;
    expect(first.textContent).toBe('Start as a seller');
    const before = fake.callsTo(`GET /contacts/${IDS.jane}/ai-isa`).length;
    await u.click(first);
    expect(await within(sheet).findByText('AI care is already on for this person.')).toBeInTheDocument();
    await waitFor(() => expect(fake.callsTo(`GET /contacts/${IDS.jane}/ai-isa`).length).toBeGreaterThan(before));
  });

  it('R-ISA-1 E517 V3: the shared hold sentence puts the banner on the panel without the replies clause; a link hold adds it', async () => {
    isaApp(person(panel(), { hold: 'AI assistant sending is off on this deployment.' }), `/contacts/${IDS.jane}`, 'agent');
    const b = await screen.findByTestId('ai-hold');
    expect(b.textContent).toContain('AI assistant sending is off on this deployment. Nothing reaches Jane from this deployment.');
    expect(b.textContent).not.toMatch(/replies/);
    expect(document.body.textContent).not.toMatch(/answering/);
  });

  it('R-ISA-1 E517: a panel chain link that holds adds "Their replies come to you as usual."', async () => {
    const p = panel();
    p.chain = p.chain.map((l) => (l.link === 3 ? { ...l, effect: 'hold' as const, code: 'ISA_CAP_REACHED', sentence: 'cap' } : l));
    isaApp(person(p), `/contacts/${IDS.jane}`, 'agent');
    const b = await screen.findByTestId('ai-hold');
    expect(b.textContent).toMatch(/daily AI assistant limit is reached.*Nothing reaches Jane from this deployment\. Their replies come to you as usual\./);
  });

  it('R-ISA-31 V18 E498: an opted-out block says it cannot restart, and offers no Lift', async () => {
    const p = panel({ state: 'ended', block: { reason: 'opted_out', since: new Date().toISOString(), sentence: 'A restart needs…' }, startRefusal: { code: 'AI_ISA_PERSON_DECLINED', sentence: 'x' } });
    isaApp(person(p, { live: false }), `/contacts/${IDS.jane}`, 'agent');
    expect(await screen.findByText("They opted out. AI care can't restart for them.")).toBeInTheDocument();
    expect(screen.queryByText(/Lift/)).toBeNull();
    expect(screen.getAllByText(/AI care ended:/).length).toBeGreaterThan(0);
  });

  it('V18 E498: a liftable block (a complaint) offers the owner Lift: their message since the block and a typed confirmation of 20 or more characters', async () => {
    const since = iso(-3_600_000);
    const p = panel({ state: 'ended', block: { reason: 'complaint', since, sentence: 'x' }, startRefusal: { code: 'AI_ISA_PERSON_DECLINED', sentence: 'x' } });
    const inbound = { id: IDS.message, type: 'message', occurredAt: iso(-600_000), actor: null, detail: 'sms:inbound', preview: 'Sorry, please keep sending me homes', note: null, provenance: 'native' };
    const fake = person(p, { live: false })
      .on(`GET /contacts/${IDS.jane}/timeline?limit=100`, { status: 200, body: { items: [inbound], nextCursor: null } })
      .on(`POST /contacts/${IDS.jane}/ai-isa/lift-block`, { status: 200, body: { lifted: true } });
    isaApp(fake, `/contacts/${IDS.jane}`, 'agent');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Lift the block' }));
    const sheet = await screen.findByRole('dialog', { name: 'Lift the block' });
    await u.click(await within(sheet).findByRole('radio', { name: /Sorry, please keep sending me homes/ }));
    const box = within(sheet).getByLabelText('Why you are lifting it, in your words');
    expect((box as HTMLTextAreaElement).value).toBe('');
    const go = within(sheet).getByRole('button', { name: 'Lift the block' });
    await u.type(box, 'too short');
    expect(go).toBeDisabled();
    await u.type(box, ' but now it is long enough to count');
    await u.click(go);
    expect(await within(sheet).findByText('Lifted. You can start AI care again.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/ai-isa/lift-block`)[0]!.body).toEqual({ inboundMessageId: IDS.message, attestation: 'too short but now it is long enough to count' });
  });

  it('E513: a paused strip says who can resume, and when a forgotten pause ends', async () => {
    isaApp(person(panel({ state: 'paused' }), { live: false }), `/contacts/${IDS.jane}`, 'team_lead', { userId: ISA_IDS.tl });
    const strip = await screen.findByTestId('ai-strip');
    expect(within(strip).getByText('Ava can resume.')).toBeInTheDocument();
    expect(within(strip).queryByRole('button', { name: 'Resume AI care' })).toBeNull();
    expect(screen.getByText(/If nobody resumes it, AI care ends around .* with a handoff\./)).toBeInTheDocument();
  });

  it('E513: Pause just after an end gets NOT_LIVE and states the fresh state in words', async () => {
    let gone = false;
    const fake = person(panel())
      .on(`GET /contacts/${IDS.jane}/ai-isa`, () => ({ status: 200, body: gone ? panel({ state: 'ended' }) : panel() }))
      .on(`POST /contacts/${IDS.jane}/ai-isa/pause`, () => ((gone = true), isaError('AI_ISA_NOT_LIVE')));
    isaApp(fake, `/contacts/${IDS.jane}`, 'agent');
    const strip = await screen.findByTestId('ai-strip');
    await userEvent.setup().click(within(strip).getAllByRole('button', { name: 'Pause' })[0]!);
    // the strip re-renders in its ended state, and the fresh state is said through the Announcer
    await waitFor(() => expect(announced()).toBe('AI care already ended: They opted out.'));
    await waitFor(() => expect(screen.getByTestId('ai-strip').textContent).toMatch(/AI care ended: They opted out\./));
  });

  it('R-ISA-15: a non-owner pause says the owner is told, and what may still reach the person', async () => {
    const fake = person(panel()).on(`POST /contacts/${IDS.jane}/ai-isa/pause`, { status: 200, body: { ...CONTROL, inFlight: [{ messageId: ISA_IDS.aiMessage, at: new Date().toISOString(), sentence: 'x' }] } });
    isaApp(fake, `/contacts/${IDS.jane}`, 'team_lead', { userId: ISA_IDS.tl });
    const strip = await screen.findByTestId('ai-strip');
    await userEvent.setup().click(within(strip).getAllByRole('button', { name: 'Pause' })[0]!);
    await waitFor(() => expect(within(strip).getByTestId('ai-control-line').textContent).toMatch(/^Paused: nobody is following up automatically\. Ava is told and can resume it\. 1 message was already on its way at .*It may still reach Jane\.$/));
  });

  it('R-PERM-5 E539: a TC never fetches AI care; a 404 panel (a forged or invisible contact id) renders nothing', async () => {
    const fake = person(panel());
    isaApp(fake, `/contacts/${IDS.jane}`, 'tc');
    await screen.findByText('Jane Doe', { selector: 'h2' });
    expect(fake.calls.some((c) => c.path.includes('ai-isa'))).toBe(false);
    const f2 = person(panel()).on(`GET /contacts/${IDS.jane}/ai-isa`, err(404, 'NOT_FOUND'));
    isaApp(f2, `/contacts/${IDS.jane}`, 'agent');
    await screen.findAllByText('Jane Doe', { selector: 'h2' });
    await waitFor(() => expect(f2.callsTo(`GET /contacts/${IDS.jane}/ai-isa`).length).toBeGreaterThan(0));
    expect(screen.queryByTestId('ai-strip')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'AI care' })).toBeNull();
  });
});

describe('Take over, End and the Undo toast (R-ISA-15, E496)', () => {
  it('R-ISA-15 E496: Take over from the person page navigates to the thread, takes focus to Undo, and holds the compose autofocus', async () => {
    const until = new Date(Date.now() + UNDO_MS).toISOString();
    const fake = person(panel()).on(`POST /contacts/${IDS.jane}/ai-isa/take-over`, { status: 200, body: { ...CONTROL, undoUntil: until, sentence: 'You took over.' } });
    const { router } = isaApp(fake, `/contacts/${IDS.jane}`, 'agent');
    const strip = await screen.findByTestId('ai-strip');
    await userEvent.setup().click(within(strip).getAllByRole('button', { name: 'Take over' })[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/contacts/${IDS.jane}/thread`));
    expect(router.state.location.search).toBe('?compose=sms');
    await screen.findByTestId('ai-thread-banner');
    const toast = await screen.findByTestId('ai-undo-toast');
    expect(within(toast).getByText('You took over. AI care ends in 10 seconds; Undo keeps it paused instead.')).toBeInTheDocument();
    const undo = within(toast).getByRole('button', { name: 'Undo' });
    await waitFor(() => expect(document.activeElement).toBe(undo));
    // the compose box did not take the focus from Undo
    expect(document.activeElement?.tagName).not.toBe('TEXTAREA');
    await waitFor(() => expect(announced()).toMatch(/Undo keeps it paused/));
  });

  it('R-ISA-15 E496: Undo keeps care paused and says so; Escape closes the toast without undoing', async () => {
    const until = new Date(Date.now() + UNDO_MS).toISOString();
    const fake = person(panel())
      .on(`POST /contacts/${IDS.jane}/ai-isa/take-over`, { status: 200, body: { ...CONTROL, undoUntil: until } })
      .on(`POST /contacts/${IDS.jane}/ai-isa/undo`, { status: 200, body: CONTROL });
    isaApp(fake, `/contacts/${IDS.jane}/thread`, 'agent');
    const u = userEvent.setup();
    const banner = await screen.findByTestId('ai-thread-banner');
    await u.click(within(banner).getByRole('button', { name: 'Take over' }));
    const toast = await screen.findByTestId('ai-undo-toast');
    await u.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(announced()).toBe('Undone. AI care stays paused until you resume it.'));
    expect(screen.queryByTestId('ai-undo-toast')).toBeNull();
    // Escape: a fresh window, closed without a request
    await u.click(within(banner).getByRole('button', { name: 'Take over' }));
    await screen.findByTestId('ai-undo-toast');
    await u.keyboard('{Escape}');
    expect(screen.queryByTestId('ai-undo-toast')).toBeNull();
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/ai-isa/undo`)).toHaveLength(1);
  });

  it('R-ISA-15 E496: Undo is reachable by Tab from the page', async () => {
    const until = new Date(Date.now() + UNDO_MS).toISOString();
    const fake = person(panel()).on(`POST /contacts/${IDS.jane}/ai-isa/end`, { status: 200, body: { ...CONTROL, undoUntil: until } });
    isaApp(fake, `/contacts/${IDS.jane}/thread`, 'agent');
    const u = userEvent.setup();
    const banner = await screen.findByTestId('ai-thread-banner');
    await u.click(within(banner).getByRole('button', { name: 'More' }));
    await u.click(within(banner).getByRole('button', { name: 'End AI care' }));
    const toast = await screen.findByTestId('ai-undo-toast');
    expect(within(toast).getByText('AI care ends in 10 seconds. Undo keeps it paused instead.')).toBeInTheDocument();
    (document.activeElement as HTMLElement | null)?.blur();
    let reached = false;
    for (let i = 0; i < 60 && !reached; i += 1) {
      await u.tab();
      reached = document.activeElement === within(toast).getByRole('button', { name: 'Undo' });
    }
    expect(reached).toBe(true);
  });

  it("R-ISA-15 E496: a second Undo after someone else's reads \"Someone already undid this\"", async () => {
    const until = new Date(Date.now() + UNDO_MS).toISOString();
    let n = 0;
    const fake = person(panel())
      .on(`GET /contacts/${IDS.jane}/ai-isa`, () => ({ status: 200, body: ++n === 1 ? panel() : panel({ state: 'paused' }) }))
      .on(`POST /contacts/${IDS.jane}/ai-isa/take-over`, { status: 200, body: { ...CONTROL, undoUntil: until } })
      .on(`POST /contacts/${IDS.jane}/ai-isa/undo`, isaError('AI_ISA_UNDO_EXPIRED'));
    isaApp(fake, `/contacts/${IDS.jane}/thread`, 'agent');
    const u = userEvent.setup();
    await u.click(within(await screen.findByTestId('ai-thread-banner')).getByRole('button', { name: 'Take over' }));
    await u.click(within(await screen.findByTestId('ai-undo-toast')).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(announced()).toBe('Someone already undid this. AI care stays paused.'));
  });

  it("E496 (batch 13 isa-4 F14): another person's open window shows Undo to a viewer with control (restored from panel.undoUntil, worded from the seconds left), and never to a collaborator", async () => {
    const p = panel({ state: 'paused' });
    p.assignment!.undoUntil = new Date(Date.now() + 6000).toISOString();
    const first = isaApp(person(p, { live: false }), `/contacts/${IDS.jane}/thread`, 'owner', { userId: ISA_IDS.other });
    const toast = await screen.findByTestId('ai-undo-toast');
    const left = Number(within(toast).getByRole('timer').textContent?.replace(/\D/g, ''));
    expect(left).toBeLessThanOrEqual(6);
    // batch 13 isa-4 F14: a restored toast says the seconds actually left, never "10 seconds"
    expect(within(toast).getByText(/^AI care ends in [1-6] seconds?\. Undo keeps it paused instead\.$/)).toBeInTheDocument();
    expect(toast.textContent).not.toMatch(/10 seconds/);
    expect(screen.queryByRole('button', { name: 'Resume AI care' })).toBeNull();
    // a collaborating agent (not the owner) sees no Undo
    first.view.unmount();
    isaApp(person(p, { live: false }), `/contacts/${IDS.jane}/thread`, 'agent', { userId: ISA_IDS.other });
    await screen.findByTestId('ai-thread-banner');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('E496 mechanics: the window is 10 s minus the round trip from receipt, and after a reload min(10 s, undoUntil − now); skew never shows it longer', () => {
    expect(windowFromResponse(1000, 1600, new Date().toISOString())).toBe(1600 + UNDO_MS - 600);
    const now = Date.now();
    expect(windowFromPanel(new Date(now + 60_000).toISOString(), now)).toBe(now + UNDO_MS);
    expect(windowFromPanel(new Date(now + 4000).toISOString(), now)).toBe(now + 4000);
    expect(windowFromPanel(new Date(now - 1000).toISOString(), now)).toBeLessThanOrEqual(now);
  });

  it('R-ISA-30 ISA-2b Q1 (batch 13 isa-4 F4): after a team lead took over, the owner never reads her own name as the handoff recipient', async () => {
    const ended = panel({ state: 'ended', handoff: { id: ISA_IDS.handoff, reason: 'taken_over', slaClass: 'high', slaDueAt: new Date(Date.now() + 3_600_000).toISOString(), slaMetAt: null, overdue: false, confirmationStatus: 'none', confirmationNotSent: null, closedReason: null } });
    ended.assignment!.endReason = 'taken_over';
    ended.assignment!.pauseReason = 'taking_over';
    const fake = person(ended, { live: false }).on(`GET /ai-isa/handoffs/${ISA_IDS.handoff}`, { status: 200, body: handoffView({ reason: 'taken_over', recipientUserId: ISA_IDS.tl, canAcknowledge: false }) });
    isaApp(fake, `/contacts/${IDS.jane}`, 'agent');
    const strip = await screen.findByTestId('ai-strip');
    expect(await within(strip).findByText('The person who took over got the handoff.')).toBeInTheDocument();
    expect(strip.textContent).not.toMatch(/Ava got the handoff|team leads and Owner\/Admin/);
  });

  it('R-ISA-30 (batch 13 isa-4 F4): a lead that moved names its new owner as the recipient', async () => {
    const ended = panel({ state: 'ended', owner: ISA_IDS.other, handoff: { id: ISA_IDS.handoff, reason: 'owner_change', slaClass: 'high', slaDueAt: new Date(Date.now() + 3_600_000).toISOString(), slaMetAt: null, overdue: false, confirmationStatus: 'none', confirmationNotSent: null, closedReason: null } });
    ended.assignment!.endReason = 'owner_change';
    const fake = person(ended, { live: false }).on(`GET /ai-isa/handoffs/${ISA_IDS.handoff}`, { status: 200, body: handoffView({ reason: 'owner_change', recipientUserId: IDS.me }) });
    isaApp(fake, `/contacts/${IDS.jane}`, 'admin', { userId: ISA_IDS.tl });
    const strip = await screen.findByTestId('ai-strip');
    expect(await within(strip).findByText('Ava got the handoff.')).toBeInTheDocument();
  });

  it('R-ISA-15 E496 (batch 13 isa-4 F4): after a team lead took over, an Admin whose window was restored reads that the person who took over gets the handoff, never the team leads and Owner/Admin', async () => {
    const closing = panel({ state: 'paused' });
    closing.assignment!.undoUntil = new Date(Date.now() + 400).toISOString();
    closing.assignment!.pauseReason = 'taking_over';
    const ended = panel({ state: 'ended', handoff: { id: ISA_IDS.handoff, reason: 'taken_over', slaClass: 'high', slaDueAt: new Date(Date.now() + 3_600_000).toISOString(), slaMetAt: null, overdue: false, confirmationStatus: 'none', confirmationNotSent: null, closedReason: null } });
    ended.assignment!.pauseReason = 'taking_over';
    let n = 0;
    const fake = person(closing, { live: false })
      .on(`GET /contacts/${IDS.jane}/ai-isa`, () => ({ status: 200, body: ++n <= 2 ? closing : ended }))
      .on(`GET /ai-isa/handoffs/${ISA_IDS.handoff}`, { status: 200, body: handoffView({ reason: 'taken_over', recipientUserId: ISA_IDS.tl }) });
    isaApp(fake, `/contacts/${IDS.jane}/thread`, 'admin', { userId: ISA_IDS.other });
    await screen.findByTestId('ai-undo-toast');
    const after = await screen.findByTestId('ai-after-toast', {}, { timeout: 4000 });
    await waitFor(() => expect(after.textContent).toBe('AI care ended. The person who took over gets the handoff.'), { timeout: 5000 });
    await act(async () => {});
  });

  it('R-ISA-15 E496: after the window (here restored from panel.undoUntil after a reload) it says "Finishing…", then who has the handoff (the actual recipient)', async () => {
    const closing = panel({ state: 'paused' });
    closing.assignment!.undoUntil = new Date(Date.now() + 400).toISOString();
    const ended = panel({ state: 'ended', handoff: { id: ISA_IDS.handoff, reason: 'taken_over', slaClass: 'high', slaDueAt: new Date(Date.now() + 3_600_000).toISOString(), slaMetAt: null, overdue: false, confirmationStatus: 'none', confirmationNotSent: null, closedReason: null } });
    let n = 0;
    const fake = person(closing, { live: false })
      .on(`GET /contacts/${IDS.jane}/ai-isa`, () => ({ status: 200, body: ++n <= 2 ? closing : ended }))
      .on(`GET /ai-isa/handoffs/${ISA_IDS.handoff}`, { status: 200, body: handoffView({ recipientUserId: IDS.me }) });
    isaApp(fake, `/contacts/${IDS.jane}/thread`, 'agent');
    await screen.findByTestId('ai-undo-toast');
    const after = await screen.findByTestId('ai-after-toast', {}, { timeout: 4000 });
    await waitFor(() => expect(after.textContent).toBe('AI care ended. The handoff is in your feed.'), { timeout: 5000 });
    await act(async () => {});
  });
});
