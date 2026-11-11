// The web-chat transport (module 22; R-GATE-2, R-GATE-15). Its one method, `deliverChannelMessage`, is a reserved
// outbound name: only apps/api/src/comms/dispatch.ts may call it (lint realty/no-provider-outbound + the channels
// architecture test), inside TX1 → transport → TX2, after the send-time gate allowed the message.
//
// Web chat has no external provider: the visitor's own poll (app.webchat_poll) is the delivery, and it shows a
// message only once TX2 marked it `sent`. The transport therefore only acknowledges, deterministically, and keeps a
// log for tests. A test may make the next delivery fail (an injected outage), which dispatch records as `failed`
// (never resent). Nothing here reaches the network, ever.
import { ProviderError } from '../providers/types.js';

export interface ChannelMessage {
  /** the widget connection the message goes out through (messages.integration_connection_id) */
  connectionId: string;
  /** the session's own chat identity (wc:<hex>) */
  toAddress: string;
  /** messages.id: the idempotency key */
  messageId: string;
  body: string;
}

export interface WebChatTransport {
  deliverChannelMessage(m: ChannelMessage): Promise<{ providerRef: string }>;
}

export class InProcessWebChat implements WebChatTransport {
  readonly delivered: ChannelMessage[] = [];
  private failures: ('unavailable' | 'timeout')[] = [];

  /** test helper: the next delivery fails like a provider outage */
  failNext(kind: 'unavailable' | 'timeout'): void {
    this.failures.push(kind);
  }

  async deliverChannelMessage(m: ChannelMessage): Promise<{ providerRef: string }> {
    const f = this.failures.shift();
    if (f) throw new ProviderError(f === 'timeout' ? 'timeout' : 'unavailable', 'WEBCHAT_UNAVAILABLE');
    const prior = this.delivered.find((d) => d.messageId === m.messageId);
    if (!prior) this.delivered.push({ ...m });
    return { providerRef: `webchat:${m.messageId}` };
  }
}
