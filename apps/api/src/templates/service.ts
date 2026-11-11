// Templates (parity module 63; R-PAR-23..R-PAR-26, Q-PAR-4) and the email signature.
//
// - Team templates: members read; Owner/Admin create, edit and archive (RLS + core can()). A Team Lead
//   (or anyone) copies a team template to personal to change it.
// - Personal templates: the owner's alone; Owner/Admin do not read other people's (RLS).
// - Every content change bumps the version (DB guard), so a bulk action can freeze one (R-PAR-26).
// - Render-for-one: the template rendered for ONE person under the sender's own RLS (core renderForSend).
//   Sending stays the existing compose path: the composer inserts this text and the human taps Send.
import type { UserActor } from '@realty/core/foundation';
import { can } from '@realty/core/foundation';
import { type MergeField, type TemplateChannel, renderTemplate, validateTemplate } from '@realty/core/parity/templates';
import { withTenantTx, type Database } from '@realty/db';
import type { IdGenerator } from '@realty/core/foundation';
import { audit, redactDiff, redactSnapshot } from '../audit.js';
import { AppError, fromCoreFailure } from '../errors.js';
import { renderHumanBody } from '../comms/render.js';
import { resolvedPolicy } from '../comms/gateInput.js';
import { onePersonContext } from './repos/context.js';
import { senderSignature, setSenderSignature } from './repos/signature.js';
import * as T from './repos/templates.js';

export interface TemplateDeps {
  db: Database;
  ids: IdGenerator;
}

export interface TemplateView {
  id: string;
  scope: 'team' | 'personal';
  mine: boolean;
  channel: TemplateChannel;
  name: string;
  subject: string | null;
  body: string;
  version: number;
  mergeFields: string[];
  archived: boolean;
  /** the caller may edit it (own personal, or a team template for Owner/Admin) */
  editable: boolean;
  updatedAt: string;
}

function view(actor: UserActor, t: T.TemplateRow): TemplateView {
  const mine = t.scope === 'personal' && t.ownerUserId === actor.userId;
  const editable = mine || (t.scope === 'team' && can(actor, 'template.team_manage', {}).ok);
  return { id: t.id, scope: t.scope, mine, channel: t.channel, name: t.name, subject: t.subject, body: t.body, version: t.version, mergeFields: t.mergeFields, archived: t.archivedAt !== null, editable, updatedAt: t.updatedAt.toISOString() };
}

const tx = <R>(deps: TemplateDeps, actor: UserActor, fn: Parameters<typeof withTenantTx<R>>[1]) => withTenantTx(actor, fn, { db: deps.db, retries: 2 });

/** Who may write a template of this scope (team: Owner/Admin; personal: anyone, their own). */
function mayWrite(actor: UserActor, scope: 'team' | 'personal'): boolean {
  return can(actor, scope === 'team' ? 'template.team_manage' : 'template.personal', {}).ok;
}

export async function listTemplates(actor: UserActor, q: { channel?: TemplateChannel | undefined; includeArchived?: boolean | undefined }, deps: TemplateDeps): Promise<TemplateView[]> {
  return tx(deps, actor, async (t) => (await T.listTemplates(t, { channel: q.channel, includeArchived: q.includeArchived === true })).map((r) => view(actor, r)));
}

export async function getTemplate(actor: UserActor, id: string, deps: TemplateDeps): Promise<TemplateView> {
  return tx(deps, actor, async (t) => {
    const r = await T.templateById(t, id);
    if (!r) throw new AppError('NOT_FOUND');
    return view(actor, r);
  });
}

export interface TemplateInput {
  scope: 'team' | 'personal';
  channel: TemplateChannel;
  name: string;
  subject?: string | null | undefined;
  body: string;
}

async function validated(t: Parameters<typeof T.customFieldKeys>[0], d: { channel: TemplateChannel; name: string; subject: string | null; body: string }) {
  const keys = await T.customFieldKeys(t);
  const v = validateTemplate(d, keys.live, keys.archived);
  if (!v.ok) throw fromCoreFailure(v, v.token ? { token: v.token } : undefined);
  return v.template;
}

