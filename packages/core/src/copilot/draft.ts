// Draft selection and the playbook templates (CP-3, CP-4, CP-8).
//
// The copilot picks ONE next message for the agent: which purpose, which channel, and a template text that
// already passes every check. The local model may then write a better one from the history; that text is
// used only if it passes the same checks (and names no number the records do not), else the template stays.
// The agent copies it and sends it themselves. Nothing here sends (CP-1).
import { DateTime } from 'luxon';
import { type Instant, zone } from '../foundation/index.js';
import { chronological, isHumanTouch } from './history.js';
import { timingStatus } from './timing.js';
import type { CopilotDraft, CopilotInput, CopilotPolicy, DraftIssue, DraftPurpose, SlipFlag } from './types.js';
import { RENTAL_TERMS, checkDraft } from './voice.js';

export interface DraftPlan {
  channel: 'sms' | 'email';
  purpose: DraftPurpose;
  marketing: boolean;
  /** what the template and the model both work from */
  greetingName: string | null;
  agentName: string | null;
  area: string | null;
  appointmentText: string | null;
  intent: 'buy' | 'sell' | 'both' | null;
}

export type DraftPlanResult = { ok: true; plan: DraftPlan } | { ok: false; reason: 'DO_NOT_CONTACT' | 'NO_CONTACT_CHANNEL' | 'NOT_WORKABLE' };

