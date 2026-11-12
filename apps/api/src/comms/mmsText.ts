// Text carried in MMS text/plain parts (lane telephony-safeguards S3; R-TWL-11, E386-E389). The pieces the inbound
// path needs (no import of inbound.ts, so there is no cycle): what a text part is, how one is decoded, and the enqueue
// that runs INSIDE the inbound message's own ingestion transaction. The job itself is comms/mmsTextJob.ts.
//
// OWNER DEFAULTS (open owner questions; one constant each):
//   TEXT_PART_MAX_BYTES         16 KiB   a larger part is unreadable (never truncated and classified)
//   PLATFORM_CONFIRMS_PART_STOP true     a STOP found only in a part is confirmed by the platform, once per message
//   (text parts can only ADD opt-outs, never lift them: comms/mmsTextJob.ts applies revoking kinds only)
import type { Tx } from '@realty/db';
import { enqueueJob } from '@realty/db';
import { sql } from 'kysely';

export const TEXT_PART_MAX_BYTES = 16 * 1024;
export const PLATFORM_CONFIRMS_PART_STOP = true;
export const MMS_TEXT_JOB = { kind: 'comms.mms_text', queue: 'default' as const, dedupeKey: (key: string) => `comms.mms_text:${key}` };

/** The one notice an unreadable part gets (E387). `{name}` is the contact's label. */
export const UNREADABLE_PART_NOTICE = (name: string) => `Part of a text from ${name} couldn't be read. Check the conversation before you text them.`;
/** b9 review sends/F2: the notice's body when that text came to a tracking number from a pond / unassigned person. */
export const UNREADABLE_TRACKED_PART_BODY = "Because part of it couldn't be read, this text to a tracking number was not counted as a new inquiry.";
/** What the thread shows for a part that has not been read yet. */
export const PENDING_PART_SENTENCE = "Part of this text hasn't been read yet.";

const ME_SID = /^ME[0-9a-f]{32}$/;

/** A declared MMS part type that carries plain text (Twilio MediaContentType{n}). */
export function isTextPart(declaredType: string | null | undefined): boolean {
  return (declaredType ?? '').split(';')[0]!.trim().toLowerCase() === 'text/plain';
}

export type DecodedPart = { ok: true; text: string } | { ok: false; reason: 'TOO_LARGE' | 'CONTENT_MISMATCH' };

/**
 * Decodes one fetched part: at most TEXT_PART_MAX_BYTES, strict UTF-8 (an invalid sequence is unreadable), the BOM
 * stripped, and a NUL anywhere is unreadable (CONTENT_MISMATCH: the bytes are not the text they claim to be). Pure.
 */
export function decodeTextPart(bytes: Uint8Array): DecodedPart {
  if (bytes.byteLength > TEXT_PART_MAX_BYTES) return { ok: false, reason: 'TOO_LARGE' };
  let text: string;
  try {
    // fatal: invalid UTF-8 throws; ignoreBOM false: a leading BOM is consumed (stripped), never kept as text
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { ok: false, reason: 'CONTENT_MISMATCH' };
  }
  if (text.includes('\u0000')) return { ok: false, reason: 'CONTENT_MISMATCH' };
  return { ok: true, text };
}

export interface TextPartJob {
  /** the inbound message (a contact's text); absent for an agent's alert phone, which has no message row (E388) */
  messageId?: string;
  agentUserId?: string;
  /** the provider message SID the parts belong to */
  messageRef: string;
  parts: { position: number; ref: string | null }[];
  /**
   * b9 review sends/F2 (R-TRK-3, E595): the message came to a tracking number of this ON lead source from a known
   * person. The R-TRK-3 re-inquiry is decided by the job, once every part is read, never at ingestion.
   */
  trackedLeadSourceId?: string;
}

/**
 * In the caller's (ingestion) transaction: one pending message_text_parts row per declared part (a contact's message),
 * and the comms.mms_text job, deduplicated per message. Never a second transaction (R-TWL-11).
 */
export async function enqueueTextParts(tx: Tx, j: TextPartJob): Promise<void> {
  const parts = j.parts.filter((p) => Number.isInteger(p.position) && p.position >= 0 && p.position <= 99).slice(0, 100).map((p) => ({ position: p.position, ref: p.ref && ME_SID.test(p.ref) ? p.ref : null }));
  if (parts.length === 0) return;
  if (j.messageId) {
    for (const p of parts) {
      await sql`
        INSERT INTO message_text_parts (tenant_id, message_id, position, provider_media_ref)
        VALUES (app.tenant_id(), ${j.messageId}, ${p.position}, ${p.ref}) ON CONFLICT DO NOTHING`.execute(tx);
    }
  }
  const key = j.messageId ?? `agent:${j.messageRef.slice(0, 64)}`;
  await enqueueJob(tx, {
    queue: MMS_TEXT_JOB.queue,
    kind: MMS_TEXT_JOB.kind,
    payload: { ...(j.messageId ? { messageId: j.messageId } : {}), ...(j.agentUserId ? { agentUserId: j.agentUserId } : {}), messageRef: j.messageRef.slice(0, 64), parts, ...(j.messageId && j.trackedLeadSourceId ? { trackedLeadSourceId: j.trackedLeadSourceId } : {}) },
    dedupeKey: MMS_TEXT_JOB.dedupeKey(key),
  });
}
