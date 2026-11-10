// The one gate for any URL that comes from data (listing links, lead source URLs, imported website
// fields, API responses) and is rendered into an href or src. React 18 renders `javascript:` URLs
// as-is (it only warns), so a data URL must pass through here first. In-app navigation uses
// react-router paths built in code, not this helper.

/** Schemes a data URL may use by default. */
export const SAFE_URL_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:', 'tel:'];

export interface SafeUrlOptions {
  /** Replaces the default scheme list (lowercase, with the trailing colon, e.g. `['otpauth:']`). */
  allow?: readonly string[];
}

/**
 * Returns the trimmed URL when it is absolute, has an allowed scheme and carries no credentials;
 * otherwise null (render plain text instead of a link). Relative values are rejected: data never
 * names an in-app path.
 */
export function safeUrl(raw: string | null | undefined, o: SafeUrlOptions = {}): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  // control characters and whitespace inside a URL are how scheme filters get bypassed ("java\tscript:")
  // eslint-disable-next-line no-control-regex
  if (value === '' || /[\u0000- \u007f-\u009f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const allow = o.allow ?? SAFE_URL_SCHEMES;
  if (!allow.includes(url.protocol.toLowerCase())) return null;
  // the literal scheme must match what URL parsed (no parser-differential tricks)
  if (!value.toLowerCase().startsWith(url.protocol.toLowerCase())) return null;
  if (url.username !== '' || url.password !== '') return null;
  return value;
}
