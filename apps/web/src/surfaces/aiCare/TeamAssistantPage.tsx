// "AI assistant (ISA)" (/settings/ai-assistant/team; Owner and Admin; R-ISA-32; E517, E522; docs/AI_ISA.md §3.5, §10.7).
// - One line for each condition that holds sending back (counsel review, the deployment switch, the cap, the team's AI
//   features), not only the first (settings.ts:27-29 sends only the first).
// - The switch: the Owner turns it on with a written confirmation and the password (Q2: the confirmation text is a web
//   constant until the server serves one; allowed while counsel review is pending, Q8: nothing sends and Start is
//   refused). An Admin turns it off only. Off ends AI care for everyone, with a handoff each (E522).
// - The daily cap: 0–1000; raising it is the Owner's, with its own confirmation and the password.
// - The team policy, read-only, in words, each value marked VERIFY WITH COUNSEL (Q5: editing and approving it in the
//   app is not built), with the fields that changed since the previous version (no claim about pausing, V11).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { parseAiIsaContent, type AiIsaContent } from '@realty/core/isa';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Dialog, Notice, announce } from '../../design/index.js';
import { type ApiError, useApi, useRequestReauth } from '../../shell/index.js';
import type { Playbook } from '../admin/lib/types.js';
import { type AdminPutBody, type AdminView, useAdmin, useIsaVisible, useMe } from './api.js';
import { useViewer } from './Controls.js';
import { CAPABILITY_WORDS, CAP_PAGE_MESSAGES, TEAM_PAGE_MESSAGES, isaMessage } from './words.js';

/** Q2: what the Owner confirms (sent verbatim as the attestation; the server hashes it into the audit). */
export const ON_ATTESTATION = 'I turn on the AI assistant for my team. Its consent, quiet-hours and frequency limits are engineering defaults that counsel has not reviewed, and I accept responsibility for that.';
export const capAttestation = (n: number) => `I raise the team's daily AI assistant limit to ${n} messages and accept responsibility for that.`;

/** Every condition that holds AI sending back right now, one sentence each. */
export function holdLines(v: AdminView): { key: string; text: string; link?: { to: string; label: string } }[] {
  const out: { key: string; text: string; link?: { to: string; label: string } }[] = [];
  if (!v.packCleared) out.push({ key: 'counsel', text: 'Waiting on counsel review (platform:ai_isa). Nothing is sent until counsel clears it.' });
  if (!v.liveSends) out.push({ key: 'live', text: 'AI assistant sending is off on this deployment.' });
  if (v.sentToday >= v.dailyCap) out.push({ key: 'cap', text: "The team's daily AI assistant limit is reached; it continues on its own when the limit resets." });
  if (!v.aiEnabled) out.push({ key: 'ai', text: 'AI features are off for the team', link: { to: '/settings/team', label: 'Brokerage and team settings' } });
  return out;
}

export default function TeamAssistantPage() {
  const q = useAdmin(useIsaVisible());
  if (q.isPending) return <p className="py-10 text-center text-[15px] text-ink-muted">Loading</p>;
  if (q.isError) return q.error.status === 404 || q.error.status === 403 ? null : <Notice tone="error">{isaMessage(q.error)}</Notice>;
  return <Team v={q.data} />;
}

