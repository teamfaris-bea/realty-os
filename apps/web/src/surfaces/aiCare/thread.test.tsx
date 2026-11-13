// The thread under AI care (R-ISA-7, R-ISA-29; E511, E533): AI labels come from the turns route's message ids with a
// verb the message's own status supports; the rest keep "Sent automatically"; no person's name stands alone.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '../feed/lib/types.js';
import { FakeFetch, IDS, ISA_IDS, contactReads, handoffView, isaApp, iso, panel, row, turn } from './testing.js';

const SCHED = '01900000-0000-7000-8000-0000000a1002';
const BLOCKED = '01900000-0000-7000-8000-0000000a1003';
const PLAIN = '01900000-0000-7000-8000-0000000a1004';
const OLD = '01900000-0000-7000-8000-0000000a1005';
const msg = (id: string, status: string, preview: string, ms: number): TimelineItem => ({ id, type: 'message', occurredAt: iso(ms), actor: null, detail: 'sms:outbound', preview, note: null, provenance: 'native', status, statusReason: status === 'blocked' ? 'ISA_QUIET_HOURS' : null });

function thread(o: { turns?: ReturnType<typeof turn>[]; items?: TimelineItem[]; p?: ReturnType<typeof panel>; hold?: string | null } = {}) {
  const items = o.items ?? [msg(ISA_IDS.aiMessage, 'sent', 'Hi from the assistant', -900_000), msg(SCHED, 'scheduled', 'Planned follow-up', -800_000), msg(BLOCKED, 'blocked', 'Blocked one', -700_000), msg(PLAIN, 'sent', 'An automated reminder', -600_000), msg(OLD, 'sent', 'From an older period', -86_400_000 * 3)].reverse();
  return contactReads(new FakeFetch())
    .on(`GET /contacts/${IDS.jane}/timeline?limit=100`, { status: 200, body: { items, nextCursor: null } })
    .on(`GET /contacts/${IDS.jane}/ai-isa`, { status: 200, body: o.p ?? panel() })
    .on('GET /ai-isa/assignments?scope=all&state=live', { status: 200, body: { rows: [row()], holdSentence: o.hold ?? null } })
    .on(`GET /contacts/${IDS.jane}/ai-isa/turns`, {
      status: 200,
      body: {
        turns: o.turns ?? [
          turn({ messageId: ISA_IDS.aiMessage, createdAt: iso(-900_000) }),
          turn({ id: '01900000-0000-7000-8000-0000000c0002', messageId: SCHED, status: 'deferred', triggerKind: 'timer', notBefore: '2026-11-14T15:00:00Z', createdAt: iso(-800_000) }),
          turn({ id: '01900000-0000-7000-8000-0000000c0003', messageId: BLOCKED, status: 'blocked', denied: ['ISA_QUIET_HOURS:reply'], decision: { escalations: ['pricing_negotiation'] }, createdAt: iso(-700_000) }),
          turn({ id: '01900000-0000-7000-8000-0000000c0004', messageId: OLD, createdAt: iso(-86_400_000 * 3) }),
        ],
      },
    });
}

