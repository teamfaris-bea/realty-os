// module 46: the client portal's entry (portal.html). boot.tsx reads the link, and strips a token from the address
// bar, BEFORE React renders anything, and re-reads a link opened in a tab already on this page (R-PORTALWEB-3).
import { bootPortal } from './boot.js';
import './portal.css';

bootPortal(document.getElementById('root'));
