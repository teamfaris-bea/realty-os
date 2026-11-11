// chooseChannel (module 37): exhaustive over every combination of addresses, blocks, an ended chat, the
// client's last channel, the channel the box was opened for and the agent's tap (3 × 2^5 × 4^3 = 6,144
// cases). The properties are the rules, so a mutation of the decision fails here:
//   D1 / R-PAR-12  a blocked (or ended) channel is never chosen and every one carries its reason;
//                  no channel at all only when nothing is open
//   module 37      with nothing asked for, the box is on the client's last open channel; a usable tap wins
//                  next, then the channel it was opened for; whenever the box is not where the client wrote
//                  last (and that channel is an option), it says why
//   D2             no option is ever Messenger or Instagram
import { describe, expect, it } from 'vitest';
import type { ChannelState } from '../../reasons/index.js';
import type { ComposeChannel } from './channelApi.js';
import { type ChoiceInput, WEB_CHAT_ENDED, chooseChannel, composeChannelOf } from './channelChoice.js';

const OPEN: ChannelState = { blocked: false, sentence: null, note: null };
const STOPPED: ChannelState = { blocked: true, sentence: 'Texted STOP on Nov 10', note: null };
const UNSUB: ChannelState = { blocked: true, sentence: 'Unsubscribed from email on Nov 10', note: null };
const CH: (ComposeChannel | null)[] = [null, 'sms', 'email', 'web_chat'];
const bools = [false, true];

function* cases(): Generator<ChoiceInput> {
  for (const canText of bools)
    for (const canEmail of bools)
      for (const hasWebChat of bools)
        for (const smsBlocked of bools)
          for (const emailBlocked of bools)
            for (const webChatEnded of [false, true, false])
              for (const lastInbound of CH)
                for (const requested of CH)
                  for (const picked of CH)
                    yield { firstName: 'Jane', canText, canEmail, hasWebChat, sms: smsBlocked ? STOPPED : OPEN, email: emailBlocked ? UNSUB : OPEN, webChatEnded, lastInbound, requested, picked };
}

const isOpen = (i: ChoiceInput, c: ComposeChannel) => (c === 'sms' ? i.canText && !i.sms.blocked : c === 'email' ? i.canEmail && !i.email.blocked : i.hasWebChat && !i.webChatEnded);
const isOption = (i: ChoiceInput, c: ComposeChannel) => (c === 'sms' ? i.canText : c === 'email' ? i.canEmail : i.hasWebChat);

describe('chooseChannel (module 37, D1, R-PAR-12)', () => {
  it('D1 R-PAR-12: never chooses a channel the person cannot be reached on; every blocked option carries its reason; null only when nothing is open', () => {
    let n = 0;
    for (const i of cases()) {
      n += 1;
      const c = chooseChannel(i);
      if (c.channel !== null) expect(isOpen(i, c.channel), JSON.stringify(i)).toBe(true);
      expect(c.channel === null, JSON.stringify(i)).toBe(!(['sms', 'email', 'web_chat'] as const).some((x) => isOpen(i, x)));
      for (const o of c.options) {
        expect(o.open).toBe(isOpen(i, o.channel));
        if (!o.open) expect(o.reason).toBe(o.channel === 'sms' ? STOPPED.sentence : o.channel === 'email' ? UNSUB.sentence : WEB_CHAT_ENDED);
        else expect(o.reason).toBeNull();
      }
      expect(c.options.map((o) => o.channel)).toEqual((['sms', 'email', 'web_chat'] as const).filter((x) => isOption(i, x)));
    }
    expect(n).toBe(6144);
  });

  it('module 37: precedence is the agent\'s usable tap, then the channel the box was opened for, then the client\'s last open channel', () => {
    for (const i of cases()) {
      const c = chooseChannel(i);
      const expected = [i.picked, i.requested, i.lastInbound, 'sms', 'email', 'web_chat'].find((x): x is ComposeChannel => x !== null && isOpen(i, x as ComposeChannel)) ?? null;
      expect(c.channel, JSON.stringify(i)).toBe(expected);
      if (i.picked === null && i.requested === null && i.lastInbound !== null && isOpen(i, i.lastInbound)) expect(c.channel).toBe(i.lastInbound);
    }
  });

  it('module 37: whenever the box is not on the channel the client wrote on last, it says why', () => {
    for (const i of cases()) {
      const c = chooseChannel(i);
      if (c.channel === null) {
        expect(c.why).toBeNull();
        continue;
      }
      if (i.lastInbound !== null && isOption(i, i.lastInbound) && c.channel !== i.lastInbound) expect(c.why, JSON.stringify(i)).not.toBeNull();
      if (i.lastInbound !== null && c.channel === i.lastInbound && i.picked === null && i.requested === null) expect(c.why).toBe(`Replying ${c.channel === 'sms' ? 'by text' : c.channel === 'email' ? 'by email' : 'in web chat'}, where Jane wrote last.`);
      // a reason given for leaving a channel names a channel that really is closed
      const left = /: (texting is blocked|email is blocked|the web chat has ended)\.$/.exec(c.why ?? '')?.[1];
      if (left === 'texting is blocked') expect(isOpen(i, 'sms')).toBe(false);
      if (left === 'email is blocked') expect(isOpen(i, 'email')).toBe(false);
      if (left === 'the web chat has ended') expect(isOpen(i, 'web_chat')).toBe(false);
    }
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
