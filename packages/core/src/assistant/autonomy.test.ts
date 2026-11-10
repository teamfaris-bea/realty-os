import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ACTION_CATEGORIES, ALWAYS_HUMAN_CATEGORIES, type ActionCategory } from '../compliance/index.js';
import {
  type ActionKind,
  type DowngradeReason,
  type StoredCategory,
  approvalCurrent,
  authorizeAutonomousAction,
  checkDraftCurrent,
  classifyAction,
  downgradeExplanation,
  draftCategory,
} from './autonomy.js';
import { contentSha256 } from './playbook.js';
import { renderStep, signOffFor } from './render.js';
import { step, teamIdentity } from './testing/fixtures.js';

const s = step();
const HASH = contentSha256([s], {});
const identity = teamIdentity();
const rendered = (() => {
  const r = renderStep(s, { first_name: 'Jane' }, { signOff: signOffFor(identity), brokerageName: identity.brokerageLegalName, firstInThread: false });
  if (!r.ok) throw new Error(r.code);
  return r.text;
})();
const base = {
  category: 'nurture_step' as ActionCategory,
  playbookVersion: { status: 'approved', contentSha256: HASH },
  latestApproval: { decision: 'approve' as const, contentSha256: HASH },
  tenantAutonomous: new Set<ActionCategory>(['speed_to_lead_reply', 'reminder', 'booking_confirmation', 'nurture_step', 'search_alert']),
  step: s,
  rendered,
  intentCheck: 'match' as const,
  identity,
  firstInThread: false,
};

