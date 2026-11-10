// Compliance policy (BUILD_PLAN module 17 admin; api/admin policy versions; DATA_MODEL §3).
//
// - Honest banner: the jurisdiction packs in force and whether counsel reviewed them, said plainly
//   (Phase 1 exit criterion 6). VERIFY WITH COUNSEL: every value on this page is a legal parameter.
// - Every change is a NEW append-only version (a delta on the active one). A stricter change can be
//   made by an Owner or Admin; a looser one only by the Owner, after re-entering their password
//   (R-PERM-13) and confirming the exact attestation sentence the server supplies. The page shows that
//   attestation before saving, from the same field-by-field rules the server uses.
// - The platform ceilings (contact hours 08:00–21:00 at the widest, the caps' maxima) are DB checks;
//   the inputs stop there too.
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useMemo, useState } from 'react';
import { Button, Card, Notice, TextField } from '../../design/index.js';
import { type ApiError, messageFor, useApi, useSession } from '../../shell/index.js';
import { formatDate, formatStamp } from '../admin/lib/format.js';
import { useAction, useAnnounce } from '../admin/lib/hooks.js';
import { ADMIN_MESSAGES } from '../admin/lib/messages.js';
import { AUTONOMOUS_CATEGORIES, type PoliciesResponse, type PolicyCreated, type PolicyValues, type PolicyVersion } from '../admin/lib/types.js';
import { Check, CounselBanner, ErrorLine, Fact, Pill, Section, SelectField, StatusLine } from '../admin/lib/ui.js';
import { CATEGORY_LABEL, FIELD_LABEL, NUMERIC_FIELDS, type PolicyField, draftDelta, looserFields, valueText } from './policy.js';

const POLICY_KEY = ['admin', 'compliance-policies'] as const;

function valuesOf(v: PolicyVersion): PolicyValues {
  const { id: _i, versionNo: _n, attested: _a, createdByUserId: _c, createdAt: _t, active: _x, ...values } = v;
  return values;
}

export default function CompliancePage() {
  const api = useApi();
  const [status, announce] = useAnnounce();
  const q = useQuery<PoliciesResponse, ApiError>({ queryKey: POLICY_KEY, queryFn: ({ signal }) => api.get('/compliance-policies', { signal }) });
  const active = q.data?.versions.find((v) => v.id === q.data?.activePolicyId) ?? null;
  return (
    <div className="flex w-full flex-col gap-8">
      <StatusLine text={status} />
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, ADMIN_MESSAGES)}</Notice> : null}
      {q.data ? (
        <CounselBanner reviewed={q.data.counsel.allReviewed}>
          {q.data.counsel.packs.length === 0 ? (
            <span>No state rule pack is in force yet, so only the strict platform defaults apply.</span>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5">
              {q.data.counsel.packs.map((p) => (
                <li key={`${p.key}@${p.version}`}>
                  {p.key.toUpperCase()} rules (version {p.version}): {p.reviewedByCounselAt ? `reviewed by counsel ${formatDate(p.reviewedByCounselAt)}` : 'not reviewed by counsel'}
                </li>
              ))}
            </ul>
          )}
        </CounselBanner>
      ) : null}
      {q.data && active ? (
        <>
          <Section title="In force now" description={`Version ${active.versionNo}, since ${formatStamp(active.createdAt)}. Every send is checked against it at the moment it goes out.`}>
            <Card>
              <dl className="flex flex-col gap-2">
                {(Object.keys(FIELD_LABEL) as PolicyField[]).map((k) => (
                  <Fact key={k} label={FIELD_LABEL[k]}>
                    {valueText(k, active)}
                  </Fact>
                ))}
              </dl>
            </Card>
          </Section>
          <PolicyEditor key={active.id} data={q.data} active={active} onDone={announce} />
          <Versions data={q.data} active={active} onDone={announce} />
        </>
      ) : null}
    </div>
  );
}

