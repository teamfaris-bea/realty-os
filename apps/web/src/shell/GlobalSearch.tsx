// Global search (navigation exploration, directions A and B): one field in the top bar of every signed-in page.
//
// It asks the SAME endpoint as the Search page (GET /search?q=, from 2 characters, 150 ms debounce, a newer query
// aborts the older one) and adds no index. The server scopes every group to what the caller may see (it runs under
// the caller's row-level security; a pond or offer lead comes back as a masked card). This field renders only what
// came back: a person's row shows the name the API returned and which of name / phone / email / address matched
// (the API returns no phone number or email text, so none is shown). The API returns no tasks, so there is no Tasks
// group. Messages and notes are counted on the last row and shown on the Search page ("See all results").
// "Pages" are the role's own navigation entries whose name matches: local, nothing the role cannot already open.
//
// Keyboard (ARIA combobox with a listbox popup): "/" or Cmd/Ctrl+K focuses the field; Down/Up move through the
// rows; Enter opens the highlighted row, or the Search page when none is; Escape closes, then clears.
// `compact` is the phone's: a short field in the page's top bar that grows over the bar on focus, with Cancel.
import { useQuery } from '@tanstack/react-query';
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '../design/index.js';
import { STAGE_LABEL, formatMoney } from '../surfaces/feed/lib/format.js';
import type { DealStage, SearchResponse } from '../surfaces/feed/lib/types.js';
import type { ApiError } from './api.js';
import { useApi } from './context.js';
import { messageFor } from './errorMessages.js';
import type { NavItem } from './pages.js';

export const MIN_QUERY = 2;
export const DEBOUNCE_MS = 150;
const MAX_PEOPLE = 5;
const MAX_OTHER = 3;

const MATCHED: Record<string, string> = { name: 'name', phone: 'phone', email: 'email', address: 'address' };

interface Option {
  key: string;
  to: string;
  title: string;
  detail: string;
  icon: IconName;
}
interface OptionGroup {
  label: string;
  options: Option[];
}

/** The rows for one answer, in order: people first, then deals, listings, and the role's pages by name. */
export function searchGroups(data: SearchResponse | undefined, q: string, pages: readonly NavItem[]): OptionGroup[] {
  const groups: OptionGroup[] = [];
  if (data) {
    groups.push({
      label: 'People',
      options: data.contacts.slice(0, MAX_PEOPLE).map((c) => ({
        key: `c-${c.id}`,
        to: `/contacts/${c.id}`,
        title: c.name,
        detail: c.view === 'card' ? 'Pond or offer lead · claim or accept to see details' : `Matched on ${MATCHED[c.matchedOn] ?? c.matchedOn}`,
        icon: 'person',
      })),
    });
    groups.push({
      label: 'Deals',
      options: data.deals.slice(0, MAX_OTHER).map((d) => ({ key: `d-${d.id}`, to: `/deals/${d.id}`, title: d.name, detail: STAGE_LABEL[d.stage as DealStage] ?? d.stage, icon: 'deal' })),
    });
    groups.push({
      label: 'Listings',
      options: data.listings.slice(0, MAX_OTHER).map((l) => ({
        key: `l-${l.id}`,
        to: `/listings/${l.id}`,
        title: l.address,
        detail: [l.city, l.status.replace(/_/g, ' '), formatMoney(l.listPriceCents)].filter(Boolean).join(' · '),
        icon: 'listing',
      })),
    });
  }
  const needle = q.toLowerCase();
  if (needle.length >= MIN_QUERY) {
    groups.push({
      label: 'Pages',
      options: pages
        .filter((p) => p.label.toLowerCase().includes(needle))
        .slice(0, MAX_OTHER)
        .map((p) => ({ key: `p-${p.path}`, to: p.path, title: p.label, detail: 'Go to this page', icon: p.icon })),
    });
  }
  return groups.filter((g) => g.options.length > 0);
}

// The phone's field at rest. Just the magnifier (44 × 44, the word "Search" hidden) on a detail page, and on any page
// of a phone narrower than 360 px: the page's title needs the room more than the field does.
const RESTING_TIGHT = 'w-11 pr-0 placeholder:text-transparent';
const RESTING_NARROW = 'max-[359px]:w-11 max-[359px]:pr-0 max-[359px]:placeholder:text-transparent';

const isDesktop = () => (typeof window === 'undefined' ? true : (window.matchMedia?.('(min-width: 768px)').matches ?? true));

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
}

export interface GlobalSearchProps {
  variant: 'bar' | 'compact';
  /** the role's navigation entries, for the "Pages" matches */
  pages: readonly NavItem[];
  /** bar only: which edge of the field the results line up with */
  align?: 'left' | 'right';
  /** bar only: below 1024 px the field is short (direction B's bar), so its placeholder is the one word "Search" */
  shortBelowLg?: boolean;
  /** compact only: at rest the field is just its magnifier (a detail page, whose title is a person's name, needs the room) */
  tight?: boolean;
}

