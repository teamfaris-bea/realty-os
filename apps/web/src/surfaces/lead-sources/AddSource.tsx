// "Add a source" (a bottom sheet on a phone, a dialog on desktop): a name, then "How do leads arrive?". The choice
// defaults the kind (which can be changed) and, once POST /lead-sources has made the source, opens that path's setup
// on the source's page. "An agent's forwarded email" is a guided setup of its own (AgentForwarding.tsx) that names
// the source after the agent. The consent text is optional. Where this deployment cannot do a path (no inbound email
// domain, no public https address, live texting and calling off) the choice says so before anything is made.
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dialog, Notice, TextField } from '../../design/index.js';
import { useAction } from '../admin/lib/hooks.js';
import { TELEPHONY_OFF_SETUP } from '../admin/lib/telephony.js';
import { Check, SelectField, TextArea } from '../admin/lib/ui.js';
import { LEAD_EMAIL_ERROR_MESSAGES } from '../lead-email/messages.js';
import { AgentForwarding } from './AgentForwarding.js';
import { SOURCE_KEYS } from './hooks.js';
import { sentenceFor } from './messages.js';
import type { CreatedResponse, OverviewResponse } from './types.js';
import { ARRIVALS, GOOGLE_NOT_AVAILABLE, KINDS, type PathKey, detailPath } from './words.js';

export function arrivalNote(choice: PathKey, deployment: OverviewResponse['deployment'] | null): string | null {
  if (!deployment) return null;
  if (choice === 'email' && !deployment.inboundEmail) return LEAD_EMAIL_ERROR_MESSAGES.LEAD_EMAIL_NOT_CONFIGURED!;
  if (choice === 'forward' && !deployment.inboundEmail) return LEAD_EMAIL_ERROR_MESSAGES.LEAD_EMAIL_NOT_CONFIGURED!;
  if (choice === 'google' && !deployment.publicHttps) return GOOGLE_NOT_AVAILABLE;
  // R-TWL-1 (b9 ui/F3): the kill switch off or a simulated provider: said before anything is made
  if (choice === 'phone' && deployment.telephony && deployment.telephony !== 'live') return TELEPHONY_OFF_SETUP;
  return null;
}

export function AddSource({ deployment, onClose }: { deployment: OverviewResponse['deployment'] | null; onClose(): void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [choice, setChoice] = useState<PathKey>('email');
  const [kind, setKind] = useState<string>('portal');
  const [withConsent, setWithConsent] = useState(false);
  const [text, setText] = useState('');
  const [namesSeller, setNamesSeller] = useState('');
  const [guided, setGuided] = useState(false);
  const create = useAction<Record<string, unknown>, CreatedResponse>('POST', { invalidate: SOURCE_KEYS });
  const note = arrivalNote(choice, deployment);
  if (guided) return <AgentForwarding deployment={deployment} onClose={onClose} />;
  const pick = (v: PathKey) => {
    setChoice(v);
    setKind(ARRIVALS.find((a) => a.value === v)!.kind);
  };
  const consentOk = !withConsent || (text.trim() !== '' && namesSeller.trim() !== '');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (choice === 'forward') {
      setGuided(true);
      return;
    }
    const r = await create.run('/lead-sources', { name: name.trim(), kind, ...(withConsent ? { consentDisclosure: { text: text.trim(), namesSeller: namesSeller.trim() } } : {}) });
    if (r.ok) {
      onClose();
      navigate(detailPath(r.data.source.id, choice));
    }
  };
  return (
    <Dialog
      title="Add a source"
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button type="submit" form="add-source" pending={create.pending} disabled={choice !== 'forward' && (!name.trim() || !consentOk)}>
            {choice === 'forward' ? 'Continue' : 'Add source'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <form id="add-source" aria-label="Add a source" className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        {choice !== 'forward' ? <TextField label="Name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} hint="For example: Zillow, Home value form, Yard signs." /> : null}
        <fieldset className="flex flex-col gap-1">
          <legend className="pb-1 text-[15px] font-medium text-ink">How do leads arrive?</legend>
          {ARRIVALS.map((a) => (
            <label key={a.value} className="flex min-h-tap cursor-pointer items-center gap-3 rounded-xl px-1 text-[16px] text-ink">
              <input type="radio" name="arrival" value={a.value} checked={choice === a.value} onChange={() => pick(a.value)} className="h-[22px] w-[22px] shrink-0 accent-[var(--accent)]" />
              <span className="min-w-0">
                {a.label}
                {a.hint ? <span className="block text-[14px] text-ink-muted">{a.hint}</span> : null}
              </span>
            </label>
          ))}
        </fieldset>
        {note ? <Notice tone="warn">{note}</Notice> : null}
        {choice === 'forward' ? (
          <p className="text-[15px] text-ink-muted">Next: pick the agent and the portals that email them. The source is named after the agent.</p>
        ) : (
          <>
            <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} hint="Set from your choice above. Change it if it fits better.">
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </SelectField>
            <Check label="Add the consent text people see (optional)" checked={withConsent} onChange={setWithConsent} hint="The words on the form or page where people leave their details. You can add it later." />
            {withConsent ? (
              <>
                <TextArea label="Consent text" value={text} maxLength={10_000} onChange={(e) => setText(e.target.value)} />
                <TextField label="Who it names as the seller" value={namesSeller} maxLength={300} onChange={(e) => setNamesSeller(e.target.value)} hint="The team or brokerage the text says will contact them." />
              </>
            ) : null}
          </>
        )}
        {create.error ? <Notice tone="error">{sentenceFor(create.error)}</Notice> : null}
      </form>
    </Dialog>
  );
}
