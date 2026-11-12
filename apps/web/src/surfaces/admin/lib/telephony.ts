// Whether this deployment's texts and calls reach a phone (R-TWL-1; b9 review ui/F3). The API says it on GET /numbers
// and on the Lead sources overview (apps/api/src/comms/telephonyMode.ts):
//   live       texts and calls reach phones;
//   off        the kill switch (TELEPHONY_LIVE_REQUESTS) is off: every provider request, number purchase included, is
//              refused, so buying a number is not offered (tying a number the team already has still works);
//   simulated  a simulated provider (dev and demos): numbers can be made, but they are test numbers and nothing
//              reaches a phone.
// Phone and email and the Lead sources tracking path say it before the tap, never after it fails.
export type TelephonyMode = 'live' | 'off' | 'simulated';

export const TELEPHONY_OFF_SETUP = 'Live texting and calling are off on this deployment: numbers can be set up but nothing reaches a phone yet.';
/** with the kill switch off: what waits until it is on */
export const TELEPHONY_OFF_DETAIL = 'Getting a new number, checking a registration and releasing a number wait until they are turned on. A number the team already has can still be tied to a lead source, and texts and calls that come in are still received.';
/** with a simulated provider */
export const TELEPHONY_SIMULATED = 'Numbers made here are test numbers from a simulated provider: don’t give them out or print them.';

/** The sentences to show for a mode, or none when texts and calls are live (or the mode is not known). */
export function telephonyNotice(mode: TelephonyMode | undefined): string[] {
  if (mode === 'off') return [TELEPHONY_OFF_SETUP, TELEPHONY_OFF_DETAIL];
  if (mode === 'simulated') return [TELEPHONY_OFF_SETUP, TELEPHONY_SIMULATED];
  return [];
}

/** Buying a number can only fail while the kill switch is off. */
export const canBuyNumber = (mode: TelephonyMode | undefined) => mode !== 'off';
