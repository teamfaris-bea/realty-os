// Sharing a CMA (R-CMA-9, D1, R-GATE-14, R-FH-1; E376, E600-E614): the creator's draft of a contact, whose subject is
// not a listing. The share preview (GET /cma/:id/share-preview) says everything before the tap: who receives it and at
// which address (a chooser only when there is a choice), the send-time check's answer in words, the report exactly as
// it will be emailed, what won't print, the wording to check, and every reason the Email button is off. "Email to
// {first name}" is on only when the preview says it can be shared, and one tap is one request (POST /cma/:id/share
// with the hashes the preview showed). The email is shown as it will be sent, open (never behind a tap), and the phone's
// sticky bar names the recipient, the address and the send-time check beside the button (ShareRecipient; audit F7). A
// report that changed since the preview (CMA_STALE) is fetched again and says so. Nothing here offers another way to
// send the report.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button, Card, Notice } from '../../design/index.js';
import { type ApiError, useApi } from '../../shell/index.js';
import { type CmaView, type ShareResult, type SharePreview, cmaKey, cmaMessage, contactCmasKey, previewKey, previewPath, sharePanelApplies, useCall } from './lib.js';
import { DISCLOSURE_WORDS, ROLE_WORDS, W, WHERE_WORDS } from './words.js';

interface Choice {
  recipientContactId: string | null;
  toPointId: string | null;
}

export interface ShareState {
  applies: boolean;
  preview: SharePreview | null;
  loading: boolean;
  loadError: string | null;
  retry(): void;
  choose(c: Choice): void;
  send(): Promise<void>;
  pending: boolean;
  /** the share's failure in words (CMA_STALE is said as `notice`) */
  error: string | null;
  /** after a tap: "Sent", the email's sentence, or the stale report's words */
  notice: { tone: 'ok' | 'warn'; text: string } | null;
  firstName: string | null;
}

export function useShare(view: CmaView): ShareState {
  const api = useApi();
  const qc = useQueryClient();
  const applies = sharePanelApplies(view);
  const [choice, setChoice] = useState<Choice>({ recipientContactId: null, toPointId: null });
  const [notice, setNotice] = useState<ShareState['notice']>(null);
  const q = useQuery<{ preview: SharePreview }, ApiError>({
    // the content hash is part of the key: every re-run of the draft is previewed again
    queryKey: [...previewKey(view.id, choice.recipientContactId, choice.toPointId), view.contentSha256],
    queryFn: ({ signal }) => api.get<{ preview: SharePreview }>(previewPath(view.id, choice.recipientContactId, choice.toPointId), { signal }),
    enabled: applies,
    staleTime: 0,
  });
  const call = useCall<unknown, ShareResult>('POST');
  const p = q.data?.preview ?? null;
  const firstName = p?.recipients.find((r) => r.contactId === p.recipientContactId)?.firstName ?? null;

  const send = async () => {
    if (!p || !p.canShare || !p.recipientContactId || !p.toPointId || !p.reportSha256) return;
    setNotice(null);
    const r = await call.run(`/cma/${view.id}/share`, { recipientContactId: p.recipientContactId, toPointId: p.toPointId, contentSha256: p.contentSha256, reportSha256: p.reportSha256 });
    if (r.ok) {
      qc.setQueryData(cmaKey(view.id), { cma: r.data.cma });
      if (view.contactId) void qc.invalidateQueries({ queryKey: contactCmasKey(view.contactId) });
      const sentence = r.data.cma.share?.message?.sentence;
      setNotice({ tone: r.data.message.result === 'sent' || r.data.message.result === 'replayed' ? 'ok' : 'warn', text: r.data.message.result === 'sent' ? W.sent : (sentence ?? W.sent) });
      return;
    }
    if (r.error.code === 'CMA_STALE') {
      setNotice({ tone: 'warn', text: r.error.details?.reason === 'DATA_OLD' ? W.dataOld : W.staleRetap });
      call.reset();
      void qc.invalidateQueries({ queryKey: cmaKey(view.id), exact: true });
      await q.refetch();
      return;
    }
    // any other refusal: the preview says why now
    void q.refetch();
  };

  return {
    applies,
    preview: p,
    loading: applies && q.isPending,
    loadError: q.isError ? cmaMessage(q.error) : null,
    retry: () => void q.refetch(),
    choose: (c) => {
      setNotice(null);
      setChoice(c);
    },
    send,
    pending: call.pending,
    error: call.error && call.error.error.code !== 'CMA_STALE' ? call.error.message : null,
    notice,
    firstName,
  };
}

