// chooseChannel (module 37): exhaustive over every combination of addresses, blocks, the web chat as the
// reachability summary tells it (unknown, none to reply to, open, ended, turned off, opted out), a send that just came
// back CHANNEL_NOT_CONNECTED, the client's last channel, the channel the box was opened for and the agent's tap
// (2^4 × 6 × 2 × 4^3 = 12,288 cases). The properties are the rules, so a mutation of the decision fails here:
//   D1 / R-PAR-12  a blocked (or ended) channel is never chosen and every one carries its reason;
//                  no channel at all only when nothing is open
//   module 22/37   web chat is offered only while the summary says there is a chat; it is closed, with the
//                  summary's reason, when the chat ended, the widget was turned off or the person opted out
//   module 37      with nothing asked for, the box is on the client's last open channel; a usable tap wins
//                  next, then the channel it was opened for; whenever the box is not where the client wrote
//                  last (and that channel is an option), it says why; asked for a chat the summary has nothing
//                  to reply to, it says so (review ui-compose/F2)
//   D2             no option is ever Messenger or Instagram
import { describe, expect, it } from 'vitest';
import type { ChannelState, ChatReach, Reachability, ReachReason } from '../../reasons/index.js';
import type { ComposeChannel } from './channelApi.js';
import { CHAT_NOT_HERE, CHAT_SESSION_ENDED, CHAT_TURNED_OFF, type ChoiceInput, WEB_CHAT_ENDED, type WebChatState, chooseChannel, composeChannelOf, replyChatState, webChatState } from './channelChoice.js';

const OPEN: ChannelState = { blocked: false, sentence: null, note: null };
const STOPPED: ChannelState = { blocked: true, sentence: 'Texted STOP on Nov 10', note: null };
const UNSUB: ChannelState = { blocked: true, sentence: 'Unsubscribed from email on Nov 10', note: null };
const CHATS: WebChatState[] = [
  // the summary unknown and no chat in the thread; then the summary in, with no chat to reply to (review ui-compose/F2)
  { offered: false, blocked: false, sentence: null, note: null, left: 'the web chat has ended', missing: false },
  { offered: false, blocked: false, sentence: null, note: null, left: 'the web chat has ended', missing: true },
  { offered: true, blocked: false, sentence: null, note: null, left: 'the web chat has ended', missing: false },
  { offered: true, blocked: true, sentence: CHAT_SESSION_ENDED, note: null, left: 'the web chat has ended', missing: false },
  { offered: true, blocked: true, sentence: CHAT_TURNED_OFF, note: null, left: 'the website chat was turned off', missing: false },
  { offered: true, blocked: true, sentence: 'Asked in the chat to stop being contacted on Nov 10', note: null, left: 'web chat is blocked', missing: false },
];
const CH: (ComposeChannel | null)[] = [null, 'sms', 'email', 'web_chat'];
const bools = [false, true];

function* cases(): Generator<ChoiceInput> {
  for (const canText of bools)
    for (const canEmail of bools)
      for (const webChat of CHATS)
        for (const smsBlocked of bools)
          for (const emailBlocked of bools)
            for (const webChatEnded of bools)
              for (const lastInbound of CH)
                for (const requested of CH)
                  for (const picked of CH)
                    yield { firstName: 'Jane', canText, canEmail, webChat, sms: smsBlocked ? STOPPED : OPEN, email: emailBlocked ? UNSUB : OPEN, webChatEnded, lastInbound, requested, picked };
}

const isOpen = (i: ChoiceInput, c: ComposeChannel) => (c === 'sms' ? i.canText && !i.sms.blocked : c === 'email' ? i.canEmail && !i.email.blocked : i.webChat.offered && !i.webChat.blocked && !i.webChatEnded);
const isOption = (i: ChoiceInput, c: ComposeChannel) => (c === 'sms' ? i.canText : c === 'email' ? i.canEmail : i.webChat.offered);

