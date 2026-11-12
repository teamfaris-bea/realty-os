// Which channel the compose box writes on, and the one line that says why (module 37, PHASE2_3_PLAN §5.4).
//
// - The box defaults to the client's last OPEN channel: the channel of their latest message (text, email or
//   web chat), unless that channel cannot be used now. A channel cannot be used when the reachability
//   summary says it is blocked: for texts and email an opt-out or suppression (D1: STOP on any of their phones,
//   including a removed one, R-PAR-12; an unsubscribe; an agent-recorded or person-level do-not-contact); for web
//   chat its own entry (module 22, channels.web_chat): the chat ended (the visitor has been gone 30 minutes, E77),
//   the website chat was turned off (R-INBOX-7), or an opt-out. Web chat is also closed when a send in this box just
//   came back CHANNEL_NOT_CONNECTED (it ended between the summary and the tap).
// - Web chat is an option only when the contact has a chat to reply to, as the summary says; while the summary is
//   unknown (loading, failed, or an API without the entry) the thread's own web-chat messages decide, and the
//   send-time check decides the rest, as always.
// - Opened to write on a named channel (a Text or Email tap, or an assistant draft), the box keeps it unless
//   it cannot be used. The agent's own tap always wins among the usable ones.
// - A channel that cannot be used is never offered: it is shown, disabled, with the reason in the exact
//   words of the reachability summary (reasons/sentences.ts), instead of being hidden.
// - Whenever the box is not on the channel the client wrote on last, `why` says why in plain words. That includes a
//   chat the summary has nothing to reply to although the box was opened to reply there (the feed's Reply) or the
//   client wrote last there (review ui-compose/F2): the box never moves to Text silently.
//
// D2: there is no Messenger or Instagram channel and no messaging-window rule anywhere here.
import { type ChannelState, type Reachability, reachSentence } from '../../reasons/index.js';
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

/** Web chat as the reachability summary tells it (webChatState). */
export interface WebChatState extends ChannelState {
  /** the contact has a website chat to reply to */
  offered: boolean;
  /** completes "Writing by text: …" when the box left web chat because of it */
  left: string;
  /** the summary is in and has no chat to reply to (none was ever there, or none can be answered from this record) */
  missing: boolean;
}

export interface ChoiceInput {
  firstName: string;
  canText: boolean;
  canEmail: boolean;
  sms: ChannelState;
  email: ChannelState;
  webChat: WebChatState;
  /** a web-chat send in this box came back CHANNEL_NOT_CONNECTED */
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

/** A send in this box came back CHANNEL_NOT_CONNECTED: one of the two happened, and the summary will say which. */
export const WEB_CHAT_ENDED = 'The chat has ended: they left the page or the widget was disconnected';
/** channels.web_chat.session.open is false: the visitor has been gone 30 minutes (E77) */
export const CHAT_SESSION_ENDED = 'The chat has ended: they left the page';
/** channels.web_chat.session.widgetConnected is false (R-INBOX-7) */
export const CHAT_TURNED_OFF = 'The website chat was turned off';
const ENDED_LEFT = 'the web chat has ended';
/**
 * The summary has no chat to reply to although a Reply asked for one or the client wrote last in web chat (review
 * ui-compose/F2: a record a chat cannot be answered from, the box had moved to Text and said nothing).
 */
export const CHAT_NOT_HERE = "This website chat can't be answered from this record";
const NOT_HERE_LEFT = "this website chat can't be answered from this record";

/**
 * Web chat from the reachability summary (module 22's channels.web_chat). `seenInThread`: the thread shows web-chat
 * messages; it decides only while the summary is unknown.
 */
export function webChatState(r: Reachability | null, seenInThread: boolean): WebChatState {
  const wc = r?.channels.web_chat;
  const open = (offered: boolean, missing = false): WebChatState => ({ offered, blocked: false, sentence: null, note: null, left: ENDED_LEFT, missing });
  if (!wc) return open(seenInThread);
  if (!wc.hasAddress || !wc.session) return open(false, true);
  const closed = (sentence: string, left: string): WebChatState => ({ offered: true, blocked: true, sentence, note: null, left, missing: false });
  const optOut = wc.reasons[0];
  if (optOut) return closed(reachSentence(optOut, 'web_chat'), 'web chat is blocked');
  if (!wc.session.widgetConnected) return closed(CHAT_TURNED_OFF, 'the website chat was turned off');
  if (!wc.session.open) return closed(CHAT_SESSION_ENDED, ENDED_LEFT);
  if (wc.blocked) return closed("This chat can't take a reply right now", 'web chat is blocked');
  return open(true);
}

/**
 * The feed's Reply (a reply in the website chat): disabled with the reason whenever the summary says the chat cannot
 * take one, and also when the summary has no chat to answer at all (review ui-compose/F2: it had stayed enabled and
 * opened a text box with no word about the chat). Unknown summary: nothing is disabled.
 */
export function replyChatState(r: Reachability | null): ChannelState {
  const s = webChatState(r, true);
  return s.missing ? { blocked: true, sentence: CHAT_NOT_HERE, note: null } : { blocked: s.blocked, sentence: s.sentence, note: s.note };
}

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
  if (i.webChat.offered) {
    const closed = i.webChatEnded || i.webChat.blocked;
    options.push({
      channel: 'web_chat',
      label: CHANNEL_LABEL.web_chat,
      open: !closed,
      reason: i.webChatEnded ? WEB_CHAT_ENDED : i.webChat.blocked ? i.webChat.sentence : null,
    });
  }
  const blockedWhy: Record<ComposeChannel, string> = {
    sms: 'texting is blocked',
    email: 'email is blocked',
    web_chat: i.webChatEnded ? ENDED_LEFT : i.webChat.left,
  };
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
  // asked to reply in web chat (a Reply tap, the agent's own tap) or the client wrote last there, and the summary has
  // no chat to reply to: say so, unless the box left another channel it was meant to be on (that reason comes first)
  const chatAsked = [i.picked, i.requested, i.lastInbound].includes('web_chat');
  if (i.webChat.missing && chatAsked && channel !== 'web_chat' && (meant === null || meant === channel)) {
    why = `Writing ${BY[channel]}: ${NOT_HERE_LEFT}.`;
  } else if (meant !== null && meant !== channel) {
    why = `Writing ${BY[channel]}: ${blockedWhy[meant]}.`;
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
