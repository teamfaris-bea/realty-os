// Milestone templates admin API (PHASE2_3_PLAN §5.4 #31 and the 41 bullet; R-TXN-6, R-AUDIT-5, R-OWN-27).
//
//   GET /settings/milestone-templates   tenant_settings.milestone_templates as stored, the parsed templates and every
//                                       invalid entry by index (core parseMilestoneTemplates), the jurisdictions
//   PUT /settings/milestone-templates   replaces the list; every entry must pass MilestoneTemplateSchema and (id,
//                                       version) must be unique, else MILESTONE_TEMPLATES_INVALID with the indexes
// Templates are tenant data per side and jurisdiction; nothing here ships template data, so no state's defaults are
// hard-coded (R-TXN-6). Counsel review is recorded only as an Owner/Admin's statement (`reviewed`, default false):
// VERIFY WITH COUNSEL what counts as reviewed. Every change is audited as settings.changed with a diff. Edits move no
// stored proposal and no stored instant (R-OWN-27): a plan reads the template when a person asks for it.
// Authorization: milestone_template.manage (Owner/Admin; §8 names no role: flagged for the owner).
import { createHash } from 'node:crypto';
import type { Actor } from '@realty/core/foundation';
import { parseMilestoneTemplates } from '@realty/core/transactions';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import * as R from './repos.js';

export async function getTemplates(tx: Tx) {
  const s = await R.txnSettings(tx);
  const raw = Array.isArray(s.templates) ? (s.templates as unknown[]) : [];
  const { templates, invalid } = parseMilestoneTemplates(s.templates);
  return {
    templates: raw,
    parsed: templates.map((t) => ({ id: t.id, version: t.version, name: t.name, side: t.side, jurisdiction: t.jurisdiction, reviewed: t.reviewed === true, rules: t.rules.length })),
    invalid,
    jurisdictions: s.jurisdictions,
  };
}

/** Entry problems: the schema's, plus a repeated (id, version). */
export function validateTemplates(raw: unknown[]): { index: number; error: string }[] {
  const out = [...parseMilestoneTemplates(raw).invalid];
  const seen = new Map<string, number>();
  raw.forEach((t, index) => {
    if (typeof t !== 'object' || t === null) return;
    const o = t as { id?: unknown; version?: unknown };
    const k = `${String(o.id)}@${String(o.version)}`;
    if (seen.has(k)) out.push({ index, error: `id and version repeat entry ${seen.get(k)!}` });
    else seen.set(k, index);
  });
  return out.sort((a, b) => a.index - b.index);
}

const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const keyOf = (t: { id: string; version: number }) => `${t.id}@${t.version}`;

export async function putTemplates(tx: Tx, actor: Actor, raw: unknown[]) {
  const invalid = validateTemplates(raw);
  if (invalid.length > 0) throw new AppError('MILESTONE_TEMPLATES_INVALID', { invalid: invalid.map((i) => ({ index: i.index, error: i.error.slice(0, 300) })) });
  const before = await sql<{ t: unknown }>`SELECT milestone_templates AS t FROM tenant_settings WHERE tenant_id = app.tenant_id() FOR UPDATE`.execute(tx);
  const prevRaw = before.rows[0]?.t ?? [];
  // stored as parsed (absent `reviewed` is stored as false: review is recorded, never assumed)
  const next = parseMilestoneTemplates(raw).templates;
  if (sha(prevRaw) === sha(next)) return getTemplates(tx);
  const prev = parseMilestoneTemplates(prevRaw).templates;
  await sql`UPDATE tenant_settings SET milestone_templates = ${JSON.stringify(next)}::jsonb WHERE tenant_id = app.tenant_id()`.execute(tx);
  await audit(tx, actor, {
    action: 'settings.changed',
    entity: { type: 'tenant_settings', id: actor.tenantId },
    changes: redactDiff(
      { milestone_template_count: prev.length, milestone_template_ids: prev.map(keyOf), reviewed_milestone_template_ids: prev.filter((t) => t.reviewed).map(keyOf), milestone_templates_sha256: sha(prevRaw) },
      { milestone_template_count: next.length, milestone_template_ids: next.map(keyOf), reviewed_milestone_template_ids: next.filter((t) => t.reviewed).map(keyOf), milestone_templates_sha256: sha(next) },
      { entity: 'tenant_settings' },
    ),
    reason: 'MILESTONE_TEMPLATES',
  });
  return getTemplates(tx);
}
