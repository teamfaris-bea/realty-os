// What came with a message or a call (GET /contacts/:id/attachments): inbound MMS media and voicemails.
//
// - Photos (raster images) show inline as <img>, same-origin, with a download link; every other kept file
//   is a download (the API sends it as an attachment with nosniff and a sandboxing CSP).
// - Media the platform did not keep are said plainly, with why, never hidden (honest UI).
// - A voicemail plays only after a tap (POST /recordings/:id/stream-token, single-use, audited), and its
//   transcript opens on a second tap (GET /recordings/:id/transcript, audited). Recording access rules
//   (R-PERM-8) decide: someone outside the scope sees no voicemail row at all.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import type { TimelineItem } from '../feed/lib/types.js';

export interface AttachmentsResponse {
  messages: {
    messageId: string;
    media: { position: number; contentType: string; byteSize: number; inline: boolean; url: string }[];
    skipped: { position: number; reason: string }[];
    /** R-TWL-11: MMS text parts (absent from older servers) */
    textParts?: { position: number; status: 'read' | 'pending'; text: string | null }[];
  }[];
  voicemails: { callId: string; recordingId: string; durationS: number | null; transcriptReady: boolean }[];
}

export function useAttachments(contactId: string) {
  const api = useApi();
  return useQuery<AttachmentsResponse, ApiError>({
    queryKey: ['attachments', contactId],
    queryFn: ({ signal }) => api.get<AttachmentsResponse>(`/contacts/${contactId}/attachments`, { signal }),
    refetchInterval: 30_000,
  });
}

const SKIP_SENTENCE: Record<string, string> = {
  TYPE_NOT_ALLOWED: "this kind of file isn't accepted",
  TOO_LARGE: 'it was larger than 5 MB',
  TOO_MANY: 'only the first 10 attachments of a message are kept',
  CONTENT_MISMATCH: "the file wasn't what it said it was",
  FETCH_FAILED: "it couldn't be downloaded from the carrier",
};

export function skippedSentence(reason: string): string {
  return SKIP_SENTENCE[reason] ?? "it couldn't be saved";
}

const KIND_LABEL: Record<string, string> = { 'application/pdf': 'PDF', 'text/vcard': 'contact card' };

function kindOf(contentType: string): string {
  if (KIND_LABEL[contentType]) return KIND_LABEL[contentType]!;
  const [top] = contentType.split('/');
  return top === 'image' ? 'photo' : top === 'video' ? 'video' : top === 'audio' ? 'audio clip' : 'file';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function duration(s: number | null): string {
  if (s === null) return '';
  return ` (${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')})`;
}

/** The attachments of one thread row (a message's media, or a call's voicemail). Renders nothing when there are none. */
export function RowAttachments({ contactId, item }: { contactId: string; item: Pick<TimelineItem, 'id' | 'type'> }) {
  const a = useAttachments(contactId);
  if (!a.data) return null;
  if (item.type === 'call') {
    const vm = a.data.voicemails.find((v) => v.callId === item.id);
    return vm ? <Voicemail vm={vm} /> : null;
  }
  const m = a.data.messages.find((x) => x.messageId === item.id);
  if (!m) return null;
  const parts = m.textParts ?? [];
  const total = m.media.length + m.skipped.length + parts.length;
  return (
    <div className="flex flex-col gap-1 px-1">
      {parts.map((x) =>
        // plain text only: React escapes it; never HTML, never a link (R-TWL-11)
        x.status === 'read' ? (
          <p key={`t${x.position}`} className="max-w-[85%] whitespace-pre-wrap break-words text-[14px] text-ink">
            Text in this message: {x.text}
          </p>
        ) : (
          <p key={`t${x.position}`} className="text-[13px] text-ink-muted">
            Part of this text hasn't been read yet.
          </p>
        ),
      )}
      {m.media.map((x) => {
        const label = `Attachment ${x.position + 1} of ${total}, ${kindOf(x.contentType)}, ${formatBytes(x.byteSize)}`;
        return (
          <div key={x.position} className="flex flex-col items-start gap-1">
            {x.inline ? <img src={x.url} alt={`Photo ${x.position + 1} of ${total} they sent`} loading="lazy" className="max-h-64 max-w-full rounded-xl border border-line object-contain" /> : null}
            <a href={x.url} download className="inline-flex min-h-tap items-center text-[14px] font-medium text-accent underline">
              Download {label}
            </a>
          </div>
        );
      })}
      {m.skipped.map((x) => (
        <p key={`s${x.position}`} className="text-[13px] text-ink-muted">
          Attachment {x.position + 1} of {total} wasn't saved: {skippedSentence(x.reason)}.
        </p>
      ))}
    </div>
  );
}

function Voicemail({ vm }: { vm: AttachmentsResponse['voicemails'][number] }) {
  const api = useApi();
  const [src, setSrc] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const play = async () => {
    setBusy(true);
    setError(null);
    try {
      const t = await api.post<{ url: string }>(`/recordings/${vm.recordingId}/stream-token`, { purpose: 'play' });
      setSrc(t.url);
    } catch (e) {
      setError(messageFor(e as ApiError));
    } finally {
      setBusy(false);
    }
  };
  const read = async () => {
    setBusy(true);
    setError(null);
    try {
      const t = await api.get<{ status: string; segments: { text: string }[] }>(`/recordings/${vm.recordingId}/transcript`);
      setTranscript(t.segments.map((s) => s.text).join(' ').trim() || 'The transcript is empty.');
    } catch (e) {
      setError(messageFor(e as ApiError));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-center gap-1">
      <p className="text-[14px] text-ink-muted">Voicemail{duration(vm.durationS)}</p>
      <div className="flex flex-wrap justify-center gap-2" role="group" aria-label="Voicemail">
        {src ? (
          // the transcript button is the text alternative
          <audio controls autoPlay src={src} className="max-w-full" aria-label="Voicemail recording" />
        ) : (
          <Button variant="secondary" disabled={busy} onClick={() => void play()}>
            Play voicemail
          </Button>
        )}
        {vm.transcriptReady && transcript === null ? (
          <Button variant="quiet" disabled={busy} onClick={() => void read()}>
            Read transcript
          </Button>
        ) : null}
      </div>
      {!vm.transcriptReady ? <p className="text-[13px] text-ink-muted">The transcript isn't ready yet.</p> : null}
      {transcript !== null ? <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl border border-line bg-surface px-3.5 py-2 text-[15px] text-ink">{transcript}</p> : null}
      {error ? (
        <p role="alert" className="text-[13px] font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
