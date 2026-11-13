// Upload controls (module 55 item 6; R-STAFF-8, E672). Shown only to roles that hold the scope's upload action (the
// caller decides); the server still decides. A chosen file is checked before any request: an empty file, another
// type or one over 10,000,000 bytes is refused in words and nothing is sent. The form carries only `file`, `kind`
// (never on a version) and an optional `displayName`; never a commandId. Sent once through api.upload, never retried.
import type { QueryKey } from '@tanstack/react-query';
import { type ChangeEvent, type FormEvent, useId, useRef, useState } from 'react';
import { Button, Notice } from '../../design/index.js';
import { useUpload } from './hooks.js';
import { DOCUMENT_KINDS, type DocumentKind, type UploadResponse } from './types.js';
import { ACCEPT, KIND_WORDS, precheck } from './words.js';

export type UploadMode = 'deal' | 'kinds' | 'version';

function formOf(file: File, kind: DocumentKind | null, displayName: string): FormData {
  const form = new FormData();
  form.append('file', file);
  if (kind !== null) form.append('kind', kind);
  const name = displayName.trim();
  if (name !== '') form.append('displayName', name);
  return form;
}

export function UploadControls({ path, mode, invalidate, onUploaded }: { path: string; mode: UploadMode; invalidate: QueryKey[]; onUploaded?: (r: UploadResponse) => void }) {
  const upload = useUpload<UploadResponse>({ invalidate });
  const quick = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<UploadResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<DocumentKind | ''>('');
  const [file, setFile] = useState<File | null>(null);
  const [displayName, setDisplayName] = useState('');
  const ids = { kind: useId(), name: useId(), file: useId(), hint: useId() };

  const send = async (f: File, k: DocumentKind | null, name: string) => {
    const refused = precheck(f);
    if (refused) {
      setError(refused);
      return false;
    }
    setError(null);
    setDone(null);
    const r = await upload.run(path, formOf(f, k, name));
    if (!r.ok) {
      setError(r.message);
      return false;
    }
    setDone(r.data);
    onUploaded?.(r.data);
    return true;
  };

  // one tap to the picker: the chosen file goes at once (the picker is not a tap)
  const quickKind: DocumentKind | null = mode === 'deal' ? 'purchase_contract' : null;
  const onQuick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    e.target.value = '';
    if (f) void send(f, quickKind, '');
  };
  const onChoose = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setError(f ? precheck(f) : null);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || kind === '') return;
    if (await send(file, kind, displayName)) {
      setOpen(false);
      setFile(null);
      setKind('');
      setDisplayName('');
    }
  };

  const quickLabel = mode === 'deal' ? 'Upload a contract' : 'Upload a new version';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {mode === 'deal' || mode === 'version' ? (
          <>
            <Button variant="secondary" icon="upload" pending={upload.pending} pendingLabel="Uploading" onClick={() => quick.current?.click()}>
              {quickLabel}
            </Button>
            <input ref={quick} type="file" accept={ACCEPT} className="hidden" tabIndex={-1} aria-label={mode === 'deal' ? 'Contract file' : 'New version file'} onChange={onQuick} />
          </>
        ) : null}
        {mode !== 'version' && !open ? (
          <Button variant="quiet" onClick={() => setOpen(true)}>
            {mode === 'deal' ? 'Upload another document' : 'Upload a document'}
          </Button>
        ) : null}
      </div>
      <p id={ids.hint} className="text-[14px] text-ink-muted">
        PDF, JPEG or PNG, up to 10 MB.
      </p>
      {open ? (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 rounded-xl border border-line p-3" aria-label="Upload a document">
          <label htmlFor={ids.kind} className="flex flex-col gap-1 text-[15px] font-medium text-ink">
            Kind
            <select id={ids.kind} value={kind} onChange={(e) => setKind(e.target.value as DocumentKind | '')} required className="min-h-tap rounded-xl border border-line bg-surface px-3 text-[17px] text-ink">
              <option value="">Choose a kind</option>
              {DOCUMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_WORDS[k]}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={ids.file} className="flex flex-col gap-1 text-[15px] font-medium text-ink">
            File
            <input id={ids.file} type="file" accept={ACCEPT} aria-describedby={ids.hint} onChange={onChoose} className="min-h-tap text-[15px] text-ink" />
          </label>
          <label htmlFor={ids.name} className="flex flex-col gap-1 text-[15px] font-medium text-ink">
            Name (optional)
            <input id={ids.name} value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={200} className="min-h-tap rounded-xl border border-line bg-surface px-3.5 text-[17px] text-ink" />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" pending={upload.pending} pendingLabel="Uploading" disabled={!file || kind === '' || precheck(file) !== null}>
              Upload
            </Button>
            <Button variant="quiet" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {done ? (
        <Notice tone="ok" title={`Added ${done.document.displayName}, version ${done.document.versionNo}.`}>
          {done.document.scanText ?? null}
          {done.previousVersionSharedText ? <p className="mt-1">{done.previousVersionSharedText}</p> : null}
        </Notice>
      ) : null}
    </div>
  );
}
