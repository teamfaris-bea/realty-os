// Contact edits (PARITY_PLAN module 57; R-PAR-13, R-PAR-14, R-PAR-15, R-PAR-43, R-PAR-32 do-not-contact).
//
//   GET   /contacts/:id/details          stage (+ locked stages), labels, addresses, collaborators,
//                                        relationships, removed points, row version     contact.view_detail
//   PATCH /contacts/:id                  names, type, intent, timezone, stage, pond summary (row_version)  contact.edit
//   POST  /contacts/:id/stage            one stage change (the Undo toast posts the previous stage)  contact.edit
//   GET   /stage-labels                  the eight stages with the tenant's labels        session (members)
//   PUT   /stage-labels                  Owner/Admin                                      settings.stage_labels
//   POST  /contacts/:id/do-not-contact   person-level do-not-contact (R-CHAN-3 path): revokes every channel on
//                                        every point and sets the person-level flag; tighten-only  contact.edit
//                                        (also on a merged-away record the caller sees: it follows the merge, E140)
//
// Ownership, attribution, merge/delete state, do_not_contact_* and imported_fields are never patched
// (core validateContactPatch refuses them; the contacts_guard and opt-out guard back it up). A stage
// change is checked by core first so the caller learns STAGE_NEEDS_CONTACT up front, and the DB guard
// app.contacts_stage_guard refuses it anyway; the definer trigger writes the stage history (R-PAR-15).
import { type UserActor, can } from '@realty/core/foundation';
import { STAGES, type Stage, type StageFacts, isStage, lockedStages, stageChangeAllowed, stageLabel, validateContactPatch, validateStageLabels } from '@realty/core/parity/people';
import { instantFromDate } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { audit, redactDiff, redactSnapshot } from '../audit.js';
import { AppError } from '../errors.js';
import { factsOf } from '../leads/contacts.js';
import * as leads from '../leads/repos/contacts.js';
import { authorize } from '../rbac.js';
import { actorOf, detailFacts, liveDetailFacts, idOf, peopleTx, platformOf } from './common.js';
import * as repo from './repos/people.js';
import { addressView, collaboratorView, relationshipView, removedPointView } from './views.js';
import * as S from './schemas.js';
import { stageChangeAutomation } from '../stageAutomation/index.js';
import { ownLatestStageEvent } from '../stageAutomation/repos.js';
import { recordPersonDoNotContactInTx } from '../channels/personOptOut.js';

export function stageFactsOf(r: repo.EditRow): StageFacts {
  return {
    stage: (isStage(r.stage) ? r.stage : 'new') as Stage,
    ownershipState: r.ownership_state,
    firstTouchDueAt: r.first_touch_due_at ? instantFromDate(r.first_touch_due_at) : null,
    firstTouchAt: r.first_touch_at ? instantFromDate(r.first_touch_at) : null,
  };
}

export function stageInfo(r: repo.EditRow, actor: UserActor, labels: Record<string, string>) {
  const f = stageFactsOf(r);
  const locked = lockedStages(f, { kind: 'user', role: actor.role });
  return { stage: f.stage, label: stageLabel(f.stage, labels), locked, lockedReason: locked.length > 0 ? 'STAGE_NEEDS_CONTACT' : null };
}

function editView(r: repo.EditRow) {
  return { id: r.id, rowVersion: r.row_version, displayName: r.display_name, firstName: r.first_name, lastName: r.last_name, contactType: r.contact_type, intent: r.intent, timezone: r.timezone, stage: r.stage, pondSummary: r.pond_summary };
}

function changeStageCheck(r: repo.EditRow, actor: UserActor, to: Stage): void {
  const d = stageChangeAllowed(stageFactsOf(r), { kind: 'user', role: actor.role }, to);
  if (!d.ok) throw new AppError('STAGE_NEEDS_CONTACT', { locked: lockedStages(stageFactsOf(r), { kind: 'user', role: actor.role }), offer: ['call', 'text', 'close'] });
}

async function staleOrMissing(tx: Tx, id: string): Promise<never> {
  const now = await repo.editRow(tx, id);
  if (!now) throw new AppError('NOT_FOUND');
  throw new AppError('STALE_CONTACT', { rowVersion: now.row_version });
}

const readAuth = (req: FastifyRequest) => detailFacts(req);
const editAuth = (req: FastifyRequest) => liveDetailFacts(req);
// The one api/people write a merged-away record takes: the person-level do-not-contact, from whoever still sees the
// record's detail and holds contact.edit on it (the Owner, an Admin, a collaborator of the loser: a merge moves no
// collaborator; a TC on the loser's deal sees it but has no contact.edit). Recording an opt-out only tightens, and
// nothing is stranded on the loser: the definer trigger app.contacts_dnc_follow_merge (migration 0018) copies the
// loser's do-not-contact and its ledger event onto the survivor's own row, along merge chains (R-CHAN-2 E140), even
// when the caller cannot see the survivor, and the revokes are keyed by the HMACs of the addresses the merge copied
// onto the survivor. Whoever cannot see the record gets 404 as before (R-PERM-5).
const optOutAuth = (req: FastifyRequest) => detailFacts(req);

