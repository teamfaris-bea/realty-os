// D5a: the compose surface's typed client for photos and videos sent by text (apps/api comms outbound media):
//
//   POST   /contacts/:id/outbound-media            {contentType, data: padded base64}   → 201 {upload: {id, contentType, byteSize, expiresAt}}
//   DELETE /contacts/:id/outbound-media/:uploadId                                        → 204 (404 when it is already gone)
//
// A staged upload belongs to the agent who made it and lives until it is sent (POST /contacts/:id/messages with
// mediaIds) or removed; the server strips location and other metadata itself, and refuses a file it cannot clean.
// An upload is not a command: the body is exactly {contentType, data} (no idempotency key), so a failed upload is
// never retried behind the agent's back; the tile says it failed and the agent removes it and attaches it again.
//
// Codes are never shown: each has its own words here (MEDIA_ERROR_WORDS). mediaApi.contract.test.tsx checks the
// requests and responses against the API's own schemas (apps/api/src/channels/webContract.json).
import { ApiError, type ApiClient } from '../../shell/index.js';
import { formatSize } from './prepareMedia.js';
import type { MediaKind } from './prepareMedia.js';

export type UploadContentType = 'image/jpeg' | 'image/png' | 'image/gif' | 'video/mp4' | 'video/quicktime';

export interface UploadMediaBody {
  contentType: UploadContentType;
  data: string;
}

export interface StagedUpload {
  id: string;
  contentType: UploadContentType;
  byteSize: number;
  expiresAt: string;
}

export interface UploadMediaResponse {
  upload: StagedUpload;
}

export type UploadOutcome = { ok: true; upload: StagedUpload } | { ok: false; code: string; sentence: string };

/** How long the server keeps an unsent upload (its expiresAt); not a messaging window (D2). */
export const UNSENT_UPLOAD_HOURS = 24;
export const MEDIA_UPLOAD_LIMIT_WORDS = `You have 20 photos or videos waiting in unsent texts. Unsent ones are removed within ${UNSENT_UPLOAD_HOURS} hours. Remove some, or try again later.`;

/** What each refusal of an upload (or of a text carrying uploads) means, in words. */
export const MEDIA_ERROR_WORDS: Record<string, string> = {
  MEDIA_NOT_ALLOWED: "This file can't be sent by text. Try a JPEG or PNG photo, or an MP4 or MOV video.",
  MEDIA_TOO_LARGE: "It's larger than a text can carry.",
  MEDIA_LOCATION_NOT_REMOVED: "The location couldn't be removed from this file, so it can't be sent. Send a link to it instead.",
  MEDIA_UPLOAD_LIMIT: MEDIA_UPLOAD_LIMIT_WORDS,
  MEDIA_UPLOAD_GONE: 'This photo or video is no longer available. Remove it and attach it again.',
  RATE_LIMITED: 'Too many photos and videos were attached in the last hour. Try again later.',
  CONTACT_MERGED: 'This person was merged into another record. Open their current record to text them.',
  NOT_FOUND: "This person isn't available to you any more.",
  PAYLOAD_TOO_LARGE: "It's larger than a text can carry.",
  NETWORK_ERROR: 'The connection dropped before it was uploaded.',
};

const GENERIC = 'Something went wrong while uploading it.';

/** The words for a refused upload. MEDIA_TOO_LARGE names its limit, per file or for the whole text. */
export function mediaErrorSentence(code: string, details: Record<string, unknown> | null = null, kind: MediaKind = 'photo'): string {
  if (code === 'MEDIA_TOO_LARGE') {
    const limit = typeof details?.limitBytes === 'number' ? details.limitBytes : null;
    if (details?.scope === 'total') return `That would make this text larger than ${formatSize(limit ?? 5_000_000)} in all.`;
    if (limit !== null) return `It's larger than a text can carry: a ${kind} can be at most ${formatSize(limit)}.`;
  }
  if (code === 'MEDIA_UPLOAD_GONE') return goneSentence(kind);
  return MEDIA_ERROR_WORDS[code] ?? GENERIC;
}

/** A tile whose upload the server no longer has (expired, removed, or already sent with another text). */
export function goneSentence(kind: MediaKind): string {
  return `This ${kind} is no longer available. Remove it and attach it again.`;
}

/** Stage one prepared file. Never throws (an abort excepted, which the caller started). */
export async function uploadMedia(api: ApiClient, contactId: string, body: UploadMediaBody, kind: MediaKind, signal?: AbortSignal): Promise<UploadOutcome> {
  try {
    const r = await api.request<UploadMediaResponse>('POST', `/contacts/${contactId}/outbound-media`, body, signal ? { signal } : {});
    return { ok: true, upload: r.upload };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    const err = e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 0);
    return { ok: false, code: err.code, sentence: mediaErrorSentence(err.code, err.details, kind) };
  }
}

/** Remove a staged upload, best effort: true when it is gone (removed now, or already gone: 404). */
export async function deleteMedia(api: ApiClient, contactId: string, uploadId: string): Promise<boolean> {
  try {
    await api.delete<void>(`/contacts/${contactId}/outbound-media/${uploadId}`);
    return true;
  } catch (e) {
    return e instanceof ApiError && e.code === 'NOT_FOUND';
  }
}

/** The issue codes POST /contacts/:id/messages answers for a text with media (VALIDATION_FAILED details.issues). */
const SEND_ISSUE_WORDS: Record<string, string> = {
  media_duplicate: 'The same photo or video is attached twice. Remove one of them.',
  media_text_only: 'Photos and videos go only by text.',
  media_one_to_one_only: 'Photos and videos can only be sent in a text to one person.',
  body_required: 'Write a message, or attach a photo or video.',
  text_too_long: 'Too long for a text. Shorten it or send an email.',
};

/**
 * The words for a send refused because of what it carries (its photos and videos, or a body a text can't take),
 * or null when the refusal is about something else (the caller keeps its own sentence).
 */
export function sendRefusalSentence(code: string, details: Record<string, unknown> | null): string | null {
  if (code === 'MEDIA_UPLOAD_GONE') return 'Not sent: a photo or video is no longer available. Remove it and attach it again.';
  if (code === 'MEDIA_TOO_LARGE') return `Not sent: ${lowerFirst(mediaErrorSentence(code, { ...details, scope: 'total' }))}`;
  if (code === 'MEDIA_NOT_ALLOWED' || code === 'MEDIA_LOCATION_NOT_REMOVED' || code === 'MEDIA_UPLOAD_LIMIT') return `Not sent: ${lowerFirst(MEDIA_ERROR_WORDS[code]!)}`;
  if (code !== 'VALIDATION_FAILED') return null;
  const issues = Array.isArray(details?.issues) ? (details.issues as { path?: unknown; code?: unknown }[]) : [];
  for (const i of issues) if (typeof i.code === 'string' && SEND_ISSUE_WORDS[i.code]) return `Not sent: ${lowerFirst(SEND_ISSUE_WORDS[i.code]!)}`;
  return null;
}

/** The upload a MEDIA_UPLOAD_GONE refusal names, or null. */
export function goneUploadId(code: string, details: Record<string, unknown> | null): string | null {
  return code === 'MEDIA_UPLOAD_GONE' && typeof details?.uploadId === 'string' ? details.uploadId : null;
}

const lowerFirst = (s: string) => (s.length > 1 && /^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);
