// Shapes of the module 68 mail-sync API (self routes, /me/...). The web reads only these fields; nothing
// here can carry a token (the API never returns one, and no view type has room for it).

export type LinkStatus = 'connected' | 'degraded' | 'revoked';
export type RevokeReason = 'USER_DISCONNECTED' | 'MEMBER_INACTIVE' | 'SYNC_TURNED_OFF' | 'PLATFORM_NOT_CLEARED' | 'PROVIDER_REVOKED';

export interface MailAvailability {
  cleared: boolean;
  enabled: boolean;
  configured: boolean;
  canConnect: boolean;
  sentence: string;
}

export interface MailLinkView {
  id: string;
  status: LinkStatus;
  mailboxAddress: string;
  connectedAt: string;
  lastSyncedAt: string | null;
  lastErrorCode: string | null;
  revokeReason: RevokeReason | null;
  backfillRequestedAt: string | null;
  backfillDoneAt: string | null;
  statusSentence: string;
}

export interface MailLinkResponse {
  available: MailAvailability;
  /** the live link, else the most recent revoked one */
  link: MailLinkView | null;
  backfillDays: number;
  pollIntervalSeconds: number;
  disclosureSha256: string;
}

export interface ConfirmedPoint {
  pointId: string;
  contactId: string;
  contactName: string;
  address: string;
  confirmedAt: string;
}

export interface SuggestedPoint {
  pointId: string;
  contactId: string;
  contactName: string;
  address: string;
}

export interface SyncPointsResponse {
  confirmed: ConfirmedPoint[];
  suggestions: SuggestedPoint[];
}

export const MAIL_LINK_KEY = ['mail-link'] as const;
export const SYNC_POINTS_KEY = ['mail-sync-points'] as const;

export const isLive = (l: MailLinkView | null | undefined): l is MailLinkView & { status: 'connected' | 'degraded' } => !!l && l.status !== 'revoked';
