// module 46 (R-PORTALWEB-5, R-PORTALWEB-8, R-PORTALWEB-10; R-PORTAL-16): the client's view, as pure components. The
// client portal renders them in 'client' mode; the staff preview (surfaces/client-portal) renders the very same
// components in 'preview' mode, where every control is plain text. Text nodes only: nothing is linkified, every
// server string is direction-isolated (dir="auto") and long words wrap. No window, document, fetch or history here.
import type { KeyboardEvent, ReactNode, Ref } from 'react';
import { mailtoHref, smsHref } from './contact.js';
import { formatLocalDate, formatShared } from './dates.js';
import type { ContactView, DocumentView, GrantView, ItemView } from './parse.js';
import { VIEW_WORDS, byDate, downloadLabel, emailAgent, previewHidden, previewVisible, sharedOn, textAgent, visibleUntil } from './words.js';

export type ViewMode = 'client' | 'preview';

/** Server text: isolated direction, wraps anywhere, never markup. */
export function Txt({ children, className = '' }: { children: string; className?: string }) {
  return (
    <span dir="auto" className={`[overflow-wrap:anywhere] ${className}`}>
      {children}
    </span>
  );
}

const sectionHeading = 'text-[13px] font-semibold uppercase tracking-wide text-ink-muted';
const card = 'flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4';

export function GrantHeader({ grant, level = 1, headingRef }: { grant: GrantView; level?: 1 | 2; headingRef?: Ref<HTMLHeadingElement> }) {
  const H = level === 1 ? 'h1' : 'h2';
  return (
    <header className="flex flex-col gap-1">
      <H ref={headingRef} tabIndex={-1} className="text-[26px] font-bold leading-tight text-ink outline-none md:text-[30px]">
        <Txt>{grant.title}</Txt>
      </H>
      {grant.expiresOn ? <p className="text-[15px] text-ink-muted">{visibleUntil(formatLocalDate(grant.expiresOn))}</p> : null}
    </header>
  );
}

function ItemDates({ item, by }: { item: { occursOn?: string | null; publishedAt: string }; by?: boolean }) {
  return (
    <p className="flex flex-wrap gap-x-3 text-[14px] text-ink-muted">
      {item.occursOn ? <span className="font-semibold text-ink">{by ? byDate(formatLocalDate(item.occursOn)) : formatLocalDate(item.occursOn)}</span> : null}
      <span>{sharedOn(formatShared(item.publishedAt))}</span>
    </p>
  );
}

