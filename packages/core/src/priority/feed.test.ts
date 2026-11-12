import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DAY_MS, addLocalDays, at, localDate, localTime, resolveLocal, zone } from '../foundation/index.js';
import { firstTouchFeedKey as ownershipFirstTouchKey, offerFeedKey as ownershipOfferKey } from '../ownership/index.js';
import {
  FEED_REASONS,
  FEED_REASON_CODES,
  FeedItemSchema,
  SCORE_VERSION,
  type FeedInputs,
  type FeedItem,
  answersClient,
  compareFeedItems,
  dealDateWindow,
  isHumanTouch,
  reasonFromCode,
  scoreFeed,
  scoreOf,
  splitBands,
  taskDeadline,
} from './index.js';
import {
  NOW,
  NY,
  OTHER,
  action,
  apptF,
  busyFeed,
  call,
  contact,
  dealDateF,
  draft,
  feedInputs,
  handback,
  hours,
  inactivity,
  inbound,
  min,
  msg,
  offer,
  pondLead,
  proposal,
  reinq,
  shuffled,
  sla,
  t,
  task,
  taskF,
  touch,
} from './testing/fixtures.js';

const codes = (it: FeedItem | undefined) => (it?.reasons ?? []).map((r) => r.code);
const one = (i: FeedInputs) => {
  const out = scoreFeed(i);
  expect(out).toHaveLength(1);
  return out[0] as FeedItem;
};

