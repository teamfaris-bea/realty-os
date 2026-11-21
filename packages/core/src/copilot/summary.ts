// The lead summary (CP-2): confirmed facts the agent can scan in seconds, computed without any model, plus
// an optional local-model narrative marked UNVERIFIED. Timing cues come from the timing-scan lane and call
// transcripts from the transcription lane (CP-9); both are counted and shown with their labels.
import { type Instant, HOUR_MS } from '../foundation/index.js';
import { chronological, isHumanTouch, isInboundReply, lastWhere } from './history.js';
import { ago } from './prompt.js';
import { timingViews } from './timing.js';
import type { CopilotInput, CopilotPolicy, SummaryFacts } from './types.js';

const SOURCE_TEXT: Record<SummaryFacts['source'], string> = {
  website: 'Website', google_ads: 'Google Ads', portal: 'Portal', referral: 'Referral', past_client: 'Past client',
  open_house: 'Open house', manual: 'Entered by hand', import: 'Imported', other: 'Other source',
};

export function summaryFacts(input: CopilotInput, policy: CopilotPolicy, now: Instant): SummaryFacts {
  const acts = chronological(input.activities, now);
  const human = acts.filter(isHumanTouch);
  const count = (k: string): number => human.filter((a) => a.kind === k).length;
  return {
    leadId: input.lead.id,
    source: input.lead.source,
    stage: input.lead.stage,
    ageHours: Math.max(0, Math.floor((now - input.lead.createdAt) / HOUR_MS)),
    assignedAgentId: input.lead.assignedAgent?.id ?? null,
    humanCalls: count('call'),
    humanTexts: count('text'),
    humanEmails: count('email'),
    talkSeconds: human.filter((a) => a.kind === 'call').reduce((s, a) => s + (a.durationSec ?? 0), 0),
    appointments: count('appointment'),
    notes: acts.filter((a) => a.kind === 'note').length,
    automatedTouches: acts.filter((a) => a.kind === 'automated' || (!a.byHuman && a.direction === 'outbound')).length,
    lastHumanTouchAt: lastWhere(acts, isHumanTouch)?.at ?? null,
    lastInboundAt: lastWhere(acts, isInboundReply)?.at ?? null,
    transcripts: input.transcripts.filter((t) => t.at <= now).length,
    timing: timingViews(input.timingCues, now, policy.zone),
    label: 'CONFIRMED',
  };
}

const WINDOW_TEXT = { current: 'window is now', soon: 'window starts within 90 days', upcoming: 'window is later', passed: 'plan date has passed', open_ended: 'no dates given' } as const;

/** Short fact lines; no phone, email or note text (the narrative may quote the history; these never do). */
export function summaryLines(f: SummaryFacts, now: Instant): string[] {
  const lines = [
    `${SOURCE_TEXT[f.source]} lead, ${f.ageHours < 48 ? `${f.ageHours} h` : `${Math.floor(f.ageHours / 24)} days`} old, stage ${f.stage.replace('_', ' ')}, ${f.assignedAgentId === null ? 'unassigned' : 'assigned'}.`,
    `Agent touches: ${f.humanCalls} calls (${Math.round(f.talkSeconds / 60)} min talk), ${f.humanTexts} texts, ${f.humanEmails} emails, ${f.appointments} appointments; ${f.automatedTouches} automated.`,
    `Last agent touch: ${f.lastHumanTouchAt === null ? 'never' : ago(now - f.lastHumanTouchAt)}. Last reply from the lead: ${f.lastInboundAt === null ? 'none' : ago(now - f.lastInboundAt)}.`,
    `Notes: ${f.notes}. Call transcripts: ${f.transcripts}.`,
  ];
  for (const t of f.timing.slice(0, 2)) lines.push(`Timing (UNVERIFIED): ${t.intent}, ${WINDOW_TEXT[t.status]}, said ${ago(now - t.statedAt)}.`);
  if (f.timing.length === 0) lines.push('Timing: none found in the notes (DATA GAP).');
  return lines;
}