function PolicyEditor({ data, active, onDone }: { data: PoliciesResponse; active: PolicyVersion; onDone(t: string): void }) {
  const { session } = useSession();
  const isOwner = session?.tenant?.role === 'owner';
  const base = useMemo(() => valuesOf(active), [active]);
  const [v, setV] = useState<PolicyValues>(base);
  const [attest, setAttest] = useState(false);
  const [activate, setActivate] = useState(true);
  const [serverWantsAttest, setServerWantsAttest] = useState(false);
  const a = useAction<Record<string, unknown>, PolicyCreated>('POST', { invalidate: [[...POLICY_KEY], ['admin', 'settings']] });
  const delta = draftDelta(base, v);
  const changed = Object.keys(delta).length > 0;
  const looser = looserFields(base, v, data.defaults);
  const needsAttest = looser.length > 0 || serverWantsAttest;
  const set = <K extends PolicyField>(k: K, val: PolicyValues[K]) => setV((x) => ({ ...x, [k]: val }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await a.run('/compliance-policies', { ...delta, activate, ...(needsAttest && attest ? { attestation: data.attestationText } : {}) });
    if (r.ok) {
      onDone(`Version ${r.data.versionNo} saved${r.data.active ? ' and in force' : ''}`);
      setAttest(false);
      setServerWantsAttest(false);
    } else if (r.code === 'ATTESTATION_REQUIRED') setServerWantsAttest(true);
  };
  return (
    <Section title="Change the policy" description="Saving creates a new version. Earlier versions are kept, so every past decision can still cite the rules it used.">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <Card className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextField label="Contact hours start" type="time" min={data.widestWindow.start} max={data.widestWindow.end} value={v.contactWindowStart} onChange={(e) => set('contactWindowStart', e.target.value)} hint={`No earlier than ${data.widestWindow.start}. Default ${data.defaults.contactWindowStart}.`} />
            <TextField label="Contact hours end" type="time" min={data.widestWindow.start} max={data.widestWindow.end} value={v.contactWindowEnd} onChange={(e) => set('contactWindowEnd', e.target.value)} hint={`No later than ${data.widestWindow.end}. Default ${data.defaults.contactWindowEnd}.`} />
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {NUMERIC_FIELDS.map((f) => (
              <TextField
                key={f.key}
                label={f.unit ? `${f.label} (${f.unit})` : f.label}
                type="number"
                inputMode="numeric"
                min={f.min}
                max={f.max}
                value={String(v[f.key])}
                onChange={(e) => {
                  const n = Math.min(f.max, Math.max(f.min, Math.trunc(Number(e.target.value) || 0)));
                  set(f.key, n as never);
                }}
                hint={`Up to ${f.max}.`}
              />
            ))}
          </div>
          <Check label="Email waits for contact hours too" checked={v.emailQuietHours} onChange={(x) => set('emailQuietHours', x)} />
          <fieldset className="flex flex-col gap-1">
            <legend className="text-[15px] font-semibold text-ink">The assistant may send these on its own, inside approved playbooks</legend>
            {AUTONOMOUS_CATEGORIES.map((c) => (
              <Check
                key={c}
                label={CATEGORY_LABEL[c]}
                checked={v.autonomousCategories.includes(c)}
                onChange={(on) => set('autonomousCategories', on ? [...v.autonomousCategories, c] : v.autonomousCategories.filter((x) => x !== c))}
              />
            ))}
            <p className="text-[14px] text-ink-muted">Money, contracts and any new kind of message always wait for a person to tap Send.</p>
          </fieldset>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SelectField label="Who confirms an opt-out" value={v.optOutConfirmationSender} onChange={(e) => set('optOutConfirmationSender', e.target.value as PolicyValues['optOutConfirmationSender'])}>
              <option value="provider">The phone carrier service</option>
              <option value="platform">This app</option>
            </SelectField>
            <SelectField label="Recording notice" value={v.recordingMode} onChange={(e) => set('recordingMode', e.target.value as PolicyValues['recordingMode'])}>
              <option value="announce_all">Announce every recorded call</option>
              <option value="one_party_where_permitted">One-party consent where the law allows it</option>
            </SelectField>
          </div>
          <Check label="Record calls" checked={v.recordingEnabled} onChange={(x) => set('recordingEnabled', x)} />
        </Card>
        {needsAttest ? (
          <Notice tone="warn" title="This is looser than the policy in force">
            {looser.length > 0 ? <p>Looser: {looser.map((f) => FIELD_LABEL[f]).join(', ')}.</p> : null}
            {isOwner ? (
              <div className="mt-2">
                <Check label={data.attestationText} checked={attest} onChange={setAttest} />
                <p className="text-[14px] text-ink-muted">You'll be asked for your password. This wording has not been reviewed by counsel.</p>
              </div>
            ) : (
              <p className="mt-1">Only the Owner can make a looser change. You can still make any change that is stricter.</p>
            )}
          </Notice>
        ) : null}
        <Check label="Put this version in force as soon as it is saved" checked={activate} onChange={setActivate} />
        <ErrorLine message={a.error && a.error.code !== 'ATTESTATION_REQUIRED' ? a.error.message : null} />
        <div className="flex gap-2">
          <Button type="submit" pending={a.pending} disabled={!changed || (needsAttest && (!isOwner || !attest))}>
            Save new version
          </Button>
          {changed ? (
            <Button variant="quiet" onClick={() => setV(base)}>
              Undo changes
            </Button>
          ) : null}
        </div>
      </form>
    </Section>
  );
}

function Versions({ data, active, onDone }: { data: PoliciesResponse; active: PolicyVersion; onDone(t: string): void }) {
  const versions = [...data.versions].sort((x, y) => y.versionNo - x.versionNo);
  return (
    <Section title="All versions" description="Versions are never edited or deleted.">
      <ul className="flex flex-col gap-2">
        {versions.map((v) => (
          <li key={v.id}>
            <VersionRow version={v} active={active} data={data} onDone={onDone} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function VersionRow({ version, active, data, onDone }: { version: PolicyVersion; active: PolicyVersion; data: PoliciesResponse; onDone(t: string): void }) {
  const { session } = useSession();
  const isOwner = session?.tenant?.role === 'owner';
  const [attest, setAttest] = useState(false);
  const [askAttest, setAskAttest] = useState(false);
  const a = useAction<{ attestation?: string }, { activePolicyId: string; loosening: boolean; changed: boolean }>('POST', { invalidate: [[...POLICY_KEY], ['admin', 'settings']] });
  const looser = version.id === active.id ? [] : looserFields(valuesOf(active), valuesOf(version), data.defaults);
  const needsAttest = looser.length > 0 || version.attested || askAttest;
  const diff = Object.keys(draftDelta(valuesOf(active), valuesOf(version))) as PolicyField[];
  const run = async () => {
    const r = await a.run(`/compliance-policies/${version.id}/activate`, needsAttest && attest ? { attestation: data.attestationText } : {});
    if (r.ok) onDone(`Version ${version.versionNo} is in force`);
    else if (r.code === 'ATTESTATION_REQUIRED') setAskAttest(true);
  };
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-[16px] font-medium text-ink">
          Version {version.versionNo} <span className="font-normal text-ink-muted">· {formatStamp(version.createdAt)}</span>
        </p>
        {version.active ? <Pill tone="ok">In force</Pill> : null}
        {version.attested ? <Pill tone="warn">Owner confirmed a looser policy</Pill> : null}
      </div>
      {!version.active && diff.length > 0 ? <p className="text-[14px] text-ink-muted">Differs from the version in force in: {diff.map((f) => FIELD_LABEL[f]).join(', ')}.</p> : null}
      {!version.active ? (
        <>
          {needsAttest ? (
            isOwner ? (
              <Check label={data.attestationText} checked={attest} onChange={setAttest} />
            ) : (
              <p className="text-[14px] text-ink">Only the Owner can put a looser version in force.</p>
            )
          ) : null}
          <div>
            <Button variant="secondary" pending={a.pending} disabled={needsAttest && (!isOwner || !attest)} onClick={() => void run()}>
              Put version {version.versionNo} in force
            </Button>
          </div>
        </>
      ) : null}
      <ErrorLine message={a.error && a.error.code !== 'ATTESTATION_REQUIRED' ? a.error.message : null} />
    </Card>
  );
}