describe('scoreFeed: item types and reasons', () => {
  it('lead offer: pinned, Accept is the one-tap primary, countdown to expiry, lead source shown', () => {
    const it = one(feedInputs({ offers: [offer()] }));
    expect(it).toMatchObject({ itemType: 'lead_offer', band: 'pinned', dueAt: t(min(4)), score: 90, scoreVersion: SCORE_VERSION });
    expect(it.primaryAction).toEqual({ kind: 'accept_offer', label: 'Accept', contactId: contact(1), offerId: offer().offerId });
    expect(it.alternatives.map((a) => a.kind)).toEqual(['decline_offer']);
    expect(it.reasons.map((r) => r.label)).toEqual(['New lead offered to you', 'Offer ends in 4 min', 'From Zillow']);
    expect(it.dedupeKey).toBe(ownershipOfferKey(contact(1), offer().offerId));
  });

  it('an expired offer or an offer to someone else is not shown', () => {
    expect(scoreFeed(feedInputs({ offers: [offer({ expiresAt: NOW }), offer({ offerId: 'x', offeredToUserId: OTHER })] }))).toEqual([]);
  });

  it('first-touch SLA: pinned, call first, release countdown; overdue raises the score', () => {
    const due = one(feedInputs({ slas: [sla()] }));
    expect(due).toMatchObject({ itemType: 'first_touch_due', band: 'pinned', score: 85, dueAt: t(min(10)) });
    expect(due.primaryAction.kind).toBe('call');
    expect(due.alternatives.map((a) => a.kind)).toEqual(['text', 'email', 'open_contact']);
    expect(due.reasons.map((r) => r.label)).toEqual(['First contact due in 10 min', 'Goes back to the pond in 25 min if not contacted']);
    expect(due.dedupeKey).toBe(ownershipFirstTouchKey(contact(2), 4));
    const late = one(feedInputs({ slas: [sla({ firstTouchDueAt: t(-min(3)) })] }));
    expect(codes(late)).toContain('FIRST_TOUCH_OVERDUE');
    expect(late.reasons[0]?.label).toBe('First contact 3 min overdue');
    expect(late.score).toBe(95);
  });

  it('first-touch SLA: a touched or ended period, or another owner, shows nothing', () => {
    expect(
      scoreFeed(feedInputs({ slas: [sla({ firstTouchAt: t(-min(1)) }), sla({ periodSeq: 5, periodEndedAt: t(-min(1)) }), sla({ periodSeq: 6, ownerUserId: OTHER })] })),
    ).toEqual([]);
  });

  it('re-inquiry: scored without an SLA, pinned with one, folded into an open first-touch card', () => {
    const plain = one(feedInputs({ reinquiries: [reinq()] }));
    expect(plain).toMatchObject({ itemType: 'reinquiry', band: 'scored', score: 70, dedupeKey: `reinquiry:${contact(8)}:${reinq().inquiryId}` });
    expect(plain.reasons[0]?.label).toBe('Asked again 3 min ago');
    const withSla = one(feedInputs({ reinquiries: [reinq({ dueAt: t(min(12)) })] }));
    expect(withSla.band).toBe('pinned');
    expect(codes(withSla)).toEqual(['REINQUIRY', 'FIRST_TOUCH_DUE']);
    const overdue = one(feedInputs({ reinquiries: [reinq({ dueAt: t(-min(2)) })] }));
    expect(codes(overdue)).toEqual(['REINQUIRY', 'FIRST_TOUCH_OVERDUE']);
    // The same lead with an open first-touch card: one card, with "Asked again" from the latest re-inquiry.
    const merged = scoreFeed(
      feedInputs({
        slas: [sla({ contactId: contact(8) })],
        reinquiries: [reinq({ at: t(-hours(3)), inquiryId: 'a' as never }), reinq({ at: t(-min(3)), inquiryId: 'b' as never })],
      }),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.itemType).toBe('first_touch_due');
    expect(merged[0]?.reasons.find((r) => r.code === 'ASKED_AGAIN')?.label).toBe('Asked again 3 min ago');
    expect(scoreFeed(feedInputs({ reinquiries: [reinq({ touchedSince: true })] }))).toEqual([]);
  });

  it('inactivity warning: pinned until the release instant, same key as core/ownership', () => {
    const w = one(feedInputs({ inactivityWarnings: [inactivity()] }));
    expect(w).toMatchObject({ itemType: 'inactivity_warning', band: 'pinned', dueAt: t(hours(47)), dedupeKey: `inactivity:${contact(9)}:7:${t(-hours(1))}` });
    expect(w.reasons[0]?.label).toBe('No contact in a while; goes back to the pond in 47 h');
    expect(scoreFeed(feedInputs({ inactivityWarnings: [inactivity({ releaseAt: NOW })] }))).toEqual([]);
  });

  it('client waiting: one card per contact keyed by the latest message, with how long they waited', () => {
    const it = one(
      feedInputs({
        unansweredInbound: [inbound({ id: msg(2), at: t(-hours(5)) }), inbound({ id: msg(3), at: t(-min(20)) })],
      }),
    );
    expect(it).toMatchObject({ itemType: 'unanswered_inbound', band: 'scored', subjectType: 'message', subjectId: msg(3), dedupeKey: `inbound:${contact(3)}:${msg(3)}` });
    expect(it.reasons.map((r) => r.label)).toEqual(['They texted 20 min ago; no reply yet', '2 messages or calls waiting', 'Waiting over 4 h']);
    expect(it.score).toBe(70);
    expect(it.primaryAction.kind).toBe('text');
    expect(it.createdAt).toBe(t(-hours(5)));
  });

  it('client waiting (finding UXA-3): a message in the website chat says so and offers a Reply in the chat first, never "They texted"; a chat-only lead is not demoted as unreachable', () => {
    const unreachable = new Map([[contact(3), { sms: { outcome: 'unavailable' as const, explanation: 'No working phone number' }, voice: { outcome: 'unavailable' as const, explanation: 'No working phone number' }, email: { outcome: 'unavailable' as const, explanation: 'No email address' } }]]);
    const it = one(feedInputs({ unansweredInbound: [inbound({ channel: 'web_chat', at: t(-min(1)) })], blockedChannels: unreachable }));
    expect(it.reasons[0]).toMatchObject({ code: 'CLIENT_WAITING', label: 'They wrote in the website chat 1 min ago; no reply yet' });
    expect(it.primaryAction).toEqual({ kind: 'reply_chat', label: 'Reply', contactId: contact(3) });
    expect(it.alternatives.map((a) => a.kind)).toEqual(['open_contact']);
    expect(codes(it)).not.toContain('CANT_CONTACT');
    // a chat lead the agent also has a phone for: Reply in the chat, then call, text (email only with an address)
    const withPhone = new Map([[contact(3), { email: { outcome: 'unavailable' as const, explanation: 'No email address' } }]]);
    const both = one(feedInputs({ unansweredInbound: [inbound({ channel: 'web_chat' })], blockedChannels: withPhone }));
    expect([both.primaryAction.kind, ...both.alternatives.map((a) => a.kind)]).toEqual(['reply_chat', 'call', 'text', 'open_contact']);
    expect(FeedItemSchema.safeParse(both).success).toBe(true);
  });

  it('R-CHAN-2 (review optouts/F1): a lead waiting in the website chat whose person asked not to be contacted gets no Reply: the card keeps "Can\'t reach them right now" with the reason, and opens the contact', () => {
    const dnc = { outcome: 'deny' as const, explanation: 'Asked not to be contacted at all' };
    const blocked = new Map([[contact(3), { sms: dnc, voice: dnc, email: dnc, web_chat: dnc }]]);
    const waiting = one(feedInputs({ unansweredInbound: [inbound({ channel: 'web_chat', at: t(-min(1)) })], blockedChannels: blocked }));
    expect(waiting.primaryAction).toEqual({ kind: 'open_contact', label: 'Open', contactId: contact(3) });
    expect([waiting.primaryAction, ...waiting.alternatives].map((a) => a.kind)).not.toContain('reply_chat');
    expect(waiting.reasons.find((r) => r.code === 'CANT_CONTACT')?.label).toBe("Can't reach them right now: Asked not to be contacted at all");
    // the first-touch card too
    const ft = scoreFeed(feedInputs({ slas: [sla()], unansweredInbound: [inbound({ contactId: contact(2), channel: 'web_chat', at: t(-min(1)) })], blockedChannels: new Map([[contact(2), { sms: dnc, voice: dnc, email: dnc, web_chat: dnc }]]) })).find((x) => x.itemType === 'first_touch_due')!;
    expect(ft.primaryAction.kind).toBe('open_contact');
    expect(codes(ft)).toContain('CANT_CONTACT');
    // a chat that only opted out (the person did not ask about every channel): no Reply in it, the other channels stay
    const chatOnly = new Map([[contact(3), { web_chat: { outcome: 'deny' as const, explanation: 'Asked in the chat to stop being contacted' } }]]);
    const other = one(feedInputs({ unansweredInbound: [inbound({ channel: 'web_chat' })], blockedChannels: chatOnly }));
    expect([other.primaryAction.kind, ...other.alternatives.map((a) => a.kind)]).toEqual(['call', 'text', 'email', 'open_contact']);
  });

  it('R-INBOX-4 (review ui-compose/F3): web-chat drafts are said and judged as web chat: "Chat reply drafted for you", Reply in the chat first, never demoted for the texts', () => {
    const noPhoneNoEmail = { sms: { outcome: 'unavailable' as const, explanation: 'No working phone number' }, voice: { outcome: 'unavailable' as const, explanation: 'No working phone number' }, email: { outcome: 'unavailable' as const, explanation: 'No email address' } };
    // a chat-only lead waiting, with the assistant's chat reply drafted: Reply in the chat (the thread adopts the draft)
    const waiting = one(feedInputs({ unansweredInbound: [inbound({ channel: 'web_chat', at: t(-min(1)) })], drafts: [draft({ contactId: contact(3), channel: 'web_chat' })], blockedChannels: new Map([[contact(3), noPhoneNoEmail]]) }));
    expect(waiting.reasons.map((r) => r.label)).toContain('Chat reply drafted for you');
    expect(waiting.reasons.map((r) => r.label).join(' ')).not.toMatch(/text drafted|Can't reach them/i);
    expect(waiting.primaryAction).toEqual({ kind: 'reply_chat', label: 'Reply', contactId: contact(3) });
    // its own card: Send in one tap, and a STOP on their phone does not demote a reply in the chat
    const stopped = new Map([[contact(5), { sms: { outcome: 'deny' as const, explanation: 'Opted out of texts' } }]]);
    const own = one(feedInputs({ drafts: [draft({ channel: 'web_chat' })], blockedChannels: stopped }));
    expect(own.reasons[0]).toMatchObject({ code: 'DRAFT_READY', label: 'Chat reply drafted for you' });
    expect(codes(own)).not.toContain('TEXT_BLOCKED');
    expect(own.primaryAction).toEqual({ kind: 'send_draft', label: 'Send', actionId: action(2) });
    // a chat the person blocked (they asked not to be contacted): no Send, "can't reach them" with the reason
    const dnc = { outcome: 'deny' as const, explanation: 'Asked not to be contacted at all' };
    const blocked = one(feedInputs({ drafts: [draft({ channel: 'web_chat' })], blockedChannels: new Map([[contact(5), { sms: dnc, voice: dnc, email: dnc, web_chat: dnc }]]) }));
    expect(blocked.primaryAction.kind).not.toBe('send_draft');
    expect(blocked.reasons.find((r) => r.code === 'CANT_CONTACT')?.label).toBe("Can't reach them right now: Asked not to be contacted at all");
    // a text draft is still a text draft
    expect(one(feedInputs({ drafts: [draft()] })).reasons[0]?.label).toBe('Text drafted for you');
  });

  it('R-INBOX-4 (review ui-compose/F3): a handback after a chat reply offers the chat: Send its draft or Reply there, never "Can\'t reach them right now" for a chat-only lead', () => {
    const noPhoneNoEmail = new Map([[contact(4), { sms: { outcome: 'unavailable' as const, explanation: 'No working phone number' }, voice: { outcome: 'unavailable' as const, explanation: 'No working phone number' }, email: { outcome: 'unavailable' as const, explanation: 'No email address' } }]]);
    const plain = one(feedInputs({ handbacks: [handback({ inboundChannel: 'web_chat' })], blockedChannels: noPhoneNoEmail }));
    expect(plain.primaryAction).toEqual({ kind: 'reply_chat', label: 'Reply', contactId: contact(4) });
    expect(codes(plain)).not.toContain('CANT_CONTACT');
    const drafted = one(feedInputs({ handbacks: [handback({ inboundChannel: 'web_chat', replyDraftActionId: action(1) })], blockedChannels: noPhoneNoEmail }));
    expect(drafted.primaryAction).toEqual({ kind: 'send_draft', label: 'Send', actionId: action(1) });
    expect(codes(drafted)).not.toContain('CANT_CONTACT');
    // the person asked not to be contacted: nothing to send or reply with
    const dnc = { outcome: 'deny' as const, explanation: 'Asked not to be contacted at all' };
    const blocked = one(feedInputs({ handbacks: [handback({ inboundChannel: 'web_chat', replyDraftActionId: action(1) })], blockedChannels: new Map([[contact(4), { sms: dnc, voice: dnc, email: dnc, web_chat: dnc }]]) }));
    expect([blocked.primaryAction.kind, ...blocked.alternatives.map((a) => a.kind)]).not.toContain('send_draft');
    expect([blocked.primaryAction.kind, ...blocked.alternatives.map((a) => a.kind)]).not.toContain('reply_chat');
    expect(codes(blocked)).toContain('CANT_CONTACT');
  });

  it('first-touch SLA (finding UXA-3): a new lead who wrote in the website chat gets a Reply in the chat first', () => {
    const unreachable = new Map([[contact(2), { sms: { outcome: 'unavailable' as const, explanation: 'No working phone number' }, voice: { outcome: 'unavailable' as const, explanation: 'No working phone number' }, email: { outcome: 'unavailable' as const, explanation: 'No email address' } }]]);
    const out = scoreFeed(feedInputs({ slas: [sla()], unansweredInbound: [inbound({ contactId: contact(2), channel: 'web_chat', at: t(-min(1)) })], blockedChannels: unreachable }));
    const ft = out.find((x) => x.itemType === 'first_touch_due')!;
    expect(ft.primaryAction).toEqual({ kind: 'reply_chat', label: 'Reply', contactId: contact(2) });
    expect(codes(ft)).not.toContain('CANT_CONTACT');
  });

  it('client waiting: an email asks for an email reply; over an hour adds urgency', () => {
    const it = one(feedInputs({ unansweredInbound: [inbound({ channel: 'email', at: t(-hours(2)) })] }));
    expect(it.reasons.map((r) => r.code)).toEqual(['CLIENT_WAITING', 'WAITING_OVER_1H']);
    expect(it.reasons[0]?.label).toBe('They emailed 2 h ago; no reply yet');
    expect(it.primaryAction.kind).toBe('email');
    expect(it.score).toBe(60);
  });

  it('missed call: call back first', () => {
    const it = one(feedInputs({ unansweredInbound: [inbound({ id: call(1), kind: 'missed_call', channel: 'voice', at: t(-min(7)) })] }));
    expect(it).toMatchObject({ itemType: 'missed_call', subjectType: 'call', score: 55 });
    expect(it.reasons[0]?.label).toBe('Missed call 7 min ago');
    expect(it.primaryAction.kind).toBe('call');
  });

  it('auto-replies and opt-out/HELP keywords need no answer', () => {
    expect(scoreFeed(feedInputs({ unansweredInbound: [inbound({ isAutoReply: true }), inbound({ id: msg(9), isKeyword: true })] }))).toEqual([]);
  });

  it('R-IMPORT-6: imported inbound history never creates a feed item', () => {
    expect(scoreFeed(feedInputs({ unansweredInbound: [inbound({ imported: true })] }))).toEqual([]);
  });

  it('R-AST-15 R-IMPORT-6: only a human reply answers a waiting client; assistant, system, imported or gate-blocked sends do not', () => {
    const notAnswers = [
      touch({ initiator: 'assistant', byUserId: null }),
      touch({ initiator: 'system', byUserId: null }),
      touch({ initiator: 'import', imported: true }),
      touch({ gateAllowed: false }),
      touch({ at: t(-hours(1)) }), // before the message
    ];
    const still = scoreFeed(feedInputs({ unansweredInbound: [inbound({ laterTouches: notAnswers })] }));
    expect(still.map((x) => x.itemType)).toEqual(['unanswered_inbound']);
    expect(scoreFeed(feedInputs({ unansweredInbound: [inbound({ laterTouches: [...notAnswers, touch()] })] }))).toEqual([]);
    // A call the agent picked up also answers them (it is not a scoreboard touch).
    const picked = touch({ kind: 'call', direction: 'inbound_answered', gateAllowed: false });
    expect(scoreFeed(feedInputs({ unansweredInbound: [inbound({ laterTouches: [picked] })] }))).toEqual([]);
    expect(isHumanTouch(picked)).toBe(false);
    expect(answersClient(touch({ kind: 'message', direction: 'inbound_answered' }), t(-hours(1)))).toBe(false);
  });

  it('handback: one card for the conversation; with a reply draft, Send is one tap', () => {
    const items = scoreFeed(
      feedInputs({
        handbacks: [handback({ contactId: contact(3), replyDraftActionId: action(9) })],
        unansweredInbound: [inbound({ contactId: contact(3) })],
        drafts: [draft({ actionId: action(9), contactId: contact(3) })],
      }),
    );
    expect(items.map((x) => x.itemType)).toEqual(['handback']);
    const h = items[0] as FeedItem;
    expect(h.primaryAction).toEqual({ kind: 'send_draft', label: 'Send', actionId: action(9) });
    expect(h.alternatives.map((a) => a.kind)).toEqual(['edit_draft', 'call', 'review_handback', 'open_contact']);
    expect(h.assistantActionId).toBe(action(1));
    expect(h.reasons.map((r) => r.label)).toEqual(['Replied to the assistant; follow-ups paused']);
  });

  it('handback without a draft: reply on their channel; a long wait adds urgency', () => {
    const h = one(feedInputs({ handbacks: [handback({ inboundChannel: 'email', receivedAt: t(-hours(6)) })] }));
    expect(h.primaryAction.kind).toBe('email');
    expect(h.alternatives.map((a) => a.kind)).toEqual(['call', 'text', 'review_handback', 'open_contact']);
    expect(h.score).toBe(80);
    const v = one(feedInputs({ handbacks: [handback({ inboundChannel: 'voice', replyDraftActionId: action(3) })] }));
    expect(v.primaryAction.kind).toBe('call');
    expect(v.alternatives.map((a) => a.kind)).toContain('edit_draft');
  });

  it("assistant draft: Send is one tap and the assistant's one-line why is shown", () => {
    const d = one(feedInputs({ drafts: [draft()] }));
    expect(d).toMatchObject({ itemType: 'assistant_draft', score: 35, subjectType: 'assistant_action', assistantActionId: action(2) });
    expect(d.primaryAction).toEqual({ kind: 'send_draft', label: 'Send', actionId: action(2) });
    expect(d.reasons.map((r) => r.label)).toEqual(['Text drafted for you', 'They asked about the open house on Saturday']);
    const e = one(feedInputs({ drafts: [draft({ channel: 'email' })] }));
    expect(e.reasons[0]?.label).toBe('Email drafted for you');
  });

  // R-AST-5 (partial): needs-review details are never sent unchecked.
  it('a draft with a detail to check opens for review instead of sending', () => {
    const d = one(feedInputs({ drafts: [draft({ needsReview: true })] }));
    expect(d.primaryAction).toEqual({ kind: 'edit_draft', label: 'Review', actionId: action(2) });
    expect(codes(d)).toContain('CHECK_THIS');
    expect(d.alternatives.map((a) => a.kind)).toEqual(['open_contact']);
  });

  it('tasks: due soon, due within the hour, overdue, overdue over a day; Done is offered', () => {
    const soon = one(feedInputs({ tasks: [taskF()] }));
    expect(soon).toMatchObject({ itemType: 'task_due', score: 30, dueAt: t(hours(2)) });
    expect(soon.reasons[0]?.label).toBe('Due in 2 h');
    expect(soon.primaryAction.kind).toBe('call');
    expect(soon.alternatives.map((a) => a.kind)).toEqual(['text', 'email', 'complete_task', 'open_contact']);
    expect(codes(one(feedInputs({ tasks: [taskF({ dueAt: t(min(30)) })] })))).toEqual(['TASK_DUE', 'DUE_WITHIN_HOUR']);
    const late = one(feedInputs({ tasks: [taskF({ dueAt: t(-hours(30)) })] }));
    expect(codes(late)).toEqual(['TASK_OVERDUE', 'OVERDUE_OVER_DAY']);
    expect(late.reasons[0]?.label).toBe('Overdue by 30 h');
    expect(scoreFeed(feedInputs({ tasks: [taskF({ dueAt: t(hours(25)) }), taskF({ taskId: task(2), dueAt: null }), taskF({ taskId: task(3), status: 'done', completedAt: NOW })] }))).toEqual([]);
  });

  it('tasks: a document task emails first; a task with no contact offers Done (and the deal)', () => {
    expect(one(feedInputs({ tasks: [taskF({ kind: 'document' })] })).primaryAction.kind).toBe('email');
    const noContact = one(feedInputs({ tasks: [taskF({ contactId: null, dealId: 'f2000000-0000-7000-8000-000000000009' as never })] }));
    expect(noContact.primaryAction.kind).toBe('complete_task');
    expect(noContact.alternatives.map((a) => a.kind)).toEqual(['open_deal']);
    expect(one(feedInputs({ tasks: [taskF({ contactId: null })] })).alternatives).toEqual([]);
  });

  it('promises: overdue and due wording, with the verbatim evidence of where it was promised', () => {
    const p = one(
      feedInputs({
        tasks: [
          taskF({
            kind: 'promise',
            dueAt: t(-hours(1)),
            createdByKind: 'assistant',
            evidence: [{ sourceType: 'call', sourceId: call(5), locator: { kind: 'transcript_offset', startMs: 134_000, endMs: 137_000 }, snippet: 'I will send the comps by ten' }],
          }),
        ],
      }),
    );
    expect(p).toMatchObject({ itemType: 'promise_due', score: 55 });
    expect(p.reasons.map((r) => r.label)).toEqual(['You promised this; 1 h overdue', '“I will send the comps by ten” at 2:14 in the call']);
    const d = one(feedInputs({ tasks: [taskF({ kind: 'promise', dueAt: t(hours(3)) })] }));
    expect(d.reasons[0]?.label).toBe('You promised this; due in 3 h');
  });

  // R-AST-5 (partial): an unpinned promise date is never asserted.
  it('a promise whose date the assistant was unsure of asks for a date and never shows a due time', () => {
    const p = one(feedInputs({ tasks: [taskF({ kind: 'promise', dueAt: null, needsReview: true })] }));
    expect(p).toMatchObject({ itemType: 'promise_due', dueAt: null, score: 25 });
    expect(p.primaryAction).toEqual({ kind: 'open_task', label: 'Set the date', taskId: task(1) });
    expect(p.alternatives.map((a) => a.kind)).toEqual(['call', 'text', 'email', 'open_contact']);
  });

  it('all-day tasks are due at the end of their local day, across a DST change', () => {
    // 2026-11-01 is the US fall-back day: the local day is 25 hours long.
    const start = at('2026-11-01T04:00:00Z');
    expect(taskDeadline({ dueAt: start, dueAllDay: true, dueTz: NY })).toBe(at('2026-11-02T05:00:00Z'));
    expect(taskDeadline({ dueAt: start, dueAllDay: true, dueTz: null })).toBe(start + DAY_MS);
    expect(taskDeadline({ dueAt: null, dueAllDay: true, dueTz: NY })).toBeNull();
    const allDay = one(feedInputs({ tasks: [taskF({ dueAt: at('2026-11-10T05:00:00Z'), dueAllDay: true, dueTz: NY })] }));
    expect(allDay.dueAt).toBe(at('2026-11-11T05:00:00Z'));
    expect(codes(allDay)).toEqual(['TASK_DUE']);
  });

  it('contract-date windows match the exact DST-aware resolution on every day of a year, in several zones', () => {
    for (const z of ['America/New_York', 'America/Los_Angeles', 'Europe/London', 'Australia/Lord_Howe', 'America/Santiago', 'Asia/Kolkata', 'Pacific/Apia']) {
      const zz = zone(z);
      for (let day = 0; day < 366; day++) {
        const dueOn = localDate(new Date(Date.UTC(2026, 0, 1) + day * DAY_MS).toISOString().slice(0, 10));
        const start = resolveLocal(dueOn, localTime('00:00'), zz, 'earlier');
        expect(dealDateWindow({ dueOn, zone: zz })).toEqual({ start, end: addLocalDays(start, 1, zz) });
      }
    }
  });

  it('contract dates: today, coming up and passed, in the deal zone; Open deal is one tap', () => {
    const today = one(feedInputs({ dealDates: [dealDateF()] }));
    expect(today).toMatchObject({ itemType: 'deal_date', score: 40, dueAt: at('2026-11-11T05:00:00Z'), contactId: null });
    expect(today.reasons[0]?.label).toBe('Inspection date is today');
    expect(today.primaryAction.kind).toBe('open_deal');
    expect(today.alternatives.map((a) => a.kind)).toEqual(['complete_deal_date']);
    const soon = one(feedInputs({ dealDates: [dealDateF({ dueOn: localDate('2026-11-12'), kind: 'custom', label: 'HOA docs' })] }));
    expect(soon.reasons[0]?.label).toBe('HOA docs date in 38 h');
    const passed = one(feedInputs({ dealDates: [dealDateF({ dueOn: localDate('2026-11-08'), kind: 'closing' })] }));
    expect(codes(passed)).toEqual(['DEAL_DATE_PASSED', 'OVERDUE_OVER_DAY']);
    const la = one(feedInputs({ dealDates: [dealDateF({ dueOn: localDate('2026-11-09'), zone: zone('America/Los_Angeles') })] }));
    expect(la.reasons[0]?.label).toBe('Inspection date passed 7 h ago');
    expect(scoreFeed(feedInputs({ dealDates: [dealDateF({ dueOn: localDate('2026-11-13') }), dealDateF({ dealDateId: 'x' as never, completedAt: NOW }), dealDateF({ dealDateId: 'y' as never, userIds: [OTHER] })] }))).toEqual([]);
  });

  it('appointment outcome: shown once it ends; more urgent after 2 h; canceled, imported or logged ones are not shown', () => {
    const a = one(feedInputs({ appointments: [apptF()] }));
    expect(a).toMatchObject({ itemType: 'appointment_outcome', score: 35, dueAt: t(hours(1)) });
    expect(a.reasons[0]?.label).toBe('Buyer consult ended 1 h ago; log how it went');
    expect(a.primaryAction.kind).toBe('log_outcome');
    expect(codes(one(feedInputs({ appointments: [apptF({ endsAt: t(-hours(3)), contactId: null })] })))).toEqual(['OUTCOME_MISSING', 'OUTCOME_OVER_2H']);
    expect(
      scoreFeed(
        feedInputs({
          appointments: [
            apptF({ endsAt: t(min(30)) }),
            apptF({ appointmentId: 'b' as never, status: 'canceled' }),
            apptF({ appointmentId: 'c' as never, createdByKind: 'import' }),
            apptF({ appointmentId: 'd' as never, outcomeLoggedAt: NOW }),
            apptF({ appointmentId: 'e' as never, status: 'no_show' }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('pond leads: Claim while new; saved-search proposals: Review with unchecked criteria noted', () => {
    const p = one(feedInputs({ pondLeads: [pondLead()] }));
    expect(p).toMatchObject({ itemType: 'pond_new', score: 20 });
    expect(p.primaryAction.kind).toBe('claim');
    expect(scoreFeed(feedInputs({ pondLeads: [pondLead({ enteredAt: t(-hours(25)) }), pondLead({ contactId: contact(99), userIds: [OTHER] })] }))).toEqual([]);
    const s = one(feedInputs({ searchProposals: [proposal({ uncheckedCount: 2 })] }));
    expect(s.reasons.map((r) => r.label)).toEqual(['Saved search ready to review', '2 criteria need your check']);
    expect(one(feedInputs({ searchProposals: [proposal()] })).reasons[1]?.label).toBe('1 criterion needs your check');
    expect(one(feedInputs({ searchProposals: [proposal({ uncheckedCount: 0 })] })).reasons).toHaveLength(1);
  });

  it('each reason string in the catalog has a fixture that produces it', () => {
    const blocked = new Map([
      [contact(2), { voice: { outcome: 'deny' as const, explanation: 'Do Not Call list' } }],
      [contact(3), { sms: { outcome: 'deny' as const, explanation: 'Opted out of texts' }, voice: { outcome: 'unavailable' as const, explanation: 'No phone number' }, email: { outcome: 'unavailable' as const, explanation: 'No email address' } }],
      [contact(5), { sms: { outcome: 'deny' as const, explanation: 'Opted out of texts' } }],
      [contact(6), { email: { outcome: 'unavailable' as const, explanation: 'No email address' } }],
    ]);
    const fixtures: FeedInputs[] = [
      busyFeed(),
      feedInputs({ slas: [sla({ firstTouchDueAt: t(-min(1)) }), sla({ contactId: contact(8), periodSeq: 9 })], reinquiries: [reinq()], blockedChannels: blocked }),
      feedInputs({ unansweredInbound: [inbound({ at: t(-hours(5)) }), inbound({ id: msg(2), at: t(-hours(2)) }), inbound({ id: call(3), kind: 'missed_call', channel: 'voice', contactId: contact(30) })], blockedChannels: blocked }),
      feedInputs({ unansweredInbound: [inbound({ at: t(-hours(2)) })] }),
      feedInputs({ unansweredInbound: [inbound({ contactId: contact(5) })], drafts: [draft()] }),
      feedInputs({ drafts: [draft({ needsReview: true })], blockedChannels: blocked }),
      feedInputs({
        tasks: [
          taskF({ dueAt: t(-hours(30)) }),
          taskF({ taskId: task(2), dueAt: t(min(20)), kind: 'document' }),
          taskF({ taskId: task(3), kind: 'promise', dueAt: t(hours(2)), evidence: [{ sourceType: 'message', sourceId: msg(1), locator: { kind: 'message' }, snippet: 'call me tomorrow' }] }),
          taskF({ taskId: task(4), kind: 'promise', dueAt: t(-hours(2)) }),
          taskF({ taskId: task(5), kind: 'promise', dueAt: null, needsReview: true }),
        ],
        blockedChannels: blocked,
      }),
      feedInputs({ dealDates: [dealDateF({ dueOn: localDate('2026-11-12') }), dealDateF({ dealDateId: 'p' as never, dueOn: localDate('2026-11-01') })] }),
      feedInputs({ appointments: [apptF({ endsAt: t(-hours(3)) })], reinquiries: [reinq()], searchProposals: [proposal()] }),
    ];
    const seen = new Set(fixtures.flatMap((f) => scoreFeed(f).flatMap((x) => codes(x))));
    expect(FEED_REASON_CODES.filter((c) => !seen.has(c))).toEqual([]);
  });

  it('labels of bare reason codes written by core/ownership render from the catalog; unknown codes get an honest generic label', () => {
    for (const c of ['LEAD_OFFER', 'FIRST_TOUCH_DUE', 'REINQUIRY', 'INACTIVITY_WARNING']) expect(reasonFromCode(c)).toEqual({ code: c, label: FEED_REASONS[c as 'LEAD_OFFER'].label, points: FEED_REASONS[c as 'LEAD_OFFER'].points });
    expect(reasonFromCode('OFFER_ENDS')).toEqual({ code: 'OFFER_ENDS', label: 'The offer ends soon' });
    expect(reasonFromCode('SOMETHING_NEW')).toEqual({ code: 'SOMETHING_NEW', label: 'Needs your attention' });
  });
});

describe('scoreFeed: gate summary (blocked channels)', () => {
  const optedOut = { outcome: 'deny' as const, explanation: 'Opted out of texts' };

  it('a blocked SMS demotes the item but never hides it, and offers call/email instead', () => {
    const open = one(feedInputs({ unansweredInbound: [inbound()] }));
    const blocked = one(feedInputs({ unansweredInbound: [inbound()], blockedChannels: new Map([[contact(3), { sms: optedOut }]]) }));
    expect(blocked.itemType).toBe('unanswered_inbound');
    expect(blocked.score).toBe(open.score - 15);
    expect(blocked.primaryAction.kind).toBe('call');
    expect(blocked.alternatives.map((a) => a.kind)).toEqual(['email', 'open_contact']);
    expect(blocked.reasons.at(-1)).toEqual({ code: 'TEXT_BLOCKED', label: "Can't text: Opted out of texts", points: -15 });
  });

  it('a blocked SMS on a draft swaps Send for call/email and keeps Edit', () => {
    const d = one(feedInputs({ drafts: [draft()], blockedChannels: new Map([[contact(5), { sms: optedOut }]]) }));
    expect(d.primaryAction.kind).toBe('call');
    expect(d.alternatives.map((a) => a.kind)).toEqual(['email', 'edit_draft', 'open_contact']);
    expect(codes(d)).toContain('TEXT_BLOCKED');
  });

  it('a blocked reply channel on a handback with a draft falls back to the other channels', () => {
    const h = one(feedInputs({ handbacks: [handback({ replyDraftActionId: action(9) })], blockedChannels: new Map([[contact(4), { sms: optedOut }]]) }));
    expect(h.primaryAction.kind).toBe('call');
    expect(h.alternatives.map((a) => a.kind)).toEqual(['email', 'edit_draft', 'review_handback', 'open_contact']);
  });

  it('when every channel is blocked the card stays, opens the contact, and says why', () => {
    const all = {
      sms: optedOut,
      voice: { outcome: 'deny' as const, explanation: 'Opted out of calls' },
      email: { outcome: 'unavailable' as const, explanation: 'No email address' },
    };
    const s = one(feedInputs({ slas: [sla()], blockedChannels: new Map([[contact(2), all]]) }));
    expect(s.band).toBe('pinned');
    expect(s.primaryAction).toEqual({ kind: 'open_contact', label: 'Open', contactId: contact(2) });
    expect(s.alternatives).toEqual([]);
    expect(s.reasons.at(-1)).toEqual({ code: 'CANT_CONTACT', label: "Can't reach them right now: Opted out of calls · Opted out of texts · No email address", points: -30 });
    const noWhy = one(feedInputs({ slas: [sla()], blockedChannels: new Map([[contact(2), { sms: { outcome: 'deny' as const, explanation: '' }, voice: { outcome: 'deny' as const, explanation: '' }, email: { outcome: 'unavailable' as const, explanation: '' } }]]) }));
    expect(noWhy.reasons.at(-1)?.label).toBe("Can't reach them right now");
    const noWhyOne = one(feedInputs({ slas: [sla()], blockedChannels: new Map([[contact(2), { voice: { outcome: 'deny' as const, explanation: '' } }]]) }));
    expect(noWhyOne.reasons.at(-1)?.label).toBe("Can't call right now");
  });

  it('an email draft whose channel is blocked emails nothing and offers a call', () => {
    const d = one(feedInputs({ drafts: [draft({ channel: 'email' })], blockedChannels: new Map([[contact(5), { email: { outcome: 'deny' as const, explanation: 'Opted out of email' } }]]) }));
    expect(d.primaryAction.kind).toBe('call');
    expect(d.alternatives.map((a) => a.kind)).toEqual(['text', 'edit_draft', 'open_contact']);
  });
});

describe('scoreFeed: ordering, visibility, invariants', () => {
  it('pinned (deadline ascending) come first, then scored by score; ties by deadline, createdAt, key', () => {
    const items = scoreFeed(busyFeed());
    const { pinned, scored } = splitBands(items);
    expect(items).toEqual([...pinned, ...scored]);
    expect(pinned.map((x) => x.itemType)).toEqual(['lead_offer', 'first_touch_due', 'inactivity_warning']);
    for (let k = 1; k < scored.length; k++) expect((scored[k - 1] as FeedItem).score).toBeGreaterThanOrEqual((scored[k] as FeedItem).score);
    for (let k = 1; k < items.length; k++) expect(compareFeedItems(items[k - 1] as FeedItem, items[k] as FeedItem)).toBeLessThan(0);
  });

  it('tie-breaks: pinned with no deadline sort last; equal scores order by deadline then createdAt then key', () => {
    const base = scoreFeed(feedInputs({ drafts: [draft()] }))[0] as FeedItem;
    const mk = (o: Partial<FeedItem>): FeedItem => ({ ...base, ...o });
    const a = mk({ band: 'pinned', dueAt: null, dedupeKey: 'a' });
    const b = mk({ band: 'pinned', dueAt: t(1), dedupeKey: 'b' });
    expect(compareFeedItems(b, a)).toBeLessThan(0);
    expect(compareFeedItems(a, b)).toBeGreaterThan(0);
    expect(compareFeedItems(mk({ dueAt: t(1) }), mk({ dueAt: t(2) }))).toBeLessThan(0);
    expect(compareFeedItems(mk({ createdAt: t(1) }), mk({ createdAt: t(2) }))).toBeLessThan(0);
    expect(compareFeedItems(mk({ dedupeKey: 'x' }), mk({ dedupeKey: 'y' }))).toBeLessThan(0);
    expect(compareFeedItems(mk({ dedupeKey: 'y' }), mk({ dedupeKey: 'x' }))).toBeGreaterThan(0);
    expect(compareFeedItems(mk({}), mk({}))).toBe(0);
    expect(compareFeedItems(mk({ band: 'pinned', dueAt: t(1), score: 10 }), mk({ band: 'pinned', dueAt: t(1), score: 20 }))).toBeGreaterThan(0);
  });

  it('deterministic ordering: any shuffle of every input list gives the same feed (property)', () => {
    const input = busyFeed(120);
    const expected = scoreFeed(input);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 }), (seed) => {
        const s = (k: number) => seed + k;
        const blocked = new Map(shuffled([...input.blockedChannels.entries()], s(99)));
        const shuffledInput: FeedInputs = {
          ...input,
          offers: shuffled(input.offers, s(1)),
          slas: shuffled(input.slas, s(2)),
          unansweredInbound: shuffled(input.unansweredInbound, s(3)),
          handbacks: shuffled(input.handbacks, s(4)),
          drafts: shuffled(input.drafts, s(5)),
          tasks: shuffled(input.tasks, s(6)),
          dealDates: shuffled(input.dealDates, s(7)),
          appointments: shuffled(input.appointments, s(8)),
          reinquiries: shuffled(input.reinquiries ?? [], s(9)),
          blockedChannels: blocked,
        };
        expect(scoreFeed(shuffledInput)).toEqual(expected);
      }),
      { numRuns: 60 },
    );
  });

  it('duplicate input rows give one item per dedupe key, chosen independently of input order', () => {
    const a = taskF({ dueAt: t(hours(1)) });
    const b = taskF({ dueAt: t(hours(2)) });
    const x = scoreFeed(feedInputs({ tasks: [a, b] }));
    const y = scoreFeed(feedInputs({ tasks: [b, a] }));
    expect(x).toHaveLength(1);
    expect(x).toEqual(y);
    // Full ties on the sort keys fall back to content.
    const c = draft({ explanation: 'first' });
    const d = draft({ explanation: 'second' });
    expect(scoreFeed(feedInputs({ drafts: [c, d] }))).toEqual(scoreFeed(feedInputs({ drafts: [d, c] })));
  });

  it("rows that belong to another user never produce items (stale after reassignment)", () => {
    const theirs = feedInputs({
      offers: [offer({ offeredToUserId: OTHER })],
      slas: [sla({ ownerUserId: OTHER })],
      unansweredInbound: [inbound({ ownerUserId: OTHER })],
      handbacks: [handback({ ownerUserId: OTHER })],
      drafts: [draft({ ownerUserId: OTHER })],
      tasks: [taskF({ assigneeUserId: OTHER })],
      dealDates: [dealDateF({ userIds: [OTHER] })],
      appointments: [apptF({ userId: OTHER })],
      reinquiries: [reinq({ ownerUserId: OTHER })],
      inactivityWarnings: [inactivity({ ownerUserId: OTHER })],
      pondLeads: [pondLead({ userIds: [OTHER] })],
      searchProposals: [proposal({ ownerUserId: OTHER })],
    });
    expect(scoreFeed(theirs)).toEqual([]);
    expect(scoreFeed({ ...theirs, userId: OTHER })).toHaveLength(12);
  });

  it('every item validates against the stored/serialized schema: score 0..100, ≥ 1 reason, score = sum of points', () => {
    const items = scoreFeed(busyFeed(200));
    expect(items.length).toBeGreaterThan(150);
    for (const it of items) {
      expect(FeedItemSchema.parse(it)).toEqual(it);
      expect(it.reasons.length).toBeGreaterThanOrEqual(1);
      expect(it.score).toBe(scoreOf(it.reasons));
    }
    expect(scoreOf([{ code: 'A', label: 'a', points: 90 }, { code: 'B', label: 'b', points: 95 }])).toBe(100);
    expect(scoreOf([{ code: 'A', label: 'a', points: -40 }])).toBe(0);
  });

  it('R-AST-12: extra protected-proxy data smuggled onto inputs never changes the feed', () => {
    const clean = busyFeed(40);
    const smuggle = <T extends object>(xs: T[]): T[] =>
      xs.map((x) => ({ ...x, protected_proxy: true, attributes: { va_loan: true, military_status: 'active', source_of_income: 'voucher' }, sensitivity: 'protected_proxy' }));
    const dirty: FeedInputs = {
      ...clean,
      offers: smuggle(clean.offers),
      slas: smuggle(clean.slas),
      unansweredInbound: smuggle(clean.unansweredInbound),
      handbacks: smuggle(clean.handbacks),
      drafts: smuggle(clean.drafts),
      tasks: smuggle(clean.tasks),
      dealDates: smuggle(clean.dealDates),
      appointments: smuggle(clean.appointments),
    };
    expect(scoreFeed(dirty)).toEqual(scoreFeed(clean));
  });

  it('labels never carry contact data (names, numbers, addresses are not inputs)', () => {
    const labels = scoreFeed(busyFeed(80)).flatMap((x) => [...x.reasons.map((r) => r.label), x.primaryAction.label]);
    for (const l of labels) {
      expect(l).not.toMatch(/\+?\d{10,}/);
      expect(l).not.toMatch(/@/);
      expect(l).not.toMatch(/confiden|probab|likely to/i);
    }
  });
});

describe('scoreFeed: one card per conversation and edge inputs', () => {
  it('A1 Text → Send: a pending reply draft rides on the waiting card’s Text action, with no second card', () => {
    const items = scoreFeed(feedInputs({ unansweredInbound: [inbound({ contactId: contact(5) })], drafts: [draft({ createdAt: t(-min(30)) }), draft({ actionId: action(7) })] }));
    expect(items.map((x) => x.itemType)).toEqual(['unanswered_inbound']);
    const it = items[0] as FeedItem;
    expect(it.primaryAction).toEqual({ kind: 'text', label: 'Text', contactId: contact(5), draftActionId: action(7) });
    expect(it.assistantActionId).toBe(action(7));
    expect(codes(it)).toEqual(['CLIENT_WAITING', 'REPLY_DRAFTED']);
    // same-instant drafts: the higher id wins, whatever the order
    const tie = (ds: ReturnType<typeof draft>[]) => scoreFeed(feedInputs({ unansweredInbound: [inbound({ contactId: contact(5) })], drafts: ds }))[0]?.assistantActionId;
    expect(tie([draft({ actionId: action(3) }), draft({ actionId: action(4) })])).toBe(action(4));
    expect(tie([draft({ actionId: action(4) }), draft({ actionId: action(3) })])).toBe(action(4));
  });

  it('a folded email draft makes Email the primary with the draft; a draft needing review says so', () => {
    const it = one(feedInputs({ unansweredInbound: [inbound({ contactId: contact(5) })], drafts: [draft({ channel: 'email', needsReview: true })] }));
    expect(it.primaryAction).toEqual({ kind: 'email', label: 'Email', contactId: contact(5), draftActionId: action(2) });
    expect(it.reasons.map((r) => r.label)).toEqual(['They texted 20 min ago; no reply yet', 'Reply email drafted for you', 'Check this: a detail needs your OK']);
    // a draft for a contact who is not waiting stays its own card
    expect(scoreFeed(feedInputs({ unansweredInbound: [inbound()], drafts: [draft()] })).map((x) => x.itemType).sort()).toEqual(['assistant_draft', 'unanswered_inbound']);
  });

  it('a handback with no known inbound channel offers a call first', () => {
    expect(one(feedInputs({ handbacks: [handback({ inboundChannel: null })] })).primaryAction.kind).toBe('call');
  });

  it('an offer with no lead source shows no source reason', () => {
    expect(codes(one(feedInputs({ offers: [offer({ sourceName: null })] })))).toEqual(['LEAD_OFFER', 'OFFER_ENDS']);
  });

  it('two current SLA periods for one contact (bad input) still fold re-inquiries into one card deterministically', () => {
    const a = sla({ contactId: contact(8), periodSeq: 3 });
    const b = sla({ contactId: contact(8), periodSeq: 4 });
    const run = (xs: typeof a[]) => scoreFeed(feedInputs({ slas: xs, reinquiries: [reinq()] }));
    expect(run([a, b])).toEqual(run([b, a]));
    expect(run([a, b]).filter((x) => codes(x).includes('ASKED_AGAIN')).map((x) => x.dedupeKey)).toEqual([`first_touch:${contact(8)}:4`]);
  });

  it('messages at the same instant order by id, so the card key is stable', () => {
    const x = inbound({ id: msg(5) });
    const y = inbound({ id: msg(6) });
    expect(one(feedInputs({ unansweredInbound: [x, y] })).dedupeKey).toBe(`inbound:${contact(3)}:${msg(6)}`);
    expect(one(feedInputs({ unansweredInbound: [y, x] })).dedupeKey).toBe(`inbound:${contact(3)}:${msg(6)}`);
  });

  it('a custom contract date without a label is called a contract date', () => {
    expect(one(feedInputs({ dealDates: [dealDateF({ kind: 'custom', label: null })] })).reasons[0]?.label).toBe('Contract date is today');
  });
});
