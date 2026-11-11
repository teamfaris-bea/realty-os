// PHASE2_3_PLAN §5.3 (modules 37 and 46): a separately shipped browser bundle (the website chat widget in
// apps/web/src/widget, later the client portal in apps/web/src/portal) imports nothing from the staff app: no
// staff surface, no shell, no design system, no staff-only package. A relative import must stay inside the
// bundle's own directory (`dir`, a directory name under some src/), and a package import must be on `allow`.
// The files it applies to are configured in eslint.config.js.

/** @typedef {import('eslint').Rule.RuleModule} RuleModule */
import { dirname, resolve, sep } from 'node:path';

/** @type {RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'A separate browser bundle (src/widget, src/portal) imports nothing outside its own directory (PHASE2_3_PLAN §5.3)' },
    schema: [
      {
        type: 'object',
        properties: { dir: { type: 'string' }, allow: { type: 'array', items: { type: 'string' } } },
        required: ['dir'],
        additionalProperties: false,
      },
    ],
    messages: {
      outside: 'Import "{{source}}" leaves {{dir}}/: this bundle ships on its own and may not import staff-app code.',
      pkg: 'Import "{{source}}" is not allowed in {{dir}}/: this bundle ships on its own (allowed packages: {{allowed}}).',
    },
  },
  create(context) {
    const opts = context.options[0] ?? { dir: 'widget' };
    const dir = String(opts.dir).replace(/[^a-z0-9_-]/gi, '');
    /** @type {string[]} */
    const allow = opts.allow ?? [];
    const filename = context.filename;
    const marker = `${sep}src${sep}${dir}${sep}`;
    const at = filename.lastIndexOf(marker);
    if (at < 0) return {};
    const root = filename.slice(0, at + marker.length);
    /** @param {any} node @param {string} source */
    function check(node, source) {
      if (source.startsWith('.') || source.startsWith('/')) {
        const target = resolve(dirname(filename), source);
        if (!`${target}${sep}`.startsWith(root) && !target.startsWith(root)) context.report({ node, messageId: 'outside', data: { source, dir } });
        return;
      }
      const bare = source.split('?')[0] ?? source;
      if (!allow.some((a) => bare === a || bare.startsWith(`${a}/`))) context.report({ node, messageId: 'pkg', data: { source, dir, allowed: allow.length ? allow.join(', ') : 'none' } });
    }
    /** @param {any} node */
    function fromSource(node) {
      const src = node.source;
      if (src && src.type === 'Literal' && typeof src.value === 'string') check(src, src.value);
    }
    return {
      ImportDeclaration: fromSource,
      ExportNamedDeclaration: fromSource,
      ExportAllDeclaration: fromSource,
      ImportExpression: fromSource,
      /** @param {any} node */
      TSImportType(node) {
        const raw = 'source' in node && node.source ? node.source : node.argument;
        const arg = raw?.type === 'TSLiteralType' ? raw.literal : raw;
        if (arg?.type === 'Literal' && typeof arg.value === 'string') check(node, arg.value);
      },
    };
  },
};

export default rule;
