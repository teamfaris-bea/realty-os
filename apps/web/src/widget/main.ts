// Entry of the separate chat-widget bundle (vite.widget.config.ts → dist/widget/chat.js), loaded by a
// brokerage's website with the embed snippet (config.ts). Reads its own <script> tag, asks the server whether there
// is a chat to offer here (the team name and notice), and only then mounts one widget at the end of <body>; it opens
// when the page address ends in #realty-chat-open: on arrival (a link a team can share), and every time the page moves
// to that address (the site's own "Chat with us" link, <a href="#realty-chat-open">; openHash.ts). When the visitor
// comes back to the tab, an open chat looks for replies at once.
import { chatApi } from './api.js';
import { readConfig } from './config.js';
import { watchOpenHash } from './openHash.js';
import { ChatWidget } from './widget.js';

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

async function boot(script: HTMLScriptElement | null): Promise<void> {
  const cfg = readConfig(script, location.href);
  if (!cfg) {
    console.warn('Realty OS chat: the embed has no valid data-widget-key; nothing is shown.');
    return;
  }
  if (document.querySelector('[data-realty-chat]')) return;
  const w = new ChatWidget(cfg, { api: chatApi(cfg.apiBase), storage: storage() });
  if (!(await w.load())) {
    console.warn("Realty OS chat: this widget isn't available on this page (unknown key, a website it may not run on, turned off, or no notice yet); nothing is shown.");
    return;
  }
  if (document.querySelector('[data-realty-chat]')) return;
  document.body.append(w.host);
  watchOpenHash(() => w.open());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') w.wake();
  });
}

const me = (document.currentScript as HTMLScriptElement | null) ?? document.querySelector<HTMLScriptElement>('script[data-widget-key]');
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot(me));
else void boot(me);
