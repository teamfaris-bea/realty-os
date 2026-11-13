// Error code → sentence for every code the agent surfaces show (CONVENTIONS §7: the web never shows a
// raw code). Registered once, on the feed surface's `errorMessages` (registry.ts), so useCommand finds
// them through the page table; useMutate reads the same map. Sentences say what happened and what to
// do next, in plain words, without revealing more than the server did (R-PERM-7: a loser of a race
// learns only that it lost, not who won).
export const AGENT_ERROR_MESSAGES: Record<string, string> = {
  // ownership commands (api/leads)
  LEAD_OFFER_EXPIRED: 'This offer ended before your tap reached us. The lead is going to the next agent.',
  LEAD_OFFER_SUPERSEDED: 'This offer was replaced by a newer one. Pull to refresh to see where the lead is now.',
  LEAD_ALREADY_CLAIMED: 'Someone else claimed this lead just now.',
  LEAD_STATE_CHANGED: 'This lead changed while you were looking at it. What you see now is up to date.',
  CLAIM_LIMIT_REACHED: "You've reached today's claim limit. You can claim again tomorrow.",
  CLAIM_COOLDOWN: "You can't claim this lead yet: it was released from you recently.",
  CAPACITY_REACHED: 'Contact the leads you already have before claiming more.',
  POND_NOT_ELIGIBLE: "You can't claim from this pond.",
  ALREADY_OWNER: 'This lead is already yours.',
  MEMBERSHIP_INACTIVE: "Your account isn't active on this team right now.",
  COMMAND_ID_REUSED: 'That tap was already used for something else. Try again.',
  // messages and calls (api/comms)
  CONTACT_POINT_MISSING: "There's no phone number or email for this on file.",
  CONTACT_MERGED: "This record was merged into another one, so nothing was done here. Open the person's current record to text, call or enroll them.",
  SUBJECT_REQUIRED: 'An email needs a subject.',
  SCHEDULE_IN_PAST: 'Pick a time in the future.',
  MESSAGE_NOT_SENDABLE: "This message can't be sent any more. Write a new one.",
  CALL_NOT_ACTIVE: 'This call has already ended, so its outcome was saved on the call.',
  AGENT_PHONE_MISSING: 'Add your phone number in Account so calls can ring you first.',
  SENDER_UNAVAILABLE: "There's no number or address set up to send from yet. Ask your admin.",
  PROVIDER_UNAVAILABLE: "The phone service isn't answering right now. Nothing was sent. Try again in a moment.",
  ALREADY_REVIEWED: 'This was already reviewed.',
  // assistant (api/assistant)
  DRAFT_STALE: 'They replied since this was drafted. Read the new message, then send if it still fits.',
  DRAFT_INVALIDATED: "This draft no longer applies: the lead's owner changed. Nothing was sent.",
  ACTION_NOT_PENDING: 'This was already handled.',
  AI_ISA_HANDOFF_USE_ACK: "This is the assistant's handoff, not a draft, so nothing was sent.",
  ASSISTANT_UNAVAILABLE: "The assistant couldn't write a draft right now. You can write the message yourself.",
  DRAFT_OWNER_ONLY: 'Only the lead’s owner can ask the assistant for a draft.',
  SAVED_SEARCH_INVALID: 'Check the search criteria: something in them is not valid.',
  SAVED_SEARCH_STATE: 'This saved search changed since you opened it. Open it again.',
  // workspace (api/workspace)
  FEED_ITEM_PINNED: "Deadline cards close when you act on them, so they can't be dismissed.",
  FEED_ITEM_NOT_OPEN: 'This card was already handled.',
  DEAL_STAGE_INVALID: "A deal can't move to that stage from here.",
  ASSIGNEE_NOT_ELIGIBLE: "That person can't be assigned this task.",
  VERSION_CONFLICT: 'Someone changed this while you were editing. What you see now is up to date; make your change again.',
};

export function useSurfaceMessages(): Record<string, string> {
  return AGENT_ERROR_MESSAGES;
}

/**
 * E142 (R-TXN-5): DRAFT_STALE with details.reason says the deal date the update cites changed since it was drafted.
 * Unlike an inbound reply (R-AST-6), no re-read or re-tap clears it, so these say only why and to dismiss it.
 * VERIFY (V9): whether the team's update plan always covers a moved date.
 */
export const DEAL_DATE_STALE_WORDS = {
  DATE_MOVED: "The deal date in this update moved since it was drafted, so it can't be sent as written. Dismiss it; the new date gets its own update if the team's update plan covers it.",
  DATE_NO_LONGER_DRIVES: "The deal date in this update was completed or waived, so this update won't be sent. Dismiss it.",
  DATE_GONE: "The deal date in this update no longer exists, so this update won't be sent. Dismiss it.",
} as const;

/** The same on a feed card, which has no Dismiss of the draft itself: it ends by pointing at Approvals. */
const DEAL_DATE_STALE_FEED_WORDS: Record<keyof typeof DEAL_DATE_STALE_WORDS, string> = {
  DATE_MOVED: "The deal date in this update moved since it was drafted, so it can't be sent as written; the new date gets its own update if the team's update plan covers it. Dismiss it in Approvals.",
  DATE_NO_LONGER_DRIVES: "The deal date in this update was completed or waived, so this update won't be sent. Dismiss it in Approvals.",
  DATE_GONE: "The deal date in this update no longer exists, so this update won't be sent. Dismiss it in Approvals.",
};

/** The E142 sentence for a DRAFT_STALE refusal's details, or null when it is the inbound (they-replied) staleness. */
export function dealDateStaleWords(details: Record<string, unknown> | null | undefined, where: 'draft' | 'feed' | 'compose' = 'draft'): string | null {
  const r = details?.['reason'];
  if (typeof r !== 'string' || !(r in DEAL_DATE_STALE_WORDS)) return null;
  const k = r as keyof typeof DEAL_DATE_STALE_WORDS;
  if (where === 'feed') return DEAL_DATE_STALE_FEED_WORDS[k];
  // in the compose box the draft is detached and its text kept as the agent's own: only the why, no Dismiss
  if (where === 'compose') return DEAL_DATE_STALE_WORDS[k].replace(/ Dismiss it[;.].*$/, '');
  return DEAL_DATE_STALE_WORDS[k];
}
