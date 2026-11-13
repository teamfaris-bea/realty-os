// Every line the voice assistant says on its own (R-VOICE-5, R-VOICE-8, R-FH-3; E113, E114, E119).
//
// The plan sets no copy for module 47, so every spoken line is exported data: product, counsel and
// module 48 read it here, and tests prove each one passes voiceTurnGuard. Every scripted line says
// it is an automated assistant, so a caller who skipped the disclosure still hears the truth.
// VERIFY WITH COUNSEL (C2): disclosure timing, the truthful answer, the decline line, the
// uncovered-language line and the FCC treatment of AI voices. The area-question line is core/
// fairhousing's AREA_QUESTION_CLIENT_REPLY (VERIFY WITH COUNSEL, C3).
import { AREA_QUESTION_CLIENT_REPLY } from '../fairhousing/index.js';

export const VOICE_LINES = {
  /** E113: "Am I talking to a real person?" (R-VOICE-8). */
  truthfulAnswer: "No, you're talking to the team's automated assistant. It's an AI, not a person. I can book a time with your agent or take a message for them.",
  /** E114 and R-VOICE-5: price, offers, contracts, commission, legal and lending questions. */
  decline: "I'm the team's automated assistant, so I can't answer that one. I'll pass your question to your agent so they can get back to you.",
  /** R-FH-3: who lives in an area, its safety, its "kind of people". */
  areaQuestion: AREA_QUESTION_CLIENT_REPLY,
  /** E119: a language the playbook does not cover. */
  uncoveredLanguage: "Sorry, I'm the team's automated assistant and I can't help in this language yet. Please leave a short message after the tone and your agent will get back to you.",
  /** A model turn that failed voiceTurnGuard is never spoken; this is said instead. */
  replacement: "Sorry, I'm the team's automated assistant and I can't help with that. I can book a time with your agent or take a message for them.",
  /** Silence: a bounded number of re-prompts. */
  reprompt: "Are you still there? This is the team's automated assistant. I can book a time with your agent or take a message.",
  /** Silence after the last re-prompt. */
  silenceGoodbye: "I haven't heard anything, so I'll send you to voicemail. The team's automated assistant will pass on your call.",
  /** R-VOICE-6: a hot caller holds for the contact's own agent. */
  transferHold: "Please hold while the team's automated assistant tries your agent.",
  /** E115: the owner did not answer within the hold, and a phone callback is allowed. */
  ownerUnavailableCallback: "Your agent couldn't pick up just now. I'm the team's automated assistant: I can book a time for you, or take a message and they'll call you back.",
  /** E115 with E112: no phone callback is offered (voice opted out on a phone, or do-not-contact). */
  ownerUnavailableNoCallback: "Your agent couldn't pick up just now. I'm the team's automated assistant: I can book a time for you, or take a message for them.",
  /** E151 and E428: any failed booking (the slot was taken meanwhile, the calendar is unavailable, the slot is no longer
   *  valid). Generic, so it never claims the slot was taken (owner question O1's default, module 48). */
  bookingFailed: "I couldn't book that time. I'm the team's automated assistant; let me find another one.",
  /** Booked, with the agent's confirmation mentioned only on an allowed channel (E112). The assistant never sends it: it
   *  is a one-tap draft for the agent (R-VOICE-17), so the line promises the agent, not the assistant (O1's default). */
  bookedConfirmSms: "You're booked. I'm the team's automated assistant; your agent will confirm by text.",
  bookedConfirmEmail: "You're booked. I'm the team's automated assistant; your agent will confirm by email.",
  bookedNoConfirmation: "You're booked. I'm the team's automated assistant, and I've passed the details to your agent.",
  /** The booking result never arrived: nothing is promised, the agent confirms (R-VOICE-7). */
  bookingUnconfirmed: "I'm the team's automated assistant, and I couldn't confirm that time just now. Your agent will confirm it with you.",
  /** The caller asked not to be contacted (spoken STOP or opt-out language). No promise of any follow-up. */
  optOutAck: "Understood. I'm the team's automated assistant, and I've noted that you don't want to be contacted. Your agent will see it.",
  /** The content's maxCallSeconds was reached. */
  wrapUp: "We're nearly out of time. I'm the team's automated assistant, and I've passed everything to your agent. Goodbye.",
} as const;

export type VoiceLineId = keyof typeof VOICE_LINES;
export const VOICE_LINE_IDS = Object.keys(VOICE_LINES) as VoiceLineId[];
