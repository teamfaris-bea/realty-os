// R-GMAIL-14 (PHASE2_3_PLAN §5.3, module 68's one flagged edit of this package): synced Gmail is never a channel and
// never reaches a model. Two modes, configured per file set in eslint.config.js:
//
//   mode 'outside' (all of apps/api except src/mailSync/**): no string or template literal may name the tables
//     `mail_messages` or `user_mail_links` (SQL lives only in mailSync/**), except inside the functions named in
//     `allowInFunctions` (module 68's flagged `ingestSyncedMailInTx` in comms/inbound.ts).
//   mode 'no-import' (apps/api/src/assistant/** and the model provider apps/api/src/providers/anthropic.ts): no import
//     of apps/api/src/mailSync/**.
//   mode 'inside' (apps/api/src/mailSync/**): no import of a model provider (providers/anthropic, @anthropic-ai/*,
//     providers/fake/ai, assistant/**) and no reference to `dispatchOutbound` / `dialOutbound` (nothing is ever sent).
// The architecture test apps/api/src/mailSync/architecture.test.ts proves the same over the real files.

/** @typedef {import('eslint').Rule.RuleModule} RuleModule */
import { dirname, resolve, sep } from 'node:path';

const TABLES = /(?<![A-Za-z0-9_])(mail_messages|user_mail_links)(?![A-Za-z0-9_])/;
const SENDS = new Set(['dispatchOutbound', 'dialOutbound']);

/** @param {string} p */
const norm = (p) => p.split(sep).join('/');

/** @type {RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Synced Gmail stays inside apps/api/src/mailSync and never reaches a model or a send path (R-GMAIL-14)' },
    schema: [
      {
        type: 'object',
        properties: { mode: { enum: ['outside', 'no-import', 'inside'] }, allowInFunctions: { type: 'array', items: { type: 'string' } } },
        required: ['mode'],
        additionalProperties: false,
      },
    ],
    messages: {
      table: 'SQL naming "{{table}}" belongs in apps/api/src/mailSync/** only (R-GMAIL-14).',
      importMailSync: 'This code may not import mailSync: synced Gmail is never used by the assistant or sent to a model (R-GMAIL-14).',
      importModel: 'mailSync may not import a model provider or the assistant ("{{source}}"): synced Gmail never reaches a model (R-GMAIL-14).',
      send: 'mailSync never sends: "{{name}}" is not allowed here (R-GMAIL-3, R-GMAIL-14).',
    },
  },
  create(context) {
    const mode = context.options[0]?.mode;
    const allow = new Set(context.options[0]?.allowInFunctions ?? []);
    const filename = context.filename;

    /** @param {string} source */
    const resolved = (source) => (source.startsWith('.') ? norm(resolve(dirname(filename), source)) : source);
    /** @param {string} source */
    const isMailSync = (source) => /\/apps\/api\/src\/mailSync(\/|$)/.test(resolved(source)) || /(^|\/)mailSync\//.test(source) && source.startsWith('.');
    /** @param {string} source */
    const isModel = (source) => {
      if (/^@anthropic-ai\//.test(source)) return true;
      if (!source.startsWith('.')) return false;
      const r = resolved(source);
      return /\/apps\/api\/src\/providers\/(anthropic|fake\/(ai|hostileAi))(\.[jt]s)?$/.test(r) || /\/apps\/api\/src\/assistant(\/|$)/.test(r);
    };

    /** @param {any} node */
    function inAllowedFunction(node) {
      for (let p = node.parent; p; p = p.parent) {
        if ((p.type === 'FunctionDeclaration' || p.type === 'FunctionExpression') && p.id && allow.has(p.id.name)) return true;
        if (p.type === 'VariableDeclarator' && p.id?.type === 'Identifier' && allow.has(p.id.name)) return true;
      }
      return false;
    }

    /** @param {any} node @param {string} text */
    function checkText(node, text) {
      if (mode !== 'outside') return;
      const m = TABLES.exec(text);
      if (m && !inAllowedFunction(node)) context.report({ node, messageId: 'table', data: { table: m[1] } });
    }

    /** @param {any} node */
    function checkImport(node) {
      const src = node.source;
      if (!src || src.type !== 'Literal' || typeof src.value !== 'string') return;
      if (mode === 'no-import' && isMailSync(src.value)) context.report({ node: src, messageId: 'importMailSync' });
      if (mode === 'inside' && isModel(src.value)) context.report({ node: src, messageId: 'importModel', data: { source: src.value } });
    }

    return {
      /** @param {any} node */
      Literal(node) {
        if (typeof node.value === 'string') checkText(node, node.value);
      },
      /** @param {any} node */
      TemplateElement(node) {
        checkText(node, node.value?.cooked ?? node.value?.raw ?? '');
      },
      ImportDeclaration: checkImport,
      ExportNamedDeclaration: checkImport,
      ExportAllDeclaration: checkImport,
      ImportExpression: checkImport,
      /** @param {any} node */
      Identifier(node) {
        if (mode === 'inside' && SENDS.has(node.name)) context.report({ node, messageId: 'send', data: { name: node.name } });
      },
    };
  },
};

export default rule;
