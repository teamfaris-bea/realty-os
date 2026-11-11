// A person's custom field values (PARITY_PLAN §5: the Details section shows custom fields; R-PAR-17..20; journey
// bug: imported field values were served by GET /contacts/:id/fields but shown nowhere). Registered on the contact
// page through module 58's section registry (surfaces/contact/sections.ts) in the Details slot.
//
// - Read: module 60's GET /contacts/:id/fields (detail only) with the live field definitions (GET /custom-fields).
//   Each value shows under its field's label, in the field's own terms: the number, the date, the choices' names.
// - Edit: only people who may edit the person (contact.edit: the details' canEdit) get "Edit fields", one sheet
//   with every live field; Save sends PUT /contacts/:id/fields/:fieldId for each changed value (an empty value
//   clears it), exactly what module 60's API accepts. Everyone else reads them. Archived fields are not shown;
//   an archived choice a value still holds keeps its name and is not offered for new values.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button, Dialog, Notice, TextField } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { useMutate } from '../feed/lib/hooks.js';
import type { ContactFullView } from '../feed/lib/types.js';
import { useDetails } from '../people-edit/api.js';
import { selectClass } from '../people-edit/hooks.js';
import { type FieldDefView, PEOPLE_KEY, useFields } from './api.js';
import { LISTS_ERROR_MESSAGES } from './messages.js';

/** GET /contacts/:id/fields (api/lists FieldValueView), restated. */
export interface FieldValueView {
  fieldId: string;
  text: string | null;
  number: number | null;
  date: string | null;
  optionIds: string[] | null;
  updatedByKind: 'user' | 'bulk' | 'import';
  updatedAt: string;
}

export const contactFieldsKey = (contactId: string) => ['lists', 'contact-fields', contactId] as const;

export function useContactFields(contactId: string) {
  const api = useApi();
  return useQuery<{ values: FieldValueView[] }, ApiError>({ queryKey: contactFieldsKey(contactId), queryFn: ({ signal }) => api.get(`/contacts/${contactId}/fields`, { signal }) });
}

const dateText = (iso: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));

/** A value in its field's own terms ("87", "Dec 15, 2026", "Pool, Garage"); null when it holds nothing. */
export function fieldValueText(def: Pick<FieldDefView, 'fieldType' | 'options'>, v: FieldValueView | undefined): string | null {
  if (!v) return null;
  switch (def.fieldType) {
    case 'text':
      return v.text?.trim() ? v.text : null;
    case 'number':
      return v.number === null ? null : new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(v.number);
    case 'date':
      return v.date ? dateText(v.date) : null;
    case 'single_select':
    case 'multi_select': {
      const names = (v.optionIds ?? []).map((id) => def.options.find((o) => o.id === id)?.label).filter((x): x is string => typeof x === 'string');
      return names.length > 0 ? names.join(', ') : null;
    }
  }
}

/** The sheet's draft of one field: what its input holds. */
type Draft = string | string[];

function draftOf(def: FieldDefView, v: FieldValueView | undefined): Draft {
  switch (def.fieldType) {
    case 'text':
      return v?.text ?? '';
    case 'number':
      return v?.number === null || v?.number === undefined ? '' : String(v.number);
    case 'date':
      return v?.date ? v.date.slice(0, 10) : '';
    case 'single_select':
      return v?.optionIds?.[0] ?? '';
    case 'multi_select':
      return v?.optionIds ?? [];
  }
}

/** The PUT body's value for a draft (module 60: text, a number, YYYY-MM-DD, an option id or ids; empty clears). */
export function valueOfDraft(def: Pick<FieldDefView, 'fieldType'>, d: Draft): string | number | string[] | null {
  if (Array.isArray(d)) return d;
  const t = d.trim();
  if (t === '') return null;
  if (def.fieldType === 'number') {
    const n = Number(t.replace(/,/g, ''));
    return Number.isFinite(n) ? n : t; // anything else is the server's to refuse, with its reason
  }
  return t;
}

const same = (a: Draft, b: Draft) => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x) => b.includes(x)) : a === b);

