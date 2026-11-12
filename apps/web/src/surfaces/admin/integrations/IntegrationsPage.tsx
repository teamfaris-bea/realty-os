// Integrations (module 41, web/admin-p2): every service's real state in one place, for Owner and Admin.
//
//   GET  /admin/integrations                              services, their connections and capabilities, platform packs
//   POST /admin/integrations/connections/:id/disconnect   only for a connection of a kind no longer offered (re-auth)
//
// What the page says comes from the server's sentences (R-INT-2, R-INT-6): a capability is "Works now" only when
// the server says it is available; every review pack shows whether counsel reviewed it, with a "Not reviewed by
// counsel" banner while any is not. Owner decision D2: Messenger and Instagram direct messages, Meta Lead Ads and
// Meta ads are never offered (filtered by kind here whatever the server sends), and platform:meta is never shown
// as a review to clear. A row of those kinds made before D2 is listed only so it can be disconnected.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useId, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, ButtonLink, Card, Dialog, Notice } from '../../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../../shell/index.js';
import { Pill, StatusLine } from '../lib/ui.js';
import { keepFocus, useRequest } from './request.js';
import { type Connection, type Integrations, type PlatformPack, type Service, NEVER_CLEARED_PACKS, offered, pickIntegrations, stillThere } from './types.js';
import { ERROR_MESSAGES, adapterModeWords, callbackResultWords, capabilityName, capabilityReason, manageLink, packName, plainSentence, statusLabel } from './words.js';

export const INTEGRATIONS_KEY = ['admin', 'integrations'] as const;

export default function IntegrationsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const req = useRequest(ERROR_MESSAGES);
  const [params] = useSearchParams();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Connection | null>(null);
  const q = useQuery<Integrations, ApiError>({ queryKey: INTEGRATIONS_KEY, queryFn: async ({ signal }) => pickIntegrations(await api.get<unknown>('/admin/integrations', { signal })) });
  const d = q.data;
  const result = callbackResultWords(params.get('result'));

  const disconnect = async (c: Connection) => {
    setError(null);
    setStatus(null);
    // closed first: the shell's password prompt may open next, and two dialogs must never trap focus at once
    setConfirm(null);
    setStatus(`Disconnecting ${c.displayName}`);
    const r = await req.run('disconnect', 'POST', `/admin/integrations/connections/${encodeURIComponent(c.id)}/disconnect`);
    void qc.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
    setStatus(r.ok ? `${c.displayName} is disconnected. Its access was revoked.` : null);
    if (!r.ok) setError(r.message);
    keepFocus();
  };

  const services = d?.services.filter(offered) ?? [];
  const leftovers = d?.services.filter((s) => !offered(s)).flatMap((s) => s.connections.filter(stillThere).map((c) => ({ service: s, connection: c }))) ?? [];
  const packs = d?.platformPacks.filter((p) => !NEVER_CLEARED_PACKS.includes(p.key)) ?? [];
  const mode = d ? adapterModeWords(d.adapterMode) : null;

  return (
    <div className="flex w-full min-w-0 max-w-4xl flex-col gap-8">
      <StatusLine text={status} />
      {result ? <Notice tone={result.tone}>{result.text}</Notice> : null}
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, ERROR_MESSAGES)}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {d ? (
        <>
          {mode ? <Notice tone={mode.tone}>{mode.text}</Notice> : null}

          <Block title="Services" description="What each service does for your team right now, and why when it does not.">
            <ul className="flex flex-col gap-3">
              {services.map((s) => (
                <ServiceCard key={s.kind} service={s} />
              ))}
            </ul>
          </Block>

          <PacksBlock packs={packs} />

          {d.perUser.length > 0 ? (
            <Block title="Connected by each person" description="These are not set up here.">
              <ul className="flex flex-col gap-3">
                {d.perUser.map((p) => (
                  <li key={p.key} className="flex flex-col gap-0.5">
                    <p className="text-[16px] font-semibold text-ink">{p.name}</p>
                    <p className="text-[15px] text-ink-muted">{p.sentence}</p>
                  </li>
                ))}
              </ul>
            </Block>
          ) : null}

          {leftovers.length > 0 ? (
            <Block title="No longer offered" description="These connections were made before the owner took these services out of scope. Nothing is sent or received through them, and they cannot be connected again. Disconnect them to remove their access.">
              <ul className="flex flex-col gap-3">
                {leftovers.map(({ service, connection }) => (
                  <Card as="li" key={connection.id} className="flex flex-col gap-2">
                    <p className="text-[16px] font-semibold text-ink">
                      {connection.displayName} <span className="font-normal text-ink-muted">({service.name})</span>
                    </p>
                    <p className="text-[15px] text-ink">Not offered. Nothing is sent or received through it.</p>
                    <div>
                      <Button variant="secondary" disabled={req.pending !== null} onClick={() => setConfirm(connection)}>
                        Disconnect {connection.displayName}
                      </Button>
                    </div>
                  </Card>
                ))}
              </ul>
            </Block>
          ) : null}
        </>
      ) : null}
      {confirm ? (
        <Dialog
          title={`Disconnect ${confirm.displayName}?`}
          description="Its access is revoked at once."
          onClose={() => setConfirm(null)}
          footer={
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="quiet" onClick={() => setConfirm(null)}>
                Go back
              </Button>
              <Button variant="danger" pending={req.pending === 'disconnect'} pendingLabel="Disconnecting" onClick={() => void disconnect(confirm)}>
                Disconnect
              </Button>
            </div>
          }
        >
          <p className="text-[16px] text-ink">History stays. The connection cannot be made again.</p>
        </Dialog>
      ) : null}
    </div>
  );
}

