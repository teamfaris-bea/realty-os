// An agent's forwarded email, guided (Owner/Admin), in four steps:
//   1 pick a member and the portals that email them (one checkbox per portal; Zillow and Realtor.com start ticked);
//   2 make the source "Forwarded by <name>" (kind portal) and turn its lead email on with those portals' sender
//     domains (POST /lead-sources, then POST /lead-sources/:id/lead-email, 🔒: the shell asks for the password);
//   3 add a direct routing rule for the source (POST /routing-rules) and show where a new lead would go
//     (POST /lead-sources/:id/preview). When another rule wins, "Move this rule to the top" (PUT
//     /routing-rules/order) and the preview again;
//   4 the agent's own steps, in order: the portal's notification or CC field (best), Gmail forwarding and its
//     filter, an Outlook redirect rule, or one at a time (each waits for review).
// "Set it up" runs steps 2 and 3 in one tap. A step that failed is retried from where it stopped: what was already
// made is never made twice.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dialog, Notice } from '../../design/index.js';
import { type ApiError, useApi } from '../../shell/index.js';
import { useAction } from '../admin/lib/hooks.js';
import type { RoutingRule } from '../admin/lib/types.js';
import { Check, SelectField } from '../admin/lib/ui.js';
import { LEAD_EMAIL_ERROR_MESSAGES } from '../lead-email/messages.js';
import type { InboxResponse } from '../lead-email/types.js';
import { SOURCE_KEYS, useMembers } from './hooks.js';
import { sentenceFor } from './messages.js';
import { type CreatedResponse, type OverviewResponse, type PreviewResponse, RULES_KEY } from './types.js';
import { CopyField } from './ui.js';
import { PORTAL_CATALOG, agentSteps, detailPath, portalsOf } from './words.js';

const OFFERABLE = new Set(['agent', 'team_lead', 'isa']);

export const forwardedName = (name: string) => `Forwarded by ${name}`;