/** Whether the window is at least 1024 px wide (true where matchMedia does not exist). */
function useLgUp(): boolean {
  const query = '(min-width: 1024px)';
  const [lg, setLg] = useState(() => (typeof window === 'undefined' ? true : (window.matchMedia?.(query).matches ?? true)));
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return undefined;
    const on = () => setLg(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return lg;
}

export function GlobalSearch({ variant, pages, align = 'left', tight = false, shortBelowLg = false }: GlobalSearchProps) {
  const lgUp = useLgUp();
  const api = useApi();
  const navigate = useNavigate();
  const location = useLocation();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const trimmed = text.trim();

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);

  const res = useQuery<SearchResponse, ApiError>({
    queryKey: ['search', q],
    queryFn: ({ signal }) => api.get<SearchResponse>(`/search?q=${encodeURIComponent(q)}`, { signal }),
    enabled: open && q.length >= MIN_QUERY,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
  /** the answer on screen belongs to what is in the field (not to an older query still being replaced) */
  const settled = q === trimmed && q.length >= MIN_QUERY && res.data !== undefined && !res.isPlaceholderData;
  const data = trimmed.length >= MIN_QUERY ? res.data : undefined;
  const groups = useMemo(() => searchGroups(data, trimmed, pages), [data, trimmed, pages]);
  const total = data ? data.contacts.length + data.listings.length + data.deals.length + data.notes.length + data.messages.length : 0;
  const elsewhere = data ? data.notes.length + data.messages.length : 0;
  const seeAll: Option | null =
    trimmed.length >= MIN_QUERY && !res.isError && (total > 0 || !settled)
      ? { key: 'all', to: `/search?q=${encodeURIComponent(trimmed)}`, title: `See all results for “${trimmed}”`, detail: elsewhere > 0 ? `Also ${elsewhere} in messages and notes` : 'Opens the Search page', icon: 'search' }
      : null;
  const flat = [...groups.flatMap((g) => g.options), ...(seeAll ? [seeAll] : [])];

  // the first row is ready for Enter once the answer is the field's own; never while an older answer is showing
  useEffect(() => {
    setActive(settled && groups.length > 0 ? 0 : -1);
  }, [settled, groups]);

  const close = (clear: boolean) => {
    setOpen(false);
    setActive(-1);
    if (clear) setText('');
  };

  // a page change closes and empties the field (the desktop bar outlives the page)
  useEffect(() => {
    close(true);
  }, [location.pathname, location.search]);

  // "/" and Cmd/Ctrl+K, only for the field of the layout on screen, never while a dialog holds the page inert
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((variant === 'bar') !== isDesktop()) return;
      const el = input.current;
      if (!el || el.closest('[inert]')) return;
      const k = (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k';
      const slash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target);
      if (!k && !slash) return;
      e.preventDefault();
      el.focus();
      el.select();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [variant]);

  // a press outside closes the results (the text stays in the bar; the phone's field has Cancel for that)
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) close(variant === 'compact' && trimmed === '');
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  });

  const go = (to: string) => {
    close(true);
    input.current?.blur();
    navigate(to);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) setOpen(true);
      if (flat.length === 0) return;
      setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % flat.length : (a <= 0 ? flat.length : a) - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = active >= 0 ? flat[active] : undefined;
      if (chosen) go(chosen.to);
      else go(trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : '/search');
    } else if (e.key === 'Escape') {
      if (open && variant === 'bar' && text !== '') {
        e.preventDefault();
        close(false);
      } else {
        close(true);
        input.current?.blur();
      }
    }
  };

  useEffect(() => {
    if (active >= 0) document.getElementById(`${id}-o-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, id]);

  const compact = variant === 'compact';
  const expanded = compact && open;
  const showPanel = open && (compact || text !== '');
  const status =
    trimmed.length === 0
      ? ''
      : trimmed.length < MIN_QUERY
        ? `Type at least ${MIN_QUERY} characters.`
        : res.isError
          ? messageFor(res.error)
          : !data
            ? 'Searching'
            : settled && flat.length === 0
              ? `No matches for “${trimmed}”.`
              : '';

  let n = -1;
  const panel = showPanel ? (
    <div
      className={
        compact
          ? 'absolute inset-x-0 top-full z-10 h-[calc(100dvh-52px-env(safe-area-inset-top))] overflow-y-auto overscroll-contain border-t border-line bg-canvas px-3 pb-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+48px)] pt-3'
          : `absolute top-full z-40 mt-2 max-h-[min(72dvh,640px)] w-full min-w-[min(460px,calc(100vw-32px))] overflow-y-auto rounded-2xl border border-line bg-surface p-2 shadow-xl ${align === 'right' ? 'right-0' : 'left-0'}`
      }
    >
      <p role="status" className={status ? 'px-3 py-2 text-[15px] text-ink-muted' : 'sr-only'}>
        {status || (settled ? `${flat.length} ${flat.length === 1 ? 'result' : 'results'}` : '')}
      </p>
      {trimmed.length === 0 ? <p className="px-3 py-2 text-[15px] text-ink-muted">Search by name, phone, email or address.</p> : null}
      {data && data.incomplete.length > 0 ? <p className="px-3 py-2 text-[14px] text-warn">Some results may be missing: part of the search took too long.</p> : null}
      <div id={`${id}-list`} role="listbox" aria-label="Search results" aria-busy={res.isFetching || undefined} className={compact ? 'flex flex-col gap-3' : 'flex flex-col gap-1'}>
        {groups.map((g) => (
          <div key={g.label} role="group" aria-label={g.label} className={compact ? 'overflow-hidden rounded-2xl border border-line bg-surface' : ''}>
            <p aria-hidden="true" className="px-3 pb-1 pt-2 text-[12px] font-semibold uppercase tracking-wide text-ink-muted">
              {g.label}
            </p>
            {g.options.map((o) => {
              n += 1;
              return <Row key={o.key} id={`${id}-o-${n}`} option={o} active={n === active} onHover={((i) => () => setActive(i))(n)} onChoose={() => go(o.to)} />;
            })}
          </div>
        ))}
        {seeAll ? (
          <div className={compact ? 'overflow-hidden rounded-2xl border border-line bg-surface' : 'border-t border-line pt-1'}>
            <Row id={`${id}-o-${flat.length - 1}`} option={seeAll} active={active === flat.length - 1} onHover={() => setActive(flat.length - 1)} onChoose={() => go(seeAll.to)} />
          </div>
        ) : null}
      </div>
    </div>
  ) : null;

  return (
    <div ref={root} data-search={variant} className={expanded ? 'absolute inset-0 z-10 flex items-center gap-1 bg-surface px-2' : compact ? 'relative shrink-0' : 'relative w-full'}>
      <form role="search" onSubmit={(e) => e.preventDefault()} className="relative min-w-0 flex-1">
        <label htmlFor={`${id}-q`} className="sr-only">
          Search people, deals and listings
        </label>
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">
          <Icon name="search" size={18} />
        </span>
        <input
          ref={input}
          id={`${id}-q`}
          type="search"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={showPanel && active >= 0 ? `${id}-o-${active}` : undefined}
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={(e) => {
            // focus left the field for something outside the search (Tab, a click elsewhere)
            if (!root.current?.contains(e.relatedTarget)) {
              if (variant === 'bar') close(false);
              else if (trimmed === '') close(true);
            }
          }}
          onKeyDown={onKeyDown}
          placeholder={(compact && !expanded) || (shortBelowLg && !lgUp) ? 'Search' : 'Search people, deals, listings'}
          className={`min-h-tap rounded-xl border border-line bg-surface-2 pl-9 text-ink placeholder:text-ink-muted [&::-webkit-search-cancel-button]:appearance-none ${
            compact ? `text-[16px] ${expanded ? 'w-full pr-3' : tight ? RESTING_TIGHT : `w-[112px] pr-2 ${RESTING_NARROW}`}` : 'w-full pr-3 text-[15px] lg:pr-12'
          }`}
        />
        {!compact ? (
          <kbd aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-md border border-line bg-surface px-1.5 text-[12px] font-medium leading-5 text-ink-muted lg:block">
            /
          </kbd>
        ) : null}
      </form>
      {expanded ? (
        <button
          type="button"
          onClick={() => {
            close(true);
            input.current?.blur();
          }}
          className="inline-flex min-h-tap shrink-0 items-center rounded-xl px-2 text-[16px] font-medium text-accent"
        >
          Cancel
        </button>
      ) : null}
      {panel}
    </div>
  );
}

function Row({ id, option, active, onHover, onChoose }: { id: string; option: Option; active: boolean; onHover: () => void; onChoose: () => void }) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      // keep focus in the field: the press must not blur it before the click lands
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={onHover}
      onClick={onChoose}
      className={`flex min-h-[52px] cursor-pointer items-center gap-3 rounded-xl px-3 py-1.5 ${active ? 'bg-accent-soft' : ''}`}
    >
      <span className={active ? 'text-accent' : 'text-ink-muted'}>
        <Icon name={option.icon} size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[16px] font-medium text-ink [overflow-wrap:anywhere]">{option.title}</span>
        <span className="block text-[13px] text-ink-muted [overflow-wrap:anywhere]">{option.detail}</span>
      </span>
    </div>
  );
}
