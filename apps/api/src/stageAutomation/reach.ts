// Can a playbook version reach this person? (PARITY_PLAN module 67; R-PAR-16, R-PAR-12, D1.)
//
// The one reachability rule of every enrollment a person starts: a stage entry (reconcile.ts, decide.ts skip
// reason cannot_be_reached) and a direct enrollment (assistant/enrollments.ts enrollContact, POST
// /contacts/:id/enrollments, refused as CANNOT_BE_REACHED). Moved here from reconcile.ts unchanged, so both import
// the same function without an import cycle (reconcile.ts imports assistant/enrollments.ts for enqueueStep). Runs
// in the caller's transaction, under the caller's RLS: the system actor for a stage entry, the person enrolling for
// a direct one; both see the person's points and opt-outs (a do-not-contact of a merged duplicate is on the
// survivor's own row, E140). Nothing here is the send-time gate: dispatch still decides every message.
import { type Channel, type ConsentStateRow, canContact } from '@realty/core/compliance';
import { type PlaybookStep, PlaybookStepSchema } from '@realty/core/assistant';
import type { Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { buildGateInput } from '../comms/gateInput.js';
import * as g from '../comms/repos/gate.js';
import { type ChannelReach, reachableOn } from './decide.js';
import * as R from './repos.js';

/** R-PAR-12: opt-out rows of the person's REMOVED phones (a confirmed wrong number excepted), for texts. */
async function removedPhoneConsent(tx: Tx, contactId: string, channel: Channel): Promise<ConsentStateRow[]> {
  if (channel !== 'sms') return [];
  const r = await sql<{ h: Buffer }>`
    SELECT address_hmac AS h FROM contact_points
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND kind = 'phone' AND removed_at IS NOT NULL
       AND removed_reason IS DISTINCT FROM 'wrong_number'`.execute(tx);
  return g.consentRows(tx, 'sms', r.rows.map((x) => x.h.toString('hex')));
}

function messagingSteps(raw: unknown): PlaybookStep[] {
  if (!Array.isArray(raw)) return [];
  const out: PlaybookStep[] = [];
  for (const s of raw) {
    const p = PlaybookStepSchema.safeParse(s);
    if (p.success && (p.data.channel === 'sms' || p.data.channel === 'email')) out.push(p.data);
  }
  return out;
}

/** The point compose would message on this channel (comms/compose pickPoint: the primary active one first). */
function pointFor(points: readonly g.PointRow[], channel: 'sms' | 'email'): g.PointRow | null {
  const kind = channel === 'email' ? 'email' : 'phone';
  return points.find((p) => p.kind === kind && p.status === 'active') ?? points.find((p) => p.kind === kind) ?? null;
}

/**
 * D1: can the person be reached on some channel the version messages on? core canContact on the same gate
 * input dispatch builds, plus the removed phones' opt-outs (R-PAR-12; core may deny more than the DB
 * guard, never less). Only opt-out reasons count here (decide.ts OPT_OUT_REASONS). A version with no text or
 * email step is reachable (decide.ts reachableOn: it sends nothing).
 */
export async function reachableForVersion(tx: Tx, contactId: string, versionId: string, now: Instant): Promise<boolean> {
  const steps = messagingSteps(await R.versionSteps(tx, versionId));
  const seen = new Set<string>();
  const points = await g.contactPoints(tx, contactId);
  const reach: ChannelReach[] = [];
  for (const s of steps) {
    const ch = s.channel as 'sms' | 'email';
    const key = `${ch}:${s.purpose}:${s.category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const point = pointFor(points, ch);
    if (!point) {
      reach.push({ hasAddress: false, reasons: [] });
      continue;
    }
    const gate = await buildGateInput(tx, {
      contactId,
      recipient: { kind: 'contact', addressHmac: point.hmac, channel: ch, pointId: point.id },
      purpose: s.purpose,
      initiator: 'assistant',
      category: s.category,
      sender: { phoneNumberId: null, emailIdentityId: null },
      body: null,
    }, now);
    const extra = await removedPhoneConsent(tx, contactId, ch);
    const d = canContact({ ...gate, consent: [...gate.consent, ...extra] });
    reach.push({ hasAddress: true, reasons: d.reasons });
  }
  return reachableOn(reach);
}
