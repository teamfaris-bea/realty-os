// The seller side of the person's AI care panel (R-ISA-35; E1007, E1008; docs/AI_ISA.md §6.3, §10.1): the home the
// assistant believes it is discussing (the address and the MLS facts the API read), whether its owner confirmed it, and
// the four actions of the seller routes. Each control is drawn only when GET /contacts/:id/ai-isa/seller says the
// action is available to this viewer; a tap shows the server's own sentence, also when the server refuses. Nothing here
// reaches the lead: these are the agent's answers to the assistant, and every fact shown is agent-only.
import { useState } from 'react';
import { Button, announce } from '../../design/index.js';
import { type SellerPanelView, type SellerResult, useIsaAction, useSellerPanel } from './api.js';

const TYPE_WORDS: Record<string, string> = { single_family: 'Single family', condo: 'Condo', townhouse: 'Townhouse', multi_family: 'Multi-family', land: 'Land', manufactured: 'Manufactured home', other: 'Another type' };
const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

export function factsLine(f: NonNullable<SellerPanelView['subject']['facts']>): string {
  const baths = f.baths_x10 === null ? null : count(f.baths_x10 / 10, 'bathroom');
  return `${[TYPE_WORDS[f.type] ?? 'Another type', count(f.beds, 'bedroom'), baths, `${f.sqft.toLocaleString('en-US')} sq ft`].filter(Boolean).join(', ')} (from its MLS record).`;
}

export function SellerHome({ contactId, isOwner, ownerFirst }: { contactId: string; isOwner: boolean; ownerFirst: string }) {
  const q = useSellerPanel(contactId);
  const [line, setLine] = useState<string | null>(null);
  const act = useIsaAction<Record<string, unknown>, SellerResult>('POST', { kind: 'seller', contactId });
  if (!q.data) return null;
  const s = q.data;
  const run = async (path: string, body: Record<string, unknown> = {}) => {
    const r = await act.run(`/contacts/${contactId}/ai-isa/${path}`, body);
    // the server's sentence either way: what it did, or why it refused (its details.sentence, else the code's words)
    const t = r.ok ? r.data.sentence : typeof r.details?.sentence === 'string' ? r.details.sentence : r.message;
    setLine(t);
    announce(t);
  };
  const subject = s.subject;
  const who = isOwner ? 'you confirm' : `${ownerFirst} confirms`;
  const status = subject.disputed
    ? `Marked as not their home. The assistant shares nothing about it until ${who} it again.`
    : subject.confirmed && subject.codes.length === 0
      ? 'Confirmed: the assistant may compare recent sales with this home.'
      : subject.confirmed
        ? `The home’s record or address changed since it was confirmed. The assistant shares nothing about it until ${who} it again.`
        : subject.state === 'ok'
          ? `Not confirmed yet. The assistant shares nothing about this home until ${who} it.`
          : null;
  const a = s.actions;
  return (
    <div id="ai-seller-home" data-testid="ai-seller-home" className="flex scroll-mt-20 flex-col gap-2 rounded-xl border border-line p-3 text-[15px]">
      <p className="font-medium">The home the assistant believes it is discussing</p>
      {subject.addressLine ? <p>{subject.addressLine}</p> : null}
      {subject.facts ? <p>{factsLine(subject.facts)}</p> : null}
      {subject.state !== 'ok' ? (
        <>
          <p>{subject.sentence}</p>
          {subject.nextStep ? <p className="text-ink-muted">{subject.nextStep}</p> : null}
        </>
      ) : null}
      {status ? <p>{status}</p> : null}
      {!a.confirmSubject.available && a.confirmSubject.reason && subject.state === 'ok' && !(subject.confirmed && subject.codes.length === 0) ? <p className="text-ink-muted">{a.confirmSubject.reason}</p> : null}
      {s.link.effect !== 'ok' ? <p className="font-medium text-warn">{s.link.sentence}</p> : null}
      {s.suspension.suspended && s.suspension.sentence ? <p>{s.suspension.sentence}</p> : null}
      {a.confirmSubject.available || a.subjectDisputed.available || a.nearMatchDifferent.available || a.resumeComps.available ? (
        <div className="flex flex-wrap gap-2">
          {a.confirmSubject.available ? (
            <Button variant="primary" pending={act.pending} onClick={() => void run('confirm-subject', { contactAddressId: subject.contactAddressId, recordListingId: subject.recordListingId, factsSha256: subject.factsSha256 })}>
              Confirm this is their home
            </Button>
          ) : null}
          {a.subjectDisputed.available ? (
            <Button variant="secondary" pending={act.pending} onClick={() => void run('seller/subject-disputed')}>
              That is not their home
            </Button>
          ) : null}
          {a.nearMatchDifferent.available ? (
            <Button variant="secondary" pending={act.pending} onClick={() => void run('seller/near-match-different', { listingIds: a.nearMatchDifferent.listingIds })}>
              Near match, different home
            </Button>
          ) : null}
          {a.resumeComps.available ? (
            <Button variant="secondary" pending={act.pending} onClick={() => void run('seller/resume-comps')}>
              Resume comps
            </Button>
          ) : null}
        </div>
      ) : null}
      {line ? (
        <p role="status" className="font-medium" data-testid="ai-seller-line">
          {line}
        </p>
      ) : null}
    </div>
  );
}
