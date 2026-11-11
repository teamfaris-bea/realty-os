// Zod request/response schemas of the templates routes (parity module 63). No tenant_id anywhere (R-TEN-3);
// no confidence fields (R-AST-13).
import { z } from 'zod';

export const Channel = z.enum(['sms', 'email']);

export const TemplateSchema = z.object({
  id: z.uuid(),
  scope: z.enum(['team', 'personal']),
  mine: z.boolean(),
  channel: Channel,
  name: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  version: z.number().int(),
  mergeFields: z.array(z.string()),
  archived: z.boolean(),
  editable: z.boolean(),
  updatedAt: z.string(),
});

export const TemplateResponse = z.object({ template: TemplateSchema });
export const TemplatesResponse = z.object({ templates: z.array(TemplateSchema) });

export const ListQuery = z.strictObject({
  channel: Channel.optional(),
  includeArchived: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

export const CreateBody = z.strictObject({
  scope: z.enum(['team', 'personal']),
  channel: Channel,
  name: z.string().min(1).max(200),
  subject: z.string().max(400).nullable().optional(),
  body: z.string().min(1).max(25_000),
});

export const PatchBody = z.strictObject({
  version: z.number().int().min(1),
  name: z.string().min(1).max(200).optional(),
  subject: z.string().max(400).nullable().optional(),
  body: z.string().min(1).max(25_000).optional(),
});

export const RenderBody = z.strictObject({ contactId: z.uuid() });

export const RenderResponse = z.object({
  rendered: z.object({
    templateId: z.uuid(),
    version: z.number().int(),
    channel: Channel,
    subject: z.string().nullable(),
    body: z.string(),
    preview: z.string(),
    missing: z.array(z.string()),
  }),
});

export const SignatureBody = z.strictObject({ signature: z.string().max(2000).nullable() });
export const SignatureResponse = z.object({ signature: z.string().nullable() });

/** Every response schema (snapshot-tested: no tenant ids, no confidence). */
export const RESPONSE_SCHEMAS = { TemplateResponse, TemplatesResponse, RenderResponse, SignatureResponse };
