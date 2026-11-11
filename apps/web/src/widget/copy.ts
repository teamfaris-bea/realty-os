// Every sentence the chat widget shows (module 37). Plain words, nothing the product does not do:
// no "online now", no "typing…", no "an agent will reply in N minutes", no promise to text or email the
// visitor (nothing automated is ever sent to what they type, R-INBOX-5, E154). The disclosure itself is the
// tenant's stored consent language (consent_disclosures), passed in by the embed and cited by id at start.
// D2: no Messenger or Instagram, no messaging-window copy.
// VERIFY WITH COUNSEL (C1): the web-chat disclosure wording and keyword list.

export const ASSISTANT_LINE = "The first reply may come from the team's assistant.";

export const copy = {
  launcher: (brokerage: string) => `Chat with ${brokerage}`,
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
  openNote: 'Replies appear here while this page is open.',
  ended: 'This chat has ended.',
  newChat: 'Start a new chat',
  need: {
    name: 'Please enter your name.',
    contact: 'Please enter a phone number or an email address.',
    message: 'Please write a message.',
  },
  failure: {
    rate_limited: 'Too many messages right now. Please wait a minute and try again.',
    unavailable: "Chat isn't available right now. Please try again later.",
    ended: 'This chat has ended.',
    invalid: 'Please check your name, phone or email, and message.',
    failed: "Couldn't send. Check your connection and try again.",
  },
} as const;
