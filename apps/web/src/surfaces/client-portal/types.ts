// module 46: the shapes of module 45's staff routes the section reads (webContract.json; checked in the tests).
export type ChannelState = 'real' | 'test' | 'off';
export interface Decision {
  outcome: string;
  reasons: string[];
  explanation: string;
}
export interface Notice {
  sent: boolean;
  text: string;
  channel: 'sms' | 'email' | null;
  decision: Decision | null;
}
export interface AccountStaff {
  id: string;
  contactId: string;
  status: 'invited' | 'active' | 'disabled';
  statusText: string;
  loginPoint: { id: string; kind: 'email' | 'phone'; hint: string; status: string; usable: boolean } | null;
  signInImpossible: string | null;
  disabledReason: string | null;
}
export interface GrantStaff {
  id: string;
  accountId: string;
  state: 'live' | 'revoked' | 'lapsed' | 'not_a_party' | 'account_disabled';
  stateText: string;
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  view: { id: string; title: string };
}
export interface PortalState {
  portalCleared: boolean;
  portalText: string | null;
  channels: { email: ChannelState; sms: ChannelState; text: string[] };
  accounts: AccountStaff[];
  grants: GrantStaff[];
}
export interface InviteResponse {
  account: AccountStaff;
  grant: GrantStaff;
  created: { account: boolean; grant: boolean };
  notice: Notice;
}
