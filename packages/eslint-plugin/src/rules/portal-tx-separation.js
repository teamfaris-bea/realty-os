// R-TEN-14 / R-PORTAL-4 (PHASE2_3_PLAN module 43): staff and client transaction helpers never mix.
//
//   mode 'client' (portal client code, configured in eslint.config.js: apps/api/src/portal/client/**):
//       the staff and pre-tenant helpers withTenantTx, withPreTenant, withNoContext and actorGucs are banned;
//       client code reaches the database only through withPortalTx and the portal wrappers of @realty/db.
//   mode 'staff' (everything else except packages/db/src/portalTx.ts and tests):
//       withPortalTx is banned, and so is constructing a client actor ({ kind: 'client', ... } with a
//       portalAccountId / tenantId / sessionId or a spread): a ClientActor comes only from resolvePortalSession.
//
// Reported: an import of a banned name, a call to it (directly or as a member, e.g. db.withTenantTx), and passing
// it as a value. A type-only reference is not a use.

/** @typedef {import('eslint').Rule.RuleModule} RuleModule */

const BANNED = {
  client: ['withTenantTx', 'withPreTenant', 'withNoContext', 'actorGucs'],
  staff: ['withPortalTx'],
};

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
    docs: { description: 'Keep withPortalTx (client principal) and withTenantTx (staff) apart (R-TEN-14, R-PORTAL-4)' },
    schema: [{ type: 'object', properties: { mode: { enum: ['client', 'staff'] } }, required: ['mode'], additionalProperties: false }],
    messages: {
      clientUsesStaff: '{{name}} is a staff/pre-tenant transaction helper: portal client code uses withPortalTx and the @realty/db portal wrappers only (R-TEN-14).',
      staffUsesClient: 'withPortalTx is the client principal\'s transaction: only portal client code (apps/api/src/portal/client/**) may use it (R-TEN-14).',
      clientActor: 'A client actor is built only by resolvePortalSession (packages/db/src/portalTx.ts); never construct one (R-TEN-14).',
    },
  },
  create(context) {
    const mode = /** @type {'client' | 'staff'} */ (context.options[0]?.mode ?? 'staff');
    const banned = new Set(BANNED[mode]);
    const messageId = mode === 'client' ? 'clientUsesStaff' : 'staffUsesClient';
    /** @param {any} node @param {string} name */
    const report = (node, name) => context.report({ node, messageId, data: { name } });
    return {
      /** @param {any} node */
      ImportSpecifier(node) {
        if (node.importKind === 'type' || node.parent?.importKind === 'type') return;
        const name = node.imported?.name ?? node.imported?.value;
        if (banned.has(name)) report(node, name);
      },
      /** @param {any} node */
      CallExpression(node) {
        const callee = unwrap(node.callee);
        const name = callee?.type === 'Identifier' ? callee.name : callee?.type === 'MemberExpression' && !callee.computed ? callee.property?.name : callee?.type === 'MemberExpression' ? stringValue(callee.property) : null;
        if (name && banned.has(name)) report(node, name);
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
