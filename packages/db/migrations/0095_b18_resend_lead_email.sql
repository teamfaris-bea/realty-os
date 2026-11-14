-- Batch 18 item i (owner 2026-11-14: Resend preferred for inbound email, untested; PHASE2_3_PLAN N24): a lead email
-- received through Resend is stored as provider_format 'resend'. Security notes: docs/ARCHITECTURE.md §21.62.
--
--   apps/api/src/leadEmail/routes.ts POST /webhooks/lead-email/resend/inbound (Standard Webhooks / Svix signature,
--   providers/email/resend.ts) feeds the same pipeline as Postmark and SendGrid; formats.ts believes no DKIM verdict from
--   Resend, so every such email is held for review (DKIM trust unchanged, R-LEM-3). The only schema change: the CHECK
--   on lead_email_messages.provider_format gains 'resend'. It only widens; no row, function, policy, grant or trigger
--   changes (app.lead_email_messages_guard compares provider_format as a value and is unchanged).

ALTER TABLE lead_email_messages DROP CONSTRAINT lead_email_messages_provider_format_check;
ALTER TABLE lead_email_messages ADD CONSTRAINT lead_email_messages_provider_format_check
  CHECK (provider_format IN ('generic','postmark','sendgrid','resend'));