export function NextSteps({ steps }: { steps: readonly ItemView[] }) {
  if (steps.length === 0) return null;
  return (
    <section aria-labelledby="portal-next-steps" className={card}>
      <h2 id="portal-next-steps" className={sectionHeading}>
        {VIEW_WORDS.nextSteps}
      </h2>
      <ul className="flex flex-col">
        {steps.map((s) => (
          <li key={s.itemId} className="flex flex-col gap-0.5 border-t border-line py-2 first:border-t-0">
            <Txt className="text-[16px] font-medium text-ink">{s.title}</Txt>
            {s.body ? <Txt className="whitespace-pre-line text-[15px] text-ink">{s.body}</Txt> : null}
            <ItemDates item={s} by />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Dated items in the API's order: no done mark, no grouping (R-PORTALWEB-5; Q-PORTALWEB-5). */
export function Timeline({ items, headingId = 'portal-timeline' }: { items: readonly ItemView[]; headingId?: string }) {
  return (
    <section aria-labelledby={headingId} className={card}>
      <h2 id={headingId} className={sectionHeading}>
        {VIEW_WORDS.timeline}
      </h2>
      {items.length === 0 ? (
        <p className="text-[15px] text-ink-muted">{VIEW_WORDS.noDates}</p>
      ) : (
        <ol className="flex flex-col">
          {items.map((i) => (
            <li key={i.itemId} className="flex flex-col gap-0.5 border-t border-line py-2 first:border-t-0">
              <Txt className="text-[16px] font-medium text-ink">{i.title}</Txt>
              {i.body ? <Txt className="whitespace-pre-line text-[15px] text-ink">{i.body}</Txt> : null}
              <ItemDates item={i} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export interface DocumentsProps {
  documents: readonly DocumentView[];
  mode: ViewMode;
  headingId?: string;
  /** client mode: the Download tap (download.ts) */
  onDownload?: (d: DocumentView) => void;
  busyId?: string | null;
  /** client mode: the sentence after a failed download */
  error?: string | null;
}

export function Documents({ documents, mode, headingId = 'portal-documents', onDownload, busyId = null, error = null }: DocumentsProps) {
  return (
    <section aria-labelledby={headingId} className={card}>
      <h2 id={headingId} className={sectionHeading}>
        {VIEW_WORDS.documents}
      </h2>
      {error ? <p className="rounded-lg bg-danger-soft px-3 py-2 text-[15px] text-ink">{error}</p> : null}
      {documents.length === 0 ? (
        <p className="text-[15px] text-ink-muted">{VIEW_WORDS.noDocuments}</p>
      ) : (
        <ul className="flex flex-col">
          {documents.map((d) => (
            <li key={d.itemId} className="flex flex-col gap-1 border-t border-line py-2 first:border-t-0">
              <Txt className="text-[16px] font-medium text-ink">{d.title}</Txt>
              {d.body ? <Txt className="text-[15px] text-ink-muted">{d.body}</Txt> : null}
              <ItemDates item={d} />
              {mode === 'client' ? (
                <button
                  type="button"
                  onClick={() => onDownload?.(d)}
                  disabled={busyId !== null}
                  aria-label={downloadLabel(d.title)}
                  className="inline-flex min-h-tap min-w-tap items-center self-start rounded-xl bg-accent px-4 text-[16px] font-semibold text-accent-ink disabled:opacity-60"
                >
                  {busyId === d.itemId ? VIEW_WORDS.downloading : 'Download'}
                </button>
              ) : (
                <span data-inert="download" className="text-[15px] text-ink-muted">
                  <Txt>{downloadLabel(d.title)}</Txt>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The agent card: names verbatim, links only from view/contact.ts, else the fallback sentence (R-PORTALWEB-8). */
export function ContactCard({ contact, mode, compact = false }: { contact: ContactView | null; mode: ViewMode; compact?: boolean }) {
  const name = contact?.agentName ?? null;
  const sms = smsHref(contact?.textTo);
  const mail = mailtoHref(contact?.emailTo);
  const actions: { key: string; label: string; href: string }[] = [];
  if (sms) actions.push({ key: 'sms', label: textAgent(name), href: sms });
  if (mail) actions.push({ key: 'mail', label: emailAgent(name), href: mail });
  return (
    <section aria-labelledby="portal-contact" className={`${card} ${compact ? 'p-3' : ''}`}>
      <h2 id="portal-contact" className={sectionHeading}>
        {VIEW_WORDS.yourAgent}
      </h2>
      {name ? <Txt className="text-[17px] font-semibold text-ink">{name}</Txt> : null}
      {actions.length === 0 ? (
        <p className="text-[15px] text-ink">{VIEW_WORDS.contactFallback}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {actions.map((a) => (
            <li key={a.key}>
              {mode === 'client' ? (
                <a href={a.href} className="inline-flex min-h-tap items-center rounded-xl border border-line bg-surface-2 px-4 text-[16px] font-semibold text-accent">
                  <Txt>{a.label}</Txt>
                </a>
              ) : (
                <span data-inert="contact" className="inline-flex min-h-tap items-center px-1 text-[15px] text-ink-muted">
                  <Txt>{a.label}</Txt>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The staff preview banner: what the client sees now, or why they can't (45's sentences as given). */
export function PreviewBanner({ name, visibleNow, why }: { name: string; visibleNow: boolean; why: readonly string[] }) {
  const lines = visibleNow ? [previewVisible(name)] : (why.length > 0 ? why : [VIEW_WORDS.previewGeneric]).map((r) => previewHidden(name, r));
  return (
    <div role="note" className={`flex flex-col gap-1 rounded-2xl px-4 py-3 text-[15px] text-ink ${visibleNow ? 'bg-ok-soft' : 'bg-warn-soft'}`}>
      {lines.map((l) => (
        <p key={l}>
          <Txt>{l}</Txt>
        </p>
      ))}
    </div>
  );
}

export type GrantLayout = 'tabs' | 'both';
export type GrantTab = 'timeline' | 'documents';

export interface GrantBodyProps {
  grant: GrantView;
  timeline: { items: readonly ItemView[]; nextSteps: readonly ItemView[] } | null;
  documents: readonly DocumentView[] | null;
  mode: ViewMode;
  /** 'tabs' (the client on a phone) or 'both' (desktop: two columns; the preview: both, stacked on a phone) */
  layout: GrantLayout;
  tab?: GrantTab;
  onTab?: (t: GrantTab) => void;
  headingLevel?: 1 | 2;
  headingRef?: Ref<HTMLHeadingElement>;
  documentsProps?: Omit<DocumentsProps, 'documents' | 'mode'>;
  /** shown in place of a section that is still loading or failed */
  placeholder?: ReactNode;
}

/** One grant: header, next steps, the contact card, then the timeline and documents (tabs on a phone, two columns on desktop). */
export function GrantBody({ grant, timeline, documents, mode, layout, tab = 'timeline', onTab, headingLevel = 1, headingRef, documentsProps, placeholder = null }: GrantBodyProps) {
  const timelinePanel = timeline ? <Timeline items={timeline.items} /> : placeholder;
  const documentsPanel = documents ? <Documents documents={documents} mode={mode} {...documentsProps} /> : placeholder;
  const tabs: { id: GrantTab; label: string }[] = [
    { id: 'timeline', label: VIEW_WORDS.timeline },
    { id: 'documents', label: VIEW_WORDS.documents },
  ];
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const next: GrantTab = e.key === 'Home' ? 'timeline' : e.key === 'End' ? 'documents' : tab === 'timeline' ? 'documents' : 'timeline';
    onTab?.(next);
    (e.currentTarget.parentElement?.querySelector(`[data-tab="${next}"]`) as HTMLButtonElement | null)?.focus();
  };
  return (
    <div className="flex flex-col gap-4">
      <GrantHeader grant={grant} level={headingLevel} {...(headingRef ? { headingRef } : {})} />
      {timeline ? <NextSteps steps={timeline.nextSteps} /> : null}
      <ContactCard contact={grant.contact} mode={mode} compact={layout === 'tabs'} />
      {layout === 'tabs' ? (
        <>
          <div role="tablist" aria-label={grant.title} className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`portal-tab-${t.id}`}
                data-tab={t.id}
                aria-selected={tab === t.id}
                aria-controls={`portal-panel-${t.id}`}
                tabIndex={tab === t.id ? 0 : -1}
                onClick={() => onTab?.(t.id)}
                onKeyDown={onKey}
                className={`min-h-tap rounded-lg text-[16px] font-semibold ${tab === t.id ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`portal-panel-${tab}`} aria-labelledby={`portal-tab-${tab}`}>
            {tab === 'timeline' ? timelinePanel : documentsPanel}
          </div>
        </>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {timelinePanel}
          {documentsPanel}
        </div>
      )}
    </div>
  );
}
