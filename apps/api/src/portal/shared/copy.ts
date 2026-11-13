// Module 45 copy table (R-PORTAL-8…19; honest states). Every stable code the portal API answers has one sentence here,
// and webContract.json carries them to modules 46 and 55. Pure: no I/O. Sentences never name a person the reader may
// not know about, and never claim a send that did not happen.
import type { ErrorCode } from '../../errors.js';

/** The client portal page of the web app (module 46): fixed here so the link, the notice and the web agree. */
export const PORTAL_PAGE = '/portal.html';
/** The magic link carries its token in the fragment (it never reaches a server log); the page posts it on a tap. */
export const portalLinkUrl = (webOrigin: string, token: string): string => `${webOrigin}${PORTAL_PAGE}#token=${token}`;
/** The invite notice names the team's sign-in page (no token). */
export const portalSignInUrl = (webOrigin: string, slug: string): string => `${webOrigin}${PORTAL_PAGE}?team=${encodeURIComponent(slug)}`;

/** The one answer to every sign-in request that reaches the lookup (R-PORTAL-10, E680). */
export const SIGNIN_ACCEPTED =
  'If that email or phone number is the one your agent set up, and it can get messages from us, we sent a sign-in link. It works once, for 15 minutes. Nothing after a few minutes? Ask your agent.';

export const LINK_EMAIL_SUBJECT = 'Your sign-in link';

/**
 * The stored line of a sign-in link message (E683: it names whose portal it opens). The URL is never in it (b14 audit
 * F2): comms/dispatch.ts renders the sealed URL after this line at the provider send only, so staff reading the thread
 * see this line, which says the link is not kept, and the client gets the line with the link after it.
 */
export function linkLine(o: { brokerage: string; name: string; channel: 'sms' | 'email' }): string {
  return `${o.brokerage}: sign-in link for ${o.name}'s client portal. It works once, for 15 minutes; if you did not ask for it, ignore this ${o.channel === 'email' ? 'message' : 'text'}. Sign in here (the link itself is not kept in the message history):`;
}

export const INVITE_EMAIL_SUBJECT = (scope: 'purchase' | 'sale'): string => `Follow your home ${scope} online`;
/** The invite notice: the agent's own message, no token (R-PORTAL-13). */
export function inviteBody(o: { agent: string; scope: 'purchase' | 'sale'; url: string; kind: 'email' | 'phone' }): string {
  return `${o.agent} invited you to follow your ${o.scope} online. Sign in at ${o.url} with this ${o.kind === 'email' ? 'email address' : 'phone number'}.`;
}
export const inviteNotSent = (first: string): string => `${first} can't sign in until the client portal is turned on, so nothing was sent to them.`;
export const inviteSent = (first: string, kind: 'email' | 'phone'): string => `${first} was sent a note by ${kind === 'email' ? 'email' : 'text'} with how to sign in.`;
export const inviteBlocked = (first: string): string => `The note to ${first} was not sent; the reason is below. The invite stands.`;
/** A repeat invite when a note to this grant was sent (b14 audit F7: said only when one really was). */
export const inviteNoNotice = (first: string): string => `${first} was already invited; no second note was sent.`;
/** A repeat invite while a note to this grant is still on its way (queued, sending, or its outcome unknown). */
export const inviteNoteInFlight = (first: string): string => `A note to ${first} is still being sent. Check the conversation before you resend.`;
/** A repeat invite when every note to this grant was blocked, failed, canceled or never arrived. */
export const inviteNoteNotReached = (first: string): string => `No note has reached ${first} yet. Tap Resend to try again.`;
export const LOGIN_POINT_CHANGED =
  'Sign-in links sent to the old address no longer work. To end their open sessions now, disable the account and invite them again.';

