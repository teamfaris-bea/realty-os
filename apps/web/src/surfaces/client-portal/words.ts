// module 46 (R-PORTALWEB-10; E693, E718): the staff words of the client-portal section and preview. 45's sentences are
// copied verbatim (staff code cannot import the API; ClientPortalSection.test.tsx proves them equal to 45's contract).
// They are passed to messageFor here, never put in the surface's errorMessages (CONTACT_MERGED already has two
// sentences in the staff app, and shell/pages.ts refuses a conflicting one).

import type { Role } from '@realty/core/foundation';

/** 45's error sentences the section meets (webContract.json errors.*.sentence), verbatim. */
export const PORTAL_STAFF_MESSAGES: Readonly<Record<string, string>> = {
  PORTAL_NOT_A_PARTY: 'This person is not a buyer, seller or co-party on this deal or listing. Add them first.',
  PORTAL_LOGIN_POINT_MISSING: 'This person has no working email or phone to sign in with. Add one first.',
  PORTAL_GRANT_REVOKED: 'This access was already revoked.',
  PORTAL_ACCOUNT_DISABLED: 'This account is already disabled. Invite the client again to give access back.',
  CONTACT_MERGED: 'This contact was merged into another record. Open that record instead.',
  /** b15 review L1: 45 refuses an invite (and a resend) on a lost deal; the section shows it in place of Invite */
  PORTAL_DEAL_LOST: "This deal is marked lost, so its client can't be invited to the portal.",
};

/**
 * b15 audit F1: whether to show Invite, Resend and Stop sharing, mirroring core authz `portal.manage` (Owner, Admin, a
 * Team Lead's T, the agent who owns the deal or listing) from the session role and the scope's owner. A TC on the deal
 * and a member agent who is not the owner have `portal.view` only: 45 refuses them manage (404), so they see the section
 * read-only. A Team Lead's team is not known here, but `portal.view` and `portal.manage` are both T for a Team Lead, so a
 * Team Lead who can open the section at all (its GET answered) may manage it. Membership never grants manage.
 */
export function mayManagePortal(role: Role | null | undefined, f: { own: boolean; member: boolean }): boolean {
  if (role === 'owner' || role === 'admin' || role === 'team_lead') return true;
  return role === 'agent' && f.own;
}

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
  readOnly: (kind: 'deal' | 'listing') => `Only the agent who owns this ${kind}, their Team Lead, an Owner or an Admin can invite the client or stop sharing.`,
} as const;
