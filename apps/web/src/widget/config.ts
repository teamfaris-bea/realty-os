// The widget's embed configuration, read from its own <script> tag (the snippet a team copies from Realty OS):
//
//   <script src="https://app.example.com/widget/chat.js" defer data-widget-key="wk_…"></script>
//
// The key is the only setting. The team name, the notice the visitor must see first (with its id, sent back at
// start so the server records exactly which stored text they saw, R-INBOX-5) and the assistant sentence all come
// from the server (GET /public/chat/:widgetKey), so a team that changes its notice never has to touch its website.
// `data-api` overrides the API base (default: the script's own origin + /api). A missing or malformed key renders
// nothing: the widget never shows a chat it cannot start.
import { WIDGET_KEY } from './api.js';

export interface EmbedConfig {
  widgetKey: string;
  apiBase: string;
}

export function readConfig(el: HTMLScriptElement | null, pageUrl: string): EmbedConfig | null {
  if (!el) return null;
  const widgetKey = (el.dataset.widgetKey ?? '').trim();
  if (!WIDGET_KEY.test(widgetKey)) return null;
  let apiBase = (el.dataset.api ?? '').trim();
  try {
    apiBase = apiBase ? new URL(apiBase, pageUrl).toString().replace(/\/+$/, '') : `${new URL(el.src || pageUrl, pageUrl).origin}/api`;
  } catch {
    return null;
  }
  return { widgetKey, apiBase };
}
