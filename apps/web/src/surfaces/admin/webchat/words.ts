// Plain words and pure helpers for the Website chat page.

export const WEBCHAT_PATH = '/admin/web-chat';
/** Lead sources (surfaces/lead-sources): where sources and their consent text are added (b9 ui/F4). */
export const LEAD_SOURCES_PATH = '/admin/lead-sources';
export const MAX_WEBSITES = 10;

export const ERROR_MESSAGES: Record<string, string> = {
  CHANNEL_NOT_CONNECTED: "This widget is disconnected, so its key and websites can't be changed. Create a new widget instead.",
  CONNECTION_NOT_CONNECTABLE: 'This widget is already disconnected. Nothing was changed.',
  VALIDATION_FAILED: 'Check the form: each website must be an address like https://www.example.com, and you can list at most 10.',
  NOT_FOUND: "That widget or lead source wasn't found. It may have been removed. Reload the page and try again.",
};

/** The websites box → origins, or the sentence that says what to fix. Mirrors the API's rule (address only, no path). */
export function parseWebsites(text: string): { ok: true; origins: string[] } | { ok: false; message: string } {
  const out: string[] = [];
  for (const line of text.split(/[\n,]/)) {
    const raw = line.trim();
    if (!raw) continue;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return { ok: false, message: `"${raw}" isn't a website address. Write it like https://www.example.com.` };
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
      return { ok: false, message: `"${raw}" has more than the website's address. Write only the address, like https://www.example.com, without a page path.` };
    }
    const o = `${u.protocol}//${u.host}`.toLowerCase();
    if (!out.includes(o)) out.push(o);
  }
  if (out.length > MAX_WEBSITES) return { ok: false, message: `List at most ${MAX_WEBSITES} websites.` };
  return { ok: true, origins: out };
}

export function websitesWords(origins: readonly string[]): string {
  return origins.length === 0 ? 'Any website that has the embed code.' : origins.join(', ');
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The embed snippet: the widget key only (src/widget/config.ts reads `data-widget-key`, and `data-api` when a
 * deployment overrides the API base). The team name and the current consent disclosure come from the server
 * (GET /public/chat/:key), so a changed notice never goes stale inside a customer's website (batch 7 review ui/F4).
 * The script is served by this app's own origin at /widget/chat.js; the widget's API base defaults to that origin + /api.
 */
export function embedSnippet(appOrigin: string, key: string): string {
  return `<script src="${attr(appOrigin)}/widget/chat.js" defer data-widget-key="${attr(key)}"></script>`;
}

export const STATUS_LABEL: Record<string, { label: string; tone: 'ok' | 'warn' | 'neutral' }> = {
  connected: { label: 'Live', tone: 'ok' },
  degraded: { label: 'Live with problems', tone: 'warn' },
  disconnected: { label: 'Disconnected', tone: 'neutral' },
};

export const isLive = (status: string) => status === 'connected' || status === 'degraded';
