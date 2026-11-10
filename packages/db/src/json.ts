// jsonb values are written as JSON strings: node-postgres would otherwise serialize a JS array as a
// Postgres ARRAY literal ('{a,b}'), which is not valid JSON. `json(v)` is the typed way to fill a
// `Json` column with Kysely (`.values({ reasons: json(['LEAD_OFFER']) })`).
import type { JsonValue } from './schema.js';

export function json(v: JsonValue): string {
  return JSON.stringify(v);
}
