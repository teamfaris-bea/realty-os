// Built-in playbook templates (ARCHITECTURE §11): they ship INACTIVE (a draft version) and are approved
// once during setup by whoever may approve them (team: Owner/Admin; agent: that agent). The wording is
// plain and short, asks one thing at a time, and never mentions price negotiation, offers, money or
// contracts (those always need a human, R-AST-3). Sign-off, brokerage name and the STOP line are added
// by core.renderStep (R-AST-11, R-GATE-12). VERIFY WITH COUNSEL: AI-disclosure wording by state.
import type { PlaybookKind, PlaybookStep } from '@realty/core/assistant';

export interface BuiltInTemplate {
  key: string;
  kind: PlaybookKind;
  scope: 'team' | 'agent';
  name: string;
  steps: PlaybookStep[];
}

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
    key: 'post_closing',
    kind: 'post_closing',
    scope: 'agent',
    name: 'After closing',
    steps: [
      { stepKey: 'settled_in', channel: 'sms', delay: { anchor: 'event', offsetSeconds: 14 * DAY_S }, purpose: 'marketing', category: 'nurture_step', intent: 'check_in', template: 'Hi {{first_name}}, how are you settling in? If anything comes up with the house, I am happy to point you to someone good.', personalization: 'none', slots: ['first_name'], maxLength: 480, stopIf: [] },
      // The home-value step is defined but skipped until an AVM exists (Phase 2): requires 'avm'.
      { stepKey: 'home_value', channel: 'email', delay: { anchor: 'event', offsetSeconds: 180 * DAY_S }, purpose: 'marketing', category: 'nurture_step', intent: 'home_value_update', subject: 'Your home value update', template: 'Hi {{first_name}},\n\nHere is a quick update on what homes like yours are worth.', personalization: 'none', slots: ['first_name'], maxLength: 2000, stopIf: [], requires: ['avm'] },
      { stepKey: 'anniversary', channel: 'email', delay: { anchor: 'event', offsetSeconds: 365 * DAY_S }, purpose: 'marketing', category: 'nurture_step', intent: 'home_anniversary', subject: 'Happy home anniversary', template: 'Hi {{first_name}},\n\nIt has been a year since you got the keys. Happy home anniversary!', personalization: 'none', slots: ['first_name'], maxLength: 2000, stopIf: [] },
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
];

export function templateByKey(key: string): BuiltInTemplate | null {
  return BUILT_IN_TEMPLATES.find((t) => t.key === key) ?? null;
}
