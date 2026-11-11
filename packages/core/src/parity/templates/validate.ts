// Saving a template (PARITY_PLAN module 62; R-PAR-23, R-PAR-24, R-PAR-26).
//
// The DB CHECKs hold the shapes (name, subject without CR/LF, body length per channel, the merge-field
// regex); core ties the stored `merge_fields` to the body and subject actually saved, and refuses a
// custom field that is not live (archived or unknown), so a template never names data the renderer
// will not have.
import { type Result, fail, ok } from '../../foundation/index.js';
import { type MergeField, type ParseErrorCode, customFieldKey, fieldsOf, parseMergeTokens } from './fields.js';

export type TemplateChannel = 'sms' | 'email';
export type TemplateScope = 'team' | 'personal';

export const TEMPLATE_LIMITS = Object.freeze({
  nameMax: 80,
  subjectMax: 200,
  smsBodyMax: 1600,
  emailBodyMax: 20000,
});

export interface TemplateDraft {
  channel: TemplateChannel;
  name: string;
  subject: string | null;
  body: string;
}

export interface ValidTemplate {
  name: string;
  subject: string | null;
  body: string;
  mergeFields: MergeField[];
}

export type TemplateErrorCode =
  | ParseErrorCode
  | 'TEMPLATE_NAME_INVALID'
  | 'TEMPLATE_SUBJECT_REQUIRED'
  | 'TEMPLATE_SUBJECT_NOT_ALLOWED'
  | 'TEMPLATE_SUBJECT_INVALID'
  | 'TEMPLATE_BODY_EMPTY'
  | 'TEMPLATE_BODY_TOO_LONG'
  | 'TEMPLATE_BODY_INVALID'
  | 'MERGE_FIELD_ARCHIVED';

// eslint-disable-next-line no-control-regex -- detecting control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- a body may hold tabs and line breaks, never other control characters
const BODY_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * Validates a template before insert/update. `liveFieldKeys` are the tenant's live (not archived) custom
 * field keys; `archivedFieldKeys` lets the error say "archived" rather than "unknown".
 */
export function validateTemplate(
  d: TemplateDraft,
  liveFieldKeys: ReadonlySet<string>,
  archivedFieldKeys: ReadonlySet<string> = new Set(),
): Result<{ template: ValidTemplate }, TemplateErrorCode, { token?: string }> {
  const name = d.name.trim();
  if (name.length < 1 || name.length > TEMPLATE_LIMITS.nameMax || CONTROL_RE.test(name)) return fail('TEMPLATE_NAME_INVALID');
  let subject: string | null = null;
  if (d.channel === 'email') {
    if (d.subject === null || d.subject.trim().length === 0) return fail('TEMPLATE_SUBJECT_REQUIRED');
    subject = d.subject.trim();
    if (subject.length > TEMPLATE_LIMITS.subjectMax || CONTROL_RE.test(subject)) return fail('TEMPLATE_SUBJECT_INVALID');
  } else if (d.subject !== null && d.subject.trim().length > 0) return fail('TEMPLATE_SUBJECT_NOT_ALLOWED');
  const body = d.body.replace(/\r\n?/g, '\n').trim();
  if (body.length === 0) return fail('TEMPLATE_BODY_EMPTY');
  if (body.length > (d.channel === 'sms' ? TEMPLATE_LIMITS.smsBodyMax : TEMPLATE_LIMITS.emailBodyMax)) return fail('TEMPLATE_BODY_TOO_LONG');
  if (BODY_CONTROL_RE.test(body)) return fail('TEMPLATE_BODY_INVALID');
  const b = parseMergeTokens(body);
  if (!b.ok) return b;
  const s = subject === null ? ok({ tokens: [] }) : parseMergeTokens(subject);
  if (!s.ok) return s;
  const mergeFields = fieldsOf([...b.tokens, ...s.tokens]);
  for (const f of mergeFields) {
    const key = customFieldKey(f);
    if (key === null) continue;
    if (!liveFieldKeys.has(key)) return fail(archivedFieldKeys.has(key) ? 'MERGE_FIELD_ARCHIVED' : 'MERGE_FIELD_UNKNOWN', { token: f });
  }
  return ok({ template: { name, subject, body, mergeFields } });
}
