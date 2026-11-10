// Brokerage identity and team settings (BUILD_PLAN module 17 admin; api/admin settings).
//
// - Brokerage identity renders on every outbound marketing message (R-GATE-12, A7f). Only the Owner
//   changes it, after re-entering their password (R-PERM-3, R-PERM-13). The legal name can never be
//   blank. While the postal address is missing, the page says plainly that marketing email is held.
//   Jurisdiction advertising rules (e.g. team-name placement) are data, VERIFY WITH COUNSEL.
// - Recording retention and who may play recordings are Owner-only (R-PERM-3).
// - The assistant switch and lock-screen detail are Owner/Admin.
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Button, Card, Notice, TextField } from '../../design/index.js';
import { type ApiError, messageFor, useApi, useSession } from '../../shell/index.js';
import { useAction, useAnnounce } from '../admin/lib/hooks.js';
import { ADMIN_MESSAGES } from '../admin/lib/messages.js';
import type { Settings } from '../admin/lib/types.js';
import { Check, ErrorLine, Fact, Section, SelectField, StatusLine } from '../admin/lib/ui.js';

const SETTINGS_KEY = ['admin', 'settings'] as const;

export default function TeamSettingsPage() {
  const api = useApi();
  const { session } = useSession();
  const isOwner = session?.tenant?.role === 'owner';
  const [status, announce] = useAnnounce();
  const q = useQuery<{ settings: Settings }, ApiError>({ queryKey: SETTINGS_KEY, queryFn: ({ signal }) => api.get('/settings', { signal }) });
  const s = q.data?.settings;
  return (
    <div className="flex w-full max-w-3xl flex-col gap-8">
      <StatusLine text={status} />
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, ADMIN_MESSAGES)}</Notice> : null}
      {s ? (
        <>
          <Identity key={`i${s.version}`} settings={s} isOwner={isOwner} onDone={announce} />
          <Assistant key={`a${s.version}`} settings={s} onDone={announce} />
          <Recording key={`r${s.version}`} settings={s} isOwner={isOwner} onDone={announce} />
        </>
      ) : null}
    </div>
  );
}

function Identity({ settings, isOwner, onDone }: { settings: Settings; isOwner: boolean; onDone(t: string): void }) {
  const id = settings.identity;
  const [f, setF] = useState({ legal: id.brokerageLegalName, team: id.teamName ?? '', license: id.brokerageLicenseNumber ?? '', address: id.brokeragePostalAddress ?? '' });
  const a = useAction<Record<string, unknown>, { settings: Settings }>('PATCH', { invalidate: [[...SETTINGS_KEY]] });
  const opt = (s: string) => (s.trim() === '' ? null : s.trim());
  const body: Record<string, unknown> = {};
  if (f.legal.trim() !== id.brokerageLegalName) body.brokerageLegalName = f.legal.trim();
  if (opt(f.team) !== id.teamName) body.teamName = opt(f.team);
  if (opt(f.license) !== id.brokerageLicenseNumber) body.brokerageLicenseNumber = opt(f.license);
  if (opt(f.address) !== id.brokeragePostalAddress) body.brokeragePostalAddress = opt(f.address);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await a.run('/settings/identity', { ...body, version: settings.version });
    if (r.ok) onDone('Brokerage details saved');
  };
  return (
    <Section title="Brokerage" description="Shown on every marketing message and template the team sends, so clients always know which brokerage is behind it.">
      {id.missing.includes('brokerage_postal_address') ? <Notice tone="warn" title="Marketing email is on hold">Marketing email needs the brokerage's postal address in it. Until it is added here, those emails are not sent.</Notice> : null}
      {isOwner ? (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <Card className="flex flex-col gap-3">
            <TextField label="Brokerage legal name" value={f.legal} onChange={(e) => setF((x) => ({ ...x, legal: e.target.value }))} required maxLength={200} hint="Required. It can be changed but never left blank." />
            <TextField label="Team name (optional)" value={f.team} onChange={(e) => setF((x) => ({ ...x, team: e.target.value }))} maxLength={120} hint="Some states limit how a team name may appear next to the brokerage name. Check with counsel." />
            <TextField label="Brokerage license number (optional)" value={f.license} onChange={(e) => setF((x) => ({ ...x, license: e.target.value }))} maxLength={60} />
            <TextField label="Brokerage postal address" value={f.address} onChange={(e) => setF((x) => ({ ...x, address: e.target.value }))} maxLength={300} hint="Needed for marketing email." />
          </Card>
          <ErrorLine message={a.error?.message} />
          <div>
            <Button type="submit" pending={a.pending} disabled={Object.keys(body).length === 0 || !f.legal.trim()}>
              Save brokerage details
            </Button>
          </div>
        </form>
      ) : (
        <Card>
          <dl className="flex flex-col gap-2">
            <Fact label="Brokerage legal name">{id.brokerageLegalName}</Fact>
            <Fact label="Team name">{id.teamName ?? 'Not set'}</Fact>
            <Fact label="License number">{id.brokerageLicenseNumber ?? 'Not set'}</Fact>
            <Fact label="Postal address">{id.brokeragePostalAddress ?? 'Not set'}</Fact>
          </dl>
          <p className="mt-3 text-[14px] text-ink-muted">Only the Owner can change these.</p>
        </Card>
      )}
    </Section>
  );
}

