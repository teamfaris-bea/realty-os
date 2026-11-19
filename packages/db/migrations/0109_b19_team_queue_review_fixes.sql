-- Batch 19, team-queue lane, review fixes (handoff visibility; findings M1 to M5 and L1 to L7 of the independent
-- review of draft pull request 15). DATA_MODEL R-TEAMQ-19 onward. Security notes: docs/ARCHITECTURE.md §21.74.
--
--   1. (M1, R-TEAMQ-20) lead_ownership_events.type gains 'sla_restored'. The waiver of a covered source's
--      auto-release (0107's `sla_waived`, which clears the stored release deadline) is re-evaluated, not one-shot:
--      when the source stops being covered, or the lead's own owner stops being an active member, the system writes
--      `sla_restored` with a NEW release deadline (payload.releaseDueAt) for the same ownership period, and the
--      ordinary `ownership.auto_release` timer decides at that time. contacts.release_due_at is set again by the
--      projection, so app.due_work (the sweeper) re-issues a lost timer as for any stored deadline. The ledger stays
--      append-only: no event is changed or removed, and no existing row has the new type.
--   No table, no SECURITY DEFINER function, no policy, no grant and no retention change in this part.

-- 1. the ledger's event types (0001's unnamed CHECK, found by its definition and replaced with the one more type)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.lead_ownership_events'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%sla_waived%' LOOP
    EXECUTE format('ALTER TABLE lead_ownership_events DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE lead_ownership_events ADD CONSTRAINT lead_ownership_events_type_check CHECK (type IN (
  'created','imported','offered','offer_accepted','offer_declined','offer_expired',
  'offer_rescinded','claimed','assigned','reassigned','released','sent_to_pond',
  'auto_released','reinquiry','first_touch_recorded','first_touch_breached','sla_waived','sla_restored',
  'inactivity_warned','inactivity_released','closed','reopened','merged_away','merged_in'));

-- Self-check: exactly one type check, and it admits both the waiver and its restoration.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.lead_ownership_events'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%sla_waived%' AND pg_get_constraintdef(oid) LIKE '%sla_restored%' AND convalidated) <> 1 THEN
    RAISE EXCEPTION '0109: lead_ownership_events needs one validated type check admitting sla_waived and sla_restored';
  END IF;
  IF EXISTS (SELECT 1 FROM lead_ownership_events WHERE type = 'sla_restored') THEN
    RAISE EXCEPTION '0109: no existing ledger event may have the new type';
  END IF;
END $$;
