// Owner view (PHASE2_3_PLAN module 40; DATA_MODEL R-OWNER-1…5; E107–E109). Owner/Admin only.
//
// Evidence over confidence: every number on this page is shown with what it is out of and how it was made.
//   - Dollars by source: a desktop table (phone: one card per source). Commission says "from 2 of 3 closings with a
//     commission entered"; cost says how many monthly entries it sums; cost per closing is words from the server
//     ("— (0 closings)", never $0 or ∞). The section's method sentence sits under its heading, and the deals left
//     out (no commission, no source) are counted and listed by name.
//   - Velocity: median days per stage with n; stages with too few moves are listed as "not enough history".
//   - 90-day forecast: a low–high range per unit with its one-sentence method, the k of n behind each stage and the
//     stages left out. No per-deal number exists anywhere.
// Costs: "Enter cost" opens a small form (month, amount, note). A month that has ended needs the password again
// (the shell's re-auth prompt opens by itself and the same save is sent again).
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Dialog, EmptyState, Notice, TextField } from '../../design/index.js';
import { type ApiError, useApi } from '../../shell/index.js';
import { dollarsToCents, plural } from '../admin/lib/format.js';
import { useAction, useAnnounce } from '../admin/lib/hooks.js';
import { Section, Segmented, SelectField, StatusLine } from '../admin/lib/ui.js';
import { humanize } from '../goals/humanize.js';
import { sentenceFor } from './messages.js';
import { type CostsResponse, type ForecastResponse, type ForecastUnitView, OWNER_KEY, type PutCostResponse, type SourceRowView, type SourcesResponse, type VelocityResponse, stageLabel } from './types.js';

type Range = 'this' | 'last' | 'year';

const pad = (n: number) => String(n).padStart(2, '0');
const ymOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export function shiftYm(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
}
export function monthWords(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
export function monthsOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to && out.length < 24; m = shiftYm(m, 1)) out.push(m);
  return out;
}

/**
 * The months of a period choice. `cur` is the current month in the TEAM's zone, as the server reported it for "This
 * month" (the browser's clock can be in another month near midnight); until that is known the browser's is used.
 */
export function rangeQuery(range: Range, cur: string = ymOf(new Date())): { from: string; to: string } {
  if (range === 'this') return { from: cur, to: cur };
  if (range === 'last') return { from: shiftYm(cur, -1), to: shiftYm(cur, -1) };
  return { from: shiftYm(cur, -11), to: cur };
}

