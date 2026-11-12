// Tool requests of the voice model (R-VOICE-4, R-VOICE-2, R-VOICE-6, R-VOICE-7, R-CONSENT-8).
//
// The DB's voice_tool_calls.tool CHECK is the closed set. Arguments are identical to or stricter
// than app.voice_tool_args_ok: an object of string values, allowlisted keys only, ISO instants,
// lowercase uuids and closed code sets. Neither the caller's nor the model's words ever choose a
// transfer target, a slot or an opt-out effect: the target must be the facts' owner, the slot one
// the facts offered, and an opt-out must have been heard by classifyInbound in the caller's own
// words (its effects are planInboundEffects', run by module 48, never the model's arguments).
//
// Known gap (a): core/assistant's VOICE_TOOLS (content.ts, module 25) names different tools. The
// content's tools map onto the ledger set by CONTENT_TOOL_LEDGER_MAP; renaming VOICE_TOOLS is the
// orchestrator's decision.
import { type VoiceContent, type VoiceTool } from '../assistant/index.js';
import { type Instant, instantFromIso, toIso } from '../foundation/index.js';
import { isHot } from './hot.js';
import type { VoiceState } from './state.js';
import { transferTarget } from './transfer.js';
import {
  APPOINTMENT_KINDS,
  END_CALL_REASONS,
  type LedgerRow,
  MESSAGE_TOPICS,
  type OfferedSlot,
  OPT_OUT_TOOL_CHANNELS,
  type ToolDecision,
  type ToolRequest,
  VOICE_LEDGER_TOOLS,
  type VoiceErrorCode,
  type VoiceFacts,
  type VoiceLedgerTool,
} from './types.js';

/** The content's tools ⇒ the ledger tools they enable (known gap (a)). */
export const CONTENT_TOOL_LEDGER_MAP: Readonly<Record<VoiceTool, readonly VoiceLedgerTool[]>> = {
  book_appointment: ['check_availability', 'book_appointment'],
  take_message: ['take_message'],
  transfer_to_owner: ['warm_transfer'],
  // whether the session may speak listing facts is module 48's question; it is no ledger tool
  share_listing_facts: [],
};

/** Always available once both disclosures played (D1: an opt-out has no override; a call is always endable). */
export const ALWAYS_AVAILABLE_TOOLS: readonly VoiceLedgerTool[] = ['record_opt_out', 'end_call'];

/** The allowlisted argument keys per tool (app.voice_tool_args_ok). */
export const TOOL_ARG_KEYS: Readonly<Record<VoiceLedgerTool, readonly string[]>> = {
  check_availability: ['from', 'to'],
  book_appointment: ['slot_start', 'slot_end', 'kind'],
  warm_transfer: ['target_user_id'],
  take_message: ['topic'],
  record_opt_out: ['channel'],
  end_call: ['reason_code'],
};