describe('chooseChannel (module 37, D1, R-PAR-12)', () => {
  it('D1 R-PAR-12 R-INBOX-7: never chooses a channel the person cannot be reached on; every blocked option carries its reason; null only when nothing is open', () => {
    let n = 0;
    for (const i of cases()) {
      n += 1;
      const c = chooseChannel(i);
      if (c.channel !== null) expect(isOpen(i, c.channel), JSON.stringify(i)).toBe(true);
      expect(c.channel === null, JSON.stringify(i)).toBe(!(['sms', 'email', 'web_chat'] as const).some((x) => isOpen(i, x)));
      for (const o of c.options) {
        expect(o.open).toBe(isOpen(i, o.channel));
        if (!o.open) expect(o.reason).toBe(o.channel === 'sms' ? STOPPED.sentence : o.channel === 'email' ? UNSUB.sentence : i.webChatEnded ? WEB_CHAT_ENDED : i.webChat.sentence);
        else expect(o.reason).toBeNull();
      }
      expect(c.options.map((o) => o.channel)).toEqual((['sms', 'email', 'web_chat'] as const).filter((x) => isOption(i, x)));
    }
    expect(n).toBe(12_288);
  });

  it('module 37: precedence is the agent\'s usable tap, then the channel the box was opened for, then the client\'s last open channel', () => {
    for (const i of cases()) {
      const c = chooseChannel(i);
      const expected = [i.picked, i.requested, i.lastInbound, 'sms', 'email', 'web_chat'].find((x): x is ComposeChannel => x !== null && isOpen(i, x as ComposeChannel)) ?? null;
      expect(c.channel, JSON.stringify(i)).toBe(expected);
      if (i.picked === null && i.requested === null && i.lastInbound !== null && isOpen(i, i.lastInbound)) expect(c.channel).toBe(i.lastInbound);
    }
  });

  it('module 37: whenever the box is not on the channel the client wrote on last, it says why, naming a channel that really is closed', () => {
    for (const i of cases()) {
      const c = chooseChannel(i);
      if (c.channel === null) {
        expect(c.why).toBeNull();
        continue;
      }
      if (i.lastInbound !== null && isOption(i, i.lastInbound) && c.channel !== i.lastInbound) expect(c.why, JSON.stringify(i)).not.toBeNull();
      if (i.lastInbound !== null && c.channel === i.lastInbound && i.picked === null && i.requested === null) expect(c.why).toBe(`Replying ${c.channel === 'sms' ? 'by text' : c.channel === 'email' ? 'by email' : 'in web chat'}, where Jane wrote last.`);
      const left = /: (texting is blocked|email is blocked|the web chat has ended|the website chat was turned off|web chat is blocked)\.$/.exec(c.why ?? '')?.[1];
      if (left === 'texting is blocked') expect(isOpen(i, 'sms')).toBe(false);
      if (left === 'email is blocked') expect(isOpen(i, 'email')).toBe(false);
      if (left !== undefined && left.includes('chat')) {
        expect(isOpen(i, 'web_chat')).toBe(false);
        expect(left).toBe(i.webChatEnded ? 'the web chat has ended' : i.webChat.left);
      }
    }
  });

  it('review ui-compose/F2: asked to reply in a web chat the summary has nothing to reply to (a Reply tap, the agent\'s tap, or the client wrote last there), the box never moves to another channel silently: it says the chat cannot be answered from this record, unless another channel it was meant to be on is closed', () => {
    for (const i of cases()) {
      const c = chooseChannel(i);
      const notHere = (c.why ?? '').endsWith(": this website chat can't be answered from this record.");
      const asked = [i.picked, i.requested, i.lastInbound].includes('web_chat');
      if (notHere) expect(i.webChat.missing && asked && c.channel !== 'web_chat', JSON.stringify(i)).toBe(true);
      const meant = [i.picked, i.requested, i.lastInbound].find((x): x is ComposeChannel => x !== null && isOption(i, x)) ?? null;
      if (c.channel !== null && i.webChat.missing && asked && (meant === null || meant === c.channel)) expect(notHere, JSON.stringify(i)).toBe(true);
    }
    const none = { hasAddress: false, defaultPointId: null, blocked: false, reasons: [], points: [] };
    const summary = (web_chat: ChatReach): Reachability => ({ contactId: '01900000-0000-7000-8000-00000000c001', purposeNow: 'informational', channels: { sms: none, voice: none, email: none, web_chat } });
    const noChat = summary({ ...none, session: null });
    const openChat = summary({ hasAddress: true, defaultPointId: '01900000-0000-7000-8000-00000000ac01', blocked: false, reasons: [], points: [], session: { open: true, widgetConnected: true } });
    expect(webChatState(noChat, true)).toMatchObject({ offered: false, blocked: false, missing: true });
    expect(webChatState(null, true)).toMatchObject({ offered: true, missing: false });
    expect(replyChatState(noChat)).toEqual({ blocked: true, sentence: CHAT_NOT_HERE, note: null });
    expect(replyChatState(openChat)).toEqual({ blocked: false, sentence: null, note: null });
    expect(replyChatState(null)).toEqual({ blocked: false, sentence: null, note: null });
  });

  it('D2: no option, label or sentence is ever Messenger, Instagram or a messaging window', () => {
    for (const i of cases()) {
      const c = chooseChannel(i);
      const words = JSON.stringify(c);
      expect(words).not.toMatch(/messenger|instagram|facebook|window/i);
    }
    expect(composeChannelOf('messenger:inbound')).toBeNull();
    expect(composeChannelOf('instagram:inbound')).toBeNull();
    expect(composeChannelOf('web_chat:inbound')).toBe('web_chat');
    expect(composeChannelOf('mms:inbound')).toBe('sms');
    expect(composeChannelOf(null)).toBeNull();
  });
});

