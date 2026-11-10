-- 0002 (BUILD_PLAN module 7, db/client): app.ownership_head
--
-- SECURITY REVIEW ITEM (CONVENTIONS §4): one new SECURITY DEFINER read.
--
-- Why: applyOwnershipCommand takes app.lock_contact and then reads the projection under the caller's
-- RLS. The loser of a claim race (E1) or a decliner whose offer was re-routed can no longer SEE the
-- contact once the winner commits, so the read returns nothing and the command could only be
-- rejected as NOT_FOUND. R-OWN-5 requires the loser to get LEAD_ALREADY_CLAIMED, and the rejection
-- log records the ledger head the command observed (ownership_command_rejections.observed_seq).
--
-- What it returns: for ONE contact id in the caller's tenant, only the ownership state and the ledger
-- head seq. No owner, no pond, no names, no contact points. Callers must be active members
-- (app.is_member()); without tenant context it returns no rows.
--
-- It is NOT an existence oracle (R-PERM-5, E52): a user gets a row only for a contact they had a
-- legitimate sight of before it moved on: a ledger event names them (actor, owner, previous owner,
-- offeree), or the contact sat in a pond they may claim from (the pond card they raced for, E1).
-- For any other id the caller gets nothing, exactly as for an id that does not exist, so the command
-- is rejected NOT_FOUND (404) either way. Tenant-wide callers see every row anyway.
CREATE FUNCTION app.ownership_head(p_contact_id uuid)
RETURNS TABLE (ownership_state text, ownership_seq bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.ownership_state, c.ownership_seq
    FROM public.contacts c
   WHERE c.tenant_id = app.tenant_id() AND c.id = p_contact_id AND app.is_member()
     AND (app.is_tenant_wide()
          OR EXISTS (SELECT 1 FROM public.lead_ownership_events e
                      WHERE e.tenant_id = c.tenant_id AND e.contact_id = c.id
                        AND (e.actor_user_id = app.user_id() OR e.owner_user_id = app.user_id()
                             OR e.prev_owner_user_id = app.user_id() OR e.offered_to_user_id = app.user_id()
                             OR (e.to_state = 'in_pond' AND e.pond_id = ANY (app.my_pond_ids())))))
$$;
ALTER FUNCTION app.ownership_head(uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.ownership_head(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ownership_head(uuid) TO app_user;

-- SECURITY REVIEW ITEM: app.ownership_command_events
--
-- Why: R-OWN-7 says a replayed command returns its STORED outcome. The ledger SELECT policy needs
-- contact detail visibility, which the actor of a decline / handoff / release loses once a later
-- command moves the contact on (R-PERM-7), so the actor could no longer read back the events of
-- their own command, and the replay would be re-decided instead of returning what was stored.
--
-- What it returns: the ledger rows written by ONE command id, only to the user who issued it
-- (actor_kind 'user' and actor_user_id = app.user_id() in a user context) or to a tenant-wide
-- caller (system, Owner/Admin). Ledger rows hold ids, codes and instants only (no PII).
CREATE FUNCTION app.ownership_command_events(p_command_id uuid)
RETURNS SETOF public.lead_ownership_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT e.* FROM public.lead_ownership_events e
   WHERE e.tenant_id = app.tenant_id() AND e.command_id = p_command_id AND app.is_member()
     AND (app.is_tenant_wide()
          OR (app.actor_kind() = 'user' AND e.actor_kind = 'user' AND e.actor_user_id = app.user_id()))
   ORDER BY e.contact_id, e.seq
$$;
ALTER FUNCTION app.ownership_command_events(uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.ownership_command_events(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ownership_command_events(uuid) TO app_user;
