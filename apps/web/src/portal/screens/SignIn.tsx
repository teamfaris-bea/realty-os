// module 46: the signed-out screens. SignIn (GET /me answered 401), SignedOut (after a logout or a session 401: the
// causes are not told apart, R-PORTALWEB-6), Incomplete (a malformed link, E702) and Unavailable (503: the portal is
// off; after a request, nothing was sent; at a link's Sign in tap, no claim about sending, E704).
import { useState } from 'react';
import { API_SENTENCES, COPY } from '../copy.js';
import { usePortal } from '../context.js';
import { H1, Page, useFocusHeading } from './common.js';
import { SignInForm } from './SignInForm.js';

export function SignIn({ onUnavailable, lead }: { onUnavailable(): void; lead?: string | null }) {
  const { team } = usePortal();
  const h = useFocusHeading();
  // b15 review UI-3: once a link is asked for, a used link's "…ask for a new one" is stale and goes
  const [asked, setAsked] = useState(false);
  return (
    <Page>
      <H1 headingRef={h}>{team ? COPY.signInTitle : COPY.noTeamTitle}</H1>
      {lead && !asked ? <p className="rounded-lg bg-warn-soft px-3 py-2 text-[16px] text-ink">{lead}</p> : null}
      {team ? <SignInForm onUnavailable={onUnavailable} onAccepted={() => setAsked(true)} /> : <p className="text-[16px] text-ink">{COPY.noTeamBody}</p>}
    </Page>
  );
}

export function SignedOut({ onUnavailable }: { onUnavailable(): void }) {
  const h = useFocusHeading();
  return (
    <Page>
      <H1 headingRef={h}>{COPY.signedOutTitle}</H1>
      <p className="text-[16px] text-ink">{COPY.signedOutBody}</p>
      <SignInForm onUnavailable={onUnavailable} />
    </Page>
  );
}

export function Incomplete({ onUnavailable }: { onUnavailable(): void }) {
  const { team } = usePortal();
  const h = useFocusHeading();
  const [asked, setAsked] = useState(false); // b15 review UI-3, as in SignIn
  return (
    <Page>
      <H1 headingRef={h}>{team ? COPY.signInTitle : COPY.noTeamTitle}</H1>
      {asked ? null : <p className="rounded-lg bg-warn-soft px-3 py-2 text-[16px] text-ink">{COPY.incomplete}</p>}
      {team ? <SignInForm onUnavailable={onUnavailable} onAccepted={() => setAsked(true)} /> : <p className="text-[16px] text-ink">{COPY.noTeamBody}</p>}
    </Page>
  );
}

/**
 * `atTap`: the 503 answered the Sign in tap of a link that was sent (b15 audit F11), so the screen makes no claim about
 * sending; after a request for a link it adds that none was sent.
 */
export function Unavailable({ atTap = false }: { atTap?: boolean }) {
  const h = useFocusHeading();
  return (
    <Page>
      <H1 headingRef={h}>{COPY.unavailableTitle}</H1>
      <p className="text-[16px] text-ink">{API_SENTENCES.PORTAL_NOT_AVAILABLE}</p>
      {atTap ? null : <p className="text-[16px] text-ink-muted">{COPY.nothingSent}</p>}
    </Page>
  );
}
