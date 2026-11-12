// The MLS page's sync and licence-pack sections (module 41, web/admin-p2), above the Spark key sections.
//
//   GET /admin/mls                                  each MLS connection: status, last sync, "MLS data as of",
//                                                   whether MLS data may reach clients and why not, its licence pack
//   PUT /admin/mls/connections/:id/license-pack     the whole pack, each value with "counsel reviewed it" (re-auth);
//                                                   the valuation section (D9, its own counsel stamp) is saved apart:
//                                                   the stored display pack as it stands, plus `valuation`
//
// R-MLS-2: the pack is counsel-reviewed only when every value is marked; until then the page says MLS data cannot
// reach clients. Changing a value clears its mark: counsel reviewed the value it had, not the new one.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Button, Card, Notice, TextField } from '../../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../../shell/index.js';
import { useRequest } from '../../admin/integrations/request.js';
import { Check, Pill, SelectField, StatusLine, TextArea } from '../../admin/lib/ui.js';
import {
  AVM_SCOPES,
  AVM_SCOPE_WORDS,
  type AvmScope,
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
  USPS_REGIONS,
  VALUATION_ERROR_MESSAGES,
  VALUATION_KEYS,
  VALUATION_NOT_SHARED,
  VALUATION_WORDS,
  type ValuationKey,
  type ValuationValues,
  type ValuationView,
  packBody,
  pickMls,
  pickPack,
  reviewWords,
  statementsValid,
  valuationBody,
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
        {c.feedStale ? <Notice tone="warn">{staleWords(c)}</Notice> : null}
        <Notice tone={c.clientDisplay ? 'ok' : 'warn'} title={c.clientDisplay ? 'MLS data may reach clients' : 'MLS data does not reach clients'}>
          {c.clientDisplaySentence}
        </Notice>
      </Section>
      <PackEditor key={c.id} c={c} several={several} editable={c.status !== 'disconnected'} />
      <ValuationEditor key={`${c.id}:valuation`} c={c} several={several} editable={c.status !== 'disconnected'} />
    </>
  );
}

type StatementRow = { region: string; text: string; size: string };
const rowsOf = (v: ValuationView): StatementRow[] => v.values.statements.map((x) => ({ region: x.region, text: x.text, size: String(x.minPointSize) }));
const REGION_CODES = Object.keys(USPS_REGIONS);
const STATEMENTS_INVALID = 'Nothing was saved: every state statement needs a state (each state once), a text and a type size from 6 to 36 points.';

/**
 * The licence pack's valuation section (D9; R-CMA-6, R-CMA-7; batch 10 review api-ui/F2): the Owner/Admin records from
 * the MLS agreement whether sold data may be used for valuations, with its own counsel marks and stamp. Saved apart from
 * the display pack: the PUT carries the display pack exactly as the server last returned it (so its review stamp is
 * kept), plus `valuation`. Strictest values when nothing is stored; nothing is ever ticked for the Owner. V1 shares
 * nothing built from MLS sales, whatever is recorded (the client uses say so).
 */
