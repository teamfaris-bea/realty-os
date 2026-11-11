import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as priority from './index.js';

const schemas = {
  FeedItemSchema: priority.FeedItemSchema,
  FeedReasonSchema: priority.FeedReasonSchema,
  OneTapActionSchema: priority.OneTapActionSchema,
  ExceptionItemSpecSchema: priority.ExceptionItemSpecSchema,
  ExceptionEvidenceSchema: priority.ExceptionEvidenceSchema,
  SpeedToLeadSummarySchema: priority.SpeedToLeadSummarySchema,
};

function keysDeep(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysDeep(x, out);
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysDeep(x, out);
    }
  }
  return out;
}

describe('core/priority schemas', () => {
  // R-AST-13 / R-TEN-3 for core data schemas; api/* snapshot-tests the agent-facing response schemas.
  it.each(Object.entries(schemas))('%s has no confidence fields and no tenant_id (snapshot)', (name, schema) => {
    const json = z.toJSONSchema(schema as z.ZodType, { unrepresentable: 'any' });
    const keys = [...keysDeep(json)];
    expect(keys.filter((k) => /confidence|probability|likelihood|tenant_?id/i.test(k))).toEqual([]);
    expect(json).toMatchSnapshot(name);
  });

  it('the item-type enums mirror the DB CHECK lists', () => {
    expect(priority.FEED_ITEM_TYPES).toEqual([
      'lead_offer',
      'first_touch_due',
      'unanswered_inbound',
      'handback',
      'assistant_draft',
      'task_due',
      'promise_due',
      'deal_date',
      'appointment_outcome',
      'reinquiry',
      'inactivity_warning',
      'pond_new',
      'saved_search_review',
      'missed_call',
      // 0018: Phase 2/3 cards, materialized by their owning modules (module 18a)
      'seller_update',
      'marketing_review',
      'weekly_plan',
      'coaching_fix',
      'likely_to_move',
    ]);
    expect(priority.EXCEPTION_TYPES).toEqual(['untouched_lead', 'overdue_promise', 'failed_send', 'missing_outcome', 'milestone_at_risk']);
  });

  it('the public module surface exposes the BUILD_PLAN interface', () => {
    for (const fn of ['scoreFeed', 'deriveExceptions', 'speedToLeadSummary', 'momentum'] as const) expect(typeof priority[fn]).toBe('function');
    expect(priority.SCORE_VERSION).toBe(1);
  });
});
