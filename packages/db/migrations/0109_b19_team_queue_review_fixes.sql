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
--   2. (M2, R-TEAMQ-21) lead_backup_alerts: a waiting lead from a covered source always tells someone other than the
--      person already holding it. recipient gains 'admins' (the team's Owners and Admins, alerted when there is no
--      team lead to tell); fallback_reason says why it was not the named backup ('backup_unavailable', or
--      'backup_is_holder': the backup is the person holding the lead); alerted_count is how many members were alerted
--      (alerted_user_id stays the one member for 'backup' and 'team_lead', and is the first of them for 'admins':
--      each alerted member has their own notification row, keyed on the inquiry). Codes and a number only.
--   No table, no SECURITY DEFINER function, no policy, no grant and no retention change: the new columns are read
--   and written under lead_backup_alerts' existing policies and grants (SELECT, INSERT; never UPDATE or DELETE).

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

-- 2. who was alerted, and why it was not the backup
ALTER TABLE lead_backup_alerts DROP CONSTRAINT lead_backup_alerts_recipient_check;
ALTER TABLE lead_backup_alerts ADD CONSTRAINT lead_backup_alerts_recipient_check CHECK (recipient IN ('backup','team_lead','admins'));
ALTER TABLE lead_backup_alerts ADD COLUMN fallback_reason text CHECK (fallback_reason IN ('backup_unavailable','backup_is_holder'));
ALTER TABLE lead_backup_alerts ADD COLUMN alerted_count integer NOT NULL DEFAULT 0 CHECK (alerted_count >= 0);
UPDATE lead_backup_alerts SET alerted_count = 1 WHERE outcome = 'alerted';
UPDATE lead_backup_alerts SET fallback_reason = 'backup_unavailable' WHERE recipient = 'team_lead';
ALTER TABLE lead_backup_alerts ADD CONSTRAINT lead_backup_alerts_count_matches CHECK ((outcome = 'alerted') = (alerted_count >= 1));
ALTER TABLE lead_backup_alerts ADD CONSTRAINT lead_backup_alerts_reason_matches CHECK ((fallback_reason IS NOT NULL) = (recipient IN ('team_lead','admins')));
ALTER TABLE lead_backup_alerts ADD CONSTRAINT lead_backup_alerts_one_unless_admins CHECK (recipient = 'admins' OR alerted_count <= 1);
COMMENT ON COLUMN lead_backup_alerts.fallback_reason IS 'b19 R-TEAMQ-21: why someone other than the source''s named backup was alerted: backup_unavailable, or backup_is_holder (the backup is the person holding the lead). Null when the backup was alerted or nobody was.';
COMMENT ON COLUMN lead_backup_alerts.alerted_count IS 'b19 R-TEAMQ-21: how many members were alerted (several only for recipient admins: the team''s Owners and Admins). 0 unless outcome is alerted.';

-- Self-check: the recipient check admits admins; app_user still can neither change nor delete a row.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.lead_backup_alerts'::regclass AND conname = 'lead_backup_alerts_recipient_check'
                   AND pg_get_constraintdef(oid) LIKE '%admins%') THEN
    RAISE EXCEPTION '0109: lead_backup_alerts.recipient must admit admins';
  END IF;
  IF has_table_privilege('app_user', 'public.lead_backup_alerts', 'UPDATE') OR has_table_privilege('app_user', 'public.lead_backup_alerts', 'DELETE') THEN
    RAISE EXCEPTION '0109: app_user must not change or delete lead_backup_alerts rows';
  END IF;
END $$;
