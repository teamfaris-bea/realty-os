// Details (PARITY_PLAN §5): phones and emails with labels, addresses (Remove, with Undo), custom fields (the Details
// slot of contact/sections.ts), relationships, collaborators, and a pencil to edit. "Edit / replace a phone": phone Details ✎ → field → Save = 3 taps; desktop inline → ↵ = 1.
// A number is never edited in place: changing it replaces it (the old one is removed and keeps its opt-out
// history, R-PAR-11). If a number you removed opted out, texting stays blocked and this says why (R-PAR-12).
// R-PAR-12's one exception, removing a point as a confirmed wrong number, is offered exactly where module 57's
// remove route accepts it: on a point whose wrong-number report is on the consent ledger (a call from the app
// marked "Wrong number", or a reply saying so). Anywhere else the sheet says why it is not offered. Such a removal
// has no Undo: a confirmed wrong number is never added back (WRONG_NUMBER_FINAL).
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Dialog, Notice, TextField } from '../../design/index.js';
import { type ApiError, useApi } from '../../shell/index.js';
import { formatPhone, intentLabel } from '../feed/lib/format.js';
import { DetailsSlots } from '../contact/slots.js';
import type { ContactFullView } from '../feed/lib/types.js';
import { type AddressView, type Details, type PointDetail, RELATIONSHIP_LABEL, firstNameOf, pointsKey, useCandidates } from './api.js';
import { selectClass, useIsDesktop, usePersonAction, useToast } from './hooks.js';

const LABELS = ['mobile', 'home', 'work', 'other'] as const;
const INTENTS = ['buyer', 'seller', 'buyer_seller', 'renter', 'landlord', 'investor'] as const;
const TYPES = [
  ['lead', 'Lead'],
  ['sphere', 'Sphere'],
  ['past_client', 'Past client'],
  ['vendor', 'Vendor'],
  ['other', 'Other'],
] as const;

function usePoints(contactId: string) {
  const api = useApi();
  return useQuery<{ points: PointDetail[] }, ApiError>({ queryKey: pointsKey(contactId), queryFn: ({ signal }) => api.get(`/contacts/${contactId}/points`, { signal }) });
}

const show = (p: Pick<PointDetail, 'kind' | 'address'>) => (p.kind === 'phone' ? formatPhone(p.address) : p.address);

/** Desktop: the number is an inline field; Enter replaces it (remove + add). */
function InlinePoint({ contactId, point }: { contactId: string; point: PointDetail }) {
  const [value, setValue] = useState(show(point));
  const act = usePersonAction(contactId);
  const toast = useToast();
  const id = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (value.trim() === show(point)) return;
    const r = await act.run('POST', `/contacts/${contactId}/points/${point.id}/replace`, { address: value.trim() });
    if (r.ok) toast({ text: `${point.kind === 'phone' ? 'Number' : 'Email'} replaced` });
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="w-20 shrink-0 text-[14px] capitalize text-ink-muted">
          {point.label}
        </label>
        <input id={id} value={value} onChange={(e) => setValue(e.target.value)} className="min-h-tap flex-1 rounded-lg border border-transparent bg-transparent px-2 text-[16px] text-ink hover:border-line focus:border-line" aria-describedby={act.error ? `${id}-e` : undefined} />
        {point.isPrimary ? <span className="text-[13px] text-ink-muted">primary</span> : null}
      </div>
      {act.error ? (
        <p id={`${id}-e`} className="text-[14px] font-medium text-danger">
          {act.error}
        </p>
      ) : null}
    </form>
  );
}

interface PointEdit {
  id: string | null;
  kind: 'phone' | 'email';
  original: string;
  value: string;
  label: string;
  originalLabel: string;
}

/** Why "Remove as a wrong number" is not offered for a saved point (R-PAR-12: the ledger needs the report first). */
export function wrongNumberNotOffered(kind: 'phone' | 'email'): string {
  return kind === 'phone'
    ? '“Remove as a wrong number” isn’t offered: nobody has reported this number as a wrong number yet (a call from the app marked “Wrong number”, or a reply saying so).'
    : '“Remove as a wrong address” isn’t offered: nobody has reported this email as reaching the wrong person yet (a reply saying so).';
}

