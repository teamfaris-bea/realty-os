// A person's tags (R-PAR-6..8): chips under the name, "+" to add (2 taps: + → tag; typing creates),
// a chip's × to remove (VoiceOver: "Tag Buyer, remove"), and a tap on the chip opens everyone with
// that tag (1 tap). Exported for the contact page's section registry (module 58 owns
// surfaces/contact/sections.ts; module 61 adds one entry there).
//
// R-PAR-7 / E167: a tag never stops messages. Adding one that reads like an opt-out ("DNC") saves the
// tag and says so plainly, pointing at the real person-level do-not-contact.
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, Notice } from '../../design/index.js';
import { messageFor, useSession } from '../../shell/index.js';
import { useMutate } from '../feed/lib/hooks.js';
import { type ContactTagView, PEOPLE_KEY, chipClass, tagSource, useContactTags } from './api.js';
import { LISTS_ERROR_MESSAGES } from './messages.js';
import { TagPicker } from './TagPicker.js';
import { startWork } from './workList.js';

export function ContactTags({ contactId, contactName, editable = true }: { contactId: string; contactName: string; editable?: boolean }) {
  const q = useContactTags(contactId);
  const qc = useQueryClient();
  const nav = useNavigate();
  const { session } = useSession();
  const canEdit = editable && session?.tenant?.role !== 'tc';
  const [picking, setPicking] = useState(false);
  const [optOut, setOptOut] = useState<string | null>(null);
  const add = useMutate<{ tagIds?: string[]; names?: string[] }, { tags: ContactTagView[]; optOutLike: string[] }>('POST', { invalidate: [['lists', 'contact-tags', contactId], [...PEOPLE_KEY], ['lists', 'tags']] });
  const remove = useMutate<undefined, { tags: ContactTagView[] }>('DELETE', { invalidate: [['lists', 'contact-tags', contactId], [...PEOPLE_KEY]] });
  const first = contactName.split(' ')[0] ?? contactName;

  const after = (r: Awaited<ReturnType<typeof add.run>>) => {
    if (!r.ok) return;
    qc.setQueryData(['lists', 'contact-tags', contactId], { tags: r.data.tags });
    const flagged = r.data.tags.find((t) => r.data.optOutLike.includes(t.id));
    setOptOut(flagged ? flagged.name : null);
  };

  if (q.isError) return null; // card view or no access: tags are detail-only (R-PAR-7)
  const tags = q.data?.tags ?? [];
  return (
    <section aria-label="Tags" className="flex flex-col gap-2">
      <ul className="flex flex-wrap items-center gap-2">
        {tags.map((t) => (
          <li key={t.id} className={`inline-flex min-h-tap items-center rounded-full ${chipClass(t.color)}`}>
            <button
              type="button"
              className="inline-flex min-h-tap items-center gap-1 rounded-l-full pl-4 pr-2 text-[15px] font-medium"
              aria-label={`Tag ${t.name}, show everyone with it`}
              onClick={() => {
                startWork(tagSource(t), []);
                nav(`/people?tag=${encodeURIComponent(t.id)}&name=${encodeURIComponent(t.name)}`);
              }}
            >
              {t.protected ? <Icon name="block" size={16} label="Protected" /> : null}
              {t.name}
            </button>
            {canEdit ? (
              <button type="button" className="inline-flex min-h-tap min-w-tap items-center justify-center rounded-r-full" aria-label={`Tag ${t.name}, remove`} disabled={remove.pending} onClick={() => void remove.run(`/contacts/${contactId}/tags/${t.id}`)}>
                <span aria-hidden="true" className="text-[20px] leading-none">×</span>
              </button>
            ) : null}
          </li>
        ))}
        {canEdit ? (
          <li>
            <button type="button" className="inline-flex min-h-tap min-w-tap items-center justify-center rounded-full border border-line px-3 text-[15px] font-medium text-ink" aria-label="Add a tag" onClick={() => setPicking(true)}>
              + Tag
            </button>
          </li>
        ) : null}
      </ul>
      {optOut ? (
        <Notice tone="warn" title="Tags don't stop messages">
          "{optOut}" is saved as a tag only. To stop all messages and calls to {first}, record "Do not contact" on {first}'s page.
        </Notice>
      ) : null}
      {add.error ? <Notice tone="error">{messageFor(add.error.code, LISTS_ERROR_MESSAGES)}</Notice> : null}
      {picking ? (
        <TagPicker
          title={`Tag ${first}`}
          exclude={tags.map((t) => t.id)}
          allowCreate={canEdit}
          onClose={() => setPicking(false)}
          onPick={(t) => {
            setPicking(false);
            void add.run(`/contacts/${contactId}/tags`, { tagIds: [t.id] }).then(after);
          }}
          onCreate={(name) => {
            setPicking(false);
            void add.run(`/contacts/${contactId}/tags`, { names: [name] }).then(after);
          }}
        />
      ) : null}
    </section>
  );
}
