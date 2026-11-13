// Compose, dial and approvals under AI care (R-ISA-3, R-ISA-15; E496; docs/AI_ISA.md §10.4):
// - the compose box says, before Send, that a one-to-one message pauses AI care (ingest.ts takeoverInTx from
//   compose.ts:268/:304, dial.ts:109, drafts.ts:184), and who can resume it;
// - after the owner's own send, a toast offers "Resume AI care" (focusable) when care paused human_contact;
// - Call, Text, Email and Send on a live contact carry the same warning before the tap;
// - the inbox never lists ai_isa_message or ai_isa_handoff actions (V1: acknowledging one would approve it or close
//   its handoff card), for every consumer of useInbox.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button, announce } from '../../design/index.js';
import { useApi } from '../../shell/index.js';
import { useContact } from '../contact/useContact.js';
import type { OneTapAction } from '../feed/lib/types.js';
import { type ControlResult, type PanelResponse, isaKeys, useIsaAction, useLiveRow } from './api.js';
import { cap, useViewer } from './Controls.js';
import { StartSheet } from './Person.js';
import { firstOf } from './words.js';

export const AI_INBOX_KINDS: ReadonlySet<string> = new Set(['ai_isa_message', 'ai_isa_handoff']);
export const isAiInboxKind = (kind: string) => AI_INBOX_KINDS.has(kind);
/** useInbox's `select`: drops the AI ISA actions for every consumer (V1). */
export function withoutAiActions<T extends { items: { kind: string }[] }>(d: T): T {
  return { ...d, items: d.items.filter((a) => !AI_INBOX_KINDS.has(a.kind)) };
}

// ---- "sent" events from the compose box -----------------------------------------------------------------------------

const sentListeners = new Set<(contactId: string) => void>();
/** ComposeBox calls this after a send or schedule went out. */
export function aiCareSent(contactId: string): void {
  for (const l of sentListeners) l(contactId);
}

export function AiCareComposeNote({ contact }: { contact: { id: string; name: string } }) {
  const row = useLiveRow(contact.id);
  const c = useContact(contact.id);
  const full = c.data?.contact.view === 'full' ? c.data.contact : null;
  const ownerUserId = row?.ownerUserId ?? full?.owner?.userId ?? null;
  const viewer = useViewer(ownerUserId, row?.ownerName ?? full?.owner?.displayName ?? null);
  const api = useApi();
  const qc = useQueryClient();
  const [toast, setToast] = useState(false);
  const wasLive = useRef(false);
  wasLive.current = row !== null;
  const first = firstOf(contact.name, 'them');
  useEffect(() => {
    const l = async (id: string) => {
      if (id !== contact.id) return;
      const live = wasLive.current;
      void qc.invalidateQueries({ queryKey: ['ai-isa', 'list'] });
      try {
        const p = await api.get<PanelResponse>(`/contacts/${contact.id}/ai-isa`);
        qc.setQueryData(isaKeys.panel(contact.id), p);
        if (live && p.assignment?.pausedAt && p.assignment.pauseReason === 'human_contact' && viewer.isOwner) {
          setToast(true);
          announce(`AI care for ${first} is paused because you messaged them.`);
        }
      } catch {
        /* a 403/404 renders nothing */
      }
    };
    sentListeners.add(l);
    return () => {
      sentListeners.delete(l);
    };
  }, [api, qc, contact.id, first, viewer.isOwner]);
  return (
    <>
      {row ? (
        <p className="text-[14px] leading-snug text-ink" data-testid="ai-compose-note">
          Sending or scheduling this pauses AI care for {first} now. {viewer.isOwner ? 'You' : cap(viewer.ownerFirst)} can resume it.
        </p>
      ) : null}
      {toast ? <ResumeToast contactId={contact.id} first={first} onClose={() => setToast(false)} /> : null}
    </>
  );
}

