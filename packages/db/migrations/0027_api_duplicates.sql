-- =============================================================================
-- api/duplicates (PARITY_PLAN module 66): a merge moves the loser's parity child rows to the survivor
-- (R-PAR-45) and never loses an opt-out (D1, R-PAR-12, R-CHAN-2).
--
-- The file number is a placeholder: the orchestrator renumbers at merge. Nothing in code or tests names it.
--
-- Why a trigger: the merge is decided and written by the ownership engine (applyOwnershipCommand), which
-- sets contacts.merged_into_contact_id on the loser. This trigger fires on exactly that write, in the
-- engine's merge transaction, whoever the actor is (Owner/Admin inline, a Team Lead, the system). It is
-- the same shape as 0018's contacts_dnc_follow_merge (a person-level do-not-contact follows the merge).
--
-- What moves (loser -> survivor):
--   * contact_points are COPIED (R-PAR-11: a point's contact never changes): every phone/email/identity of
--     the loser, live or removed, with its status, removal time and removal reason. The dispatch guards'
--     "any of the contact's phones" fan-out (R-PAR-12) then sees a STOP on any of the loser's numbers when
--     the survivor is texted or called: a STOP on either person blocks the merged person. Consent,
--     suppressions and do-not-contact stay keyed by HMAC / follow the merge already.
--   * contact_tags (provenance kept; first one wins on the survivor), then removed from the loser.
--   * contact_field_values: the survivor's value wins when both are set; a loser value that cannot be
--     written (archived field or option) stays on the loser rather than aborting the merge.
--   * contact_relationships: re-pointed; self-pairs (the loser linked to the survivor) dropped; pairs deduped.
--   * notes: re-pointed (R-PAR-45 "notes move with the contact"); the only parent change notes_edit_guard
--     allows, and only to this definer for a merged pair.
--   * contact_stage_events are COPIED (append-only, R-PAR-15): the survivor's timeline shows the history.
--   * the pair's open contact_duplicate_candidates row is marked merged.
-- A tag the survivor cannot take (CONTACT_TAG_LIMIT, or a protected tag applied in bulk) stays on the loser;
-- nothing here ever aborts a merge.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4):
--   * new SECURITY DEFINER trigger function app.contacts_merge_children() (owner app_definer, pinned
--     search_path, EXECUTE revoked from PUBLIC). It acts only for a row whose merged_into_contact_id was just
--     set by the engine, only inside that row's tenant, and only between the two merged contacts. It writes
--     no opt-out state; it only adds points (which can only make the guards refuse MORE).
--   * app.notes_edit_guard() replaced verbatim except ONE condition: a note's contact may change only when
--     current_user is app_definer and the old contact is merged into the new one.
--   * grants to app_definer (least privilege for the above): INSERT on contact_points, contact_tags,
--     contact_field_values, contact_relationships; DELETE on contact_tags, contact_field_values,
--     contact_relationships; UPDATE on notes, contact_duplicate_candidates; SELECT on the parity tables read.
-- =============================================================================

CREATE FUNCTION app.contacts_merge_children() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  s uuid := NEW.merged_into_contact_id;
  l uuid := NEW.id;
  t uuid := NEW.tenant_id;
  r record;