describe('authorizeAutonomousAction (R-AST-3, R-AST-4)', () => {
  it('R-AST-4 allows an approved, hash-bound playbook step whose text passes the guard', () => {
    expect(authorizeAutonomousAction(base)).toEqual({ allow: true });
  });

  it.each([...ALWAYS_HUMAN_CATEGORIES])('R-AST-3 E35 the always-human category %s is never autonomous, even if a tenant lists it', (category) => {
    const r = authorizeAutonomousAction({ ...base, category, tenantAutonomous: new Set([...base.tenantAutonomous, category]), step: { ...s, category } });
    expect(r).toEqual({ allow: false, downgrade: 'ALWAYS_HUMAN_CATEGORY' });
  });

  const cases: [DowngradeReason, Partial<typeof base>][] = [
    ['CATEGORY_NOT_AUTONOMOUS', { category: 'agent_alert' }],
    ['CATEGORY_NOT_AUTONOMOUS', { category: 'none' }],
    ['CATEGORY_DISABLED', { category: 'document_chase', step: { ...s, category: 'document_chase' } }],
    ['STEP_CATEGORY_MISMATCH', { category: 'reminder' }],
    ['NO_PLAYBOOK_VERSION', { playbookVersion: null as never }],
    ['VERSION_NOT_APPROVED', { playbookVersion: { status: 'draft', contentSha256: HASH } }],
    ['VERSION_NOT_APPROVED', { playbookVersion: { status: 'superseded', contentSha256: HASH } }],
    ['VERSION_NOT_APPROVED', { playbookVersion: { status: 'revoked', contentSha256: HASH } }],
    ['NO_APPROVAL', { latestApproval: null as never }],
    ['APPROVAL_REVOKED', { latestApproval: { decision: 'revoke' as never, contentSha256: HASH } }],
    ['APPROVAL_HASH_MISMATCH', { latestApproval: { decision: 'approve', contentSha256: 'f'.repeat(64) } }],
    ['APPROVAL_HASH_MISMATCH', { playbookVersion: { status: 'approved', contentSha256: contentSha256([{ ...s, template: 'edited' }], {}) } }],
    ['INTENT_MISMATCH', { intentCheck: 'mismatch' as never }],
  ];
  it.each(cases)('R-AST-4 downgrade %s', (downgrade, patch) => {
    const r = authorizeAutonomousAction({ ...base, ...patch });
    expect(r).toEqual({ allow: false, downgrade });
    expect(downgradeExplanation(downgrade).length).toBeLessThanOrEqual(300);
  });

  it('R-AST-3 E35 money or contract wording in the rendered text downgrades to a draft in that category', () => {
    const money = authorizeAutonomousAction({ ...base, rendered: `${rendered.split('\n')[0]} Ready to make an offer?\n— the Smith Team assistant` });
    expect(money).toMatchObject({ allow: false, downgrade: 'CONTENT_GUARD', category: 'money' });
    const contract = authorizeAutonomousAction({ ...base, rendered: `Your addendum is ready.\n— the Smith Team assistant` });
    expect(contract).toMatchObject({ allow: false, downgrade: 'CONTENT_GUARD', category: 'contract' });
    expect(downgradeExplanation('CONTENT_GUARD', 'money')).toMatch(/money/);
    expect(downgradeExplanation('CONTENT_GUARD', 'contract')).toMatch(/contract/);
  });

  it('R-GATE-7 payment instructions are their own downgrade (and the gate denies them for everyone)', () => {
    const r = authorizeAutonomousAction({ ...base, rendered: `Wire the deposit to routing 021000021.\n— the Smith Team assistant` });
    expect(r).toMatchObject({ allow: false, downgrade: 'PAYMENT_INSTRUCTIONS', category: 'money' });
    expect(downgradeExplanation('PAYMENT_INSTRUCTIONS')).toBe("For safety, wiring details can't be sent by text or email from here.");
  });

  it('R-AST-11 a guard failure without a topic (missing sign-off, human claim) downgrades with its issues', () => {
    const r = authorizeAutonomousAction({ ...base, rendered: 'Hi Jane, this is Sarah!' });
    expect(r).toMatchObject({ allow: false, downgrade: 'CONTENT_GUARD' });
    expect(r.allow === false && r.guardIssues?.map((i) => i.code)).toEqual(['HUMAN_CLAIM', 'MISSING_SIGN_OFF', 'MISSING_BROKERAGE_NAME']);
    expect(r.allow === false && 'category' in r).toBe(false);
    expect(downgradeExplanation('CONTENT_GUARD')).toMatch(/check/);
    const first = authorizeAutonomousAction({ ...base, firstInThread: true });
    expect(first.allow === false && first.guardIssues?.map((i) => i.code)).toEqual(['MISSING_OPT_OUT_HINT']);
  });

  it('R-AST-4 property: allow implies approved + latest approve with the same hash + eligible enabled category', () => {
    const cat = fc.constantFrom(...ACTION_CATEGORIES);
    const hash = fc.constantFrom(HASH, 'a'.repeat(64));
    fc.assert(
      fc.property(
        cat,
        fc.constantFrom('draft', 'approved', 'superseded', 'revoked'),
        hash,
        fc.option(fc.record({ decision: fc.constantFrom('approve' as const, 'revoke' as const), contentSha256: hash }), { nil: null }),
        fc.subarray([...ACTION_CATEGORIES]),
        (category, status, vh, approval, enabled) => {
          const r = authorizeAutonomousAction({
            ...base,
            category,
            step: { ...s, category: category as never },
            playbookVersion: { status, contentSha256: vh },
            latestApproval: approval,
            tenantAutonomous: new Set(enabled),
          });
          if (r.allow) {
            expect(ALWAYS_HUMAN_CATEGORIES.has(category)).toBe(false);
            expect(enabled).toContain(category);
            expect(approvalCurrent({ status, contentSha256: vh }, approval)).toBe(true);
          }
        },
      ),
    );
  });
});

