// The person-page sections module 58 adds through contact/sections.ts (PARITY_PLAN §5):
// - the stage pill under the name, and on a phone the working bar Call · Text · Log · Next · Note (PhoneBar.tsx;
//   Note → Save = 2 taps, Log → outcome → one button = 3 taps); on desktop an always-visible note box (type → ⌘↵ = 1)
//   and a Log button. Text (the bar's, and the pill's "Reach them first: Text") opens the page's one text sheet;
// - buyer or seller and texting permission as their own chips beside the stage (R-STG-1);
// - Notes, Details and "What happens next" (R-STG-4: the next task with Add follow-up / Add appointment, the
//   automated playbook's status, and AI follow-up).
import { type ReactNode, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Dialog, Notice } from '../../design/index.js';
import type { ContactFullView } from '../feed/lib/types.js';
import { useAgentSheets } from '../feed/lib/AgentSheets.js';
import { LogSheet } from '../notes/LogSheet.js';
import { NoteComposer } from '../notes/NoteComposer.js';
import { NotesList } from '../notes/NotesSection.js';
import { useDetails } from './api.js';
import { DetailsSection } from './DetailsSection.js';
import { NextPanel, PersonChips } from './NextPanel.js';
import { PhoneBar, usePhoneBarRef } from './PhoneBar.js';
import { AppointmentDialog, TaskDialog } from './PlanSection.js';
import { StagePill } from './StagePill.js';
import { useTextSheet } from './TextSheet.js';
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

export { PERSON_BAR_VAR } from './PhoneBar.js';

function Inner({ contact }: { contact: ContactFullView }) {
  const d = useDetails(contact.id);
  const desktop = useIsDesktop();
  const navigate = useNavigate();
  const { call } = useAgentSheets();
  const [sheet, setSheet] = useState<'note' | 'log' | 'task' | 'appointment' | null>(null);
  // M3: the page's one text sheet (TextSheet.tsx), shared with the header's Text button; nothing here navigates to text
  const text = useTextSheet();
  // b13 review F3-ui: the AI care bar (aiCare/Person.tsx) stacks above the phone bar by its height (PERSON_BAR_VAR)
  const barRef = usePhoneBarRef();
  if (d.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  if (d.isError) return <Notice tone="error">{d.error.message}</Notice>;
  const details = d.data.details;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <StagePill contactId={contact.id} name={contact.displayName} details={details} onCall={() => call({ id: contact.id, name: contact.displayName })} onText={text.open} onReplyChat={() => navigate(`/contacts/${contact.id}/thread?compose=web_chat`)} />
        <PersonChips contact={contact} />
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

      <NextPanel contact={contact} onAddTask={() => setSheet('task')} onAddAppointment={() => setSheet('appointment')} />

      {/* the page's end clears the phone bar: a spacer at the end of <main>, not mid-page */}
      {!desktop && typeof document !== 'undefined' && document.querySelector('main') ? createPortal(<div aria-hidden="true" data-sticky-spacer className="h-16" />, document.querySelector('main')!) : null}
      {!desktop ? (
        <PhoneBar
          contact={contact}
          barRef={barRef}
          onCall={() => call({ id: contact.id, name: contact.displayName })}
          onText={text.open}
          onLog={() => setSheet('log')}
          onNext={() => setSheet('task')}
          onNote={() => setSheet('note')}
        />
      ) : null}
      {sheet === 'note' ? (
        <Dialog title={`Note on ${contact.displayName}`} onClose={() => setSheet(null)} footer={<Button block variant="secondary" onClick={() => setSheet(null)}>Close</Button>}>
          <NoteComposer contactId={contact.id} contactName={contact.displayName} canShare={details.canManageCollaborators} autoFocus onSaved={() => setSheet(null)} />
        </Dialog>
      ) : null}
      {sheet === 'task' ? <TaskDialog contactId={contact.id} name={contact.displayName} onClose={() => setSheet(null)} /> : null}
      {sheet === 'appointment' ? <AppointmentDialog contactId={contact.id} name={contact.displayName} onClose={() => setSheet(null)} /> : null}
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
