import { describe, expect, it } from 'vitest';
import { backtestText, listableForOutreach, predictionFeedCard, score, visiblePredictions, type PredictionFeedCard, type ScorecardModel, type StoredPrediction } from './index.js';
import { APPROVED, NARROW, cid, withStatus } from './testing/fixtures.js';

const MESSAGE_KEY = /channel|template|draft|message|body|recipient|^to$|send|subject|sms|email|phone/i;

function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      allKeys(x, out);
    }
  }
  return out;
}

const likely: StoredPrediction = { contactId: cid(1), modelVersion: APPROVED.version, ...score({ yearsInHome: 14, statedTimelineDays: 30, equityBand: 'high' }, APPROVED) };

describe('feed card only (R-PRED-4, E121)', () => {
  it('R-PRED-4 E121: a contact flagged "likely" gets a feed card with band, reasons and the back-test — and no message path', () => {
    expect(likely.band).toBe('likely_90d');
    const card = predictionFeedCard(likely, APPROVED);
    expect(card).not.toBeNull();
    expect(card).toMatchObject({ kind: 'likely_to_move', band: 'likely_90d', modelVersion: 'predict/1.0' });
    expect(card?.reasons.length).toBeGreaterThan(0);
    expect(card?.backtest.text).toBe('Of 120 people flagged in the back-test, 31 transacted within 90 days');
    expect(allKeys(card).filter((k) => MESSAGE_KEY.test(k))).toEqual([]);
  });

  it('R-PRED-4 E121: compile time: a card cannot carry a channel, template or draft', () => {
    const card = predictionFeedCard(likely, APPROVED) as PredictionFeedCard;
    // @ts-expect-error channel is never
    const a: PredictionFeedCard = { ...card, channel: 'sms' };
    // @ts-expect-error template is never
    const b: PredictionFeedCard = { ...card, template: 't-1' };
    // @ts-expect-error draft is never
    const c: PredictionFeedCard = { ...card, draft: 'Hi!' };
    expect([a, b, c]).toHaveLength(3);
  });

  it('R-PRED-4: only likely/watch with reasons from the same, approved model become cards', () => {
    expect(predictionFeedCard({ ...likely, band: 'none' }, APPROVED)).toBeNull();
    expect(predictionFeedCard({ ...likely, band: 'not_enough_data', reasons: [] }, APPROVED)).toBeNull();
    expect(predictionFeedCard({ ...likely, reasons: [] }, APPROVED)).toBeNull();
    expect(predictionFeedCard(likely, NARROW)).toBeNull(); // other model version
    expect(predictionFeedCard({ ...likely, modelVersion: NARROW.version }, NARROW)).toBeNull(); // reasons cite features outside NARROW
    expect(predictionFeedCard(likely, undefined)).toBeNull();
  });

  it('R-PRED-3: back-test text names N flagged, M transacted and the window', () => {
    expect(backtestText({ flagged: 1, transacted: 0, windowDays: 30, dataset: 'x' })).toBe('Of 1 person flagged in the back-test, 0 transacted within 30 days');
  });
});

describe('withdrawal hides scores and cards at once (R-PRED-5, E144)', () => {
  it('R-PRED-5 E144: counsel withdraws approval ⇒ its predictions and cards are hidden; other models stay', () => {
    const other: StoredPrediction = { contactId: cid(2), modelVersion: NARROW.version, ...score({ yearsInHome: 12, recentPermit: true }, NARROW) };
    const live = new Map<string, ScorecardModel>([[APPROVED.version, APPROVED], [NARROW.version, NARROW]]);
    expect(visiblePredictions([likely, other], live)).toHaveLength(2);
    const withdrawn = withStatus(APPROVED, 'withdrawn');
    const after = new Map<string, ScorecardModel>([[APPROVED.version, withdrawn], [NARROW.version, NARROW]]);
    expect(visiblePredictions([likely, other], after)).toEqual([other]);
    expect(predictionFeedCard(likely, withdrawn)).toBeNull();
    expect(predictionFeedCard(likely, withStatus(APPROVED, 'draft'))).toBeNull();
    expect(visiblePredictions([likely], new Map())).toEqual([]);
  });
});

describe('outreach listing (R-PRED-6)', () => {
  it('R-PRED-6: person-level do-not-contact or erased contacts are never listed for outreach', () => {
    expect(listableForOutreach({ personDoNotContact: false })).toBe(true);
    expect(listableForOutreach({ personDoNotContact: true })).toBe(false);
    expect(listableForOutreach({ personDoNotContact: false, closedReason: 'do_not_contact' })).toBe(false);
    expect(listableForOutreach({ personDoNotContact: false, erased: true })).toBe(false);
  });
});
