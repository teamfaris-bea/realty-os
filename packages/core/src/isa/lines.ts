// The AI ISA's fixed client lines (docs/AI_ISA.md §4.4, §4.5, §4.6, §6.3, §7.3). Server text only: the model never
// writes any of them. The disclosure and sign-off are platform constants of `platform:ai_isa` (not team text) and
// always say "AI assistant" (R-ISA-7). Holding lines never name a time (Q-ISA-13). Every line is VERIFY WITH COUNSEL
// (C-ISA-5, C-ISA-12); the safety and fraud lines especially.
import { AREA_QUESTION_CLIENT_REPLY } from '../fairhousing/index.js';

/** Who the lines speak for. Every value is the server's (tenant settings and the owner's first name). */
export interface LineIdentity {
  agentFirstName: string;
  teamName: string;
  brokerageName: string;
}

export const ISA_LINE_IDS = [
  'bot_question',
  'safety',
  'fraud_risk',
  'privacy_request',
  'ai_declined',
  'complaint',
  'human_request',
  'fair_housing',
  'legal_contract',
  'third_party',
  'pricing',
  'financial',
  'sensitive_personal',
  'language',
  'data_unavailable',
  'booking_unavailable',
  'uncertain',
  'ready',
  'open_offer_closed',
  'slot_clarify_intro',
  'email_details_pointer',
  'holding',
] as const;
export type IsaLineId = (typeof ISA_LINE_IDS)[number];

/** The fixed lines; `{Agent}` and `{Team}` are filled from `LineIdentity` only. */
export const ISA_LINES: Readonly<Record<IsaLineId, string>> = Object.freeze({
  bot_question: "You're texting with {Agent}'s AI assistant, not a person. Reply AGENT any time and I'll ask {Agent} to contact you.",
  safety: "I'm an AI assistant and I've alerted {Agent} right away. If you're in danger, please call 911 now.",
  fraud_risk: "Don't send money based on a text or email. Call {Agent} at a number you already know.",
  privacy_request: "I've passed your request to {Team}.",
  ai_declined: "Understood. I've asked {Agent} to take it from here.",
  complaint: "I'm sorry. I've asked {Agent} to reach out to you personally.",
  human_request: "I've let {Agent} know you'd like to talk.",
  fair_housing: AREA_QUESTION_CLIENT_REPLY,
  legal_contract: "That's a question for {Agent}. I've passed it on.",
  third_party: "Thanks. I've let {Agent} know.",
  pricing: "Putting a price on your home is something {Agent} does with you personally, so I've let {Agent} know.",
  financial: "That's a question for {Agent} or a lender. I've passed it on.",
  sensitive_personal: "Thank you for telling me. I've asked {Agent} to reach out to you personally.",
  language: "I can only write in English. I've asked {Agent} to reach out to you.",
  data_unavailable: "I don't have current market data for that right now. {Agent} can go over this with you.",
  booking_unavailable: "I couldn't confirm a time right now. {Agent} will reach out to set one.",
  uncertain: "I've passed this to {Agent}.",
  ready: '{Agent} will take it from here and be in touch.',
  open_offer_closed: '{Agent} will confirm a time with you directly.',
  slot_clarify_intro: 'Which of these times works best? Reply with its number:',
  email_details_pointer: 'I can email you the details.',
  holding: "I've passed this to {Agent}.",
});

/** One line, filled. Only `{Agent}` and `{Team}` are placeholders; any other brace text stays as written. */
export function fillLine(id: IsaLineId, who: LineIdentity): string {
  return fillTemplate(ISA_LINES[id], who);
}

export function fillTemplate(template: string, who: LineIdentity): string {
  return template.replace(/\{Agent\}/g, who.agentFirstName.trim()).replace(/\{Team\}/g, who.teamName.trim());
}

// ---- platform constants of `platform:ai_isa` (C-ISA-5) ---------------------------------------------------------

/** The disclosure on the first AI message of a thread. Must contain "AI" (AI_IDENTITY_MISSING). VERIFY WITH COUNSEL. */
export const ISA_DISCLOSURE_TEMPLATE = "Hi, this is {Agent}'s AI assistant at {Brokerage}.";
/** The sign-off of every AI message. Also satisfies gate check 4's brokerage name for marketing SMS. VERIFY WITH COUNSEL. */
export const ISA_SIGN_OFF_TEMPLATE = "— {Agent}'s AI assistant, {Brokerage}";
/** On the first message and on initiated messages after 7 days of silence. VERIFY WITH COUNSEL. */
export const ISA_OPT_OUT_HINT = 'Reply STOP to opt out.';
/** The email From display name. VERIFY WITH COUNSEL. */
export const ISA_FROM_NAME_TEMPLATE = "{Agent}'s AI assistant ({Team})";

function fillPlatform(t: string, who: LineIdentity): string {
  return t.replace(/\{Agent\}/g, who.agentFirstName.trim()).replace(/\{Brokerage\}/g, who.brokerageName.trim()).replace(/\{Team\}/g, who.teamName.trim());
}

export function disclosureLine(who: LineIdentity): string {
  return fillPlatform(ISA_DISCLOSURE_TEMPLATE, who);
}
export function signOffLine(who: LineIdentity): string {
  return fillPlatform(ISA_SIGN_OFF_TEMPLATE, who);
}
export function fromDisplayName(who: LineIdentity): string {
  return fillPlatform(ISA_FROM_NAME_TEMPLATE, who);
}

/**
 * The full body of one AI message: the disclosure when it is the first AI message of the thread, the body, the
 * sign-off, and the opt-out hint when required. The ISA guard's AI_IDENTITY_MISSING checks the result.
 */
export function composeMessage(i: { body: string; who: LineIdentity; firstInThread: boolean; optOutHint: boolean; channel: 'sms' | 'email' }): string {
  const sep = i.channel === 'email' ? '\n\n' : '\n';
  const parts: string[] = [];
  if (i.firstInThread) parts.push(disclosureLine(i.who));
  parts.push(i.body.trim());
  parts.push(signOffLine(i.who));
  if (i.optOutHint) parts.push(ISA_OPT_OUT_HINT);
  return parts.join(sep);
}
