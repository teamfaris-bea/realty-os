// Runs a psql-style SQL script (like packages/db/test/rls_smoke.sql) through node-postgres, so the
// script can be a Vitest test without shelling out to psql.
//
// Supported psql features (anything else throws, so a script never silently runs differently):
//   \set NAME value...   variables; values follow psql quoting ('' inside '...' is a quote)
//   :NAME                substitution outside string literals, quoted identifiers, dollar quotes
//                        and comments; `::` casts and undefined names are left alone (as psql does)
//   \o FILE, \set ON_ERROR_STOP/QUIET   accepted and ignored (errors always stop; output is not printed)
// The whole script is sent as one simple-query batch, so the first error aborts it and rejects.
import pg from 'pg';

export interface PsqlScriptResult {
  /** server NOTICE messages, in order */
  notices: string[];
}

function parseSetValue(rest: string): string {
  let out = '';
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i]!;
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === "'") {
      i++;
      for (;;) {
        if (i >= rest.length) throw new Error(`unterminated quote in \\set value: ${rest}`);
        const c = rest[i]!;
        if (c === "'") {
          if (rest[i + 1] === "'") {
            out += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (c === '\\') throw new Error(`backslash escapes in \\set values are not supported: ${rest}`);
        out += c;
        i++;
      }
      continue;
    }
    let word = '';
    while (i < rest.length && rest[i] !== ' ' && rest[i] !== '\t' && rest[i] !== "'") word += rest[i++]!;
    out += word;
  }
  return out;
}

/** Converts a psql script to plain SQL (exported for tests). */
export function preprocessPsqlScript(script: string): string {
  const vars = new Map<string, string>();
  const lines: string[] = [];
  for (const line of script.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('\\')) {
      lines.push(line);
      continue;
    }
    const m = /^\\(\w+)\s*(.*)$/.exec(trimmed);
    const cmd = m?.[1];
    if (cmd === 'set') {
      const sm = /^(\w+)\s*(.*)$/.exec(m![2]!);
      if (!sm) throw new Error(`bad \\set: ${line}`);
      vars.set(sm[1]!, parseSetValue(sm[2]!));
    } else if (cmd === 'o') {
      // output redirection: ignored
    } else {
      throw new Error(`unsupported psql meta-command: ${trimmed}`);
    }
    lines.push(''); // keep line numbers stable
  }
  return substitute(lines.join('\n'), vars);
}

function substitute(sql: string, vars: ReadonlyMap<string, string>): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  const isIdentStart = (c: string | undefined) => !!c && /[A-Za-z_]/.test(c);
  const isIdent = (c: string | undefined) => !!c && /[A-Za-z0-9_$]/.test(c);
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    // line comment
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    // block comment (nestable)
    if (ch === '/' && next === '*') {
      let depth = 0;
      let j = i;
      while (j < n) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else j++;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    // single-quoted literal ('' escapes; E'' strings also honour backslash escapes)
    if (ch === "'") {
      const escapeString = i > 0 && /[eE]/.test(sql[i - 1]!) && !isIdent(sql[i - 2]);
      let j = i + 1;
      while (j < n) {
        if (escapeString && sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // quoted identifier
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // dollar quote $tag$ ... $tag$ (not inside an identifier, not a $1 parameter)
    if (ch === '$' && !(i > 0 && isIdent(sql[i - 1]))) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    // :: cast
    if (ch === ':' && next === ':') {
      out += '::';
      i += 2;
      continue;
    }
    // :NAME variable
    if (ch === ':' && isIdentStart(next)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
      const name = sql.slice(i + 1, j);
      const value = vars.get(name);
      if (value !== undefined) {
        out += value;
        i = j;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Runs a psql-style script against `url` and returns the NOTICE messages it raised. */
export async function runPsqlScript(url: string, script: string): Promise<PsqlScriptResult> {
  const sql = preprocessPsqlScript(script);
  const client = new pg.Client({ connectionString: url, application_name: 'realty-psql-script' });
  const notices: string[] = [];
  client.on('notice', (msg) => notices.push(msg.message ?? ''));
  await client.connect();
  try {
    await client.query(sql);
    return { notices };
  } catch (err) {
    const e = err as Error & { position?: string };
    const line = e.position ? sql.slice(0, Number(e.position)).split('\n').length : undefined;
    const last = notices.at(-1);
    throw new Error(`${e.message}${line ? ` (script line ${line})` : ''}${last ? `; last notice: ${last}` : ''}`, { cause: err });
  } finally {
    await client.end();
  }
}