function Team({ v }: { v: AdminView }) {
  const api = useApi();
  const { role } = useViewer(null, null);
  const owner = role === 'owner';
  const [confirmOn, setConfirmOn] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [tick, setTick] = useState(false);
  const [cap, setCap] = useState(String(v.dailyCap));
  const [capTick, setCapTick] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const reauth = useRequestReauth();
  const qc = useQueryClient();
  const put = async (body: AdminPutBody, ok: string, local: Readonly<Record<string, string>> = TEAM_PAGE_MESSAGES) => {
    if (pending) return;
    setPending(true);
    try {
      for (let tries = 0; ; tries += 1) {
        try {
          await api.request<AdminView>('PUT', '/admin/ai-isa', body);
          setLine(ok);
          announce(ok);
          break;
        } catch (e) {
          const err = e as ApiError;
          if (err.code === 'REAUTH_REQUIRED' && tries === 0 && (await reauth())) continue;
          const t = isaMessage(err, local);
          setLine(t);
          announce(t);
          break;
        }
      }
    } finally {
      setPending(false);
      await qc.invalidateQueries({ queryKey: ['ai-isa'] });
    }
  };
  const capN = Number(cap);
  const capValid = Number.isInteger(capN) && capN >= 0 && capN <= 1000;
  const raising = capValid && capN > v.dailyCap;
  const lines = holdLines(v);
  return (
    <div className="flex w-full max-w-3xl flex-col gap-5">
      <p className="text-[15px] text-ink">{v.noticeSentence} VERIFY WITH COUNSEL.</p>
      {lines.length > 0 ? (
        <div data-testid="ai-team-holds">
          <Notice tone="warn" title="What holds AI messages back">
            <ul className="flex flex-col gap-1">
              {lines.map((l) => (
                <li key={l.key}>
                  {l.text}
                  {l.link ? (
                    <>
                      {': '}
                      <Link to={l.link.to} className="font-medium text-accent underline">
                        {l.link.label}
                      </Link>
                    </>
                  ) : null}
                  {l.link ? '.' : ''}
                </li>
              ))}
            </ul>
          </Notice>
        </div>
      ) : null}
      {line ? (
        <p role="status" className="text-[15px] text-ink" data-testid="ai-team-line">
          {line}
        </p>
      ) : null}
      <Card className="flex flex-col gap-3" aria-labelledby="ai-switch">
        <h2 id="ai-switch" className="text-[19px] font-semibold">
          The AI assistant for the team
        </h2>
        <p className="text-[15px]">{v.enabled ? `On. AI care for ${v.underCare} people now.` : 'Off.'}</p>
        {v.enabled ? (
          <div>
            <Button variant="danger" pending={pending} onClick={() => setConfirmOff(true)}>
              Turn off
            </Button>
          </div>
        ) : owner ? (
          <div>
            <Button variant="primary" pending={pending} onClick={() => setConfirmOn(true)}>
              Turn on
            </Button>
          </div>
        ) : (
          // batch 13 isa-4 F13: an Admin may turn it off only (R-ISA-32): no button that always fails
          <p className="text-[15px] text-ink-muted">{TEAM_PAGE_MESSAGES.OWNER_REQUIRED}</p>
        )}
      </Card>
      <Card className="flex flex-col gap-3" aria-labelledby="ai-cap">
        <h2 id="ai-cap" className="text-[19px] font-semibold">
          Daily limit
        </h2>
        <p className="text-[15px]">{v.sentToday} AI messages counted today.</p>
        <label className="flex flex-col gap-1 text-[15px] font-medium" htmlFor="ai-cap-input">
          Most AI messages a day for the team (0 to 1000)
          <input id="ai-cap-input" type="number" min={0} max={1000} step={1} inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} className="min-h-tap rounded-xl border border-line bg-surface px-3 text-[17px]" />
        </label>
        {raising && owner ? (
          <label className="flex items-start gap-2 text-[15px]">
            <input type="checkbox" className="mt-1 h-5 w-5" checked={capTick} onChange={(e) => setCapTick(e.target.checked)} />
            <span>{capAttestation(capN)}</span>
          </label>
        ) : null}
        {!capValid ? <p className="text-[14px] text-danger">Enter a whole number from 0 to 1000.</p> : null}
        <div>
          <Button
            variant="secondary"
            pending={pending}
            disabled={!capValid || capN === v.dailyCap || (raising && owner && !capTick)}
            onClick={() => void put({ enabled: v.enabled, dailyCap: capN, ...(raising && owner ? { attestation: capAttestation(capN) } : {}) }, `Daily limit set to ${capN}.`, CAP_PAGE_MESSAGES)}
          >
            Save limit
          </Button>
        </div>
      </Card>
      {v.overdueHandoffs > 0 ? (
        <p className="text-[15px]">
          <Link to="/ai-care?filter=overdue" className="font-medium text-accent underline">
            {v.overdueHandoffs} handoffs are past their deadline
          </Link>
        </p>
      ) : null}
      <TeamPolicy />
      {confirmOn ? (
        <Dialog title="Turn on the AI assistant" onClose={() => setConfirmOn(false)}>
          <div className="flex flex-col gap-3 text-[15px]">
            <p className="rounded-xl border border-line bg-surface-2 p-3">{ON_ATTESTATION}</p>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1 h-5 w-5" checked={tick} onChange={(e) => setTick(e.target.checked)} />
              <span>I have read this and agree</span>
            </label>
            {!v.packCleared ? <p>Waiting on counsel review (platform:ai_isa). Nothing is sent until counsel clears it.</p> : null}
            <Button
              variant="primary"
              disabled={!tick}
              pending={pending}
              onClick={async () => {
                setConfirmOn(false);
                await put({ enabled: true, dailyCap: v.dailyCap, attestation: ON_ATTESTATION }, 'Turned on.');
              }}
            >
              Turn on
            </Button>
          </div>
        </Dialog>
      ) : null}
      {confirmOff ? (
        <Dialog title="Turn off the AI assistant" onClose={() => setConfirmOff(false)}>
          <div className="flex flex-col gap-3 text-[15px]">
            <p>This ends AI care for {v.underCare} people now. Each owner gets a handoff.</p>
            <Button
              variant="danger"
              pending={pending}
              onClick={async () => {
                setConfirmOff(false);
                await put({ enabled: false, dailyCap: v.dailyCap }, `Turned off. AI care ended for ${v.underCare} people.`);
              }}
            >
              Turn off for everyone
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

// ---- the team policy, read-only -------------------------------------------------------------------------------------

const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hhmm = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${ampm}`;
};

export function contentOf(steps: unknown): AiIsaContent | null {
  const inner = steps && typeof steps === 'object' && !Array.isArray(steps) && 'aiIsa' in (steps as Record<string, unknown>) ? (steps as { aiIsa: unknown }).aiIsa : steps;
  try {
    return parseAiIsaContent(inner);
  } catch {
    return null;
  }
}

export function policyLines(c: AiIsaContent): { key: keyof AiIsaContent; text: string }[] {
  return [
    { key: 'capabilities', text: `What it may do: ${c.capabilities.map((x) => CAPABILITY_WORDS[x] ?? 'another capability').join('; ')}.` },
    { key: 'channels', text: `Channels: ${c.channels.map((x) => (x === 'sms' ? 'texts' : 'email')).join(' and ')}.` },
    { key: 'window', text: `Sends only between ${hhmm(c.window.startSec)} and ${hhmm(c.window.endSec)} in the person's time.` },
    { key: 'initiatedDays', text: `Follow-ups it starts only on ${c.initiatedDays.map((d) => DAY[d]).join(', ') || 'no day'}.` },
    { key: 'noInitiatedOnHolidays', text: c.noInitiatedOnHolidays ? 'No follow-ups it starts on US federal holidays.' : 'Follow-ups it starts may go on holidays.' },
    { key: 'caps', text: `Limits: ${c.caps.ai24h} AI messages per person in 24 hours, ${c.caps.initiated24h} follow-ups in 24 hours and ${c.caps.initiated7d} in 7 days, at least ${Math.round(c.caps.minGapSeconds / 60)} minutes apart.` },
    { key: 'cadence', text: `Follows up every ${c.cadence.replace('d', ' days').replace(/^1 days$/, '1 day')} when they don't answer.` },
    { key: 'limits', text: `At most ${c.limits.maxMessagesPerAssignment} messages and ${c.limits.maxDays} days per person; slower after ${c.limits.slowAfterUnanswered} unanswered, stops after ${c.limits.dormantAfterUnanswered}.` },
  ];
}

export function changedFields(prev: AiIsaContent, next: AiIsaContent): (keyof AiIsaContent)[] {
  return (Object.keys(next) as (keyof AiIsaContent)[]).filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
}

const FIELD_WORDS: Partial<Record<keyof AiIsaContent, string>> = {
  capabilities: 'what it may do', channels: 'channels', window: 'sending hours', initiatedDays: 'follow-up days', noInitiatedOnHolidays: 'holidays', caps: 'limits',
  cadence: 'follow-up pace', limits: 'message and day limits', readiness: 'readiness', booking: 'booking', holdingLines: 'holding lines', tone: 'tone',
};

function TeamPolicy() {
  const api = useApi();
  const me = useMe();
  const pb = useQuery<{ playbooks: Playbook[] }, ApiError>({ queryKey: ['playbooks'], queryFn: ({ signal }) => api.get('/playbooks', { signal }) });
  const isa = pb.data?.playbooks.find((p) => p.kind === 'ai_isa') ?? null;
  const versionId = me.data?.policy?.versionId ?? isa?.approvedVersionId ?? null;
  const versions = [...(isa?.versions ?? [])].sort((a, b) => b.versionNo - a.versionNo);
  const approved = versions.find((v) => v.id === versionId) ?? null;
  const prev = approved ? versions.find((v) => v.versionNo < approved.versionNo && v.status !== 'draft') ?? null : null;
  const content = approved ? contentOf(approved.steps) : null;
  const prevContent = prev ? contentOf(prev.steps) : null;
  return (
    <Card className="flex flex-col gap-2" aria-labelledby="ai-policy">
      <h2 id="ai-policy" className="text-[19px] font-semibold">
        Team policy
      </h2>
      {!me.data || pb.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : !me.data.policy ? <p className="text-[15px]">Your team has no approved AI assistant policy yet.</p> : !content ? (
        <p className="text-[15px]">This policy can't be shown here.</p>
      ) : (
        <>
          <p className="text-[15px]">Approved version {approved?.versionNo}. Engineering defaults: VERIFY WITH COUNSEL.</p>
          <ul className="flex flex-col gap-1 text-[15px]">
            {policyLines(content).map((l) => (
              <li key={l.key}>
                {l.text} <span className="text-[13px] text-ink-muted">VERIFY WITH COUNSEL</span>
              </li>
            ))}
          </ul>
          {prevContent ? (
            <p className="text-[15px]">
              Changed since version {prev!.versionNo}: {changedFields(prevContent, content).map((k) => FIELD_WORDS[k] ?? 'another field').join(', ') || 'nothing'}.
            </p>
          ) : null}
        </>
      )}
      <p className="text-[14px] text-ink-muted">Editing and approving the team policy is not built yet.</p>
    </Card>
  );
}