function ServiceCard({ service }: { service: Service }) {
  const hid = useId();
  const link = manageLink(service.kind);
  const shown = service.connections;
  return (
    <Card as="li" aria-labelledby={hid} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 id={hid} className="text-[17px] font-semibold text-ink">
          {service.name}
        </h3>
        <p className="text-[15px] text-ink">{service.connect === 'keyed' && link ? 'It has no outside account to connect; it is set up on its own page (below).' : plainSentence(service.sentence)}
          {service.connect === 'oauth' ? ' Connecting is not available from this page yet.' : ''}</p>
      </div>
      {shown.length > 0 ? (
        <ul className="flex flex-col gap-3 border-t border-line pt-3" aria-label={`${service.name} connections`}>
          {shown.map((c) => (
            <ConnectionRow key={c.id} c={c} />
          ))}
        </ul>
      ) : (
        <p className="text-[15px] text-ink-muted">No connection yet.</p>
      )}
      {link ? (
        <div className="flex flex-col gap-1">
          <div>
            <ButtonLink variant="secondary" to={link.to}>
              {link.label}
            </ButtonLink>
          </div>
          <p className="text-[14px] text-ink-muted">{link.hint}</p>
        </div>
      ) : null}
    </Card>
  );
}

function ConnectionRow({ c }: { c: Connection }) {
  const s = statusLabel(c);
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[16px] font-medium text-ink">{c.displayName}</span>
        <Pill tone={s.tone === 'danger' ? 'danger' : s.tone}>{s.label}</Pill>
      </div>
      <p className="text-[15px] text-ink">{plainSentence(c.statusSentence)}</p>
      {c.capabilities.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label={`What ${c.displayName} can do`}>
          {c.capabilities.map((k) => (
            <li key={k.name} className="text-[15px] text-ink">
              <span className="font-medium">{capabilityName(k.name)}:</span> {capabilityReason(k)}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function PacksBlock({ packs }: { packs: PlatformPack[] }) {
  const open = packs.filter((p) => !p.reviewed).length;
  return (
    <Block title="Counsel review" description="Some features stay off until counsel has reviewed the rules they follow. Reviews are recorded by the platform, not on this page.">
      {packs.length === 0 ? (
        <p className="text-[15px] text-ink-muted">No review packs are published on this deployment.</p>
      ) : open > 0 ? (
        <Notice tone="warn" title="Not reviewed by counsel">
          {open === packs.length ? `None of the ${packs.length} review packs has` : `${open} of ${packs.length} review packs have not`} been reviewed by counsel{open === packs.length ? ' yet' : ''}. What each one controls stays off until it is.
        </Notice>
      ) : (
        <Notice tone="ok" title="Reviewed by counsel">
          Every review pack has been reviewed by counsel. Each line below says whether its feature also waits on anything else.
        </Notice>
      )}
      <ul className="flex flex-col gap-3">
        {packs.map((p) => (
          <li key={p.key} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[16px] font-medium text-ink">{packName(p.key)}</span>
              <Pill tone={p.reviewed ? 'ok' : 'warn'}>{p.reviewed ? 'Reviewed by counsel' : 'Not reviewed by counsel'}</Pill>
            </div>
            <p className="text-[15px] text-ink-muted">{plainSentence(p.sentence)}</p>
          </li>
        ))}
      </ul>
    </Block>
  );
}

function Block({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div>
        <h2 id={id} className="text-[20px] font-semibold text-ink">
          {title}
        </h2>
        {description ? <p className="text-[15px] text-ink-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
