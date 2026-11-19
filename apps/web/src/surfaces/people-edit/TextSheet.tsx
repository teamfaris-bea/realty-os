// Text from the person's page without leaving it (owner brief 2026-11-19: "Don't make an agent bounce between
// screens"). The sheet holds the existing compose box, unchanged: the same reachability reasons, the same send-time
// check on the server, the same outcome words. Nothing here can text past an opt-out.
//
// ONE sheet for the page's three ways to text (b19 fix pass M3, E777): the phone bar's Text, the header's Text button
// and the stage pill's "Reach them first: Text", on a phone and on desktop. TextSheetProvider wraps the person's page
// (contact/ContactPage.tsx) and each of the three calls useTextSheet().open; none of them navigates. The full
// conversation stays one visible link away ("Open the full conversation"), and a reply the assistant has ready for
// this person is offered in the box exactly as on the conversation page (Text → prefilled Send = 2 taps).
//
// After a text or email went out, the same sheet shows the stage step. The send route answers no stage suggestion,
// so the step reads the signal ("we sent a text, no reply yet") by core's own table against the person's fresh
// details (StageStep.tsx). A message that is only SCHEDULED or only QUEUED has not been sent: it suggests nothing, and
// the step says when it will go, or that it is being sent (E783). A reply in the website chat suggests nothing either (the table reads texts and emails).
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ButtonLink, Dialog } from '../../design/index.js';
import { useInbox } from '../approvals/ApprovalsPage.js';
import { ComposeBox } from '../compose/ComposeBox.js';
import { sendOutcomeText, sentResult } from '../feed/lib/AgentSheets.js';
import type { ContactFullView } from '../feed/lib/types.js';
import { TemplatePicker } from '../templates/TemplatePicker.js';
import { type OnePassOptions, StageStep, type StageSignal } from './StageStep.js';

/**
 * What a send says about the stage: a text or email the API reports SENT is a try; anything else, nothing. A message
 * that is only queued has not gone out yet (the send-time check and the provider still decide), so it suggests
 * nothing and is never worded as sent (E783): the step says "Sending to Jane." and keeps the stage.
 */
export function signalOfSend(result: string, channel: string): StageSignal | null {
  if (result !== 'sent') return null;
  if (channel === 'sms') return { kind: 'message', channel: 'text', direction: 'outbound' };
  if (channel === 'email') return { kind: 'message', channel: 'email', direction: 'outbound' };
  return null;
}

const Ctx = createContext<{ open(): void } | null>(null);

/**
 * The page's one text sheet. Outside a provider (a section rendered on its own in a test) `open` does nothing: there
 * is no page to hold the sheet.
 */
export function useTextSheet(): { open(): void } {
  return useContext(Ctx) ?? NO_SHEET;
}
const NO_SHEET = { open: () => undefined };

export function TextSheetProvider({ contact, children }: { contact: ContactFullView; children: ReactNode }) {
  const [on, setOn] = useState(false);
  const open = useCallback(() => setOn(true), []);
  const value = useMemo(() => ({ open }), [open]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {on ? <TextSheet contact={contact} onClose={() => setOn(false)} /> : null}
    </Ctx.Provider>
  );
}

export function TextSheet({ contact, onClose, onePass }: { contact: ContactFullView; onClose: () => void; /** R-TODAY-7: opened from Today (StageStep.tsx OnePassOptions) */ onePass?: OnePassOptions | undefined }) {
  const [sent, setSent] = useState<{ saved: string; signal: StageSignal | null } | null>(null);
  // the assistant's reply waiting for this person, offered in the box as the conversation page offers it
  const inbox = useInbox();
  const pendingDraft = inbox.data?.items.find((a) => a.contactId === contact.id && a.status === 'proposed' && a.primaryAction === 'send' && a.draft !== null && a.draft.channel === 'sms')?.id ?? null;
  // The message field takes focus once it is on the page. (The box's own autoFocus runs before the sheet is attached
  // to the document, and the field may not be drawn until the reachability summary is in.) One time only: focus is
  // never pulled back to the field after the agent moved on.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const take = (): boolean => {
      const field = el.querySelector('textarea');
      if (!field) return false;
      field.focus();
      return true;
    };
    if (take() || typeof MutationObserver === 'undefined') return undefined;
    const seen = new MutationObserver(() => {
      if (take()) seen.disconnect();
    });
    seen.observe(el, { childList: true, subtree: true });
    return () => seen.disconnect();
  }, []);
  if (sent) return <StageStep contactId={contact.id} contactName={contact.displayName} saved={sent.saved} signal={sent.signal} onClose={onClose} onePass={onePass} />;
  return (
    <Dialog
      title={`Text ${contact.displayName}`}
      onClose={onClose}
      closeButton
      footer={
        <ButtonLink to={`/contacts/${contact.id}/thread`} variant="quiet" className="w-full">
          Open the full conversation
        </ButtonLink>
      }
    >
      <div ref={box}>
      <ComposeBox
        contact={{ id: contact.id, name: contact.displayName, canText: contact.phones.length > 0, canEmail: contact.emails.length > 0, typedInChat: contact.typedInChat ?? [], ownedByMe: contact.ownership.ownedByMe }}
        initialChannel="sms"
        suggestedDraftId={pendingDraft}
        sentShownByCaller
        onSent={(r, channel) => setSent({ saved: sendOutcomeText(r, contact.displayName).title, signal: signalOfSend(sentResult(r), channel) })}
        templatePicker={({ channel, insert }) => <TemplatePicker contactId={contact.id} channel={channel} onInsert={insert} />}
      />
      </div>
    </Dialog>
  );
}