describe('AI labels in the thread (R-ISA-7)', () => {
  it('R-ISA-7: turn message ids get the AI label with a status-led verb; a scheduled or blocked one never reads "Sent by"', async () => {
    isaApp(thread(), `/contacts/${IDS.jane}/thread`, 'agent');
    const sent = await screen.findByText(/Sent by Ava's AI assistant/);
    expect(sent.closest('li')!.textContent).toContain('Hi from the assistant');
    const sched = screen.getByText(/Scheduled by Ava's AI assistant for/).closest('li')!;
    expect(sched.textContent).toContain('Planned follow-up');
    const blocked = screen.getByText(/Written by Ava's AI assistant/).closest('li')!;
    expect(blocked.textContent).toContain('Blocked one');
    expect(blocked.textContent).not.toMatch(/Sent by/);
  });

  it('R-ISA-7 V12: messages outside the turns keep "Sent automatically"; an older assignment\'s turns never carry the current owner\'s name', async () => {
    isaApp(thread(), `/contacts/${IDS.jane}/thread`, 'agent');
    const plain = (await screen.findByText('An automated reminder')).closest('li')!;
    expect(plain.textContent).toMatch(/Sent automatically/);
    const old = screen.getByText('From an older period').closest('li')!;
    expect(old.textContent).toMatch(/Sent by the AI assistant/);
    expect(old.textContent).not.toMatch(/Ava/);
  });

  it('R-ISA-7: no person\'s name stands alone as a sender, and no avatar', async () => {
    isaApp(thread(), `/contacts/${IDS.jane}/thread`, 'agent');
    await screen.findByText(/Sent by Ava's AI assistant/);
    const conv = screen.getByRole('list', { name: 'Conversation' });
    expect(conv.textContent).not.toMatch(/Ava Agent ·|Sent by Ava ·/);
    expect(conv.querySelector('img')).toBeNull();
  });

  it('R-ISA-7: Why says the trigger, the holding-line class and the status and codes in words', async () => {
    isaApp(thread(), `/contacts/${IDS.jane}/thread`, 'agent');
    const blocked = (await screen.findByText(/Written by Ava's AI assistant/)).closest('li')!;
    await userEvent.setup().click(within(blocked).getByRole('button', { name: 'Why' }));
    expect(within(blocked).getByText('Reply to their message · Holding line: price or value · Not sent: a send check refused it. · Quiet hours where they may be')).toBeInTheDocument();
    expect(blocked.textContent).not.toMatch(/\b[A-Z]{2,}_[A-Z_]+\b/);
  });

  it('R-ISA-22: the banner shows the state and the controls above the messages', async () => {
    isaApp(thread(), `/contacts/${IDS.jane}/thread`, 'agent');
    const b = await screen.findByTestId('ai-thread-banner');
    expect(within(b).getByText('AI assistant is handling this conversation')).toBeInTheDocument();
    expect(within(b).getByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  it('E533 V17: a pending post-handoff message says when it goes and what stops it; a canceled one reads "confirm by hand"', async () => {
    const p = panel({ state: 'ended', handoff: { id: ISA_IDS.handoff, reason: 'appointment_booked', slaClass: 'high', slaDueAt: iso(3_600_000), slaMetAt: null, overdue: false, confirmationStatus: 'queued', confirmationNotSent: null, closedReason: null } });
    const pending = { id: ISA_IDS.pending, kind: 'confirmation' as const, channel: 'sms', status: 'scheduled', scheduledFor: iso(1_800_000) };
    const fake = thread({ p }).on(`GET /ai-isa/handoffs/${ISA_IDS.handoff}`, { status: 200, body: handoffView({ pendingMessage: pending }) });
    isaApp(fake, `/contacts/${IDS.jane}/thread`, 'agent');
    expect(await screen.findByText(/An AI confirmation is scheduled for .*\. A text from anyone on the team, or any call with Jane, before then stops it\./)).toBeInTheDocument();
  });

  it('E533 V17: a canceled confirmation reads from its own status', async () => {
    const p = panel({ state: 'ended', handoff: { id: ISA_IDS.handoff, reason: 'appointment_booked', slaClass: 'high', slaDueAt: iso(3_600_000), slaMetAt: null, overdue: false, confirmationStatus: 'queued', confirmationNotSent: null, closedReason: null } });
    const fake = thread({ p }).on(`GET /ai-isa/handoffs/${ISA_IDS.handoff}`, { status: 200, body: handoffView({ pendingMessage: { id: ISA_IDS.pending, kind: 'confirmation', channel: 'sms', status: 'canceled', scheduledFor: null } }) });
    isaApp(fake, `/contacts/${IDS.jane}/thread`, 'agent');
    await waitFor(() => expect(screen.getByTestId('ai-thread-banner').textContent).toMatch(/Confirmation not sent: confirm by hand\./));
  });

  it('E533 V3 (b13 review F8-ui): under the AI_ISA_LIVE_SENDS hold, after care ended, a scheduled confirmation keeps the hold banner and says it would go out only if sending were allowed, so confirm it yourself', async () => {
    const p = panel({ state: 'ended', handoff: { id: ISA_IDS.handoff, reason: 'appointment_booked', slaClass: 'critical', slaDueAt: iso(3_600_000), slaMetAt: null, overdue: false, confirmationStatus: 'scheduled', confirmationNotSent: null, closedReason: null } });
    const pending = { id: ISA_IDS.pending, kind: 'confirmation' as const, channel: 'sms', status: 'scheduled', scheduledFor: iso(1_800_000) };
    const fake = thread({ p, hold: 'AI assistant sending is off on this deployment.' }).on(`GET /ai-isa/handoffs/${ISA_IDS.handoff}`, { status: 200, body: handoffView({ pendingMessage: pending }) });
    isaApp(fake, `/contacts/${IDS.jane}/thread`, 'agent');
    const b = await screen.findByTestId('ai-thread-banner');
    expect(await within(b).findByTestId('ai-hold')).toHaveTextContent('AI assistant sending is off on this deployment.');
    await waitFor(() => expect(b.textContent).toMatch(/would be sent at .* if sending were allowed\. AI messages are held, so confirm it yourself\./));
    expect(b.textContent).not.toMatch(/is scheduled for/);
  });

  it('E533 R-ISA-30 (b13 review B13S-3 / F4-ui): a canceled confirmation to a person D1 leaves no channel reads keep or cancel, never "confirm by hand"', async () => {
    const p = panel({ state: 'ended', handoff: { id: ISA_IDS.handoff, reason: 'appointment_booked', slaClass: 'none', slaDueAt: iso(0), slaMetAt: null, overdue: false, confirmationStatus: 'canceled', confirmationNotSent: 'unreachable', closedReason: null } });
    const fake = thread({ p }).on(`GET /ai-isa/handoffs/${ISA_IDS.handoff}`, { status: 200, body: handoffView({ confirmationStatus: 'canceled', confirmationNotSent: 'unreachable', pendingMessage: { id: ISA_IDS.pending, kind: 'confirmation', channel: 'sms', status: 'canceled', scheduledFor: null } }) });
    isaApp(fake, `/contacts/${IDS.jane}/thread`, 'agent');
    await waitFor(() => expect(screen.getByTestId('ai-thread-banner').textContent).toMatch(/cannot be confirmed by hand: keep or cancel the appointment\./));
    expect(screen.getByTestId('ai-thread-banner').textContent).not.toMatch(/Confirmation not sent: confirm by hand/);
  });
});
