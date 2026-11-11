// Adversarial cases for core/parity-people (critical module 56): inputs a hostile or careless client
// could send. Opt-outs (R-PAR-12), ownership (R-PAR-43), mention spoofing (R-PAR-2) and the stage
// guard (R-PAR-14) must hold whatever the input.
import { describe, expect, it } from 'vitest';
import { at } from '../../foundation/time.js';
import { mentionToken, parseMentions, planReplacePoint, pointCountsForOptOut, removalReason, renderMentions, stageChangeAllowed, validateContactPatch, validateLoggedActivity } from './index.js';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('adversarial: core/parity-people', () => {
  it('R-PAR-43 ownership cannot be smuggled through the patch (camelCase, snake_case or __proto__)', () => {
    expect(validateContactPatch({ rowVersion: 1, ownerUserId: U(1) })).toMatchObject({ ok: false, code: 'FIELD_NOT_EDITABLE' });
    expect(validateContactPatch({ rowVersion: 1, owner_user_id: U(1) })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(validateContactPatch(JSON.parse(`{"rowVersion":1,"firstName":"A","__proto__":{"ownerUserId":"x"}}`))).toMatchObject({ ok: false });
    expect(validateContactPatch({ rowVersion: 1, do_not_contact_at: null })).toMatchObject({ ok: false });
    expect(validateContactPatch({ rowVersion: 1, imported_fields: {} })).toMatchObject({ ok: false });
  });
  it('R-PAR-12 no input makes a removed point stop counting except a ledger-proven wrong number', () => {
    expect(removalReason('wrong_number', false).ok).toBe(false);
    expect(pointCountsForOptOut({ removed: true, removedReason: 'replaced' })).toBe(true);
    // a status edit is not proof: removing as "old" keeps blocking
    const r = removalReason('old', true);
    expect(r.ok && pointCountsForOptOut({ removed: true, removedReason: r.reason })).toBe(true);
  });
  it('R-PAR-11 a replace cannot change the kind (an email typed into a phone is invalid, not a new email point)', () => {
    const old = { id: U(1), kind: 'phone' as const, address: '+14155550123', label: 'mobile' as const, removed: false, removedReason: null };
    expect(planReplacePoint(old, 'jane@example.com')).toEqual({ ok: false, code: 'PHONE_INVALID' });
    expect(planReplacePoint(old, '+1 415 555 0123 ext. 9')).toEqual({ ok: false, code: 'POINT_UNCHANGED' });
  });
  it('R-PAR-2 a crafted token cannot mention a non-member or the author, and labels cannot impersonate', () => {
    const body = `${mentionToken(U(9), 'Owner')} @[Sam](${U(2).toUpperCase()}) @[x](not-a-uuid) @[](${U(2)})`;
    expect(parseMentions(body, { members: [U(1), U(2)], self: U(1) })).toEqual({ ok: true, userIds: [U(2)] });
    expect(renderMentions(`@[Admin](${U(2)})`, () => 'Sam Lee')).toBe('@Sam Lee');
    // newlines or brackets in a label cannot open a second token
    expect(mentionToken(U(2), 'a](x)\n@[b')).toBe(`@[ax@b](${U(2)})`);
  });
  it('R-PAR-14 R-PAR-31 a logged activity cannot be back- or forward-dated past the window to unlock anything', () => {
    const now = at('2026-11-11T12:00:00Z');
    expect(validateLoggedActivity({ kind: 'call', at: at('2030-01-01T00:00:00Z') }, now).ok).toBe(false);
    expect(validateLoggedActivity({ kind: 'call', at: Number.NaN as never }, now).ok).toBe(false);
    // and a logged call never changes the stage decision: the guard reads first_touch_at only
    const c = { stage: 'new' as const, ownershipState: 'owned' as const, firstTouchDueAt: now, firstTouchAt: null };
    expect(stageChangeAllowed(c, { kind: 'user', role: 'agent' }, 'nurture').ok).toBe(false);
  });
});
