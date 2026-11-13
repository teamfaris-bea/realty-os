// module 46: the signed-out screens. SignIn (GET /me answered 401), SignedOut (after a logout or a session 401: the
// causes are not told apart, R-PORTALWEB-6), Incomplete (a malformed link, E682) and Unavailable (503: the portal is
// off, nothing was sent, E684).
import { API_SENTENCES, COPY } from '../copy.js';
import { usePortal } from '../context.js';
import { H1, Page, useFocusHeading } from './common.js';
import { SignInForm } from './SignInForm.js';

export function SignIn({ onUnavailable, lead }: { onUnavailable(): void; lead?: string | null }) {
  const { team } = usePortal();
  const h = useFocusHeading();
  return (
    <Page>
      <H1 headingRef={h}>{team ? COPY.signInTitle : COPY.noTeamTitle}</H1>
      {lead ? <p className="rounded-lg bg-warn-soft px-3 py-2 text-[16px] text-ink">{lead}</p> : null}
      {team ? <SignInForm onUnavailable={onUnavailable} /> : <p className="text-[16px] text-ink">{COPY.noTeamBody}</p>}
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
  return (
    <Page>
      <H1 headingRef={h}>{team ? COPY.signInTitle : COPY.noTeamTitle}</H1>
      <p className="rounded-lg bg-warn-soft px-3 py-2 text-[16px] text-ink">{COPY.incomplete}</p>
      {team ? <SignInForm onUnavailable={onUnavailable} /> : <p className="text-[16px] text-ink">{COPY.noTeamBody}</p>}
    </Page>
  );
}

export function Unavailable() {
  const h = useFocusHeading();
  return (
    <Page>
      <H1 headingRef={h}>{COPY.unavailableTitle}</H1>
      <p className="text-[16px] text-ink">{API_SENTENCES.PORTAL_NOT_AVAILABLE}</p>
      <p className="text-[16px] text-ink-muted">{COPY.nothingSent}</p>
    </Page>
  );
}
