// Plain words for the Connect MLS page. Pure functions; the page passes what the API sent.
import type { SparkOverview, SparkProvider, ValidateResult } from './types.js';

export const LIVE_CALLS_OFF = 'Live MLS calls are turned off on this deployment';

export const TOKEN_HINT = "Use the CRM's own Spark API key. Never the website's key.";

export function providerWords(p: SparkProvider): string {
  return p === 'spark' ? 'Spark API' : 'Built-in test listings (no MLS connected)';
}

/**
 * The deployment sentence. The server's sentence already starts with LIVE_CALLS_OFF when live calls
 * are off; if it ever does not, the page says it anyway, so it is never left unsaid.
 */
export function deploymentWords(o: Pick<SparkOverview, 'liveCalls' | 'sentence'>): string {
  const s = o.sentence.trim();
  if (o.liveCalls || s.startsWith(LIVE_CALLS_OFF)) return s;
  return s ? `${LIVE_CALLS_OFF}. ${s}` : `${LIVE_CALLS_OFF}.`;
}

export type Tone = 'ok' | 'warn' | 'error' | 'info';

const RESULTS: Record<ValidateResult, { text: string; tone: Tone }> = {
  connected: { text: 'Connected. Spark accepted the key and answered a test request for one listing.', tone: 'ok' },
  invalid_credentials: {
    text: "Spark did not accept this key. Check that you copied the CRM's access token in full and that the auth scheme is right, then save it again.",
    tone: 'error',
  },
  not_licensed_or_role_insufficient: {
    text: "Spark recognized the key, but it isn't licensed for this listing data or its role can't read listings. Ask Spark support to check the key's access.",
    tone: 'error',
  },
  rate_limited: { text: 'Spark is limiting requests from this key right now. Wait a few minutes, then validate again.', tone: 'warn' },
  unreachable: { text: "We couldn't reach Spark just now. Nothing was changed. Try again in a few minutes.", tone: 'warn' },
  live_calls_disabled: { text: 'Not checked: live MLS calls are turned off on this deployment, so no request was sent to Spark.', tone: 'info' },
};

export function resultWords(r: ValidateResult): { text: string; tone: Tone } {
  return RESULTS[r];
}

/** The stored last result (UPPER_SNAKE code) as words; an unknown code is never shown raw. */
export function lastResultWords(code: string | null): string {
  if (!code) return 'Not validated yet.';
  const key = code.toLowerCase() as ValidateResult;
  return Object.hasOwn(RESULTS, key) ? RESULTS[key].text : 'The last check ended in a way this page cannot describe. Validate again to see the current state.';
}
