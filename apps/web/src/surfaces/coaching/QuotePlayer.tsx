// A tap-to-play quote from a call (module 40; R-COACH-2). One tap asks the API for a single-use stream token
// (POST /recordings/:id/stream-token, audited as recording.play) and plays that moment of the call: the
// media fragment `#t=start,end` starts the audio at the quoted words and stops after them. The quote's words
// are the text alternative; when the viewer may not read the transcript, the page says so instead.
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import type { QuoteView } from './types.js';

const seconds = (ms: number) => Math.max(0, Math.floor(ms / 100) / 10);

export function QuotePlayer({ quote, index }: { quote: QuoteView; index: number }) {
  const api = useApi();
  const id = useId();
  const audio = useRef<HTMLAudioElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the button is replaced by the player: focus moves to the player, not to <body>
  useEffect(() => {
    if (src) audio.current?.focus();
  }, [src]);
  const play = async () => {
    if (!quote.recordingId) return;
    setBusy(true);
    setError(null);
    try {
      const t = await api.post<{ url: string }>(`/recordings/${quote.recordingId}/stream-token`, { purpose: 'play' });
      setSrc(`${t.url}#t=${seconds(quote.startMs)},${seconds(quote.endMs)}`);
      // autoPlay starts it; an explicit play() covers browsers that wait for the element (no-op in jsdom)
      queueMicrotask(() => void Promise.resolve(audio.current?.play?.()).catch(() => undefined));
    } catch (e) {
      setError(messageFor(e as ApiError));
    } finally {
      setBusy(false);
    }
  };
  const words = quote.snippet !== null ? `“${quote.snippet}”` : 'Words not shown: you can play the call but not read its transcript.';
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-line bg-surface-2 p-3">
      <p id={`${id}-call`} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
        {quote.callLabel}
      </p>
      <blockquote id={`${id}-words`} className="break-words text-[17px] text-ink">
        {words}
      </blockquote>
      {quote.recordingId === null ? (
        <p className="text-[15px] text-ink-muted">The recording is no longer available.</p>
      ) : src ? (
        <audio ref={audio} controls autoPlay tabIndex={0} src={src} className="w-full" aria-label={`Moment ${index + 1} of the call`} />
      ) : (
        <Button variant="secondary" icon="play" className="self-start" pending={busy} pendingLabel="Loading" onClick={() => void play()} aria-describedby={`${id}-call ${id}-words`}>
          Play this moment
        </Button>
      )}
      {error ? (
        <p role="alert" className="text-[15px] font-medium text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}