export function AgentForwarding({ deployment, onClose }: { deployment: OverviewResponse['deployment'] | null; onClose(): void }) {
  const api = useApi();
  const navigate = useNavigate();
  const members = useMembers();
  const people = (members.data?.members ?? []).filter((m) => m.status === 'active' && OFFERABLE.has(m.role));
  const portals = portalsOf(PORTAL_CATALOG);
  const [userId, setUserId] = useState('');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(portals.filter((p) => p.preTicked).map((p) => p.portal)));
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [ruleId, setRuleId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = useAction<Record<string, unknown>, CreatedResponse>('POST', { invalidate: SOURCE_KEYS });
  const enable = useAction<Record<string, unknown>, InboxResponse>('POST', { invalidate: SOURCE_KEYS });
  const rule = useAction<Record<string, unknown>, { rule: RoutingRule }>('POST', { invalidate: [[...RULES_KEY]] });
  const check = useAction<Record<string, unknown>, PreviewResponse>('POST');
  const order = useAction<{ ruleIds: string[] }, { rules: RoutingRule[] }>('PUT', { invalidate: [[...RULES_KEY]] });

  const person = people.find((p) => p.userId === userId) ?? null;
  const chosen = portals.filter((p) => picked.has(p.portal));
  const domains = chosen.flatMap((p) => p.domains);
  const noEmail = deployment !== null && !deployment.inboundEmail;
  const done = preview !== null && address !== null;

  /** null when the preview is shown, else the sentence of the failure */
  const runPreview = async (id: string): Promise<string | null> => {
    const r = await check.run(`/lead-sources/${id}/preview`, {});
    if (!r.ok) return sentenceFor(r);
    setPreview(r.data);
    return null;
  };

  const setUp = async () => {
    if (!person) return;
    setBusy(true);
    setFailure(null);
    try {
      let id = sourceId;
      if (!id) {
        const r = await create.run('/lead-sources', { name: forwardedName(person.displayName), kind: 'portal' });
        if (!r.ok) return setFailure(sentenceFor(r));
        id = r.data.source.id;
        setSourceId(id);
      }
      if (!address) {
        const r = await enable.run(`/lead-sources/${id}/lead-email`, { allowedSenderDomains: domains });
        if (!r.ok) return setFailure(sentenceFor(r));
        if (!r.data.inbox.address) return setFailure(LEAD_EMAIL_ERROR_MESSAGES.LEAD_EMAIL_NOT_CONFIGURED!);
        setAddress(r.data.inbox.address);
      }
      if (!ruleId) {
        const r = await rule.run('/routing-rules', { name: forwardedName(person.displayName), strategy: 'direct', directUserId: person.userId, match: { sources: [id] } });
        if (!r.ok) return setFailure(sentenceFor(r));
        setRuleId(r.data.rule.id);
      }
      const p = await runPreview(id);
      if (p) setFailure(p);
    } finally {
      setBusy(false);
    }
  };

  const moveToTop = async () => {
    if (!ruleId || !sourceId) return;
    setFailure(null);
    let rules: RoutingRule[];
    try {
      rules = (await api.get<{ rules: RoutingRule[] }>('/routing-rules')).rules.filter((r) => !r.archived);
    } catch (e) {
      return setFailure(sentenceFor(e as ApiError));
    }
    const r = await order.run('/routing-rules/order', { ruleIds: [ruleId, ...rules.map((x) => x.id).filter((x) => x !== ruleId)] });
    if (!r.ok) return setFailure(sentenceFor(r));
    const p = await runPreview(sourceId);
    if (p) setFailure(p);
  };

  const otherRuleWins = preview !== null && preview.rule?.id !== ruleId;
  const offeredTo = preview?.outcome.kind === 'offer' ? preview.outcome.name : null;

  return (
    <Dialog
      title="An agent's forwarded email"
      description={done ? undefined : 'Leads that one agent gets by email from portals, offered to that agent.'}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          {done ? (
            <Button onClick={() => (onClose(), navigate(detailPath(sourceId!)))}>Done</Button>
          ) : (
            <Button pending={busy} disabled={!person || domains.length === 0 || noEmail} onClick={() => void setUp()}>
              Set it up
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            {done ? 'Close' : 'Cancel'}
          </Button>
        </div>
      }
    >
      <ol className="flex flex-col gap-5">
        <li className="flex flex-col gap-2">
          <h3 className="text-[17px] font-semibold text-ink">1. The agent and their portals</h3>
          {members.isError ? <Notice tone="error">{sentenceFor(members.error)}</Notice> : null}
          <SelectField label="Agent" value={userId} disabled={sourceId !== null} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Pick someone</option>
            {people.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.displayName}
              </option>
            ))}
          </SelectField>
          <fieldset className="flex flex-col">
            <legend className="text-[15px] font-medium text-ink">Which portals email them?</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2">
              {portals.map((p) => (
                <Check
                  key={p.portal}
                  label={p.label}
                  checked={picked.has(p.portal)}
                  disabled={address !== null}
                  onChange={(v) => setPicked((s) => (v ? new Set([...s, p.portal]) : new Set([...s].filter((x) => x !== p.portal))))}
                />
              ))}
            </div>
          </fieldset>
          {noEmail ? <Notice tone="warn">{LEAD_EMAIL_ERROR_MESSAGES.LEAD_EMAIL_NOT_CONFIGURED}</Notice> : null}
        </li>
        <li className="flex flex-col gap-2">
          <h3 className="text-[17px] font-semibold text-ink">2. A source for their email</h3>
          {address ? (
            <>
              <p className="text-[15px] text-ink">
                {person ? forwardedName(person.displayName) : 'The source'} was made and its lead email is on, allowing {domains.join(', ')}.
              </p>
              <CopyField label="Lead-email address" value={address} />
            </>
          ) : (
            <p className="text-[15px] text-ink-muted">{person ? `"${forwardedName(person.displayName)}" (a portal source) with lead email on for the portals picked.` : 'Pick the agent first.'}</p>
          )}
        </li>
        <li className="flex flex-col gap-2">
          <h3 className="text-[17px] font-semibold text-ink">3. A rule that offers these leads to them</h3>
          {preview ? (
            <>
              <p className="text-[15px] text-ink">{preview.sentence}</p>
              {otherRuleWins ? (
                <Notice
                  tone="warn"
                  action={
                    <Button variant="secondary" pending={order.pending || check.pending} onClick={() => void moveToTop()}>
                      Move this rule to the top
                    </Button>
                  }
                >
                  {preview.rule ? `The rule "${preview.rule.name}" comes first, so it decides these leads.` : 'No rule matches these leads yet.'}
                </Notice>
              ) : offeredTo ? (
                <Notice tone="ok">The new rule decides these leads.</Notice>
              ) : null}
            </>
          ) : (
            <p className="text-[15px] text-ink-muted">A direct rule for the source, then a check of where a new lead would go.</p>
          )}
        </li>
        <li className="flex flex-col gap-2">
          <h3 className="text-[17px] font-semibold text-ink">4. What the agent does</h3>
          {address ? (
            <AgentSteps address={address} portals={chosen} domains={domains} />
          ) : (
            <p className="text-[15px] text-ink-muted">Their steps show here once the address is made.</p>
          )}
        </li>
      </ol>
      {failure ? (
        <div className="mt-4">
          <Notice tone="error">{failure}</Notice>
        </div>
      ) : null}
    </Dialog>
  );
}

export function AgentSteps({ address, portals, domains }: { address: string; portals: { portal: Parameters<typeof agentSteps>[1][number]['portal']; label: string }[]; domains: string[] }) {
  const steps = agentSteps(address, portals, domains);
  return (
    <ol aria-label="The agent's steps" className="flex flex-col gap-3">
      {steps.map((s, i) => (
        <li key={s.title} className="flex flex-col gap-1">
          <p className="text-[16px] font-semibold text-ink">
            {String.fromCharCode(97 + i)}. {s.title}
          </p>
          {s.lines.map((l) => (
            <p key={l} className="break-words text-[15px] text-ink">
              {l}
            </p>
          ))}
        </li>
      ))}
    </ol>
  );
}