BEGIN
  IF app.tenant_id() IS NOT NULL AND t IS DISTINCT FROM app.tenant_id() THEN RETURN NULL; END IF;
  IF s IS NULL OR s = l OR NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = t AND c.id = s) THEN
    RETURN NULL;
  END IF;

  -- 1. points: copy every point of the loser (live or removed) so opt-outs on them keep blocking (R-PAR-12)
  FOR r IN SELECT * FROM public.contact_points p WHERE p.tenant_id = t AND p.contact_id = l ORDER BY p.created_at, p.id LOOP
    BEGIN
      INSERT INTO public.contact_points (tenant_id, id, contact_id, kind, address, address_hmac, label, line_type, status,
                                         is_primary, timezone, created_at, removed_at, removed_reason, platform_window_until)
      VALUES (t, gen_random_uuid(), s, r.kind, r.address, r.address_hmac, r.label, r.line_type, r.status,
              r.is_primary AND r.removed_at IS NULL AND NOT EXISTS (
                SELECT 1 FROM public.contact_points x WHERE x.tenant_id = t AND x.contact_id = s AND x.kind = r.kind
                   AND x.is_primary AND x.removed_at IS NULL),
              r.timezone, r.created_at, r.removed_at, r.removed_reason, r.platform_window_until)
      ON CONFLICT (tenant_id, contact_id, kind, address) DO NOTHING;
    EXCEPTION WHEN check_violation OR unique_violation THEN
      -- cannot happen for a valid loser row; never abort the merge. The loser keeps the point, and the
      -- guards still find the address's own opt-outs through its HMAC.
      NULL;
    END;
  END LOOP;

  -- 2. tags: provenance kept; a tag already on the survivor is simply dropped from the loser
  FOR r IN SELECT * FROM public.contact_tags x WHERE x.tenant_id = t AND x.contact_id = l ORDER BY x.created_at, x.tag_id LOOP
    BEGIN
      INSERT INTO public.contact_tags (tenant_id, contact_id, tag_id, added_by_kind, added_by_user_id, import_batch_id, created_at)
      VALUES (t, s, r.tag_id, r.added_by_kind, r.added_by_user_id, r.import_batch_id, r.created_at)
      ON CONFLICT (tenant_id, contact_id, tag_id) DO NOTHING;
      DELETE FROM public.contact_tags x WHERE x.tenant_id = t AND x.contact_id = l AND x.tag_id = r.tag_id;
    EXCEPTION WHEN check_violation THEN
      NULL;   -- CONTACT_TAG_LIMIT / AUDIENCE_PROTECTED_PROXY: stays on the loser
    END;
  END LOOP;

  -- 3. custom values: the survivor's value wins; a loser value that cannot be written stays on the loser
  FOR r IN SELECT * FROM public.contact_field_values v WHERE v.tenant_id = t AND v.contact_id = l
            AND NOT EXISTS (SELECT 1 FROM public.contact_field_values sv WHERE sv.tenant_id = t AND sv.contact_id = s AND sv.field_id = v.field_id) LOOP
    BEGIN
      INSERT INTO public.contact_field_values (tenant_id, contact_id, field_id, value_text, value_number, value_date, value_options,
                                               updated_by_kind, updated_by_user_id, import_batch_id, created_at)
      VALUES (t, s, r.field_id, r.value_text, r.value_number, r.value_date, r.value_options,
              r.updated_by_kind, r.updated_by_user_id, r.import_batch_id, r.created_at);
      DELETE FROM public.contact_field_values v WHERE v.tenant_id = t AND v.contact_id = l AND v.field_id = r.field_id;
    EXCEPTION WHEN check_violation OR unique_violation THEN
      NULL;   -- CUSTOM_FIELD_ARCHIVED / CUSTOM_VALUE_OPTION: stays on the loser
    END;
  END LOOP;

  -- 4. relationships: re-pointed, self-pairs dropped, pairs deduped (R-PAR-45)
  FOR r IN SELECT * FROM public.contact_relationships x WHERE x.tenant_id = t AND (x.contact_id = l OR x.related_contact_id = l) LOOP
    BEGIN
      IF (CASE WHEN r.contact_id = l THEN s ELSE r.contact_id END) <> (CASE WHEN r.related_contact_id = l THEN s ELSE r.related_contact_id END) THEN
        INSERT INTO public.contact_relationships (tenant_id, id, contact_id, related_contact_id, kind, label, created_by_user_id, created_at)
        VALUES (t, gen_random_uuid(), CASE WHEN r.contact_id = l THEN s ELSE r.contact_id END,
                CASE WHEN r.related_contact_id = l THEN s ELSE r.related_contact_id END, r.kind, r.label, r.created_by_user_id, r.created_at)
        ON CONFLICT DO NOTHING;
      END IF;
      DELETE FROM public.contact_relationships x WHERE x.tenant_id = t AND x.id = r.id;
    EXCEPTION WHEN check_violation OR unique_violation THEN
      NULL;
    END;
  END LOOP;

  -- 5. notes follow the person (notes_edit_guard allows exactly this parent change)
  UPDATE public.notes n SET contact_id = s WHERE n.tenant_id = t AND n.contact_id = l;

  -- 6. stage history: append-only, so copied (once: a re-applied merge finds the copies already there)
  INSERT INTO public.contact_stage_events (tenant_id, id, contact_id, from_stage, to_stage, actor_kind, actor_user_id, occurred_at)
  SELECT t, gen_random_uuid(), s, e.from_stage, e.to_stage, e.actor_kind, e.actor_user_id, e.occurred_at
    FROM public.contact_stage_events e
   WHERE e.tenant_id = t AND e.contact_id = l
     AND NOT EXISTS (SELECT 1 FROM public.contact_stage_events x
                      WHERE x.tenant_id = t AND x.contact_id = s AND x.occurred_at = e.occurred_at
                        AND x.from_stage IS NOT DISTINCT FROM e.from_stage AND x.to_stage = e.to_stage
                        AND x.actor_kind = e.actor_kind AND x.actor_user_id IS NOT DISTINCT FROM e.actor_user_id);

  -- 7. the pair's open duplicate suggestion is resolved as merged
  UPDATE public.contact_duplicate_candidates d
     SET status = 'merged', decided_at = now(),
         decided_by_user_id = CASE WHEN COALESCE(current_setting('app.actor_kind', true), '') = 'user'
                                   THEN NULLIF(current_setting('app.user_id', true), '')::uuid END
   WHERE d.tenant_id = t AND d.status = 'open' AND d.contact_a_id = LEAST(s, l) AND d.contact_b_id = GREATEST(s, l);
  RETURN NULL;
