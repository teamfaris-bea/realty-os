// Browser security policy for the web app, defined once. vite.config.ts applies it to `vite preview`
// (the production build) and injects the CSP as a <meta> tag into the built index.html; the
// deployable static server (deploy/nginx.conf) sends `webSecurityHeaders` on every response it serves,
// through deploy/security-headers.conf, which is generated from `nginxSecurityHeadersConf()` below.
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

/**
 * The website chat widget's script, /widget/chat.js (module 37, built by vite.widget.config.ts), is loaded by the
 * brokerages' own websites with a plain <script src>: a cross-origin no-cors request, which
 * Cross-Origin-Resource-Policy: same-origin would block. That one path gets the same headers with CORP
 * cross-origin; every other response stays same-origin. (The widget's calls to the API are CORS requests that the
 * API answers itself, for any website and without credentials; the widget's allowed websites are enforced where its
 * key is resolved, the config and start routes, while an open chat's session routes rely on its token alone.)
 */
export const widgetScriptHeaders: Readonly<Record<string, string>> = {
  ...webSecurityHeaders,
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

/** `add_header` lines for a header set (with `always`, so error pages carry them too), after a header comment. */
function nginxHeaders(headers: Readonly<Record<string, string>>, comment: readonly string[]): string {
  const lines = Object.entries(headers).map(([name, value]) => {
    // a value is written inside "…": refuse anything nginx would interpret (quotes, escapes, variables)
    if (!/^[A-Za-z0-9-]+$/.test(name) || /["\\$\r\n{}]/.test(value)) throw new Error(`${name} cannot be written as an nginx header`);
    return `add_header ${name} "${value}" always;`;
  });
  return [...comment, ...lines, ''].join('\n');
}

/**
 * The nginx `add_header` lines that send `webSecurityHeaders`. deploy/security-headers.conf is exactly this text,
 * written by `node deploy/render-security-headers.mjs`; src/security-headers.nginx.test.ts fails when that file or
 * deploy/nginx.conf drifts from this policy.
 */
export function nginxSecurityHeadersConf(): string {
  return nginxHeaders(webSecurityHeaders, [
    '# GENERATED from apps/web/security-headers.ts (webSecurityHeaders) by `node deploy/render-security-headers.mjs`.',
    '# Do not edit: apps/web/src/security-headers.nginx.test.ts fails when this file drifts from that policy.',
    '# Included by every content location of deploy/nginx.conf (nginx drops inherited add_header lines in a',
    '# location that sets its own, so each location includes this file instead of relying on inheritance).',
  ]);
}

/** The same for `widgetScriptHeaders`: deploy/widget-security-headers.conf, included by the /widget/chat.js location only. */
export function nginxWidgetHeadersConf(): string {
  return nginxHeaders(widgetScriptHeaders, [
    '# GENERATED from apps/web/security-headers.ts (widgetScriptHeaders) by `node deploy/render-security-headers.mjs`.',
    '# Do not edit: apps/web/src/security-headers.nginx.test.ts fails when this file drifts from that policy.',
    '# Included only by the /widget/chat.js location of deploy/nginx.conf: the chat widget script that brokerages\'',
    '# websites load cross-origin (Cross-Origin-Resource-Policy: cross-origin); every other location stays same-origin.',
  ]);
}

/** The <meta> tag the build injects at the top of <head>, before any script or stylesheet. */
export function cspMetaTag(): string {
  return `<meta http-equiv="Content-Security-Policy" content="${metaContentSecurityPolicy}" />`;
}
