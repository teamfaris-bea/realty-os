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
import { type Stage, type StageSignal, activitySignal, stageChangeAllowed, suggestStageFromOutcome } from '@realty/core/parity/people';
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
  /** stages offered beside it (only "nurture", after a two-way conversation), each with its own `locked` */
  alsoOffer: { stage: Stage; locked: boolean }[];
}

// The signal of a logged outside activity is core's (one function for this route and the web's Log sheet).
export { activitySignal };

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
  const locked = (to: Stage) => !stageChangeAllowed(facts, { kind: 'user', role: actor.role }, to).ok;
  return { stage: s.stage, why: s.why, locked: locked(s.stage), alsoOffer: s.alsoOffer.map((to) => ({ stage: to, locked: locked(to) })) };
}
