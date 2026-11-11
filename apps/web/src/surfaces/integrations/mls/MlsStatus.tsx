// The MLS page's sync and licence-pack sections (module 41, web/admin-p2), above the Spark key sections.
//
//   GET /admin/mls                                  each MLS connection: status, last sync, "MLS data as of",
//                                                   whether MLS data may reach clients and why not, its licence pack
//   PUT /admin/mls/connections/:id/license-pack     the whole pack, each value with "counsel reviewed it" (re-auth)
//
// R-MLS-2: the pack is counsel-reviewed only when every value is marked; until then the page says MLS data cannot
// reach clients. Changing a value clears its mark: counsel reviewed the value it had, not the new one.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Button, Card, Notice, TextField } from '../../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../../shell/index.js';
import { useRequest } from '../../admin/integrations/request.js';
import { Check, Pill, StatusLine, TextArea } from '../../admin/lib/ui.js';
import {
  DISPLAY_FIELDS,
  FIELD_WORDS,
  KEY_WORDS,
  LISTING_STATUSES,
  MLS_ERROR_MESSAGES,
  type MlsConnection,
  PACK_KEYS,
  type PackKey,
  type PackValues,
  STATUS_WORDS,
  packBody,
  pickMls,
  pickPack,
  reviewWords,
} from './pack.js';

export const MLS_KEY = ['integrations', 'mls', 'admin'] as const;

export function MlsStatus() {
  const api = useApi();
  const q = useQuery<MlsConnection[], ApiError>({ queryKey: MLS_KEY, queryFn: async ({ signal }) => pickMls(await api.get<unknown>('/admin/mls', { signal })) });
  return (
    <>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, MLS_ERROR_MESSAGES)}</Notice> : null}
      {q.data && q.data.length === 0 ? (
        <Section title="MLS sync">
          <p className="text-[16px] text-ink">No MLS connection yet, so no MLS data is read and none reaches clients. The licence pack appears here once there is an MLS connection.</p>
        </Section>
      ) : null}
      {q.data?.map((c) => (
        <ConnectionBlock key={c.id} c={c} several={q.data.length > 1} />
      ))}
    </>
  );
}

function ConnectionBlock({ c, several }: { c: MlsConnection; several: boolean }) {
  const live = c.status === 'connected' || c.status === 'degraded';
  return (
    <>
      <Section title={several ? `MLS sync: ${c.displayName}` : 'MLS sync'}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[16px] font-medium text-ink">{c.displayName}</span>
          <Pill tone={live ? (c.status === 'degraded' ? 'warn' : 'ok') : 'neutral'}>{live ? (c.status === 'degraded' ? 'Connected with problems' : 'Connected') : 'Not connected'}</Pill>
        </div>
        <p className="text-[16px] text-ink">{c.statusSentence.replace(/\s*\([A-Z][A-Z0-9_]+\)/g, '')}</p>
        <dl className="flex flex-col gap-2">
          <Fact label="Last sync">{c.lastSyncedAt ? stamp(c.lastSyncedAt) : 'Never'}</Fact>
          <Fact label="Next sync">{c.nextSyncAt ? stamp(c.nextSyncAt) : live ? 'Not scheduled' : 'None: not connected'}</Fact>
          <Fact label="MLS data">{c.mlsDataAsOf}</Fact>
        </dl>
        {c.feedStale ? <Notice tone="warn">The MLS data is older than the licence pack allows, so MLS listings are paused for clients until the next sync.</Notice> : null}
        <Notice tone={c.clientDisplay ? 'ok' : 'warn'} title={c.clientDisplay ? 'MLS data may reach clients' : 'MLS data does not reach clients'}>
          {c.clientDisplaySentence}
        </Notice>
      </Section>
      <PackEditor key={c.id} c={c} several={several} editable={c.status !== 'disconnected'} />
    </>
  );
}

