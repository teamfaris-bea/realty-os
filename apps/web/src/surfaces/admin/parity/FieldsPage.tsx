// Admin → Custom fields (R-PAR-17, R-PAR-18, R-PAR-20): typed fields (text, number, date, one or
// several choices), at most 50 live; a date can repeat every year (birthdays, home anniversaries) and
// drives "coming up" lists. A field keeps its type; choices are archived, never removed, so values
// keep their meaning. A name that would record a fair-housing protected trait is refused with a
// pointer to the built-in self-reported details.
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Dialog, EmptyState, Notice, TextField } from '../../../design/index.js';
import { messageFor } from '../../../shell/index.js';
import { useMutate } from '../../feed/lib/hooks.js';
import { AgentSheetsProvider, useAgentSheets } from '../../feed/lib/AgentSheets.js';
import { FIELDS_KEY, type FieldDefView, type FieldType, useFields } from '../../people/api.js';
import { LISTS_ERROR_MESSAGES } from '../../people/messages.js';

export const FIELD_TYPE_LABEL: Record<FieldType, string> = { text: 'Text', number: 'Number', date: 'Date', single_select: 'One choice', multi_select: 'Several choices' };

export default function FieldsPage() {
  return (
    <AgentSheetsProvider>
      <Fields />
    </AgentSheetsProvider>
  );
}

