// Opt-out and message-status reasons, said the same way everywhere (lane optout-visibility).
export { HELD_REASONS, type MessageStatusFacts, type SayChannel, type StatusLine, isHeld, messageStatus, reachSentence, shortDate } from './sentences.js';
export { ReasonCaption } from './ReasonCaption.js';
export { type ChannelState, REACHABILITY_KEY, ReachabilityBatch, channelState, useChannelState, useReachability, useReachabilityQuery } from './useReachability.js';
export type { ChannelReach, ChatReach, ReachChannel, ReachCode, ReachPurpose, ReachReason, ReachSource, Reachability } from './types.js';