describe('approvalCurrent', () => {
  it('R-AST-4 requires an approved version and a latest approve row with the version hash', () => {
    expect(approvalCurrent(null, null)).toBe(false);
    expect(approvalCurrent({ status: 'approved', contentSha256: HASH }, null)).toBe(false);
    expect(approvalCurrent({ status: 'approved', contentSha256: HASH }, { decision: 'approve', contentSha256: HASH })).toBe(true);
    expect(approvalCurrent({ status: 'approved', contentSha256: HASH }, { decision: 'revoke', contentSha256: HASH })).toBe(false);
    expect(approvalCurrent({ status: 'draft', contentSha256: HASH }, { decision: 'approve', contentSha256: HASH })).toBe(false);
  });
});

// R-AST-17 is a DB CHECK (smoke); this proves core never produces a row that would violate it.
describe('classifyAction (assistant_actions CHECKs)', () => {
  const kinds: ActionKind[] = ['message_draft', 'autonomous_message', 'call_summary', 'handback', 'promise_extraction', 'saved_search_proposal', 'next_step', 'lead_summary', 'seller_update_draft', 'weekly_plan'];
  const cats: StoredCategory[] = ['speed_to_lead_reply', 'reminder', 'booking_confirmation', 'document_chase', 'nurture_step', 'search_alert', 'money', 'contract', 'novel_message', 'seller_update', 'internal'];

  it('property: every output satisfies the table CHECKs', () => {
    fc.assert(
      fc.property(fc.constantFrom(...kinds), fc.constantFrom(...cats), fc.boolean(), fc.option(fc.constant('v1'), { nil: null }), (kind, category, authorized, playbookVersionId) => {
        const r = classifyAction({ kind, category, authorized, playbookVersionId });
        // CHECK: never within_playbook for money/contract/novel/seller_update/internal
        if (r.autonomy === 'within_playbook') expect(['money', 'contract', 'novel_message', 'seller_update', 'internal']).not.toContain(r.category);
        // CHECK: seller_update_draft ⇒ seller_update + requires_approval
        if (r.kind === 'seller_update_draft') expect(r).toMatchObject({ category: 'seller_update', autonomy: 'requires_approval' });
        // CHECK: within_playbook ⇔ autonomous_message + version
        expect(r.autonomy === 'within_playbook').toBe(r.kind === 'autonomous_message' && playbookVersionId !== null);
        // CHECK: internal autonomy ⇒ internal category
        if (r.autonomy === 'internal') expect(r.category).toBe('internal');
        if (r.category === 'internal') expect(r.autonomy).toBe('internal');
        // seller updates are never auto-sent (R-AST-17)
        if (category === 'seller_update') expect(r.autonomy).not.toBe('within_playbook');
      }),
    );
  });

  it('turns an unauthorized autonomous message into a draft', () => {
    expect(classifyAction({ kind: 'autonomous_message', category: 'nurture_step', authorized: false, playbookVersionId: 'v1' })).toEqual({ kind: 'message_draft', category: 'nurture_step', autonomy: 'requires_approval' });
    expect(classifyAction({ kind: 'autonomous_message', category: 'nurture_step', authorized: true, playbookVersionId: 'v1' })).toEqual({ kind: 'autonomous_message', category: 'nurture_step', autonomy: 'within_playbook' });
    expect(classifyAction({ kind: 'handback', category: 'internal', authorized: false, playbookVersionId: null })).toEqual({ kind: 'handback', category: 'novel_message', autonomy: 'requires_approval' });
  });
});

describe('draftCategory (E35)', () => {
  it('R-AST-3 E35 a client asking about price or an offer makes the reply a money draft', () => {
    expect(draftCategory({ inboundText: 'Would they take 430? Should we make an offer?' })).toBe('money');
    expect(draftCategory({ inboundText: 'Can you send me the contract?' })).toBe('contract');
    expect(draftCategory({ inboundText: 'Thanks!', draftText: 'The commission is 3%.' })).toBe('money');
    expect(draftCategory({ inboundText: 'Is the contract ready?', draftText: 'Your offer is in.' })).toBe('money');
    expect(draftCategory({ inboundText: 'Sounds good, see you then', draftText: 'Great, see you Thursday!' })).toBe('novel_message');
    expect(draftCategory({})).toBe('novel_message');
  });
});

