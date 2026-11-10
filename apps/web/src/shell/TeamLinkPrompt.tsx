// A deep link tagged with one of the user's other teams (DATA_MODEL E56). A user can belong to two
// tenants and a session has exactly one active; push notifications carry their tenant's slug as
// `?team=<slug>`, so a notification from team B opened while team A is active would otherwise open
// a page that does not exist in A. This says so plainly and offers the switch (POST /auth/tenant-switch,
// which rotates the session). It never switches on its own: the person decides.
// `?team=` naming the active team, or a team the user is not on, shows nothing (the server only ever
// switches to a team the user is an active member of; the slug is a hint, never authority).
import { useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Notice } from '../design/index.js';
import { pathAfterAuth } from './authApi.js';
import { FormError, useAuthAction } from './auth/AuthFrame.js';
import { useSession, useShell } from './context.js';

export const TEAM_PARAM = 'team';

export function TeamLinkPrompt() {
  const { auth } = useShell();
  const { session, setSession } = useSession();
  const [params] = useSearchParams();
  const { pathname, hash } = useLocation();
  const navigate = useNavigate();
  const a = useAuthAction();
  const [dismissed, setDismissed] = useState<string | null>(null);

  const wanted = params.get(TEAM_PARAM)?.toLowerCase() ?? null;
  const current = session?.tenant ?? null;
  const target = wanted && current && current.slug.toLowerCase() !== wanted ? session?.tenants.find((t) => t.slug.toLowerCase() === wanted) : undefined;
  if (!target || !current || dismissed === target.slug) return null;

  /** The same page without `?team=` (other query parameters and the hash are kept). */
  const samePath = () => {
    const rest = new URLSearchParams(params);
    rest.delete(TEAM_PARAM);
    const q = rest.toString();
    return `${pathname}${q ? `?${q}` : ''}${hash}`;
  };

  const switchTeam = async () => {
    const res = await a.run(() => auth.tenantSwitch(target.slug));
    if (!res) return;
    setSession(res.session);
    navigate(pathAfterAuth(res.session, samePath()), { replace: true });
  };

  const stay = () => {
    setDismissed(target.slug);
    navigate(samePath(), { replace: true });
  };

  return (
    <div className="px-4 pt-3 md:px-8">
      <Notice tone="info" title={`This notification is from ${target.name}.`}>
        <p>
          You're signed in to {current.name}. Switch to {target.name} to open it.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="primary" pending={a.pending} pendingLabel={`Switching to ${target.name}`} onClick={() => void switchTeam()}>
            Switch to {target.name}
          </Button>
          <Button variant="quiet" disabled={a.pending} onClick={stay}>
            Stay in {current.name}
          </Button>
        </div>
        {a.error ? (
          <div className="mt-2">
            <FormError message={a.error} />
          </div>
        ) : null}
      </Notice>
    </div>
  );
}
