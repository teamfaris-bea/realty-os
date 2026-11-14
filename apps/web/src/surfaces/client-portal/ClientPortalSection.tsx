// module 46 (R-PORTALWEB-10; E653, E698): the client portal section of a deal (and, in a follow-up, a listing). It
// reads module 45's staff routes only (never the client API): GET /deals/:id/portal; an invisible deal or a role
// without portal.view (an ISA, support) is 404 and the section is hidden. It shows 45's words for the clearance,
// the link channels, each account and grant, a "What {name} sees" link per live grant, Invite (one tap, a fresh
// idempotency key per tap) with 45's dispatch-gated notice, blocked included, never a send-anyway, and Stop sharing
// (a confirm dialog; final). It always says what cannot be shared from the app yet.
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Dialog, GateBadge, Notice } from '../../design/index.js';
import { type ApiError, messageFor, newCommandId, useApi } from '../../shell/index.js';
import { useMutate } from '../feed/lib/hooks.js';
import type { GrantStaff, InviteResponse, Notice as InviteNotice, PortalState } from './types.js';
import { PORTAL_STAFF_MESSAGES, STAFF_WORDS } from './words.js';

export const portalKey = (kind: 'deal' | 'listing', id: string) => ['client-portal', kind, id] as const;

export interface ClientPortalSectionProps {
  dealId?: string;
  listingId?: string;
  primaryContact: { id: string; name: string } | null;
}

function NoticeView({ notice }: { notice: InviteNotice }) {
  return (
    <div className="flex flex-col gap-2" data-testid="invite-notice">
      <Notice tone={notice.sent ? 'ok' : notice.decision ? 'warn' : 'info'}>{notice.text}</Notice>
      {notice.decision && notice.decision.outcome !== 'allow' ? <GateBadge decision={{ outcome: 'deny', explanation: notice.decision.explanation }} lead={STAFF_WORDS.notSent} /> : null}
    </div>
  );
}