// R-AST-6 (stale draft) is enforced by api/assistant on approve; checkDraftCurrent is its pure check.
describe('checkDraftCurrent (R-AST-7, E16)', () => {
  const draft = { ownerUserId: 'u1', boundOwnershipSeq: 4, pinnedInboundSeq: 2 };
  const contact = { ownerUserId: 'u1', ownershipPeriodSeq: 4 };
  it('R-AST-7 E16 an ownership change (owner or period) invalidates a pending draft', () => {
    expect(checkDraftCurrent({ draft, contact, conversation: { inboundSeq: 2 } })).toEqual({ ok: true });
    expect(checkDraftCurrent({ draft, contact: { ...contact, ownerUserId: 'u2' }, conversation: { inboundSeq: 2 } })).toEqual({ ok: false, code: 'DRAFT_INVALIDATED' });
    expect(checkDraftCurrent({ draft, contact: { ...contact, ownershipPeriodSeq: 7 }, conversation: { inboundSeq: 2 } })).toEqual({ ok: false, code: 'DRAFT_INVALIDATED' });
    expect(checkDraftCurrent({ draft, contact: { ownerUserId: null, ownershipPeriodSeq: null }, conversation: null })).toEqual({ ok: false, code: 'DRAFT_INVALIDATED' });
    expect(checkDraftCurrent({ draft: { ...draft, ownerUserId: null, boundOwnershipSeq: null }, contact: { ownerUserId: null, ownershipPeriodSeq: null }, conversation: null })).toEqual({ ok: true });
  });

  it('R-AST-7 E16 in-period events (touch, breach, warning) do not invalidate: same owner and period seq, bigint or number', () => {
    expect(checkDraftCurrent({ draft: { ...draft, boundOwnershipSeq: 4n }, contact: { ownerUserId: 'u1', ownershipPeriodSeq: 4 }, conversation: { inboundSeq: 2n } })).toEqual({ ok: true });
  });

  it('a client reply after drafting makes the draft stale; invalidation wins over staleness', () => {
    // R-AST-6 is enforced by the API on approve; this is its pure check.
    expect(checkDraftCurrent({ draft, contact, conversation: { inboundSeq: 3 } })).toEqual({ ok: false, code: 'DRAFT_STALE' });
    expect(checkDraftCurrent({ draft: { ...draft, pinnedInboundSeq: null }, contact, conversation: { inboundSeq: 0 } })).toEqual({ ok: false, code: 'DRAFT_STALE' });
    expect(checkDraftCurrent({ draft, contact: { ...contact, ownerUserId: 'u2' }, conversation: { inboundSeq: 3 } })).toEqual({ ok: false, code: 'DRAFT_INVALIDATED' });
  });
});

describe('downgradeExplanation', () => {
  it('every downgrade has an honest sentence of at most 300 chars, never a score', () => {
    const all: DowngradeReason[] = ['ALWAYS_HUMAN_CATEGORY', 'CATEGORY_NOT_AUTONOMOUS', 'CATEGORY_DISABLED', 'STEP_CATEGORY_MISMATCH', 'NO_PLAYBOOK_VERSION', 'VERSION_NOT_APPROVED', 'NO_APPROVAL', 'APPROVAL_REVOKED', 'APPROVAL_HASH_MISMATCH', 'PAYMENT_INSTRUCTIONS', 'CONTENT_GUARD', 'INTENT_MISMATCH'];
    for (const d of all) {
      const s = downgradeExplanation(d);
      expect(s.length).toBeGreaterThan(0);
      expect(s.length).toBeLessThanOrEqual(300);
      expect(s).not.toMatch(/%|confiden/i);
    }
    expect(downgradeExplanation('ALWAYS_HUMAN_CATEGORY')).toBe('Money, contracts and new kinds of messages always need your tap.');
  });
});
