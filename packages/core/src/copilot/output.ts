// Parsing the local model's answers (CP-10): one JSON object, closed shapes, bounded lengths. Anything else
// is MODEL_OUTPUT_INVALID and the copilot falls back to its deterministic parts.
import { z } from 'zod';
import { linkHosts } from '../assistant/index.js';
import { SUMMARY_MAX_CHARS, maskContactData } from './prompt.js';

const SummaryOut = z.object({ summary: z.string().min(1).max(2_000) }).strict();
const DraftOut = z.object({ text: z.string().min(1).max(4_000), subject: z.string().max(500).optional() }).strict();

function firstJsonObject(raw: string): unknown {
  const s = raw.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
}

export type ParsedSummary = { ok: true; text: string } | { ok: false; problem: 'MODEL_OUTPUT_INVALID' | 'MODEL_OUTPUT_FAILED_CHECKS' };

export function parseSummaryOutput(raw: string): ParsedSummary {
  const r = SummaryOut.safeParse(firstJsonObject(raw));
  if (!r.success) return { ok: false, problem: 'MODEL_OUTPUT_INVALID' };
  const text = r.data.summary.replace(/\s+/gu, ' ').trim();
  // internal text for the agent: bounded, no links, no phone numbers or email addresses
  if (text.length > SUMMARY_MAX_CHARS || linkHosts(text).length > 0 || maskContactData(text) !== text) {
    return { ok: false, problem: 'MODEL_OUTPUT_FAILED_CHECKS' };
  }
  return { ok: true, text };
}

export type ParsedDraft = { ok: true; text: string; subject: string | null } | { ok: false; problem: 'MODEL_OUTPUT_INVALID' };

export function parseDraftOutput(raw: string): ParsedDraft {
  const r = DraftOut.safeParse(firstJsonObject(raw));
  if (!r.success) return { ok: false, problem: 'MODEL_OUTPUT_INVALID' };
  return { ok: true, text: r.data.text.trim(), subject: r.data.subject?.trim() ?? null };
}