/** A name or area from the records, safe to put in a text: letters, spaces, ' . -, short; else left out. */
export function safeWord(s: string | null, max: number): string | null {
  if (s === null) return null;
  const t = s.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (t === '' || t.length > max || !/^[\p{L}][\p{L}\p{M} .'’-]*$/u.test(t)) return null;
  if (RENTAL_TERMS.some((re) => re.test(t))) return null;
  return t;
}

export function planDraft(input: CopilotInput, flags: readonly SlipFlag[], policy: CopilotPolicy, now: Instant): DraftPlanResult {
  const { lead } = input;
  if (lead.doNotContact) return { ok: false, reason: 'DO_NOT_CONTACT' };
  if (lead.stage === 'closed' || lead.stage === 'trash') return { ok: false, reason: 'NOT_WORKABLE' };
  const channel = lead.reachable.sms ? 'sms' : lead.reachable.email ? 'email' : null;
  if (channel === null) return { ok: false, reason: 'NO_CONTACT_CHANNEL' };

  const touched = chronological(input.activities, now).some(isHumanTouch);
  const cues = input.timingCues.filter((c) => c.excluded === undefined && c.statedAt <= now).sort((a, b) => b.statedAt - a.statedAt);
  const statuses = cues.map((c) => ({ c, s: timingStatus(c, now, policy.zone) }));
  const liveCue = statuses.find((x) => x.s === 'current' || x.s === 'soon');
  const passedCue = statuses.find((x) => x.s === 'passed');
  const appt = lead.appointment;

  let purpose: DraftPurpose;
  let intent: DraftPlan['intent'] = null;
  if (!touched && lead.source !== 'import') purpose = 'first_contact';
  else if (flags.some((f) => f.code === 'REPLY_NOT_RECONTACTED')) purpose = 'reply_follow_up';
  else if (appt !== null && !appt.confirmed && appt.at > now) purpose = 'appointment_confirm';
  else if (liveCue !== undefined) { purpose = 'timing_call'; intent = liveCue.c.intent; }
  else if (passedCue !== undefined) { purpose = 'timing_check_in'; intent = passedCue.c.intent; }
  else if (!touched) purpose = 'first_contact';
  else purpose = 'follow_up';

  const appointmentText = purpose === 'appointment_confirm' && appt !== null
    ? DateTime.fromMillis(appt.at, { zone: zone(policy.zone) }).toFormat("cccc, LLL d 'at' h:mm a")
    : null;
  return {
    ok: true,
    plan: {
      channel,
      purpose,
      marketing: purpose === 'first_contact' || channel === 'email',
      greetingName: safeWord(lead.firstName, 30),
      agentName: lead.assignedAgent === null ? null : safeWord(lead.assignedAgent.displayName, 30),
      area: safeWord(lead.area, 40),
      appointmentText,
      intent,
    },
  };
}

const INTENT_WORD = { buy: 'buying', sell: 'selling', both: 'making a move' } as const;
const INTENT_VERB = { buy: 'buy', sell: 'sell', both: 'move' } as const;

/** The playbook text for a plan. Every combination passes checkDraft (tested). */
export function templateDraft(plan: DraftPlan, input: CopilotInput, policy: CopilotPolicy): { text: string; subject: string | null } {
  const hi = plan.greetingName === null ? 'Hi,' : `Hi ${plan.greetingName},`;
  const intro = plan.agentName === null ? `this is ${policy.brokerageName}.` : `this is ${plan.agentName} with ${policy.brokerageName}.`;
  const lead = input.lead;
  let body: string;
  let subject: string;
  switch (plan.purpose) {
    case 'first_contact':
      if (lead.military) {
        body = 'Saw you may be on PCS orders, and I help a lot of military buyers with VA timing. What time works for a quick call today?';
      } else if (lead.source === 'referral') {
        body = 'Glad you were referred our way. Would a quick call today or tomorrow work?';
      } else if (lead.source === 'past_client') {
        body = 'Good to reconnect. Would a quick call this week work?';
      } else {
        body = `Saw you were looking at homes${plan.area === null ? '' : ` in ${plan.area}`}. Are you free for a quick call in the next 10 minutes?`;
      }
      subject = 'Quick call today?';
      break;
    case 'reply_follow_up':
      body = 'Got your message, sorry for the slow reply. Can I call you today?';
      subject = 'Got your message';
      break;
    case 'appointment_confirm':
      body = `Confirming our appointment ${plan.appointmentText ?? 'this week'}. Does that time still work?`;
      subject = 'Confirming our appointment';
      break;
    case 'timing_call':
      body = `You mentioned ${INTENT_WORD[plan.intent ?? 'both']} around now. Are you free for a quick call today?`;
      subject = 'Quick call today?';
      break;
    case 'timing_check_in':
      body = `Checking in, are you still planning to ${INTENT_VERB[plan.intent ?? 'both']}? Happy to set a quick call this week.`;
      subject = 'Still planning to move?';
      break;
    case 'follow_up':
      body = 'Checking in on your plans. Would a quick call this week help?';
      subject = 'Checking in';
      break;
  }
  const withIntro = plan.marketing ? `${hi} ${intro} ${body}` : `${hi} ${body.charAt(0).toLowerCase()}${body.slice(1)}`;
  const text = plan.channel === 'email' ? `${withIntro}\n\nThank you` : `${withIntro} Thank you`;
  return { text, subject: plan.channel === 'email' ? subject : null };
}

/** Numbers in a model draft must come from the records or the template (no invented prices, dates, addresses). */
export function unsupportedNumbers(text: string, context: string): string[] {
  const have = new Set(context.match(/\d+/gu) ?? []);
  return [...new Set(text.match(/\d+/gu) ?? [])].filter((n) => !have.has(n));
}

export function finalizeDraft(
  plan: DraftPlan,
  input: CopilotInput,
  policy: CopilotPolicy,
  model: { text: string; subject: string | null; context: string } | null,
): { draft: CopilotDraft; modelRejected: DraftIssue[] | null } {
  const tpl = templateDraft(plan, input, policy);
  const base = { channel: plan.channel, purpose: plan.purpose, marketing: plan.marketing, agentSendsThemselves: true as const };
  let modelRejected: DraftIssue[] | null = null;
  if (model !== null) {
    const subject = plan.channel === 'email' ? (model.subject?.trim() || tpl.subject) : null;
    const check = (text: string): DraftIssue[] => {
      const issues = checkDraft({ channel: plan.channel, text, subject, marketing: plan.marketing, brokerageName: policy.brokerageName });
      if (unsupportedNumbers(`${subject ?? ''} ${text}`, `${model.context} ${tpl.text}`).length > 0) issues.push({ code: 'UNSUPPORTED_DETAIL', detail: 'a number not in the records' });
      return issues;
    };
    let text = model.text.trim();
    let issues = check(text);
    // the one repair: a draft whose ONLY problem is the missing closing "Thank you" gets it appended
    if (issues.length === 1 && issues[0]?.code === 'MISSING_THANK_YOU') {
      const repaired = `${text}${plan.channel === 'email' ? '\n\n' : ' '}Thank you`;
      const again = check(repaired);
      if (again.length === 0) { text = repaired; issues = again; }
    }
    if (issues.length === 0) return { draft: { ...base, subject, text, origin: 'model', issues: [] }, modelRejected: null };
    modelRejected = issues;
  }
  const issues = checkDraft({ channel: plan.channel, text: tpl.text, subject: tpl.subject, marketing: plan.marketing, brokerageName: policy.brokerageName });
  return { draft: { ...base, subject: tpl.subject, text: tpl.text, origin: 'template', issues }, modelRejected };
}
