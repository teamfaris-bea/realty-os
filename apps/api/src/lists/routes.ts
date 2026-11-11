// api/lists route module (PARITY_PLAN module 60), mounted under /api by routes.ts:
//
//   GET    /tags                          the tag catalog (members read; usage counts for Owner/Admin)  self
//   POST   /tags                          create by typing (existing name → that tag, E165)            tag.create
//   PATCH  /tags/:id                      rename / recolor (audited tag.rename)                         tag.manage
//   POST   /tags/:id/protect              set or lift fair-housing protection (lift: Owner only)        tag.manage
//   POST   /tags/:id/merge                merge into another tag (links, lists, protection; audited)    tag.manage
//   DELETE /tags/:id                      delete (audited with the link count)                          tag.manage
//   GET    /contacts/:id/tags             a person's tags (detail only)                                 contact.view_detail
//   POST   /contacts/:id/tags             add tags by id or typed name                                  contact.edit
//   DELETE /contacts/:id/tags/:tagId      remove one tag                                                contact.edit
//   GET    /custom-fields                 definitions (members read)                                    self
//   POST   /custom-fields                 define (≤ 50 live; protected traits refused; audited)         custom_field.manage
//   PATCH  /custom-fields/:id             label, position, options (append/rename/archive; audited)     custom_field.manage
//   POST   /custom-fields/:id/archive     archive or restore (audited)                                  custom_field.manage
//   GET    /contacts/:id/fields           a person's values (detail only)                               contact.view_detail
//   PUT    /contacts/:id/fields/:fieldId  set or clear one value                                        contact.edit
//   GET    /smart-lists                   team lists + my personal lists                                self
//   POST   /smart-lists                   create (team: Owner/Admin/TL, no free text)                   smart_list.personal (+ team_manage)
//   PATCH  /smart-lists/:id               edit                                                          smart_list.personal (+ team_manage)
//   DELETE /smart-lists/:id               archive                                                       smart_list.personal (+ team_manage)
//   GET    /people?list=&cursor=&sort=    run a saved list (or everyone) under my RLS, 50 per page      smart_list.personal
//   POST   /people/query                  run an unsaved definition (tag chip, filters)                 smart_list.personal
//   GET    /people/count?list=            count, exact to 10,000                                        smart_list.personal
//   POST   /people/count                  count an unsaved definition                                   smart_list.personal
import { can, type ResourceFacts } from '@realty/core/foundation';
import { applyFieldDefPatch, CUSTOM_FIELD_LIMIT, validateNewFieldDef } from '@realty/core/parity/fields';
import { LIST_SORTS, type ListSort } from '@realty/core/parity/lists';
import { normalizeTagName, tagReadsLikeOptOut } from '@realty/core/parity/tags';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, redactDiff } from '../audit.js';
import { AppError, fromCoreFailure } from '../errors.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { actorOf, listsTx, platformOf } from './common.js';
import * as catalog from './repos/catalog.js';
import * as lists from './repos/smartLists.js';
import { definitionTagIds, parseDefinition, planFor, resolveSource, runCount, runPage, viewerForTags } from './run.js';
import * as S from './schemas.js';
import { contactTagView, fieldView, listView, personView, tagView, valueView } from './views.js';
import { ensureTags, setFieldValue } from './writers.js';

const IdParam = z.object({ id: z.uuid() });
const ContactTagParams = z.object({ id: z.uuid(), tagId: z.uuid() });
const ContactFieldParams = z.object({ id: z.uuid(), fieldId: z.uuid() });

function personFactsOf(p: catalog.PersonFactsRow): ResourceFacts {
  return { own: p.rel_own, collaborator: p.rel_collab, team: p.rel_team, pond: p.rel_pond, offer: p.rel_offer, deal: p.rel_deal };
}

/** Facts for a write or detail read on a person: invisible, not live, or card-only is 404 (R-PERM-5, R-PAR-7). */
const personDetail = (req: FastifyRequest) =>
  listsTx(req, async (tx) => {
    const p = await catalog.personFacts(tx, (req.params as { id: string }).id);
    return p && p.detail_visible && p.live ? personFactsOf(p) : null;
  });

function reauthOf(req: FastifyRequest) {
  return { reauthenticatedAt: req.authState!.reauthenticatedAt, now: req.authState!.now };
}

/** The second capability a team-list write needs (smart_list.team_manage: Owner/Admin/TL). */
function requireTeamManage(req: FastifyRequest): void {
  if (!can(actorOf(req), 'smart_list.team_manage', { reauth: reauthOf(req) }).ok) throw new AppError('NOT_FOUND');
}

