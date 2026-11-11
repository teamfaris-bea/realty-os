// What a prediction may become: a feed card for a person, and nothing else (R-PRED-4, E121). The card
// carries the band, its reasons and the model's platform back-test (R-PRED-3) — and no channel, template,
// draft, recipient or any other field a message could be sent from. A prediction of a model that is not
// approved is hidden, and so is its card (R-PRED-5, E144). Person-level do-not-contact contacts are never
// listed for outreach (R-PRED-6).
import type { ContactId } from '../foundation/index.js';
import { isModelLive } from './model.js';
import type { Band, BacktestSummary, ModelStatus, Reason, ScorecardModel, StoredPrediction } from './types.js';

export type FeedBand = Extract<Band, 'likely_90d' | 'watch'>;

export type PredictionFeedCard = {
  kind: 'likely_to_move';
  contactId: ContactId;
  modelVersion: string;
  band: FeedBand;
  reasons: Reason[];
  backtest: BacktestSummary & { text: string };
  // nothing that can send a message (E121)
  channel?: never;
  template?: never;
  draft?: never;
  body?: never;
  recipient?: never;
  to?: never;
  send?: never;
};

/** "Of N people flagged in the back-test, M transacted within W days" (R-PRED-3). */
export function backtestText(b: BacktestSummary): string {
  const people = b.flagged === 1 ? '1 person' : `${b.flagged} people`;
  return `Of ${people} flagged in the back-test, ${b.transacted} transacted within ${b.windowDays} days`;
}

/** Visible only while its model is approved (R-PRED-5). Unknown model ⇒ hidden. */
export function isPredictionVisible(p: Pick<StoredPrediction, 'modelVersion'>, models: ReadonlyMap<string, Pick<ScorecardModel, 'status'>>): boolean {
  return isModelLive(models.get(p.modelVersion));
}

/** Filter for the feed and the contact page: withdrawal hides every score of that model at once (E144). */
export function visiblePredictions<P extends Pick<StoredPrediction, 'modelVersion'>>(ps: readonly P[], models: ReadonlyMap<string, Pick<ScorecardModel, 'status'>>): P[] {
  return ps.filter((p) => isPredictionVisible(p, models));
}

/**
 * The feed card for one stored prediction, or null: only likely/watch with ≥1 reason, only for an approved
 * model with its back-test, and only when every reason cites a feature of that model.
 */
export function predictionFeedCard(
  p: StoredPrediction,
  model: Pick<ScorecardModel, 'version' | 'status' | 'features' | 'backtest'> | undefined,
): PredictionFeedCard | null {
  if (model === undefined || model.version !== p.modelVersion) return null;
  if ((model.status as ModelStatus) !== 'approved' || model.backtest === undefined || model.backtest === null) return null;
  if (p.band !== 'likely_90d' && p.band !== 'watch') return null;
  if (p.reasons.length === 0 || !p.reasons.every((r) => model.features.includes(r.feature))) return null;
  const b = model.backtest;
  return {
    kind: 'likely_to_move',
    contactId: p.contactId,
    modelVersion: p.modelVersion,
    band: p.band,
    reasons: p.reasons.map((r) => ({ ...r, evidence: { ...r.evidence } })),
    backtest: { flagged: b.flagged, transacted: b.transacted, windowDays: b.windowDays, dataset: b.dataset, text: backtestText(b) },
  };
}

export type OutreachContact = {
  /** Person-level do-not-contact (e.g. closed as do_not_contact, or a person-wide DNC flag, incl. via merge). */
  personDoNotContact: boolean;
  erased?: boolean;
  closedReason?: string | null;
};

/** False for a person-level do-not-contact or erased contact: never listed for outreach (R-PRED-6). */
export function listableForOutreach(c: OutreachContact): boolean {
  return c.personDoNotContact !== true && c.erased !== true && c.closedReason !== 'do_not_contact';
}