export async function registerContactEditRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/contacts/:id/details',
    { config: { auth: 'contact.view_detail' }, preHandler: authorize('contact.view_detail', readAuth), schema: { params: S.IdParams, response: { 200: S.DetailsResponse } } },
    async (req) =>
      peopleTx(req, async (tx, _now, actor) => {
        const id = req.params.id;
        const row = await repo.editRow(tx, id);
        const contact = await leads.getContact(tx, id);
        if (!row || !contact || !contact.detail_visible) throw new AppError('NOT_FOUND');
        const labels = await repo.stageLabels(tx);
        const facts = factsOf(contact);
        return {
          details: {
            contactId: id,
            rowVersion: row.row_version,
            doNotContact: row.do_not_contact_at !== null,
            stage: stageInfo(row, actor, labels),
            stageLabels: labels,
            addresses: (await repo.addresses(tx, id)).map(addressView),
            collaborators: (await repo.collaborators(tx, id)).map(collaboratorView),
            relationships: (await repo.relationships(tx, id)).map((x) => relationshipView(x, id)),
            // phones and emails only: a removed website-chat identity is no removed point of the person (tenancy-public/F3)
            removedPoints: (await repo.allPoints(tx, id)).filter((p) => p.removed_at !== null && repo.personPoint(p)).map(removedPointView),
            canEdit: can(actor, 'contact.edit', facts).ok,
            canManageCollaborators: can(actor, 'collaborator.manage', facts).ok,
          },
        };
      }),
  );

  r.patch(
    '/contacts/:id',
    { config: { auth: 'contact.edit' }, preHandler: authorize('contact.edit', editAuth), schema: { params: S.IdParams, body: S.PatchBody, response: { 200: S.ContactEditResponse } } },
    async (req) => {
      const v = validateContactPatch(req.body);
      if (!v.ok) throw new AppError(v.code, { issues: v.issues });
      const p = v.patch;
      return peopleTx(req, async (tx, _now, actor) => {
        const id = req.params.id;
        const before = await repo.editRow(tx, id);
        if (!before) throw new AppError('NOT_FOUND');
        if (before.row_version !== p.rowVersion) throw new AppError('STALE_CONTACT', { rowVersion: before.row_version });
        if (p.pondSummary !== undefined && !(before.owner_user_id === actor.userId || ['owner', 'admin', 'team_lead'].includes(actor.role))) {
          throw new AppError('FIELD_NOT_EDITABLE', { issues: [{ path: '/pondSummary', code: 'owner_or_team_lead' }] });
        }
        if (p.stage !== undefined) changeStageCheck(before, actor, p.stage);
        const cols: repo.ContactColumns = {};
        if (p.firstName !== undefined) cols.first_name = p.firstName;
        if (p.lastName !== undefined) cols.last_name = p.lastName;
        if (p.displayName !== undefined) cols.display_name = p.displayName;
        else if (p.firstName !== undefined || p.lastName !== undefined) {
          // the display name follows the names when it was just "first last" (it was never hand-written)
          const join = (a: string | null, b: string | null) => [a, b].filter(Boolean).join(' ');
          if (before.display_name === join(before.first_name, before.last_name)) {
            const next = join(p.firstName !== undefined ? p.firstName : before.first_name, p.lastName !== undefined ? p.lastName : before.last_name);
            if (next) cols.display_name = next;
          }
        }
        if (p.contactType !== undefined) cols.contact_type = p.contactType;
        if (p.intent !== undefined) cols.intent = p.intent;
        if (p.timezone !== undefined) {
          cols.timezone = p.timezone;
          cols.timezone_source = p.timezone === null ? null : 'explicit';
        }
        if (p.stage !== undefined) cols.stage = p.stage;
        if (p.pondSummary !== undefined) cols.pond_summary = p.pondSummary;
        const next = await repo.updateContact(tx, id, p.rowVersion, cols);
        if (next === null) return staleOrMissing(tx, id);
        const after = (await repo.editRow(tx, id))!;
        const changed = v.fields.filter((f) => JSON.stringify(editView(before)[f]) !== JSON.stringify(editView(after)[f]));
        // R-PAR-43: audited as contact.update; PII fields are named, never their values (fail-closed classes)
        await audit(tx, actor, { action: 'contact.update', entity: { type: 'contact', id }, changes: redactDiff(pick(editView(before), changed), pick(editView(after), changed), { entity: 'contacts' }) });
        return { contact: editView(after), changed };
      });
    },
  );

  r.post(
    '/contacts/:id/stage',
    { config: { auth: 'contact.edit' }, preHandler: authorize('contact.edit', editAuth), schema: { params: S.IdParams, body: S.StageBody, response: { 200: S.StageResponse } } },
    async (req) => {
      const out = await peopleTx(req, async (tx, _now, actor) => {
        const id = req.params.id;
        const before = await repo.editRow(tx, id);
        if (!before) throw new AppError('NOT_FOUND');
        const rv = req.body.rowVersion ?? before.row_version;
        if (rv !== before.row_version) throw new AppError('STALE_CONTACT', { rowVersion: before.row_version });
        changeStageCheck(before, actor, req.body.stage);
        const labels = await repo.stageLabels(tx);
        let eventId: string | null = null;
        if (req.body.stage !== before.stage) {
          const next = await repo.updateContact(tx, id, rv, { stage: req.body.stage });
          if (next === null) return staleOrMissing(tx, id);
          await audit(tx, actor, { action: 'contact.update', entity: { type: 'contact', id }, changes: redactDiff({ stage: before.stage }, { stage: req.body.stage }, { entity: 'contacts' }) });
          eventId = await ownLatestStageEvent(tx, id, before.stage, req.body.stage); // parity 67
        }
        const after = (await repo.editRow(tx, id))!;
        return { stage: stageInfo(after, actor, labels), previousStage: before.stage, rowVersion: after.row_version, eventId };
      });
      // parity module 67 (flagged edit): the stage entry's plan, decided after the change committed
      const { eventId, ...res } = out;
      const automation = eventId ? await stageChangeAutomation(platformOf(req).db, actorOf(req).tenantId, eventId, req.log, actorOf(req)) : null;
      return { ...res, automation };
    },
  );

  r.get('/stage-labels', { config: { auth: 'self' }, schema: { response: { 200: S.StageLabelsResponse } } }, async (req) =>
    peopleTx(req, async (tx) => {
      const labels = await repo.stageLabels(tx);
      return { labels, stages: STAGES.map((key) => ({ key, label: stageLabel(key, labels) })) };
    }),
  );

  r.put(
    '/stage-labels',
    { config: { auth: 'settings.stage_labels' }, preHandler: authorize('settings.stage_labels', async () => ({})), schema: { body: S.StageLabelsBody, response: { 200: S.StageLabelsResponse } } },
    async (req) => {
      const v = validateStageLabels(req.body.labels);
      if (!v.ok) throw new AppError('STAGE_LABEL_INVALID');
      return peopleTx(req, async (tx, _now, actor) => {
        const before = await repo.stageLabels(tx);
        if (!(await repo.setStageLabels(tx, v.labels as Record<string, string>))) throw new AppError('NOT_FOUND');
        await audit(tx, actor, { action: 'settings.changed', entity: { type: 'tenant_settings', id: null }, changes: redactDiff({ stage_labels: before }, { stage_labels: v.labels }, { entity: 'tenant_settings' }), reason: 'STAGE_LABELS' });
        const labels = v.labels as Record<string, string>;
        return { labels, stages: STAGES.map((key) => ({ key, label: stageLabel(key, labels) })) };
      });
    },
  );

  r.post(
    '/contacts/:id/do-not-contact',
    { config: { auth: 'contact.edit' }, preHandler: authorize('contact.edit', optOutAuth), schema: { params: S.IdParams, body: S.DoNotContactBody, response: { 200: S.DoNotContactResponse } } },
    async (req) => recordDoNotContact(req, req.params.id, req.body.reason),
  );
}

