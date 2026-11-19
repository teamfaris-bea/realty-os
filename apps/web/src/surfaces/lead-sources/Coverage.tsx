// Who covers a lead source (b19 team-queue lane, step 2; DATA_MODEL R-TEAMQ-10, R-TEAMQ-11): the named owner, the
// named backup, the "high intent" mark and the "covered" switch, from the overview's `coverage` and
// PUT /lead-sources/:id/coverage (Owner and Admin; the page itself is theirs only).
//
// The state is always the SERVER's sentence in words ("Covered: …", "Not covered: no backup is named."), never a
// colour alone, and every warning is the server's sentence. Covered can be turned on only once an owner and a backup
// are both picked; taking a person away turns it off in what is sent. A suspended or removed member who is still
// named stays selected and is labelled so: this page never puts anybody in their place. One column on a phone.
import { type FormEvent, useEffect, useState } from 'react';
import { Button, Card, Notice } from '../../design/index.js';
import { roleLabel } from '../admin/lib/format.js';
import { useAction, useAnnounce } from '../admin/lib/hooks.js';
import type { Member } from '../admin/lib/types.js';
import { Check, Pill, SelectField, StatusLine } from '../admin/lib/ui.js';
import { SOURCE_KEYS, useMembers } from './hooks.js';
import { sentenceFor } from './messages.js';
import type { CoverageMember, SourceCoverage, SourceOverview } from './types.js';

export const COVERAGE_INTRO = "Name who answers for this source's leads and who backs them up. Naming someone here moves no lead and changes nobody's leads.";
export const COVERED_HINT_READY = 'On only while an owner and a backup are both named.';
export const COVERED_HINT_NEEDS_BOTH = 'Name an owner and a backup first.';

const STATUS_WORDS: Record<CoverageMember['status'], string> = {
  active: 'active',
  suspended: 'suspended',
  invited: 'has not joined yet',
  deactivating: 'no longer on the team',
  removed: 'no longer on the team',
};

export interface MemberOption {
  value: string;
  label: string;
}

/**
 * Who can be picked: active members who can take leads (never a Transaction Coordinator), by name, with their role
 * in words. The person already named is always offered, whatever their status, and labelled with it.
 */
export function memberOptions(members: readonly Member[], named: CoverageMember | null): MemberOption[] {
  const out: MemberOption[] = members
    .filter((m) => m.status === 'active' && m.role !== 'tc' && m.userId !== named?.userId)
    .map((m) => ({ value: m.userId, label: `${m.displayName} (${roleLabel(m.role)})` }));
  if (named) {
    const listed = members.find((m) => m.userId === named.userId);
    const name = named.name ?? listed?.displayName ?? 'A member with no name';
    out.push({ value: named.userId, label: named.status === 'active' ? `${name}${listed ? ` (${roleLabel(listed.role)})` : ''}` : `${name} (${STATUS_WORDS[named.status]})` });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

const ISSUE_SENTENCES: Record<string, string> = {
  coverage_needs_owner_and_backup: 'Name an owner and a backup before turning coverage on.',
  member_not_active: 'That member is suspended or no longer on the team. Pick someone who is active.',
  member_cannot_take_leads: 'A transaction coordinator cannot be the owner or the backup of a lead source.',
};

/** The sentence for a refused save (never a code). */
export function coverageErrorSentence(e: { code: string; details?: Record<string, unknown> | null }): string {
  const issue = e.code === 'VALIDATION_FAILED' && Array.isArray(e.details?.issues) ? (e.details.issues[0] as { code?: unknown } | undefined)?.code : undefined;
  if (typeof issue === 'string' && Object.hasOwn(ISSUE_SENTENCES, issue)) return ISSUE_SENTENCES[issue]!;
  if (e.code === 'NOT_FOUND') return "That member or this source can't be found any more. Reload and try again.";
  return sentenceFor(e);
}

/** The covered state in the server's words, with the high-intent mark (the list card and the source page). */
export function CoverageLine({ coverage }: { coverage: SourceCoverage }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] text-ink">
      <span>{coverage.sentence}</span>
      {coverage.highIntent ? <Pill tone="accent">High intent</Pill> : null}
    </p>
  );
}

