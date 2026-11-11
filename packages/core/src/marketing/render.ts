// Rendering a piece version (R-MKT-1, R-MKT-3, R-MKT-5, R-MKT-9; E90, E92).
//
//   renderPiece(p, facts, identity, packs) → Rendered
//
// - R-MKT-5 / R-MLS-4: only the team's own listings get marketing; an MLS listing is a refusal
//   (`MARKETING_TEAM_LISTING_ONLY`), never a rendering. The DB trigger refuses the row as well.
// - R-MKT-3 / E90: bound facts (price, status, beds, baths, sqft, address, open-house time, photos)
//   are rendered LIVE from `facts` on every call. They never come from the prose, so a price change
//   shows the new price with no re-approval and the approved prose unchanged.
// - R-MKT-1: the brokerage legal name is rendered on every kind, from the identity, by the template.
//   The identity block (team name, licence number, office address) and the pack's equal-housing
//   statement are rendered from data; templates set each block's prominence so the jurisdiction
//   rule "brokerage name at least as prominent as the team name" is decidable (E92).
// - R-MKT-9: a sold, withdrawn or expired listing always shows its status, bound or not.
// Pure: time is the piece's stored open-house instants, formatted in their zone.
import { DateTime } from 'luxon';
import { formatPriceCents } from '../assistant/index.js';
import { marketingEligible, type ListingFacts } from '../listings/index.js';
import { resolveAdvertisingRules } from './packs.js';
import { PieceSchemas } from './schemas.js';
import type {
  AdvertisingRules,
  AssetRef,
  Block,
  BlockOrigin,
  BlockRole,
  BoundField,
  BrokerageIdentity,
  OpenHouse,
  Packs,
  PieceKind,
  PieceVersion,
  Prominence,
  RenderIssue,
  Rendered,
  RenderRefusal,
} from './types.js';
import { BOUND_FIELDS } from './types.js';

// ---- templates (layout data: which blocks, in which order, how prominent) -----------------------

export interface TemplateSlot {
  readonly role: BlockRole;
  readonly prominence: Prominence;
}

export interface Template {
  readonly key: string;
  readonly kind: PieceKind;
  readonly slots: readonly TemplateSlot[];
}

const s = (role: BlockRole, prominence: Prominence): TemplateSlot => ({ role, prominence });

/** Identity and pack blocks, at the prominence a template gives them. */
const identity = (brokerage: Prominence, team: Prominence, fine: Prominence): TemplateSlot[] => [
  s('brokerage_name', brokerage),
  s('team_name', team),
  s('license', fine),
  s('brokerage_address', fine),
  s('equal_housing', fine),
];

const factsSlots = (p: Prominence, headline: Prominence): TemplateSlot[] => [s('price', headline), s('status', p), s('address', headline), s('facts', p)];