function ResumeToast({ contactId, first, onClose }: { contactId: string; first: string; onClose(): void }) {
  const resume = useIsaAction<Record<string, never>, ControlResult>('POST', { kind: 'resume', contactId });
  const [line, setLine] = useState<string | null>(null);
  return (
    <div className="fixed inset-x-0 z-50 flex justify-center px-4 bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+var(--sticky-bottom-h,0px)+12px)] md:bottom-[calc(var(--sticky-bottom-h,0px)+24px)]" data-testid="ai-resume-toast">
      <div role="group" aria-label="AI care paused" className="pointer-events-auto flex max-w-md flex-wrap items-center gap-3 rounded-xl bg-ink px-4 py-3 text-[15px] font-medium text-surface shadow-lg">
        <p className="min-w-0 flex-1">{line ?? `AI care for ${first} is paused because you messaged them.`}</p>
        {line === null ? (
          <Button
            variant="secondary"
            pending={resume.pending}
            onClick={async () => {
              const r = await resume.run(`/contacts/${contactId}/ai-isa/resume`, {});
              const t = r.ok ? 'AI care resumed.' : r.message;
              setLine(t);
              announce(t);
              setTimeout(onClose, 4000);
            }}
          >
            Resume AI care
          </Button>
        ) : null}
        <Button variant="quiet" onClick={onClose} aria-label="Close">
          Close
        </Button>
      </div>
    </div>
  );
}

// ---- before a Call, Text, Email or Send tap -------------------------------------------------------------------------

const PAUSING: Partial<Record<OneTapAction['kind'], 'call' | 'send'>> = { call: 'call', text: 'send', email: 'send', send_draft: 'send' };

export function AiCareActionNote({ action, contact }: { action: OneTapAction; contact?: { id: string; name: string } | null }) {
  const kind = PAUSING[action.kind];
  const contactId = 'contactId' in action && typeof action.contactId === 'string' ? action.contactId : (contact?.id ?? null);
  const row = useLiveRow(kind ? contactId : null);
  if (!kind || !row) return null;
  const first = firstOf(contact?.name ?? row.name, 'them');
  return (
    <span className="block basis-full pt-1 text-[13px] leading-snug text-ink" data-testid="ai-action-note">
      {kind === 'call' ? `Calling pauses AI care for ${first}.` : `Sending pauses AI care for ${first}.`}
    </span>
  );
}

// ---- approvals ------------------------------------------------------------------------------------------------------

/**
 * Under a draft or handback: the Send line for a live contact, and on a handback in the viewer's inbox (the inbox
 * lists the caller's own proposed actions) "Let the AI assistant continue", which opens the Start sheet; the sheet
 * offers the sides only when the panel's canStart holds, else the refusal, then posts start {side, fromHandbackId}.
 */
export function AiApprovalExtras({ action }: { action: { id: string; kind: string; status: string; contactId: string | null; contactName: string | null; primaryAction: string; draft: unknown } }) {
  const row = useLiveRow(action.contactId);
  const [open, setOpen] = useState(false);
  const c = useContact(action.kind === 'handback' && action.contactId ? action.contactId : '');
  const full = c.data?.contact.view === 'full' ? c.data.contact : null;
  const first = firstOf(action.contactName, 'them');
  const sends = action.kind === 'handback' || (action.primaryAction === 'send' && action.draft !== null);
  return (
    <>
      {row && sends ? (
        <p className="text-[13px] leading-snug text-ink" data-testid="ai-action-note">
          Sending pauses AI care for {first}.
        </p>
      ) : null}
      {action.kind === 'handback' && action.status === 'proposed' && full && full.ownership.ownedByMe && !row ? (
        <div>
          <Button variant="secondary" onClick={() => setOpen(true)}>
            Let the AI assistant continue
          </Button>
          {open ? <StartSheet contact={full} fromHandbackId={action.id} onClose={() => setOpen(false)} /> : null}
        </div>
      ) : null}
    </>
  );
}
