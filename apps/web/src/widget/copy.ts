// Every sentence the chat widget shows (module 37). Plain words, nothing the product does not do:
// no "online now", no "typing…", no "an agent will reply in N minutes", no promise to text or email the
// visitor (nothing automated is ever sent to what they type, R-INBOX-5, E154). The team name, the notice the
// visitor must see first (the tenant's stored consent language, cited by id at start) and the sentence about the
// assistant come from the server (GET /public/chat/:widgetKey); ASSISTANT_LINE is said only if that sentence is empty.
// D2: no Messenger or Instagram, no messaging-window copy.
// VERIFY WITH COUNSEL (C1): the web-chat disclosure wording and keyword list.

export const ASSISTANT_LINE = "The first reply may come from the team's assistant.";

const replies = (n: number) => `${n} new ${n === 1 ? 'reply' : 'replies'}`;
/** The wait the server named for a rate limit, in words ("in a minute", "in about 29 minutes"); unknown: "later". */
const inWait = (seconds: number | undefined) => (seconds === undefined ? 'later' : seconds <= 60 ? 'in a minute' : `in about ${Math.ceil(seconds / 60)} minutes`);

export const copy = {
  launcher: (team: string) => `Chat with ${team}`,
  /** replies the server delivered while the panel was closed: a count of real messages, never presence */
  launcherNew: (team: string, n: number) => `Chat with ${team} · ${replies(n)}`,
  newReplies: (team: string, n: number) => `${replies(n)} in your chat with ${team}`,
  close: 'Close chat',
  intro: 'Ask a question and the team will answer here.',
  name: 'Your name',
  contact: 'Phone or email',
  contactHint: 'So someone from the team can follow up with you.',
  message: 'Message',
  start: 'Start chat',
  starting: 'Starting…',
  send: 'Send',
  sending: 'Sending…',
  replyField: 'Your reply',
  log: 'Conversation',
  you: 'You',
  /** how a reply from the team's automated assistant is signed (it never passes as a person) */
  assistant: (team: string) => `${team}'s automated assistant`,
  openNote: 'Replies appear here while this page is open.',
  /** a chat continued after the page changed: the server keeps the visitor's messages, this browser does not */
  restoredNote: 'Your earlier messages in this chat are not shown after the page changes. The team still has them.',
  disclosureChanged: 'The notice above has just changed. Please read it, then tap Start chat again.',
  ended: 'This chat has ended.',
  /** the team turned the widget off while the chat was open (R-INBOX-7) */
  turnedOff: "This chat isn't available any more.",
  newChat: 'Start a new chat',
  need: {
    name: 'Please enter your name.',
    contact: 'Please enter a phone number or an email address.',
    message: 'Please write a message.',
  },
  /** a 422 that names the field */
  check: {
    name: 'Please check your name.',
    contact: 'Please check the phone number or email address.',
    message: 'Please check your message.',
  },
  /** E137: a refused start or message, with the wait the server named (error.details.retryAfterSeconds) */
  tooManyStarts: (seconds?: number) => `Too many chats were started from this connection. Please try again ${inWait(seconds)}.`,
  tooManyMessages: (seconds?: number) => `Too many messages right now. Please try again ${inWait(seconds)}.`,
  failure: {
    rate_limited: 'Too many messages right now. Please try again later.',
    unavailable: "Chat isn't available right now. Please try again later.",
    not_found: "Chat isn't available right now. Please try again later.",
    disclosure_stale: 'The notice above has just changed. Please read it, then tap Start chat again.',
    closed: 'This chat has ended.',
    invalid: 'Please check your name, phone or email, and message.',
    failed: "Couldn't send. Check your connection and try again.",
  },
} as const;
