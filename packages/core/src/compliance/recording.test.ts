import { describe, expect, it } from 'vitest';
import { at } from '../foundation/index.js';
import type { JurisdictionPack } from './policy.js';
import { decideRecording, partyRuleFor, recordingMayStart } from './recording.js';
import { usPack } from './testing/fixtures.js';

const p = (key: string, rule?: 'one_party' | 'all_party' | 'unknown'): JurisdictionPack => ({
  key,
  version: '1',
  reviewedByCounselAt: null,
  rules: rule === undefined ? {} : { recordingPartyRule: rule },
});
const packs = [usPack(), p('US-NY', 'one_party'), p('US-TX', 'one_party'), p('US-CA', 'all_party'), p('US-ZZ')];

describe('partyRuleFor', () => {
  it('uses only the exact pack, else unknown (a state never inherits the country rule)', () => {
    expect(partyRuleFor('US-NY', packs)).toBe('one_party');
    expect(partyRuleFor(' us-ca ', packs)).toBe('all_party');
    expect(partyRuleFor('US-ZZ', packs)).toBe('unknown'); // exact pack without a rule → unknown
    expect(partyRuleFor('US-ZZ', [p('US', 'one_party'), p('US-ZZ')])).toBe('unknown');
    expect(partyRuleFor('US-TX', [p('US', 'one_party')])).toBe('unknown');
    expect(partyRuleFor('US', [p('US', 'one_party')])).toBe('one_party');
    expect(partyRuleFor('US-FL', packs)).toBe('unknown');
    expect(partyRuleFor('CA-ON', packs)).toBe('unknown');
    expect(partyRuleFor(undefined, packs)).toBe('unknown');
    expect(partyRuleFor('  ', packs)).toBe('unknown');
  });
});

describe('decideRecording (R-CONSENT-16)', () => {
  it('R-CONSENT-16 announce_all (default) always announces to all parties', () => {
    expect(decideRecording({ agentJurisdiction: 'US-NY', clientJurisdictions: ['US-NY'], packs, mode: 'announce_all', direction: 'outbound' })).toEqual({
      mode: 'announced_all_parties',
      announce: true,
      basis: 'policy_announce_all:outbound',
    });
  });

  it('R-CONSENT-16 one_party_where_permitted skips the announcement only when the agent and every client jurisdiction are one-party', () => {
    expect(decideRecording({ agentJurisdiction: 'US-NY', clientJurisdictions: ['US-TX', 'US-NY'], packs, mode: 'one_party_where_permitted', direction: 'inbound' })).toEqual({
      mode: 'one_party_no_announcement',
      announce: false,
      basis: 'one_party:US-NY,US-TX:inbound',
    });
  });

  it.each([
    ['an all-party client state', 'US-NY', ['US-CA']],
    ['one unknown candidate among several', 'US-NY', ['US-TX', 'US-FL']],
    ['an unknown agent jurisdiction', undefined, ['US-NY']],
    ['an all-party agent state', 'US-CA', ['US-NY']],
    ['no client jurisdiction at all', 'US-NY', []],
    ['the unreviewed US placeholder (party rule unknown)', 'US-FL', ['US-GA']],
  ])('R-CONSENT-16 still announces with %s', (_n, agent, clients) => {
    const d = decideRecording({ agentJurisdiction: agent, clientJurisdictions: clients, packs, mode: 'one_party_where_permitted', direction: 'outbound' });
    expect(d.mode).toBe('announced_all_parties');
    expect(d.announce).toBe(true);
    expect(d.basis).toBe('party_rule_not_one_party:outbound');
  });

  it('recording disabled by policy ⇒ off', () => {
    expect(decideRecording({ clientJurisdictions: ['US-NY'], packs, mode: 'announce_all', direction: 'outbound', enabled: false })).toEqual({ mode: 'off', announce: false, basis: 'recording_disabled:outbound' });
    expect(decideRecording({ clientJurisdictions: ['US-NY'], packs, mode: 'announce_all', direction: 'inbound', enabled: true }).mode).toBe('announced_all_parties');
  });

  it('R-CONSENT-16 E48 a third party joining re-evaluates and re-announces', () => {
    const before = decideRecording({ agentJurisdiction: 'US-NY', clientJurisdictions: ['US-TX'], packs, mode: 'one_party_where_permitted', direction: 'outbound' });
    expect(before.announce).toBe(false);
    const afterJoin = decideRecording({ agentJurisdiction: 'US-NY', clientJurisdictions: ['US-TX', 'US-CA'], packs, mode: 'one_party_where_permitted', direction: 'outbound' });
    expect(afterJoin).toMatchObject({ mode: 'announced_all_parties', announce: true });
    expect(recordingMayStart(afterJoin, null)).toBe(false);
  });

  it('R-CONSENT-16 E47 a recording whose announcement failed never starts', () => {
    const d = decideRecording({ clientJurisdictions: ['US-NY'], packs, mode: 'announce_all', direction: 'outbound' });
    expect(recordingMayStart(d, null)).toBe(false);
    expect(recordingMayStart(d, at('2026-11-10T15:00:00Z'))).toBe(true);
    expect(recordingMayStart({ mode: 'one_party_no_announcement', announce: false, basis: 'x' }, null)).toBe(true);
    expect(recordingMayStart({ mode: 'off', announce: false, basis: 'x' }, at('2026-11-10T15:00:00Z'))).toBe(false);
  });
});
