// Workspace boundaries: a relative import must stay inside the importing file's own workspace
// package. Cross-package code goes through the package name (`@realty/core/compliance`), so the
// package-level import bans (core imports nothing from db/api, ...) cannot be bypassed with `../../`.

/** @typedef {import('eslint').Rule.RuleModule} RuleModule */
import { existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

/** @type {Map<string, string | null>} */
const rootCache = new Map();

/**
 * @param {string} dir
 * @returns {string | null}
 */
function packageRoot(dir) {
  const cached = rootCache.get(dir);
  if (cached !== undefined) return cached;
  let cur = dir;
  /** @type {string | null} */
  let found = null;
  for (;;) {
    if (existsSync(resolve(cur, 'package.json'))) {
      found = cur;
      break;
    }
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  rootCache.set(dir, found);
  return found;
}

/** @type {RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Relative imports may not leave the workspace package' },
    schema: [],
    messages: {
      outside: 'Relative import "{{source}}" leaves this package. Import the other package by name (e.g. @realty/core/<module>).',
    },
  },
  create(context) {
    const filename = context.filename;
    const root = packageRoot(dirname(filename));
    /** @param {any} node */
    function check(node) {
      const source = node.source?.value;
      if (!root || typeof source !== 'string' || !source.startsWith('.')) return;
      const target = resolve(dirname(filename), source);
      if (target !== root && !target.startsWith(root + sep)) {
        context.report({ node: node.source, messageId: 'outside', data: { source } });
      }
    }
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    };
  },
};

export default rule;
