// View types of the Google Business Profile page (module 55), following api/gbp/schemas.ts (StatusResponse,
// ReviewsResponse, ReviewResponse, ReplyResponse). The server is the authority for every state and sentence shown.

export type GbpState = 'not_cleared' | 'not_set_up' | 'not_connected' | 'connected';

export interface GbpLocationView {
  connectionId: string;
  displayName: string;
  sentence: string;
}

export interface GbpStatusView {
  state: GbpState;
  sentence: string;
  locations: GbpLocationView[];
}

export type GuardCode = 'REVIEWER_NAME' | 'MONEY' | 'ADDRESS' | 'DATE' | 'CONTACT' | 'DEAL' | 'FAIR_HOUSING' | 'LENGTH';

export type ReviewState = 'needs_reply' | 'draft_waiting' | 'posting' | 'checking' | 'replied' | 'replied_outside' | 'removed';

export interface ReviewView {
  id: string;
  connectionId: string;
  /** 1..5, or null once the review was removed at Google */
  rating: number | null;
  body: string | null;
  reviewerDisplay: string | null;
  reviewedAt: string;
  state: ReviewState;
  stateLabel: string;
  /** the waiting draft: only an Owner or Admin ever receives one (the API decides) */
  draft: { actionId: string; text: string; guard: GuardCode[]; byAssistant: boolean } | null;
}

export type ReviewFilter = 'needs_reply' | 'all';

export interface ReviewsView {
  state: 'not_cleared' | 'ready';
  sentence: string;
  reviews: ReviewView[];
}

export interface ReplyResult {
  review: ReviewView;
  outcome: 'replied' | 'failed' | 'unknown';
  sentence: string;
}
