// Pure helpers for routing rules (R-OWN-10 rule shape): the editor form ↔ the API body, and the one-
// line plain description of a rule. Unit-tested.
import { centsToDollars, dollarsToCents, formatDuration, parseZips } from './format.js';
import type { RoutingMatch, RoutingRule, Strategy } from './types.js';

export const LEAD_TYPES = [
  { value: 'buy', label: 'Buyers' },
  { value: 'sell', label: 'Sellers' },
  { value: 'rent', label: 'Renters' },
  { value: 'value', label: 'Home value requests' },
  { value: 'general', label: 'General questions' },
] as const;

export const STRATEGIES: readonly { value: Strategy; label: string; hint: string }[] = [
  { value: 'round_robin', label: 'Round robin', hint: 'Offer to the next person in turn.' },
  { value: 'weighted', label: 'Weighted', hint: 'Offer more often to people with a higher weight.' },
  { value: 'direct', label: 'One person', hint: 'Offer every matching lead to one person.' },
  { value: 'pond', label: 'Straight to a pond', hint: 'Put matching leads in a pond for anyone eligible to claim.' },
];

export interface RuleForm {
  name: string;
  strategy: Strategy;
  directUserId: string;
  targetPondId: string;
  fallbackPondId: string;
  members: Map<string, number>;
  leadTypes: Set<string>;
  sources: Set<string>;
  zips: string;
  priceMin: string;
  priceMax: string;
  /** minutes; '' keeps the team's lead timer */
  offerWindowMinutes: string;
  maxOffers: string;
  enabled: boolean;
}

export function emptyRuleForm(): RuleForm {
  return { name: '', strategy: 'round_robin', directUserId: '', targetPondId: '', fallbackPondId: '', members: new Map(), leadTypes: new Set(), sources: new Set(), zips: '', priceMin: '', priceMax: '', offerWindowMinutes: '', maxOffers: '', enabled: true };
}

export function formOf(r: RoutingRule): RuleForm {
  const m = r.match;
  return {
    name: r.name,
    strategy: r.strategy,
    directUserId: r.directUserId ?? '',
    targetPondId: r.targetPondId ?? '',
    fallbackPondId: r.fallbackPondId ?? '',
    members: new Map(r.members.map((x) => [x.userId, x.weight])),
    leadTypes: new Set(m.lead_types ?? []),
    sources: new Set(m.sources ?? []),
    zips: (m.zips ?? []).join(', '),
    priceMin: centsToDollars(m.price_min),
    priceMax: centsToDollars(m.price_max),
    offerWindowMinutes: r.offerWindowSeconds === null ? '' : String(Math.round(r.offerWindowSeconds / 60)),
    maxOffers: r.maxOffers === null ? '' : String(r.maxOffers),
    enabled: r.enabled,
  };
}

/** routing_rules.match as the API stores it (snake_case; empty filters are left out = match all). */
export function matchOf(f: RuleForm): RoutingMatch {
  const out: RoutingMatch = {};
  if (f.leadTypes.size > 0) out.lead_types = [...f.leadTypes];
  if (f.sources.size > 0) out.sources = [...f.sources];
  const zips = parseZips(f.zips);
  if (zips.length > 0) out.zips = zips;
  const min = dollarsToCents(f.priceMin);
  const max = dollarsToCents(f.priceMax);
  if (min !== null) out.price_min = min;
  if (max !== null) out.price_max = max;
  return out;
}

/** What is wrong with the form before it is sent (the server re-checks everything). */
export function formProblems(f: RuleForm): string[] {
  const p: string[] = [];
  if (!f.name.trim()) p.push('Give the rule a name.');
  if (f.strategy === 'direct' && !f.directUserId) p.push('Pick the person who gets these leads.');
  if (f.strategy === 'pond' && !f.targetPondId) p.push('Pick the pond these leads go to.');
  if ((f.strategy === 'round_robin' || f.strategy === 'weighted') && f.members.size === 0) p.push('Pick at least one person to offer leads to.');
  const zips = parseZips(f.zips);
  if (zips.some((z) => !/^\d{5}(-\d{4})?$/.test(z))) p.push('ZIP codes must be 5 digits (or ZIP+4).');
  const min = dollarsToCents(f.priceMin);
  const max = dollarsToCents(f.priceMax);
  if ((f.priceMin.trim() && min === null) || (f.priceMax.trim() && max === null)) p.push('Prices must be whole dollar amounts.');
  if (min !== null && max !== null && min > max) p.push('The lowest price must not be above the highest.');
  const win = f.offerWindowMinutes.trim();
  if (win && (!/^\d+$/.test(win) || Number(win) < 1 || Number(win) > 1440)) p.push('The offer window must be 1 to 1440 minutes.');
  const mo = f.maxOffers.trim();
  if (mo && (!/^\d+$/.test(mo) || Number(mo) < 1 || Number(mo) > 10)) p.push('Offers before falling back must be 1 to 10.');
  return p;
}

