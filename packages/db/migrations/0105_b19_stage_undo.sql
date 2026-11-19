-- Batch 19, the stage flow: an undo of a stage change is marked on the stage event itself, and never starts a plan
-- (DATA_MODEL R-STG-5, E764, E765). Security notes: docs/ARCHITECTURE.md §21.72.
--
--   The Undo of a stage change was an ordinary stage change, so undoing a move away from a stage whose plan had ended
--   put the person back INTO that stage and started the plan again. An undo now starts nothing: its stage event says
--   which event it undoes, and the stage-entry decision skips such an event with the reason `undo`.
--
--   Why the mark is on the event, written in the same transaction as the stage change: the decision is made after the
--   change commits, by the request path or, if that fails, by the worker's backup scan a minute later. A mark the
--   request only carried in memory would be lost in exactly that case, and the scan would start the plan the undo
--   must not start. contact_stage_events is append-only and written only by its definer trigger, so the definer is
--   the one place the mark can be written.
--
--   * contact_stage_events.undo_of_event_id (uuid, NULL: an ordinary stage change). No foreign key, as bulk_action_id
--     (0041): the history is append-only and the definer stores only an id it has just checked.
--   * app.contacts_stage_history() (SECURITY DEFINER trigger, owner app_definer, pinned search_path; replaced: 0041's
--     statement verbatim except the marked 0105 lines). The API names the event being undone in the transaction-local
--     setting app.stage_undo_of (apps/api people/contacts.ts, after refusing a forged one with STAGE_UNDO_INVALID). The
--     definer keeps it ONLY when all of these hold, else it stores NULL and the change is an ordinary one:
--       - a user is making the change (never the system, an import or support);
--       - the value is a uuid naming a stage event of THIS contact in THIS tenant (the lookup is by tenant_id and
--         contact_id of the row being updated, so another person's or another tenant's event never matches);
--       - that event is the contact's MOST RECENT stage event; and
--       - the change really reverses it: it goes from the event's to_stage back to its from_stage.
--     So the mark cannot be forged onto an arbitrary stage change by setting the variable: at most a true reversal of
--     the latest change is called an undo, which is what it is. The mark only ever makes a plan NOT start. It grants
--     nothing: who may change the stage (RLS, app.contacts_stage_guard) is unchanged, and the definer reads only the
--     history of the row it is already writing for.
--   * stage_automation_decisions.reason gains 'undo' (the closed set of apps/api stageAutomation/decide.ts SKIP_REASONS).
--   No new table, policy, grant or definer.
--
--   EXISTING DATA. Every existing stage event has no mark (NULL): nothing already decided changes, and no decision
--   row is rewritten.

ALTER TABLE contact_stage_events ADD COLUMN undo_of_event_id uuid;
COMMENT ON COLUMN contact_stage_events.undo_of_event_id IS
  'b19 0105: the stage event this change undoes (NULL: an ordinary change). Written only by app.contacts_stage_history, and only for a user''s true reversal of the contact''s most recent stage event. A stage entry marked as an undo never starts a plan (R-STG-5).';

-- 0041's statement, verbatim except the marked 0105 lines.
CREATE OR REPLACE FUNCTION app.contacts_stage_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE ak text := COALESCE(NULLIF(current_setting('app.actor_kind', true), ''), 'none');
  uid uuid; bulk text := NULLIF(current_setting('app.bulk_action_id', true), ''); bid uuid;   -- 0041
  undo text := NULLIF(current_setting('app.stage_undo_of', true), ''); uoid uuid;   -- 0105
BEGIN
  IF ak NOT IN ('user','system','support') THEN ak := 'none'; END IF;
  uid := CASE WHEN ak = 'user' THEN NULLIF(current_setting('app.user_id', true), '')::uuid END;   -- 0041 (as 0021's VALUES)
  -- 0041: the bulk runner names its action (app.bulk_action_id); kept only for a running stage action of this tenant
  -- created by the user making this change, else NULL
  IF uid IS NOT NULL AND bulk ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT b.id INTO bid FROM public.bulk_actions b
     WHERE b.tenant_id = NEW.tenant_id AND b.id = bulk::uuid AND b.kind = 'stage' AND b.status = 'running'
       AND b.created_by_user_id = uid;
  END IF;
  -- 0105: the API names the stage event this change undoes (app.stage_undo_of); kept only when a user is making the
  -- change, the event is this contact's most recent stage event, and this change reverses it; else NULL
  IF uid IS NOT NULL AND undo ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT l.id INTO uoid
      FROM (SELECT e.id, e.from_stage, e.to_stage FROM public.contact_stage_events e
             WHERE e.tenant_id = NEW.tenant_id AND e.contact_id = NEW.id
             ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1) l
     WHERE l.id = undo::uuid AND l.to_stage = OLD.stage AND l.from_stage = NEW.stage;
  END IF;
  INSERT INTO public.contact_stage_events (tenant_id, id, contact_id, from_stage, to_stage, actor_kind, actor_user_id, bulk_action_id, undo_of_event_id)   -- 0041: bulk_action_id; 0105: undo_of_event_id
  VALUES (NEW.tenant_id, gen_random_uuid(), NEW.id, OLD.stage, NEW.stage, ak, uid, bid, uoid);
  RETURN NULL;
END $$;
ALTER FUNCTION app.contacts_stage_history() OWNER TO app_definer;

-- the closed set of skip reasons (apps/api/src/stageAutomation/decide.ts SKIP_REASONS), plus undo
ALTER TABLE stage_automation_decisions DROP CONSTRAINT stage_automation_decisions_reason_check;
ALTER TABLE stage_automation_decisions ADD CONSTRAINT stage_automation_decisions_reason_check
  CHECK (reason IN ('not_a_person_change','person_removed','stage_changed_again','not_visible',
                    'plan_not_approved','already_in_a_plan','cannot_be_reached','protected_audience','ai_isa_active',
                    'source_no_automated_contact','source_unclassified','undo'));

-- Self-check: the replaced definer keeps its reviewed owner, SECURITY DEFINER and pinned search_path, and is still the
-- function of the history trigger; the history table still forces row-level security.
DO $$
DECLARE p record;
BEGIN
  SELECT r.rolname AS owner, x.prosecdef AS definer, x.proconfig AS config INTO p
    FROM pg_proc x JOIN pg_roles r ON r.oid = x.proowner WHERE x.oid = 'app.contacts_stage_history()'::regprocedure;
  IF p.owner <> 'app_definer' OR NOT p.definer OR p.config IS DISTINCT FROM ARRAY['search_path=pg_catalog, public'] THEN
    RAISE EXCEPTION '0105: app.contacts_stage_history() must be a definer owned by app_definer with a pinned search_path';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.contacts'::regclass AND t.tgname = 'contacts_stage_history'
                    AND t.tgfoid = 'app.contacts_stage_history()'::regprocedure AND t.tgenabled <> 'D' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION '0105: the contacts_stage_history trigger must still call app.contacts_stage_history()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.contact_stage_events'::regclass AND c.relrowsecurity AND c.relforcerowsecurity) THEN
    RAISE EXCEPTION '0105: contact_stage_events must force row-level security';
  END IF;
END $$;