/** Phone: one sheet to edit names, numbers, emails, intent and type; Save sends only what changed. */
function EditSheet({ contact, details, points, onClose }: { contact: ContactFullView; details: Details; points: PointDetail[]; onClose: () => void }) {
  const [first, setFirst] = useState(contact.firstName ?? '');
  const [last, setLast] = useState(contact.lastName ?? '');
  const [intent, setIntent] = useState(contact.intent ?? '');
  const [type, setType] = useState(contact.contactType);
  const [rows, setRows] = useState<PointEdit[]>(() => points.map((p) => ({ id: p.id, kind: p.kind, original: show(p), value: show(p), label: p.label, originalLabel: p.label })));
  // read from the live points (not the sheet's first snapshot): the saved points whose wrong-number report is
  // on the ledger, where the remove route accepts reason wrong_number
  const reported = new Set(points.filter((p) => p.wrongNumberReported === true).map((p) => p.id));
  const [problem, setProblem] = useState<string | null>(null);
  const act = usePersonAction(contact.id);
  const toast = useToast();
  const ids = { intent: useId(), type: useId() };

  const set = (i: number, patch: Partial<PointEdit>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    setProblem(null);
    const patch: Record<string, unknown> = {};
    if (first.trim() !== (contact.firstName ?? '')) patch.firstName = first.trim() || null;
    if (last.trim() !== (contact.lastName ?? '')) patch.lastName = last.trim() || null;
    if ((intent || null) !== contact.intent) patch.intent = intent || null;
    if (type !== contact.contactType) patch.contactType = type;
    let changed = 0;
    if (Object.keys(patch).length > 0) {
      const r = await act.run('PATCH', `/contacts/${contact.id}`, { rowVersion: details.rowVersion, ...patch });
      if (!r.ok) return setProblem(r.message);
      changed++;
    }
    for (const row of rows) {
      const v = row.value.trim();
      if (row.id === null) {
        if (!v) continue;
        const r = await act.run('POST', `/contacts/${contact.id}/points`, { kind: row.kind, address: v, label: row.label });
        if (!r.ok) return setProblem(r.message);
        changed++;
        continue;
      }
      if (v && v !== row.original) {
        const r = await act.run('POST', `/contacts/${contact.id}/points/${row.id}/replace`, { address: v, label: row.label });
        if (!r.ok) return setProblem(r.message);
        changed++;
      } else if (row.label !== row.originalLabel) {
        const r = await act.run('PATCH', `/contacts/${contact.id}/points/${row.id}`, { label: row.label });
        if (!r.ok) return setProblem(r.message);
        changed++;
      }
    }
    if (changed > 0) toast({ text: 'Saved' });
    onClose();
  };

  const remove = async (row: PointEdit, reason: 'old' | 'wrong_number' = 'old') => {
    if (!row.id) return setRows((rs) => rs.filter((r) => r !== row));
    const r = await act.run('POST', `/contacts/${contact.id}/points/${row.id}/remove`, { reason });
    if (!r.ok) return setProblem(r.message);
    setRows((rs) => rs.filter((x) => x !== row));
    const what = row.kind === 'phone' ? 'Number' : 'Email';
    // a confirmed wrong number is never added back (WRONG_NUMBER_FINAL): no Undo for it
    if (reason === 'wrong_number') toast({ text: `${what} removed as a wrong ${row.kind === 'phone' ? 'number' : 'address'}` });
    else toast({ text: `${what} removed`, undo: () => void act.run('POST', `/contacts/${contact.id}/points`, { kind: row.kind, address: row.original, label: row.originalLabel }) });
  };

  return (
    <Dialog
      title={`Edit ${contact.displayName}`}
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-2">
          <Button block onClick={() => void save()} pending={act.pending}>
            Save
          </Button>
          <Button block variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField label="First name" value={first} onChange={(e) => setFirst(e.target.value)} autoComplete="off" />
        <TextField label="Last name" value={last} onChange={(e) => setLast(e.target.value)} autoComplete="off" />
        {rows.map((row, i) => (
          <div key={row.id ?? `new-${i}`} role="group" aria-label={row.id ? `${row.kind === 'phone' ? 'Phone' : 'Email'} ${row.original}` : `New ${row.kind}`} className="flex flex-col gap-2 rounded-xl border border-line p-3">
            <TextField
              label={`${row.kind === 'phone' ? 'Phone' : 'Email'} (${row.label})`}
              value={row.value}
              inputMode={row.kind === 'phone' ? 'tel' : 'email'}
              type={row.kind === 'phone' ? 'tel' : 'email'}
              onChange={(e) => set(i, { value: e.target.value })}
              hint={row.id && row.value.trim() !== row.original ? 'Saving replaces the old one; its history and any opt-out stay with it.' : undefined}
            />
            <div className="flex items-center gap-2">
              <label className="sr-only" htmlFor={`lab-${i}`}>
                Label
              </label>
              <select id={`lab-${i}`} value={row.label} onChange={(e) => set(i, { label: e.target.value })} className={`${selectClass} flex-1`}>
                {LABELS.map((l) => (
                  <option key={l} value={l}>
                    {l[0]!.toUpperCase() + l.slice(1)}
                  </option>
                ))}
              </select>
              <Button variant="quiet" onClick={() => void remove(row)}>
                Remove
              </Button>
              {row.id && reported.has(row.id) ? (
                <Button variant="quiet" onClick={() => void remove(row, 'wrong_number')}>
                  {row.kind === 'phone' ? 'Remove as a wrong number' : 'Remove as a wrong address'}
                </Button>
              ) : null}
            </div>
            {row.id && !reported.has(row.id) ? <p className="text-[13px] leading-snug text-ink-muted">{wrongNumberNotOffered(row.kind)}</p> : null}
          </div>
        ))}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setRows((rs) => [...rs, { id: null, kind: 'phone', original: '', value: '', label: 'mobile', originalLabel: 'mobile' }])}>
            Add phone
          </Button>
          <Button variant="secondary" onClick={() => setRows((rs) => [...rs, { id: null, kind: 'email', original: '', value: '', label: 'other', originalLabel: 'other' }])}>
            Add email
          </Button>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.intent} className="text-[15px] font-medium text-ink">
            Looking to
          </label>
          <select id={ids.intent} value={intent} onChange={(e) => setIntent(e.target.value)} className={selectClass}>
            <option value="">Not set</option>
            {INTENTS.map((x) => (
              <option key={x} value={x}>
                {intentLabel(x)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.type} className="text-[15px] font-medium text-ink">
            Type
          </label>
          <select id={ids.type} value={type} onChange={(e) => setType(e.target.value)} className={selectClass}>
            {TYPES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </div>
        {problem ? <Notice tone="error">{problem}</Notice> : null}
      </div>
    </Dialog>
  );
}

function RelationshipSheet({ contactId, name, onClose }: { contactId: string; name: string; onClose: () => void }) {
  const api = useApi();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('spouse_partner');
  const [label, setLabel] = useState('');
  const kindId = useId();
  const act = usePersonAction(contactId);
  const toast = useToast();
  const results = useQuery<{ contacts: { id: string; name: string; view: string }[] }, ApiError>({
    queryKey: ['search', 'relationship', q],
    enabled: q.trim().length >= 2,
    queryFn: ({ signal }) => api.get(`/search?q=${encodeURIComponent(q.trim())}`, { signal }),
  });
  const people = (results.data?.contacts ?? []).filter((c) => c.view === 'full' && c.id !== contactId);
  const link = async (other: { id: string; name: string }) => {
    const r = await act.run('POST', `/contacts/${contactId}/relationships`, { relatedContactId: other.id, kind, ...(kind === 'other' ? { label: label.trim() || 'Other' } : {}) });
    if (!r.ok) return;
    toast({ text: `Linked ${name} and ${other.name}` });
    onClose();
  };
  return (
    <Dialog title={`Link someone to ${name}`} description="Only people you can see are listed. A link doesn’t share anyone." onClose={onClose} footer={<Button block variant="secondary" onClick={onClose}>Cancel</Button>}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={kindId} className="text-[15px] font-medium text-ink">
            Relationship
          </label>
          <select id={kindId} value={kind} onChange={(e) => setKind(e.target.value)} className={selectClass}>
            {Object.entries(RELATIONSHIP_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </div>
        {kind === 'other' ? <TextField label="Describe it" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} /> : null}
        <TextField label="Find a person" type="search" value={q} onChange={(e) => setQ(e.target.value)} hint="Name, phone or email" />
        <ul className="flex flex-col gap-1" aria-label="People">
          {people.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => void link(p)} className="flex min-h-tap w-full items-center rounded-lg px-3 text-left text-[16px] text-ink hover:bg-surface-2">
                {p.name}
              </button>
            </li>
          ))}
        </ul>
        {act.error ? <Notice tone="error">{act.error}</Notice> : null}
      </div>
    </Dialog>
  );
}

