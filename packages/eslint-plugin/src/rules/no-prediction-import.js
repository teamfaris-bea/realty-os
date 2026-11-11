// R-PRED-4 (PHASE2_3_PLAN §5.3, module 49): predictions only create feed cards for people. Ownership,
// priority, ads, portal and messaging/routing code may not import `@realty/core/predict` or
// `@realty/core/coaching` (by package name or by a relative path into packages/core/src/{predict,coaching}).
// The files it applies to are configured in eslint.config.js.

/** @typedef {import('eslint').Rule.RuleModule} RuleModule */
import { dirname, resolve } from 'node:path';

const DEFAULT_MODULES = ['predict', 'coaching'];

/** @type {RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'No import of core/predict or core/coaching from ownership, priority, ads, portal or messaging code (R-PRED-4)' },
    schema: [{ type: 'object', properties: { modules: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: {
      forbidden:
        'Import "{{source}}" is not allowed here: predictions and coaching never feed ownership, priority, ads, the portal ' +
        'or messages; a prediction only becomes a feed card (R-PRED-4).',
    },
  },
  create(context) {
    /** @type {string[]} */
    const modules = context.options[0]?.modules ?? DEFAULT_MODULES;
    const alt = modules.map((m) => m.replace(/[^a-z0-9_-]/gi, '')).join('|');
    const bySpecifier = new RegExp(`^@realty/core/(?:${alt})(?:/|$)`);
    const byPath = new RegExp(`[\\\\/]packages[\\\\/]core[\\\\/]src[\\\\/](?:${alt})(?:[\\\\/]|$)`);
    const filename = context.filename;
    /** @param {string} source */
    function forbidden(source) {
      if (bySpecifier.test(source)) return true;
      if (!source.startsWith('.')) return false;
      return byPath.test(resolve(dirname(filename), source));
    }
    /** @param {any} node */
    function check(node) {
      const src = node.source;
      if (!src || src.type !== 'Literal' || typeof src.value !== 'string') return;
      if (forbidden(src.value)) context.report({ node: src, messageId: 'forbidden', data: { source: src.value } });
    }
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
      /** @param {any} node */
      TSImportType(node) {
        const raw = 'source' in node && node.source ? node.source : node.argument; // `argument` is deprecated in newer typescript-eslint
        const arg = raw?.type === 'TSLiteralType' ? raw.literal : raw;
        const value = arg?.type === 'Literal' ? arg.value : undefined;
        if (typeof value === 'string' && forbidden(value)) context.report({ node, messageId: 'forbidden', data: { source: value } });
      },
    };
  },
};

export default rule;
