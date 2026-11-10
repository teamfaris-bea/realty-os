-- 0008 (BUILD_PLAN module 13, api/assistant): the event an enrollment hangs off.
--
-- No SECURITY DEFINER function, no new table, no policy change. Additive nullable columns only.
--
-- Playbook steps may be anchored to an event (core PlaybookStep.delay.anchor = 'event'): a booking
-- confirmation or reminder to an appointment's start, a post-closing step to the deal's closing, a
-- document chase to a task's due date. 0001 had no place to say WHICH event an enrollment belongs to,
-- so every event-anchored step would be skipped as EVENT_MISSING. The anchor is a reference only; the
-- event instant is read live at step time (a rescheduled appointment moves its reminder, a canceled
-- one stops the enrollment with stop_if event_canceled). Polymorphic, so no FK: a missing referent is
-- treated as EVENT_MISSING (visible skip), never as an error. The post-closing scan also uses the
-- deal anchor to enroll a contact at most once per closed deal.
ALTER TABLE playbook_enrollments
  ADD COLUMN anchor_kind text CHECK (anchor_kind IN ('deal','appointment','task')),
  ADD COLUMN anchor_id   uuid,
  ADD CONSTRAINT playbook_enrollments_anchor_shape CHECK ((anchor_kind IS NULL) = (anchor_id IS NULL));

CREATE INDEX enrollment_anchor_idx ON playbook_enrollments (tenant_id, anchor_kind, anchor_id) WHERE anchor_id IS NOT NULL;
