// Admin → Tags (R-PAR-6, R-PAR-8, R-PAR-9): the team's tag catalog with how many people carry each
// tag, and the Owner/Admin catalog commands: rename, color, fair-housing protection (only the Owner
// lifts it), merge into another tag, delete. Every change is audited by the server.
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Dialog, EmptyState, Icon, Notice, TextField } from '../../../design/index.js';
import { messageFor, useSession } from '../../../shell/index.js';
import { useMutate } from '../../feed/lib/hooks.js';
import { AgentSheetsProvider, useAgentSheets } from '../../feed/lib/AgentSheets.js';
import { TAGS_KEY, TAG_COLORS, type TagColor, type TagView, chipClass, useTags } from '../../people/api.js';
import { LISTS_ERROR_MESSAGES } from '../../people/messages.js';

export default function TagsPage() {
  return (
    <AgentSheetsProvider>
      <Tags />
    </AgentSheetsProvider>
  );
}

type Open = { kind: 'edit' | 'merge' | 'delete'; tag: TagView } | null;

function Tags() {
  const q = useTags();
  const [open, setOpen] = useState<Open>(null);
  const [filter, setFilter] = useState('');
  const tags = (q.data?.tags ?? []).filter((t) => filter === '' || t.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[15px] text-ink-muted">
        Anyone on the team except a TC can create a tag by typing it on a person. Protected tags (fair-housing stand-ins) are never used for bulk actions or as the audience of a bulk send. {q.data ? `${q.data.tags.length} of 1,000 tags.` : ''}
      </p>
      <TextField label="Find a tag" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, LISTS_ERROR_MESSAGES)}</Notice> : null}
      {q.isSuccess && q.data.tags.length === 0 ? <EmptyState icon="info" title="No tags yet">Tags appear here when someone tags a person.</EmptyState> : null}
      <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
        {tags.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className={`inline-flex min-h-tap items-center gap-1 rounded-full px-4 text-[15px] font-medium ${chipClass(t.color)}`}>
              {t.protected ? <Icon name="block" size={16} label="Protected" /> : null}
              {t.name}
            </span>
            <span className="mr-auto text-[14px] text-ink-muted">
              {t.usage === null ? '' : `${t.usage.toLocaleString('en-US')} ${t.usage === 1 ? 'person' : 'people'}`}
              {t.protected ? ' · protected' : ''}
            </span>
            <Button variant="secondary" onClick={() => setOpen({ kind: 'edit', tag: t })} aria-label={`Edit ${t.name}`}>
              Edit
            </Button>
            <Button variant="secondary" onClick={() => setOpen({ kind: 'merge', tag: t })} aria-label={`Merge ${t.name}`}>
              Merge
            </Button>
            <Button variant="quiet" onClick={() => setOpen({ kind: 'delete', tag: t })} aria-label={`Delete ${t.name}`}>
              Delete
            </Button>
          </li>
        ))}
      </ul>
      {open?.kind === 'edit' ? <EditSheet tag={open.tag} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'merge' ? <MergeSheet tag={open.tag} all={q.data?.tags ?? []} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'delete' ? <DeleteSheet tag={open.tag} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function useTagMutation(method: 'PATCH' | 'POST' | 'DELETE') {
  return useMutate<unknown, unknown>(method, { invalidate: [[...TAGS_KEY], ['people']] });
}

function EditSheet({ tag, onClose }: { tag: TagView; onClose: () => void }) {
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState<TagColor | null>(tag.color);
  const [prot, setProt] = useState(tag.protected);
  const { session } = useSession();
  const owner = session?.tenant?.role === 'owner';
  const patch = useTagMutation('PATCH');
  const protect = useTagMutation('POST');
  const sheets = useAgentSheets();
  const qc = useQueryClient();
  const err = patch.error ?? protect.error;
  return (
    <Dialog
      title={`Edit "${tag.name}"`}
      onClose={onClose}
      footer={
        <Button
          disabled={patch.pending || protect.pending}
          onClick={async () => {
            if (name.trim() !== tag.name || color !== tag.color) {
              const r = await patch.run(`/tags/${tag.id}`, { ...(name.trim() !== tag.name ? { name } : {}), ...(color !== tag.color ? { color } : {}) });
              if (!r.ok) return;
            }
            if (prot !== tag.protected) {
              const r = await protect.run(`/tags/${tag.id}/protect`, { protected: prot });
              if (!r.ok) return;
            }
            await qc.invalidateQueries({ queryKey: [...TAGS_KEY] });
            sheets.announce('Tag saved');
            onClose();
          }}
        >
          Save
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        <fieldset>
          <legend className="pb-1 text-[15px] font-medium text-ink">Color</legend>
          <div className="flex flex-wrap gap-2">
            {[null, ...TAG_COLORS].map((c) => (
              <label key={c ?? 'none'} className={`inline-flex min-h-tap min-w-tap cursor-pointer items-center justify-center rounded-full border px-3 text-[14px] ${chipClass(c)} ${color === c ? 'border-accent ring-2 ring-accent' : 'border-line'}`}>
                <input type="radio" name="color" className="sr-only" checked={color === c} onChange={() => setColor(c)} />
                {c ?? 'none'}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="inline-flex min-h-tap items-center gap-3 text-[15px] text-ink">
          <input type="checkbox" checked={prot} onChange={(e) => setProt(e.target.checked)} disabled={tag.protected && !owner} />
          Fair-housing protected (never a bulk action or bulk audience)
        </label>
        {tag.protected && !owner ? <p className="text-[14px] text-ink-muted">Only the Owner can lift a protection.</p> : null}
        {err ? <Notice tone="error">{messageFor(err.code, LISTS_ERROR_MESSAGES)}</Notice> : null}
      </div>
    </Dialog>
  );
}

function MergeSheet({ tag, all, onClose }: { tag: TagView; all: TagView[]; onClose: () => void }) {
  const [into, setInto] = useState<string>('');
  const merge = useTagMutation('POST');
  const sheets = useAgentSheets();
  const qc = useQueryClient();
  const target = all.find((t) => t.id === into);
  return (
    <Dialog
      title={`Merge "${tag.name}"`}
      description={`Everyone tagged "${tag.name}" gets the tag you pick, lists that use "${tag.name}" switch to it, and "${tag.name}" is deleted.`}
      onClose={onClose}
      footer={
        <Button
          variant="danger"
          disabled={!target || merge.pending}
          onClick={async () => {
            const r = await merge.run(`/tags/${tag.id}/merge`, { intoTagId: into });
            if (!r.ok) return;
            const d = r.data as { moved: number; listsRewritten: number };
            await qc.invalidateQueries({ queryKey: [...TAGS_KEY] });
            sheets.announce(`Merged into "${target!.name}": ${d.moved} ${d.moved === 1 ? 'person' : 'people'}, ${d.listsRewritten} ${d.listsRewritten === 1 ? 'list' : 'lists'} updated`);
            onClose();
          }}
        >
          {target ? `Merge into "${target.name}"` : 'Merge'}
        </Button>
      }
    >
      <label className="flex flex-col gap-1 text-[15px] font-medium text-ink">
        Merge into
        <select className="min-h-tap rounded-lg border border-line bg-surface px-3 text-[16px]" value={into} onChange={(e) => setInto(e.target.value)}>
          <option value="">Pick a tag</option>
          {all
            .filter((t) => t.id !== tag.id)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </select>
      </label>
      {tag.protected && target && !target.protected ? <p className="pt-2 text-[14px] text-ink-muted">"{target.name}" becomes protected too (the stricter protection is kept).</p> : null}
      {merge.error ? <Notice tone="error">{messageFor(merge.error.code, LISTS_ERROR_MESSAGES)}</Notice> : null}
    </Dialog>
  );
}

function DeleteSheet({ tag, onClose }: { tag: TagView; onClose: () => void }) {
  const del = useTagMutation('DELETE');
  const sheets = useAgentSheets();
  const qc = useQueryClient();
  const n = tag.usage ?? 0;
  return (
    <Dialog
      title={`Delete "${tag.name}"?`}
      description={`It comes off ${n.toLocaleString('en-US')} ${n === 1 ? 'person' : 'people'}. Lists that use it will match nobody until you change them.`}
      onClose={onClose}
      footer={
        <Button
          variant="danger"
          disabled={del.pending}
          onClick={async () => {
            const r = await del.run(`/tags/${tag.id}`);
            if (!r.ok) return;
            await qc.invalidateQueries({ queryKey: [...TAGS_KEY] });
            sheets.announce(`Deleted "${tag.name}"`);
            onClose();
          }}
        >
          Delete
        </Button>
      }
    >
      {del.error ? <Notice tone="error">{messageFor(del.error.code, LISTS_ERROR_MESSAGES)}</Notice> : null}
    </Dialog>
  );
}