function Fields() {
  const [showArchived, setShowArchived] = useState(false);
  const q = useFields({ archived: showArchived });
  const [open, setOpen] = useState<{ kind: 'new' } | { kind: 'edit'; field: FieldDefView } | null>(null);
  const archive = useMutate<{ archived: boolean }, unknown>('POST', { invalidate: [[...FIELDS_KEY]] });
  const sheets = useAgentSheets();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto text-[15px] text-ink-muted">{q.data ? `${q.data.liveCount} of ${q.data.limit} fields in use.` : ''} Values show only to people who can see the person's details.</p>
        <Button onClick={() => setOpen({ kind: 'new' })} disabled={q.data ? q.data.liveCount >= q.data.limit : true}>
          New field
        </Button>
      </div>
      <label className="inline-flex min-h-tap items-center gap-3 self-start text-[15px] text-ink">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        Show archived fields
      </label>
      {q.isError ? <Notice tone="error">{messageFor(q.error, LISTS_ERROR_MESSAGES)}</Notice> : null}
      {archive.error ? <Notice tone="error">{messageFor(archive.error.code, LISTS_ERROR_MESSAGES)}</Notice> : null}
      {q.isSuccess && q.data.fields.length === 0 ? <EmptyState icon="info" title="No custom fields yet">Add fields like Budget, Area or Birthday.</EmptyState> : null}
      <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
        {(q.data?.fields ?? []).map((f) => (
          <li key={f.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <div className="mr-auto min-w-0">
              <p className="text-[17px] font-semibold text-ink">{f.label}</p>
              <p className="text-[14px] text-ink-muted">
                {[FIELD_TYPE_LABEL[f.fieldType], f.annual ? 'every year' : null, f.options.length > 0 ? `${f.options.filter((o) => !o.archived).length} choices` : null, f.archived ? 'archived' : null, f.origin !== 'manual' ? 'from an import' : null].filter(Boolean).join(' · ')}
              </p>
            </div>
            {!f.archived ? (
              <Button variant="secondary" onClick={() => setOpen({ kind: 'edit', field: f })} aria-label={`Edit ${f.label}`}>
                Edit
              </Button>
            ) : null}
            <Button
              variant="quiet"
              aria-label={`${f.archived ? 'Restore' : 'Archive'} ${f.label}`}
              onClick={async () => {
                const r = await archive.run(`/custom-fields/${f.id}/archive`, { archived: !f.archived });
                if (r.ok) sheets.announce(`${f.archived ? 'Restored' : 'Archived'} "${f.label}"`);
              }}
            >
              {f.archived ? 'Restore' : 'Archive'}
            </Button>
          </li>
        ))}
      </ul>
      {open?.kind === 'new' ? <NewFieldSheet onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'edit' ? <EditFieldSheet field={open.field} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

function NewFieldSheet({ onClose }: { onClose: () => void }) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [annual, setAnnual] = useState(false);
  const [options, setOptions] = useState('');
  const create = useMutate<unknown, unknown>('POST', { invalidate: [[...FIELDS_KEY]] });
  const sheets = useAgentSheets();
  const qc = useQueryClient();
  const select = type === 'single_select' || type === 'multi_select';
  return (
    <Dialog
      title="New field"
      onClose={onClose}
      footer={
        <Button
          disabled={create.pending || label.trim() === '' || (select && lines(options).length === 0)}
          onClick={async () => {
            const r = await create.run('/custom-fields', { label, fieldType: type, ...(type === 'date' ? { annual } : {}), ...(select ? { options: lines(options).map((l) => ({ label: l })) } : {}) });
            if (!r.ok) return;
            await qc.invalidateQueries({ queryKey: [...FIELDS_KEY] });
            sheets.announce(`Added "${label.trim()}"`);
            onClose();
          }}
        >
          Add field
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <TextField label="Name" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
        <label className="flex flex-col gap-1 text-[15px] font-medium text-ink">
          Type
          <select className="min-h-tap rounded-lg border border-line bg-surface px-3 text-[16px]" value={type} onChange={(e) => setType(e.target.value as FieldType)}>
            {(Object.keys(FIELD_TYPE_LABEL) as FieldType[]).map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        {type === 'date' ? (
          <label className="inline-flex min-h-tap items-center gap-3 text-[15px] text-ink">
            <input type="checkbox" checked={annual} onChange={(e) => setAnnual(e.target.checked)} />
            Repeats every year (birthday, home anniversary)
          </label>
        ) : null}
        {select ? (
          <label className="flex flex-col gap-1 text-[15px] font-medium text-ink">
            Choices, one per line
            <textarea className="min-h-32 rounded-lg border border-line bg-surface px-3 py-2 text-[16px]" value={options} onChange={(e) => setOptions(e.target.value)} />
          </label>
        ) : null}
        <p className="text-[14px] text-ink-muted">A field keeps its type. Fair-housing protected traits (military status, religion, familial status, …) cannot be custom fields; record them as the client's own self-reported details instead.</p>
        {create.error ? <Notice tone="error">{messageFor(create.error.code, LISTS_ERROR_MESSAGES)}</Notice> : null}
      </div>
    </Dialog>
  );
}

function EditFieldSheet({ field, onClose }: { field: FieldDefView; onClose: () => void }) {
  const [label, setLabel] = useState(field.label);
  const [names, setNames] = useState<Record<string, string>>(Object.fromEntries(field.options.map((o) => [o.id, o.label])));
  const [archived, setArchived] = useState<Set<string>>(new Set(field.options.filter((o) => o.archived).map((o) => o.id)));
  const [added, setAdded] = useState('');
  const patch = useMutate<unknown, unknown>('PATCH', { invalidate: [[...FIELDS_KEY]] });
  const sheets = useAgentSheets();
  const select = field.fieldType === 'single_select' || field.fieldType === 'multi_select';
  return (
    <Dialog
      title={`Edit "${field.label}"`}
      description={`${FIELD_TYPE_LABEL[field.fieldType]}${field.annual ? ', every year' : ''}. The type never changes.`}
      onClose={onClose}
      footer={
        <Button
          disabled={patch.pending || label.trim() === ''}
          onClick={async () => {
            const renameOptions = Object.fromEntries(field.options.filter((o) => names[o.id] !== o.label).map((o) => [o.id, names[o.id]!]));
            const archiveOptions = field.options.filter((o) => !o.archived && archived.has(o.id)).map((o) => o.id);
            const unarchiveOptions = field.options.filter((o) => o.archived && !archived.has(o.id)).map((o) => o.id);
            const body = {
              ...(label !== field.label ? { label } : {}),
              ...(select && Object.keys(renameOptions).length ? { renameOptions } : {}),
              ...(select && archiveOptions.length ? { archiveOptions } : {}),
              ...(select && unarchiveOptions.length ? { unarchiveOptions } : {}),
              ...(select && lines(added).length ? { addOptions: lines(added).map((l) => ({ label: l })) } : {}),
            };
            const r = await patch.run(`/custom-fields/${field.id}`, body);
            if (!r.ok) return;
            sheets.announce(`Saved "${label.trim()}"`);
            onClose();
          }}
        >
          Save
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <TextField label="Name" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
        {select ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="pb-1 text-[15px] font-medium text-ink">Choices (renaming keeps every value)</legend>
            {field.options.map((o) => (
              <div key={o.id} className="flex items-end gap-2">
                <TextField className="flex-1" label={`Choice ${o.label}`} value={names[o.id] ?? ''} onChange={(e) => setNames({ ...names, [o.id]: e.target.value })} maxLength={60} />
                <label className="inline-flex min-h-tap items-center gap-2 text-[14px] text-ink">
                  <input
                    type="checkbox"
                    checked={archived.has(o.id)}
                    onChange={(e) => {
                      const s = new Set(archived);
                      if (e.target.checked) s.add(o.id);
                      else s.delete(o.id);
                      setArchived(s);
                    }}
                  />
                  Archived
                </label>
              </div>
            ))}
            <label className="flex flex-col gap-1 text-[15px] font-medium text-ink">
              New choices, one per line
              <textarea className="min-h-20 rounded-lg border border-line bg-surface px-3 py-2 text-[16px]" value={added} onChange={(e) => setAdded(e.target.value)} />
            </label>
          </fieldset>
        ) : null}
        {patch.error ? <Notice tone="error">{messageFor(patch.error.code, LISTS_ERROR_MESSAGES)}</Notice> : null}
      </div>
    </Dialog>
  );
}