function FieldInput({ def, value, onChange }: { def: FieldDefView; value: Draft; onChange(d: Draft): void }) {
  const id = useId();
  const live = def.options.filter((o) => !o.archived || (Array.isArray(value) ? value.includes(o.id) : value === o.id));
  switch (def.fieldType) {
    case 'text':
      return <TextField label={def.label} value={value as string} maxLength={1000} onChange={(e) => onChange(e.target.value)} />;
    case 'number':
      return <TextField label={def.label} value={value as string} inputMode="decimal" onChange={(e) => onChange(e.target.value)} />;
    case 'date':
      return (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={id} className="text-[15px] font-medium text-ink">
            {def.label}
          </label>
          <input id={id} type="date" value={value as string} onChange={(e) => onChange(e.target.value)} className={selectClass} />
        </div>
      );
    case 'single_select':
      return (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={id} className="text-[15px] font-medium text-ink">
            {def.label}
          </label>
          <select id={id} value={value as string} onChange={(e) => onChange(e.target.value)} className={selectClass}>
            <option value="">Not set</option>
            {live.map((o) => (
              <option key={o.id} value={o.id} disabled={o.archived}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      );
    case 'multi_select': {
      const picked = value as string[];
      return (
        <fieldset className="flex flex-col gap-1">
          <legend className="pb-1 text-[15px] font-medium text-ink">{def.label}</legend>
          {live.map((o) => (
            <label key={o.id} className="inline-flex min-h-tap items-center gap-3 text-[16px] text-ink">
              <input type="checkbox" checked={picked.includes(o.id)} disabled={o.archived && !picked.includes(o.id)} onChange={(e) => onChange(e.target.checked ? [...picked, o.id] : picked.filter((x) => x !== o.id))} />
              {o.label}
            </label>
          ))}
        </fieldset>
      );
    }
  }
}

function EditFieldsSheet({ contactId, name, defs, values, onClose }: { contactId: string; name: string; defs: FieldDefView[]; values: FieldValueView[]; onClose(): void }) {
  const byField = new Map(values.map((v) => [v.fieldId, v]));
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => Object.fromEntries(defs.map((d) => [d.id, draftOf(d, byField.get(d.id))])));
  const [problem, setProblem] = useState<string | null>(null);
  const put = useMutate<{ value: string | number | string[] | null }, unknown>('PUT', { invalidate: [contactFieldsKey(contactId), [...PEOPLE_KEY]] });
  const save = async () => {
    setProblem(null);
    for (const d of defs) {
      const draft = drafts[d.id]!;
      if (same(draft, draftOf(d, byField.get(d.id)))) continue;
      const r = await put.run(`/contacts/${contactId}/fields/${d.id}`, { value: valueOfDraft(d, draft) });
      if (!r.ok) return setProblem(`${d.label}: ${messageFor(r.code, LISTS_ERROR_MESSAGES)}`);
    }
    onClose();
  };
  return (
    <Dialog
      title={`Fields for ${name}`}
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-2">
          <Button block onClick={() => void save()} pending={put.pending}>
            Save
          </Button>
          <Button block variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {defs.map((d) => (
          <FieldInput key={d.id} def={d} value={drafts[d.id]!} onChange={(v) => setDrafts((x) => ({ ...x, [d.id]: v }))} />
        ))}
        {problem ? <Notice tone="error">{problem}</Notice> : null}
      </div>
    </Dialog>
  );
}

export function ContactFields({ contactId, name, canEdit }: { contactId: string; name: string; canEdit: boolean }) {
  const defs = useFields();
  const values = useContactFields(contactId);
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  if (defs.isError || values.isError) return <Notice tone="error">{messageFor((defs.error ?? values.error)!, LISTS_ERROR_MESSAGES)}</Notice>;
  if (!defs.data || !values.data) return null;
  const live = [...defs.data.fields].filter((d) => !d.archived).sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));
  // a team without custom fields shows nothing here
  if (live.length === 0) return null;
  const byField = new Map(values.data.values.map((v) => [v.fieldId, v]));
  const shown = live.flatMap((d) => {
    const text = fieldValueText(d, byField.get(d.id));
    return text === null ? [] : [{ def: d, text }];
  });
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-[15px] font-semibold text-ink">Fields</h3>
      {shown.length === 0 ? <p className="text-[15px] text-ink-muted">No field values yet.</p> : null}
      {shown.length > 0 ? (
        <dl className="flex flex-col gap-1">
          {shown.map(({ def, text }) => (
            <div key={def.id} className="flex flex-wrap gap-x-3 text-[15px]">
              <dt className="min-w-[8rem] text-ink-muted">{def.label}</dt>
              <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{text}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {canEdit ? (
        <div>
          <Button variant="secondary" onClick={() => setEditing(true)} aria-label={`Edit fields of ${name}`}>
            Edit fields
          </Button>
        </div>
      ) : null}
      {editing ? (
        <EditFieldsSheet
          contactId={contactId}
          name={name}
          defs={live}
          values={values.data.values}
          onClose={() => {
            setEditing(false);
            void qc.invalidateQueries({ queryKey: contactFieldsKey(contactId) });
          }}
        />
      ) : null}
    </div>
  );
}

/** The registry entry (contact/sections.ts, Details slot): editable only for people who may edit the person. */
export function ContactFieldsSection({ contact }: { contact: ContactFullView }) {
  const d = useDetails(contact.id);
  return <ContactFields contactId={contact.id} name={contact.displayName} canEdit={d.data?.details.canEdit === true} />;
}
