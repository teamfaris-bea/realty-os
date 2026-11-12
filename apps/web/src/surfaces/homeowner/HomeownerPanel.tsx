// The homeowner profile panel on the person page (module 79; owner decision D10). Registered through module 58's
// section registry (surfaces/contact/sections.ts, id 'homeowner', order 30); hidden when the person is not
// recognised as a seller or homeowner, or the viewer cannot read it. Read only: there is no copy-all, export, send,
// list or "check now" control. Every state is in words; every link goes through safeUrl and opens a public county
// page in a new tab (never carrying the address). Internal to agents: nothing here is ever shown to the client.
import { Card, safeUrl } from '../../design/index.js';
import type { ContactFullView } from '../feed/lib/types.js';
import { type HomeView, type ViewRow, useHomeowner } from './api.js';
import * as T from './copy.js';

function ExternalLink({ label, url }: { label: string; url: string }) {
  const href = safeUrl(url, { allow: ['https:'] });
  if (!href) return <span>{label}</span>;
  return (
    <a className="inline-flex min-h-tap items-center font-medium text-accent underline" href={href} target="_blank" rel="noopener noreferrer">
      {label}
      <span className="sr-only"> (opens a county website in a new tab)</span>
    </a>
  );
}

function Row({ row }: { row: ViewRow }) {
  const label = T.FIELD_LABELS[row.key] ?? row.key;
  if (row.state === 'value') {
    return (
      <li className="flex flex-col py-2">
        <span className="text-[13px] text-ink-muted">{label}</span>
        <span className="text-[16px] text-ink">{T.valueText(row)}</span>
        <span className="text-[13px] text-ink-muted">{T.sourceLine(row)}</span>
      </li>
    );
  }
  const link = row.state !== 'pending_d9' ? row.link : null;
  return (
    <li className="flex flex-col py-2">
      <span className="text-[13px] text-ink-muted">{label}</span>
      <span className="text-[15px] text-ink-muted">
        {T.whyText(row)}
        {link ? (
          <>
            {' · look in '}
            <ExternalLink label={link.label} url={link.url} />
          </>
        ) : null}
      </span>
    </li>
  );
}

function Home({ home, firstName, index }: { home: HomeView; firstName: string | null; index: number }) {
  const check = T.checkText(home.check);
  const outcome = T.outcomeText(home, firstName);
  const headingId = `homeowner-home-${index}`;
  const rows = home.rows.filter((r) => r.state === 'value' || home.outcome === 'matched' || r.state === 'pending_d9');
  return (
    <article aria-labelledby={headingId} className="flex flex-col gap-2 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <h3 id={headingId} className="text-[16px] font-semibold text-ink">
        {home.address}
      </h3>
      {home.county ? <p className="text-[14px] text-ink-muted">{home.county.name}</p> : null}
      {check ? <p className="text-[14px] text-ink">{check}</p> : null}
      {home.providerNote && home.check.state !== 'not_configured' ? <p className="text-[14px] text-ink-muted">{home.providerNote}</p> : null}
      {outcome ? <p className="text-[15px] text-ink">{outcome}</p> : null}
      {home.lookupLinks.length > 0 ? (
        <p className="text-[15px] text-ink">
          {T.JASPER}{' '}
          {home.lookupLinks.map((l) => (
            <ExternalLink key={l.url} label={l.label} url={l.url} />
          ))}
        </p>
      ) : null}
      {home.yearsOwned ? <p className="text-[15px] text-ink">{T.yearsText(home.yearsOwned)}</p> : null}
      {home.mailingDiffers !== null ? <p className="text-[15px] text-ink">{home.mailingDiffers ? T.TAX_MAIL_ELSEWHERE : T.TAX_MAIL_HERE}</p> : null}
      {home.outcome !== 'outside_area' ? (
        <ul aria-label={`Values for ${home.address}`} className="divide-y divide-line">
          {rows.map((r) => (
            <Row key={r.key} row={r} />
          ))}
        </ul>
      ) : null}
      {home.loansLink ? (
        <p className="text-[15px] text-ink-muted">
          {T.LOANS}: <ExternalLink label={home.loansLink.label} url={home.loansLink.url} />
        </p>
      ) : null}
    </article>
  );
}

export function HomeownerPanel({ contact }: { contact: ContactFullView }) {
  const q = useHomeowner(contact.id);
  if (q.isError || !q.data || !q.data.recognized) return null;
  const v = q.data;
  return (
    <Card aria-labelledby="homeowner-title" className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h2 id="homeowner-title" className="text-[17px] font-semibold text-ink">
          {T.HEADER}
        </h2>
        <p className="text-[14px] font-medium text-ink">{T.INTERNAL}</p>
        <p className="text-[14px] text-ink-muted">{T.reasonsText(v.reasons)}</p>
      </header>
      {v.homes.length === 0 ? <p className="text-[15px] text-ink-muted">No home or property address is recorded for this person.</p> : null}
      {v.homes.map((home, i) => (
        <Home key={`${home.address}-${i}`} home={home} firstName={contact.firstName} index={i} />
      ))}
      <footer className="flex flex-col gap-1 border-t border-line pt-3">
        <p className="text-[14px] text-ink-muted">{T.FOOTER}</p>
        <p className="text-[14px] text-ink-muted">{T.outreachText(v.outreach.clearanceOn)}</p>
      </footer>
    </Card>
  );
}
