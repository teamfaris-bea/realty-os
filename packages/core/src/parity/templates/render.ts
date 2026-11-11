// renderTemplate (PARITY_PLAN §4.2 and module 62; R-PAR-24, E179).
//
// Pure. The context describes exactly ONE person, built by the API under the sender's own RLS, so a
// field the sender cannot see is simply absent. There is no lookup by name or id here: the renderer can
// only print values it was handed for that one person, the sender, the team and the brokerage.
//
// One pass: the source text is scanned once (parseMergeTokens) and each token is replaced by its value
// LITERALLY. A value that itself looks like a token ("{{agent.email}}" typed as a first name) is printed
// as those characters; it is never parsed again (E179). Output is plain text: control characters are
// removed from values, values are single-line, and the subject has no CR or LF at all.
//
// A token whose value is empty and that has no fallback is reported in `missing`; renderForSend turns
// that into MERGE_FIELD_EMPTY, so no template can ever produce "Hi ,".
import { type Result, fail, ok } from '../../foundation/index.js';
import { type MergeField, type MergeToken, customFieldKey, parseMergeTokens } from './fields.js';
import { TEMPLATE_LIMITS, type TemplateChannel } from './validate.js';

/** The facts of one person (and the sender) a template may print. Absent / null / blank = no value. */
export interface OnePersonContext {
  contact: { firstName: string | null; lastName: string | null; displayName: string | null };
  /** the SENDER (the human the message is from), never the contact owner or anyone else */
  agent: { firstName: string | null; lastName: string | null; phone: string | null; email: string | null };
  team: { name: string | null };
  brokerage: { name: string | null };
  /** live custom field values of THIS person, formatted for display, keyed by field key */
  fields: Readonly<Record<string, string | null>>;
}

export interface RenderableTemplate {
  channel: TemplateChannel;
  subject: string | null;
  body: string;
}

export interface Rendered {
  subject?: string;
  body: string;
  /** fields that had no value and no fallback, in order of first use, deduplicated */
  missing: MergeField[];
}

// eslint-disable-next-line no-control-regex -- values are plain single-line text
const VALUE_STRIP_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
/** Invisible formatting a value could use to spoof the text around it (bidi overrides, zero-width). */
// U+061C, the soft hyphen, CGJ, fillers and the invisible tag characters added by the security review: a value
// made only of them is empty (MERGE_FIELD_EMPTY, never a "Hi ," that only looks filled). Emoji variation
// selectors stay. (Each listed character is removed on its own, so a combining one in the class is intended.)
// eslint-disable-next-line no-misleading-character-class
const VALUE_INVISIBLE_RE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufeff\uffa0\u{e0000}-\u{e007f}]/gu;

/** A value as printed: control characters and line breaks become one space, invisible formatting is dropped, trimmed. */
export function cleanValue(v: string | null | undefined): string {
  if (v === null || v === undefined) return '';
  return v.replace(VALUE_INVISIBLE_RE, '').replace(VALUE_STRIP_RE, ' ').replace(/ {2,}/g, ' ').trim();
}

export function valueOf(field: MergeField, ctx: OnePersonContext): string {
  switch (field) {
    case 'contact.first_name':
      return cleanValue(ctx.contact.firstName);
    case 'contact.last_name':
      return cleanValue(ctx.contact.lastName);
    case 'contact.display_name':
      return cleanValue(ctx.contact.displayName);
    case 'agent.first_name':
      return cleanValue(ctx.agent.firstName);
    case 'agent.last_name':
      return cleanValue(ctx.agent.lastName);
    case 'agent.phone':
      return cleanValue(ctx.agent.phone);
    case 'agent.email':
      return cleanValue(ctx.agent.email);
    case 'team.name':
      return cleanValue(ctx.team.name);
    case 'brokerage.name':
      return cleanValue(ctx.brokerage.name);
    default: {
      const key = customFieldKey(field);
      if (key === null || !Object.prototype.hasOwnProperty.call(ctx.fields, key)) return '';
      return cleanValue(ctx.fields[key]);
    }
  }
}

function substitute(text: string, tokens: readonly MergeToken[], ctx: OnePersonContext, missing: MergeField[]): string {
  let out = '';
  let pos = 0;
  for (const t of tokens) {
    out += text.slice(pos, t.start);
    const v = valueOf(t.field, ctx);
    if (v.length > 0) out += v;
    else if (t.fallback !== null) out += cleanValue(t.fallback);
    else if (!missing.includes(t.field)) missing.push(t.field);
    pos = t.end;
  }
  return out + text.slice(pos);
}

/**
 * Renders a saved template for one person. A template that no longer parses (it cannot, after
 * validateTemplate; kept total for safety) renders nothing and reports every built-in as missing.
 */
export function renderTemplate(template: RenderableTemplate, ctx: OnePersonContext): Rendered {
  const missing: MergeField[] = [];
  const b = parseMergeTokens(template.body);
  if (!b.ok) return { body: '', missing: ['contact.first_name'], ...(template.channel === 'email' ? { subject: '' } : {}) };
  const body = substitute(template.body, b.tokens, ctx, missing).trim();
  if (template.channel !== 'email' || template.subject === null) return { body, missing };
  const s = parseMergeTokens(template.subject);
  if (!s.ok) return { body, subject: '', missing: [...missing, 'contact.first_name'] };
  // the subject is one line: any CR/LF (from a value or the source) becomes a space
  const subject = substitute(template.subject, s.tokens, ctx, missing).replace(/[\r\n]+/g, ' ').trim();
  return { body, subject, missing };
}

export type RenderErrorCode = 'MERGE_FIELD_EMPTY' | 'TEMPLATE_RENDERED_EMPTY' | 'TEMPLATE_RENDERED_TOO_LONG';

/** renderTemplate, refusing anything that must not be sent (R-PAR-24: never "Hi ,"). */
export function renderForSend(template: RenderableTemplate, ctx: OnePersonContext): Result<{ subject: string | null; body: string }, RenderErrorCode, { missing?: MergeField[] }> {
  const r = renderTemplate(template, ctx);
  if (r.missing.length > 0) return fail('MERGE_FIELD_EMPTY', { missing: r.missing });
  if (r.body.length === 0 || (template.channel === 'email' && (r.subject ?? '').length === 0)) return fail('TEMPLATE_RENDERED_EMPTY');
  const max = template.channel === 'sms' ? TEMPLATE_LIMITS.smsBodyMax : TEMPLATE_LIMITS.emailBodyMax;
  if (r.body.length > max || (r.subject ?? '').length > TEMPLATE_LIMITS.subjectMax) return fail('TEMPLATE_RENDERED_TOO_LONG');
  return ok({ subject: template.channel === 'email' ? (r.subject ?? '') : null, body: r.body });
}
