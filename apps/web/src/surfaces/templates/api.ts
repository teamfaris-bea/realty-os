// Templates API shapes (parity module 63 routes) and query keys for the web (module 64).
import { parseMergeTokens } from '@realty/core/parity/templates';

export type TemplateChannel = 'sms' | 'email';

export interface TemplateView {
  id: string;
  scope: 'team' | 'personal';
  mine: boolean;
  channel: TemplateChannel;
  name: string;
  subject: string | null;
  body: string;
  version: number;
  mergeFields: string[];
  archived: boolean;
  editable: boolean;
  updatedAt: string;
}

export interface RenderedView {
  templateId: string;
  version: number;
  channel: TemplateChannel;
  subject: string | null;
  body: string;
  preview: string;
  missing: string[];
}

export const TEMPLATES_KEY = ['templates'] as const;

/** The closed merge-field set (R-PAR-24), with the words the editor shows for each. */
export const MERGE_FIELD_HELP: readonly { field: string; label: string }[] = [
  { field: 'contact.first_name', label: "Their first name" },
  { field: 'contact.last_name', label: "Their last name" },
  { field: 'contact.display_name', label: "Their full name" },
  { field: 'agent.first_name', label: 'Your first name' },
  { field: 'agent.last_name', label: 'Your last name' },
  { field: 'agent.phone', label: 'Your phone' },
  { field: 'agent.email', label: 'Your email' },
  { field: 'team.name', label: 'Team name' },
  { field: 'brokerage.name', label: 'Brokerage name' },
];

/** "contact.first_name" → "their first name" (for "Needs their first name"). */
export function fieldWords(f: string): string {
  const known = MERGE_FIELD_HELP.find((x) => x.field === f);
  if (known) return known.label.charAt(0).toLowerCase() + known.label.slice(1);
  return f.startsWith('field.') ? f.slice(6).replace(/_/g, ' ') : f;
}

/**
 * A template's text with each merge field said in words, for showing it before it is filled in for each
 * person (the bulk count sheet, the template picker, a bulk action's page; journey copy bug: those showed the
 * raw "{{contact.first_name}}"): "Hi {{contact.first_name|there}}," → "Hi [their first name, or “there”],".
 * Parsed with core's own merge-token parser (R-PAR-24); a text that does not parse is shown as it is.
 */
export function readableMergeFields(text: string): string {
  const p = parseMergeTokens(text);
  if (!p.ok) return text;
  let out = '';
  let at = 0;
  for (const t of p.tokens) {
    out += `${text.slice(at, t.start)}[${fieldWords(t.field)}${t.fallback ? `, or “${t.fallback}”` : ''}]`;
    at = t.end;
  }
  return out + text.slice(at);
}

export const TEMPLATE_ERROR_MESSAGES: Record<string, string> = {
  MERGE_FIELD_UNKNOWN: "That merge field isn't one we can fill in. Pick one from the list.",
  MERGE_FIELD_MALFORMED: 'A merge field is missing its closing }}.',
  MERGE_FIELD_FALLBACK_INVALID: 'A fallback must be plain text, up to 60 characters.',
  MERGE_FIELD_TOO_MANY: 'This template has too many merge fields.',
  MERGE_FIELD_ARCHIVED: 'That custom field was archived. Remove it from the template.',
  MERGE_FIELD_EMPTY: "This person is missing a value the template needs. Add a fallback, or write the message yourself.",
  TEMPLATE_NAME_INVALID: 'Give the template a name (up to 80 characters).',
  TEMPLATE_NAME_TAKEN: 'You already have a template with that name.',
  TEMPLATE_SUBJECT_REQUIRED: 'An email template needs a subject.',
  TEMPLATE_SUBJECT_NOT_ALLOWED: "Text templates don't have a subject.",
  TEMPLATE_SUBJECT_INVALID: 'The subject must be one line, up to 200 characters.',
  TEMPLATE_BODY_EMPTY: 'Write the message.',
  TEMPLATE_BODY_TOO_LONG: 'This message is too long (texts up to 1,600 characters).',
  TEMPLATE_BODY_INVALID: 'The message has characters that cannot be sent.',
  TEMPLATE_STALE: 'Someone changed this template while you were editing. Reopen it to see their version.',
  TEMPLATE_ARCHIVED: 'This template was archived.',
  SIGNATURE_INVALID: 'A signature is plain text, up to 1,000 characters.',
};
