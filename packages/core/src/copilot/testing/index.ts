// Synthetic fixtures for the copilot (the repo is public: invented names, no real people or data).
import { type Instant, HOUR_MS, MINUTE_MS, DAY_MS, at, instant, localDate } from '../../foundation/index.js';
import type { CopilotActivity, CopilotInput, CopilotLead, CopilotPolicy, CopilotTimingCue, CopilotTranscript } from '../types.js';

export const POLICY: CopilotPolicy = { zone: 'America/New_York', brokerageName: 'Example Realty Group', businessOpen: '08:00', businessClose: '19:00' };

/** Monday 2026-11-23 10:00 ET (business hours) */
export const NOW: Instant = at('2026-11-23T15:00:00Z');

export const before = (ms: number, from: Instant = NOW): Instant => instant(from - ms);
export { DAY_MS, HOUR_MS, MINUTE_MS };

export function lead(over: Partial<CopilotLead> = {}): CopilotLead {
  return {
    id: 'lead-0001',
    firstName: 'Jordan',
    source: 'website',
    stage: 'new',
    createdAt: before(2 * MINUTE_MS),
    assignedAgent: { id: 'agent-01', displayName: 'Alex' },
    military: false,
    area: 'Riverside',
    hot: false,
    appointment: null,
    nextStep: null,
    reachable: { sms: true, email: true },
    doNotContact: false,
    ...over,
  };
}

let seq = 0;
export function act(over: Partial<CopilotActivity> & Pick<CopilotActivity, 'kind' | 'at'>): CopilotActivity {
  seq += 1;
  return { id: `act-${seq}`, direction: null, byHuman: false, ...over };
}

export const call = (atT: Instant, sec = 120): CopilotActivity => act({ kind: 'call', at: atT, direction: 'outbound', byHuman: true, durationSec: sec });
export const text = (atT: Instant, body = 'Checking in'): CopilotActivity => act({ kind: 'text', at: atT, direction: 'outbound', byHuman: true, body });
export const reply = (atT: Instant, body = 'Yes still looking'): CopilotActivity => act({ kind: 'text', at: atT, direction: 'inbound', byHuman: false, body });
export const note = (atT: Instant, body: string): CopilotActivity => act({ kind: 'note', at: atT, byHuman: true, body });
export const drip = (atT: Instant): CopilotActivity => act({ kind: 'automated', at: atT, direction: 'outbound', byHuman: false, body: 'Drip email 1' });

export function cue(over: Partial<CopilotTimingCue> = {}): CopilotTimingCue {
  return {
    intent: 'buy',
    windowStart: localDate('2026-11-01'),
    windowEnd: localDate('2027-02-28'),
    statedAt: before(20 * DAY_MS),
    evidence: 'Wants to buy in the next 3 months',
    origin: { kind: 'note', refId: 'note-1' },
    extractor: 'timing-scan/1 local',
    ...over,
  };
}

export function transcript(atT: Instant, lines: CopilotTranscript['lines']): CopilotTranscript {
  return { callActivityId: null, at: atT, durationSec: 300, lines, engine: 'local-stt/test' };
}

export function input(over: Partial<CopilotInput> = {}): CopilotInput {
  return { lead: lead(), activities: [], transcripts: [], timingCues: [], ...over };
}
