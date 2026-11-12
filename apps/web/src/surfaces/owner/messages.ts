// Error code → sentence for the owner view (CONVENTIONS §7: the web never shows a raw code).
import { messageFor } from '../../shell/index.js';
import { ADMIN_MESSAGES } from '../admin/lib/messages.js';

export const OWNER_ERROR_MESSAGES: Record<string, string> = {
  COST_MONTH_IN_FUTURE: 'That month has not started yet. Costs can be entered for this month or earlier ones.',
  GOAL_EXISTS: 'This member already has a goal for that period and count. Change its target instead.',
  GOAL_PERIOD_START_INVALID: 'That period does not start on that day. Pick the period again.',
  PLAN_ALREADY_ACCEPTED: 'This plan was already added to your tasks (maybe from another device). The page is up to date.',
};

export const OWNER_MESSAGES: Record<string, string> = { ...ADMIN_MESSAGES, ...OWNER_ERROR_MESSAGES };

export function sentenceFor(e: { code: string; details?: Record<string, unknown> | null } | string): string {
  return messageFor(e, OWNER_MESSAGES);
}
