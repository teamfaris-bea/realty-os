import { describe, expect, it } from 'vitest';
import { type DealDateId, HOUR_MS, at, instant, toIso } from '../foundation/index.js';
import { milestoneKey } from './keys.js';
import { type RiskFacts, milestoneRisk } from './risk.js';

const due = at('2026-06-30T03:59:59Z');
const facts = (over: Partial<RiskFacts> = {}): RiskFacts => ({
  id: 'dd-9' as DealDateId,
  status: 'confirmed',
  completedAt: null,
  dueAt: due,
  dueVersion: 3,
  responsible: 'lender',
  label: 'Financing',
  ...over,
});

describe('R-ACC-6 milestone_at_risk', () => {
  it('R-ACC-6 R-TXN-3: an overdue confirmed date is at risk, keyed by deal date and due_version', () => {
    const r = milestoneRisk(facts(), instant(due + 1));
    expect(r).toMatchObject({ key: 'milestone:dd-9:3', predicates: ['overdue'], detectedAt: due });
    expect(r?.evidence).toBe('Financing was due 2026-06-30T03:59:59.000Z and is not marked done.');
  });

  it('R-ACC-6: due within 48 h with no responsible party is at risk; with one it is not', () => {
    const now = instant(due - 47 * HOUR_MS);
    const r = milestoneRisk(facts({ responsible: null }), now);
    expect(r?.predicates).toEqual(['due_soon_unassigned']);
    expect(toIso(r?.detectedAt as never)).toBe(toIso(instant(due - 48 * HOUR_MS)));
    expect(r?.evidence).toBe('Financing is due within 48 hours (2026-06-30T03:59:59.000Z) and no one is responsible for it.');
    expect(milestoneRisk(facts(), now)).toBeNull();
  });

  it('R-ACC-6: the 48 h boundary is inclusive; just outside it is not a risk', () => {
    expect(milestoneRisk(facts({ responsible: null }), instant(due - 48 * HOUR_MS))?.predicates).toEqual(['due_soon_unassigned']);
    expect(milestoneRisk(facts({ responsible: null }), instant(due - 48 * HOUR_MS - 1))).toBeNull();
  });

  it('R-ACC-6: at due_at exactly it is not yet overdue', () => {
    expect(milestoneRisk(facts(), due)).toBeNull();
  });

  it('R-ACC-6: overdue and unassigned names both predicates, overdue first', () => {
    const r = milestoneRisk(facts({ responsible: null }), instant(due + HOUR_MS));
    expect(r?.predicates).toEqual(['overdue', 'due_soon_unassigned']);
    expect(r?.detectedAt).toBe(due);
    expect(r?.evidence).toBe('Financing was due 2026-06-30T03:59:59.000Z and is not marked done; no one is responsible for it.');
    expect(milestoneRisk(facts({ label: null }), instant(due + 1))?.evidence).toMatch(/^This milestone was due/);
  });

  it('R-TXN-3: an unconfirmed, waived or completed date is never a risk', () => {
    const now = instant(due + HOUR_MS);
    expect(milestoneRisk(facts({ status: 'proposed' }), now)).toBeNull();
    expect(milestoneRisk(facts({ status: 'waived' }), now)).toBeNull();
    expect(milestoneRisk(facts({ completedAt: now }), now)).toBeNull();
  });

  it('R-TXN-3: stored fields only: no due_at stored yet ⇒ not evaluated', () => {
    expect(milestoneRisk(facts({ dueAt: null }), instant(due + HOUR_MS))).toBeNull();
  });

  it('a moved date (new due_version) is a different occurrence key', () => {
    const now = instant(due + HOUR_MS);
    expect(milestoneRisk(facts({ dueVersion: 4 }), now)?.key).not.toBe(milestoneRisk(facts(), now)?.key);
    expect(milestoneKey('a', 1)).toBe('milestone:a:1');
  });

  it('recomputing later never moves detectedAt', () => {
    const a = milestoneRisk(facts(), instant(due + HOUR_MS));
    const b = milestoneRisk(facts(), instant(due + 100 * HOUR_MS));
    expect(a?.detectedAt).toBe(b?.detectedAt);
  });
});
