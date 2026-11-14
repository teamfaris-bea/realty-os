// module 46 (R-PORTALWEB-3; E703): starts the client portal. The link is read, and a token stripped from the address
// bar, BEFORE React renders anything. A sign-in link opened in a tab already on this page is only a fragment change (no
// load): it is re-read in place (b15 audit P46-SEC-2), stripped from the address bar and from the history entry the
// fragment change made before anything renders, and the app restarts on it (a fresh query cache); nothing is posted
// until the Sign in tap. The page used to reload instead, which left the token in that entry until the new page ran.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PortalApp, type PortalAppProps } from './App.js';
import { type LinkRead, readLink, rereadLink } from './link.js';

/** Reads the link, renders the portal into `el` and re-reads a link that arrives as a fragment change. Returns a stop function. */
export function bootPortal(el: HTMLElement | null, w: Window = window, props: Omit<PortalAppProps, 'link'> = {}): () => void {
  const first = readLink(w.location, w.history);
  if (!el) return () => undefined;
  const root = createRoot(el);
  let n = 0;
  const show = (link: LinkRead) =>
    root.render(
      <StrictMode>
        <PortalApp key={n} link={link} {...props} />
      </StrictMode>,
    );
  show(first);
  const onHash = () => {
    const next = rereadLink(w.location, w.history);
    if (!next) return;
    n += 1;
    show(next);
  };
  w.addEventListener('hashchange', onHash);
  return () => {
    w.removeEventListener('hashchange', onHash);
    root.unmount();
  };
}
