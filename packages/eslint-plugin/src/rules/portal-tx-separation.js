// R-TEN-14 / R-PORTAL-4 (PHASE2_3_PLAN module 43): staff and client transaction helpers never mix.
//
//   mode 'client' (portal client code, configured in eslint.config.js: apps/api/src/portal/client/**):
//       client code reaches the database only through withPortalTx and the portal wrappers of @realty/db.
//       - Banned by name: every helper that opens its own staff, pre-tenant or no-context transaction, and the pool
//         itself. withTenantTx, withPreTenant, withPreTenantThenTenant, withNoContext and actorGucs; the ownership
//         engine's applyOwnershipCommand, applyOwnershipCommandThen and runOwnershipFollowup (each opens withTenantTx,
//         for a staff actor or the system actor); the job queue's claimJobs, finishJob, reapJobs and dueWork (each
//         opens withNoContext); getDatabase and createDatabase (a statement on the pool carries no context at all).
//       - An allowlist at the source: from @realty/db (or a subpath of it) client code takes only CLIENT_DB_EXPORTS,
//         the value exports of packages/db/src/portalTx.ts. Any other value it imports or re-exports from there is
//         reported, and so is taking the package whole (a namespace import, `export *`, `import()`, `require()`), so a
//         helper that @realty/db exports later is refused here until someone puts it on the list.
//   mode 'staff' (everything else except packages/db/src/portalTx.ts and tests):
//       withPortalTx is banned, and so is constructing a client actor ({ kind: 'client', ... } with a
//       portalAccountId / tenantId / sessionId or a spread): a ClientActor comes only from resolvePortalSession.
//
// Reported: an import of a banned name (and in client mode a re-export of one), a call to it (directly or as a member,
// e.g. db.withTenantTx), and passing it as a value. A type-only import or re-export is not a use.

/** @typedef {import('eslint').Rule.RuleModule} RuleModule */

const BANNED = {
  client: [
    // withPreTenantThenTenant is withPreTenant then withTenantTx's GUCs in one transaction (principal 'staff'):
    // with `actorOf = () => null` it is the pre-tenant context, with a staff actor the staff context.
    'withTenantTx',
    'withPreTenant',
    'withPreTenantThenTenant',
    'withNoContext',
    'actorGucs',
    // the ownership engine's own-transaction entry points: withTenantTx for a staff actor, or for the system actor
    // (runOwnershipFollowup, the follow-up job), whom app.is_tenant_wide() lets see the whole tenant
    'applyOwnershipCommand',
    'applyOwnershipCommandThen',
    'runOwnershipFollowup',
    // the worker's job queue: cross-tenant definers called through withNoContext
    'claimJobs',
    'finishJob',
    'reapJobs',
    'dueWork',
    // the pool itself
    'getDatabase',
    'createDatabase',
  ],
  staff: ['withPortalTx'],
};

/**
 * Client mode: the only values portal client code may take from @realty/db, exactly the value exports of
 * packages/db/src/portalTx.ts (test/config.test.js fails when the two differ): withPortalTx; the pre-tenant entry
 * points that each run one portal.* definer (request and consume a login, resolve and end a session); the three calls
 * made inside withPortalTx; two pure token helpers; and the error requestPortalLogin throws until the portal is cleared.
 */
export const CLIENT_DB_EXPORTS = Object.freeze([
  'withPortalTx',
  'requestPortalLogin',
  'consumePortalLogin',
  'resolvePortalSession',
  'endPortalSession',
  'issuePortalDocumentStream',
  'redeemPortalDocumentStream',
  'recordPortalAudit',
  'newPortalToken',
  'portalAddressHash',
  'PortalNotClearedError',
]);

const DB_PACKAGE = '@realty/db';
const DB_SPECIFIER = /^@realty\/db(?:\/|$)/;

/**
 * @param {any} node
 * @returns {any}
 */
