import { describe, expect, it } from 'vitest';
import { at, DAY_MS, instant, MINUTE_MS } from '../../foundation/time.js';
import { localDate, zone } from '../../foundation/tz.js';
import {
  DEFAULT_STAGE_LABELS,
  LOGGED_ACTIVITY_IS_TOUCH,
  addedMentions,
  annualComingUp,
  daysUntilAnnual,
  defaultActivityBody,
  lockedStages,
  maskedTail,
  mentionDedupeKey,
  mentionTitle,
  mentionToken,
  nextAnnualOccurrence,
  parseMentions,
  planReplacePoint,
  pointCountsForOptOut,
  removalReason,
  renderMentions,
  restorable,
  stageChangeAllowed,
  stageLabel,
  suggestsDoNotContact,
  validateContactPatch,
  validateLoggedActivity,
  validateStageLabels,
} from './index.js';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = at('2026-11-11T15:00:00Z');

describe('core/parity-people: contact patch (R-PAR-43)', () => {
  it('R-PAR-43 accepts names, type, intent, timezone, stage and pond summary with a row version', () => {
    const r = validateContactPatch({ rowVersion: 3, firstName: ' Jane ', lastName: null, intent: 'buyer', timezone: 'America/Chicago', stage: 'nurture', contactType: 'sphere', pondSummary: 'Condo near the lake' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.patch.firstName).toBe('Jane');
      expect(r.fields).toEqual(['firstName', 'lastName', 'contactType', 'intent', 'timezone', 'stage', 'pondSummary']);
    }
  });
  it('R-PAR-43 never edits ownership, attribution, merge/delete state, do-not-contact, tags or imported fields', () => {
    for (const k of ['ownerUserId', 'ownershipState', 'originalLeadSourceId', 'mergedIntoContactId', 'deletedAt', 'doNotContactAt', 'importedFields', 'tags', 'tenantId']) {
      const r = validateContactPatch({ rowVersion: 1, firstName: 'A', [k]: 'x' });
      expect(r, k).toMatchObject({ ok: false, code: 'FIELD_NOT_EDITABLE', issues: [{ path: `/${k}`, code: 'not_editable' }] });
    }
  });
  it('R-PAR-43 unknown keys, a missing row version, a bad zone and an empty patch are refused', () => {
    expect(validateContactPatch({ rowVersion: 1, nickname: 'x' })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(validateContactPatch({ firstName: 'A' })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(validateContactPatch({ rowVersion: 1, timezone: 'Mars/Olympus' })).toMatchObject({ ok: false, issues: [{ path: '/timezone' }] });
    expect(validateContactPatch({ rowVersion: 1 })).toMatchObject({ ok: false, issues: [{ path: '/', code: 'empty' }] });
    expect(validateContactPatch({ rowVersion: 1, displayName: '   ' })).toMatchObject({ ok: false });
    expect(validateContactPatch({ rowVersion: 1, stage: 'parked' })).toMatchObject({ ok: false });
    expect(validateContactPatch(null)).toMatchObject({ ok: false });
    expect(validateContactPatch([1])).toMatchObject({ ok: false });
  });
});

describe('core/parity-people: points (R-PAR-11, R-PAR-12)', () => {
  const old = { id: U(1), kind: 'phone' as const, address: '+14155550123', label: 'mobile' as const, removed: false, removedReason: null };
  it('R-PAR-11 E170 replace = remove (replaced) + add; the address is never edited in place', () => {
    const r = planReplacePoint(old, '(415) 555-0124');
    expect(r).toEqual({ ok: true, plan: { remove: { id: U(1), reason: 'replaced' }, add: { kind: 'phone', address: '+14155550124', label: 'mobile' } } });
  });
  it('R-PAR-11 refuses an invalid, unchanged or already-removed point', () => {
    expect(planReplacePoint(old, 'call me')).toEqual({ ok: false, code: 'PHONE_INVALID' });
    expect(planReplacePoint(old, '+1 415 555 0123')).toEqual({ ok: false, code: 'POINT_UNCHANGED' });
    expect(planReplacePoint({ ...old, removed: true, removedReason: 'old' }, '+14155550124')).toEqual({ ok: false, code: 'POINT_REMOVED' });
    const email = { ...old, kind: 'email' as const, address: 'jane@example.com', label: 'other' as const };
    expect(planReplacePoint(email, ' Jane.Doe@Example.com ', 'work')).toMatchObject({ ok: true, plan: { add: { kind: 'email', address: 'jane.doe@example.com', label: 'work' } } });
    expect(planReplacePoint(email, 'not-an-email')).toEqual({ ok: false, code: 'EMAIL_INVALID' });
  });
  it('R-PAR-12 a removed point keeps blocking unless removed as a confirmed wrong number', () => {
    expect(pointCountsForOptOut({ removed: false, removedReason: null })).toBe(true);
    expect(pointCountsForOptOut({ removed: true, removedReason: 'old' })).toBe(true);
    expect(pointCountsForOptOut({ removed: true, removedReason: 'replaced' })).toBe(true);
    expect(pointCountsForOptOut({ removed: true, removedReason: null })).toBe(true);
    expect(pointCountsForOptOut({ removed: true, removedReason: 'wrong_number' })).toBe(false);
  });
  it('R-PAR-12 E169 wrong_number needs the ledger record; a confirmed wrong number is never restored', () => {
    expect(removalReason('wrong_number', false)).toEqual({ ok: false, code: 'WRONG_NUMBER_NOT_RECORDED' });
    expect(removalReason('wrong_number', true)).toEqual({ ok: true, reason: 'wrong_number' });
    expect(removalReason('old', false)).toEqual({ ok: true, reason: 'old' });
    expect(restorable({ removed: true, removedReason: 'wrong_number' })).toBe(false);
    expect(restorable({ removed: true, removedReason: 'old' })).toBe(true);
    expect(maskedTail('+14155550123')).toBe('•••0123');
  });
});

describe('core/parity-people: stages (R-PAR-13, R-PAR-14)', () => {
  const untouched = { stage: 'new' as const, ownershipState: 'owned' as const, firstTouchDueAt: NOW, firstTouchAt: null };
  it('R-PAR-14 E171 an agent or ISA cannot park an untouched routed lead outside new/attempting, lost included', () => {
    for (const role of ['agent', 'isa'] as const) {
      expect(stageChangeAllowed(untouched, { kind: 'user', role }, 'nurture')).toEqual({ ok: false, code: 'STAGE_NEEDS_CONTACT' });
      expect(stageChangeAllowed(untouched, { kind: 'user', role }, 'lost')).toEqual({ ok: false, code: 'STAGE_NEEDS_CONTACT' });
      expect(stageChangeAllowed(untouched, { kind: 'user', role }, 'attempting')).toEqual({ ok: true });
      expect(lockedStages(untouched, { kind: 'user', role })).toEqual(['connected', 'nurture', 'active', 'under_contract', 'closed', 'lost']);
    }
  });
  it('R-PAR-14 a TL/Owner/Admin may move it; a touched, self-created or unowned lead is unaffected', () => {
    for (const role of ['team_lead', 'owner', 'admin'] as const) expect(stageChangeAllowed(untouched, { kind: 'user', role }, 'lost')).toEqual({ ok: true });
    const agent = { kind: 'user' as const, role: 'agent' as const };
    expect(stageChangeAllowed({ ...untouched, firstTouchAt: NOW }, agent, 'lost').ok).toBe(true);
    expect(stageChangeAllowed({ ...untouched, firstTouchDueAt: null }, agent, 'lost').ok).toBe(true);
    expect(stageChangeAllowed({ ...untouched, ownershipState: 'in_pond' }, agent, 'lost').ok).toBe(true);
    expect(stageChangeAllowed(untouched, { kind: 'system' }, 'lost').ok).toBe(true);
    expect(lockedStages({ ...untouched, firstTouchAt: NOW }, agent)).toEqual([]);
  });
  it('R-PAR-13 labels rename one of the eight stages, 1-24 characters; code keeps the keys', () => {
    expect(validateStageLabels({ nurture: ' Long term ' })).toEqual({ ok: true, labels: { nurture: 'Long term' } });
    expect(validateStageLabels({ parked: 'X' })).toEqual({ ok: false, code: 'STAGE_LABEL_INVALID' });
    expect(validateStageLabels({ active: '' })).toEqual({ ok: false, code: 'STAGE_LABEL_INVALID' });
    expect(validateStageLabels({ active: 'x'.repeat(25) })).toEqual({ ok: false, code: 'STAGE_LABEL_INVALID' });
    expect(validateStageLabels({ active: 'a\u0007' })).toEqual({ ok: false, code: 'STAGE_LABEL_INVALID' });
    expect(validateStageLabels([])).toEqual({ ok: false, code: 'STAGE_LABEL_INVALID' });
    expect(stageLabel('nurture', { nurture: 'Long term' })).toBe('Long term');
    expect(stageLabel('under_contract')).toBe(DEFAULT_STAGE_LABELS.under_contract);
  });
});

describe('core/parity-people: mentions (R-PAR-2, R-PAR-3)', () => {
  const members = [U(1), U(2), U(3)];
  it('R-PAR-3 deduped, self dropped, non-members dropped', () => {
    const body = `Hi ${mentionToken(U(2), 'Sam')} and ${mentionToken(U(2), 'Sam again')} and ${mentionToken(U(1), 'me')} and ${mentionToken(U(9), 'ghost')}`;
    expect(parseMentions(body, { members, self: U(1) })).toEqual({ ok: true, userIds: [U(2)] });
  });
  it('R-PAR-3 at most 10 people', () => {
    const many = Array.from({ length: 12 }, (_, i) => U(100 + i));
    const body = many.map((id) => mentionToken(id, 'x')).join(' ');
    expect(parseMentions(body, { members: many, self: U(1) })).toEqual({ ok: false, code: 'MENTION_LIMIT', count: 12 });
    expect(parseMentions(many.slice(0, 10).map((id) => mentionToken(id, 'x')).join(' '), { members: many, self: U(1) })).toMatchObject({ ok: true });
  });
  it('R-PAR-3 E164 an edit notifies only newly added people', () => {
    expect(addedMentions([U(2)], [U(2), U(3)])).toEqual([U(3)]);
  });
  it('R-PAR-3 the notification never carries note text: first name + initial at most, keyed per note', () => {
    expect(mentionTitle('Jane D.')).toBe('You were mentioned in a note on Jane D.');
    expect(mentionTitle(null)).toBe('You were mentioned in a note');
    expect(mentionDedupeKey(U(5))).toBe(`mention:${U(5)}`);
  });
  it('R-PAR-2 the token label is display only: rendering uses the directory name', () => {
    const body = `ask ${mentionToken(U(2), 'Owner (fake)')}`;
    expect(renderMentions(body, (id) => (id === U(2) ? 'Sam Lee' : null))).toBe('ask @Sam Lee');
    expect(renderMentions(body)).toBe('ask @Owner fake');
  });
});

describe('core/parity-people: logged activity (R-PAR-5, R-PAR-30, R-PAR-31, R-PAR-32)', () => {
  it('R-PAR-30 a call with an outcome and an empty note gets an honest default body', () => {
    const r = validateLoggedActivity({ kind: 'call', at: NOW, outcome: 'no_answer' }, NOW);
    expect(r).toEqual({ ok: true, activity: { kind: 'call', direction: 'outbound', at: NOW, outcome: 'no_answer', body: 'Outbound call: no answer', remindInDays: null } });
    expect(defaultActivityBody('email', 'inbound', null)).toBe('Inbound email');
  });
  it('R-PAR-31 E192 at most 5 minutes ahead and a year back', () => {
    expect(validateLoggedActivity({ kind: 'text', at: instant(NOW + 5 * MINUTE_MS) }, NOW).ok).toBe(true);
    expect(validateLoggedActivity({ kind: 'text', at: instant(NOW + 5 * MINUTE_MS + 1) }, NOW)).toEqual({ ok: false, code: 'ACTIVITY_IN_FUTURE' });
    expect(validateLoggedActivity({ kind: 'text', at: instant(NOW + DAY_MS) }, NOW)).toEqual({ ok: false, code: 'ACTIVITY_IN_FUTURE' });
    expect(validateLoggedActivity({ kind: 'text', at: instant(NOW - 365 * DAY_MS) }, NOW).ok).toBe(true);
    expect(validateLoggedActivity({ kind: 'text', at: instant(NOW - 366 * DAY_MS) }, NOW)).toEqual({ ok: false, code: 'ACTIVITY_TOO_OLD' });
  });
  it('R-PAR-30 outcomes are for calls only; reminder days are 1-365', () => {
    expect(validateLoggedActivity({ kind: 'email', at: NOW, outcome: 'connected' }, NOW)).toEqual({ ok: false, code: 'OUTCOME_CALLS_ONLY' });
    expect(validateLoggedActivity({ kind: 'call', at: NOW, remindInDays: 0 }, NOW)).toEqual({ ok: false, code: 'VALIDATION_FAILED' });
    expect(validateLoggedActivity({ kind: 'call', at: NOW, remindInDays: 3 }, NOW)).toMatchObject({ ok: true, activity: { remindInDays: 3 } });
    expect(validateLoggedActivity({ kind: 'meeting' as never, at: NOW }, NOW)).toEqual({ ok: false, code: 'VALIDATION_FAILED' });
  });
  it('R-PAR-5 R-PAR-32 a logged activity is never a touch', () => {
    expect(LOGGED_ACTIVITY_IS_TOUCH).toBe(false);
  });
  it('R-PAR-32 E193 "they said stop" in free text only prompts for the real do-not-contact', () => {
    for (const t of ['She said STOP', "don't call me again", 'asked not to be contacted', 'Unsubscribe me', 'take me off your list', 'DNC']) expect(suggestsDoNotContact(t), t).toBe(true);
    for (const t of ['Call back Tuesday', 'Stopped by the open house? no', null, '']) expect(suggestsDoNotContact(t), String(t)).toBe(false);
  });
});

describe('core/parity-people: annual dates (R-PAR-20)', () => {
  const ny = zone('America/New_York');
  it('R-PAR-20 E176 29 February falls on 28 February in non-leap years', () => {
    expect(nextAnnualOccurrence(localDate('1992-02-29'), ny, at('2026-11-11T12:00:00Z'))).toBe('2027-02-28');
    expect(nextAnnualOccurrence(localDate('1992-02-29'), ny, at('2027-03-01T12:00:00Z'))).toBe('2028-02-29');
  });
  it('R-PAR-20 today counts as coming up; the date is local to the tenant zone', () => {
    // 2026-11-12T03:00Z is still 11 Nov in New York
    expect(nextAnnualOccurrence(localDate('1980-11-11'), ny, at('2026-11-12T03:00:00Z'))).toBe('2026-11-11');
    expect(nextAnnualOccurrence(localDate('1980-11-11'), zone('Etc/UTC'), at('2026-11-12T03:00:00Z'))).toBe('2027-11-11');
    expect(daysUntilAnnual(localDate('1980-11-14'), ny, at('2026-11-11T15:00:00Z'))).toBe(3);
    expect(annualComingUp(localDate('1980-11-14'), ny, at('2026-11-11T15:00:00Z'), 3)).toBe(true);
    expect(annualComingUp(localDate('1980-11-15'), ny, at('2026-11-11T15:00:00Z'), 3)).toBe(false);
  });
});
