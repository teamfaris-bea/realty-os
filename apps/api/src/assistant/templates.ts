// Built-in playbook templates (ARCHITECTURE §11): they ship INACTIVE (a draft version) and are approved
// once during setup by whoever may approve them (team: Owner/Admin; agent: that agent). The wording is
// plain and short, asks one thing at a time, and never mentions price negotiation, offers, money or
// contracts (those always need a human, R-AST-3). Sign-off, brokerage name and the STOP line are added
// by core.renderStep (R-AST-11, R-GATE-12). VERIFY WITH COUNSEL: AI-disclosure wording by state.
//
// Phase 2 (module 26, sole Phase 2 editor of this file; R-NURT-1..3, R-MKT-11, R-AST-20, F7): the trigger
// templates "Behavior alerts" (agent: a saved or matched home drops in price or comes back on the market),
// "After-closing alerts" (agent: the yearly home anniversary, and the monthly home value fired by wave 2C's
// avm.refresh; templateVersion 2 introduces the estimate sentence the system adds, R-AVM-1), "Milestone updates" (`transaction_updates`,
// team: a confirmed deal date coming up; fired by module 31 at the date's stored reminder time, to the deal roles
// the step names: the client roles only, an Owner/Admin adds lender, title or attorney before approving, C9) and "After closing" v2 (no
// home-value or anniversary step any more: those are trigger firings, so year one has a single anniversary
// email; adds the review request). A trigger template's content is one `PlaybookContent` object, hashed and
// approved like steps; its digest window is approved content (R-NURT-3). Email first (ARCHITECTURE §21.6).
// Every template ships as a draft a person approves once; nothing here is approved or sent.
import type { PlaybookContent, PlaybookKind, PlaybookStep, TriggerStep } from '@realty/core/assistant';

export interface BuiltInTemplate {
  key: string;
  kind: PlaybookKind;
  scope: 'team' | 'agent';
  name: string;
  /** step playbooks: the steps (empty for trigger templates, whose content is `content`) */
  steps: PlaybookStep[];
  /** trigger templates (module 26) and the voice template (module 48): the one content object stored as the version's content */
  content?: Extract<PlaybookContent, { kind: 'triggers' }> | Extract<PlaybookContent, { kind: 'voice' }>;
  /** bumped when a template's wording or steps change (existing playbooks keep their own versions) */
  templateVersion?: number;
}

const HOUR_S = 3_600;

/** Behavior alerts (agent): facts only, never opens or clicks (R-NURT-2). Category search_alert: the Owner's switch. */
const PRICE_DROP: TriggerStep = {
  trigger: 'price_drop',
  stepKey: 'price_drop',
  channel: 'email',
  offsetSeconds: 0,
  purpose: 'marketing',
  category: 'search_alert',
  intent: 'price_drop_alert',
  subject: 'A home you follow has a new price',
  template: 'Hi {{first_name}},\n\nA home you follow has a new price: {{listing_address}}, now {{listing_price}}.\n\nReply here if you want to see it.',
  slots: ['first_name', 'listing_address', 'listing_price'],
  maxLength: 2000,
};
const BACK_ON_MARKET: TriggerStep = {
  trigger: 'back_on_market',
  stepKey: 'back_on_market',
  channel: 'email',
  offsetSeconds: 0,
  purpose: 'marketing',
  category: 'search_alert',
  intent: 'back_on_market_alert',
  subject: 'A home you follow is back on the market',
  template: 'Hi {{first_name}},\n\nA home you follow is back on the market: {{listing_address}}.\n\nReply here if you want to see it.',
  slots: ['first_name', 'listing_address'],
  maxLength: 2000,
};
const ANNIVERSARY: TriggerStep = {
  trigger: 'home_anniversary',
  stepKey: 'home_anniversary',
  channel: 'email',
  offsetSeconds: 9 * HOUR_S,
  purpose: 'marketing',
  category: 'nurture_step',
  intent: 'home_anniversary',
  subject: 'Happy home anniversary',
  template: 'Hi {{first_name}},\n\nIt has been {{home_years}} since you got the keys to {{listing_address}}. Happy home anniversary!',
  slots: ['first_name', 'home_years', 'listing_address'],
  maxLength: 2000,
};
/**
 * The monthly home value (wave 2C: avm.refresh, R-AVM-1..3). The wording only introduces the estimate: the system
 * adds core homeValueText after rendering (provider, range, as-of date and "This is an estimate, not an appraisal."),
 * so every approved version carries it. It sends on its own only once platform:avm is cleared; until then it is a
 * draft for the agent. No estimate ⇒ skipped "No estimate available.", never "unchanged". VERIFY WITH COUNSEL (C6):
 * this wording, the sentence, and state rules on valuations by non-appraisers.
 */
