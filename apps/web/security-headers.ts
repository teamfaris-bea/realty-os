// Browser security policy for the web app, defined once. vite.config.ts applies it to `vite preview`
// (the production build) and injects the CSP as a <meta> tag into the built index.html; the
// deployable static server should send `webSecurityHeaders` on every response it serves.
//
// The policy is strict: no 'unsafe-inline' and no 'unsafe-eval' anywhere. The production bundle has
// no inline script or style (Vite emits external files; React `style` props are set through the
// CSSOM, which CSP does not block). The dev server is NOT covered: @vitejs/plugin-react's refresh
// preamble is an inline <script>, and Vite injects CSS as inline <style> tags in dev.
// e2e/security/csp.spec.ts builds the app, serves it with `vite preview` and asserts zero violations.

const directives: Record<string, readonly string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'"],
  // the API is same-origin under /api (docs/CONVENTIONS.md)
  'connect-src': ["'self'"],
  'manifest-src': ["'self'"],
  'worker-src': ["'self'"],
  'media-src': ["'self'"],
  'frame-src': ["'none'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};

/** Directives a <meta http-equiv="Content-Security-Policy"> cannot carry (browsers ignore them there). */
const HEADER_ONLY = new Set(['frame-ancestors', 'report-uri', 'sandbox']);

function serialize(names: readonly string[]): string {
  return names.map((n) => `${n} ${directives[n]!.join(' ')}`).join('; ');
}

/** The full policy, for the Content-Security-Policy response header. */
export const contentSecurityPolicy: string = serialize(Object.keys(directives));

/** The same policy without header-only directives, for the <meta> tag in the built index.html. */
export const metaContentSecurityPolicy: string = serialize(Object.keys(directives).filter((n) => !HEADER_ONLY.has(n)));

/** Every security header a server should send with the web app's HTML and assets. */
export const webSecurityHeaders: Readonly<Record<string, string>> = {
  'Content-Security-Policy': contentSecurityPolicy,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // legacy clickjacking guard for browsers without frame-ancestors
  'X-Frame-Options': 'DENY',
};

/** The <meta> tag the build injects at the top of <head>, before any script or stylesheet. */
export function cspMetaTag(): string {
  return `<meta http-equiv="Content-Security-Policy" content="${metaContentSecurityPolicy}" />`;
}
