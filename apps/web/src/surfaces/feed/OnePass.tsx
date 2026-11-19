// One pass from Today (R-TODAY-7): a follow-up card's Text and Log open the SAME sheets the person's page uses, here,
// without leaving the page. (Call is the agent sheets' own call sheet: feed/lib/AgentSheets.tsx.)
//
//   Log   notes/LogSheet.tsx: something that happened outside the app ("I called from my phone"), its outcome, and in
//         the same sheet the stage step; ONE button saves the log, the follow-up and the stage.
//   Text  people-edit/TextSheet.tsx: the same compose box (the same reachability reasons and the same send-time check
//         on the server); after a send it goes on to the stage step.
//
// Nothing is forked: both sheets are the person page's own components, given `onePass` (people-edit/StageStep.tsx
// OnePassOptions), which only preselects the follow-up the outcome suggests and makes the closing toast say the whole
// result once. When a sheet closes the feed is read again, so the card updates in place or leaves.
//
// The text sheet needs the person (their numbers, whether they are the viewer's): it is read when the sheet opens. A
// person the viewer sees only as a card (a pond or offer card) cannot be texted from here, and the sheet says so.
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Button, Dialog, Notice } from '../../design/index.js';
import { messageFor } from '../../shell/index.js';
import { useContact } from '../contact/useContact.js';
import { LogSheet } from '../notes/LogSheet.js';
import type { OnePassOptions } from '../people-edit/StageStep.js';
import { TextSheet } from '../people-edit/TextSheet.js';
import { AGENT_ERROR_MESSAGES } from './lib/messages.js';

type Who = { id: string; name: string };
type Opts = Pick<OnePassOptions, 'cardTask' | 'alsoDue'>;

export interface OnePass {
  log(contact: Who, o?: Opts): void;
  text(contact: Who, o?: Opts): void;
}

const Ctx = createContext<OnePass | null>(null);

/** The page's one-pass sheets, or null on a page that has none (the action then does what it always did). */
export function useOnePass(): OnePass | null {
  return useContext(Ctx);
}

export function OnePassProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<{ kind: 'log' | 'text'; contact: Who; o: Opts } | null>(null);
  const qc = useQueryClient();
  const close = useCallback(() => {
    setOpen(null);
    // what the feed says about the person changed (the last touch, the next step): read it again
    void qc.invalidateQueries({ queryKey: ['feed'] });
  }, [qc]);
  const value = useMemo<OnePass>(() => ({ log: (contact, o = {}) => setOpen({ kind: 'log', contact, o }), text: (contact, o = {}) => setOpen({ kind: 'text', contact, o }) }), []);
  return (
    <Ctx.Provider value={value}>
      {children}
      {open?.kind === 'log' ? <LogSheet contactId={open.contact.id} contactName={open.contact.name} onClose={close} onePass={open.o} /> : null}
      {open?.kind === 'text' ? <PersonTextSheet contact={open.contact} onClose={close} onePass={open.o} /> : null}
    </Ctx.Provider>
  );
}

function PersonTextSheet({ contact, onClose, onePass }: { contact: Who; onClose: () => void; onePass: Opts }) {
  const q = useContact(contact.id);
  const c = q.data?.contact;
  if (c && c.view === 'full') return <TextSheet contact={c} onClose={onClose} onePass={onePass} />;
  return (
    <Dialog title={`Text ${contact.name}`} onClose={onClose} footer={<Button block variant="secondary" onClick={onClose}>Close</Button>}>
      {q.isPending ? (
        <p className="text-[15px] text-ink-muted">Loading</p>
      ) : q.isError ? (
        <Notice tone="error" title={`Can't open ${contact.name}`} action={<Button variant="secondary" onClick={() => void q.refetch()}>Try again</Button>}>
          {messageFor(q.error, AGENT_ERROR_MESSAGES)}
        </Notice>
      ) : (
        <p className="text-[15px] text-ink">You can text {contact.name} once they are yours. Open their card to see what you can do now.</p>
      )}
    </Dialog>
  );
}
