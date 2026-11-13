// module 46: the client portal's entry (portal.html). The link is read, and a token stripped from the address bar,
// BEFORE React renders anything (R-PORTALWEB-3).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PortalApp } from './App.js';
import { readLink } from './link.js';
import './portal.css';

const link = readLink();
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <PortalApp link={link} />
    </StrictMode>,
  );
}
