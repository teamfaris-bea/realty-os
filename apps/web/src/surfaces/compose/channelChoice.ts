// Which channel the compose box writes on, and the one line that says why (module 37, PHASE2_3_PLAN §5.4).
//
// - The box defaults to the client's last OPEN channel: the channel of their latest message (text, email or
//   web chat), unless that channel cannot be used now. A channel cannot be used when the reachability
//   summary says it is blocked (an opt-out or suppression, D1: STOP on any of their phones, including a
//   removed one, R-PAR-12; an unsubscribe; an agent-recorded or person-level do-not-contact) or, for web
//   chat, when a send already came back CHANNEL_NOT_CONNECTED (the chat ended, E77, or the widget was
//   disconnected, R-INBOX-7).
// - Opened to write on a named channel (a Text or Email tap, or an assistant draft), the box keeps it unless
//   it cannot be used. The agent's own tap always wins among the usable ones.
// - A channel that cannot be used is never offered: it is shown, disabled, with the reason in the exact
//   words of the reachability summary (reasons/sentences.ts), instead of being hidden.
// - Whenever the box is not on the channel the client wrote on last, `why` says why in plain words.
//
// D2: there is no Messenger or Instagram channel and no messaging-window rule anywhere here.
import type { ChannelState } from '../../reasons/index.js';
import type { ComposeChannel } from './channelApi.js';

export interface ChannelOption {
  channel: ComposeChannel;
  /** the radio label */
  label: string;
  /** usable now (has an address or a chat, and nothing blocks it) */
  open: boolean;
  /** why it is not offered, in the reachability summary's words (or the chat-ended sentence); null when open */
  reason: string | null;
}

export interface ChoiceInput {
  firstName: string;
  canText: boolean;
  canEmail: boolean;
  /** the client has written by web chat (there is a web-chat message in the thread) */
  hasWebChat: boolean;
  sms: ChannelState;
  email: ChannelState;
  /** a web-chat send came back CHANNEL_NOT_CONNECTED in this box */
  webChatEnded: boolean;
  /** the channel of the client's latest message, or null when they never wrote */
  lastInbound: ComposeChannel | null;
  /** opened to write on this channel (a Text / Email tap, an assistant draft) */
  requested: ComposeChannel | null;
  /** the agent's own tap */
  picked: ComposeChannel | null;
}

export interface Choice {
  /** null: no channel can be used now (every option is shown with its reason) */
  channel: ComposeChannel | null;
  options: ChannelOption[];
  /** one sentence: why the box is on this channel when it is not where the client wrote last; null when nothing to say */
  why: string | null;
}

export const CHANNEL_LABEL: Record<ComposeChannel, string> = {
  sms: 'Text',
  email: 'Email',
  web_chat: 'Web chat',
};
const BY: Record<ComposeChannel, string> = {
  sms: 'by text',
  email: 'by email',
  web_chat: 'in web chat',
};
const BLOCKED: Record<ComposeChannel, string> = {
  sms: 'texting is blocked',
  email: 'email is blocked',
  web_chat: 'the web chat has ended',
};

export const WEB_CHAT_ENDED =
  'The chat has ended: they left the page or the widget was disconnected';

/** The channel of an inbound timeline message ("sms:inbound" → sms); null for anything compose cannot answer on. */
export function composeChannelOf(detail: string | null): ComposeChannel | null {
  const ch = (detail ?? '').split(':')[0];
  if (ch === 'sms' || ch === 'mms') return 'sms';
  if (ch === 'email') return 'email';
  if (ch === 'web_chat') return 'web_chat';
  return null;
}

export function chooseChannel(i: ChoiceInput): Choice {
  const options: ChannelOption[] = [];
  if (i.canText)
    options.push({
      channel: 'sms',
      label: CHANNEL_LABEL.sms,
      open: !i.sms.blocked,
      reason: i.sms.blocked ? i.sms.sentence : null,
    });
  if (i.canEmail)
    options.push({
      channel: 'email',
      label: CHANNEL_LABEL.email,
      open: !i.email.blocked,
      reason: i.email.blocked ? i.email.sentence : null,
    });
  if (i.hasWebChat)
    options.push({
      channel: 'web_chat',
      label: CHANNEL_LABEL.web_chat,
      open: !i.webChatEnded,
      reason: i.webChatEnded ? WEB_CHAT_ENDED : null,
    });
  const open = (c: ComposeChannel | null): c is ComposeChannel =>
    c !== null && options.some((o) => o.channel === c && o.open);

  // the agent's tap, then what the box was opened for, then where the client wrote last, then the usual order
  const order: (ComposeChannel | null)[] = [
    i.picked,
    i.requested,
    i.lastInbound,
    'sms',
    'email',
    'web_chat',
  ];
  const channel = order.find(open) ?? null;
  if (channel === null) return { channel, options, why: null };

  // the channel the box was meant to be on (by the agent or by default) and could not be
  const meant =
    [i.picked, i.requested, i.lastInbound].find(
      (c): c is ComposeChannel =>
        c !== null && options.some((o) => o.channel === c),
    ) ?? null;
  let why: string | null = null;
  if (meant !== null && meant !== channel) {
    why = `Writing ${BY[channel]}: ${BLOCKED[meant]}.`;
  } else if (i.lastInbound !== null && channel === i.lastInbound) {
    why = `Replying ${BY[channel]}, where ${i.firstName} wrote last.`;
  } else if (
    i.lastInbound !== null &&
    options.some((o) => o.channel === i.lastInbound)
  ) {
    why = `${i.firstName} wrote last ${BY[i.lastInbound]}.`;
  }
  return { channel, options, why };
}
