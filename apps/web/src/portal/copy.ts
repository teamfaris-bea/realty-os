// module 46 (R-PORTALWEB-4, R-PORTALWEB-6): every sentence the client portal's sign-in and states show. Module 45's
// sentences are copied verbatim (src/portal cannot import the API) and api.contract.test.ts proves them equal to
// apps/api/src/portal/shared/webContract.json and shared/copy.ts; the portal's own sentences carry no code, no "AI" and
// no urgency. An unknown code gets one generic sentence.

/** 45's sentences (webContract.json `signin.acceptedMessage` and `errors.*.sentence`), verbatim. */
export const API_SENTENCES = {
  SIGNIN_ACCEPTED:
    'If that email or phone number is the one your agent set up, and it can get messages from us, we sent a sign-in link. It works once, for 15 minutes. Nothing after a few minutes? Ask your agent.',
  PORTAL_NOT_AVAILABLE: 'Client sign-in is not available right now. Ask your agent.',
  PORTAL_LINK_INVALID: 'That sign-in link no longer works. Links work once, for 15 minutes; ask for a new one.',
  RATE_LIMITED: 'Too many tries. Wait a few minutes and try again.',
  VALIDATION_FAILED: 'Something in the request was not right. Check it and try again.',
  EMAIL_INVALID: 'That does not look like an email address.',
  PHONE_INVALID: 'That does not look like a phone number.',
  PAYLOAD_TOO_LARGE: 'That request is too large.',
  CSRF_INVALID: 'This page is out of date. Reload it and try again.',
} as const;

/** 45's constants the web must agree with (webContract.json `signin`; packages/db portalTx.ts token length). */
export const PORTAL_PAGE = '/portal.html';
export const TOKEN_IN_FRAGMENT = '#token=';
export const TEAM_IN_QUERY = '?team=';
export const CSRF_HEADER = 'x-csrf-token';
export const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** A team slug as tenants store it (0001_init.sql). */
export const TEAM_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

export const COPY = {
  // LinkLanding
  landingTitle: 'Sign in',
  landingBody: 'Tap Sign in to open your client portal. Sign-in links work once, within 15 minutes of being sent.',
  signInButton: 'Sign in',
  signingIn: 'Signing in',
  incomplete: 'This sign-in link is incomplete. Open it again from the message, or get a new link.',
  // SignIn
  signInTitle: 'Sign in to your client portal',
  sendBy: 'Send the link by',
  byEmail: 'Email',
  byText: 'Text message',
  emailLabel: 'Email address',
  phoneLabel: 'Mobile number',
  sendLink: 'Send me a sign-in link',
  sending: 'Sending',
  useDifferent: 'Use a different email or number',
  smsOff: "Sign-in links can't be sent by text message right now, so nothing was sent. Choose Email to get a link by email.",
  // b15 audit F11: email off never sends the client to text messages, which may be off too (smsOff offers Email)
  emailOff: "Sign-in links can't be sent by email right now, so nothing was sent. Try again later, or ask your agent.",
  // no team
  noTeamTitle: 'Open your invitation link',
  noTeamBody: "To sign in, open the link in the invitation your agent sent you. If you can't find it, ask your agent to send it again.",
  // SignedOut
  signedOutTitle: "You're signed out",
  signedOutBody: 'To open your client portal again, get a new sign-in link.',
  // not available
  unavailableTitle: "The client portal isn't available",
  nothingSent: 'No sign-in link was sent.',
  // home
  signOut: 'Sign out',
  chooseHome: 'Choose what to open',
  loading: 'Loading',
  // generic
  generic: 'Something went wrong. Try again in a moment.',
  tryAgain: 'Try again',
  network: "We couldn't reach the server. Check your connection and try again.",
} as const;

/** The sentence for a code the sign-in screens meet; one generic sentence for anything else. */
export function sentenceFor(code: string): string {
  if (code === 'NETWORK_ERROR') return COPY.network;
  return (API_SENTENCES as Record<string, string>)[code] ?? COPY.generic;
}
