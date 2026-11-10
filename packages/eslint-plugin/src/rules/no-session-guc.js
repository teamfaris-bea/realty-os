// ARCHITECTURE §3 "Pool hygiene" / R-TEN-3: request context GUCs are transaction-local only.
// Bans, inside any string or template literal (including Kysely `sql` tagged templates):
//   - `SET app.x = ...` / `SET SESSION app.x ...`            (use SET LOCAL or set_config(..., true))
//   - `set_config('app.x', value, <anything but true>)`      (session-level, leaks across pooled connections)
// `SET LOCAL app.x` and `set_config('app.x', v, true)` are fine.

/** @typedef {import('eslint').Rule.RuleModule} RuleModule */

const SET_RE = /\bSET\s+(?:SESSION\s+)?(?!LOCAL\b)["']?app\.[a-z_]/i;

/**
 * Splits the argument list starting right after `set_config(`; returns the args or null if unbalanced.
 * @param {string} text
 * @param {number} start
 * @returns {string[] | null}
 */
function splitArgs(text, start) {
  /** @type {string[]} */
  const args = [];
  let depth = 0;
  let cur = '';
  let quote = '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === '(') {
      depth++;
      cur += ch;
    } else if (ch === ')') {
      if (depth === 0) {
        args.push(cur.trim());
        return args;
      }
      depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  return null;
}

/**
 * @param {string} text
 * @returns {string | null} a description of the violation, or null
 */
export function findSessionGuc(text) {
  if (SET_RE.test(text)) return 'SET app.* without LOCAL';
  const re = /set_config\s*\(/gi;
  let m;
  while ((m = re.exec(text))) {
    const args = splitArgs(text, m.index + m[0].length);
    if (!args) continue;
    // only literal app.* names are checked; a dynamic name (template expression) cannot be judged
    if (!/^['"]app\./i.test(args[0] ?? '')) continue;
    if ((args[2] ?? '').toLowerCase() !== 'true') return "set_config('app.*', ..., is_local) where is_local is not literally true";
  }
  return null;
}

/** @type {RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Ban session-level app.* GUCs (SET without LOCAL, set_config(..., false))' },
    schema: [],
    messages: {
      guc: 'Session-level request context ({{what}}). Use SET LOCAL / set_config(name, value, true) inside the transaction (ARCHITECTURE §3).',
    },
  },
  create(context) {
    return {
      /** @param {any} node */
      Literal(node) {
        if (typeof node.value !== 'string') return;
        const what = findSessionGuc(node.value);
        if (what) context.report({ node, messageId: 'guc', data: { what } });
      },
      /** @param {any} node */
      TemplateLiteral(node) {
        const text = node.quasis.map((/** @type {any} */ q) => q.value.raw).join('$__expr__');
        const what = findSessionGuc(text);
        if (what) context.report({ node, messageId: 'guc', data: { what } });
      },
    };
  },
};

export default rule;