describe('webChatState: the web chat as channels.web_chat tells it (module 22)', () => {
  const POINT = '01900000-0000-7000-8000-00000000ac01';
  const chat = (over: Partial<ChatReach> = {}): Reachability => {
    const none = { hasAddress: false, defaultPointId: null, blocked: false, reasons: [], points: [] };
    return { contactId: '01900000-0000-7000-8000-00000000c001', purposeNow: 'informational', channels: { sms: none, voice: none, email: none, web_chat: { hasAddress: true, defaultPointId: POINT, blocked: false, reasons: [], points: [], session: { open: true, widgetConnected: true }, ...over } } };
  };
  const optOut: ReachReason = { code: 'CONSENT_REVOKED', source: 'opt_out_language', purposes: ['informational', 'marketing'], at: '2026-11-10T15:00:00.000Z', keyword: null, recordedBy: null, importBatchId: null, suppressionReason: null, addressHint: 'web chat', otherAddress: false, evidence: { consentEventId: null, inboundMessageId: null, callId: null, suppressionId: null } };

  it('an open chat is offered; an ended chat, a widget turned off and an opt-out are offered closed, each with its own words', () => {
    expect(webChatState(chat(), false)).toMatchObject({ offered: true, blocked: false, sentence: null });
    expect(webChatState(chat({ blocked: true, session: { open: false, widgetConnected: true } }), true)).toMatchObject({ offered: true, blocked: true, sentence: 'The chat has ended: they left the page', left: 'the web chat has ended' });
    expect(webChatState(chat({ blocked: true, session: { open: true, widgetConnected: false } }), true)).toMatchObject({ offered: true, blocked: true, sentence: 'The website chat was turned off', left: 'the website chat was turned off' });
    expect(webChatState(chat({ blocked: true, reasons: [optOut], session: { open: false, widgetConnected: false } }), true)).toMatchObject({ offered: true, blocked: true, sentence: 'Asked in the chat to stop being contacted on Nov 10', left: 'web chat is blocked' });
  });

  it('no chat to reply to is no option, whatever the thread shows; while the summary is unknown the thread decides and nothing is blocked', () => {
    expect(webChatState(chat({ hasAddress: false, defaultPointId: null, session: null }), true)).toMatchObject({ offered: false, blocked: false });
    expect(webChatState(null, true)).toMatchObject({ offered: true, blocked: false });
    expect(webChatState(null, false)).toMatchObject({ offered: false, blocked: false });
    const older = chat();
    delete older.channels.web_chat;
    expect(webChatState(older, true)).toMatchObject({ offered: true, blocked: false });
  });
});
