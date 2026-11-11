// View types of GET /contacts/:id/reachability and GET /reachability (api/comms schemas.ts,
// ReachabilityResponse). apps/web may import @realty/api types only through restated shapes, so they are
// restated here field for field. No scores, no raw codes shown: sentences.ts turns them into words.

export type ReachChannel = 'sms' | 'voice' | 'email';
export type ReachPurpose = 'marketing' | 'informational';

export type ReachCode = 'CONSENT_REVOKED' | 'SUPPRESSED' | 'WRONG_NUMBER' | 'CONTACT_POINT_INVALID' | 'LANDLINE_NO_SMS';

export type ReachSource = 'keyword' | 'opt_out_language' | 'unsubscribe' | 'agent_recorded' | 'call_outcome' | 'wrong_number' | 'provider_report' | 'imported' | 'suppression' | 'contact_point' | 'other';

export interface ReachReason {
  code: ReachCode;
  source: ReachSource;
  purposes: ReachPurpose[];
  at: string | null;
  keyword: string | null;
  recordedBy: { userId: string; displayName: string | null } | null;
  importBatchId: string | null;
  suppressionReason: string | null;
  addressHint: string | null;
  otherAddress: boolean;
  /** that other phone has since been removed from the person (R-PAR-12: its opt-out still blocks them) */
  addressRemoved?: boolean;
  evidence: { consentEventId: string | null; inboundMessageId: string | null; callId: string | null; suppressionId: string | null };
}

export interface ChannelReach {
  hasAddress: boolean;
  defaultPointId: string | null;
  blocked: boolean;
  reasons: ReachReason[];
  points: { pointId: string; addressHint: string; blocked: boolean; reasons: ReachReason[] }[];
}

export interface Reachability {
  contactId: string;
  purposeNow: ReachPurpose;
  channels: Record<ReachChannel, ChannelReach>;
}
