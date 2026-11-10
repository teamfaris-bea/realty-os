// CSV export hygiene (OWASP "CSV Injection"). Any CSV the API sends (an error report, a rejected-row
// report, any text/csv download) must be built with `toCsv` (or `csvField` per cell): imported data is
// attacker-controlled, and a spreadsheet evaluates a cell that starts with = + - @ tab or CR.
//
//   neutralizeCsvCell  prefixes a single quote to such a cell, so it is shown as text, not evaluated.
//                      Strict on purpose: unlike core's csvSafeCell (which lets "+1 415…" and "-5"
//                      through for the import review), every + and - is prefixed here.
//   csvField           one field: text is neutralised, then always quoted with embedded quotes doubled;
//                      typed numbers and booleans are written as they are (they cannot carry a formula).
//   toCsv              a header plus rows, CRLF line endings (RFC 4180), every header cell neutralised.
//
// As of this pass no route sends CSV; the helper exists so the first one cannot forget it.

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export type CsvValue = string | number | boolean | null | undefined;

export function neutralizeCsvCell(v: string): string {
  return FORMULA_TRIGGER.test(v) ? `'${v}` : v;
}

export function csvField(v: CsvValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return String(v);
  return `"${neutralizeCsvCell(v).replace(/"/g, '""')}"`;
}

export function toCsv(header: readonly string[], rows: Iterable<readonly CsvValue[]>): string {
  const lines = [header.map(csvField).join(',')];
  for (const r of rows) lines.push(r.map(csvField).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