export default function OwnerPage() {
  const api = useApi();
  const [range, setRange] = useState<Range>('this');
  // "This month" asks without from/to, so the server answers in the team's zone; its period gives the other choices
  const current = useQuery<SourcesResponse, ApiError>({ queryKey: [...OWNER_KEY, 'sources', ''], queryFn: ({ signal }) => api.get('/owner/sources', { signal }) });
  const cur = current.data?.period.to;
  const q = cur ? rangeQuery(range, cur) : null;
  const qs = range === 'this' || !q ? '' : `?from=${q.from}&to=${q.to}`;
  const other = useQuery<SourcesResponse, ApiError>({ queryKey: [...OWNER_KEY, 'sources', qs], queryFn: ({ signal }) => api.get(`/owner/sources${qs}`, { signal }), enabled: qs !== '' });
  const sources = qs === '' ? current : other;
  const costs = useQuery<CostsResponse, ApiError>({ queryKey: [...OWNER_KEY, 'costs', qs], queryFn: ({ signal }) => api.get(`/lead-source-costs${qs}`, { signal }), enabled: range === 'this' || !!cur });
  const velocity = useQuery<VelocityResponse, ApiError>({ queryKey: [...OWNER_KEY, 'velocity'], queryFn: ({ signal }) => api.get('/owner/velocity', { signal }) });
  const forecast = useQuery<ForecastResponse, ApiError>({ queryKey: [...OWNER_KEY, 'forecast'], queryFn: ({ signal }) => api.get('/owner/forecast', { signal }) });
  const [status, announce] = useAnnounce(6000);
  const [editing, setEditing] = useState<{ sourceId: string | null } | null>(null);

  return (
    <div className="flex w-full max-w-6xl flex-col gap-8">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <p className="text-[16px] text-ink" data-testid="period">
          {sources.data ? `${monthWords(sources.data.period.from)}${sources.data.period.from === sources.data.period.to ? '' : ` to ${monthWords(sources.data.period.to)}`} · ${plural(sources.data.closedInPeriod, 'closing')}` : ' '}
        </p>
        <div className="md:ml-auto">
          <Segmented<Range>
            label="Period"
            value={range}
            onChange={setRange}
            options={[
              { value: 'this', label: 'This month' },
              { value: 'last', label: 'Last month' },
              { value: 'year', label: 'Last 12 months' },
            ]}
          />
        </div>
      </div>
      <StatusLine text={status} />

      <Section
        title="Dollars by source"
        description={sources.data?.method}
        actions={
          <Button variant="secondary" onClick={() => setEditing({ sourceId: null })} disabled={!costs.data}>
            Enter cost
          </Button>
        }
      >
        {sources.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
        {sources.isError ? <Notice tone="error">{sentenceFor(sources.error)}</Notice> : null}
        {sources.data && sources.data.rows.length === 0 ? (
          <EmptyState icon="deal" title="No closings or costs in this period">
            Closed deals and the costs you enter for each lead source show up here.
          </EmptyState>
        ) : null}
        {sources.data && sources.data.rows.length > 0 ? <SourcesTable rows={sources.data.rows} onEdit={(id) => setEditing({ sourceId: id })} /> : null}
        {sources.data ? <Excluded s={sources.data} /> : null}
      </Section>

      <Section title="Velocity" description={velocity.data?.method}>
        {velocity.isError ? <Notice tone="error">{sentenceFor(velocity.error)}</Notice> : null}
        {velocity.data ? <Velocity v={velocity.data} /> : null}
      </Section>

      <Section title="90-day forecast" description={forecast.data ? `${plural(forecast.data.openDeals, 'open deal')} today. Stages with fewer than ${forecast.data.minSample} deals that entered them 90 to 365 days ago are left out.` : undefined}>
        {forecast.isError ? <Notice tone="error">{sentenceFor(forecast.error)}</Notice> : null}
        {forecast.data ? (
          <div className="grid gap-4 md:grid-cols-2">
            <ForecastCard title="Closings" f={forecast.data.closings} />
            <ForecastCard title="Commission" f={forecast.data.commission} />
          </div>
        ) : null}
      </Section>

      {editing && costs.data && sources.data ? (
        <CostDialog
          costs={costs.data}
          sourceId={editing.sourceId}
          months={monthsOf(sources.data.period.from, sources.data.period.to)}
          onClose={() => setEditing(null)}
          onSaved={(name, month) => {
            setEditing(null);
            announce(`Cost saved for ${name}, ${monthWords(month)}.`);
          }}
        />
      ) : null}
    </div>
  );
}

function SourcesTable({ rows, onEdit }: { rows: SourceRowView[]; onEdit(sourceId: string): void }) {
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-left text-[15px]">
          <caption className="sr-only">Dollars by lead source, with closings, commission, cost and cost per closing</caption>
          <thead>
            <tr className="border-b border-line text-[14px] text-ink-muted">
              <th scope="col" className="py-2 pr-4 font-medium">
                Source
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Closings
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Commission
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Cost
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Cost per closing
              </th>
              <th scope="col" className="py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.leadSourceId} className="border-b border-line align-top">
                <th scope="row" className="py-3 pr-4 font-semibold text-ink">
                  {r.leadSourceName}
                </th>
                <td className="py-3 pr-4 tabular-nums">{r.closings}</td>
                <td className="py-3 pr-4">
                  <span className="font-semibold tabular-nums">{centsToDollarsWords(r.commissionCents)}</span>
                  <span className="block text-[14px] text-ink-muted">{commissionDenominator(r)}</span>
                </td>
                <td className="py-3 pr-4">
                  <span className="tabular-nums">{r.costRows === 0 ? '—' : centsToDollarsWords(r.costCents)}</span>
                  <span className="block text-[14px] text-ink-muted">{r.costWords}</span>
                </td>
                <td className="py-3 pr-4">{r.costPerClosingWords}</td>
                <td className="py-3">
                  <Button variant="quiet" onClick={() => onEdit(r.leadSourceId)} aria-label={`Enter cost for ${r.leadSourceName}`}>
                    Enter cost
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="flex flex-col gap-3 md:hidden" aria-label="Dollars by source">
        {rows.map((r) => (
          <li key={r.leadSourceId}>
            <Card as="article" className="flex flex-col gap-2">
              <h3 className="text-[17px] font-semibold text-ink">{r.leadSourceName}</h3>
              <p className="text-[15px]">
                <span className="font-semibold tabular-nums">{centsToDollarsWords(r.commissionCents)}</span> commission
                <span className="block text-[14px] text-ink-muted">{commissionDenominator(r)}</span>
              </p>
              <p className="text-[15px]">
                Cost: {r.costWords}
                <span className="block text-[14px] text-ink-muted">Cost per closing: {r.costPerClosingWords}</span>
              </p>
              <Button variant="secondary" block onClick={() => onEdit(r.leadSourceId)} aria-label={`Enter cost for ${r.leadSourceName}`}>
                Enter cost
              </Button>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Exact dollars and cents from integer cents ("$15,000.50"); never rounded to whole dollars. */
export const centsToDollarsWords = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const centsToInput = (cents: number) => (cents / 100).toFixed(2);

function commissionDenominator(r: SourceRowView): string {
  return `from ${r.dealsWithCommission} of ${plural(r.closings, 'closing')} with a commission entered`;
}

function Excluded({ s }: { s: SourcesResponse }) {
  const { missingCommission: mc, noSource: ns } = s.excluded;
  if (mc.count === 0 && ns.count === 0) return null;
  return (
    <Notice tone="info" title="Left out of the dollars">
      {mc.count > 0 ? (
        <p>
          {plural(mc.count, 'closed deal')} with no commission entered: <DealLinks deals={mc.deals} />. Those with a lead source still count as that source’s closings.
        </p>
      ) : null}
      {ns.count > 0 ? (
        <p>
          {plural(ns.count, 'closed deal')} with no lead source, so in no row: <DealLinks deals={ns.deals} />.
        </p>
      ) : null}
    </Notice>
  );
}

function DealLinks({ deals }: { deals: readonly { dealId: string; name: string }[] }) {
  return (
    <>
      {deals.map((d, i) => (
        <span key={d.dealId}>
          {i > 0 ? ', ' : ''}
          <Link to={`/deals/${d.dealId}`} className="font-semibold text-accent underline">
            {d.name}
          </Link>
        </span>
      ))}
    </>
  );
}

function Velocity({ v }: { v: VelocityResponse }) {
  return (
    <div className="flex flex-col gap-3">
      {v.rows.length === 0 ? <p className="text-[15px] text-ink-muted">Not enough stage changes yet to show a median.</p> : null}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Median days per stage">
        {v.rows.map((r) => (
          <li key={r.stage}>
            <Card className="flex flex-col gap-1">
              <h3 className="text-[15px] font-medium text-ink-muted">{stageLabel(r.stage)}</h3>
              <p className="text-[17px] font-semibold text-ink">{r.words}</p>
            </Card>
          </li>
        ))}
      </ul>
      {v.excluded.thinStages.length > 0 ? (
        <p className="text-[15px] text-ink-muted">
          Not enough history (fewer than {v.minSample} moves): {v.excluded.thinStages.map((t) => `${stageLabel(t.stage)} (n=${t.sampleSize})`).join(', ')}.
        </p>
      ) : null}
    </div>
  );
}

function ForecastCard({ title, f }: { title: string; f: ForecastUnitView }) {
  const counted = f.samples.filter((s) => !f.excluded.thinStages.includes(s.stage));
  return (
    <Card as="article" className="flex flex-col gap-3">
      <h3 className="text-[17px] font-semibold text-ink">{title}</h3>
      <p className="text-[22px] font-semibold text-ink" data-testid={`forecast-${f.unit}`}>
        {f.rangeWords}
      </p>
      <p className="text-[15px] text-ink">{humanize(f.method)}</p>
      {counted.length > 0 ? (
        <ul className="flex flex-col gap-1 text-[15px]" aria-label={`${title}: history behind each stage`}>
          {counted.map((s) => (
            <li key={s.stage}>
              {stageLabel(s.stage)}: {s.k} of {s.n} closed within 90 days
            </li>
          ))}
        </ul>
      ) : null}
      {f.excluded.thinStages.length > 0 ? <p className="text-[14px] text-ink-muted">Not enough history: {f.excluded.thinStages.map(stageLabel).join(', ')}.</p> : null}
      {f.excluded.noSource > 0 ? <p className="text-[14px] text-ink-muted">{plural(f.excluded.noSource, 'open deal')} with no lead source (still counted).</p> : null}
    </Card>
  );
}

function CostDialog({ costs, sourceId, months, onClose, onSaved }: { costs: CostsResponse; sourceId: string | null; months: string[]; onClose(): void; onSaved(name: string, month: string): void }) {
  const [source, setSource] = useState(sourceId ?? costs.sources[0]?.id ?? '');
  const [month, setMonth] = useState(months[months.length - 1] ?? '');
  const existing = useMemo(() => costs.costs.find((c) => c.leadSourceId === source && c.month === month && c.origin === 'manual'), [costs, source, month]);
  const [amount, setAmount] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const shown = amount ?? (existing ? centsToInput(existing.amountCents) : '');
  const put = useAction<{ leadSourceId: string; month: string; amountCents: number; note: string | null }, PutCostResponse>('PUT', { invalidate: [[...OWNER_KEY]] });
  const [error, setError] = useState<string | null>(null);
  const name = costs.sources.find((s) => s.id === source)?.name ?? 'the source';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const cents = dollarsToCents(shown);
    if (cents === null) {
      setError('Enter the amount in dollars, like 450 or 450.00.');
      return;
    }
    const r = await put.run('/lead-source-costs', { leadSourceId: source, month, amountCents: cents, note: (note ?? existing?.note ?? '').trim() || null });
    if (r.ok) onSaved(name, month);
    else setError(sentenceFor(r));
  };
  return (
    <Dialog
      title="Enter cost"
      description="What you spent on this lead source in one month. Months that have ended ask for your password again."
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="cost-form" disabled={put.pending || !source || !month}>
            Save cost
          </Button>
        </>
      }
    >
      <form id="cost-form" className="flex flex-col gap-3" onSubmit={submit}>
        <SelectField label="Lead source" value={source} onChange={(e) => setSource(e.target.value)}>
          {costs.sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="Month" value={month} onChange={(e) => setMonth(e.target.value)}>
          {months.map((m) => (
            <option key={m} value={m}>
              {monthWords(m)}
            </option>
          ))}
        </SelectField>
        <TextField label="Amount (dollars)" inputMode="decimal" value={shown} onChange={(e) => setAmount(e.target.value)} hint={existing ? `Now ${centsToDollarsWords(existing.amountCents)}` : 'No cost entered for this month yet'} />
        <TextField label="Note (optional)" value={note ?? existing?.note ?? ''} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        {error ? <Notice tone="error">{error}</Notice> : null}
      </form>
    </Dialog>
  );
}
