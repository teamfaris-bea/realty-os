// A plain in-memory reference evaluator of a SmartListDefinition (lane people-filters): the meaning of each
// clause written the obvious way, with no plan, no SQL and no optimisation, so the API's equivalence tests can
// say "the SQL run returns exactly these people". It covers every clause except custom fields and tasks
// (fields have their own value tests in api/lists/fields.test.ts). Visibility is NOT its job: callers pass only
// the people the viewer may see in detail, live (not merged away, not erased).
import type { ListClause, SmartListDefinition } from '../definition.js';

export interface RefPerson {
  id: string;
  displayName: string;
  stage: string;
  intent: string | null;
  contactType: string;
  sourceId: string | null;
  ownerId: string | null;
  tagIds: readonly string[];
  /** GREATEST(last_human_touch_at, last_inbound_at), ms, or null */
  lastActivityMs: number | null;
  createdMs: number;
}

export interface RefContext {
  meId: string;
  nowMs: number;
}

const DAY = 86_400_000;

export function refClause(c: ListClause, p: RefPerson, ctx: RefContext): boolean {
  switch (c.kind) {
    case 'stage':
      return 'not_in' in c ? !c.not_in.includes(p.stage as never) : c.in.includes(p.stage as never);
    case 'intent':
      // "is not": a person with no intent is not a buyer (E196)
      return 'not_in' in c ? p.intent === null || !c.not_in.includes(p.intent as never) : p.intent !== null && c.in.includes(p.intent as never);
    case 'contact_type':
      return 'not_in' in c ? !c.not_in.includes(p.contactType as never) : c.in.includes(p.contactType as never);
    case 'source':
      // "is not Zillow" keeps people with no source (E195)
      return 'not_in' in c ? p.sourceId === null || !c.not_in.includes(p.sourceId) : p.sourceId !== null && c.in.includes(p.sourceId);
    case 'owner':
      // "is not Avery" keeps unassigned people (E197)
      if ('not_in' in c) return p.ownerId === null || !c.not_in.includes(p.ownerId);
      if ('in' in c) return p.ownerId !== null && c.in.includes(p.ownerId);
      return c.is === 'me' ? p.ownerId === ctx.meId : p.ownerId === null;
    case 'tag':
      if (c.op === 'any') return c.tagIds.some((t) => p.tagIds.includes(t));
      if (c.op === 'all') return c.tagIds.every((t) => p.tagIds.includes(t));
      return !c.tagIds.some((t) => p.tagIds.includes(t));
    case 'last_activity':
      if (c.op === 'never') return p.lastActivityMs === null;
      if (c.op === 'within_days') return p.lastActivityMs !== null && p.lastActivityMs >= ctx.nowMs - c.days * DAY;
      return p.lastActivityMs === null || p.lastActivityMs < ctx.nowMs - c.days * DAY;
    case 'created':
      return c.op === 'within_days' ? p.createdMs >= ctx.nowMs - c.days * DAY : p.createdMs < ctx.nowMs - c.days * DAY;
    case 'name':
      return p.displayName.toLowerCase().includes(c.contains.toLowerCase());
    case 'next_task':
    case 'field':
      throw new Error(`refClause: ${c.kind} is not covered by the reference evaluator`);
  }
}

export function refMatches(def: SmartListDefinition, p: RefPerson, ctx: RefContext): boolean {
  return def.all.every((c) => refClause(c, p, ctx)) && (def.any === undefined || def.any.length === 0 || def.any.some((c) => refClause(c, p, ctx)));
}

/** The ids of the people the definition holds, in input order. */
export function refEvaluate(def: SmartListDefinition, people: readonly RefPerson[], ctx: RefContext): string[] {
  return people.filter((p) => refMatches(def, p, ctx)).map((p) => p.id);
}
