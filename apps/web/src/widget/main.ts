// Entry of the separate chat-widget bundle (vite.widget.config.ts → dist/widget/chat.js), loaded by a
// brokerage's website with the embed snippet (config.ts). Reads its own <script> tag, mounts one widget at the
// end of <body>, and opens it at once when the page address ends in #realty-chat-open (a link a team can share).
import { chatApi } from './api.js';
import { readConfig } from './config.js';
import { ChatWidget } from './widget.js';

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function boot(script: HTMLScriptElement | null): void {
  const cfg = readConfig(script, location.href);
  if (!cfg) {
    console.warn('Realty OS chat: the embed is missing data-widget-key, data-brokerage, data-disclosure-id or data-disclosure; nothing is shown.');
    return;
  }
  if (document.querySelector('[data-realty-chat]')) return;
  const w = new ChatWidget(cfg, { api: chatApi(cfg.apiBase), storage: storage() });
  document.body.append(w.host);
  if (location.hash === '#realty-chat-open') w.open();
}

const me = (document.currentScript as HTMLScriptElement | null) ?? document.querySelector<HTMLScriptElement>('script[data-widget-key]');
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => boot(me));
else boot(me);
