// module 46: the client portal's entry (portal.html). The link is read, and a token stripped from the address bar,
// BEFORE React renders anything (R-PORTALWEB-3).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PortalApp } from './App.js';
import { classifyHash, readLink } from './link.js';
import './portal.css';

const link = readLink();
// a sign-in link opened in a tab already on this page is only a fragment change (no load): reload, so the link is
// read, and stripped, exactly as on a first load (nothing is posted until the Sign in tap)
window.addEventListener('hashchange', () => {
  if (classifyHash(window.location.hash).kind !== 'none') window.location.reload();
});
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <PortalApp link={link} />
    </StrictMode>,
  );
}
