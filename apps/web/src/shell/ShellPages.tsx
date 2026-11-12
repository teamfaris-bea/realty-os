// Pages the shell itself provides: Account, the phone More list, the home fallback (shown only
// while no surface registers '/'), and Not found.
import { useId } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, EmptyState, Icon } from '../design/index.js';
import { useSession } from './context.js';
import { ROLE_LABEL, useNav } from './Layout.js';
import type { NavItem } from './pages.js';

export function AccountPage() {
  const { session, signOut } = useSession();
  if (!session?.tenant) return null;
  const others = session.tenants.filter((t) => t.id !== session.tenant!.id);
  return (
    <div className="flex max-w-xl flex-col gap-4">
      <Card aria-labelledby="acct-you">
        <h2 id="acct-you" className="sr-only">
          You
        </h2>
        <p className="text-[17px] font-semibold text-ink">{session.user.displayName}</p>
        <p className="text-[15px] text-ink-muted">{session.user.email}</p>
      </Card>
      <Card aria-labelledby="acct-team">
        <h2 id="acct-team" className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
          Team
        </h2>
        <p className="mt-1 text-[17px] text-ink">{session.tenant.name}</p>
        <p className="text-[15px] text-ink-muted">{ROLE_LABEL[session.tenant.role]}</p>
        {others.length > 0 ? (
          <Link to="/choose-team" className="mt-2 inline-flex min-h-tap items-center gap-1 text-[16px] font-medium text-accent">
            Switch team ({others.length} other{others.length === 1 ? '' : 's'})
            <Icon name="chevron" size={16} />
          </Link>
        ) : null}
      </Card>
      <Card aria-labelledby="acct-security">
        <h2 id="acct-security" className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
          Security
        </h2>
        <p className="mt-1 text-[16px] text-ink">Two-step verification: {session.mfa.enabled ? 'on' : 'off'}</p>
        {!session.mfa.enabled ? (
          <Link to="/mfa/enroll?next=%2Faccount" className="mt-1 inline-flex min-h-tap items-center gap-1 text-[16px] font-medium text-accent">
            Turn on two-step verification
            <Icon name="chevron" size={16} />
          </Link>
        ) : null}
      </Card>
      <Button variant="secondary" icon="logout" block className="md:w-auto md:self-start" onClick={() => void signOut()}>
        Sign out
      </Button>
    </div>
  );
}

/** Phone More headings, in the desktop sidebar's section order (batch 7 review ui/F7: 30+ rows need their sections). */
const MORE_SECTIONS: readonly { section: NavItem['section']; label: string }[] = [
  { section: 'work', label: 'Work' },
  { section: 'team', label: 'Team' },
  { section: 'admin', label: 'Admin' },
  { section: 'account', label: 'Account' },
];

/** The phone More tab: every page that is not a bottom tab, grouped by section under headings. */
export function MorePage() {
  const nav = useNav();
  const id = useId();
  const groups = MORE_SECTIONS.map((g) => ({ ...g, items: nav.more.filter((i) => i.section === g.section) })).filter((g) => g.items.length > 0);
  return (
    <nav aria-label="More" className="flex flex-col gap-4">
      {groups.map((g) => (
        <section key={g.section} className="flex flex-col gap-1.5">
          <h2 id={`${id}-${g.section}`} className="px-1 text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
            {g.label}
          </h2>
          <ul aria-labelledby={`${id}-${g.section}`} className="overflow-hidden rounded-2xl border border-line bg-surface">
            {g.items.map((i, idx) => (
              <li key={i.path} className={idx > 0 ? 'border-t border-line' : ''}>
                <Link to={i.path} className="flex min-h-[52px] items-center gap-3 px-4 text-[17px] text-ink active:bg-surface-2">
                  <span className="text-accent">
                    <Icon name={i.icon} size={22} />
                  </span>
                  <span className="flex-1">{i.label}</span>
                  <span className="text-ink-muted">
                    <Icon name="chevron" size={18} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

export function HomeFallbackPage() {
  const { session } = useSession();
  return (
    <EmptyState icon="home" title={session?.user.displayName ? `Signed in as ${session.user.displayName}` : 'Signed in'}>
      Nothing is set up on this home screen for your team yet.
    </EmptyState>
  );
}

export function NotFoundPage() {
  return (
    <EmptyState icon="question" title="This page isn't available">
      It may have moved, or your role may not include it.{' '}
      <Link to="/" className="text-accent underline underline-offset-4">
        Go to the home screen
      </Link>
      .
    </EmptyState>
  );
}
