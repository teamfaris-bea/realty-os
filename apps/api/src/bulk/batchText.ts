// The Owner's batch-text switch (parity module 63; R-PAR-40, Q-PAR-5, counsel item C-PAR-1).
//
// Off by default. Only the Owner turns it on, after re-authentication (core can(): settings.batch_text is
// 🔒 when "loosening") and a typed attestation, recorded in audit_log. Owner or Admin turn it off. The DB
// trigger refuses "on" by anyone but the Owner; the bulk guards re-read the switch at confirm and at every
// message, so turning it off stops a running batch (E185).
import type { UserActor } from '@realty/core/foundation';
import { type Database, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';

/** The sentence the Owner types to turn batch text on (case and surrounding spaces ignored). */
export const BATCH_TEXT_ATTESTATION = 'I have reviewed batch texting with counsel and accept responsibility';

/**
 * Shown on the settings page before the switch, verbatim. VERIFY WITH COUNSEL (C-PAR-1): this is a
 * plain-language placeholder written by the product team, not legal advice.
 */
export const BATCH_TEXT_COUNSEL_TEXT = [
  'Batch text sends one marketing text to up to 200 people at once. It is off until the Owner turns it on.',
  'Realty OS does not check consent before a text. It only blocks people who opted out (STOP, unsubscribe, do-not-contact) and suppressed numbers.',
  "Some state laws, for example Florida's Telephone Solicitation Act (FTSA) and Oklahoma's telephone solicitation act, regulate the automated selection or dialing of marketing texts, require prior express written consent, and limit the hours and how often you may text. Realty OS checks none of these.",
  'Talk to your counsel before you turn this on. You are responsible for who you text and when.',
].join('\n\n');

export function attestationMatches(s: string | undefined | null): boolean {
  return typeof s === 'string' && s.trim().replace(/\s+/g, ' ').toLowerCase() === BATCH_TEXT_ATTESTATION.toLowerCase();
}

export interface BatchTextView {
  enabled: boolean;
  counselText: string;
  attestation: string;
  maxRecipients: number;
}

export async function getBatchText(actor: UserActor, db: Database): Promise<BatchTextView> {
  return withTenantTx(actor, async (tx) => {
    const r = await sql<{ on: boolean }>`SELECT batch_text_enabled AS on FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
    return { enabled: r.rows[0]?.on === true, counselText: BATCH_TEXT_COUNSEL_TEXT, attestation: BATCH_TEXT_ATTESTATION, maxRecipients: 200 };
  }, { db });
}

/** PUT /settings/batch-text. The route has already run can() (re-auth + attestation when turning on). */
export async function setBatchText(actor: UserActor, enabled: boolean, attestation: string | undefined, db: Database): Promise<BatchTextView> {
  if (enabled && !attestationMatches(attestation)) throw new AppError('BATCH_TEXT_ATTESTATION_REQUIRED');
  await withTenantTx(actor, async (tx) => {
    const cur = await sql<{ on: boolean }>`SELECT batch_text_enabled AS on FROM tenant_settings WHERE tenant_id = app.tenant_id() FOR UPDATE`.execute(tx);
    const was = cur.rows[0]?.on === true;
    if (was === enabled) return;
    await sql`UPDATE tenant_settings SET batch_text_enabled = ${enabled} WHERE tenant_id = app.tenant_id()`.execute(tx);
    // the attestation is the Owner's typed sentence (fixed wording, no PII): it is the audit reason
    await audit(tx, actor, { action: 'settings.batch_text_changed', entity: { type: 'tenant_settings', id: actor.tenantId }, changes: redactDiff({ batchTextEnabled: was }, { batchTextEnabled: enabled }, { entity: 'tenant_settings' }), reason: enabled ? `ATTESTED: ${BATCH_TEXT_ATTESTATION}` : 'TURNED_OFF' });
  }, { db, retries: 2 });
  return getBatchText(actor, db);
}