/** Why the client cannot see a grant now (staff preview and views; honest UI). */
export const NOT_VISIBLE = {
  PORTAL_OFF: 'The client portal is not turned on for this team yet, so the client sees nothing.',
  NOT_SIGNED_IN: 'The client has not signed in yet.',
  REVOKED: 'This access was revoked, so the client no longer sees it.',
  LAPSED: 'This access has ended (it expires after the deal closed), so the client no longer sees it.',
  NOT_A_PARTY: 'The client is no longer a party to this deal or listing, so they see nothing here.',
  DISABLED: 'The client portal account is disabled.',
} as const;
export type NotVisibleReason = keyof typeof NOT_VISIBLE;

export const CHANNEL_WORDS = {
  email: { real: null, test: 'Sign-in links by email use the test provider (test deployments only).', off: "Clients can't get sign-in links by email: email sending is not set up on this deployment." },
  sms: { real: null, test: 'Sign-in links by text use the test provider (test deployments only).', off: "Clients can't get sign-in links by text: live texting is off on this deployment." },
} as const;

export const ITEM_STILL_LISTED_UNSHARED = 'Still listed but the file is no longer shared, so the client cannot open it.';
export const RETRACTED_BY_SYNC = 'Removed automatically: the date moved, was waived or went back to proposed, or the file stopped being shared.';

/** One sentence per stable code the portal API answers (module 46 and 55 show these). */
export const CODE_SENTENCES = {
  NOT_FOUND: 'We could not find that.',
  VALIDATION_FAILED: 'Something in the request was not right. Check it and try again.',
  PAYLOAD_TOO_LARGE: 'That request is too large.',
  RATE_LIMITED: 'Too many tries. Wait a few minutes and try again.',
  CSRF_INVALID: 'This page is out of date. Reload it and try again.',
  EMAIL_INVALID: 'That does not look like an email address.',
  PHONE_INVALID: 'That does not look like a phone number.',
  CONTACT_MERGED: 'This contact was merged into another record. Open that record instead.',
  PORTAL_SESSION_REQUIRED: 'Please sign in again.',
  PORTAL_LINK_INVALID: 'That sign-in link no longer works. Links work once, for 15 minutes; ask for a new one.',
  PORTAL_NOT_AVAILABLE: 'Client sign-in is not available right now. Ask your agent.',
  PORTAL_NOT_A_PARTY: 'This person is not a buyer, seller or co-party on this deal or listing. Add them first.',
  PORTAL_LOGIN_POINT_MISSING: 'This person has no working email or phone to sign in with. Add one first.',
  PORTAL_SOURCE_NOT_IN_GRANT: 'That cannot be shared to this client: it is not from their deal or listing, or it is not ready to share.',
  PORTAL_NOT_SELLER_SIDE: 'Only a seller or co-seller of the deal sees showings, feedback and seller updates. Add them as a seller first.',
  PORTAL_GRANT_INACTIVE: 'This client access was revoked or has ended, so nothing new can be shared to it.',
  PORTAL_ITEM_RETRACTED: 'This was already removed from the portal.',
  PORTAL_GRANT_REVOKED: 'This access was already revoked.',
  PORTAL_ACCOUNT_DISABLED: 'This account is already disabled. Invite the client again to give access back.',
  PORTAL_KIND_SOURCE_MISMATCH: 'That kind of item does not match what was chosen.',
  PORTAL_SOURCE_INVALID: 'That item could not be read. Reload and try again.',
  PORTAL_TEXT_TOO_LONG: 'That text is over 4,000 characters; shorten it before sharing.',
  PORTAL_TEXT_NOT_PLAIN: 'That text has characters the portal cannot show; edit it before sharing.',
  PORTAL_PERSON_ONLY: 'Only a person can share this.',
  PORTAL_RULE_MILESTONES_ONLY: 'Only confirmed dates are shared automatically.',
} as const satisfies Partial<Record<ErrorCode | 'PORTAL_PERSON_ONLY' | 'PORTAL_RULE_MILESTONES_ONLY', string>>;
export type PortalCode = keyof typeof CODE_SENTENCES;

/** The sentence for a code (a code with none is a bug: the copy test proves every portal code has one). */
export const sentenceFor = (code: string): string => (CODE_SENTENCES as Record<string, string>)[code] ?? CODE_SENTENCES.VALIDATION_FAILED;