function ValuationEditor({ c, several, editable }: { c: MlsConnection; several: boolean; editable: boolean }) {
  const qc = useQueryClient();
  const req = useRequest(VALUATION_ERROR_MESSAGES);
  const [values, setValues] = useState<ValuationValues>(c.licensePack.valuation.values);
  const [rows, setRows] = useState<StatementRow[]>(rowsOf(c.licensePack.valuation));
  const [marks, setMarks] = useState<Record<ValuationKey, boolean>>(c.licensePack.valuation.marks);
  const [saved, setSaved] = useState<ValuationView>(c.licensePack.valuation);
  const [changed, setChanged] = useState<Set<ValuationKey>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const allMarked = saved.unreviewedCount === 0 && saved.reviewedByCounselAt !== null;

  const touch = (k: ValuationKey) => {
    // counsel reviewed the value it had, not this one
    setMarks((old) => ({ ...old, [k]: false }));
    setChanged((old) => new Set(old).add(k));
    setDirty(true);
    setStatus(null);
  };
  const change = <K extends Exclude<ValuationKey, 'statements'>>(k: K, v: ValuationValues[K]) => {
    setValues((old) => ({ ...old, [k]: v }));
    touch(k);
  };
  const editRows = (next: StatementRow[]) => {
    setRows(next);
    touch('statements');
  };
  const mark = (k: ValuationKey, on: boolean) => {
    setMarks((old) => ({ ...old, [k]: on }));
    setDirty(true);
    setStatus(null);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setStatus(null);
    const statements = rows.map((r) => ({ region: r.region, text: r.text.trim(), minPointSize: r.size.trim() === '' ? Number.NaN : Number(r.size) }));
    if (!statementsValid(statements)) {
      setError(STATEMENTS_INVALID);
      return;
    }
    // the display pack as the server last returned it: unchanged values and marks keep its review stamp
    const body = { ...packBody(c.licensePack.values, c.licensePack.marks), valuation: valuationBody({ ...values, statements }, marks) };
    const r = await req.run<unknown>('save-valuation', 'PUT', `/admin/mls/connections/${encodeURIComponent(c.id)}/license-pack`, body);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    const v = pickPack((r.data as { licensePack?: unknown } | null)?.licensePack).valuation;
    setValues(v.values);
    setRows(rowsOf(v));
    setMarks(v.marks);
    setSaved(v);
    setChanged(new Set());
    setDirty(false);
    setStatus(v.unreviewedCount === 0 ? 'Valuation use saved. Every valuation value is marked as reviewed by counsel.' : `Valuation use saved. ${v.unreviewedCount} of ${VALUATION_KEYS.length} valuation values are not marked as reviewed by counsel.`);
    void qc.invalidateQueries({ queryKey: MLS_KEY });
  };

  const markRow = (k: ValuationKey) => (
    <Check
      label={
        <>
          Counsel reviewed this valuation value <span className="sr-only">({VALUATION_WORDS[k].label})</span>
        </>
      }
      hint={changed.has(k) && !marks[k] ? 'Changed: mark it again once counsel has reviewed the new value.' : undefined}
      checked={marks[k]}
      disabled={!editable}
      onChange={(on) => mark(k, on)}
    />
  );
  const fallback = `${saved.unreviewedCount} of ${VALUATION_KEYS.length} valuation values are not marked as reviewed by counsel. ${VALUATION_NOT_SHARED}`;

  return (
    <Section
      title={several ? `Valuation use: ${c.displayName}` : 'Valuation use'}
      description="What your MLS agreement allows for sold data used in valuations (CMAs). It has its own counsel review, apart from the display rules above: have counsel review each value and mark it here."
    >
      <Notice tone={allMarked ? 'ok' : 'warn'} title={allMarked ? 'Every valuation value is marked as reviewed by counsel' : 'Not reviewed by counsel'}>
        {saved.sentence || fallback}
        {allMarked && saved.reviewedByCounselAt && changed.size === 0 ? ` Marked complete on ${day(saved.reviewedByCounselAt)}.` : ''}
      </Notice>
      {!editable ? <p className="text-[15px] text-ink-muted">This connection is disconnected, so its valuation use cannot be changed.</p> : null}
      <form className="flex flex-col gap-4" noValidate onSubmit={(e) => void save(e)}>
        <ul className="flex flex-col gap-3">
          {(['agent_cma', 'client_cma', 'automated_notes'] as const).map((k) => (
            <ValuationValue key={k} k={k} reviewed={marks[k]} mark={markRow(k)}>
              <Check label={VALUATION_WORDS[k].label} hint={VALUATION_WORDS[k].hint} checked={values[k]} disabled={!editable} onChange={(on) => change(k, on)} />
            </ValuationValue>
          ))}
          <ValuationValue k="avm_flag_scope" reviewed={marks.avm_flag_scope} mark={markRow('avm_flag_scope')}>
            <SelectField label={VALUATION_WORDS.avm_flag_scope.label} hint={VALUATION_WORDS.avm_flag_scope.hint} value={values.avm_flag_scope} disabled={!editable} onChange={(e) => change('avm_flag_scope', e.target.value as AvmScope)}>
              {AVM_SCOPES.map((o) => (
                <option key={o} value={o}>
                  {AVM_SCOPE_WORDS[o]}
                </option>
              ))}
            </SelectField>
          </ValuationValue>
          <ValuationValue k="statements" reviewed={marks.statements} mark={markRow('statements')}>
            <fieldset className="flex flex-col gap-3">
              <legend className="text-[15px] font-medium text-ink">{VALUATION_WORDS.statements.label}</legend>
              <p className="text-[14px] text-ink-muted">{VALUATION_WORDS.statements.hint}</p>
              {rows.length === 0 ? <p className="text-[15px] text-ink">No state statement yet.</p> : null}
              {rows.map((r, i) => (
                <fieldset key={i} className="flex flex-col gap-2 rounded-xl border border-line p-3">
                  <legend className="px-1 text-[14px] font-medium text-ink">{r.region && USPS_REGIONS[r.region] ? `Statement for ${USPS_REGIONS[r.region]}` : `Statement ${i + 1}`}</legend>
                  <SelectField label="State" value={r.region} disabled={!editable} onChange={(e) => editRows(rows.map((x, j) => (j === i ? { ...x, region: e.target.value } : x)))}>
                    <option value="">Choose a state</option>
                    {REGION_CODES.map((code) => (
                      <option key={code} value={code} disabled={code !== r.region && rows.some((x) => x.region === code)}>
                        {USPS_REGIONS[code]} ({code})
                      </option>
                    ))}
                  </SelectField>
                  <TextArea label="Statement text" value={r.text} maxLength={4000} disabled={!editable} onChange={(e) => editRows(rows.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                  <TextField label="Smallest type size (points)" hint="From 6 to 36." inputMode="decimal" value={r.size} disabled={!editable} onChange={(e) => editRows(rows.map((x, j) => (j === i ? { ...x, size: e.target.value } : x)))} />
                  {editable ? (
                    <div>
                      <Button variant="quiet" onClick={() => editRows(rows.filter((_x, j) => j !== i))}>
                        Remove this statement
                      </Button>
                    </div>
                  ) : null}
                </fieldset>
              ))}
              {editable && rows.length < REGION_CODES.length ? (
                <div>
                  <Button variant="secondary" onClick={() => editRows([...rows, { region: '', text: '', size: '' }])}>
                    Add a state statement
                  </Button>
                </div>
              ) : null}
            </fieldset>
          </ValuationValue>
        </ul>
        <StatusLine text={status} />
        {error ? <Notice tone="error">{error}</Notice> : null}
        {editable && dirty ? <p className="text-[15px] font-medium text-ink">Not saved yet. {VALUATION_KEYS.filter((k) => marks[k]).length} of {VALUATION_KEYS.length} valuation values are ticked as reviewed by counsel.</p> : null}
        {editable ? (
          <div>
            <Button type="submit" pending={req.pending === 'save-valuation'} pendingLabel="Saving">
              Save valuation use
            </Button>
          </div>
        ) : null}
      </form>
    </Section>
  );
}

function ValuationValue({ k, reviewed, mark, children }: { k: ValuationKey; reviewed: boolean; mark: ReactNode; children: ReactNode }) {
  return (
    <Card as="li" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="sr-only">{VALUATION_WORDS[k].label}:</span>
        <Pill tone={reviewed ? 'ok' : 'warn'}>{reviewed ? 'Reviewed by counsel' : 'Not reviewed by counsel'}</Pill>
      </div>
      {children}
      <div className="border-t border-line pt-1">{mark}</div>
    </Card>
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
      // said next to the Save button too: the field may be far above it
      setError('Nothing was saved: the longest time the MLS data may be out of date needs fixing (at the top of the licence pack).');
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
      label={
        <>
          Counsel reviewed this value <span className="sr-only">({KEY_WORDS[k].label})</span>
        </>
      }
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

/** Why the MLS data counts as out of date, by cause (core feedStale: never synced, no limit set, or over the limit). */
function staleWords(c: MlsConnection): string {
  if (c.lastSyncedAt === null) return 'No MLS data has been received yet, so MLS listings do not reach clients.';
  if (c.licensePack.values.max_staleness_hours === null) return 'The licence pack sets no limit on how old MLS data may be, so the data always counts as out of date and MLS listings are paused for clients. Set the limit below.';
  return 'The MLS data is older than the licence pack allows, so MLS listings are paused for clients until a sync brings it up to date.';
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
