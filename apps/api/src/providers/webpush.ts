// Real PushProvider over the Web Push protocol (web-push, VAPID). Push goes only to agents' own
// subscribed devices; bodies are PII-minimized by the notification module (first name + initial or
// nothing, tenant setting notification_detail).
import { sendNotification } from 'web-push';
import type { PushProvider, PushTarget } from './types.js';

export function webPushProvider(vapid: { publicKey: string; privateKey: string; subject: string }): PushProvider {
  return {
    vapidPublicKey: vapid.publicKey,
    async deliverPush(target: PushTarget, payload) {
      try {
        await sendNotification({ endpoint: target.endpoint, keys: target.keys }, JSON.stringify(payload), {
          vapidDetails: vapid,
          TTL: 300,
          urgency: 'high',
        });
        return { status: 'sent' };
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) return { status: 'gone' };
        return { status: 'failed' };
      }
    },
  };
}
