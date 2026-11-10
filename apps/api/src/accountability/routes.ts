// api/accountability route module (BUILD_PLAN module 15), mounted under /api by routes.ts.
//
//   GET  /team/exceptions?type=&owner=&state=&limit=        exception.view     (TL: team; agent/ISA: own; Owner/Admin: all)
//   GET  /team/exceptions/:dedupeKey                         exception.view
//   POST /team/exceptions/:dedupeKey/resolve   { note, commandId? }             exception.resolve
//   POST /team/exceptions/:dedupeKey/verify    { note?, commandId? }            exception.verify   (TL/Admin/Owner)
//   POST /team/exceptions/:dedupeKey/reopen    { note?, commandId? }            exception.resolve
//   POST /team/exceptions/:dedupeKey/reassign  { toUserId, note?, commandId }   exception.reassign (TL/Admin/Owner)
//   GET  /scoreboard?userId=&range=                          scoreboard.view    (agent/ISA: self; TL: team)
//   GET  /team/scoreboard?range=                             scoreboard.view
//   GET  /team/momentum                                      scoreboard.view
//
// Authorization: core.can on facts read from RLS-visible rows (DATA_MODEL §3). An item the caller cannot
// see, or may not act on, is 404 (R-PERM-5). List routes authorize the caller's own scope; RLS decides
// which rows exist (exception_items, deals), and the 0012 functions decide whose numbers are returned.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError } from '../errors.js';
import { memberTarget } from '../leads/repos/contacts.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { accTx, actorOf } from './common.js';
import { type Verb, actOnException, exceptionFacts, getException, listExceptions, reassignException } from './exceptions.js';
import * as S from './schemas.js';
import { scoreboardFor, teamMomentum, teamScoreboard } from './scoreboard.js';

const keyOf = (req: FastifyRequest) => (req.params as { dedupeKey: string }).dedupeKey;
const itemFacts = (req: FastifyRequest) => accTx(req, (tx, _now, actor) => exceptionFacts(tx, actor, keyOf(req)));
/** list routes: the caller's own scope (RLS / the aggregate functions narrow the rows) */
const ownScope = () => ({ own: true });

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const envelope = () => app.platform.envelope;

  // ---- exception queue ----
  r.get(
    '/team/exceptions',
    { config: { auth: 'exception.view' }, preHandler: authorize('exception.view', ownScope), schema: { querystring: S.QueueQuery, response: { 200: S.QueueResponse } } },
    async (req) => accTx(req, (tx, now, actor) => listExceptions(tx, actor, envelope(), req.query, now)),
  );
  r.get(
    '/team/exceptions/:dedupeKey',
    { config: { auth: 'exception.view' }, preHandler: authorize('exception.view', itemFacts), schema: { params: S.KeyParams, response: { 200: S.ItemResponse } } },
    async (req) => accTx(req, (tx, now, actor) => getException(tx, actor, envelope(), req.params.dedupeKey, now)),
  );

  const simple: { verb: Exclude<Verb, 'reassign'>; action: 'exception.resolve' | 'exception.verify'; body: typeof S.ResolveBody | typeof S.VerifyBody | typeof S.ReopenBody }[] = [
    { verb: 'resolve', action: 'exception.resolve', body: S.ResolveBody },
    { verb: 'verify', action: 'exception.verify', body: S.VerifyBody },
    { verb: 'reopen', action: 'exception.resolve', body: S.ReopenBody },
  ];
  for (const s of simple) {
    r.post(
      `/team/exceptions/:dedupeKey/${s.verb}`,
      { config: { auth: s.action }, preHandler: authorize(s.action, itemFacts), schema: { params: S.KeyParams, body: s.body, response: { 200: S.ItemResponse } } },
      async (req) =>
        accTx(req, async (tx, now, actor) => {
          await actOnException(tx, actor, app.platform.ids, req.params.dedupeKey, s.verb, req.body as { note?: string; commandId?: string });
          return getException(tx, actor, envelope(), req.params.dedupeKey, now);
        }),
    );
  }

  r.post(
    '/team/exceptions/:dedupeKey/reassign',
    { config: { auth: 'exception.reassign' }, preHandler: authorize('exception.reassign', itemFacts), schema: { params: S.KeyParams, body: S.ReassignBody, response: { 200: S.ItemResponse } } },
    async (req) => {
      // ONE transaction: the ownership command and the event that cites it (R-ACC-3 / R-OWN-18). A rejected
      // command commits its rejection log first, then answers with its code.
      const out = await accTx(req, (tx, _now, actor) => reassignException(tx, actor, app.platform.ids, req.params.dedupeKey, req.body), { retries: 3 });
      if (!out.ok) throw out.error;
      return accTx(req, (tx, now, actor) => getException(tx, actor, envelope(), req.params.dedupeKey, now));
    },
  );

  // ---- scoreboard and momentum ----
  r.get(
    '/scoreboard',
    {
      config: { auth: 'scoreboard.view' },
      preHandler: authorize('scoreboard.view', (req) => {
        const actor = actorOf(req);
        const userId = (req.query as { userId?: string }).userId ?? actor.userId;
        if (userId === actor.userId) return { own: true };
        return accTx(req, async (tx) => {
          const t = await memberTarget(tx, userId);
          return t ? { team: t.in_my_team } : null;
        });
      }),
      schema: { querystring: S.ScoreboardQuery, response: { 200: S.ScoreboardResponse } },
    },
    async (req) =>
      accTx(req, async (tx, now, actor) => {
        const out = await scoreboardFor(tx, req.query.userId ?? actor.userId, req.query.range ?? '7d', now);
        if (!out.scoreboard) throw new AppError('NOT_FOUND');
        return { range: out.range, scoreboard: out.scoreboard };
      }),
  );
  r.get(
    '/team/scoreboard',
    { config: { auth: 'scoreboard.view' }, preHandler: authorize('scoreboard.view', ownScope), schema: { querystring: S.TeamScoreboardQuery, response: { 200: S.TeamScoreboardResponse } } },
    async (req) => accTx(req, (tx, now, actor) => teamScoreboard(tx, actor, req.query.range ?? '7d', now)),
  );
  r.get(
    '/team/momentum',
    { config: { auth: 'scoreboard.view' }, preHandler: authorize('scoreboard.view', ownScope), schema: { response: { 200: S.MomentumResponse } } },
    async (req) => accTx(req, (tx, now) => teamMomentum(tx, now)),
  );
}

export const accountabilityRoutes: RouteModule = { name: 'accountability', register };
