// What this deployment's telephony can do, in one word the web can say (R-TWL-1; b9 review ui/F3). Read by the
// Lead sources overview and GET /numbers so tracking-number setup says before the tap that nothing reaches a phone:
//   live       TELEPHONY_PROVIDER=twilio and TELEPHONY_LIVE_REQUESTS=true: texts and calls reach phones.
//   off        TELEPHONY_PROVIDER=twilio with the kill switch off (the default everywhere until the pilot approval):
//              every outbound provider request, number purchase included, is refused (TELEPHONY_LIVE_OFF).
//   simulated  TELEPHONY_PROVIDER=fake (dev and demos; production refuses it unless ALLOW_FAKE_PROVIDERS): numbers
//              and sends are the deterministic fake's and never reach a phone, whatever the switch says.
// It names only the deployment's configuration (no credential, no tenant fact) and is shown to Owner/Admin only.
import { z } from 'zod';
import type { Config } from '../config.js';

export const TelephonyMode = z.enum(['live', 'off', 'simulated']);
export type TelephonyMode = z.infer<typeof TelephonyMode>;

export function telephonyMode(c: Pick<Config, 'providers' | 'telephonyLiveRequests'>): TelephonyMode {
  if (c.providers.telephony !== 'twilio') return 'simulated';
  return c.telephonyLiveRequests === true ? 'live' : 'off';
}
