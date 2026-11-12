// Imports with staged review lists (BUILD_PLAN module 17; api/imports module 16; ARCHITECTURE §13).
//
// Dry-run first, verified per category:
//   1. Connection test: counts only. Nothing is promised or imported before it (R-IMPORT-1).
//   2. Snapshot: every later step works on that frozen copy, never on live Follow Up Boss.
//   3. Per category, in dependency order: dry run → per-record review list (will import | needs review
//      | rejected | duplicate) → Approve exactly that snapshot (R-IMPORT-2) → Import → Verify with the
//      recount and the side-by-side checks (R-IMPORT-5). A category imports only after the ones before
//      it are verified or skipped (R-IMPORT-3); the page says which one it is waiting for.
//   4. The report never claims more than the counts show (the server writes its sentences).
// Every import call needs a password confirmation within 15 minutes (R-PERM-13); the page asks for
// it once and continues. Undo works per category in reverse order, or for the whole import.
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, Card, EmptyState, Notice, TextField } from '../../design/index.js';
import { type ApiError, messageFor, useApi, useSession, useWithReauth } from '../../shell/index.js';
import { formatStamp, plural } from '../admin/lib/format.js';
import { useAction, useAnnounce } from '../admin/lib/hooks.js';
import { ADMIN_MESSAGES } from '../admin/lib/messages.js';
import type { ImportBatch, ImportCounts, ImportRecord, ImportStage, MappingsResponse, MembersResponse, Pond, ReportResponse, VerificationResponse } from '../admin/lib/types.js';
import { ErrorLine, Pill, Section, Segmented, SelectField, StatusLine } from '../admin/lib/ui.js';
import { BulkActionSheet, mayBulkAssign } from '../bulk/index.js';
import { ParityMapping } from './ParityMapping.js';
import { CATEGORY_LABEL, CATEGORY_NOTE, type DocumentedOutcome, type ImportBatchView, type NotImportedView, PARITY_CATEGORY_LABEL, type ParityResponse, type ParityRowView, type UnassignedView, parityEditable, OUTCOME_LABEL, SKIP_WARNING, SOURCE_LABEL, STAGE_STATUS, blockingEarlier, canSkipStage, canUndoStage, consentNeedsDryRunToSkip, isRunning, nextStep, ordered, reconciles, recordSummary, reportSaysNotImported, spotChecksReady, toBase64 } from './lib.js';

const IMPORTS_KEY = ['imports'] as const;
const POLL_MS = 2000;

/** GETs on import routes need a fresh password confirmation too: ask once, then fetch. */
function useImportsQuery<T>(key: readonly unknown[], path: string, o: { enabled?: boolean; poll?: (d: T | undefined) => boolean } = {}) {
  const api = useApi();
  const withReauth = useWithReauth();
  return useQuery<T, ApiError>({
    queryKey: key,
    enabled: o.enabled ?? true,
    queryFn: ({ signal }) => withReauth(() => api.get<T>(path, { signal })),
    refetchInterval: (q) => (o.poll?.(q.state.data) ? POLL_MS : false),
  });
}

// ---- list + new import ----------------------------------------------------------------------------

