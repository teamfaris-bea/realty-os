// module 46 (R-PORTALWEB-3; E700, E685, E701, E704): the page a sign-in link opens. Nothing is posted on load, focus,
// visibility, pageshow or reload: only the Sign in button's activation posts POST /api/portal/session {token}, once
// (disabled while pending). Success: the cache is cleared, the token dropped, and home opens. 401: 45's link sentence,
// then GET /me decides (home if signed in, else the form or the no-team state). 503: not available. 429 and a network
// error: the sentence, and the tap may be tried again.
import { useRef, useState } from 'react';
import { PortalError } from '../api.js';
import { API_SENTENCES, COPY, sentenceFor } from '../copy.js';
import { usePortal } from '../context.js';
import { dropToken, linkToken } from '../link.js';
import { parseSession } from '../view/index.js';
import { H1, Page, primaryButton, useFocusHeading } from './common.js';

export interface LinkLandingProps {
  /** signed in: the caller clears the cache and opens home */
  onSignedIn(): void;
  /** the link was refused: the caller checks /me with this sentence */
  onLinkRefused(sentence: string): void;
  onUnavailable(): void;
}

export function LinkLanding({ onSignedIn, onLinkRefused, onUnavailable }: LinkLandingProps) {
  const { api, announce } = usePortal();
  const h = useFocusHeading();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const once = useRef(false);

  const tap = async () => {
    const token = linkToken();
    if (once.current || !token) return;
    once.current = true;
    setPending(true);
    setNotice(null);
    try {
      const s = await api.request('POST', '/api/portal/session', parseSession, { token });
      api.setCsrf(s.csrfToken);
      dropToken(token); // only the token this tap sent: a newer link read in place meanwhile stays (B15R-PORTAL-2)
      onSignedIn();
      return;
    } catch (e) {
      const code = e instanceof PortalError ? e.code : 'BAD_RESPONSE';
      if (code === 'PORTAL_LINK_INVALID') {
        dropToken(token);
        onLinkRefused(API_SENTENCES.PORTAL_LINK_INVALID);
        return;
      }
      if (code === 'PORTAL_NOT_AVAILABLE') {
        onUnavailable();
        return;
      }
      const text = sentenceFor(code);
      setNotice(text);
      announce(text);
      once.current = false; // a rate limit or a network error: the client may tap again
    } finally {
      setPending(false);
    }
  };

  return (
    <Page>
      <H1 headingRef={h}>{COPY.landingTitle}</H1>
      <p className="text-[16px] text-ink">{COPY.landingBody}</p>
      {notice ? <p className="rounded-lg bg-danger-soft px-3 py-2 text-[15px] text-ink">{notice}</p> : null}
      <button type="button" onClick={() => void tap()} disabled={pending} className={`${primaryButton} self-start`}>
        {pending ? COPY.signingIn : COPY.signInButton}
      </button>
    </Page>
  );
}