function cleanListName(raw: string): string {
  const n = raw.replace(/\s+/gu, ' ').trim();
  // eslint-disable-next-line no-control-regex -- refuse control characters
  if (n === '' || [...n].length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(n)) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/name', code: 'invalid' }] });
  return n;
}

export async function registerListsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---- tag catalog -------------------------------------------------------------------------------

  r.get('/tags', { config: { auth: 'self' }, schema: { response: { 200: S.TagsResponse } } }, async (req) =>
    listsTx(req, async (tx, _now, actor) => {
      const rows = await catalog.listTags(tx);
      const usage = can(actor, 'tag.manage', { reauth: reauthOf(req) }).ok ? await catalog.tagUsage(tx) : null;
      return { tags: rows.map((t) => tagView(t, usage ? (usage.get(t.id) ?? 0) : null)) };
    }),
  );

  r.post(
    '/tags',
    { config: { auth: 'tag.create' }, preHandler: authorize('tag.create', () => ({})), schema: { body: S.CreateTagBody, response: { 200: S.TagCreatedResponse, 201: S.TagCreatedResponse } } },
    async (req, reply) => {
      const n = normalizeTagName(req.body.name);
      if (!n.ok) throw new AppError(n.code);
      const res = await listsTx(req, async (tx, _now, actor) => {
        const e = await ensureTags(tx, platformOf(req).ids, [n.name], { kind: 'user', userId: actor.userId });
        if (e.issues[0]) throw new AppError(e.issues[0].code);
        const t = e.tags[0]!;
        let row = await catalog.getTag(tx, t.id);
        if (t.created && req.body.color) row = await catalog.updateTag(tx, t.id, { color: req.body.color }).catch(() => row);
        return { tag: tagView(row!), created: t.created, readsLikeOptOut: tagReadsLikeOptOut(row!.name) };
      });
      reply.status(res.created ? 201 : 200);
      return res;
    },
  );

  r.patch(
    '/tags/:id',
    { config: { auth: 'tag.manage' }, preHandler: authorize('tag.manage', () => ({})), schema: { params: IdParam, body: S.PatchTagBody, response: { 200: S.TagResponse } } },
    async (req) =>
      listsTx(req, async (tx, _now, actor) => {
        const before = await catalog.getTag(tx, req.params.id, { lock: true });
        if (!before) throw new AppError('NOT_FOUND');
        let name: string | undefined;
        if (req.body.name !== undefined) {
          const n = normalizeTagName(req.body.name);
          if (!n.ok) throw new AppError(n.code);
          name = n.name;
        }
        const after = await catalog.updateTag(tx, before.id, { ...(name !== undefined ? { name } : {}), ...(req.body.color !== undefined ? { color: req.body.color } : {}) });
        if (!after) throw new AppError('NOT_FOUND');
        await audit(tx, actor, { action: 'tag.rename', entity: { type: 'tag', id: after.id }, changes: redactDiff({ name: before.name, color: before.color }, { name: after.name, color: after.color }, { entity: 'tag' }) });
        return { tag: tagView(after) };
      }),
  );

  r.post(
    '/tags/:id/protect',
    { config: { auth: 'tag.manage' }, preHandler: authorize('tag.manage', () => ({})), schema: { params: IdParam, body: S.ProtectTagBody, response: { 200: S.TagResponse } } },
    async (req) =>
      listsTx(req, async (tx, _now, actor) => {
        const before = await catalog.getTag(tx, req.params.id, { lock: true });
        if (!before) throw new AppError('NOT_FOUND');
        // R-PAR-8: protection only tightens unless the Owner lifts it (the DB trigger refuses too)
        if (before.protected_proxy && !req.body.protected && actor.role !== 'owner') throw new AppError('TAG_PROTECTION_OWNER_ONLY');
        const after = await catalog.updateTag(tx, before.id, { protectedProxy: req.body.protected });
        if (!after) throw new AppError('NOT_FOUND');
        if (before.protected_proxy !== after.protected_proxy) {
          await audit(tx, actor, { action: 'tag.protect', entity: { type: 'tag', id: after.id }, changes: redactDiff({ is_protected: before.protected_proxy }, { is_protected: after.protected_proxy }, { entity: 'tag' }) });
        }
        return { tag: tagView(after) };
      }),
  );

  r.post(
    '/tags/:id/merge',
    { config: { auth: 'tag.manage' }, preHandler: authorize('tag.manage', () => ({})), schema: { params: IdParam, body: S.MergeTagBody, response: { 200: S.MergeResultResponse } } },
    async (req) =>
      listsTx(req, async (tx, _now, actor) => {
        const sourceId = req.params.id;
        const targetId = req.body.intoTagId.toLowerCase();
        if (sourceId === targetId) throw new AppError('TAG_MERGE_INVALID');
        // lock both in id order (two merges of the same pair cannot deadlock)
        const [first, second] = [sourceId, targetId].sort();
        const a = await catalog.getTag(tx, first!, { lock: true });
        const b = await catalog.getTag(tx, second!, { lock: true });
        const source = a?.id === sourceId ? a : b;
        const target = a?.id === targetId ? a : b;
        if (!source || !target || source.id === target.id) throw new AppError('NOT_FOUND');
        // R-PAR-9: lists first (both tags still exist), then links, then the stricter protection, then the source goes
        const listsRewritten = await catalog.retargetLists(tx, source.id, target.id);
        const moved = await catalog.moveTagLinks(tx, source.id, target.id, actor.userId);
        let merged = target;
        if (source.protected_proxy && !target.protected_proxy) merged = (await catalog.updateTag(tx, target.id, { protectedProxy: true })) ?? target;
        await catalog.deleteTag(tx, source.id);
        await audit(tx, actor, {
          action: 'tag.merge',
          entity: { type: 'tag', id: target.id },
          changes: redactDiff(
            { source_tag_id: source.id, name: source.name, is_protected: target.protected_proxy },
            { source_tag_id: source.id, name: target.name, is_protected: merged.protected_proxy, moved_count: moved.moved, added_count: moved.added, lists_rewritten_count: listsRewritten },
            { entity: 'tag' },
          ),
        });
        return { tag: tagView(merged), moved: moved.moved, alreadyTagged: moved.moved - moved.added, listsRewritten };
      }),
  );

  r.delete(
    '/tags/:id',
    { config: { auth: 'tag.manage' }, preHandler: authorize('tag.manage', () => ({})), schema: { params: IdParam, response: { 200: S.DeleteResultResponse } } },
    async (req) =>
      listsTx(req, async (tx, _now, actor) => {
        const before = await catalog.getTag(tx, req.params.id, { lock: true });
        if (!before) throw new AppError('NOT_FOUND');
        const links = await catalog.tagLinkCount(tx, before.id);
        if (!(await catalog.deleteTag(tx, before.id))) throw new AppError('NOT_FOUND');
        await audit(tx, actor, { action: 'tag.delete', entity: { type: 'tag', id: before.id }, changes: redactDiff({ name: before.name, link_count: links }, null, { entity: 'tag' }) });
        return { deleted: true as const, removedLinks: links };
      }),
  );

  // ---- a person's tags ----------------------------------------------------------------------------

  r.get(
    '/contacts/:id/tags',
    { config: { auth: 'contact.view_detail' }, preHandler: authorize('contact.view_detail', personDetail), schema: { params: IdParam, response: { 200: S.ContactTagsResponse } } },
    async (req) => listsTx(req, async (tx) => ({ tags: (await catalog.contactTags(tx, req.params.id)).map(contactTagView) })),
  );

  r.post(
    '/contacts/:id/tags',
    { config: { auth: 'contact.edit' }, preHandler: authorize('contact.edit', personDetail), schema: { params: IdParam, body: S.AddContactTagsBody, response: { 200: S.AddContactTagsResponse } } },
    async (req) => {
      const names = req.body.names ?? [];
      const ids = (req.body.tagIds ?? []).map((x) => x.toLowerCase());
      if (names.length + ids.length === 0) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/tagIds', code: 'required' }] });
      // creating a tag by typing is its own capability (TCs never reach here: contact.edit refuses them)
      if (names.length > 0 && !can(actorOf(req), 'tag.create', { reauth: reauthOf(req) }).ok) throw new AppError('NOT_FOUND');
      return listsTx(req, async (tx, _now, actor) => {
        const known = await catalog.tagsByIds(tx, ids);
        if (known.length !== new Set(ids).size) throw new AppError('NOT_FOUND');
        const typed = await ensureTags(tx, platformOf(req).ids, names, { kind: 'user', userId: actor.userId });
        if (typed.issues[0]) throw new AppError(typed.issues[0].code);
        const all = [...new Set([...ids, ...typed.tags.map((t) => t.id)])];
        const added = await catalog.addTagLinks(tx, req.params.id, all, { kind: 'user', userId: actor.userId });
        const tags = await catalog.contactTags(tx, req.params.id);
        const optOutLike = tags.filter((t) => added.includes(t.id) && tagReadsLikeOptOut(t.name)).map((t) => t.id);
        return { tags: tags.map(contactTagView), added, optOutLike };
      });
    },
  );

  r.delete(
    '/contacts/:id/tags/:tagId',
    { config: { auth: 'contact.edit' }, preHandler: authorize('contact.edit', personDetail), schema: { params: ContactTagParams, response: { 200: S.RemoveContactTagResponse } } },
    async (req) =>
      listsTx(req, async (tx) => {
        const removed = await catalog.removeTagLinks(tx, req.params.id, [req.params.tagId]);
        return { tags: (await catalog.contactTags(tx, req.params.id)).map(contactTagView), removed: removed.length > 0 };
      }),
  );

  // ---- custom fields ------------------------------------------------------------------------------

  r.get('/custom-fields', { config: { auth: 'self' }, schema: { querystring: z.strictObject({ archived: z.enum(['0', '1']).optional() }), response: { 200: S.FieldDefsResponse } } }, async (req) =>
    listsTx(req, async (tx) => {
      const rows = await catalog.listFieldDefs(tx, { includeArchived: req.query.archived === '1' });
      const live = rows.filter((d) => d.archived_at === null).length;
      return { fields: rows.map(fieldView), liveCount: live, limit: CUSTOM_FIELD_LIMIT };
    }),
  );

  r.post(
    '/custom-fields',
    { config: { auth: 'custom_field.manage' }, preHandler: authorize('custom_field.manage', () => ({})), schema: { body: S.CreateFieldBody, response: { 201: S.FieldDefResponse } } },
    async (req, reply) => {
      const res = await listsTx(req, async (tx, _now, actor) => {
        const v = validateNewFieldDef(req.body, await catalog.fieldKeys(tx));
        if (!v.ok) throw fromCoreFailure(v, v.path ? { path: v.path } : undefined);
        const row = await catalog.insertFieldDef(tx, { id: platformOf(req).ids.next(), ...v.def, position: await catalog.nextFieldPosition(tx), origin: 'manual', byUserId: actor.userId });
        await audit(tx, actor, { action: 'custom_field.created', entity: { type: 'custom_field', id: row.id }, changes: redactDiff(null, { key: row.key, label: row.label, field_type: row.field_type, annual: row.annual }, { entity: 'custom_field' }) });
        return { field: fieldView(row) };
      });
      reply.status(201);
      return res;
    },
  );

  r.patch(
    '/custom-fields/:id',
    { config: { auth: 'custom_field.manage' }, preHandler: authorize('custom_field.manage', () => ({})), schema: { params: IdParam, body: S.PatchFieldBody, response: { 200: S.FieldDefResponse } } },
    async (req) =>
      listsTx(req, async (tx, _now, actor) => {
        const before = await catalog.getFieldDef(tx, req.params.id, { lock: true });
        if (!before) throw new AppError('NOT_FOUND');
        if (before.archived_at !== null) throw new AppError('CUSTOM_FIELD_ARCHIVED');
        const p = applyFieldDefPatch(catalog.fieldDefOf(before), req.body);
        if (!p.ok) throw fromCoreFailure(p, p.path ? { path: p.path } : undefined);
        const after = await catalog.updateFieldDef(tx, before.id, { label: p.label, options: p.options, ...(req.body.position !== undefined ? { position: req.body.position } : {}) });
        if (!after) throw new AppError('NOT_FOUND');
        await audit(tx, actor, {
          action: 'custom_field.changed',
          entity: { type: 'custom_field', id: after.id },
          changes: redactDiff({ label: before.label, options: before.options, position: before.position }, { label: after.label, options: after.options, position: after.position }, { entity: 'custom_field' }),
        });
        return { field: fieldView(after) };
      }),
  );

  r.post(
    '/custom-fields/:id/archive',
    { config: { auth: 'custom_field.manage' }, preHandler: authorize('custom_field.manage', () => ({})), schema: { params: IdParam, body: S.ArchiveFieldBody, response: { 200: S.FieldDefResponse } } },
    async (req) =>
      listsTx(req, async (tx, _now, actor) => {
        const before = await catalog.getFieldDef(tx, req.params.id, { lock: true });
        if (!before) throw new AppError('NOT_FOUND');
        const after = await catalog.updateFieldDef(tx, before.id, { archived: req.body.archived });
        if (!after) throw new AppError('NOT_FOUND');
        if ((before.archived_at === null) !== (after.archived_at === null)) {
          await audit(tx, actor, { action: 'custom_field.archived', entity: { type: 'custom_field', id: after.id }, changes: redactDiff({ archived_at: before.archived_at?.toISOString() ?? null }, { archived_at: after.archived_at?.toISOString() ?? null }, { entity: 'custom_field' }) });
        }
        return { field: fieldView(after) };
      }),
  );

  r.get(
    '/contacts/:id/fields',
    { config: { auth: 'contact.view_detail' }, preHandler: authorize('contact.view_detail', personDetail), schema: { params: IdParam, response: { 200: S.ContactFieldsResponse } } },
    async (req) => listsTx(req, async (tx) => ({ values: (await catalog.contactFieldValues(tx, req.params.id)).map(valueView) })),
  );

  r.put(
    '/contacts/:id/fields/:fieldId',
    { config: { auth: 'contact.edit' }, preHandler: authorize('contact.edit', personDetail), schema: { params: ContactFieldParams, body: S.SetFieldValueBody, response: { 200: S.SetFieldValueResponse } } },
    async (req) =>
      listsTx(req, async (tx, _now, actor) => {
        const def = await catalog.getFieldDef(tx, req.params.fieldId);
        if (!def) throw new AppError('NOT_FOUND');
        const res = await setFieldValue(tx, req.params.id, catalog.fieldDefOf(def), req.body.value, { kind: 'user', userId: actor.userId });
        if (!res.ok) throw fromCoreFailure(res);
        const row = (await catalog.contactFieldValues(tx, req.params.id)).find((v) => v.field_id === def.id) ?? null;
        return { value: row ? valueView(row) : null, changed: res.changed };
      }),
  );

  // ---- smart lists --------------------------------------------------------------------------------

  r.get('/smart-lists', { config: { auth: 'self' }, schema: { response: { 200: S.SmartListsResponse } } }, async (req) =>
    listsTx(req, async (tx, _now, actor) => {
      const rows = await lists.listSmartLists(tx);
      const viewer = await viewerForTags(tx, [...new Set(rows.flatMap((l) => definitionTagIds(l.definition)))]);
      return { lists: rows.map((l) => listView(l, actor.userId, viewer)) };
    }),
  );

  r.post(
    '/smart-lists',
    { config: { auth: 'smart_list.personal' }, preHandler: authorize('smart_list.personal', () => ({})), schema: { body: S.CreateSmartListBody, response: { 201: S.SmartListResponse } } },
    async (req, reply) => {
      if (req.body.scope === 'team') requireTeamManage(req);
      const name = cleanListName(req.body.name);
      const res = await listsTx(req, async (tx, _now, actor) => {
        const def = parseDefinition(req.body.definition, req.body.scope);
        await planFor(tx, def, { strict: true }); // unknown fields, tags and options are refused at save
        const row = await lists.insertSmartList(tx, {
          id: platformOf(req).ids.next(),
          scope: req.body.scope,
          ownerUserId: req.body.scope === 'personal' ? actor.userId : null,
          name,
          definition: def,
          sort: req.body.sort ?? 'last_activity_desc',
          position: req.body.position ?? 0,
          byUserId: actor.userId,
        });
        if (row.scope === 'team') await audit(tx, actor, { action: 'smart_list.team_changed', entity: { type: 'smart_list', id: row.id }, changes: redactDiff(null, { name: row.name, definition: row.definition, sort: row.sort }, { entity: 'smart_list' }) });
        return { list: listView(row, actor.userId, await viewerForTags(tx, definitionTagIds(row.definition))) };
      });
      reply.status(201);
      return res;
    },
  );

  r.patch(
    '/smart-lists/:id',
    { config: { auth: 'smart_list.personal' }, preHandler: authorize('smart_list.personal', () => ({})), schema: { params: IdParam, body: S.PatchSmartListBody, response: { 200: S.SmartListResponse } } },
    async (req) =>
      listsTx(req, async (tx, _now, actor) => {
        const before = await lists.getSmartList(tx, req.params.id);
        if (!before || before.archived_at !== null) throw new AppError('NOT_FOUND');
        if (before.scope === 'team') requireTeamManage(req);
        else if (before.owner_user_id !== actor.userId) throw new AppError('NOT_FOUND');
        let definition: unknown;
        if (req.body.definition !== undefined) {
          const def = parseDefinition(req.body.definition, before.scope);
          await planFor(tx, def, { strict: true });
          definition = def;
        }
        const after = await lists.updateSmartList(tx, before.id, {
          ...(req.body.name !== undefined ? { name: cleanListName(req.body.name) } : {}),
          ...(definition !== undefined ? { definition } : {}),
          ...(req.body.sort !== undefined ? { sort: req.body.sort } : {}),
          ...(req.body.position !== undefined ? { position: req.body.position } : {}),
          byUserId: actor.userId,
        });
        if (!after) throw new AppError('NOT_FOUND');
        if (after.scope === 'team') {
          await audit(tx, actor, { action: 'smart_list.team_changed', entity: { type: 'smart_list', id: after.id }, changes: redactDiff({ name: before.name, definition: before.definition, sort: before.sort }, { name: after.name, definition: after.definition, sort: after.sort }, { entity: 'smart_list' }) });
        }
        return { list: listView(after, actor.userId, await viewerForTags(tx, definitionTagIds(after.definition))) };
      }),
  );

  r.delete(
    '/smart-lists/:id',
    { config: { auth: 'smart_list.personal' }, preHandler: authorize('smart_list.personal', () => ({})), schema: { params: IdParam, response: { 200: S.SmartListResponse } } },
    async (req) =>
      listsTx(req, async (tx, _now, actor) => {
        const before = await lists.getSmartList(tx, req.params.id);
        if (!before || before.archived_at !== null) throw new AppError('NOT_FOUND');
        if (before.scope === 'team') requireTeamManage(req);
        else if (before.owner_user_id !== actor.userId) throw new AppError('NOT_FOUND');
        const after = await lists.updateSmartList(tx, before.id, { archived: true, byUserId: actor.userId });
        if (!after) throw new AppError('NOT_FOUND');
        if (after.scope === 'team') await audit(tx, actor, { action: 'smart_list.team_changed', entity: { type: 'smart_list', id: after.id }, changes: redactDiff({ archived_at: null }, { archived_at: after.archived_at?.toISOString() ?? null }, { entity: 'smart_list' }) });
        return { list: listView(after, actor.userId, null) };
      }),
  );

  // ---- people: list runs ----------------------------------------------------------------------------

  const page = async (req: FastifyRequest, src: Parameters<typeof resolveSource>[1], sort: ListSort | undefined, cursor: string | undefined) =>
    listsTx(req, async (tx) => {
      const resolved = await resolveSource(tx, src, sort);
      const res = await runPage(tx, resolved.definition, resolved.sort, cursor ?? null);
      return {
        people: res.rows.map(personView),
        nextCursor: res.nextCursor,
        sort: resolved.sort,
        list: resolved.list ? { id: resolved.list.id, name: resolved.list.name, scope: resolved.list.scope } : null,
        scope: 'people_you_can_see' as const,
        audienceProtected: res.audienceProtected,
      };
    });

  r.get(
    '/people',
    { config: { auth: 'smart_list.personal' }, preHandler: authorize('smart_list.personal', () => ({})), schema: { querystring: S.PeopleQuery, response: { 200: S.PeoplePageResponse } } },
    async (req) => page(req, req.query.list ? { listId: req.query.list } : { all: true }, req.query.sort, req.query.cursor),
  );

  r.post(
    '/people/query',
    { config: { auth: 'smart_list.personal' }, preHandler: authorize('smart_list.personal', () => ({})), schema: { body: S.PeopleQueryBody, response: { 200: S.PeoplePageResponse } } },
    async (req) => page(req, { definition: req.body.definition }, req.body.sort, req.body.cursor),
  );

  r.get(
    '/people/count',
    { config: { auth: 'smart_list.personal' }, preHandler: authorize('smart_list.personal', () => ({})), schema: { querystring: S.PeopleCountQuery, response: { 200: S.PeopleCountResponse } } },
    async (req) => listsTx(req, async (tx) => runCount(tx, (await resolveSource(tx, req.query.list ? { listId: req.query.list } : { all: true })).definition)),
  );

  r.post(
    '/people/count',
    { config: { auth: 'smart_list.personal' }, preHandler: authorize('smart_list.personal', () => ({})), schema: { body: S.PeopleCountBody, response: { 200: S.PeopleCountResponse } } },
    async (req) => listsTx(req, async (tx) => runCount(tx, (await resolveSource(tx, { definition: req.body.definition })).definition)),
  );
}

export const listsRoutes: RouteModule = {
  name: 'lists',
  async register(app: FastifyInstance) {
    await registerListsRoutes(app);
  },
};

export { LIST_SORTS };
