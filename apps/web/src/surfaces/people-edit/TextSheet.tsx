// Text from the person's page without leaving it (owner brief 2026-11-19: "Don't make an agent bounce between
// screens"). The sheet holds the existing compose box, unchanged: the same reachability reasons, the same send-time
// check on the server, the same outcome words. Nothing here can text past an opt-out.
//
// After a text or email went out, the same sheet shows the stage step. The send route answers no stage suggestion,
// so the step reads the signal ("we sent a text, no reply yet") by core's own table against the person's fresh
// details (StageStep.tsx). A message that is only SCHEDULED has not been sent: it suggests nothing, and the step
// says when it will go. A reply in the website chat suggests nothing either (the table reads texts and emails).
import { useState } from 'react';
import { Button, Dialog } from '../../design/index.js';
import { ComposeBox } from '../compose/ComposeBox.js';
import { sendOutcomeText, sentResult } from '../feed/lib/AgentSheets.js';
import type { ContactFullView } from '../feed/lib/types.js';
import { TemplatePicker } from '../templates/TemplatePicker.js';
import { StageStep, type StageSignal } from './StageStep.js';

/** What a send that went out says about the stage: a text or email actually handed over is a try; anything else, nothing. */
export function signalOfSend(result: string, channel: string): StageSignal | null {
  if (result !== 'sent' && result !== 'queued') return null;
  if (channel === 'sms') return { kind: 'message', channel: 'text', direction: 'outbound' };
  if (channel === 'email') return { kind: 'message', channel: 'email', direction: 'outbound' };
  return null;
}

export function TextSheet({ contact, onClose }: { contact: ContactFullView; onClose: () => void }) {
  const [sent, setSent] = useState<{ saved: string; signal: StageSignal | null } | null>(null);
  if (sent) return <StageStep contactId={contact.id} contactName={contact.displayName} saved={sent.saved} signal={sent.signal} onClose={onClose} />;
  return (
    <Dialog
      title={`Text ${contact.displayName}`}
      onClose={onClose}
      footer={
        <Button block variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <ComposeBox
        contact={{ id: contact.id, name: contact.displayName, canText: contact.phones.length > 0, canEmail: contact.emails.length > 0, typedInChat: contact.typedInChat ?? [], ownedByMe: contact.ownership.ownedByMe }}
        initialChannel="sms"
        autoFocus
        onSent={(r, channel) => setSent({ saved: sendOutcomeText(r, contact.displayName).title, signal: signalOfSend(sentResult(r), channel) })}
        templatePicker={({ channel, insert }) => <TemplatePicker contactId={contact.id} channel={channel} onInsert={insert} />}
      />
    </Dialog>
  );
}