const deepFreeze = <T>(o: T): T => {
  if (typeof o === 'object' && o !== null && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
};

export const TEMPLATES: Readonly<Record<string, Template>> = deepFreeze({
  'website_page.standard': {
    key: 'website_page.standard',
    kind: 'website_page',
    slots: [s('headline', 'display'), ...factsSlots('body', 'heading'), s('body', 'body'), s('highlights', 'body'), s('gallery', 'body'), ...identity('heading', 'heading', 'small')],
  },
  'social_post.standard': {
    key: 'social_post.standard',
    kind: 'social_post',
    slots: [s('caption', 'body'), ...factsSlots('body', 'body'), s('hashtags', 'body'), ...identity('body', 'body', 'body')],
  },
  'open_house_invite.standard': {
    key: 'open_house_invite.standard',
    kind: 'open_house_invite',
    slots: [s('subject', 'heading'), s('open_house', 'heading'), ...factsSlots('body', 'heading'), s('body', 'body'), s('gallery', 'body'), ...identity('body', 'body', 'small')],
  },
  'flyer.standard': {
    key: 'flyer.standard',
    kind: 'flyer',
    slots: [s('headline', 'display'), ...factsSlots('body', 'heading'), s('body', 'body'), s('highlights', 'body'), s('gallery', 'body'), ...identity('heading', 'heading', 'small')],
  },
  /** Team name as the hero, brokerage in the footer: fails a pack that requires brokerage prominence (E92). */
  'flyer.team_forward': {
    key: 'flyer.team_forward',
    kind: 'flyer',
    slots: [s('team_name', 'display'), s('headline', 'heading'), ...factsSlots('body', 'heading'), s('body', 'body'), s('highlights', 'body'), s('gallery', 'body'), s('brokerage_name', 'footnote'), s('license', 'footnote'), s('brokerage_address', 'footnote'), s('equal_housing', 'footnote')],
  },
  'marketplace_export.standard': {
    key: 'marketplace_export.standard',
    kind: 'marketplace_export',
    slots: [s('title', 'heading'), ...factsSlots('body', 'heading'), s('body', 'body'), ...identity('body', 'body', 'body')],
  },
  'gbp_post.standard': {
    key: 'gbp_post.standard',
    kind: 'gbp_post',
    slots: [s('body', 'body'), ...factsSlots('body', 'body'), ...identity('body', 'body', 'body')],
  },
} satisfies Record<string, Template>);

/** The default template of each kind (module 29 creates pieces with it). */
export const DEFAULT_TEMPLATE: Readonly<Record<PieceKind, string>> = Object.freeze({
  website_page: 'website_page.standard',
  social_post: 'social_post.standard',
  open_house_invite: 'open_house_invite.standard',
  flyer: 'flyer.standard',
  marketplace_export: 'marketplace_export.standard',
  gbp_post: 'gbp_post.standard',
});

// ---- bound facts ---------------------------------------------------------------------------------

const STATUS_LABEL: Readonly<Record<ListingFacts['status'], string>> = {
  coming_soon: 'Coming soon',
  active: 'For sale',
  pending: 'Sale pending',
  sold: 'Sold',
  withdrawn: 'No longer available',
  expired: 'No longer available',
};

export const OFF_MARKET_STATUSES: readonly ListingFacts['status'][] = ['sold', 'withdrawn', 'expired'];

function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function bathsText(x10: number): string {
  return x10 % 10 === 0 ? String(x10 / 10) : (x10 / 10).toFixed(1);
}

function addressText(f: ListingFacts): string {
  const street = [f.addressLine1, f.addressLine2].filter((x): x is string => x !== null && x.trim() !== '').join(', ');
  const locality = `${f.city}, ${f.region} ${f.postalCode}`.trim();
  return [street, locality].filter((x) => x !== '').join(', ');
}

/** "Open house: Sat, Nov 14, 1:00 PM – 3:00 PM CST" in the open house's own zone. */
export function formatOpenHouse(o: OpenHouse): string {
  const a = DateTime.fromMillis(o.startsAt, { zone: o.zone, locale: 'en-US' });
  const b = DateTime.fromMillis(o.endsAt, { zone: o.zone, locale: 'en-US' });
  const end = a.hasSame(b, 'day') ? b.toFormat('h:mm a ZZZZ') : b.toFormat('ccc, LLL d, h:mm a ZZZZ');
  return `Open house: ${a.toFormat('ccc, LLL d, h:mm a')} – ${end}`;
}

// ---- rendering ---------------------------------------------------------------------------------------

const refusal = (code: RenderRefusal['code'], reason: string): RenderRefusal => ({ ok: false, code, reason });

const norm = (x: string): string => x.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '').replace(/\s+/gu, ' ').trim().toLowerCase();

/** Whether the team name is shown as its own block (a solo brokerage's team name is its name). */
function teamShown(id: BrokerageIdentity): boolean {
  const t = norm(id.teamName);
  return t !== '' && t !== norm(id.brokerageLegalName);
}

function proseText(kind: PieceKind, prose: Record<string, unknown>, role: BlockRole): string | null {
  const str = (k: string): string | null => (typeof prose[k] === 'string' ? (prose[k] as string).trim() : null);
  const list = (k: string, sep: string): string | null => {
    const v = prose[k];
    if (!Array.isArray(v) || v.length === 0) return null;
    return (v as string[]).map((x) => x.trim()).join(sep);
  };
  switch (role) {
    case 'headline':
    case 'subject':
    case 'title':
    case 'caption':
      return str(role);
    case 'body':
      return kind === 'marketplace_export' ? str('description') : str('body');
    case 'highlights':
      return list('highlights', '\n');
    case 'hashtags':
      return list('hashtags', ' ');
    default:
      return null;
  }
}

const PROSE_ROLES: ReadonlySet<BlockRole> = new Set(['headline', 'subject', 'title', 'caption', 'body', 'highlights', 'hashtags']);

interface Ctx {
  readonly p: PieceVersion;
  readonly prose: Record<string, unknown>;
  readonly facts: ListingFacts;
  readonly identity: BrokerageIdentity;
  readonly rules: AdvertisingRules;
  readonly bound: ReadonlySet<BoundField>;
  readonly images: readonly AssetRef[];
}

