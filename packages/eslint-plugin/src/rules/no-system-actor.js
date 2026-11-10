// ARCHITECTURE §2 / R-TEN-3: an Actor { kind: 'system', ... } may be constructed only in
// apps/api/src/worker/** (the allowlist is configured in eslint.config.js). Other code obtains a
// system actor from a factory exported by apps/api/src/worker/.
//
// Reported: an object literal with `kind: 'system'` (also `'system' as const`, `satisfies`, template
// literal) that also has a `tenantId` or `via` property or a spread, i.e. something actor-shaped.

/** @typedef {import('eslint').Rule.RuleModule} RuleModule */

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

/**
 * @param {any} key
 * @returns {string | null}
 */
function keyName(key) {
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

/** @type {RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: "Actor { kind: 'system' } is constructed only in apps/api/src/worker/**" },
    schema: [],
    messages: {
      system:
        "A system actor may only be constructed in apps/api/src/worker/**. Import the worker's system-actor factory instead (ARCHITECTURE §2, R-TEN-3).",
    },
  },
  create(context) {
    return {
      /** @param {any} node */
      ObjectExpression(node) {
        let isSystem = false;
        let actorShaped = false;
        for (const p of node.properties) {
          if (p.type === 'SpreadElement') {
            actorShaped = true;
            continue;
          }
          if (p.type !== 'Property' || p.computed && p.key.type !== 'Literal') continue;
          const k = keyName(p.key);
          if (k === 'kind' && stringValue(p.value) === 'system') isSystem = true;
          if (k === 'tenantId' || k === 'via') actorShaped = true;
        }
        if (isSystem && actorShaped) context.report({ node, messageId: 'system' });
      },
    };
  },
};

export default rule;