const HOME_VALUE: TriggerStep = {
  trigger: 'home_value',
  stepKey: 'home_value',
  channel: 'email',
  offsetSeconds: 9 * HOUR_S,
  purpose: 'marketing',
  category: 'nurture_step',
  intent: 'home_value_update',
  subject: 'Your monthly home update',
  template: 'Hi {{first_name}},\n\nHere is this month’s automated estimate for {{listing_address}}, with its range and date below. Reply here if you would like to talk it through.',
  slots: ['first_name', 'listing_address'],
  maxLength: 2000,
};
/**
 * Fired by module 31 (deal dates, wave 2B; R-TXN-4): only human-confirmed, uncompleted dates, at the date's stored
 * reminder_at (offset 0: the reminder time is computed at confirm time), to the deal contacts in `roles`. Ships with
 * the client roles only; an Owner/Admin adds lender, title or attorney when editing the draft (VERIFY WITH COUNSEL,
 * C9: sharing deal status with lenders and title). The wording fits every role it may name. Informational.
 */
const DEAL_DATE: TriggerStep = {
  trigger: 'deal_date_upcoming',
  stepKey: 'deal_date_upcoming',
  channel: 'email',
  offsetSeconds: 0,
  purpose: 'informational',
  category: 'reminder',
  intent: 'deadline_reminder',
  subject: 'A date on your transaction is coming up',
  template: 'Hi {{first_name}},\n\nA quick heads-up: {{document_name}} is coming up on {{due_date}}. Reply here with any questions.',
  slots: ['first_name', 'document_name', 'due_date'],
  maxLength: 2000,
  roles: ['buyer', 'seller', 'co_buyer', 'co_seller'],
};

const DAY_S = 86_400;