function slotContent(c: Ctx, role: BlockRole): { origin: BlockOrigin; text: string } | null {
  if (PROSE_ROLES.has(role)) {
    const t = proseText(c.p.kind, c.prose, role);
    return t === null || t === '' ? null : { origin: 'prose', text: t };
  }
  const f = c.facts;
  const bound = (t: string | null): { origin: BlockOrigin; text: string } | null => (t === null || t === '' ? null : { origin: 'bound', text: t });
  switch (role) {
    case 'price':
      return c.bound.has('price') && f.listPriceCents !== null ? bound(formatPriceCents(f.listPriceCents)) : null;
    case 'status':
      return c.bound.has('status') || OFF_MARKET_STATUSES.includes(f.status) ? bound(STATUS_LABEL[f.status]) : null;
    case 'address':
      return c.bound.has('address') ? bound(addressText(f)) : null;
    case 'facts': {
      const parts: string[] = [];
      if (c.bound.has('beds') && f.beds !== null) parts.push(`${f.beds} bd`);
      if (c.bound.has('baths') && f.bathsX10 !== null) parts.push(`${bathsText(f.bathsX10)} ba`);
      if (c.bound.has('sqft') && f.sqft !== null) parts.push(`${groupThousands(f.sqft)} sq ft`);
      return bound(parts.length > 0 ? parts.join(' · ') : null);
    }
    case 'open_house':
      return c.bound.has('open_house_at') && c.p.openHouse ? bound(formatOpenHouse(c.p.openHouse)) : null;
    case 'gallery':
      // images are carried in `images`; the block marks where they are drawn
      return c.bound.has('photos') && c.images.length > 0 ? { origin: 'bound', text: '' } : null;
    case 'brokerage_name': {
      const n = c.identity.brokerageLegalName.trim();
      return n === '' ? null : { origin: 'identity', text: n };
    }
    case 'team_name':
      return teamShown(c.identity) ? { origin: 'identity', text: c.identity.teamName.trim() } : null;
    case 'license': {
      const l = c.identity.licenseNumber?.trim() ?? '';
      return l === '' ? null : { origin: 'identity', text: `License #${l}` };
    }
    case 'brokerage_address': {
      const parts = [c.identity.brokerageAddress, c.identity.brokeragePhone ?? null].map((x) => x?.trim() ?? '').filter((x) => x !== '');
      return parts.length === 0 ? null : { origin: 'identity', text: parts.join(' · ') };
    }
    case 'equal_housing':
      return c.rules.requireEqualHousingStatement ? { origin: 'pack', text: c.rules.equalHousingStatement } : null;
    default:
      return null;
  }
}

/**
 * Render one piece version against the live team listing. Never throws: an MLS listing, an unknown
 * or mismatched template, invalid prose or an unknown bound field is a `RenderRefusal`.
 */
export function renderPiece(p: PieceVersion, facts: ListingFacts, identity: BrokerageIdentity, packs: Packs): Rendered {
  if (!marketingEligible(facts)) {
    return refusal('MARKETING_TEAM_LISTING_ONLY', 'Only your own listings get marketing. MLS listings from other brokerages cannot be marketed here.');
  }
  const template = Object.hasOwn(TEMPLATES, p.templateKey) ? TEMPLATES[p.templateKey] : undefined;
  if (template === undefined || template.kind !== p.kind) {
    return refusal('MARKETING_TEMPLATE_UNKNOWN', `There is no ${p.kind.replace(/_/g, ' ')} template named "${p.templateKey}".`);
  }
  const schema = PieceSchemas[p.kind];
  const parsed = schema.safeParse(p.prose);
  if (!parsed.success) {
    return refusal('MARKETING_PROSE_INVALID', `The copy does not fit a ${p.kind.replace(/_/g, ' ')}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'copy'}: ${i.message}`).join('; ')}.`);
  }
  const unknown = p.boundFields.filter((f) => !(BOUND_FIELDS as readonly string[]).includes(f));
  if (unknown.length > 0) return refusal('MARKETING_BOUND_FIELD_INVALID', `Unknown bound fields: ${unknown.join(', ')}.`);

  const issues: RenderIssue[] = [];
  const images = [...p.assets].sort((a, b) => a.position - b.position);
  const positions = new Set(images.map((a) => a.position));
  const objects = new Set(images.map((a) => a.objectId));
  if (positions.size !== images.length || objects.size !== images.length) {
    issues.push({ ruleId: 'platform.assets', reason: 'Each image appears once, at its own position.' });
  }
  if (p.kind === 'open_house_invite' && (!p.boundFields.includes('open_house_at') || !p.openHouse)) {
    issues.push({ ruleId: 'platform.open_house_time', reason: 'An open-house invite needs its open-house time set on the piece; the time is never typed into the copy.' });
  }
  if (p.openHouse && p.openHouse.endsAt <= p.openHouse.startsAt) {
    issues.push({ ruleId: 'platform.open_house_time', reason: 'The open house ends before it starts.' });
  }

  const ctx: Ctx = {
    p,
    prose: parsed.data as Record<string, unknown>,
    facts,
    identity,
    rules: resolveAdvertisingRules(packs),
    bound: new Set(p.boundFields),
    images,
  };
  const blocks: Block[] = [];
  for (const slot of template.slots) {
    const c = slotContent(ctx, slot.role);
    if (c !== null) blocks.push({ role: slot.role, origin: c.origin, prominence: slot.prominence, text: c.text });
  }
  const text = blocks
    .map((b) => b.text)
    .filter((t) => t !== '')
    .join('\n');
  return { ok: true, kind: p.kind, templateKey: template.key, blocks, text, images, issues };
}

/** Fold for name comparisons (NFKC, invisible characters dropped, whitespace collapsed, lower case). */
export const foldName = norm;