export function ClientPortalSection({ dealId, listingId, primaryContact }: ClientPortalSectionProps) {
  const kind = dealId ? 'deal' : 'listing';
  const id = (dealId ?? listingId)!;
  const api = useApi();
  const heading = useId();
  const key = portalKey(kind, id);
  const q = useQuery<PortalState, ApiError>({ queryKey: key, queryFn: ({ signal }) => api.get<PortalState>(`/${kind}s/${id}/portal`, { signal }), retry: false });
  const invite = useMutate<{ contactId: string; idempotencyKey: string; resend?: boolean }, InviteResponse>('POST', { invalidate: [key] });
  const revoke = useMutate<Record<string, never>, { ok: true }>('POST', { invalidate: [key] });
  const [notice, setNotice] = useState<InviteNotice | null>(null);
  const [stopping, setStopping] = useState<GrantStaff | null>(null);
  const [revokeMsg, setRevokeMsg] = useState<string | null>(null);

  if (q.isError && q.error.code === 'NOT_FOUND') return null;
  const s = q.data;
  const nameFor = (g: GrantStaff) => {
    const acc = s?.accounts.find((a) => a.id === g.accountId);
    return acc && primaryContact && acc.contactId === primaryContact.id ? primaryContact.name : STAFF_WORDS.theClient;
  };
  const primaryLive = s && primaryContact ? s.grants.find((g) => g.state === 'live' && s.accounts.some((a) => a.id === g.accountId && a.contactId === primaryContact.id)) : undefined;

  const doInvite = async (resend: boolean) => {
    if (!primaryContact) return;
    setNotice(null);
    // a fresh key per tap: a double tap is one request (useMutate), a later tap is a new command
    const r = await invite.run(`/${kind}s/${id}/portal/invite`, { contactId: primaryContact.id, idempotencyKey: newCommandId(), ...(resend ? { resend: true } : {}) });
    if (r.ok) setNotice(r.data.notice);
  };
  const doRevoke = async (g: GrantStaff) => {
    const r = await revoke.run(`/portal-grants/${g.id}/revoke`, {});
    setStopping(null);
    setRevokeMsg(r.ok ? null : r.code === 'PORTAL_GRANT_REVOKED' ? STAFF_WORDS.revokeDone : messageFor(r, PORTAL_STAFF_MESSAGES));
  };

  return (
    <Card aria-labelledby={heading} className="flex flex-col gap-3">
      <h2 id={heading} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
        {STAFF_WORDS.heading}
      </h2>
      {q.isPending ? <p className="text-[15px] text-ink-muted">{STAFF_WORDS.loading}</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, PORTAL_STAFF_MESSAGES)}</Notice> : null}
      {s ? (
        <>
          {!s.portalCleared ? <Notice tone="warn">{s.portalText ? `${s.portalText} ${STAFF_WORDS.offTail}` : STAFF_WORDS.off}</Notice> : null}
          {s.channels.text.length > 0 ? (
            <ul className="flex flex-col gap-1 text-[14px] text-ink-muted" aria-label="Sign-in links">
              {s.channels.text.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          ) : null}
          {s.grants.length === 0 ? <p className="text-[15px] text-ink-muted">{STAFF_WORDS.noOne}</p> : null}
          <ul className="flex flex-col">
            {s.grants.map((g) => {
              const acc = s.accounts.find((a) => a.id === g.accountId);
              const name = nameFor(g);
              return (
                <li key={g.id} className="flex flex-col gap-1 border-t border-line py-3 first:border-t-0">
                  <p className="text-[16px] font-medium text-ink">
                    <span dir="auto">{name}</span>
                    <span className="text-ink-muted"> · </span>
                    <span dir="auto">{g.view.title}</span>
                  </p>
                  <p className="text-[14px] text-ink-muted">{[acc?.statusText, g.stateText].filter(Boolean).join(' ')}</p>
                  {acc?.signInImpossible ? <p className="text-[14px] text-ink">{acc.signInImpossible}</p> : null}
                  {g.state === 'live' ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={`/client-portal/${g.id}`} state={{ name }} className="inline-flex min-h-tap items-center text-[15px] font-semibold text-accent underline underline-offset-4">
                        {STAFF_WORDS.sees(name)}
                      </Link>
                      <Button variant="quiet" onClick={() => setStopping(g)}>
                        {STAFF_WORDS.stop(name)}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {primaryContact ? (
            <div className="flex flex-wrap gap-2">
              {primaryLive ? (
                <Button variant="secondary" pending={invite.pending} onClick={() => void doInvite(true)}>
                  {STAFF_WORDS.resend}
                </Button>
              ) : (
                <Button pending={invite.pending} onClick={() => void doInvite(false)}>
                  {STAFF_WORDS.invite(primaryContact.name)}
                </Button>
              )}
            </div>
          ) : null}
          {notice ? <NoticeView notice={notice} /> : null}
          {invite.error ? <Notice tone="error">{messageFor(invite.error, PORTAL_STAFF_MESSAGES)}</Notice> : null}
          {revokeMsg ? <Notice tone="info">{revokeMsg}</Notice> : null}
          <p className="text-[14px] text-ink-muted">{STAFF_WORDS.notShareable}</p>
        </>
      ) : null}
      {stopping ? (
        <Dialog
          title={STAFF_WORDS.stop(nameFor(stopping))}
          description={STAFF_WORDS.revokeBody(nameFor(stopping).replace(/^the client$/, 'The client'))}
          onClose={() => setStopping(null)}
          footer={
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="quiet" onClick={() => setStopping(null)}>
                Cancel
              </Button>
              <Button variant="danger" pending={revoke.pending} onClick={() => void doRevoke(stopping)}>
                {STAFF_WORDS.stop(nameFor(stopping))}
              </Button>
            </div>
          }
        >
          {null}
        </Dialog>
      ) : null}
    </Card>
  );
}
