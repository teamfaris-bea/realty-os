// The one serializer from portal rows to the client's view (R-PORTAL-16). Pure: the client routes and the staff preview
// (portal/staff) both call it, so the preview is exactly what the client sees. Reads only the three portal tables'
// columns; ids are portal ids (grant and item), never a deal, listing, contact or document id.
import type { PortalKind } from '@realty/core/portal';

export type Scope = 'purchase' | 'sale' | 'listing';

export interface GrantDisplay {
  title?: string;
  scope?: Scope;
  agentName?: string;
  textTo?: string;
  emailTo?: string;
}

export interface PortalGrantRow {
  id: string;
  display: unknown;
  expiresAt: Date | null;
}

export interface PortalItemRow {
  id: string;
  grantId: string;
  kind: PortalKind;
  title: string;
  body: string | null;
  /** YYYY-MM-DD (portal_items.occurs_on::text) */
  occursOn: string | null;
  publishedAt: Date;
}

export interface GrantView {
  id: string;
  scope: Scope | null;
  title: string;
  contact: { agentName: string | null; textTo: string | null; emailTo: string | null } | null;
  /** the UTC date the access ends, or null while open-ended */
  expiresOn: string | null;
}

export interface ItemView {
  itemId: string;
  kind: 'milestone' | 'showing' | 'feedback' | 'seller_update' | 'next_step';
  title: string;
  body: string | null;
  occursOn: string | null;
  publishedAt: string;
}

export interface DocumentItemView {
  itemId: string;
  title: string;
  body: string | null;
  publishedAt: string;
}

const SCOPES: readonly Scope[] = ['purchase', 'sale', 'listing'];
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() !== '' && [...v].length <= max && !/\p{Cc}/u.test(v) ? v : undefined);

/** The stored copy, re-read defensively (the DB CHECK already holds it): unknown keys and bad values are dropped. */
export function displayOf(raw: unknown): GrantDisplay {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: GrantDisplay = {};
  const title = str(r.title, 120);
  if (title) out.title = title;
  if (typeof r.scope === 'string' && (SCOPES as readonly string[]).includes(r.scope)) out.scope = r.scope as Scope;
  const agentName = str(r.agentName, 120);
  if (agentName) out.agentName = agentName;
  if (typeof r.textTo === 'string' && /^\+[1-9][0-9]{6,14}$/.test(r.textTo)) out.textTo = r.textTo;
  const emailTo = str(r.emailTo, 320);
  if (emailTo && /^[^@\s]+@[^@\s]+$/.test(emailTo)) out.emailTo = emailTo;
  return out;
}

export const DEFAULT_TITLES: Record<Scope, string> = { purchase: 'Your home purchase', sale: 'Your home sale', listing: 'Your home sale' };

export function grantView(g: PortalGrantRow): GrantView {
  const d = displayOf(g.display);
  const contact = d.agentName || d.textTo || d.emailTo ? { agentName: d.agentName ?? null, textTo: d.textTo ?? null, emailTo: d.emailTo ?? null } : null;
  return {
    id: g.id,
    scope: d.scope ?? null,
    title: d.title ?? (d.scope ? DEFAULT_TITLES[d.scope] : 'Your client portal'),
    contact,
    expiresOn: g.expiresAt === null ? null : g.expiresAt.toISOString().slice(0, 10),
  };
}

const byDateThenPublished = (a: PortalItemRow, b: PortalItemRow): number => {
  if (a.occursOn !== b.occursOn) {
    if (a.occursOn === null) return 1;
    if (b.occursOn === null) return -1;
    return a.occursOn < b.occursOn ? -1 : 1;
  }
  const t = a.publishedAt.getTime() - b.publishedAt.getTime();
  return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

const itemView = (i: PortalItemRow): ItemView => ({
  itemId: i.id,
  kind: i.kind as ItemView['kind'],
  title: i.title,
  body: i.body,
  occursOn: i.occursOn,
  publishedAt: i.publishedAt.toISOString(),
});

/** Milestones, showings, feedback and seller updates by date then publication; next steps apart. */
export function timelineView(items: readonly PortalItemRow[]): { items: ItemView[]; nextSteps: ItemView[] } {
  const sorted = [...items].sort(byDateThenPublished);
  return {
    items: sorted.filter((i) => i.kind !== 'document' && i.kind !== 'next_step').map(itemView),
    nextSteps: sorted.filter((i) => i.kind === 'next_step').map(itemView),
  };
}

export function documentsView(items: readonly PortalItemRow[]): DocumentItemView[] {
  return [...items]
    .filter((i) => i.kind === 'document')
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime() || (a.id < b.id ? -1 : 1))
    .map((i) => ({ itemId: i.id, title: i.title, body: i.body, publishedAt: i.publishedAt.toISOString() }));
}

/** Everything the client sees for one grant (the staff preview renders exactly this). */
export function grantContent(g: PortalGrantRow, items: readonly PortalItemRow[]) {
  const own = items.filter((i) => i.grantId === g.id);
  return { grant: grantView(g), timeline: timelineView(own), documents: documentsView(own) };
}
