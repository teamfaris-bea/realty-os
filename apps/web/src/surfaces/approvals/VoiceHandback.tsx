// The voice handback card (module 55 item 9; R-STAFF-9, R-VOICE-17; E662, E665, E666). ActionCard keeps its header,
// draft, Send/Edit and Dismiss; for a voice handback its header says VOICE_HANDBACK_LABEL instead of the handback kind's
// "Replied to the assistant" (batch 14 audit R2; the feed's label stays module 18a's, owner question 12), and it hands
// two places to this file: the claims (VoiceHandback) and, when there is no draft to send, the buttons
// (VoiceHandbackButtons).
//
// - A voice handback is a handback (kind 'handback') with a claim whose evidence is the call (sourceType 'call') at
//   the field voice_outcome; that evidence's snippet is the stored outcome and its sourceId the call id. Nothing else
//   is one: no ai_isa kind and no other kind gets this card (module 55 adds no branch for them).
// - The code-built claims cite stored fields of the call or the appointment (locator kind 'field'). Their snippet is
//   the stored value (an outcome code, an ISO time), so the claim's own text is shown with "From the call record" and
//   the value never is (E662).
// - "What the assistant did" reads GET /calls/:id/voice (the call's own RLS read: the handback's recipient sees it,
//   anyone else gets 404 and the card says the details aren't available, E666): the state and outcome sentences, the
//   takeover time, the transfer outcome, the ledger and unlogged rows, all in words. Ledger arguments are never shown,
//   and neither is anything the caller said (R-STAFF-9).
// - Buttons: a confirmation draft keeps ActionCard's one-tap Send and Edit (R-VOICE-17). Otherwise Reply, Mark handled
//   and Call back (the contact page); for a caller who opted out, only Mark handled, and the card says why (E665).
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useId, useState } from 'react';
import { Button, ButtonLink, ClaimLine, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { claimView, formatDateTime } from '../feed/lib/format.js';
import type { ActionView, ClaimApiView, EvidenceApiView } from '../feed/lib/types.js';
import type { CallVoiceView } from '../voice/types.js';
import { endReasonWords, ledgerRowWords, outcomeWords, transferWords, unloggedWords } from '../voice/words.js';

export const VOICE_HANDBACK_LABEL = 'The assistant answered a call';
export const FROM_CALL_RECORD = 'From the call record';
export const CALL_DETAILS_UNAVAILABLE = "The call details aren't available to you.";
export const NO_CALLER_WORDS = "Nothing the caller said is shown here; their words are kept only in the call's encrypted transcript.";
export const OPTED_OUT_CARD = 'The caller asked not to be contacted, so there is no reply or call back from here.';

const isOutcomeEvidence = (e: EvidenceApiView) => e.sourceType === 'call' && e.locator['kind'] === 'field' && e.locator['field'] === 'voice_outcome';
const isFieldEvidence = (e: EvidenceApiView) => (e.sourceType === 'call' || e.sourceType === 'appointment') && e.locator['kind'] === 'field';

/** The call and its stored outcome when `a` is a voice handback; null for anything else. */
export function voiceHandbackOf(a: ActionView): { callId: string; outcome: string | null } | null {
  if (a.kind !== 'handback') return null;
  for (const c of a.claims) {
    const e = c.evidence.find(isOutcomeEvidence);
    if (e) return { callId: e.sourceId, outcome: e.snippet };
  }
  return null;
}

export function isVoiceHandback(a: ActionView): boolean {
  return voiceHandbackOf(a) !== null;
}

/** The claims of a voice handback, the code-built ones worded, and what the assistant did on the call. */
export function VoiceHandback({ action, review }: { action: ActionView; review(claim: ClaimApiView): ReactNode }) {
  const v = voiceHandbackOf(action)!;
  return (
    <div className="flex flex-col gap-3">
      {action.claims.length > 0 ? (
        <ul className="flex flex-col gap-3" aria-label="What the assistant found">
          {action.claims.map((c) => (
            <li key={c.id}>
              {c.evidence.length > 0 && c.evidence.every(isFieldEvidence) ? (
                <div className="flex flex-col gap-0.5">
                  <p className="text-[16px] text-ink">{c.text}</p>
                  <p className="text-[14px] text-ink-muted">{FROM_CALL_RECORD}</p>
                </div>
              ) : (
                <ClaimLine claim={claimView(c, action.contactId)} />
              )}
              {review(c)}
            </li>
          ))}
        </ul>
      ) : null}
      {v.outcome === 'opted_out' ? <Notice tone="warn">{OPTED_OUT_CARD}</Notice> : null}
      <CallDetails callId={v.callId} />
    </div>
  );
}

function CallDetails({ callId }: { callId: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button variant="quiet" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          What the assistant did
        </Button>
      </div>
      <div id={id}>{open ? <CallDetailsBody callId={callId} /> : null}</div>
    </div>
  );
}

function CallDetailsBody({ callId }: { callId: string }) {
  const api = useApi();
  const q = useQuery<CallVoiceView, ApiError>({ queryKey: ['call-voice', callId], queryFn: ({ signal }) => api.get<CallVoiceView>(`/calls/${encodeURIComponent(callId)}/voice`, { signal }) });
  if (q.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  if (q.isError) return <p className="text-[15px] text-ink">{q.error.code === 'NOT_FOUND' ? CALL_DETAILS_UNAVAILABLE : messageFor(q.error)}</p>;
  const d = q.data;
  // E666: a call still in progress, recovered after the session was lost, or not answered: the server's sentence only
  if (d.state !== 'ended') return <p className="text-[15px] text-ink">{d.sentence}</p>;
  const transfer = transferWords(d.transferOutcome);
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-surface-2 px-3.5 py-3 text-[15px] text-ink">
      <p>{d.sentence}</p>
      <p>{d.outcomeSentence ?? outcomeWords(d.outcome)}</p>
      {d.takeoverAt ? <p>{`The assistant took the call at ${formatDateTime(d.takeoverAt)}.`}</p> : null}
      {d.endReason ? <p>{endReasonWords(d.endReason)}</p> : null}
      {transfer ? <p>{transfer}</p> : null}
      {d.ledger.length > 0 ? (
        <ul aria-label="What the assistant asked to do" className="flex list-disc flex-col gap-1 pl-5">
          {d.ledger.map((x) => (
            <li key={x.seq}>{ledgerRowWords(x)}</li>
          ))}
        </ul>
      ) : (
        <p>The assistant asked to do nothing.</p>
      )}
      {d.unlogged.length > 0 ? (
        <ul aria-label="Requests not logged" className="flex list-disc flex-col gap-1 pl-5">
          {d.unlogged.map((x) => (
            <li key={x.seq}>{unloggedWords(x.reason)}</li>
          ))}
        </ul>
      ) : null}
      <p className="text-ink-muted">{NO_CALLER_WORDS}</p>
    </div>
  );
}

/** A voice handback with no draft to send: Reply, Mark handled and Call back; for an opted-out caller, Mark handled only. */
export function VoiceHandbackButtons({ action, pending, onHandled }: { action: ActionView; pending: boolean; onHandled(): void }) {
  const optedOut = voiceHandbackOf(action)?.outcome === 'opted_out';
  const contactId = action.contactId;
  return (
    <>
      {!optedOut && contactId ? (
        <ButtonLink icon="message" to={`/contacts/${encodeURIComponent(contactId)}/thread?compose=sms`}>
          Reply
        </ButtonLink>
      ) : null}
      <Button variant="secondary" pending={pending} onClick={onHandled}>
        Mark handled
      </Button>
      {!optedOut && contactId ? (
        <ButtonLink variant="secondary" icon="phone" to={`/contacts/${encodeURIComponent(contactId)}`}>
          Call back
        </ButtonLink>
      ) : null}
    </>
  );
}
