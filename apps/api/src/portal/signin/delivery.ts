// Which channels can carry a client's sign-in link on this deployment (R-PORTAL-10, E686; F11). A link is never handed
// to a fake provider outside tests, and a text needs both Twilio and TELEPHONY_LIVE_REQUESTS=true (without it every
// text fails TELEPHONY_LIVE_OFF). Pure.
import type { Config } from '../../config.js';
import { CHANNEL_WORDS } from '../shared/copy.js';

export type LinkChannelState = 'real' | 'test' | 'off';
export interface LinkChannels {
  email: LinkChannelState;
  sms: LinkChannelState;
}

type ChannelConfig = Pick<Config, 'env' | 'telephonyLiveRequests'> & { providers: Pick<Config['providers'], 'email' | 'telephony'> };

export function linkChannels(c: ChannelConfig): LinkChannels {
  const test = c.env === 'test';
  return {
    email: c.providers.email === 'smtp' ? 'real' : c.providers.email === 'fake' && test ? 'test' : 'off',
    sms: c.providers.telephony === 'twilio' && c.telephonyLiveRequests ? 'real' : c.providers.telephony === 'fake' && test ? 'test' : 'off',
  };
}

/** The staff view's words for the channels (nothing for a real one). */
export function linkChannelWords(ch: LinkChannels): string[] {
  const out: string[] = [];
  for (const k of ['email', 'sms'] as const) {
    const t = CHANNEL_WORDS[k][ch[k]];
    if (t) out.push(t);
  }
  return out;
}