export async function createTemplate(actor: UserActor, input: TemplateInput, deps: TemplateDeps): Promise<TemplateView> {
  if (!mayWrite(actor, input.scope)) throw new AppError('NOT_FOUND');
  return tx(deps, actor, async (t) => {
    const v = await validated(t, { channel: input.channel, name: input.name, subject: input.subject ?? null, body: input.body });
    const id = deps.ids.next<'TemplateId'>();
    if (!(await T.insertTemplate(t, { id, scope: input.scope, channel: input.channel, name: v.name, subject: v.subject, body: v.body, mergeFields: v.mergeFields }))) throw new AppError('TEMPLATE_NAME_TAKEN');
    await audit(t, actor, { action: 'template.created', entity: { type: 'message_template', id }, changes: redactSnapshot({ scope: input.scope, channel: input.channel, name: v.name, body: v.body }, { entity: 'message_template' }) });
    return view(actor, (await T.templateById(t, id))!);
  });
}

export interface TemplatePatch {
  /** the version the editor opened (optimistic: TEMPLATE_STALE when it moved) */
  version: number;
  name?: string | undefined;
  subject?: string | null | undefined;
  body?: string | undefined;
}

export async function updateTemplate(actor: UserActor, id: string, patch: TemplatePatch, deps: TemplateDeps): Promise<TemplateView> {
  return tx(deps, actor, async (t) => {
    const cur = await T.templateById(t, id, { lock: true });
    if (!cur) throw new AppError('NOT_FOUND');
    const mine = cur.scope === 'personal' && cur.ownerUserId === actor.userId;
    if (!mine && !(cur.scope === 'team' && mayWrite(actor, 'team'))) throw new AppError('NOT_FOUND');
    if (cur.archivedAt) throw new AppError('TEMPLATE_ARCHIVED');
    if (cur.version !== patch.version) throw new AppError('TEMPLATE_STALE', { version: cur.version });
    const next = { channel: cur.channel, name: patch.name ?? cur.name, subject: patch.subject !== undefined ? patch.subject : cur.subject, body: patch.body ?? cur.body };
    const v = await validated(t, next);
    const contentChanged = v.body !== cur.body || v.subject !== cur.subject;
    if (!contentChanged && v.name === cur.name) return view(actor, cur);
    try {
      if (!(await T.updateTemplate(t, id, { name: v.name, subject: v.subject, body: v.body, mergeFields: v.mergeFields, bumpVersion: contentChanged }))) throw new AppError('NOT_FOUND');
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError('TEMPLATE_NAME_TAKEN');
      throw e;
    }
    await audit(t, actor, { action: 'template.updated', entity: { type: 'message_template', id }, changes: redactDiff({ name: cur.name, subject: cur.subject, body: cur.body, version: cur.version }, { name: v.name, subject: v.subject, body: v.body, version: cur.version + (contentChanged ? 1 : 0) }, { entity: 'message_template' }) });
    return view(actor, (await T.templateById(t, id))!);
  });
}

export async function archiveTemplate(actor: UserActor, id: string, deps: TemplateDeps): Promise<TemplateView> {
  return tx(deps, actor, async (t) => {
    const cur = await T.templateById(t, id, { lock: true });
    if (!cur) throw new AppError('NOT_FOUND');
    const mine = cur.scope === 'personal' && cur.ownerUserId === actor.userId;
    if (!mine && !(cur.scope === 'team' && mayWrite(actor, 'team'))) throw new AppError('NOT_FOUND');
    if (cur.archivedAt) return view(actor, cur);
    if (!(await T.archiveTemplate(t, id))) throw new AppError('NOT_FOUND');
    await audit(t, actor, { action: 'template.archived', entity: { type: 'message_template', id } });
    return view(actor, (await T.templateById(t, id))!);
  });
}

