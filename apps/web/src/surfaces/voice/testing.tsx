// Fixtures and mounting for the module 55 voice tests (imported by *.test.tsx only). Every body here is checked
// against the API's real schemas by StaffFake (src/test/staffContract.ts) when a test answers with it.
import axe from 'axe-core';
import { renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import type { StaffFake } from '../../test/staffContract.js';
import { surface as voiceSurface } from './index.js';
import type { AnsweringView, CallVoiceView, TestCallResult } from './types.js';

export type Role = 'owner' | 'admin' | 'team_lead' | 'agent' | 'isa' | 'tc';
export const NOT_ADMINS = ['team_lead', 'agent', 'isa', 'tc'] as const;

/** The rendered-text check of the lane brief: no code, pack key, planning tag or ISO time. */
export const RAW_CODE = /\b[A-Z]{2,}_[A-Z_]+\b|platform:[a-z_]+|\(N\d+\)|\d{4}-\d\d-\d\dT/;

export const IDS = {
  playbook: '01900000-0000-7000-8000-0000000055a1',
  version: '01900000-0000-7000-8000-0000000055a2',
  call: '01900000-0000-7000-8000-0000000055c1',
  handback: '01900000-0000-7000-8000-0000000055c2',
  contact: '01900000-0000-7000-8000-0000000055c3',
  appointment: '01900000-0000-7000-8000-0000000055c4',
} as const;

/** The API's literal strings (apps/api/src/voice/answering.ts:27-28 VOICE_ATTESTATION_TEXT, :44-50 REASON, :31 OWNER_ONLY_DISABLE_SENTENCE;
 *  words.test.ts checks they are still there). */
export const API_ATTESTATION = 'I am the Owner. I reviewed the disclosure and turn on AI answering of missed and after-hours calls for this team.';
export const API_REASON_SENTENCES = {
  VOICE_NOT_CLEARED: 'AI answering waits for counsel review and a real voice vendor check (platform:voice is not cleared).',
  VOICE_VENDOR_NOT_CONFIGURED: 'No voice vendor is set up on this platform yet (N12). AI answering stays off.',
  VOICE_PLAYBOOK_NOT_APPROVED: 'The AI answering playbook is not approved yet.',
  AI_DISABLED: 'The assistant is turned off for this team.',
  VOICE_RECORDING_OFF: 'Call recording is off in the team policy; an AI call is always announced and recorded.',
  VOICE_ANSWERING_OFF: 'The Owner has not turned AI answering on.',
} as const;
export const API_OWNER_ONLY_DISABLE = "Only the Owner can turn AI answering off under this team's policy. Turning AI off for the team also stops it.";
/** apps/api/src/voice/provider.ts:76 VOICE_VENDOR_NOT_CONFIGURED_TEXT */
export const API_VENDOR_NOT_CONFIGURED_TEXT = 'No voice vendor is set up on this platform yet (N12). AI answering stays off.';
/** apps/api/src/voice/routes.ts:32 TEST_CALL_SENTENCE */
export const API_TEST_CALL_SENTENCE = 'Simulation with a scripted caller. No call was placed and nothing was saved.';

const reason = (code: keyof typeof API_REASON_SENTENCES) => ({ code, sentence: API_REASON_SENTENCES[code] });

/** GET /voice/answering as the API answers it in each state. */
export function answering(state: 'dark' | 'off' | 'off_blocked' | 'on', over: Partial<AnsweringView> = {}): AnsweringView {
  const base: AnsweringView = {
    state: 'off',
    reasons: [reason('VOICE_ANSWERING_OFF')],
    pack: { version: '2026.11.0', reviewedByCounselAt: '2026-11-02T15:00:00.000Z', vendorReady: true, cleared: true },
    playbook: { id: IDS.playbook, approvedVersionId: IDS.version, state: 'approved' },
    enabled: { on: false, sentence: 'AI answering is off.' },
    settings: { answerAfterSeconds: 20, answerWhen: 'after_hours_only', version: 4 },
    provider: { configured: true, statusText: 'Deterministic fake voice agent (tests and development only). No call reaches a vendor.' },
    transfers: 'Nobody is transferred live: no hot-lead rule is set.',
    attestationText: API_ATTESTATION,
  };
  const byState: Record<typeof state, Partial<AnsweringView>> = {
    dark: {
      state: 'dark',
      reasons: [reason('VOICE_NOT_CLEARED'), reason('VOICE_VENDOR_NOT_CONFIGURED'), reason('VOICE_PLAYBOOK_NOT_APPROVED'), reason('VOICE_ANSWERING_OFF')],
      pack: { version: '2026.11.0', reviewedByCounselAt: null, vendorReady: false, cleared: false },
      playbook: { id: IDS.playbook, approvedVersionId: null, state: 'draft' },
      provider: { configured: false, statusText: API_VENDOR_NOT_CONFIGURED_TEXT },
    },
    off: {},
    off_blocked: { reasons: [reason('VOICE_PLAYBOOK_NOT_APPROVED'), reason('VOICE_ANSWERING_OFF')], playbook: { id: IDS.playbook, approvedVersionId: null, state: 'draft' } },
    on: { state: 'on', reasons: [], enabled: { on: true, sentence: 'Attested by the Owner on 2026-11-03.' } },
  };
  return { ...base, ...byState[state], ...over };
}

export function testCall(over: Partial<TestCallResult> = {}): TestCallResult {
  return {
    sentence: API_TEST_CALL_SENTENCE,
    lines: [
      { source: 'disclosure', text: "Hi, you've reached the Harbor team's automated assistant." },
      { source: 'announcement', text: 'This call is recorded.' },
      { source: 'model', text: 'I can book a time with your agent.' },
      { source: 'script', text: "You're booked. I'm the team's automated assistant; your agent will confirm by text." },
    ],
    ledger: [
      { seq: 1, tool: 'check_availability', decision: 'deny', reasonCode: 'VOICE_TOOL_BEFORE_DISCLOSURE' },
      { seq: 2, tool: 'check_availability', decision: 'allow', reasonCode: 'ALLOW_AVAILABILITY' },
      { seq: 3, tool: 'book_appointment', decision: 'allow', reasonCode: 'ALLOW_OFFERED_SLOT' },
      { seq: 4, tool: null, decision: 'deny', reasonCode: 'VOICE_TOOL_UNKNOWN' },
    ],
    handback: { outcome: 'booked', endReason: 'MODEL_ENDED_CALL', critical: false, messageTopics: [], noPhoneCallback: false, confirmationChannel: 'sms' },
    ...over,
  };
}

/** GET /calls/:id/voice for an ended call (the shape the API answered in a real run, ids synthetic). */
export function callVoice(over: Partial<CallVoiceView> = {}): CallVoiceView {
  return {
    callId: IDS.call,
    state: 'ended',
    sentence: 'The assistant answered this call and handed it back.',
    takeoverAt: '2026-11-13T14:11:50.617Z',
    outcome: 'booked',
    outcomeSentence: 'The assistant booked a time with you.',
    endReason: 'MODEL_ENDED_CALL',
    transferOutcome: null,
    ledger: [
      { seq: 2, tool: 'check_availability', args: {}, decision: 'allow', reasonCode: 'ALLOW_AVAILABILITY', occurredAt: '2026-11-13T14:11:41.194Z' },
      { seq: 3, tool: 'book_appointment', args: { kind: 'buyer_consult', slot_start: '2026-11-13T16:30:00.000Z', slot_end: '2026-11-13T17:00:00.000Z' }, decision: 'allow', reasonCode: 'ALLOW_OFFERED_SLOT', occurredAt: '2026-11-13T14:11:45.194Z' },
      { seq: 4, tool: 'end_call', args: { reason_code: 'BOOKED' }, decision: 'allow', reasonCode: 'ALLOW_END_CALL', occurredAt: '2026-11-13T14:11:49.194Z' },
    ],
    unlogged: [{ seq: 1, reason: 'VOICE_TOOL_BEFORE_DISCLOSURE', at: '2026-11-13T14:11:31.694Z' }],
    handbackId: IDS.handback,
    ...over,
  };
}

export function session(role: Role) {
  const s = sessionFixture({ reauthenticatedAt: null });
  const tenant = { ...s.tenant!, role };
  return { ...s, tenant, tenants: [tenant] };
}

/** The whole app at `path` as `role`, with the voice surface (plus any `extra`) in the page table. */
export function mountAs(fake: StaffFake, role: Role, path: string, ...extra: Parameters<typeof tableWith>) {
  fake.on('GET /auth/session', { status: 200, body: session(role) });
  return renderApp({ fake, path, table: tableWith(voiceSurface, ...extra) });
}

/** Every rendered text node and accessible label of the page (dialogs included). */
export function pageText(): string {
  return document.body.textContent ?? '';
}

/** axe on the whole document (contrast is the design system's, checked by the e2e sweep). */
export async function axeViolations(): Promise<string[]> {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}