function CollaboratorSheet({ contactId, name, current, onClose }: { contactId: string; name: string; current: Set<string>; onClose: () => void }) {
  const members = useCandidates(contactId, true);
  const act = usePersonAction(contactId);
  const toast = useToast();
  const list = (members.data?.members ?? []).filter((m) => !current.has(m.userId) && !m.canSee);
  return (
    <Dialog title={`Share ${name}`} description={`A collaborator sees everything about ${firstNameOf(name)} and can work with them, without owning the lead.`} onClose={onClose} footer={<Button block variant="secondary" onClick={onClose}>Cancel</Button>}>
      {members.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {members.data && list.length === 0 ? <p className="text-[15px] text-ink-muted">Everyone on the team who could be added already sees {firstNameOf(name)}.</p> : null}
      <ul className="flex flex-col gap-1" aria-label="Teammates">
        {list.map((m) => (
          <li key={m.userId}>
            <button type="button" onClick={() => void act.run('POST', `/contacts/${contactId}/collaborators`, { userId: m.userId }).then((r) => { if (r.ok) { toast({ text: `${m.displayName ?? 'They'} can now see ${firstNameOf(name)}` }); onClose(); } })} className="flex min-h-tap w-full items-center justify-between rounded-lg px-3 text-left text-[16px] text-ink hover:bg-surface-2">
              <span>{m.displayName ?? 'Member'}</span>
              <span className="text-[14px] text-ink-muted">{m.role.replace('_', ' ')}</span>
            </button>
          </li>
        ))}
      </ul>
      {act.error ? <Notice tone="error">{act.error}</Notice> : null}
    </Dialog>
  );
}

export function DetailsSection({ contact, details }: { contact: ContactFullView; details: Details }) {
  const desktop = useIsDesktop();
  const pts = usePoints(contact.id);
  const [open, setOpen] = useState<'edit' | 'relationship' | 'collaborator' | null>(null);
  const act = usePersonAction(contact.id);
  const toast = useToast();
  const points = pts.data?.points ?? [...contact.phones.map((p) => ({ ...p, kind: 'phone' as const })), ...contact.emails.map((p) => ({ ...p, kind: 'email' as const }))];
  const first = firstNameOf(contact.displayName);
  const blockingRemoved = details.removedPoints.filter((p) => p.optedOut && p.stillBlocks);
  const close = () => setOpen(null);
  // Delete an address (module 57): one tap, then an Undo toast instead of a confirm modal (PARITY_PLAN §5,
  // reversible one-person edits). Undo is the server's restore of the row it deleted (the delete's restore token):
  // the same address exactly, never one rebuilt from what this page shows (an imported address can be longer than
  // the add form allows, and carries details the page does not show).
  const removeAddress = async (a: AddressView) => {
    const r = await act.run('DELETE', `/contacts/${contact.id}/addresses/${a.id}`);
    if (!r.ok) return;
    const token = (r.data as { restoreToken?: unknown } | null)?.restoreToken;
    const undo = typeof token === 'string' ? () => void act.run('POST', `/contacts/${contact.id}/addresses/${a.id}/restore`, { restoreToken: token }) : undefined;
    toast(undo ? { text: 'Address removed', undo } : { text: 'Address removed' });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        {desktop && details.canEdit ? (
          points.map((p) => <InlinePoint key={`${p.id}-${p.address}`} contactId={contact.id} point={p} />)
        ) : (
          <ul className="flex flex-col gap-1 text-[16px] text-ink">
            {points.map((p) => (
              <li key={p.id} className="break-all">
                {show(p)} <span className="text-ink-muted">· {p.label}{p.isPrimary && points.filter((x) => x.kind === p.kind).length > 1 ? ' · primary' : ''}</span>
              </li>
            ))}
            {points.length === 0 ? <li className="text-ink-muted">No phone or email on file.</li> : null}
          </ul>
        )}
      </div>
      {blockingRemoved.length > 0 ? (
        <Notice tone="warn">
          {blockingRemoved.map((p) => (
            <span key={p.id} className="block">
              {p.kind === 'phone'
                ? `Texting ${first} is blocked because a number you removed (${p.tail}) opted out. ${first} can text START from it to opt back in.`
                : `Email to ${first} is blocked because an email you removed (${p.tail}) unsubscribed.`}
            </span>
          ))}
        </Notice>
      ) : null}
      {details.doNotContact ? <Notice tone="warn">{first} asked not to be contacted. Nobody on the team can text, email or call them.</Notice> : null}

      {details.addresses.length > 0 ? (
        <ul className="flex flex-col gap-1 text-[15px] text-ink" aria-label="Addresses">
          {details.addresses.map((a) => {
            const text = [a.line1, a.line2, a.city, a.region, a.postalCode].filter(Boolean).join(', ');
            return (
              <li key={a.id} className="flex items-center gap-2">
                <span className="flex-1">
                  {text} <span className="text-ink-muted">· {a.kind}</span>
                </span>
                {details.canEdit ? (
                  <Button variant="quiet" aria-label={`Remove address ${text || a.kind}`} onClick={() => void removeAddress(a)}>
                    Remove
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* sections other modules register for the Details slot (contact/sections.ts): custom fields */}
      <DetailsSlots contact={contact} />

      <div className="flex flex-col gap-1">
        <h3 className="text-[15px] font-semibold text-ink">Relationships</h3>
        {details.relationships.length === 0 ? <p className="text-[15px] text-ink-muted">None.</p> : null}
        <ul className="flex flex-col gap-1">
          {details.relationships.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-[15px] text-ink">
              <span className="flex-1">
                {r.kind === 'referred_by' && r.direction === 'incoming' ? 'Referred' : (r.label ?? RELATIONSHIP_LABEL[r.kind] ?? r.kind)}:{' '}
                <Link to={`/contacts/${r.other.id}`} className="inline-flex min-h-tap items-center font-medium text-accent hover:underline">
                  {r.other.displayName}
                </Link>
              </span>
              {details.canEdit ? (
                <Button variant="quiet" aria-label={`Remove link to ${r.other.displayName}`} onClick={() => void act.run('DELETE', `/contacts/${contact.id}/relationships/${r.id}`).then((x) => x.ok && toast({ text: 'Link removed' }))}>
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-1">
        <h3 className="text-[15px] font-semibold text-ink">Collaborators</h3>
        {details.collaborators.length === 0 ? <p className="text-[15px] text-ink-muted">Nobody else.</p> : null}
        <ul className="flex flex-col gap-1">
          {details.collaborators.map((c) => (
            <li key={c.userId} className="flex items-center gap-2 text-[15px] text-ink">
              <span className="flex-1">
                {c.displayName ?? 'Member'} <span className="text-ink-muted">· {c.role.replace('_', '-')}</span>
              </span>
              {details.canManageCollaborators ? (
                <Button variant="quiet" aria-label={`Stop sharing with ${c.displayName ?? 'member'}`} onClick={() => void act.run('DELETE', `/contacts/${contact.id}/collaborators/${c.userId}`).then((x) => x.ok && toast({ text: 'Stopped sharing' }))}>
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap gap-2">
        {details.canEdit ? (
          <Button variant="secondary" onClick={() => setOpen('edit')} aria-label={`Edit details of ${contact.displayName}`}>
            ✎ Edit
          </Button>
        ) : null}
        {details.canEdit ? (
          <Button variant="secondary" onClick={() => setOpen('relationship')}>
            Link a person
          </Button>
        ) : null}
        {details.canManageCollaborators ? (
          <Button variant="secondary" onClick={() => setOpen('collaborator')}>
            Share
          </Button>
        ) : null}
      </div>
      {act.error ? <Notice tone="error">{act.error}</Notice> : null}
      {open === 'edit' ? <EditSheet contact={contact} details={details} points={points as PointDetail[]} onClose={close} /> : null}
      {open === 'relationship' ? <RelationshipSheet contactId={contact.id} name={contact.displayName} onClose={close} /> : null}
      {open === 'collaborator' ? <CollaboratorSheet contactId={contact.id} name={contact.displayName} current={new Set(details.collaborators.map((c) => c.userId))} onClose={close} /> : null}
    </div>
  );
}