END $$;
ALTER FUNCTION app.contacts_merge_children() OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.contacts_merge_children() FROM PUBLIC;
CREATE TRIGGER contacts_merge_children AFTER UPDATE OF merged_into_contact_id ON contacts
  FOR EACH ROW WHEN (OLD.merged_into_contact_id IS NULL AND NEW.merged_into_contact_id IS NOT NULL)
  EXECUTE FUNCTION app.contacts_merge_children();

-- notes_edit_guard: verbatim from the parity schema except the marked merge condition.
CREATE OR REPLACE FUNCTION app.notes_edit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.activity_at IS DISTINCT FROM OLD.activity_at
     OR NEW.activity_direction IS DISTINCT FROM OLD.activity_direction OR NEW.activity_outcome IS DISTINCT FROM OLD.activity_outcome THEN
    IF OLD.source IN ('import','call_summary') THEN
      RAISE EXCEPTION 'NOTE_READ_ONLY: imported notes and call summaries are not edited' USING ERRCODE = 'check_violation';
    END IF;
    IF app.actor_kind() <> 'user' OR OLD.author_user_id IS DISTINCT FROM app.user_id() THEN
      RAISE EXCEPTION 'NOTE_AUTHOR_ONLY: only the author edits a note' USING ERRCODE = 'check_violation';
    END IF;
    NEW.edited_at := now();
  END IF;
  IF NEW.source IS DISTINCT FROM OLD.source
     -- module 66 (R-PAR-45): a note follows its person into a merge, moved only by app.contacts_merge_children
     OR (NEW.contact_id IS DISTINCT FROM OLD.contact_id
         AND NOT (current_user = 'app_definer' AND OLD.contact_id IS NOT NULL AND NEW.contact_id IS NOT NULL
                  AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = OLD.tenant_id AND c.id = OLD.contact_id
                                 AND c.merged_into_contact_id = NEW.contact_id)))
     OR NEW.deal_id IS DISTINCT FROM OLD.deal_id OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
     OR NEW.activity_kind IS DISTINCT FROM OLD.activity_kind OR NEW.imported IS DISTINCT FROM OLD.imported THEN
    RAISE EXCEPTION 'NOTE_IMMUTABLE: a note keeps its parent, author and kind' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

GRANT SELECT ON contact_points, contact_tags, tags, contact_field_values, custom_field_defs, contact_relationships,
                notes, contact_stage_events, contact_duplicate_candidates, contacts TO app_definer;
GRANT INSERT ON contact_points, contact_tags, contact_field_values, contact_relationships TO app_definer;
GRANT DELETE ON contact_tags, contact_field_values, contact_relationships TO app_definer;
GRANT UPDATE ON notes, contact_duplicate_candidates TO app_definer;