/** The fields POST /routing-rules and PATCH /routing-rules/:id take (members go separately on edit). */
export function ruleBody(f: RuleForm) {
  const win = f.offerWindowMinutes.trim();
  const mo = f.maxOffers.trim();
  return {
    name: f.name.trim(),
    match: matchOf(f),
    strategy: f.strategy,
    directUserId: f.strategy === 'direct' ? f.directUserId : null,
    targetPondId: f.strategy === 'pond' ? f.targetPondId : null,
    fallbackPondId: f.fallbackPondId || null,
    offerWindowSeconds: win ? Number(win) * 60 : null,
    maxOffers: mo ? Number(mo) : null,
    enabled: f.enabled,
  };
}

export function membersBody(f: RuleForm): { userId: string; weight: number }[] {
  if (f.strategy !== 'round_robin' && f.strategy !== 'weighted') return [];
  return [...f.members].map(([userId, weight]) => ({ userId, weight: f.strategy === 'weighted' ? Math.min(100, Math.max(1, Math.round(weight))) : 1 }));
}

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Math.round(cents / 100));
}

/** "Buyers from Zillow in 94110, 94112 between $500,000 and $900,000", or "Every lead". */
export function describeMatch(m: RoutingMatch, sourceName: (id: string) => string): string {
  const parts: string[] = [];
  const types = (m.lead_types ?? []).map((t) => LEAD_TYPES.find((x) => x.value === t)?.label ?? t);
  parts.push(types.length > 0 ? types.join(', ') : 'Every lead');
  if (m.sources && m.sources.length > 0) parts.push(`from ${m.sources.map(sourceName).join(', ')}`);
  if (m.zips && m.zips.length > 0) parts.push(m.zips.length <= 4 ? `in ${m.zips.join(', ')}` : `in ${m.zips.length} ZIP codes`);
  if (m.price_min !== undefined && m.price_max !== undefined) parts.push(`between ${money(m.price_min)} and ${money(m.price_max)}`);
  else if (m.price_min !== undefined) parts.push(`at ${money(m.price_min)} or more`);
  else if (m.price_max !== undefined) parts.push(`up to ${money(m.price_max)}`);
  return parts.join(' ');
}

/** "Round robin among Ava, Ben · offers last 5 min" etc. */
export function describeStrategy(r: Pick<RoutingRule, 'strategy' | 'members' | 'directUserId' | 'targetPondId' | 'fallbackPondId' | 'offerWindowSeconds' | 'maxOffers'>, personName: (id: string) => string, pondName: (id: string) => string): string {
  const who = r.members.map((m) => personName(m.userId));
  let s: string;
  switch (r.strategy) {
    case 'round_robin':
      s = who.length > 0 ? `Round robin among ${who.join(', ')}` : 'Round robin (no one picked yet)';
      break;
    case 'weighted':
      s = who.length > 0 ? `Weighted among ${r.members.map((m) => `${personName(m.userId)} (${m.weight})`).join(', ')}` : 'Weighted (no one picked yet)';
      break;
    case 'direct':
      s = `Always offered to ${r.directUserId ? personName(r.directUserId) : 'no one yet'}`;
      break;
    case 'pond':
      s = `Goes to ${r.targetPondId ? pondName(r.targetPondId) : 'a pond'}`;
      break;
  }
  const extras: string[] = [];
  if (r.offerWindowSeconds !== null) extras.push(`offers last ${formatDuration(r.offerWindowSeconds)}`);
  if (r.maxOffers !== null) extras.push(`up to ${r.maxOffers} offers`);
  if (r.fallbackPondId) extras.push(`then ${pondName(r.fallbackPondId)}`);
  return extras.length > 0 ? `${s} · ${extras.join(' · ')}` : s;
}

/** The new full order after moving one rule up (-1) or down (+1); unchanged at the ends. */
export function moved(ids: readonly string[], id: string, dir: -1 | 1): string[] {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return [...ids];
  const out = [...ids];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}