/** The one button. Off unless the preview says the CMA can be shared; busy while the POST is in flight. */
export function ShareButton({ s, describedBy }: { s: ShareState; describedBy?: string }) {
  const can = s.preview?.canShare === true;
  return (
    <Button block disabled={!can} pending={s.pending} pendingLabel={W.sending} aria-describedby={describedBy} onClick={() => void s.send()}>
      {s.firstName ? W.emailTo(s.firstName) : W.emailOff}
    </Button>
  );
}

/** The send-time check's answer now, in words (D1): its explanation, or that it allows the email; null when there is none. */
export function decisionLine(p: SharePreview | null): string | null {
  const d = p?.decision ?? null;
  if (d === null) return null;
  if (d.explanation) return `${W.sendCheck}: ${d.explanation}`;
  return d.outcome === 'allow' ? W.sendCheckAllows : null;
}

/**
 * Who receives it and where, and the send-time check's answer, beside the phone's sticky Email button (R-CMA-9, D1: the
 * tap is made on a screen already showing the recipient's decision; audit cma-v2a F7). The answer is left out when the
 * bar's own sentence already says it (a deny), so it is said once.
 */
export function ShareRecipient({ s }: { s: ShareState }) {
  const p = s.preview;
  const recipient = p?.recipients.find((r) => r.contactId === p.recipientContactId) ?? null;
  if (!p || !recipient) return null;
  const email = recipient.emails.find((e) => e.id === p.toPointId) ?? null;
  const line = decisionLine(p);
  const said = line !== null && p.decision?.explanation ? (p.sentence ?? '').includes(p.decision.explanation) : false;
  return (
    <div className="flex flex-col gap-0.5 text-[14px] text-ink">
      <p className="[overflow-wrap:anywhere]">
        <span className="text-ink-muted">{W.to}: </span>
        <span className="font-medium">{recipient.name}</span>
        {email ? <span> · {email.address}</span> : null}
      </p>
      {line !== null && !said ? <p>{line}</p> : null}
    </div>
  );
}

/** The share's failure or outcome, next to the button. */
export function ShareOutcome({ s }: { s: ShareState }) {
  return (
    <>
      {s.error ? <Notice tone="error">{s.error}</Notice> : null}
      {s.notice ? <Notice tone={s.notice.tone}>{s.notice.text}</Notice> : null}
    </>
  );
}

function Lines({ items, tone = 'ink' }: { items: string[]; tone?: 'ink' | 'danger' | 'warn' }) {
  if (items.length === 0) return null;
  return (
    <ul className={`flex flex-col gap-1 text-[15px] ${tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-ink'}`}>
      {items.map((t, i) => (
        <li key={`${i}-${t}`}>{t}</li>
      ))}
    </ul>
  );
}