export function Coverage({ source }: { source: SourceOverview }) {
  const c = source.coverage;
  if (!c) return null;
  return <CoverageCard sourceId={source.id} coverage={c} />;
}

function CoverageCard({ sourceId, coverage: c }: { sourceId: string; coverage: SourceCoverage }) {
  const members = useMembers();
  const [status, announce] = useAnnounce(8000);
  const [owner, setOwner] = useState(c.owner?.userId ?? '');
  const [backup, setBackup] = useState(c.backup?.userId ?? '');
  const [high, setHigh] = useState(c.highIntent);
  const [covered, setCovered] = useState(c.setting);
  // what the server holds changed (a save, or someone else's): the form shows it
  useEffect(() => {
    setOwner(c.owner?.userId ?? '');
    setBackup(c.backup?.userId ?? '');
    setHigh(c.highIntent);
    setCovered(c.setting);
  }, [c.owner?.userId, c.backup?.userId, c.highIntent, c.setting, c.changedAt]);
  const a = useAction<{ ownerUserId: string | null; backupUserId: string | null; highIntent: boolean; covered: boolean }, { coverage: SourceCoverage }>('PUT', { invalidate: SOURCE_KEYS });
  const both = owner !== '' && backup !== '';
  const on = covered && both;
  const dirty = owner !== (c.owner?.userId ?? '') || backup !== (c.backup?.userId ?? '') || high !== c.highIntent || on !== c.setting;
  const list = members.data?.members ?? [];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await a.run(`/lead-sources/${sourceId}/coverage`, { ownerUserId: owner || null, backupUserId: backup || null, highIntent: high, covered: on });
    if (r.ok) announce('Coverage saved');
  };
  const pick = (label: string, value: string, set: (v: string) => void, named: CoverageMember | null) => (
    <SelectField label={label} value={value} onChange={(e) => set(e.target.value)}>
      <option value="">Nobody</option>
      {memberOptions(list, named).map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </SelectField>
  );
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-[18px] font-semibold text-ink">Coverage</h2>
      <p className="text-[15px] text-ink-muted">{COVERAGE_INTRO}</p>
      <Notice tone={c.covered ? 'ok' : 'warn'}>
        <p className="font-medium">{c.sentence}</p>
        {c.highIntent ? <p>Marked high intent.</p> : null}
      </Notice>
      {c.warnings.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p id={`coverage-check-${sourceId}`} className="text-[15px] font-medium text-ink">
            What to check
          </p>
          <ul aria-labelledby={`coverage-check-${sourceId}`} className="list-disc pl-5 text-[15px] text-ink">
            {c.warnings.map((w) => (
              <li key={w.code}>{w.sentence}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <form aria-label="Coverage" className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        {pick('Owner', owner, setOwner, c.owner)}
        {pick('Backup', backup, setBackup, c.backup)}
        {members.isError ? <Notice tone="error">{"Couldn't load the team's members, so nobody new can be picked. Reload to try again."}</Notice> : null}
        <Check label="High intent" hint="A mark for the team and its reports. It changes no routing." checked={high} onChange={setHigh} />
        <Check label="Covered" hint={both ? COVERED_HINT_READY : COVERED_HINT_NEEDS_BOTH} checked={on} disabled={!both} onChange={setCovered} />
        {a.error ? <Notice tone="error">{coverageErrorSentence(a.error)}</Notice> : null}
        <div>
          <Button type="submit" variant="secondary" pending={a.pending} disabled={!dirty}>
            Save coverage
          </Button>
        </div>
      </form>
      <StatusLine text={status} />
    </Card>
  );
}