/** Q-PAR-4: copy any readable template to the caller's personal templates ("Copy of …" when the name is taken). */
export async function copyTemplate(actor: UserActor, id: string, deps: TemplateDeps): Promise<TemplateView> {
  return tx(deps, actor, async (t) => {
    const src = await T.templateById(t, id);
    if (!src || src.archivedAt) throw new AppError('NOT_FOUND');
    const v = await validated(t, { channel: src.channel, name: src.name, subject: src.subject, body: src.body });
    const newId = deps.ids.next<'TemplateId'>();
    let inserted = false;
    for (const name of [v.name, `Copy of ${v.name}`.slice(0, 80), `Copy of ${v.name}`.slice(0, 74) + ` ${newId.slice(-5)}`]) {
      if (await T.insertTemplate(t, { id: newId, scope: 'personal', channel: src.channel, name, subject: v.subject, body: v.body, mergeFields: v.mergeFields })) {
        inserted = true;
        break;
      }
    }
    if (!inserted) throw new AppError('TEMPLATE_NAME_TAKEN');
    await audit(t, actor, { action: 'template.created', entity: { type: 'message_template', id: newId }, changes: redactSnapshot({ scope: 'personal', channel: src.channel, copiedFromId: src.id }, { entity: 'message_template' }) });
    return view(actor, (await T.templateById(t, newId))!);
  });
}

export interface RenderedForOne {
  templateId: string;
  version: number;
  channel: TemplateChannel;
  subject: string | null;
  /** the text the composer inserts (the person's values in place); the footer is added at send */
  body: string;
  /** the email exactly as it would be sent (signature, brokerage footer, unsubscribe placeholder) */
  preview: string;
  missing: MergeField[];
}

/**
 * POST /contacts/:id/templates/:templateId/render: the template for ONE person, under the caller's RLS.
 * A person whose detail the caller cannot see is 404 (a pond card is not enough). `missing` lists fields
 * with no value and no fallback: the composer shows them and the send would be refused until fixed.
 */
export async function renderForOne(actor: UserActor, contactId: string, templateId: string, deps: TemplateDeps): Promise<RenderedForOne> {
  return tx(deps, actor, async (t) => {
    const tpl = await T.templateById(t, templateId);
    if (!tpl || tpl.archivedAt) throw new AppError('NOT_FOUND');
    const ctx = await onePersonContext(t, contactId);
    if (!ctx) throw new AppError('NOT_FOUND');
    const r = renderTemplate({ channel: tpl.channel, subject: tpl.subject, body: tpl.body }, ctx);
    const { tenant } = await resolvedPolicy(t);
    const preview =
      tpl.channel === 'email'
        ? renderHumanBody(r.body, { channel: 'email', purpose: 'informational', identity: { brokerageLegalName: tenant.brokerageLegalName, postalAddress: tenant.postalAddress }, unsubscribe: null, signature: await senderSignature(t) })
        : r.body;
    return { templateId: tpl.id, version: tpl.version, channel: tpl.channel, subject: tpl.channel === 'email' ? (r.subject ?? '') : null, body: r.body, preview, missing: r.missing };
  });
}

// ---- email signature (self) ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- the DB CHECK, restated so the user gets a clear code
const SIGNATURE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export async function getSignature(actor: UserActor, deps: TemplateDeps): Promise<{ signature: string | null }> {
  return tx(deps, actor, async (t) => ({ signature: await senderSignature(t) }));
}

/** PUT /me/email-signature: plain text, 1-1,000 characters, or null to clear (R-PAR-25). */
export async function putSignature(actor: UserActor, raw: string | null, deps: TemplateDeps): Promise<{ signature: string | null }> {
  const signature = raw === null ? null : raw.replace(/\r\n?/g, '\n').trim() || null;
  if (signature !== null && (signature.length > 1000 || SIGNATURE_CONTROL.test(signature))) throw new AppError('SIGNATURE_INVALID');
  return tx(deps, actor, async (t) => {
    const r = await setSenderSignature(t, signature);
    if (!r) throw new AppError('NOT_FOUND');
    if (r.before !== signature) await audit(t, actor, { action: 'member.signature_changed', entity: { type: 'membership', id: actor.userId }, changes: redactDiff({ emailSignature: r.before }, { emailSignature: signature }, { entity: 'membership' }) });
    return { signature };
  });
}
