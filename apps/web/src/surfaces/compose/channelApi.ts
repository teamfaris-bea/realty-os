// The compose surface's typed client for the module 22 channel routes that do not exist yet
// (PHASE2_3_PLAN §5.4, 22 api/channels-inbox). Every call to such a route goes through this file and is
// marked `// STUB(22): <METHOD> <route>`; the orchestrator wires the real route when module 22 lands, and
// channelApi.contract.test.ts pins the shapes against a fake of the §5.4 interface.
//
// Module 22 adds web chat to the one send path (dispatch.ts deliverChannelMessage, D1): an agent's reply to
// a chat visitor is an ordinary one-to-one message on POST /contacts/:id/messages with channel 'web_chat'
// (today's ComposeBody accepts sms | email only, so the real API answers 400 until then). The send-time
// check decides, exactly as for a text: a chat that has ended (the visitor left, E77) or a widget that was
// disconnected (R-INBOX-7) is CHANNEL_NOT_CONNECTED and nothing is sent; an opt-out blocks it like any other.
//
// What is NOT here, on purpose (D2): no Messenger or Instagram channel, and no messaging-window input.
import { type CommandResult, useCommand } from '../../shell/index.js';
import { REACHABILITY_KEY } from '../../reasons/index.js';
import type { ApproveResponse, ComposeResponse } from '../feed/lib/types.js';

/** The channels compose can write on. Web chat is a reply where the client wrote last (R-INBOX-4 is the assistant's side). */
export type ComposeChannel = 'sms' | 'email' | 'web_chat';

/** POST /contacts/:id/messages, web-chat branch (§5.4 22: dispatch.ts deliverChannelMessage). */
export interface WebChatSendBody {
  channel: 'web_chat';
  body: string;
}

/** The code module 22 gives a send to an ended chat session or a disconnected widget (E77, R-INBOX-7). */
export const CHANNEL_NOT_CONNECTED = 'CHANNEL_NOT_CONNECTED';

/** The outcome of one web-chat send, normalized: the API may refuse with an error code or answer with a blocked decision. */
export type WebChatOutcome =
  | { kind: 'done'; response: ComposeResponse }
  | { kind: 'chat_ended' }
  | { kind: 'error'; message: string };

/** True when the response says the chat session is no longer there (either way module 22 may say it). */
export function isChatEnded(r: CommandResult<ComposeResponse>): boolean {
  if (!r.ok) return r.code === CHANNEL_NOT_CONNECTED;
  return (
    r.data.result === 'blocked' &&
    (r.data.decision?.reasons.includes(CHANNEL_NOT_CONNECTED) ?? false)
  );
}

export function webChatOutcome(
  r: CommandResult<ComposeResponse>,
): WebChatOutcome {
  if (isChatEnded(r)) return { kind: 'chat_ended' };
  if (!r.ok) return { kind: 'error', message: r.message };
  return { kind: 'done', response: r.data };
}

/**
 * A reply in web chat: one idempotency key per tap (retries reuse it), the same invalidations as a text.
 * STUB(22): POST /contacts/:id/messages {channel: 'web_chat', body, idempotencyKey}
 */
export function useWebChatSend(contactId: string) {
  // STUB(22): POST /contacts/:id/messages
  const cmd = useCommand<WebChatSendBody, ComposeResponse>(
    `/contacts/${contactId}/messages`,
    {
      idKey: 'idempotencyKey',
      invalidate: [['feed'], ['timeline', contactId], [...REACHABILITY_KEY]],
    },
  );
  return {
    pending: cmd.pending,
    async send(body: string): Promise<WebChatOutcome> {
      return webChatOutcome(await cmd.run({ channel: 'web_chat', body }));
    },
  };
}

/** POST /assistant/actions/:id/approve with the draft moved to web chat (§5.4 22: "drafts.ts: approved drafts may use web_chat"). */
export interface WebChatApproveBody {
  editedPayload: { channel: 'web_chat'; body: string };
  reviewedInboundSeq?: number;
}

/**
 * Approving an assistant draft as a web-chat reply (the person is the sender, path 4). Normalized like a send.
 * STUB(22): POST /assistant/actions/:id/approve {editedPayload: {channel: 'web_chat', body}}
 */
export function useWebChatApprove(contactId: string, draftId: string | null) {
  // STUB(22): POST /assistant/actions/:id/approve
  const cmd = useCommand<WebChatApproveBody, ApproveResponse>(
    `/assistant/actions/${draftId ?? 'none'}/approve`,
    {
      invalidate: [
        ['feed'],
        ['inbox'],
        ['timeline', contactId],
        [...REACHABILITY_KEY],
      ],
    },
  );
  return {
    pending: cmd.pending,
    async approve(
      body: string,
      reviewedInboundSeq: number | null,
    ): Promise<CommandResult<ApproveResponse>> {
      return cmd.run({
        editedPayload: { channel: 'web_chat', body },
        ...(reviewedInboundSeq !== null ? { reviewedInboundSeq } : {}),
      });
    },
  };
}