function pick<T extends object>(o: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (o as Record<string, unknown>)[k];
  return out;
}

/**
 * R-PAR-32 / R-CHAN-3: an agent records that the person asked not to be contacted. Every live point gets
 * a staff revoke on each of its channels (the ledger is the evidence), queued texts are canceled, and
 * the person-level do-not-contact is set, citing the first revoke. It only ever refuses more: nothing
 * here can clear an opt-out (the DB guard allows clearing only through a reviewed definer).
 */
async function recordDoNotContact(req: FastifyRequest, contactId: string, reason: string) {
  const p = platformOf(req);
  return peopleTx(req, async (tx, now, actor) => {
    const row = await repo.editRow(tx, contactId);
    if (!row) throw new AppError('NOT_FOUND');
    // module 22: the one person-level do-not-contact path (also used by closing a lead as do-not-contact, F19)
    const out = await recordPersonDoNotContactInTx(tx, p.ids, actor, contactId, reason, now);
    if (out.firstEventId === null) throw new AppError('NO_ADDRESS_TO_REVOKE');
    await audit(tx, actor, { action: 'consent.recorded', entity: { type: 'contact', id: contactId }, changes: redactSnapshot({ kind: 'revoke', source: 'agent_revoke', scope: 'person' }, { entity: 'consent_event' }), reason: 'PERSON_DO_NOT_CONTACT' });
    return { doNotContact: true as const, alreadySet: !out.set, revokedPoints: out.revokedPoints };
  });
}

export { actorOf, idOf };
