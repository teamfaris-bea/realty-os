// The tag picker sheet: type to filter the catalog, tap a tag, or create the typed one (members other
// than TCs create tags by typing, R-PAR-9). Shared by a person's tags (add) and the bulk bar (Tag).
import { useMemo, useState } from 'react';
import { Button, Dialog, Icon, TextField } from '../../design/index.js';
import { type TagView, chipClass, useTags } from './api.js';

/** Case- and width-insensitive key, the same rule as the server's tags.name_key (R-PAR-6, E165). */
export function tagKey(s: string): string {
  return s.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

export function TagPicker({ title, onPick, onCreate, onClose, exclude = [], allowCreate }: {
  title: string;
  onPick: (t: TagView) => void;
  /** creating by typing (absent: the picker only picks existing tags) */
  onCreate?: (name: string) => void;
  onClose: () => void;
  exclude?: readonly string[];
  allowCreate: boolean;
}) {
  const tags = useTags();
  const [q, setQ] = useState('');
  const key = tagKey(q);
  const list = useMemo(() => (tags.data?.tags ?? []).filter((t) => !exclude.includes(t.id) && (key === '' || tagKey(t.name).includes(key))).slice(0, 30), [tags.data, exclude, key]);
  const exact = (tags.data?.tags ?? []).find((t) => tagKey(t.name) === key);
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (exact) onPick(exact);
          else if (key && allowCreate && onCreate) onCreate(q.trim());
        }}
      >
        <TextField label="Tag" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type to find or create" autoComplete="off" />
        <ul className="flex max-h-[45vh] flex-wrap gap-2 overflow-y-auto" aria-label="Tags">
          {list.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => onPick(t)} className={`inline-flex min-h-tap items-center gap-1 rounded-full px-4 text-[15px] font-medium ${chipClass(t.color)}`}>
                {t.protected ? <Icon name="block" size={16} label="Protected" /> : null}
                {t.name}
              </button>
            </li>
          ))}
        </ul>
        {key && !exact && allowCreate && onCreate ? (
          <Button type="submit" variant="secondary" icon="check">
            Create "{q.trim()}"
          </Button>
        ) : null}
        {tags.isSuccess && list.length === 0 && !(key && allowCreate) ? <p className="text-[15px] text-ink-muted">No tags match.</p> : null}
      </form>
    </Dialog>
  );
}
