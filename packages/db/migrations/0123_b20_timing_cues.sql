-- Batch 20, timing-cue lane: what the nightly scan read in each note about WHEN a person plans to buy, sell or move.
-- DATA_MODEL R-TCUE-1 to R-TCUE-8. Security notes: docs/ARCHITECTURE.md §21.91.
--
--   * timing_cues: ONE row per note the scan has read (timing_cues_note_once is what makes the job idempotent on the
--     note), written by the system actor of the tenant only:
--       note_id, note_updated_at      which note, and its updated_at when it was read: an edited note is read again
--                                     (the row is replaced only by a read of a newer version)
--       written_at                    when the words were written (the note's activity time, else its creation): the
--                                     move window is computed from this day, never from the day of the scan
--       outcome                       no_timing | boilerplate | reminder_only (the prefilter: no model call) | no_cue |
--                                     rental (the team does no rentals) | unverified (no quote was in the note word for
--                                     word) | low_confidence | no_window | model_error | cue
--       evidence, intent, timeframe, cue_snippet, window_*, confidence   only on a `cue` row: who said it, buy / sell /
--                                     both / unknown, the stated bucket, the verbatim quote (at most 300 characters,
--                                     verified against the note), the projected window and how it was found
--       model, prompt_version         which local model and prompt read it
--     No name, number, address or other note text is copied: the quote is a few words of the note itself, and a row
--     is readable only by whoever can read that note (its own policy: the person's detail) and the tenant-wide.
--     FORCE row-level security, the restrictive tenant policy, the three support read-only policies and the statement
--     trigger. Insert and update: the system actor only. No DELETE grant: a row leaves only with its note (ON DELETE
--     CASCADE: a deleted note, an erased or purged person).
--   Nothing is sent, no task, stage, owner or tag is written, and no existing row is changed. The call list is
--   computed when it is read (LIVE / PAST_WINDOW / STALE against today), so nothing here goes stale.

CREATE TABLE timing_cues (
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  id                uuid NOT NULL,
  note_id           uuid NOT NULL,
  note_updated_at   timestamptz NOT NULL,
  written_at        timestamptz NOT NULL,
  scanned_at        timestamptz NOT NULL,
  outcome           text NOT NULL CHECK (outcome IN ('no_timing','boilerplate','reminder_only','no_cue','rental','unverified','low_confidence','no_window','model_error','cue')),
  evidence          text CHECK (evidence IN ('client_stated','form','agent_logged')),
  intent            text CHECK (intent IN ('buy','sell','both','unknown')),
  timeframe         text CHECK (timeframe IN ('0-3mo','3-6mo','6-12mo','12+mo','unknown')),
  cue_snippet       text CHECK (char_length(cue_snippet) BETWEEN 1 AND 300),
  window_start      date,
  window_end        date,
  window_precision  text CHECK (window_precision IN ('month','season','year','range')),
  window_basis      text CHECK (window_basis IN ('stated','timeframe')),
  window_label      text CHECK (char_length(window_label) BETWEEN 1 AND 40),
  confidence        numeric(3,2) CHECK (confidence >= 0 AND confidence <= 1),
  model             text CHECK (char_length(model) <= 80),
  prompt_version    text CHECK (char_length(prompt_version) <= 40),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT timing_cues_note_once UNIQUE (tenant_id, note_id),
  FOREIGN KEY (tenant_id, note_id) REFERENCES notes (tenant_id, id) ON DELETE CASCADE,
  -- a cue row carries every cue field; any other outcome carries none of them
  CONSTRAINT timing_cues_cue_fields CHECK (
    (outcome = 'cue') = (evidence IS NOT NULL AND intent IS NOT NULL AND timeframe IS NOT NULL AND cue_snippet IS NOT NULL AND window_start IS NOT NULL
                         AND window_end IS NOT NULL AND window_precision IS NOT NULL AND window_basis IS NOT NULL AND window_label IS NOT NULL AND confidence IS NOT NULL)
    AND (outcome = 'cue' OR (evidence IS NULL AND intent IS NULL AND timeframe IS NULL AND cue_snippet IS NULL AND window_start IS NULL AND window_end IS NULL
                             AND window_precision IS NULL AND window_basis IS NULL AND window_label IS NULL AND confidence IS NULL))),
  CHECK (window_end >= window_start)
);
CREATE INDEX timing_cues_cue_idx ON timing_cues (tenant_id, written_at DESC) WHERE outcome = 'cue';
COMMENT ON TABLE timing_cues IS
  'b20 (R-TCUE-1..8): one row per note the nightly timing scan read (local model only): the outcome, and on a cue the verified quote, buy/sell intent and the move window computed from the day the words were written. Written by the system only; readable by whoever can read the note.';

ALTER TABLE timing_cues ENABLE ROW LEVEL SECURITY;
ALTER TABLE timing_cues FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timing_cues AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff');
CREATE POLICY support_read_only_ins ON timing_cues AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_upd ON timing_cues AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_del ON timing_cues AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support');
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON timing_cues FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();
-- read: the tenant-wide, and whoever can read the row's note (the note's own policy: the person's detail, never a pond card)
CREATE POLICY timing_cues_select ON timing_cues FOR SELECT USING (
  (SELECT app.is_tenant_wide())
  OR EXISTS (SELECT 1 FROM notes n WHERE n.tenant_id = timing_cues.tenant_id AND n.id = timing_cues.note_id));
-- written by the nightly scan only (the system actor of the tenant)
CREATE POLICY timing_cues_insert ON timing_cues FOR INSERT WITH CHECK ((SELECT app.actor_kind()) = 'system');
CREATE POLICY timing_cues_update ON timing_cues FOR UPDATE USING ((SELECT app.actor_kind()) = 'system') WITH CHECK ((SELECT app.actor_kind()) = 'system');
GRANT SELECT, INSERT, UPDATE ON timing_cues TO app_user;

-- Self-check: the table forces row-level security with the restrictive tenant policy, the support read-only trigger and
-- policies; app_user can neither delete nor truncate a row.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.timing_cues'::regclass AND c.relrowsecurity AND c.relforcerowsecurity) THEN
    RAISE EXCEPTION '0123: timing_cues must force row-level security';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.timing_cues'::regclass AND polname = 'tenant_isolation' AND NOT polpermissive) THEN
    RAISE EXCEPTION '0123: timing_cues needs the restrictive tenant policy';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.timing_cues'::regclass AND polname LIKE 'support_read_only_%' AND NOT polpermissive) <> 3
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.timing_cues'::regclass AND tgname = 'support_read_only' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION '0123: timing_cues needs the support read-only policies and trigger';
  END IF;
  IF has_table_privilege('app_user', 'public.timing_cues', 'DELETE') OR has_table_privilege('app_user', 'public.timing_cues', 'TRUNCATE') THEN
    RAISE EXCEPTION '0123: app_user must not delete timing_cues rows';
  END IF;
END $$;
