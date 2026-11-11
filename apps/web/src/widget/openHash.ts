// The page address that opens the chat: a link a team shares (https://site.example/#realty-chat-open), and the site's
// own "Chat with us" link (<a href="#realty-chat-open">). Part of the separate widget bundle (imports nothing outside
// src/widget).
//
// A browser fires `hashchange` only when the fragment actually changes, so a request left in the address would make
// the site's link work once per page (findings F6, UXA-4: after the visitor closed the chat, the link did nothing).
// Once the chat is opened, the request is taken off the address (history.replaceState: the page's path and query stay,
// nothing reloads and no history entry is added), so the next click is a real change again.

export const OPEN_HASH = '#realty-chat-open';

/** Opens the chat now if the address asks for it, and whenever it moves there; returns the function that stops it. */
export function watchOpenHash(open: () => void, win: Window = window): () => void {
  const check = () => {
    if (win.location.hash !== OPEN_HASH) return;
    win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}`);
    open();
  };
  check();
  win.addEventListener('hashchange', check);
  return () => win.removeEventListener('hashchange', check);
}
