// Derived, idempotent ids of stage automation (PARITY_PLAN module 67). A re-run (a duplicate job delivery,
// a crash between the request path and the backup scan, a rerun of the annual scan) derives the same id and
// finds the row it already wrote instead of writing a second one.
//   - stageEnrollmentId(eventId): the enrollment a stage-entry event starts (at most one per event);
//   - annualTaskId(contactId, fieldId, occurrence): the reminder task of one person, field and occurrence
//     (the R-PAR-20 dedupe key: tasks have no dedupe column, so the key IS the primary key).
// RFC 9562 §5.5 UUIDv5 under a fixed namespace of this module (never change it: replays would duplicate).
import { uuidV5 } from '@realty/core/parity/bulk';

export const STAGE_AUTOMATION_NAMESPACE = '3b0e9c71-5d24-4a8f-b6c3-9f1e2d7a4c58';

export function stageEnrollmentId(stageEventId: string): string {
  return uuidV5(STAGE_AUTOMATION_NAMESPACE, `stage.enroll:${stageEventId.toLowerCase()}`);
}

/** `occurrence` is the local date (YYYY-MM-DD) of the next occurrence in the tenant's timezone. */
export function annualDedupeKey(contactId: string, fieldId: string, occurrence: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurrence)) throw new TypeError('annualDedupeKey: occurrence must be YYYY-MM-DD');
  return `annual:${contactId.toLowerCase()}:${fieldId.toLowerCase()}:${occurrence}`;
}

export function annualTaskId(contactId: string, fieldId: string, occurrence: string): string {
  return uuidV5(STAGE_AUTOMATION_NAMESPACE, annualDedupeKey(contactId, fieldId, occurrence));
}
