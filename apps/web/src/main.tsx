// Entry point (web/shell): design tokens, then the app shell (router, TanStack Query client,
// session, page registry). Surfaces plug in through src/shell/registry.ts.
import './design/tokens.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './shell/App.js';

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
