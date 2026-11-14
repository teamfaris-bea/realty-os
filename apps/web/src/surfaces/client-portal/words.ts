// module 46 (R-PORTALWEB-10; E653, E698): the staff words of the client-portal section and preview. 45's sentences are
// copied verbatim (staff code cannot import the API; ClientPortalSection.test.tsx proves them equal to 45's contract).
// They are passed to messageFor here, never put in the surface's errorMessages (CONTACT_MERGED already has two
// sentences in the staff app, and shell/pages.ts refuses a conflicting one).

/** 45's error sentences the section meets (webContract.json errors.*.sentence), verbatim. */
export const PORTAL_STAFF_MESSAGES: Readonly<Record<string, string>> = {
  PORTAL_NOT_A_PARTY: 'This person is not a buyer, seller or co-party on this deal or listing. Add them first.',
  PORTAL_LOGIN_POINT_MISSING: 'This person has no working email or phone to sign in with. Add one first.',
  PORTAL_GRANT_REVOKED: 'This access was already revoked.',
  PORTAL_ACCOUNT_DISABLED: 'This account is already disabled. Invite the client again to give access back.',
  CONTACT_MERGED: 'This contact was merged into another record. Open that record instead.',
};

export const STAFF_WORDS = {
  heading: 'Client portal',
  off: "The client portal is off on this deployment until counsel's review is recorded. Clients can't sign in, and invitations aren't sent.",
  offTail: "Clients can't sign in, and invitations aren't sent.",
  notShareable: "Confirmed dates are shared automatically. Documents and other updates can't be shared from the app yet.",
  noOne: 'No one on this deal is invited yet.',
  theClient: 'the client',
  resend: 'Send the invite again',
  revokeDone: 'Already stopped.',
  revokeBody: (name: string) => `${name} stops seeing this at once. You can invite again.`,
  stop: (name: string) => `Stop sharing with ${name}`,
  invite: (name: string) => `Invite ${name}`,
  sees: (name: string) => `What ${name} sees`,
  notFound: 'This client view is not available to you, or it does not exist.',
  previewTitle: 'What the client sees',
  loading: 'Loading',
  notSent: 'Not sent',
} as const;
