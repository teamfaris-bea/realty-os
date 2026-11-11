// Shapes of the website chat widget admin API (apps/api/src/channels/routes.ts), copied field by field.
//   GET  /admin/web-chat/widgets              { widgets }
//   POST /admin/web-chat/widgets              { widget, widgetKey }   the key, ONCE
//   POST /admin/web-chat/widgets/:id/rotate   { widget, widgetKey }   a new key, ONCE
//   PUT  /admin/web-chat/widgets/:id/origins  { widget }
//   GET  /admin/web-chat/widgets/:id/embed    { brokerage, disclosure } (no key)
// The widget key is never part of Widget: pickKeyed returns it separately and only the page's one-time panel
// holds it (component state; never the query cache, storage or the URL).

export interface Widget {
  id: string;
  displayName: string;
  status: string;
  leadSourceId: string | null;
  allowedOrigins: string[];
  connectedAt: string | null;
  sentence: string;
}

export interface Embed {
  brokerage: string;
  disclosure: { id: string; text: string } | null;
}

export interface LeadSource {
  id: string;
  name: string;
  active: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function pickWidget(raw: unknown): Widget {
  const w = obj(raw);
  return {
    id: str(w.id),
    displayName: str(w.displayName),
    status: str(w.status),
    leadSourceId: typeof w.leadSourceId === 'string' ? w.leadSourceId : null,
    allowedOrigins: arr(w.allowedOrigins).filter((x): x is string => typeof x === 'string'),
    connectedAt: typeof w.connectedAt === 'string' ? w.connectedAt : null,
    sentence: str(w.sentence),
  };
}

export const pickWidgets = (raw: unknown): Widget[] => arr(obj(raw).widgets).map(pickWidget);

/** The one place a key is read from a response. */
export function pickKeyed(raw: unknown): { widget: Widget; key: string | null } {
  const o = obj(raw);
  const key = typeof o.widgetKey === 'string' && /^[\x21-\x7E]{8,200}$/.test(o.widgetKey) ? o.widgetKey : null;
  return { widget: pickWidget(o.widget), key };
}

export function pickEmbed(raw: unknown): Embed {
  const o = obj(raw);
  const d = obj(o.disclosure);
  return { brokerage: str(o.brokerage), disclosure: typeof d.id === 'string' && typeof d.text === 'string' ? { id: d.id, text: d.text } : null };
}

export const pickSources = (raw: unknown): LeadSource[] =>
  arr(obj(raw).sources).map((x) => {
    const s = obj(x);
    return { id: str(s.id), name: str(s.name), active: s.active === true };
  });