function unwrap(node) {
  let cur = node;
  while (cur && (cur.type === 'TSAsExpression' || cur.type === 'TSSatisfiesExpression' || cur.type === 'TSNonNullExpression' || cur.type === 'TSTypeAssertion')) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * @param {any} key
 * @returns {string | null}
 */
function keyName(key) {
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

/**
 * @param {any} node
 * @returns {string | null}
 */
function stringValue(node) {
  const n = unwrap(node);
  if (!n) return null;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0]?.value.cooked ?? null;
  return null;
}

/** @type {RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Keep withPortalTx (client principal) and the staff, pre-tenant and no-context helpers apart (R-TEN-14, R-PORTAL-4)' },
    schema: [{ type: 'object', properties: { mode: { enum: ['client', 'staff'] } }, required: ['mode'], additionalProperties: false }],
    messages: {
      clientUsesStaff:
        '{{name}} opens a staff, pre-tenant or no-context transaction (or is the pool itself): portal client code uses withPortalTx and the @realty/db portal wrappers only (R-TEN-14).',
      clientDbImport:
        "{{name}} from '{{source}}' is not a portal client helper: portal client code takes from @realty/db only withPortalTx and the portal wrappers of packages/db/src/portalTx.ts; type-only imports are fine (R-TEN-14).",
      clientDbWhole:
        "'{{source}}' is taken whole here ({{how}}): portal client code names each value it takes from @realty/db, and takes only withPortalTx and the portal wrappers of packages/db/src/portalTx.ts (R-TEN-14).",
      staffUsesClient: 'withPortalTx is the client principal\'s transaction: only portal client code (apps/api/src/portal/client/**) may use it (R-TEN-14).',
      clientActor: 'A client actor is built only by resolvePortalSession (packages/db/src/portalTx.ts); never construct one (R-TEN-14).',
    },
  },
  create(context) {
    const mode = /** @type {'client' | 'staff'} */ (context.options[0]?.mode ?? 'staff');
    const banned = new Set(BANNED[mode]);
    const clientDb = new Set(CLIENT_DB_EXPORTS);
    const messageId = mode === 'client' ? 'clientUsesStaff' : 'staffUsesClient';
    /** @param {any} node @param {string} name */
    const report = (node, name) => context.report({ node, messageId, data: { name } });
    /**
     * Client mode: the @realty/db specifier that `node` spells, else null (another module, a computed one, staff mode).
     * @param {any} node
     * @returns {string | null}
     */
    const dbSource = (node) => {
      if (mode !== 'client') return null;
      const s = stringValue(node);
      return s !== null && DB_SPECIFIER.test(s) ? s : null;
    };
    /**
     * A value imported (or, in client mode, re-exported) by name from the module that `sourceNode` spells.
     * @param {any} node @param {string} name @param {any} sourceNode
     */
    const checkTaken = (node, name, sourceNode) => {
      if (banned.has(name)) {
        report(node, name);
        return;
      }
      const source = dbSource(sourceNode);
      if (source !== null && !(source === DB_PACKAGE && clientDb.has(name))) context.report({ node, messageId: 'clientDbImport', data: { name, source } });
    };
    /**
     * Client mode: the whole of an @realty/db module taken at once, which no name check can see through.
     * @param {any} node @param {string} how @param {any} sourceNode
     */
    const checkWhole = (node, how, sourceNode) => {
      const source = dbSource(sourceNode);
      if (source !== null) context.report({ node, messageId: 'clientDbWhole', data: { source, how } });
    };
    return {
      /** @param {any} node */
      ImportDeclaration(node) {
        if (node.importKind === 'type') return;
        for (const s of node.specifiers) {
          if (s.type === 'ImportSpecifier') {
            if (s.importKind !== 'type') checkTaken(s, s.imported?.name ?? s.imported?.value, node.source);
          } else if (s.type === 'ImportDefaultSpecifier') {
            checkTaken(s, 'default', node.source);
          } else {
            checkWhole(s, `import * as ${s.local?.name}`, node.source);
          }
        }
      },
      /** @param {any} node */
      ExportNamedDeclaration(node) {
        if (mode !== 'client' || !node.source || node.exportKind === 'type') return;
        for (const s of node.specifiers) {
          if (s.exportKind !== 'type') checkTaken(s, s.local?.name ?? s.local?.value, node.source);
        }
      },
      /** @param {any} node */
      ExportAllDeclaration(node) {
        if (node.exportKind === 'type') return;
        checkWhole(node, node.exported ? `export * as ${keyName(node.exported)}` : 'export *', node.source);
      },
      /** @param {any} node */
      ImportExpression(node) {
        checkWhole(node, 'import()', node.source);
      },
      /** @param {any} node */
      TSImportEqualsDeclaration(node) {
        if (node.importKind === 'type' || node.moduleReference?.type !== 'TSExternalModuleReference') return;
        checkWhole(node, 'import = require()', node.moduleReference.expression);
      },
      /** @param {any} node */
      CallExpression(node) {
        const callee = unwrap(node.callee);
        const name = callee?.type === 'Identifier' ? callee.name : callee?.type === 'MemberExpression' && !callee.computed ? callee.property?.name : callee?.type === 'MemberExpression' ? stringValue(callee.property) : null;
        if (name && banned.has(name)) report(node, name);
        if (callee?.type === 'Identifier' && callee.name === 'require' && node.arguments.length > 0) checkWhole(node, 'require()', node.arguments[0]);
        for (const arg of node.arguments) {
          const a = unwrap(arg);
          if (a?.type === 'Identifier' && banned.has(a.name)) report(arg, a.name);
        }
      },
      /** @param {any} node */
      ObjectExpression(node) {
        if (mode !== 'staff') return;
        let isClient = false;
        let actorShaped = false;
        for (const p of node.properties) {
          if (p.type === 'SpreadElement') {
            actorShaped = true;
            continue;
          }
          if (p.type !== 'Property' || (p.computed && p.key.type !== 'Literal')) continue;
          const k = keyName(p.key);
          if (k === 'kind' && stringValue(p.value) === 'client') isClient = true;
          if (k === 'portalAccountId' || k === 'tenantId' || k === 'sessionId') actorShaped = true;
        }
        if (isClient && actorShaped) context.report({ node, messageId: 'clientActor' });
      },
    };
  },
};

export default rule;
