// The stage an outcome suggests, as the two outcome routes answer it (R-STG-2): POST /contacts/:id/activities and
// POST /calls/:id/outcome. Read-only: nothing here writes, and no route that calls it changes a stage. The agent
// confirms the suggestion (or picks another stage) with the ordinary stage route, which decides again.
//
// A suggestion is made only to someone the stage route would hear: the person's detail is visible to them by their
// own RLS, the record is live (not merged away), and they hold contact.edit on it (the same can() the stage route
// authorizes with). `locked` is the stage route's own rule, core stageChangeAllowed on the same facts (R-PAR-14,
// STAGE_NEEDS_CONTACT): true means the route would refuse this stage for this actor now, so the screen shows the
// suggestion locked ("Reach them first") instead of offering a tap that fails.
import { type UserActor, can } from '@realty/core/foundation';
import { type ActivityDirection, type ActivityKind, type CallOutcome, type Stage, type StageSignal, stageChangeAllowed, suggestStageFromOutcome } from '@realty/core/parity/people';
import type { Tx } from '@realty/db';
import { factsOf } from '../leads/contacts.js';
import * as leads from '../leads/repos/contacts.js';
import { stageFactsOf } from './contacts.js';
import * as repo from './repos/people.js';

export interface SuggestedStage {
  stage: Stage;
  /** one plain sentence saying why */
  why: string;
  /** the stage route would refuse this stage for this actor now (STAGE_NEEDS_CONTACT) */
  locked: boolean;
}

/**
 * The signal of a logged outside activity (R-PAR-30), or null when it says nothing a stage could follow:
 *   - a text or email we sent is a try; one they sent is their reply;
 *   - an outgoing call reads by its outcome; a call logged with no outcome says nothing;
 *   - an incoming call is a conversation only when it connected. A voicemail THEY left, or a call of theirs we
 *     missed, is not our try to reach them, so it suggests nothing.
 */
export function activitySignal(a: { kind: ActivityKind; direction: ActivityDirection; outcome: CallOutcome | null }): StageSignal | null {
  if (a.kind === 'text' || a.kind === 'email') return { kind: 'message', channel: a.kind, direction: a.direction };
  if (a.outcome === null) return null;
  if (a.direction === 'inbound' && a.outcome !== 'connected') return null;
  return { kind: 'call', outcome: a.outcome };
}

/** The suggestion for `actor` in their own transaction (their RLS), or null. Reads only. */
export async function suggestedStageInTx(tx: Tx, actor: UserActor, contactId: string, signal: StageSignal | null): Promise<SuggestedStage | null> {
  if (signal === null) return null;
  const contact = await leads.getContact(tx, contactId);
  if (!contact || !contact.detail_visible || contact.merged_into_contact_id !== null) return null;
  if (!can(actor, 'contact.edit', factsOf(contact)).ok) return null;
  const row = await repo.editRow(tx, contactId);
  if (!row) return null;
  const facts = stageFactsOf(row);
  const s = suggestStageFromOutcome({ current: facts.stage, signal });
  if (s === null) return null;
  return { stage: s.stage, why: s.why, locked: !stageChangeAllowed(facts, { kind: 'user', role: actor.role }, s.stage).ok };
}
