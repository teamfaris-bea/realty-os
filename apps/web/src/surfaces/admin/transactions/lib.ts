// Pure helpers of the milestone templates page (module 41; R-TXN-6). Unit-tested.

export interface ParsedTemplate {
  id: string;
  version: number;
  name: string;
  side: string;
  jurisdiction: string;
  reviewed: boolean;
  rules: number;
}

export interface TemplatesResponse {
  templates: unknown[];
  parsed: ParsedTemplate[];
  invalid: { index: number; error: string }[];
  jurisdictions: string[];
}

/** The editor's text parsed as the list the server takes, or the reason it is not one. */
export function parseEditor(text: string): { ok: true; templates: unknown[] } | { ok: false; error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `This is not valid JSON: ${(e as Error).message}` };
  }
  if (!Array.isArray(v)) return { ok: false, error: 'The templates must be a list ([ ... ]), one object per template.' };
  return { ok: true, templates: v };
}

/**
 * Sets `reviewed` on the template entry `id@version` of the editor's list. Counsel review is recorded only as an
 * Owner/Admin's statement (R-TXN-6, VERIFY WITH COUNSEL); the change is saved with the list (and audited).
 */
export function setReviewed(text: string, key: string, reviewed: boolean): string | null {
  const p = parseEditor(text);
  if (!p.ok) return null;
  const out = p.templates.map((t) => {
    if (typeof t !== 'object' || t === null) return t;
    const o = t as { id?: unknown; version?: unknown };
    return `${String(o.id)}@${String(o.version)}` === key ? { ...(t as Record<string, unknown>), reviewed } : t;
  });
  return JSON.stringify(out, null, 2);
}

export const SIDE_LABEL: Record<string, string> = { buy: 'Buying', sell: 'Selling', dual: 'Both sides', lease: 'Lease' };
