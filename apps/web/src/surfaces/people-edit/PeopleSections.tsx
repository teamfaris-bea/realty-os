// The person-page sections module 58 adds through contact/sections.ts (PARITY_PLAN §5):
// - the stage pill under the name, and on a phone a sticky Note · Log bar (Note → Save = 2 taps, Log →
//   outcome → Save = 3 taps); on desktop an always-visible note box (type → ⌘↵ = 1) and a Log button;
// - Notes, Details and Plan (add task / appointment).
import { type ReactNode, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Dialog, Notice, useStickyBottom } from '../../design/index.js';
import type { ContactFullView } from '../feed/lib/types.js';
import { useAgentSheets } from '../feed/lib/AgentSheets.js';
import { LogSheet } from '../notes/LogSheet.js';
import { NoteComposer } from '../notes/NoteComposer.js';
import { NotesList } from '../notes/NotesSection.js';
import { useDetails } from './api.js';
import { DetailsSection } from './DetailsSection.js';
import { PlanSection } from './PlanSection.js';
import { StagePill } from './StagePill.js';
import { ToastProvider, useIsDesktop } from './hooks.js';

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  const hid = useId();
  return (
    <section aria-labelledby={hid} className="flex scroll-mt-20 flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 id={hid} className="flex-1 text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Inner({ contact }: { contact: ContactFullView }) {
  const d = useDetails(contact.id);
  const desktop = useIsDesktop();
  const navigate = useNavigate();
  const { call } = useAgentSheets();
  const [sheet, setSheet] = useState<'note' | 'log' | null>(null);
  const stickyRef = useStickyBottom<HTMLDivElement>();
  if (d.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  if (d.isError) return <Notice tone="error">{d.error.message}</Notice>;
  const details = d.data.details;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <StagePill contactId={contact.id} name={contact.displayName} details={details} onCall={() => call({ id: contact.id, name: contact.displayName })} onText={() => navigate(`/contacts/${contact.id}/thread?compose=sms`)} onReplyChat={() => navigate(`/contacts/${contact.id}/thread?compose=web_chat`)} />
        {desktop ? (
          <Button variant="secondary" onClick={() => setSheet('log')}>
            Log
          </Button>
        ) : null}
      </div>

      <Section title="Notes">
        {desktop ? (
          <Card>
            <NoteComposer contactId={contact.id} contactName={contact.displayName} canShare={details.canManageCollaborators} compact />
          </Card>
        ) : null}
        <NotesList contactId={contact.id} firstName={contact.displayName.split(' ')[0] ?? contact.displayName} />
      </Section>

      <Section title="Details">
        <DetailsSection contact={contact} details={details} />
      </Section>

      <Section title="Plan">
        <PlanSection contactId={contact.id} name={contact.displayName} />
      </Section>

      {/* the page's end clears the sticky Note · Log bar: a spacer at the end of <main>, not mid-page */}
      {!desktop && typeof document !== 'undefined' && document.querySelector('main') ? createPortal(<div aria-hidden="true" className="h-16" />, document.querySelector('main')!) : null}
      {!desktop ? (
        <div ref={stickyRef} data-sticky className="fixed inset-x-0 bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))] z-20 border-t border-line bg-surface/95 px-4 py-2 backdrop-blur md:hidden">
          <div className="mx-auto grid max-w-2xl grid-cols-2 gap-2">
            <Button onClick={() => setSheet('note')}>Note</Button>
            <Button variant="secondary" onClick={() => setSheet('log')}>
              Log
            </Button>
          </div>
        </div>
      ) : null}
      {sheet === 'note' ? (
        <Dialog title={`Note on ${contact.displayName}`} onClose={() => setSheet(null)} footer={<Button block variant="secondary" onClick={() => setSheet(null)}>Close</Button>}>
          <NoteComposer contactId={contact.id} contactName={contact.displayName} canShare={details.canManageCollaborators} autoFocus onSaved={() => setSheet(null)} />
        </Dialog>
      ) : null}
      {sheet === 'log' ? <LogSheet contactId={contact.id} contactName={contact.displayName} onClose={() => setSheet(null)} /> : null}
    </div>
  );
}

export function PeopleSections({ contact }: { contact: ContactFullView }) {
  return (
    <ToastProvider>
      <Inner contact={contact} />
    </ToastProvider>
  );
}