/** Keys core requires (the DB requires the booking slot; core also requires the transfer target). */
const REQUIRED: Readonly<Record<VoiceLedgerTool, readonly string[]>> = {
  check_availability: [],
  book_appointment: ['slot_start', 'slot_end'],
  warm_transfer: ['target_user_id'],
  take_message: [],
  record_opt_out: [],
  end_call: [],
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isLedgerTool(tool: unknown): tool is VoiceLedgerTool {
  return typeof tool === 'string' && (VOICE_LEDGER_TOOLS as readonly string[]).includes(tool);
}

/** The ledger tools the approved content enables, plus the always-available ones. */
export function enabledLedgerTools(content: Pick<VoiceContent, 'tools'>): ReadonlySet<VoiceLedgerTool> {
  return new Set([...content.tools.flatMap((t) => CONTENT_TOOL_LEDGER_MAP[t]), ...ALWAYS_AVAILABLE_TOOLS]);
}

function valueOk(tool: VoiceLedgerTool, key: string, v: string): boolean {
  switch (key) {
    case 'from':
    case 'to':
    case 'slot_start':
    case 'slot_end':
      return instantFromIso(v) !== null;
    case 'kind':
      return (APPOINTMENT_KINDS as readonly string[]).includes(v);
    case 'target_user_id':
      return UUID_RE.test(v);
    case 'topic':
      return (MESSAGE_TOPICS as readonly string[]).includes(v);
    case 'channel':
      return (OPT_OUT_TOOL_CHANNELS as readonly string[]).includes(v);
    default:
      // key is 'reason_code' (the only remaining allowlisted key) for end_call
      return tool === 'end_call' && (END_CALL_REASONS as readonly string[]).includes(v);
  }
}

function plainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/**
 * Core's argument check: an object of string values, allowlisted keys only, required keys present,
 * every value valid. Identical to or stricter than app.voice_tool_args_ok (the equivalence test).
 */
export function toolArgsValid(tool: VoiceLedgerTool, args: unknown): args is Record<string, string> {
  if (!plainObject(args)) return false;
  const allowed = TOOL_ARG_KEYS[tool];
  for (const [k, v] of Object.entries(args)) {
    if (typeof v !== 'string' || !allowed.includes(k) || !valueOk(tool, k, v)) return false;
  }
  if (!REQUIRED[tool].every((k) => k in args)) return false;
  if (tool === 'book_appointment') return (instantFromIso(args.slot_start as string) as Instant) < (instantFromIso(args.slot_end as string) as Instant);
  if (tool === 'check_availability' && typeof args.from === 'string' && typeof args.to === 'string') {
    return (instantFromIso(args.from) as Instant) <= (instantFromIso(args.to) as Instant);
  }
  return true;
}

/**
 * The allowlisted ledger projection of a request: only allowlisted keys with valid string values
 * (instants canonicalised), a transfer target only when it is the facts' owner (no foreign id
 * leaves core), and record_opt_out's channel as core heard it. Always passes app.voice_tool_args_ok.
 * null for a tool outside the closed set, or a booking without a valid slot (the DB requires one).
 */
export function ledgerProjection(req: ToolRequest, state: Pick<VoiceState, 'optOut'>, facts: Pick<VoiceFacts, 'contact'>): LedgerRow | null {
  if (!isLedgerTool(req.tool)) return null;
  const tool = req.tool;
  const raw = plainObject(req.args) ? req.args : {};
  const args: Record<string, string> = {};
  for (const k of TOOL_ARG_KEYS[tool]) {
    const v = raw[k];
    if (typeof v !== 'string' || !valueOk(tool, k, v)) continue;
    if (k === 'from' || k === 'to' || k === 'slot_start' || k === 'slot_end') args[k] = toIso(instantFromIso(v) as Instant);
    else if (k === 'target_user_id') {
      if (facts.contact.owner !== null && v === facts.contact.owner.userId) args[k] = v;
    } else if (k !== 'channel') args[k] = v;
  }
  if (tool === 'record_opt_out' && state.optOut !== null) args.channel = state.optOut.channel;
  if (tool === 'book_appointment' && (args.slot_start === undefined || args.slot_end === undefined)) return null;
  return { tool, args };
}

/** The slot a booking request names (valid args only). */
export function requestedSlot(args: Record<string, string>): OfferedSlot {
  return { start: instantFromIso(args.slot_start as string) as Instant, end: instantFromIso(args.slot_end as string) as Instant };
}

export function sameSlot(a: OfferedSlot, b: OfferedSlot): boolean {
  return a.start === b.start && a.end === b.end;
}

/** All claims the session knows: before the call and in it. */
export function sessionClaims(state: Pick<VoiceState, 'claims'>, facts: Pick<VoiceFacts, 'claims'>): VoiceFacts['claims'] {
  return [...facts.claims, ...state.claims];
}

/** Whether the contact has an owner whose calendar can be booked. */
function ownedByActiveMember(facts: Pick<VoiceFacts, 'contact'>): boolean {
  return facts.contact.owner !== null && facts.contact.owner.status === 'active';
}

/**
 * R-VOICE-4: decides one tool request. A deny changes no state (the machine only logs it). Every
 * reason is a code matching voice_tool_calls.reason_code (an allow carries one too). Added to the
 * plan's signature: the result carries the ledger projection.
 */
export function decideToolCall(state: VoiceState, req: ToolRequest, facts: VoiceFacts): ToolDecision {
  const ledger = ledgerProjection(req, state, facts);
  const deny = (reason: VoiceErrorCode): ToolDecision => ({ decision: 'deny', reason, ledger });
  if (state.phase === 'ended') return deny('VOICE_SESSION_ENDED');
  if (state.disclosedAt === null || state.announcedAt === null || req.at < state.disclosedAt || req.at < state.announcedAt) return deny('VOICE_TOOL_BEFORE_DISCLOSURE');
  if (!isLedgerTool(req.tool)) return deny('VOICE_TOOL_UNKNOWN');
  const tool = req.tool;
  if (!toolArgsValid(tool, req.args)) return deny('VOICE_TOOL_ARGS_INVALID');
  const args = req.args;
  if (!enabledLedgerTools(facts.content).has(tool)) return deny('VOICE_TOOL_NOT_ENABLED');
  if (state.phase === 'transferring') return deny('VOICE_TRANSFER_PENDING');
  if (state.optOut !== null && tool !== 'record_opt_out' && tool !== 'end_call') return deny('VOICE_OPTED_OUT');
  const allow = (reason: ToolDecision['reason']): ToolDecision => ({ decision: 'allow', reason, ledger });
  switch (tool) {
    case 'check_availability':
      return ownedByActiveMember(facts) ? allow('ALLOW_AVAILABILITY') : deny('CONTACT_NOT_OWNED');
    case 'book_appointment': {
      if (!ownedByActiveMember(facts)) return deny('CONTACT_NOT_OWNED');
      if (state.booking?.status === 'booked') return deny('ALREADY_BOOKED');
      if (state.booking?.status === 'pending') return deny('BOOKING_PENDING');
      const slot = requestedSlot(args);
      const offered = facts.offeredSlots.some((s) => sameSlot(s, slot)) && !state.failedSlots.some((s) => sameSlot(s, slot));
      return offered ? allow('ALLOW_OFFERED_SLOT') : deny('SLOT_NOT_OFFERED');
    }
    case 'warm_transfer': {
      if (facts.contact.owner === null || args.target_user_id !== facts.contact.owner.userId) return deny('TRANSFER_NOT_OWNER');
      if (state.transfer !== null) return deny('TRANSFER_ALREADY_TRIED');
      if (transferTarget(facts.contact, req.at).kind !== 'owner') return deny('TRANSFER_UNAVAILABLE');
      if (facts.hotRule === null || !isHot(sessionClaims(state, facts), facts.hotRule)) return deny('CALLER_NOT_HOT');
      return allow('ALLOW_OWNER_TRANSFER');
    }
    case 'take_message':
      return allow('ALLOW_MESSAGE');
    case 'record_opt_out':
      return state.optOut !== null ? allow('ALLOW_OPT_OUT_HEARD') : deny('OPT_OUT_NOT_HEARD');
    case 'end_call':
      return allow('ALLOW_END_CALL');
  }
}

