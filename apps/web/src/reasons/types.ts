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

/**
 * channels.web_chat (module 22): the website chat a reply goes to. `session` is what the send-time check reads for a
 * chat reply: still open (the visitor was seen in the last 30 minutes) and its widget connected; either false and a
 * reply is refused (CHANNEL_NOT_CONNECTED), so `blocked` is true too. null: the contact never wrote in website chat.
 */
export interface ChatReach extends ChannelReach {
  session: { open: boolean; widgetConnected: boolean } | null;
}

export interface Reachability {
  contactId: string;
  purposeNow: ReachPurpose;
  /** web_chat is absent only from an API older than module 22 (then the thread's own messages decide) */
  channels: Record<ReachChannel, ChannelReach> & { web_chat?: ChatReach };
}