function Chooser({ s }: { s: ShareState }) {
  const p = s.preview!;
  const rName = useId();
  const eName = useId();
  const recipient = p.recipients.find((r) => r.contactId === p.recipientContactId) ?? null;
  return (
    <div className="flex flex-col gap-3">
      {p.recipients.length > 1 ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-[15px] font-medium text-ink">{W.chooseRecipient}</legend>
          {p.recipients.map((r) => (
            <label key={r.contactId} className="flex min-h-tap items-center gap-2 text-[15px] text-ink">
              <input type="radio" name={rName} className="h-5 w-5" checked={r.contactId === p.recipientContactId} onChange={() => s.choose({ recipientContactId: r.contactId, toPointId: null })} />
              {r.name}
            </label>
          ))}
        </fieldset>
      ) : null}
      {recipient && recipient.emails.length > 1 ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-[15px] font-medium text-ink">{W.chooseEmail}</legend>
          {recipient.emails.map((e) => (
            <label key={e.id} className="flex min-h-tap items-center gap-2 break-all text-[15px] text-ink">
              <input type="radio" name={eName} className="h-5 w-5" checked={e.id === p.toPointId} onChange={() => s.choose({ recipientContactId: recipient.contactId, toPointId: e.id })} />
              {e.address}
            </label>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}

/** The panel: everything the preview says, and on wide screens the button (phones have it in the sticky bar). */
export function SharePanel({ s, withButton, sentenceId }: { s: ShareState; withButton: boolean; sentenceId: string }) {
  const hid = useId();
  const p = s.preview;
  const recipient = p?.recipients.find((r) => r.contactId === p.recipientContactId) ?? null;
  const email = recipient?.emails.find((e) => e.id === p?.toPointId) ?? null;
  const decision = p?.decision ?? null;
  const missing = p?.disclosureMissing ?? [];
  return (
    <Card className="flex flex-col gap-3" aria-labelledby={hid}>
      <h2 id={hid} className="text-[17px] font-semibold text-ink">
        {W.shareHeading}
      </h2>
      {s.loading ? <p className="text-[15px] text-ink-muted">{W.previewLoading}</p> : null}
      {s.loadError ? (
        <Notice tone="error" action={<Button variant="secondary" onClick={s.retry}>{W.tryAgain}</Button>}>
          {s.loadError}
        </Notice>
      ) : null}
      {p ? (
        <>
          {recipient ? (
            <p className="text-[15px] text-ink [overflow-wrap:anywhere]">
              <span className="text-ink-muted">{W.to}: </span>
              <span className="font-medium">{recipient.name}</span>
              {email ? <span> · {email.address}</span> : null}
            </p>
          ) : null}
          <Chooser s={s} />
          {decision ? (
            <p className="text-[15px] text-ink">
              {decision.explanation ? (
                <>
                  <span className="text-ink-muted">{W.sendCheck}: </span>
                  {decision.explanation}
                </>
              ) : decision.outcome === 'allow' ? (
                W.sendCheckAllows
              ) : null}
            </p>
          ) : null}
          {p.sentence ? (
            <div id={sentenceId} className="flex flex-col gap-1 rounded-xl bg-warn-soft px-3.5 py-3">
              <p className="text-[15px] font-semibold text-ink">{p.sentence}</p>
              <Lines items={p.blockers.map((b) => b.sentence)} />
            </div>
          ) : p.blockers.length > 0 ? (
            <Lines items={p.blockers.map((b) => b.sentence)} />
          ) : null}
          {missing.length > 0 ? (
            <div>
              <p className="text-[15px] font-medium text-ink">{W.missingHeading}</p>
              <Lines items={missing.map((m) => (m === 'notes' ? WHERE_WORDS.notes : m === 'inspectedOn' ? WHERE_WORDS.inspectedOn : DISCLOSURE_WORDS[m].label))} />
            </div>
          ) : null}
          {p.fairHousing.hard.length > 0 ? (
            <div className="flex flex-col gap-1">
              <p className="text-[15px] font-semibold text-danger">{W.fhHard}</p>
              <Lines tone="danger" items={p.fairHousing.hard.map((m) => W.fhHardLine(m.label, WHERE_WORDS[m.where]))} />
            </div>
          ) : null}
          <Lines
            tone="warn"
            items={[
              ...p.fairHousing.soft.map((m) => W.fhSoft(m.label, WHERE_WORDS[m.where])),
              ...p.warnings.filter((x) => x.code === 'CHECK_WORDING').map((x) => W.checkWording(ROLE_WORDS[x.role])),
              ...p.warnings.filter((x) => x.code === 'WONT_PRINT').map((x) => W.wontPrint(`${ROLE_WORDS[x.role]}${x.codePoints?.length ? ` (${x.codePoints.join(', ')})` : ''}`)),
              ...(p.tooLong?.parts ?? []).map((x) => W.tooLong(ROLE_WORDS[x.role], x.chars)),
            ]}
          />
          {(p.body ?? p.reportText) ? (
            // shown, never behind a tap (R-CMA-9, D1: the tap is made on a screen already showing the report; audit
            // cma-v2a F7): the email exactly as comms renders it (signature, footer, the unsubscribe line when
            // marketing), or the report alone while there is no address to render it for
            <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 py-3">
              <h3 className="text-[15px] font-medium text-ink">{W.reportHeading}</h3>
              {p.subject ? <p className="text-[15px] font-medium text-ink">{W.subjectLine(p.subject)}</p> : null}
              <pre className="whitespace-pre-wrap break-words font-sans text-[15px] text-ink">{p.body ?? p.reportText}</pre>
            </div>
          ) : null}
        </>
      ) : null}
      {withButton ? <ShareOutcome s={s} /> : null}
      {withButton ? <ShareButton s={s} {...(p?.sentence ? { describedBy: sentenceId } : {})} /> : null}
    </Card>
  );
}