export const BUILT_IN_TEMPLATES: readonly BuiltInTemplate[] = [
  {
    key: 'new_lead_response',
    kind: 'new_lead_response',
    scope: 'team',
    name: 'Instant reply to new leads',
    steps: [
      {
        stepKey: 'first_reply',
        channel: 'sms',
        delay: { anchor: 'enrollment', offsetSeconds: 0 },
        purpose: 'informational',
        category: 'speed_to_lead_reply',
        intent: 'first_response_qualify',
        template: 'Hi {{first_name}}, thanks for reaching out to {{team_name}}! When are you hoping to move, and have you talked with a lender yet?{{#va_question}} Are you planning to use a VA loan?{{/va_question}}',
        personalization: 'none',
        slots: ['first_name', 'team_name', 'va_question'],
        maxLength: 480,
        stopIf: [],
        fallback: {
          subject: 'Thanks for reaching out',
          template: 'Hi {{first_name}},\n\nThanks for reaching out to {{team_name}}! When are you hoping to move, and have you talked with a lender yet?{{#va_question}} Are you planning to use a VA loan?{{/va_question}}\n\nJust reply to this email and we will take it from here.',
          maxLength: 1500,
        },
      },
    ],
  },
  {
    key: 'nurture',
    kind: 'nurture',
    scope: 'agent',
    name: 'Stay in touch',
    steps: [
      { stepKey: 'check_in_1', channel: 'sms', delay: { anchor: 'enrollment', offsetSeconds: 0 }, purpose: 'marketing', category: 'nurture_step', intent: 'check_in', template: 'Hi {{first_name}}, just checking in. Is your home search still on, or should I check back in a few months?', personalization: 'none', slots: ['first_name'], maxLength: 480, stopIf: ['appointment_booked', 'deal_opened'] },
      { stepKey: 'check_in_2', channel: 'email', delay: { anchor: 'previous_step', offsetSeconds: 30 * DAY_S }, purpose: 'marketing', category: 'nurture_step', intent: 'market_update', subject: 'A quick market note', template: 'Hi {{first_name}},\n\nHomes near you are still moving. If you want a short list of what came up this month, just reply and I will put it together.', personalization: 'none', slots: ['first_name'], maxLength: 2000, stopIf: ['appointment_booked', 'deal_opened'] },
    ],
  },
  {
    // v2 (module 26, F7): the home-value and anniversary steps moved to the "After-closing alerts" trigger
    // template (one anniversary email a year, never a duplicate); the review request was added (R-MKT-11: no
    // sentiment condition and no incentive; it runs only once platform:review_requests is cleared).
    key: 'post_closing',
    kind: 'post_closing',
    scope: 'agent',
    name: 'After closing',
    templateVersion: 2,
    steps: [
      { stepKey: 'settled_in', channel: 'sms', delay: { anchor: 'event', offsetSeconds: 14 * DAY_S }, purpose: 'marketing', category: 'nurture_step', intent: 'check_in', template: 'Hi {{first_name}}, how are you settling in? If anything comes up with the house, I am happy to point you to someone good.', personalization: 'none', slots: ['first_name'], maxLength: 480, stopIf: [] },
      { stepKey: 'review_request', channel: 'email', delay: { anchor: 'event', offsetSeconds: 30 * DAY_S }, purpose: 'marketing', category: 'nurture_step', intent: 'review_request', subject: 'A quick favor', template: 'Hi {{first_name}},\n\nIf you have a minute, would you write a short review of how your move went? Honest feedback of any kind helps others choose an agent, and it helps me get better. Just reply to this email with it, or tell me if you would rather not.', personalization: 'none', slots: ['first_name'], maxLength: 2000, stopIf: [], requires: ['review_requests'] },
    ],
  },
  {
    key: 'booking_confirmation',
    kind: 'booking_confirmation',
    scope: 'team',
    name: 'Appointment confirmation',
    steps: [
      { stepKey: 'confirm', channel: 'sms', delay: { anchor: 'enrollment', offsetSeconds: 0 }, purpose: 'informational', category: 'booking_confirmation', intent: 'appointment_confirmation', template: 'Hi {{first_name}}, you are all set for {{appointment_time}}. Reply here if you need to change it.', personalization: 'none', slots: ['first_name', 'appointment_time'], maxLength: 480, stopIf: ['event_canceled'] },
    ],
  },
  {
    key: 'reminder',
    kind: 'reminder',
    scope: 'team',
    name: 'Appointment reminder',
    steps: [
      { stepKey: 'day_before', channel: 'sms', delay: { anchor: 'event', offsetSeconds: -DAY_S }, purpose: 'informational', category: 'reminder', intent: 'appointment_reminder', template: 'Hi {{first_name}}, a reminder about {{appointment_time}}. Reply here if anything changes.', personalization: 'none', slots: ['first_name', 'appointment_time'], maxLength: 480, stopIf: ['event_canceled'] },
    ],
  },
  {
    // module 22's note (R-INBOX-4): replies where the lead wrote (web chat) and by email otherwise; never by text.
    // A second new-lead template so the Owner can choose it; still a draft a person approves.
    key: 'new_lead_response_where_they_wrote',
    kind: 'new_lead_response',
    scope: 'team',
    name: 'Instant reply where the lead wrote (web chat, else email)',
    steps: [
      {
        stepKey: 'first_reply',
        channel: 'inbound_channel',
        delay: { anchor: 'enrollment', offsetSeconds: 0 },
        purpose: 'informational',
        category: 'speed_to_lead_reply',
        intent: 'first_response_qualify',
        template: 'Hi {{first_name}}, thanks for reaching out to {{team_name}}! When are you hoping to move, and have you talked with a lender yet?',
        personalization: 'none',
        slots: ['first_name', 'team_name'],
        maxLength: 480,
        stopIf: [],
        fallback: {
          subject: 'Thanks for reaching out',
          template: 'Hi {{first_name}},\n\nThanks for reaching out to {{team_name}}! When are you hoping to move, and have you talked with a lender yet?\n\nJust reply to this email and we will take it from here.',
          maxLength: 1500,
        },
      },
    ],
  },
  { key: 'behavior_alerts', kind: 'trigger', scope: 'agent', name: 'Behavior alerts', steps: [], content: { kind: 'triggers', triggers: [PRICE_DROP, BACK_ON_MARKET], digestWindowMinutes: 120 } },
  { key: 'after_closing_alerts', kind: 'trigger', scope: 'agent', name: 'After-closing alerts', steps: [], content: { kind: 'triggers', triggers: [ANNIVERSARY, HOME_VALUE], digestWindowMinutes: 0 }, templateVersion: 2 },
  { key: 'transaction_updates', kind: 'trigger', scope: 'team', name: 'Milestone updates', steps: [], content: { kind: 'triggers', triggers: [DEAL_DATE], digestWindowMinutes: 0 }, templateVersion: 2 },
  // module 48 (flagged edit, PLAN:306): AI answering for missed calls. Team only, a draft the Owner/Admin approves once;
  // it runs only once platform:voice is cleared and the Owner turns it on (R-VOICE-9). No share_listing_facts: it maps
  // to no ledger tool (core/voice known gap (a)). VERIFY WITH COUNSEL (C2): the disclosure and announcement wording.
  {
    key: 'voice_answering',
    kind: 'voice_answering',
    scope: 'team',
    name: 'AI answering for missed calls',
    steps: [],
    content: {
      kind: 'voice',
      voice: {
        disclosure: "Hi, you've reached the team's automated assistant. I'm an AI, not a person, and I'm answering because your agent couldn't pick up.",
        recordingAnnouncement: 'This call is recorded and transcribed by the assistant.',
        tools: ['book_appointment', 'take_message', 'transfer_to_owner'],
        maxCallSeconds: 300,
        transferHoldSeconds: 20,
      },
    },
  },
];

/**
 * Which trigger kinds can fire in this release; the rest are listed honestly as not available yet. home_value fires
 * from wave 2C's avm.refresh; GET /nurture/triggers says in words when it waits for counsel review (drafts only) or
 * when no AVM vendor is set up on the platform.
 */
export const TRIGGER_AVAILABILITY = {
  price_drop: 'available',
  back_on_market: 'available',
  home_anniversary: 'available',
  home_value: 'available',
  deal_date_upcoming: 'available',
} as const;

export function templateByKey(key: string): BuiltInTemplate | null {
  return BUILT_IN_TEMPLATES.find((t) => t.key === key) ?? null;
}