function PackEditor({ c, several, editable }: { c: MlsConnection; several: boolean; editable: boolean }) {
  const qc = useQueryClient();
  const req = useRequest(MLS_ERROR_MESSAGES);
  const [values, setValues] = useState<PackValues>(c.licensePack.values);
  const [marks, setMarks] = useState<Record<PackKey, boolean>>(c.licensePack.marks);
  const [hours, setHours] = useState(c.licensePack.values.max_staleness_hours === null ? '' : String(c.licensePack.values.max_staleness_hours));
  const [hoursError, setHoursError] = useState<string | null>(null);
  const [changed, setChanged] = useState<Set<PackKey>>(new Set());
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the banner says what is SAVED: ticking boxes does not let MLS data reach clients until the pack is saved
  const [savedMarks, setSavedMarks] = useState<Record<PackKey, boolean>>(c.licensePack.marks);
  const [dirty, setDirty] = useState(false);
  const review = reviewWords(savedMarks);

  const change = <K extends PackKey>(k: K, v: PackValues[K]) => {
    setValues((old) => ({ ...old, [k]: v }));
    // counsel reviewed the value it had, not this one
    setMarks((old) => ({ ...old, [k]: false }));
    setChanged((old) => new Set(old).add(k));
    setDirty(true);
    setStatus(null);
  };
  const mark = (k: PackKey, on: boolean) => {
    setMarks((old) => ({ ...old, [k]: on }));
    setDirty(true);
    setStatus(null);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setStatus(null);
    const h = hours.trim();
    const n = h === '' ? null : Number(h);
    if (n !== null && (!Number.isFinite(n) || n <= 0 || n > 8760)) {
      setHoursError('Enter a number of hours above 0 and at most 8,760, or leave it empty.');
      return;
    }
    setHoursError(null);
    const text = (s: string | null) => (s && s.trim() ? s.trim() : null);
    const next: PackValues = { ...values, max_staleness_hours: n, attribution_text: text(values.attribution_text), disclaimer_text: text(values.disclaimer_text) };
    const r = await req.run<unknown>('save', 'PUT', `/admin/mls/connections/${encodeURIComponent(c.id)}/license-pack`, packBody(next, marks));
    if (!r.ok) {
      setError(r.message);
      return;
    }
    const saved = pickPack((r.data as { licensePack?: unknown } | null)?.licensePack);
    setValues(saved.values);
    setMarks(saved.marks);
    setSavedMarks(saved.marks);
    setDirty(false);
    setHours(saved.values.max_staleness_hours === null ? '' : String(saved.values.max_staleness_hours));
    setChanged(new Set());
    setStatus(saved.unreviewedCount === 0 ? 'Licence pack saved. Every value is marked as reviewed by counsel.' : `Licence pack saved. ${saved.unreviewedCount} of ${PACK_KEYS.length} values are not marked as reviewed, so MLS data still cannot reach clients.`);
    void qc.invalidateQueries({ queryKey: MLS_KEY });
  };

  const markRow = (k: PackKey) => (
    <Check
      label="Counsel reviewed this value"
      hint={changed.has(k) && !marks[k] ? 'Changed: mark it again once counsel has reviewed the new value.' : undefined}
      checked={marks[k]}
      disabled={!editable}
      onChange={(on) => mark(k, on)}
    />
  );

  return (
    <Section title={several ? `Licence pack: ${c.displayName}` : 'Licence pack'} description="The MLS's display rules for this connection. Have counsel review each value against your MLS agreement and mark it here.">
      <Notice tone={review.tone} title={review.title}>
        {review.text}
        {review.tone === 'ok' && c.licensePack.reviewedByCounselAt && changed.size === 0 ? ` Marked complete on ${day(c.licensePack.reviewedByCounselAt)}.` : ''}
      </Notice>
      {!editable ? <p className="text-[15px] text-ink-muted">This connection is disconnected, so its licence pack cannot be changed.</p> : null}
      <form className="flex flex-col gap-4" noValidate onSubmit={(e) => void save(e)}>
        <ul className="flex flex-col gap-3">
          <Value k="max_staleness_hours" reviewed={marks.max_staleness_hours} mark={markRow('max_staleness_hours')}>
            <TextField label={KEY_WORDS.max_staleness_hours.label} hint={KEY_WORDS.max_staleness_hours.hint} inputMode="decimal" value={hours} disabled={!editable} error={hoursError} onChange={(e) => {
              setHours(e.target.value);
              setMarks((old) => ({ ...old, max_staleness_hours: false }));
              setChanged((old) => new Set(old).add('max_staleness_hours'));
              setDirty(true);
              setStatus(null);
            }} />
          </Value>
          {(['attribution_text', 'disclaimer_text'] as const).map((k) => (
            <Value key={k} k={k} reviewed={marks[k]} mark={markRow(k)}>
              <TextArea label={KEY_WORDS[k].label} hint={KEY_WORDS[k].hint} value={values[k] ?? ''} maxLength={4000} disabled={!editable} onChange={(e) => change(k, e.target.value)} />
            </Value>
          ))}
          {(['allow_rehost_photos', 'require_listing_brokerage'] as const).map((k) => (
            <Value key={k} k={k} reviewed={marks[k]} mark={markRow(k)}>
              <Check label={KEY_WORDS[k].label} hint={KEY_WORDS[k].hint} checked={values[k]} disabled={!editable} onChange={(on) => change(k, on)} />
            </Value>
          ))}
          {(['client_fields', 'client_statuses', 'public_fields', 'public_statuses'] as const).map((k) => {
            const options = k.endsWith('_fields') ? DISPLAY_FIELDS : LISTING_STATUSES;
            const words = k.endsWith('_fields') ? FIELD_WORDS : STATUS_WORDS;
            return (
              <Value key={k} k={k} reviewed={marks[k]} mark={markRow(k)}>
                <fieldset className="flex flex-col gap-1">
                  <legend className="text-[15px] font-medium text-ink">{KEY_WORDS[k].label}</legend>
                  <p className="text-[14px] text-ink-muted">{KEY_WORDS[k].hint}</p>
                  <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                    {options.map((o) => (
                      <Check key={o} label={words[o] ?? o} checked={values[k].includes(o)} disabled={!editable} onChange={(on) => change(k, on ? options.filter((x) => x === o || values[k].includes(x)) : values[k].filter((x) => x !== o))} />
                    ))}
                  </div>
                </fieldset>
              </Value>
            );
          })}
        </ul>
        <StatusLine text={status} />
        {error ? <Notice tone="error">{error}</Notice> : null}
        {editable && dirty ? <p className="text-[15px] font-medium text-ink">Not saved yet. {PACK_KEYS.filter((k) => marks[k]).length} of {PACK_KEYS.length} values are ticked as reviewed by counsel.</p> : null}
        {editable ? (
          <div>
            <Button type="submit" pending={req.pending === 'save'} pendingLabel="Saving">
              Save licence pack
            </Button>
          </div>
        ) : null}
      </form>
    </Section>
  );
}

function Value({ k, reviewed, mark, children }: { k: PackKey; reviewed: boolean; mark: ReactNode; children: ReactNode }) {
  return (
    <Card as="li" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="sr-only">{KEY_WORDS[k].label}:</span>
        <Pill tone={reviewed ? 'ok' : 'warn'}>{reviewed ? 'Reviewed by counsel' : 'Not reviewed by counsel'}</Pill>
      </div>
      {children}
      <div className="border-t border-line pt-1">{mark}</div>
    </Card>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div>
        <h2 id={id} className="text-[20px] font-semibold text-ink">
          {title}
        </h2>
        {description ? <p className="text-[15px] text-ink-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="text-[15px] text-ink-muted sm:w-48 sm:shrink-0">{label}</dt>
      <dd className="text-[16px] text-ink">{children}</dd>
    </div>
  );
}

function stamp(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return 'Unknown';
  return t.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function day(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? 'an unknown date' : t.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
