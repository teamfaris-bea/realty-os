// The one seam between module 75 (apps/api/src/isa) and module 74 (@realty/core/isa, lane ISA-1). Every core
// import of this module goes through this file, so a change of an ISA-1 export is a one-file change here.
//
// Every name below is a real ISA-1 export (merged from origin/lane/ai-isa-core); there are no STUB(ISA-1) stand-ins.
// Two are wrapped at the end of this file, aiIsaSendWindow and holidaysAround, so the API reads one holiday calendar
// (b13 integration).
import type { Instant } from '@realty/core/foundation';
import { aiIsaSendWindow as coreSendWindow, holidaysAround as coreHolidaysAround, type SendWindowInput } from '@realty/core/isa';
export {
  AI_ISA_PROMPT_VERSION,
  AI_ISA_RULES_VERSION,
  aiIsaConsentBasis,
  aiIsaRecipientZones,
  buildIsaPrompt,
  capabilitiesInEffect,
  clientOwnText,
  composeMessage,
  computeOffer,
  confirmationInTime,
  displayZones,
  formatSlot,
  factsMessage,
  FACT_INTROS,
  fitsSms,
  renderBuyerListing,
  usFederalHolidays,
  ISA_GROUNDING_DEFAULTS,
  consentBasisSentence,
  decideAction,
  DEFAULT_AI_ISA_CONTENT,
  disclosureLine,
  ESCALATION_TABLE,
  fillLine,
  fromDisplayName,
  icuOffsetMinutes,
  initialState,
  isAcknowledgementOnly,
  isaGuard,
  isaReasonClass,
  ISA_BOOKING_DEFAULTS,
  ISA_CAPABILITIES,
  ISA_CONSENT_DEFAULTS,
  ISA_DEFAULT_CAPS,
  ISA_DEFAULT_LIMITS,
  ISA_DEFAULT_WINDOW,
  ISA_END_REASONS,
  ISA_PAUSE_REASONS,
  ISA_REASON_CLASS,
  ISA_SLA_MINUTES,
  ISA_TURN_LIMITS,
  isaSystemPrompt,
  matchSlotChoice,
  narrowsPrevious,
  offsetsAgree,
  parseAiIsaContent,
  parseIsaModelOutput,
  refusalClass,
  renderConfirmation,
  renderOffer,
  repairNote,
  signOffLine,
  step,
  validateAiIsaContent,
} from '@realty/core/isa';
export type {
  AiIsaContent,
  HandleLabel,
  UsableQualClaim,
  AvailabilityWindow,
  IsaOffer,
  ConsentBasis,
  ConsentBasisInput,
  Decision,
  DecideContext,
  EscalationClass,
  Handoff,
  IsaAction,
  IsaCapability,
  IsaChannel,
  IsaEndReason,
  IsaEvent,
  IsaFacts,
  IsaInbound,
  IsaModelOutput,
  IsaPauseReason,
  IsaPhase,
  IsaReasonClass,
  IsaSide,
  IsaSlot,
  IsaState,
  LineIdentity,
  QueueMessage,
  RecipientZones,
  StepResult,
} from '@realty/core/isa';

/** Local dates the test calendar adds to core's holidays and excepts from them (an exception wins); empty unless a test
 *  set them. */
const testCalendar: { add: ReadonlySet<string>; except: ReadonlySet<string> } = { add: new Set(), except: new Set() };

/**
 * The AI ISA's holiday calendar in the API: core's US federal holidays (core/isa zones.ts; the guard's
 * app.ai_isa_us_federal_holiday is the same rule, 0081). Every API path reads it from here: the gate's facts
 * (send.ts aiIsaGateFacts), and through aiIsaSendWindow below the planned send, the deferral and the booking window.
 */
export function holidaysAround(at: Instant): string[] {
  const base = coreHolidaysAround(at);
  if (testCalendar.add.size === 0 && testCalendar.except.size === 0) return base;
  return [...new Set([...base, ...testCalendar.add])].filter((d) => !testCalendar.except.has(d)).sort();
}

/** core's aiIsaSendWindow on this module's holiday calendar. */
export function aiIsaSendWindow(i: SendWindowInput): Instant | null {
  return coreSendWindow({ ...i, holidays: i.holidays ?? holidaysAround(i.at) });
}

/**
 * Test-only (b13 integration). There is no fake clock: the guard and the API read the database's now(). The API tests'
 * initiatedDayNow() (isa/testing.ts) excepts today here on a real federal holiday, as its database twin swaps
 * app.ai_isa_us_federal_holiday, and a test adds today to prove the helper. It returns the calendar it replaced, so the
 * caller can put it back. It refuses outside Vitest, and isa/testing.test.ts holds every caller to test code.
 */
export function setIsaHolidayTestCalendar(c: { add?: readonly string[]; except?: readonly string[] }): { add: string[]; except: string[] } {
  if (process.env.VITEST === undefined) throw new Error('setIsaHolidayTestCalendar is test-only');
  const before = { add: [...testCalendar.add], except: [...testCalendar.except] };
  testCalendar.add = new Set(c.add ?? []);
  testCalendar.except = new Set(c.except ?? []);
  return before;
}
