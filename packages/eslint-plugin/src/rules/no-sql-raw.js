// R-PAR-29 (PARITY_PLAN module 59/60): smart-list SQL is built only from whitelisted, parameterised
// fragments. In the files this rule is configured for (eslint.config.js: apps/api/src/lists/**), the
// Kysely escape hatches that put text into SQL unparameterised are banned outright: sql.raw, sql.lit,
// sql.ref, sql.id, sql.table, sql.val is fine (a bound value) and sql.join is fine (joins fragments).
// Reading the members (`const { raw } = sql`) or passing them around (`f(sql.raw)`) is banned too.

/** @typedef {import('eslint').Rule.RuleModule} RuleModule */

const BANNED = new Set(['raw', 'lit', 'ref', 'id', 'table']);

/** @type {RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'No unparameterised Kysely SQL (sql.raw/lit/ref/id/table) in smart-list code (R-PAR-29)' },
    schema: [],
    messages: {
      banned: 'sql.{{name}} puts text into SQL without a bound parameter; smart-list SQL uses only fixed fragments and ${value} parameters (R-PAR-29).',
    },
  },
  create(context) {
    /** @param {any} node */
    function propName(node) {
      if (!node) return null;
      if (node.type === 'Identifier') return node.name;
      if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
      if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;
      return null;
    }
    return {
      /** @param {any} node */
      MemberExpression(node) {
        if (node.object.type !== 'Identifier' || node.object.name !== 'sql') return;
        const name = node.computed ? (node.property.type === 'Identifier' ? null : propName(node.property)) : node.property.name;
        if (node.computed && name === null) {
          context.report({ node, messageId: 'banned', data: { name: '[computed]' } });
          return;
        }
        if (name !== null && BANNED.has(name)) context.report({ node, messageId: 'banned', data: { name } });
      },
      /** @param {any} node */
      VariableDeclarator(node) {
        if (node.init?.type !== 'Identifier' || node.init.name !== 'sql' || node.id.type !== 'ObjectPattern') return;
        for (const p of node.id.properties) {
          const name = p.type === 'Property' ? propName(p.key) : null;
          if (name !== null && BANNED.has(name)) context.report({ node: p, messageId: 'banned', data: { name } });
        }
      },
    };
  },
};

export default rule;
