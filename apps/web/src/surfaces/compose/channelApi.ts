// The compose surface's typed client for an agent's reply in website chat (module 22: apps/api comms/compose.ts,
// its chat branch, and assistant/drafts.ts). Every web-chat send of the staff app goes through this file:
//
//   POST /contacts/:id/messages          {channel: 'web_chat', body, idempotencyKey}   a reply; never scheduled
//   POST /assistant/actions/:id/approve  {commandId, editedPayload?: {channel: 'web_chat', body}, reviewedInboundSeq?}
//
// (the box's preview is POST /contacts/:id/messages/preview {channel: 'web_chat', body}, feed/lib/sendCheck.ts).
// A chat reply is an ordinary one-to-one message on the one send path (dispatch.ts deliverChannelMessage, D1), so
// the send-time check decides exactly as for a text: a chat whose session ended (the visitor has been gone 30
// minutes, E77) or whose widget was turned off (R-INBOX-7) comes back blocked with CHANNEL_NOT_CONNECTED and nothing
// is sent; an opt-out blocks it like any other. channelApi.contract.test.tsx checks every request and response here
// against the API's own schemas (apps/api/src/channels/webContract.json).
//
// What is NOT here, on purpose (D2): no Messenger or Instagram channel, and no messaging-window input.
import { type CommandResult, useCommand } from '../../shell/index.js';
import { REACHABILITY_KEY } from '../../reasons/index.js';
import type { ApproveResponse, ComposeResponse } from '../feed/lib/types.js';

/** The channels compose can write on. Web chat is a reply where the client wrote last (R-INBOX-4 is the assistant's side). */
export type ComposeChannel = 'sms' | 'email' | 'web_chat';

/** POST /contacts/:id/messages, web-chat branch (no subject, no scheduleAt: a chat reply goes now or not at all). */
export interface WebChatSendBody {
  channel: 'web_chat';
  body: string;
}

/** The gate reason of a chat reply refused because the session ended or the widget is off (E77, R-INBOX-7). */
export const CHANNEL_NOT_CONNECTED = 'CHANNEL_NOT_CONNECTED';

/** The outcome of one web-chat send or approval, normalized for the box. */
export type WebChatOutcome =
  | { kind: 'done'; response: ComposeResponse }
  | { kind: 'chat_ended' }
  | { kind: 'error'; code: string; message: string; details: Record<string, unknown> | null };

/** True when the send-time check refused the reply because the chat is no longer there. */
export function isChatEnded(r: { result: string; decision: { reasons: string[] } | null }): boolean {
  return r.result === 'blocked' && (r.decision?.reasons.includes(CHANNEL_NOT_CONNECTED) ?? false);
}

const NO_CHAT = "There's no website chat with them to reply to.";

function failure(r: Extract<CommandResult<unknown>, { ok: false }>): WebChatOutcome {
  return { kind: 'error', code: r.code, message: r.code === 'CONTACT_POINT_MISSING' ? NO_CHAT : r.message, details: r.details };
}

export function webChatOutcome(r: CommandResult<ComposeResponse>): WebChatOutcome {
  if (!r.ok) return failure(r);
  return isChatEnded(r.data) ? { kind: 'chat_ended' } : { kind: 'done', response: r.data };
}

/** An approval's response in the box's terms (the message it queued, on web chat). */
export function approvalOutcome(r: CommandResult<ApproveResponse>, body: string): WebChatOutcome {
  if (!r.ok) return failure(r);
  if (isChatEnded(r.data)) return { kind: 'chat_ended' };
  const message = r.data.messageId ? { id: r.data.messageId, channel: 'web_chat' as const, status: r.data.status, statusReason: null, purpose: null, body, subject: null, scheduledFor: null, dispatchedAt: null } : null;
  return { kind: 'done', response: { result: r.data.result, decision: r.data.decision, message } };
}

const keys = (contactId: string) => [['feed'], ['inbox'], ['timeline', contactId], [...REACHABILITY_KEY]];

/** A reply in web chat: one idempotency key per tap (retries reuse it), the same invalidations as a text. */
export function useWebChatSend(contactId: string) {
  const cmd = useCommand<WebChatSendBody, ComposeResponse>(`/contacts/${contactId}/messages`, { idKey: 'idempotencyKey', invalidate: keys(contactId) });
  return {
    pending: cmd.pending,
    async send(body: string): Promise<WebChatOutcome> {
      return webChatOutcome(await cmd.run({ channel: 'web_chat', body }));
    },
  };
}

/** POST /assistant/actions/:id/approve with the draft answered in web chat (drafts.ts: approved drafts may use web_chat). */
export interface WebChatApproveBody {
  editedPayload?: { channel: 'web_chat'; body: string };
  reviewedInboundSeq?: number;
}

/**
 * Approving an assistant draft as a web-chat reply (the person is the sender, path 4), one commandId per tap. `edited`:
 * the agent changed the text or moved the draft to the chat, so the approval carries the chat text; a chat draft sent
 * as drafted is approved as is.
 */
export function useWebChatApprove(contactId: string, draftId: string | null) {
  const cmd = useCommand<WebChatApproveBody, ApproveResponse>(`/assistant/actions/${draftId ?? 'none'}/approve`, { invalidate: keys(contactId) });
  return {
    pending: cmd.pending,
    async approve(body: string, reviewedInboundSeq: number | null, edited: boolean): Promise<WebChatOutcome> {
      const r = await cmd.run({ ...(edited ? { editedPayload: { channel: 'web_chat' as const, body } } : {}), ...(reviewedInboundSeq !== null ? { reviewedInboundSeq } : {}) });
      return approvalOutcome(r, body);
    },
  };
}