function Assistant({ settings, onDone }: { settings: Settings; onDone(t: string): void }) {
  const [ai, setAi] = useState(settings.aiEnabled);
  const [detail, setDetail] = useState(settings.notificationDetail);
  const a = useAction<Record<string, unknown>, { settings: Settings }>('PATCH', { invalidate: [[...SETTINGS_KEY]] });
  const body: Record<string, unknown> = {};
  if (ai !== settings.aiEnabled) body.aiEnabled = ai;
  if (detail !== settings.notificationDetail) body.notificationDetail = detail;
  return (
    <Section title="Assistant and notifications">
      <Card className="flex flex-col gap-3">
        <Check
          label="Use the assistant"
          hint="When off, the assistant writes nothing and sends nothing: no drafts, no instant replies, no follow-ups. Agents write every message themselves."
          checked={ai}
          onChange={setAi}
        />
        <SelectField label="What a lock-screen notification shows" value={detail} onChange={(e) => setDetail(e.target.value as Settings['notificationDetail'])}>
          <option value="none">Nothing about the client</option>
          <option value="first_name_initial">The client's first name and last initial</option>
        </SelectField>
        <p className="text-[14px] text-ink-muted">Phone numbers, email addresses and message text never appear on a lock screen.</p>
        <ErrorLine message={a.error?.message} />
        <div>
          <Button pending={a.pending} disabled={Object.keys(body).length === 0} onClick={async () => (await a.run('/settings', { ...body, version: settings.version })).ok && onDone('Saved')}>
            Save
          </Button>
        </div>
      </Card>
    </Section>
  );
}

function Recording({ settings, isOwner, onDone }: { settings: Settings; isOwner: boolean; onDone(t: string): void }) {
  const [days, setDays] = useState(String(settings.recordingRetentionDays));
  const [tl, setTl] = useState(settings.teamLeadRecordingAccess);
  const [tc, setTc] = useState(settings.tcRecordingAccess);
  const a = useAction<Record<string, unknown>, { settings: Settings }>('PATCH', { invalidate: [[...SETTINGS_KEY]] });
  const n = Number(days);
  const body: Record<string, unknown> = {};
  if (/^\d+$/.test(days) && n !== settings.recordingRetentionDays) body.recordingRetentionDays = n;
  if (tl !== settings.teamLeadRecordingAccess) body.teamLeadRecordingAccess = tl;
  if (tc !== settings.tcRecordingAccess) body.tcRecordingAccess = tc;
  const valid = /^\d+$/.test(days) && n >= 30 && n <= 3650;
  return (
    <Section title="Call recordings" description="Every play and transcript view is logged. Recordings are deleted after the retention period.">
      <Card className="flex flex-col gap-3">
        {isOwner ? (
          <>
            <TextField label="Keep recordings for (days)" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} error={valid ? null : 'Between 30 and 3650 days.'} hint="Retention rules differ by state. Check with counsel." />
            <Check label="Team Leads may play their team's recordings" hint="Rules about monitoring employees differ by state. Check with counsel." checked={tl} onChange={setTl} />
            <Check label="Transaction coordinators may play recordings on their deals" checked={tc} onChange={setTc} />
            <ErrorLine message={a.error?.message} />
            <div>
              <Button pending={a.pending} disabled={Object.keys(body).length === 0 || !valid} onClick={async () => (await a.run('/settings', { ...body, version: settings.version })).ok && onDone('Recording settings saved')}>
                Save recording settings
              </Button>
            </div>
          </>
        ) : (
          <>
            <dl className="flex flex-col gap-2">
              <Fact label="Kept for">{settings.recordingRetentionDays} days</Fact>
              <Fact label="Team Leads may play">{settings.teamLeadRecordingAccess ? "Their team's recordings" : 'Only their own'}</Fact>
              <Fact label="Transaction coordinators">{settings.tcRecordingAccess ? 'Recordings on their deals' : 'No recordings'}</Fact>
            </dl>
            <p className="text-[14px] text-ink-muted">Only the Owner can change these.</p>
          </>
        )}
      </Card>
    </Section>
  );
}