export function ImportsPage() {
  const q = useImportsQuery<{ batches: ImportBatch[] }>(IMPORTS_KEY, '/imports');
  return (
    <div className="flex w-full max-w-3xl flex-col gap-8">
      <NewImport />
      <Section title="Imports">
        {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
        {q.isError ? <QueryError error={q.error} retry={() => void q.refetch()} /> : null}
        {q.data && q.data.batches.length === 0 ? <EmptyState icon="upload" title="No imports yet" /> : null}
        <ul className="flex flex-col gap-2">
          {q.data?.batches.map((b) => {
            const verified = b.stages.filter((s) => s.status === 'verified').length;
            return (
              <li key={b.id}>
                <Link to={`/imports/${b.id}`} className="block rounded-2xl border border-line bg-surface p-4 active:bg-surface-2">
                  <p className="text-[16px] font-semibold text-ink">
                    {SOURCE_LABEL[b.source]}
                    {b.fileLabel ? ` · ${b.fileLabel}` : ''}
                  </p>
                  <p className="text-[14px] text-ink-muted">
                    Started {formatStamp(b.createdAt)} · {verified} of {plural(b.stages.length, 'category', 'categories')} verified
                    {b.revertedAt ? ' · undone' : ''}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}

function QueryError({ error, retry }: { error: ApiError; retry(): void }) {
  return (
    <Notice
      tone="error"
      action={
        <Button variant="secondary" onClick={retry}>
          Try again
        </Button>
      }
    >
      {messageFor(error, ADMIN_MESSAGES)}
    </Notice>
  );
}

type Source = 'csv' | 'fub_api' | 'fub_export';

function NewImport() {
  const navigate = useNavigate();
  const [source, setSource] = useState<Source>('fub_api');
  const [key, setKey] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const a = useAction<Record<string, unknown>, { batch: ImportBatch }>('POST', { invalidate: [[...IMPORTS_KEY]] });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let body: Record<string, unknown>;
    if (source === 'fub_api') body = { source, apiKey: key.trim() };
    else {
      if (!file) return;
      body = { source, fileName: file.name, fileBase64: toBase64(new Uint8Array(await file.arrayBuffer())) };
    }
    const r = await a.run('/imports', body);
    if (r.ok) navigate(`/imports/${r.data.batch.id}`);
  };
  return (
    <Section title="Start an import" description="First we only count what is there. Nothing is imported until you review and approve each category.">
      <Card>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <Segmented<Source>
            label="Import from"
            value={source}
            onChange={setSource}
            options={[
              { value: 'fub_api', label: 'Follow Up Boss' },
              { value: 'fub_export', label: 'FUB export file' },
              { value: 'csv', label: 'CSV file' },
            ]}
          />
          {source === 'fub_api' ? (
            <TextField label="Follow Up Boss API key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} hint="In Follow Up Boss: Admin → API. The key is stored encrypted and deleted at the latest 30 days after the import is verified." />
          ) : (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="import-file" className="text-[15px] font-medium text-ink">
                File
              </label>
              <input id="import-file" type="file" accept={source === 'csv' ? '.csv,text/csv' : undefined} onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="min-h-tap text-[16px] text-ink" />
              <p className="text-[14px] text-ink-muted">{source === 'csv' ? 'Up to 50,000 rows. Phone numbers without an area code are listed for review, not guessed.' : 'The export file from Follow Up Boss.'}</p>
            </div>
          )}
          <ErrorLine message={a.error?.message} />
          <div>
            <Button type="submit" pending={a.pending} pendingLabel="Counting" disabled={source === 'fub_api' ? key.trim().length < 8 : !file}>
              Count what's there
            </Button>
          </div>
        </form>
      </Card>
    </Section>
  );
}

// ---- one import -----------------------------------------------------------------------------------

export function ImportPage() {
  const { importId = '' } = useParams();
  const [status, announce] = useAnnounce();
  const q = useImportsQuery<{ batch: ImportBatchView }>([...IMPORTS_KEY, importId], `/imports/${importId}`, { poll: (d) => (d ? isRunning(d.batch) : false) });
  const b = q.data?.batch;
  const stages = b ? ordered(b.stages) : [];
  return (
    <div className="flex w-full max-w-4xl flex-col gap-6">
      <Link to="/imports" className="inline-flex min-h-tap items-center text-[15px] text-accent">
        All imports
      </Link>
      <StatusLine text={status} />
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <QueryError error={q.error} retry={() => void q.refetch()} /> : null}
      {b ? (
        <>
          <Overview batch={b} onDone={announce} />
          {b.source === 'csv' && b.csv && !b.stages.some((s) => ['approved', 'committing', 'committed', 'verified'].includes(s.status)) ? <CsvMapping batch={b} onDone={announce} /> : null}
          {b.source !== 'csv' && b.snapshotSha256 && b.stages.some((s) => s.category === 'ownership' && !['verified', 'skipped', 'committed', 'committing'].includes(s.status)) ? <UserMappings batch={b} onDone={announce} /> : null}
          {b.snapshotSha256 && parityEditable(b.stages) ? <Parity batch={b} onDone={announce} /> : null}
          <Section title="Categories" description="Each category is checked, approved, imported and verified on its own. A category imports only after the ones above it are verified or skipped.">
            <ol className="flex flex-col gap-3">
              {stages.map((s) => (
                <li key={s.id}>
                  <StageCard batch={b} stage={s} stages={stages} onDone={announce} />
                </li>
              ))}
            </ol>
          </Section>
          <Report batch={b} />
          <Undo batch={b} onDone={announce} />
        </>
      ) : null}
    </div>
  );
}

/** PARITY 65: the stage map / tag / custom-field section (loaded once the snapshot exists). */
function Parity({ batch, onDone }: { batch: ImportBatch; onDone(t: string): void }) {
  const q = useImportsQuery<ParityResponse>([...batchKey(batch.id), 'parity', batch.snapshotSha256], `/imports/${batch.id}/parity`);
  if (q.isError) return <QueryError error={q.error} retry={() => void q.refetch()} />;
  if (!q.data) return null;
  return <ParityMapping key={JSON.stringify(q.data.options)} batch={batch} data={q.data} onDone={onDone} refetch={() => void q.refetch()} />;
}

function batchKey(id: string) {
  return [...IMPORTS_KEY, id];
}

function Overview({ batch, onDone }: { batch: ImportBatchView; onDone(t: string): void }) {
  const snap = useAction<Record<string, never>, { batch: ImportBatch }>('POST', { invalidate: [batchKey(batch.id)] });
  return (
    <Section title={`${SOURCE_LABEL[batch.source]}${batch.fileLabel ? ` · ${batch.fileLabel}` : ''}`} description={`Started ${formatStamp(batch.createdAt)}`}>
      <Card className="flex flex-col gap-2">
        <h3 className="text-[16px] font-semibold text-ink">What's there</h3>
        <ul className="flex flex-col gap-0.5 text-[15px] text-ink">
          {batch.connectionTest.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        {/* owner decision B7: tasks and appointments are counted and never imported, said plainly before anything else happens */}
        {batch.notImported && batch.notImported.lines.length > 0 ? (
          <section aria-label="What doesn't come over" className="flex flex-col gap-1">
            <h4 className="text-[15px] font-semibold text-ink">What doesn't come over</h4>
            {batch.notImported.lines.map((l) => (
              <Notice key={l} tone="warn">
                {l}
              </Notice>
            ))}
          </section>
        ) : null}
        {batch.snapshotError ? <Notice tone="error">The snapshot stopped: {batch.snapshotError}. Take it again.</Notice> : null}
        {batch.snapshotSha256 ? (
          <p className="text-[14px] text-ink-muted">Working from the snapshot taken {formatStamp(batch.snapshotAt)}. Changes made in the source after that need a new snapshot.</p>
        ) : batch.status === 'snapshotting' ? (
          <p className="text-[15px] text-ink">Taking the snapshot…</p>
        ) : (
          <p className="text-[15px] text-ink">Nothing has been imported. Next, take a snapshot: every later step works from that copy.</p>
        )}
        {/* a file never changes, so a CSV/export batch takes its one snapshot; a live FUB source can take a new one (E42) */}
        {(batch.source === 'fub_api' || !batch.snapshotSha256) && batch.status !== 'snapshotting' && batch.status !== 'reverted' && batch.status !== 'abandoned' ? (
          <div>
            <Button variant={batch.snapshotSha256 ? 'quiet' : 'primary'} pending={snap.pending} onClick={async () => (await snap.run(`/imports/${batch.id}/snapshot`, {})).ok && onDone('Snapshot started')}>
              {batch.snapshotSha256 ? 'Take a new snapshot' : 'Take snapshot'}
            </Button>
          </div>
        ) : null}
        <ErrorLine message={snap.error?.message} />
      </Card>
    </Section>
  );
}

const CSV_FIELDS = ['ignore', 'first_name', 'last_name', 'full_name', 'phone', 'phone_mobile', 'phone_home', 'phone_work', 'email', 'email_work', 'tags', 'contact_type', 'stage', 'intent', 'address_line1', 'address_line2', 'city', 'region', 'postal_code', 'country', 'lead_source', 'external_id', 'consent_sms', 'consent_email', 'consent_voice', 'opted_out', 'unsubscribed', 'do_not_contact', 'custom'] as const;

type ColumnTarget = { field: string; key?: string };

function CsvMapping({ batch, onDone }: { batch: ImportBatch; onDone(t: string): void }) {
  const headers = batch.csv?.headers ?? [];
  const [map, setMap] = useState<ColumnTarget[]>(() => headers.map((_, i) => (batch.csv?.mapping[i] as ColumnTarget | undefined) ?? { field: 'ignore' }));
  const a = useAction<{ mapping: ColumnTarget[] }, { batch: ImportBatch }>('PUT', { invalidate: [batchKey(batch.id)] });
  return (
    <Section title="Columns" description="Check what each column of your file holds. Changing this resets dry runs that were not imported yet.">
      <Card className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {headers.map((h, i) => (
          <SelectField
            key={`${h}:${i}`}
            label={h || `Column ${i + 1}`}
            value={map[i]?.field ?? 'ignore'}
            onChange={(e) => setMap((m) => m.map((x, j) => (j === i ? (e.target.value === 'custom' ? { field: 'custom', key: (h || `column_${i + 1}`).replace(/[^A-Za-z0-9_ -]/g, '').slice(0, 64) || `column_${i + 1}` } : { field: e.target.value }) : x)))}
          >
            {CSV_FIELDS.map((f) => (
              <option key={f} value={f}>
                {f === 'ignore' ? "Don't import" : f === 'custom' ? 'Keep as a custom field' : f.replace(/_/g, ' ')}
              </option>
            ))}
          </SelectField>
        ))}
      </Card>
      <ErrorLine message={a.error?.message} />
      <div>
        <Button variant="secondary" pending={a.pending} onClick={async () => (await a.run(`/imports/${batch.id}/csv-mapping`, { mapping: map.map((m) => (m.field === 'custom' ? { field: 'custom', key: m.key ?? 'custom' } : { field: m.field })) })).ok && onDone('Columns saved')}>
          Save columns
        </Button>
      </div>
    </Section>
  );
}

function UserMappings({ batch, onDone }: { batch: ImportBatch; onDone(t: string): void }) {
  const api = useApi();
  const q = useImportsQuery<MappingsResponse>([...batchKey(batch.id), 'mappings'], `/imports/${batch.id}/user-mappings`);
  const members = useQuery<MembersResponse, ApiError>({ queryKey: ['admin', 'members'], queryFn: ({ signal }) => api.get('/members', { signal }) });
  const ponds = useQuery<{ ponds: Pond[] }, ApiError>({ queryKey: ['admin', 'ponds'], queryFn: ({ signal }) => api.get('/ponds', { signal }) });
  const [edits, setEdits] = useState<Map<string, string>>(new Map());
  const a = useAction<{ mappings: unknown[] }, MappingsResponse>('PUT', { invalidate: [[...batchKey(batch.id), 'mappings'], batchKey(batch.id)] });
  const people = (members.data?.members ?? []).filter((m) => m.status === 'active' && m.role !== 'tc');
  const livePonds = (ponds.data?.ponds ?? []).filter((p) => !p.archived);
  const valueOf = (t: MappingsResponse['users'][number]['target']): string => (!t ? '' : t.kind === 'user' ? `user:${t.userId ?? ''}` : t.kind === 'pond' ? `pond:${t.pondId ?? ''}` : 'unassigned');
  const rows = [...(q.data?.users ?? []).map((u) => ({ ...u, kind: 'user' as const })), ...(q.data?.ponds ?? []).map((u) => ({ ...u, kind: 'pond' as const }))];
  const save = async () => {
    const mappings = rows
      .map((r) => {
        const v = edits.get(r.sourceRef) ?? valueOf(r.target);
        if (!v) return null;
        const [k, id] = v.split(':');
        const target = k === 'user' ? { kind: 'user', userId: id } : k === 'pond' ? { kind: 'pond', pondId: id } : { kind: 'unassigned' };
        return { sourceRef: r.sourceRef, kind: r.kind, target };
      })
      .filter(Boolean);
    const r = await a.run(`/imports/${batch.id}/user-mappings`, { mappings });
    if (r.ok) onDone(r.data.complete ? 'Everyone is matched' : `${plural(r.data.unmapped, 'person', 'people')} still to match`);
  };
  return (
    <Section title="Match Follow Up Boss people" description="Every Follow Up Boss agent needs a match here before ownership can be imported. Imported ownership starts no offers, timers or scoreboard counts.">
      {q.isError ? <QueryError error={q.error} retry={() => void q.refetch()} /> : null}
      {q.data ? (
        <>
          <p className="text-[15px] text-ink">{q.data.complete ? 'Everyone is matched.' : `${plural(q.data.unmapped, 'person', 'people')} still to match.`}</p>
          <Card className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {rows.map((r) => (
              <SelectField key={r.sourceRef} label={`${r.label} (${plural(r.people, 'contact')})`} value={edits.get(r.sourceRef) ?? valueOf(r.target)} onChange={(e) => setEdits((m) => new Map(m).set(r.sourceRef, e.target.value))}>
                <option value="">Pick a match</option>
                {people.map((m) => (
                  <option key={m.userId} value={`user:${m.userId}`}>
                    {m.displayName}
                  </option>
                ))}
                {livePonds.map((p) => (
                  <option key={p.id} value={`pond:${p.id}`}>
                    Pond: {p.name}
                  </option>
                ))}
                <option value="unassigned">Nobody (leave unassigned)</option>
              </SelectField>
            ))}
          </Card>
          <ErrorLine message={a.error?.message} />
          <div>
            <Button variant="secondary" pending={a.pending} onClick={() => void save()}>
              Save matches
            </Button>
          </div>
        </>
      ) : null}
    </Section>
  );
}

/** After an undo the import's count is history: say what the undo did, and what it left for a person (verbs agree with the counts). */
export function importedLine(counts: NonNullable<ImportStage['counts']>, stage: Pick<ImportStage, 'status' | 'revert'>): string | null {
  if (counts.imported === null) return null;
  const was = (k: number) => (k === 1 ? 'was' : 'were');
  if (stage.status === 'reverted') {
    const left = typeof stage.revert?.needsDecision === 'number' ? stage.revert.needsDecision : 0;
    const removed = Math.max(0, counts.imported - left);
    return left === 0
      ? `Undone: the ${counts.imported} of ${counts.source} that had been imported ${was(counts.imported)} removed.`
      : `Undone: ${removed} of the ${counts.imported} imported ${was(removed)} removed; ${left} ${left === 1 ? 'was changed since the import and waits' : 'were changed since the import and wait'} for your decision.`;
  }
  if (stage.status === 'reverting') return `Undoing the ${counts.imported} of ${counts.source} that ${was(counts.imported)} imported…`;
  return `${counts.imported} of ${counts.source} imported`;
}

function Counts({ counts, stage }: { counts: NonNullable<ImportStage['counts']>; stage: Pick<ImportStage, 'status' | 'revert'> }) {
  const cells: [string, number][] = [
    ['In the source', counts.source],
    ['Will import', counts.willImport],
    ['Needs review', counts.needsReview],
    ['Rejected', counts.rejected],
    ['Possible duplicates', counts.duplicate],
  ];
  return (
    <div className="flex flex-col gap-1">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {cells.map(([l, n]) => (
          <div key={l} className="rounded-xl bg-surface-2 px-3 py-2">
            <dt className="text-[13px] text-ink-muted">{l}</dt>
            <dd className="text-[18px] font-semibold tabular-nums text-ink">{n}</dd>
          </div>
        ))}
      </dl>
      {counts.imported !== null ? <p className="text-[15px] tabular-nums text-ink">{importedLine(counts, stage)}</p> : null}
      {!reconciles(counts) ? <p className="text-[14px] text-warn">These counts don't add up to the source total. Run the dry run again before approving.</p> : null}
    </div>
  );
}

function StageCard({ batch, stage, stages, onDone }: { batch: ImportBatch; stage: ImportStage; stages: ImportStage[]; onDone(t: string): void }) {
  const [reviewing, setReviewing] = useState(false);
  const step = nextStep(stage, batch);
  const blockers = blockingEarlier(stage, stages);
  const inv = { invalidate: [batchKey(batch.id), [...IMPORTS_KEY]] };
  const dry = useAction<Record<string, never>, unknown>('POST', inv);
  const approve = useAction<{ snapshotSha256: string }, unknown>('POST', inv);
  const commit = useAction<Record<string, never>, unknown>('POST', inv);
  const skip = useAction<Record<string, never>, unknown>('POST', inv);
  const undo = useAction<{ category: string }, unknown>('POST', inv);
  const base = `/imports/${batch.id}/stages/${stage.category}`;
  const label = CATEGORY_LABEL[stage.category];
  const failure = dry.error ?? approve.error ?? commit.error ?? skip.error ?? undo.error;
  const canUndo = canUndoStage(stage, stages, batch);
  const canSkip = canSkipStage(stage, stages, batch);
  const skipNeedsDryRun = consentNeedsDryRunToSkip(stage, stages, batch) && batch.status !== 'reverted' && ['pending', 'failed'].includes(stage.status);
  return (
    <Card className="flex flex-col gap-3" as="article" aria-labelledby={`stage-${stage.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`stage-${stage.id}`} className="flex-1 text-[17px] font-semibold text-ink">
          {stage.seq}. {label}
        </h3>
        <Pill tone={stage.status === 'verified' ? 'ok' : stage.status === 'failed' ? 'danger' : stage.status === 'committed' || stage.status === 'dry_run_ready' ? 'warn' : 'neutral'}>{STAGE_STATUS[stage.status] ?? stage.status}</Pill>
      </div>
      {CATEGORY_NOTE[stage.category] ? <p className="text-[15px] text-ink">{CATEGORY_NOTE[stage.category]}</p> : null}
      {stage.counts ? <Counts counts={stage.counts} stage={stage} /> : null}
      {(canSkip || skipNeedsDryRun) && SKIP_WARNING[stage.category] ? <p className="text-[14px] text-ink-muted">{SKIP_WARNING[stage.category]}</p> : null}
      {skipNeedsDryRun ? <p className="text-[14px] text-ink-muted">To skip it, run its dry run first, so you can see which opt-outs would not carry over.</p> : null}
      {stage.blockers.map((x, i) => (
        <Notice key={`${x.code}:${i}`} tone="warn">
          {x.sentence}
        </Notice>
      ))}
      {stage.verifiedAt ? <p className="text-[14px] text-ink-muted">Verified {formatStamp(stage.verifiedAt)} after the recount and side-by-side checks.</p> : null}
      {step === 'running' ? <p className="text-[15px] text-ink">{STAGE_STATUS[stage.status]}… this page updates on its own.</p> : null}
      <div className="flex flex-wrap gap-2">
        {step === 'dry_run' || step === 'review' ? (
          <Button variant={step === 'dry_run' ? 'primary' : 'quiet'} pending={dry.pending} onClick={async () => (await dry.run(`${base}/dry-run`, {})).ok && onDone(`${label}: dry run started`)}>
            {step === 'dry_run' ? 'Run dry run' : 'Run the dry run again'}
          </Button>
        ) : null}
        {step === 'review' ? (
          <>
            <Button variant="secondary" onClick={() => setReviewing((v) => !v)}>
              {reviewing ? 'Close review list' : 'Review records'}
            </Button>
            {/* the approval presents the digest of THIS dry run (what the reviewer saw), not the batch's snapshot file digest (E42) */}
            <Button pending={approve.pending} disabled={!stage.dryRunSha256 || stage.blockers.length > 0} onClick={async () => (await approve.run(`${base}/approve`, { snapshotSha256: stage.dryRunSha256! })).ok && onDone(`${label}: approved`)}>
              Approve these {stage.counts ? stage.counts.willImport : ''} records
            </Button>
          </>
        ) : null}
        {step === 'commit' ? (
          <Button pending={commit.pending} disabled={blockers.length > 0} onClick={async () => (await commit.run(`${base}/commit`, {})).ok && onDone(`${label}: importing`)}>
            Import {label.toLowerCase()}
          </Button>
        ) : null}
        {canSkip ? (
          <Button variant="quiet" pending={skip.pending} onClick={async () => (await skip.run(`${base}/skip`, {})).ok && onDone(`${label}: skipped`)}>
            Skip this category
          </Button>
        ) : null}
        {canUndo ? (
          <Button variant="quiet" pending={undo.pending} onClick={async () => (await undo.run(`/imports/${batch.id}/revert`, { category: stage.category })).ok && onDone(`${label}: undo started`)}>
            Undo this category
          </Button>
        ) : null}
      </div>
      {step === 'commit' && blockers.length > 0 ? <p className="text-[14px] text-ink-muted">Waiting for {blockers.map((b) => CATEGORY_LABEL[b.category]).join(', ')} to be verified or skipped.</p> : null}
      {step === 'review' ? <p className="text-[14px] text-ink-muted">Approving imports exactly what this dry run found, plus your review decisions. Nothing else.</p> : null}
      {reviewing && step === 'review' ? <ReviewList batch={batch} stage={stage} /> : null}
      {step === 'verify' ? <Verify batch={batch} stage={stage} onDone={onDone} /> : null}
      <ErrorLine message={failure?.message} />
    </Card>
  );
}

const OUTCOMES = ['needs_review', 'duplicate', 'rejected', 'will_import'] as const;

function ReviewList({ batch, stage }: { batch: ImportBatch; stage: ImportStage }) {
  const [outcome, setOutcome] = useState<(typeof OUTCOMES)[number]>(stage.counts && stage.counts.needsReview === 0 && stage.counts.duplicate > 0 ? 'duplicate' : 'needs_review');
  const [after, setAfter] = useState<string[]>([]);
  const cursor = after.at(-1);
  const path = `/imports/${batch.id}/stages/${stage.category}/records?outcome=${outcome}&limit=50${cursor ? `&after=${cursor}` : ''}`;
  const q = useImportsQuery<{ records: ImportRecord[]; next: string | null }>([...batchKey(batch.id), 'records', stage.category, outcome, cursor ?? ''], path);
  const count = (o: string) => (stage.counts ? { needs_review: stage.counts.needsReview, duplicate: stage.counts.duplicate, rejected: stage.counts.rejected, will_import: stage.counts.willImport }[o] ?? 0 : 0);
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line p-3">
      <Segmented
        label="Show records"
        value={outcome}
        onChange={(v) => {
          setOutcome(v);
          setAfter([]);
        }}
        options={OUTCOMES.map((o) => ({ value: o, label: `${OUTCOME_LABEL[o]} ${count(o)}` }))}
      />
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <QueryError error={q.error} retry={() => void q.refetch()} /> : null}
      {q.data && q.data.records.length === 0 ? <p className="text-[15px] text-ink-muted">No records here.</p> : null}
      <ul className="flex flex-col gap-2">
        {q.data?.records.map((r) => (
          <li key={r.id}>
            <RecordRow batch={batch} record={r} />
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        {after.length > 0 ? (
          <Button variant="quiet" onClick={() => setAfter((a) => a.slice(0, -1))}>
            Previous
          </Button>
        ) : null}
        {q.data?.next ? (
          <Button variant="secondary" onClick={() => setAfter((a) => [...a, q.data!.next!])}>
            Next 50
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function RecordRow({ batch, record }: { batch: ImportBatch; record: ImportRecord }) {
  const a = useAction<{ decision: string; mergeIntoContactId?: string }, { record: ImportRecord }>('POST', { invalidate: [batchKey(batch.id)] });
  const [decided, setDecided] = useState<string | null>(record.review?.decision ?? null);
  const decide = async (decision: 'import' | 'merge' | 'reject', mergeIntoContactId?: string) => {
    const r = await a.run(`/imports/${batch.id}/records/${record.id}/review`, { decision, ...(mergeIntoContactId ? { mergeIntoContactId } : {}) });
    if (r.ok) setDecided(decision);
  };
  const reviewable = record.outcome === 'needs_review' || record.outcome === 'duplicate';
  const candidate = record.duplicateCandidates[0];
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-surface-2 p-3">
      <p className="text-[15px] text-ink">{recordSummary(record.record)}</p>
      <p className="text-[13px] text-ink-muted">
        {record.sourceRef}
        {record.planned ? ` · ${record.planned}` : ''}
      </p>
      {record.issues.map((x, i) => (
        <p key={`${x.code}:${i}`} className="text-[14px] text-ink">
          {x.sentence}
        </p>
      ))}
      {record.optOutNote ? <p className="text-[14px] text-ink">{record.optOutNote}</p> : null}
      {record.duplicateCandidates.length > 0 ? (
        <p className="text-[14px] text-ink">
          Looks like{' '}
          {record.duplicateCandidates.map((c, i) => (
            <span key={c.contactId}>
              {i > 0 ? ', ' : ''}
              <Link to={`/contacts/${c.contactId}`} className="text-accent underline">
                a contact you have
              </Link>{' '}
              ({c.reason.replace(/_/g, ' ')})
            </span>
          ))}
          . Names alone are never merged automatically.
        </p>
      ) : null}
      {reviewable ? (
        <div className="flex flex-wrap items-center gap-2">
          {decided ? <Pill tone="accent">Decided: {decided === 'import' ? 'import' : decided === 'merge' ? 'merge' : "don't import"}</Pill> : null}
          <Button variant="secondary" pending={a.pending} onClick={() => void decide('import')}>
            Import it
          </Button>
          {candidate ? (
            <Button variant="secondary" pending={a.pending} onClick={() => void decide('merge', candidate.contactId)}>
              Merge into existing
            </Button>
          ) : null}
          <Button variant="quiet" pending={a.pending} onClick={() => void decide('reject')}>
            Don't import
          </Button>
        </div>
      ) : null}
      <ErrorLine message={a.error?.message} />
    </div>
  );
}

function Verify({ batch, stage, onDone }: { batch: ImportBatch; stage: ImportStage; onDone(t: string): void }) {
  const base = `/imports/${batch.id}/stages/${stage.category}`;
  const q = useImportsQuery<VerificationResponse & { approved?: ImportCounts; documented?: DocumentedOutcome[] }>([...batchKey(batch.id), 'verification', stage.category], `${base}/verification`);
  const [marks, setMarks] = useState<Map<string, boolean>>(new Map());
  const a = useAction<{ spotChecks: { sourceRef: string; matches: boolean }[] }, { batch: ImportBatch }>('POST', { invalidate: [batchKey(batch.id), [...IMPORTS_KEY]] });
  const v = q.data;
  // owner decision B4: outcomes the commit documented (people brought in unassigned) change what is expected; both are shown
  const documented = v?.documented ?? [];
  const approved = documented.length > 0 ? (v?.approved ?? null) : null;
  const ready = v ? spotChecksReady(v.sample, marks) : false;
  const anyMismatch = [...marks.values()].some((m) => !m);
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line p-3">
      <h4 className="text-[16px] font-semibold text-ink">Verify {CATEGORY_LABEL[stage.category].toLowerCase()}</h4>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Recounting</p> : null}
      {q.isError ? <QueryError error={q.error} retry={() => void q.refetch()} /> : null}
      {v ? (
        <>
          {/* a table wider than a phone scrolls inside this box, so the box takes keyboard focus (axe scrollable-region-focusable) */}
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={`Recount of ${CATEGORY_LABEL[stage.category].toLowerCase()}`}>
            <table className="w-full text-left text-[15px]">
              <thead className="text-[13px] text-ink-muted">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-semibold">
                    Count
                  </th>
                  {approved ? (
                    <th scope="col" className="py-1 pr-3 font-semibold">
                      Approved
                    </th>
                  ) : null}
                  <th scope="col" className="py-1 pr-3 font-semibold">
                    Expected
                  </th>
                  <th scope="col" className="py-1 font-semibold">
                    Found
                  </th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {(['source', 'imported', 'needs_review', 'rejected', 'duplicate'] as const).map((k) => (
                  <tr key={k} className="border-t border-line">
                    <th scope="row" className="py-1 pr-3 font-normal text-ink">
                      {k === 'source' ? 'In the source' : (OUTCOME_LABEL[k] ?? k)}
                    </th>
                    {approved ? <td className="py-1 pr-3 text-ink-muted">{approved[k]}</td> : null}
                    <td className="py-1 pr-3 text-ink">{v.expected[k]}</td>
                    <td className={`py-1 ${v.expected[k] === v.db[k] ? 'text-ink' : 'font-semibold text-danger'}`}>{v.db[k]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {documented.map((d) => (
            <Notice key={d.code} tone="info">
              {d.sentence}
            </Notice>
          ))}
          {v.matches ? <Notice tone="ok">The recount matches.</Notice> : <Notice tone="error">The recount does not match, so this can't be verified. Undo this category and check the source.</Notice>}
          {v.sample.length > 0 ? <p className="text-[15px] text-ink">Compare {plural(v.sample.length, 'record')} side by side and mark each one.</p> : null}
          <ul className="flex flex-col gap-2">
            {v.sample.map((s) => (
              <li key={s.recordId} className="grid grid-cols-1 gap-2 rounded-xl bg-surface-2 p-3 md:grid-cols-[1fr_1fr_auto] md:items-start">
                <div>
                  <p className="text-[13px] font-semibold text-ink-muted">In the source</p>
                  <p className="break-words text-[15px] text-ink">{recordSummary(s.source)}</p>
                </div>
                <div>
                  <p className="text-[13px] font-semibold text-ink-muted">Imported</p>
                  <p className="break-words text-[15px] text-ink">{s.imported ? recordSummary(s.imported) : 'Not found'}</p>
                </div>
                <div className="flex gap-2" role="group" aria-label={`Check ${s.sourceRef}`}>
                  <Button variant={marks.get(s.sourceRef) === true ? 'primary' : 'secondary'} aria-pressed={marks.get(s.sourceRef) === true} onClick={() => setMarks((m) => new Map(m).set(s.sourceRef, true))}>
                    Same
                  </Button>
                  <Button variant={marks.get(s.sourceRef) === false ? 'danger' : 'secondary'} aria-pressed={marks.get(s.sourceRef) === false} onClick={() => setMarks((m) => new Map(m).set(s.sourceRef, false))}>
                    Different
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {anyMismatch ? <Notice tone="warn">A record you marked different means this category should not be verified. Undo it below and check the source.</Notice> : null}
          <ErrorLine message={a.error?.message} />
          <div>
            <Button
              pending={a.pending}
              disabled={!v.matches || !ready || anyMismatch}
              onClick={async () => (await a.run(`${base}/verify`, { spotChecks: v.sample.map((s) => ({ sourceRef: s.sourceRef, matches: marks.get(s.sourceRef) === true })) })).ok && onDone(`${CATEGORY_LABEL[stage.category]}: verified`)}
            >
              Mark verified
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** The parity table's second count: what a dry run would import, what the import wrote, or what it wrote before an undo. */
export function parityImportedHeader(phase: string): string {
  return phase === 'dry_run' ? 'Will import' : phase === 'reverted' ? 'Imported, then undone' : 'Imported';
}

type ReportView = Omit<ReportResponse, 'categories'> & {
  categories: (ReportResponse['categories'][number] & { unassigned?: UnassignedView | null })[];
  parity?: { phase: string; rows: ParityRowView[]; lines: string[] } | null;
  /** owner decision B7: what Follow Up Boss holds that the import does not bring over */
  notImported?: Omit<NotImportedView, 'countedAt'> | null;
};

function Report({ batch }: { batch: ImportBatch }) {
  const q = useImportsQuery<ReportView>([...batchKey(batch.id), 'report', batch.stages.map((s) => s.status).join()], `/imports/${batch.id}/report`);
  if (!q.data) return null;
  const lines = q.data.categories.flatMap((c) => c.lines.map((l) => ({ c: c.category, l })));
  const parity = q.data.parity ?? null;
  const unassigned = q.data.categories.find((c) => c.category === 'ownership')?.unassigned ?? null;
  // owner decision B7: the final report says what doesn't come over once something was imported; until then the
  // "What doesn't come over" notice above is the one place it is said (review F3: no report of that sentence alone)
  const left = reportSaysNotImported(batch.stages) ? (q.data.notImported?.lines ?? []) : [];
  if (lines.length === 0 && !parity && !unassigned && left.length === 0) return null;
  return (
    <Section title="Report">
      {lines.length > 0 ? (
        <Card>
          <ul className="flex flex-col gap-1 text-[15px] text-ink">
            {lines.map(({ c, l }, i) => (
              <li key={`${c}:${i}`}>
                <span className="font-semibold">{CATEGORY_LABEL[c]}:</span> {l}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {parity ? (
        <Card className="flex flex-col gap-2">
          <h3 className="text-[16px] font-semibold text-ink">Stages, tags and custom fields</h3>
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Counts for stages, tags and fields">
            <table className="w-full text-left text-[15px] text-ink">
              <caption className="sr-only">Stages, tags and custom fields: in the source, {parityImportedHeader(parity.phase).toLowerCase()}, needs review, not imported, already here</caption>
              <thead>
                <tr className="text-[13px] text-ink-muted">
                  <th scope="col" className="py-1 pr-3 font-medium">What</th>
                  <th scope="col" className="py-1 pr-3 font-medium">In the source</th>
                  <th scope="col" className="py-1 pr-3 font-medium">{parityImportedHeader(parity.phase)}</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Needs review</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Not imported</th>
                  <th scope="col" className="py-1 font-medium">Already here</th>
                </tr>
              </thead>
              <tbody>
                {parity.rows.map((r) => (
                  <tr key={r.category}>
                    <th scope="row" className="py-1 pr-3 font-semibold">{PARITY_CATEGORY_LABEL[r.category]}</th>
                    <td className="py-1 pr-3 tabular-nums">{r.source}</td>
                    <td className="py-1 pr-3 tabular-nums">{r.imported}</td>
                    <td className="py-1 pr-3 tabular-nums">{r.needsReview}</td>
                    <td className="py-1 pr-3 tabular-nums">{r.rejected}</td>
                    <td className="py-1 tabular-nums">{r.duplicate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-col gap-1 text-[15px] text-ink">
            {parity.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </Card>
      ) : null}
      {unassigned ? <UnassignedPeople view={unassigned} onClosed={() => void q.refetch()} /> : null}
      {left.length > 0 ? (
        <section aria-label="Not brought over">
          <Card className="flex flex-col gap-2">
            <h3 className="text-[16px] font-semibold text-ink">Not brought over</h3>
            {left.map((l) => (
              <p key={l} className="text-[15px] text-ink">
                {l}
              </p>
            ))}
          </Card>
        </section>
      ) : null}
    </Section>
  );
}

/**
 * Owner decision B4 (2026-11-11): the people the ownership commit brought in unassigned, because the member they were
 * matched to could no longer hold leads, each with the reason. "Assign these people" opens the existing bulk Assign
 * (parity module 64's sheet) with exactly the ones still unassigned selected by id; the server decides each person
 * again, and the sheet only offers members who can hold leads. What is true of each person now, and the summary, are
 * the server's words (review B4-R1: "has an owner" only of someone owned; closed, deleted, merged away, in a pond or
 * on offer are said so). A deleted person is named, not linked: their contact is gone from the book. A person merged
 * away since is linked to the record they live on now (review F7). Where they are now (`summary`) is said here, next to
 * the button it names, and nowhere else on the page (review F8). Owner decision D8 (2026-11-12): a person who asked
 * again since was routed like a returning lead; the server's sentence says when and to whom, before where they are now.
 */
function UnassignedPeople({ view, onClosed }: { view: UnassignedView; onClosed(): void }) {
  const { session } = useSession();
  const [open, setOpen] = useState(false);
  const still = view.stillUnassigned;
  const selected = view.contactIds.length;
  return (
    <section aria-label="People who came in unassigned">
      <Card className="flex flex-col gap-2">
        <h3 className="text-[16px] font-semibold text-ink">People who came in unassigned</h3>
        <ul className="flex flex-col gap-1 text-[15px] text-ink">
          {view.people.map((p) => (
            <li key={p.contactId}>
              {p.now === 'deleted' ? (
                <span className="font-semibold">{p.name}</span>
              ) : (
                // review F7: a person merged into another contact since lives on that one; the old record is closed
                <Link to={`/contacts/${p.now === 'merged' && p.mergedIntoContactId ? p.mergedIntoContactId : p.contactId}`} className="font-semibold text-accent underline">
                  {p.name}
                </Link>
              )}{' '}
              {p.sentence}
              {p.askedAgainSentence ? <span> {p.askedAgainSentence}</span> : null}
              {p.nowSentence ? <span className="text-ink-muted"> {p.nowSentence}</span> : null}
            </li>
          ))}
        </ul>
        {view.total > view.people.length ? <p className="text-[14px] text-ink-muted">And {plural(view.total - view.people.length, 'more person', 'more people')}.</p> : null}
        {view.summary.map((l) => (
          <p key={l} className="text-[15px] text-ink">
            {l}
          </p>
        ))}
        {still > selected ? <p className="text-[14px] text-ink-muted">The first {selected} are selected; assign the rest after.</p> : null}
        {selected > 0 && mayBulkAssign(session?.tenant?.role) ? (
          <div>
            <Button onClick={() => setOpen(true)}>{selected === 1 ? 'Assign this person' : 'Assign these people'}</Button>
          </div>
        ) : null}
      </Card>
      {open ? (
        <BulkActionSheet
          kind="assign"
          contactIds={view.contactIds}
          selectedText={plural(selected, 'person', 'people')}
          onClose={() => {
            setOpen(false);
            onClosed();
          }}
        />
      ) : null}
    </section>
  );
}

function Undo({ batch, onDone }: { batch: ImportBatch; onDone(t: string): void }) {
  const [confirm, setConfirm] = useState(false);
  const revert = useAction<{ category?: string }, unknown>('POST', { invalidate: [batchKey(batch.id), [...IMPORTS_KEY]] });
  const abandon = useAction<Record<string, never>, unknown>('POST', { invalidate: [batchKey(batch.id), [...IMPORTS_KEY]] });
  const committed = batch.stages.some((s) => ['committed', 'verified'].includes(s.status));
  const fub = batch.source === 'fub_api';
  if (batch.status === 'reverted' || batch.status === 'abandoned') return <Notice tone="info">{batch.status === 'reverted' ? 'This import was undone.' : 'This import was stopped and the Follow Up Boss key deleted.'}</Notice>;
  return (
    <Section title="Undo or stop" description="Undo removes what this import added and was not touched since. Anything people edited, messaged or reassigned is listed for you to decide, never deleted. Imported opt-outs always stay.">
      <div className="flex flex-wrap gap-2">
        {committed ? (
          confirm ? (
            <>
              <Button variant="danger" pending={revert.pending} onClick={async () => (await revert.run(`/imports/${batch.id}/revert`, {})).ok && (setConfirm(false), onDone('Undo started'))}>
                Undo the whole import
              </Button>
              <Button variant="quiet" onClick={() => setConfirm(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setConfirm(true)}>
              Undo this import
            </Button>
          )
        ) : null}
        {fub ? (
          <Button variant="quiet" pending={abandon.pending} onClick={async () => (await abandon.run(`/imports/${batch.id}/abandon`, {})).ok && onDone('Stopped; the Follow Up Boss key was deleted')}>
            Stop and delete the Follow Up Boss key
          </Button>
        ) : null}
      </div>
      <ErrorLine message={(revert.error ?? abandon.error)?.message} />
    </Section>
  );
}
