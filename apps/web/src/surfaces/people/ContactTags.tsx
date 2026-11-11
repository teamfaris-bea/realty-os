// A person's tags (R-PAR-6..8): chips under the name, "+" to add (2 taps: + → tag; typing creates),
// a chip's × to remove (VoiceOver: "Tag Buyer, remove"), and a tap on the chip opens everyone with
// that tag (1 tap). Registered on the contact page through module 58's section registry
// (surfaces/contact/sections.ts) as `ContactTagsSection`.
//
// R-PAR-7 / E167: a tag never stops messages. Adding one that reads like an opt-out ("DNC") saves the
// tag, says so plainly, and offers the real person-level do-not-contact in one tap: module 57's
// POST /contacts/:id/do-not-contact (the R-CHAN-3 path), shown only to people allowed to record it
// (contact.edit, the same right that added the tag). It only tightens: there is no Undo, and removing
// the tag later lifts nothing.
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Icon, Notice } from '../../design/index.js';
import { messageFor, useSession } from '../../shell/index.js';
import { useMutate } from '../feed/lib/hooks.js';
import type { ContactFullView } from '../feed/lib/types.js';
import { useDetails } from '../people-edit/api.js';
import { usePersonAction } from '../people-edit/hooks.js';
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
  const [recorded, setRecorded] = useState<{ alreadySet: boolean } | null>(null);
  const add = useMutate<{ tagIds?: string[]; names?: string[] }, { tags: ContactTagView[]; optOutLike: string[] }>('POST', { invalidate: [['lists', 'contact-tags', contactId], [...PEOPLE_KEY], ['lists', 'tags']] });
  const remove = useMutate<undefined, { tags: ContactTagView[] }>('DELETE', { invalidate: [['lists', 'contact-tags', contactId], [...PEOPLE_KEY]] });
  const dnc = usePersonAction<{ doNotContact: true; alreadySet: boolean; revokedPoints: number }>(contactId);
  const first = contactName.split(' ')[0] ?? contactName;

  const after = (r: Awaited<ReturnType<typeof add.run>>) => {
    if (!r.ok) return;
    qc.setQueryData(['lists', 'contact-tags', contactId], { tags: r.data.tags });
    const flagged = r.data.tags.find((t) => r.data.optOutLike.includes(t.id));
    setOptOut(flagged ? flagged.name : null);
    setRecorded(null);
  };

  const recordDoNotContact = async () => {
    const r = await dnc.run('POST', `/contacts/${contactId}/do-not-contact`, { reason: 'other' });
    if (r.ok) setRecorded({ alreadySet: r.data.alreadySet });
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
      {optOut && recorded ? (
        <Notice tone="ok" title={recorded.alreadySet ? `${first} was already marked do not contact` : `Recorded: do not contact ${first}`}>
          Nobody on the team can text, email or call {first}. Only {first} can undo it.
        </Notice>
      ) : optOut ? (
        <Notice tone="warn" title="Tags don't stop messages">
          <div className="flex flex-col gap-2">
            <p>
              "{optOut}" is saved as a tag only. Record "do not contact" for {first}?
            </p>
            {canEdit ? (
              <>
                <p className="text-[14px] text-ink-muted">It stops every text, email and call to {first} from anyone on the team. Only {first} can undo it.</p>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => void recordDoNotContact()} pending={dnc.pending} pendingLabel="Recording">
                    Record do not contact
                  </Button>
                  <Button variant="secondary" onClick={() => setOptOut(null)} disabled={dnc.pending}>
                    Not now
                  </Button>
                </div>
              </>
            ) : null}
            {dnc.error ? <p className="text-[14px] font-medium text-danger">{dnc.error}</p> : null}
          </div>
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

/**
 * The contact page's Tags section (module 58's registry, surfaces/contact/sections.ts): the chips of the
 * full contact view, editable (and the do-not-contact offer) only when the person's details say the viewer
 * may edit this person (contact.edit, decided by the server: module 57's GET /contacts/:id/details).
 */
export function ContactTagsSection({ contact }: { contact: ContactFullView }) {
  const d = useDetails(contact.id);
  return <ContactTags contactId={contact.id} contactName={contact.displayName} editable={d.data?.details.canEdit === true} />;
}
