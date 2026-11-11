-- =============================================================================
-- Pond leads reach the members who may claim them (journey bug: Agents and Team Leads never saw a pond lead in
-- the web app; workspace/repos/feedInputs.ts built the Priority Feed with `pondLeads: []`).
--
-- A pond lead now reaches exactly the members allowed to claim it (R-OWN-16), on Home and on the Pond page,
-- each member under their own RLS:
--   * the pond: an active member whose role is one of the pond's eligible roles, of a pond that is open to all or
--     names them, not archived (app.my_pond_ids(), the contacts policy's own "in a pond I may claim"), and a pond
--     that allows claims at all (claims_per_day > 0);
--   * the lead: not while the member is in claim cooldown for it (they released or lost it within the pond's
--     claim_cooldown_hours, app.claim_stats' own rule);
--   * the member's own totals (claims today against the pond's claims_per_day, uncontacted leads against the
--     capacity cap) are read when the feed is read (workspace/feed.ts readFeed), never stored.
-- The feed card is the core scorer's "New in the pond" card (pond_new, 24 h from the event that put the lead in
-- the pond); a lead an import put in a pond gets no card (it is not new), and stays on the Pond page.
--
--   1. app.my_pond_leads(p_since, p_contact_ids): for the CALLER, the pond leads they may claim, each with the
--      ledger event that put it in its pond (seq, instant, whether an import did) and the end of the caller's own
--      claim cooldown on it. A pond card's viewer cannot read the lead's ledger (R-PERM-6: its history stays
--      hidden; lead_ownership_events needs contact detail), so this definer reads exactly those facts and nothing
--      else: ids, one seq, two instants and a flag, never a name, an address or another member's id.
--   2. Feed marks (SECURITY INVOKER, as feed_incremental requires): a lead that enters, leaves or re-enters a pond
--      marks every member who may claim from that pond (the old and the new one), so each member's incremental
--      feed re-scores it; a contact created straight into a pond (an intake with no rule match) marks them too; a
--      change of who may claim from a pond (its eligible roles, open-to-all, archive, whether it allows claims, its
--      cooldown) or of its member list marks the affected members for a whole-book recompute.
--   3. An index for the read path's per-member totals (the open pond cards of one member).
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4; docs/SECURITY.md §6.1):
--   * ONE new SECURITY DEFINER function, app.my_pond_leads: owner app_definer, search_path pinned to
--     pg_catalog, public, STABLE, EXECUTE revoked from PUBLIC and granted to app_user only. It filters
--     tenant_id = app.tenant_id() explicitly and returns rows only for the calling user's own claimable ponds
--     (app.my_pond_ids(): an active membership with an eligible role; nobody else, not the system actor, an
--     Owner/Admin, a TC or a support actor, gets a row). Every contact it returns is one the caller already sees
--     as a pond card under the contacts policy. It reveals, per such lead: when it entered its pond (the pond
--     card's "New in the pond 2 h ago"), the ledger seq of that event (the card's per-occurrence key, never
--     serialized by the API), whether an import put it there, and when the CALLER's own cooldown on it ends (the
--     caller's own release or loss; POST /leads/:id/claim already answers CLAIM_COOLDOWN for it).
--   * No policy changes. The marking functions stay SECURITY INVOKER; their lookups (memberships, ponds,
--     pond_members: every member reads them) run under the writer's RLS, and a mark only causes a re-score of the
--     marked member's own data under that member's own RLS.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The caller's claimable pond leads
-- -----------------------------------------------------------------------------
-- p_since:       only leads that entered their pond at or after this instant (the feed's 24 h window); NULL: any
-- p_contact_ids: only these contacts (the incremental feed's dirty groups, a Pond page's cards); NULL: every
--                lead that entered a pond since p_since. With both NULL nothing is returned (never a whole-pond scan).
CREATE FUNCTION app.my_pond_leads(p_since timestamptz, p_contact_ids uuid[])
RETURNS TABLE (contact_id uuid, pond_id uuid, entered_seq bigint, entered_at timestamptz, entered_by_import boolean, cooldown_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH me AS (
    SELECT app.user_id() AS uid, app.my_pond_ids() AS ponds
  ), cand AS (
    -- recent pond entries (loe_type_time_idx), or the contacts asked about
    SELECT DISTINCT e.contact_id FROM public.lead_ownership_events e
     WHERE p_contact_ids IS NULL AND p_since IS NOT NULL AND e.tenant_id = app.tenant_id()
       AND e.type = ANY (ARRAY['sent_to_pond','released','auto_released','inactivity_released','imported'])
       AND e.occurred_at >= p_since
    UNION
    SELECT x.id FROM unnest(p_contact_ids) AS x(id) WHERE p_contact_ids IS NOT NULL
  )
  SELECT c.id, c.pond_id, en.seq, en.occurred_at, en.actor_kind = 'import',
         -- the caller's own claim cooldown on this lead (app.claim_stats: released or lost it within the pond's hours)
         (SELECT max(x.occurred_at) FROM public.lead_ownership_events x
           WHERE x.tenant_id = c.tenant_id AND x.contact_id = c.id AND x.prev_owner_user_id = me.uid
             AND x.type IN ('released','auto_released','inactivity_released','reassigned','sent_to_pond'))
           + make_interval(hours => p.claim_cooldown_hours)
    FROM cand
    CROSS JOIN me
    JOIN public.contacts c ON c.tenant_id = app.tenant_id() AND c.id = cand.contact_id
    JOIN public.ponds p ON p.tenant_id = c.tenant_id AND p.id = c.pond_id
    -- the event that put it in its pond: the latest one into in_pond from another state (a re-inquiry that keeps
    -- it in the pond, or a merge into it, is not a new entry)
    CROSS JOIN LATERAL (
      SELECT e.seq, e.occurred_at, e.actor_kind FROM public.lead_ownership_events e
       WHERE e.tenant_id = c.tenant_id AND e.contact_id = c.id AND e.to_state = 'in_pond' AND e.from_state IS DISTINCT FROM 'in_pond'
       ORDER BY e.seq DESC LIMIT 1) en
   WHERE me.uid IS NOT NULL
     AND c.ownership_state = 'in_pond' AND c.deleted_at IS NULL
     AND c.pond_id = ANY (me.ponds) AND p.archived_at IS NULL AND p.claims_per_day > 0
     AND (p_since IS NULL OR en.occurred_at >= p_since)
$$;
ALTER FUNCTION app.my_pond_leads(timestamptz, uuid[]) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.my_pond_leads(timestamptz, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_pond_leads(timestamptz, uuid[]) TO app_user;

-- -----------------------------------------------------------------------------
-- 2. Feed marks
-- -----------------------------------------------------------------------------
-- contacts: 0035's marks (the old and the new owner and offeree; everyone holding a task, appointment or assistant
-- action card on a contact whose ownership or visibility changed), plus every member who may claim from the pond a
-- lead entered, left or re-entered (its ledger head moved while either side is in a pond: a re-route back into a
-- pond is a new entry, a new card key).
CREATE OR REPLACE FUNCTION app.feed_mark_contacts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT n.tenant_id, u.user_id, 'c:' || n.id
      FROM new_rows n CROSS JOIN LATERAL (VALUES (n.owner_user_id), (n.offered_to_user_id)) u(user_id)
     WHERE u.user_id IS NOT NULL;
    -- created straight into a pond
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT n.tenant_id, m.user_id, 'c:' || n.id
      FROM new_rows n
      JOIN public.ponds p ON p.tenant_id = n.tenant_id AND p.id = n.pond_id
      JOIN public.memberships m ON m.tenant_id = p.tenant_id AND m.status = 'active' AND m.role = ANY (p.eligible_roles)
     WHERE n.ownership_state = 'in_pond'
       AND (p.open_to_all OR EXISTS (SELECT 1 FROM public.pond_members pm WHERE pm.tenant_id = p.tenant_id AND pm.pond_id = p.id AND pm.user_id = m.user_id));
  ELSE
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT n.tenant_id, u.user_id, 'c:' || n.id
      FROM new_rows n JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.id = n.id
     CROSS JOIN LATERAL (VALUES (o.owner_user_id), (o.offered_to_user_id), (n.owner_user_id), (n.offered_to_user_id)) u(user_id)
     WHERE u.user_id IS NOT NULL;
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT h.tenant_id, h.user_id, 'c:' || h.contact_id
      FROM (SELECT n.tenant_id, n.id FROM new_rows n JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.id = n.id
             WHERE (o.owner_user_id, o.offered_to_user_id, o.ownership_state, o.pond_id, o.deleted_at, o.merged_into_contact_id)
                   IS DISTINCT FROM (n.owner_user_id, n.offered_to_user_id, n.ownership_state, n.pond_id, n.deleted_at, n.merged_into_contact_id)) c
     CROSS JOIN LATERAL (
       SELECT t.tenant_id, t.assignee_user_id AS user_id, t.contact_id FROM public.tasks t
        WHERE t.tenant_id = c.tenant_id AND t.contact_id = c.id AND t.status = 'open' AND t.assignee_user_id IS NOT NULL
       UNION ALL
       SELECT a.tenant_id, a.user_id, a.contact_id FROM public.appointments a
        WHERE a.tenant_id = c.tenant_id AND a.contact_id = c.id AND a.status IN ('scheduled','held') AND a.outcome_logged_at IS NULL
          AND a.user_id IS NOT NULL
       UNION ALL
       SELECT x.tenant_id, x.owner_user_id, x.contact_id FROM public.assistant_actions x
        WHERE x.tenant_id = c.tenant_id AND x.contact_id = c.id AND x.status = 'proposed' AND x.owner_user_id IS NOT NULL) h;
    -- into, out of, or back into a pond: the members who may claim from the old and the new pond
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT x.tenant_id, m.user_id, 'c:' || x.id
      FROM (SELECT n.tenant_id, n.id, unnest(ARRAY[o.pond_id, n.pond_id]) AS pond_id
              FROM new_rows n JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.id = n.id
             WHERE (o.ownership_state = 'in_pond' OR n.ownership_state = 'in_pond')
               AND (o.ownership_seq, o.ownership_state, o.pond_id, o.deleted_at)
                   IS DISTINCT FROM (n.ownership_seq, n.ownership_state, n.pond_id, n.deleted_at)) x
      JOIN public.ponds p ON p.tenant_id = x.tenant_id AND p.id = x.pond_id
      JOIN public.memberships m ON m.tenant_id = p.tenant_id AND m.status = 'active' AND m.role = ANY (p.eligible_roles)
     WHERE p.open_to_all OR EXISTS (SELECT 1 FROM public.pond_members pm WHERE pm.tenant_id = p.tenant_id AND pm.pond_id = p.id AND pm.user_id = m.user_id);
  END IF;
  RETURN NULL;
END $$;

-- ponds and pond members: who may claim from a pond changed. Pond settings and member lists change rarely, and a
-- pond can hold most of a book, so the affected members get a whole-book recompute rather than one mark per lead.
CREATE FUNCTION app.feed_mark_ponds() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'ponds' THEN
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT m.tenant_id, m.user_id, '!full'
      FROM new_rows n JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.id = n.id
      JOIN public.memberships m ON m.tenant_id = n.tenant_id AND (m.role = ANY (o.eligible_roles) OR m.role = ANY (n.eligible_roles))
     WHERE (o.eligible_roles, o.open_to_all, o.archived_at, o.claims_per_day > 0, o.claim_cooldown_hours)
           IS DISTINCT FROM (n.eligible_roles, n.open_to_all, n.archived_at, n.claims_per_day > 0, n.claim_cooldown_hours);
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT o.tenant_id, o.user_id, '!full' FROM old_rows o
     WHERE EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id = o.tenant_id AND m.user_id = o.user_id);
  ELSE
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key) SELECT DISTINCT n.tenant_id, n.user_id, '!full' FROM new_rows n;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.feed_mark_ponds() FROM PUBLIC;
CREATE TRIGGER feed_mark_upd AFTER UPDATE ON public.ponds REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_ponds();
CREATE TRIGGER feed_mark_ins AFTER INSERT ON public.pond_members REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_ponds();
CREATE TRIGGER feed_mark_del AFTER DELETE ON public.pond_members REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_ponds();

-- -----------------------------------------------------------------------------
-- 3. The open pond cards of one member (GET /feed's per-member claim totals)
-- -----------------------------------------------------------------------------
CREATE INDEX feed_items_pond_open_idx ON priority_feed_items (tenant_id, user_id) WHERE state = 'open' AND item_type = 'pond_new';

-- -----------------------------------------------------------------------------
-- 4. Self-checks
-- -----------------------------------------------------------------------------
DO $$
DECLARE bad text := ''; txt text;
BEGIN
  -- the new definer: reviewed owner, pinned search_path, STABLE, EXECUTE for app_user only
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'app.my_pond_leads(timestamptz,uuid[])'::regprocedure
                AND (pg_get_userbyid(p.proowner) <> 'app_definer' OR NOT p.prosecdef OR p.provolatile <> 's'
                     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
                     OR has_function_privilege('public', p.oid, 'EXECUTE')))
     OR NOT has_function_privilege('app_user', 'app.my_pond_leads(timestamptz,uuid[])', 'EXECUTE') THEN
    bad := bad || ' my_pond_leads';
  END IF;
  -- the feed functions stay invoker and name feed_dirty with its schema
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'app' AND p.proname LIKE 'feed\_%' AND p.prosecdef) THEN
    bad := bad || ' feed_definer';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ',') INTO txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('app','auth','portal','public') AND p.prosrc ~* '(into|from|join|update)\s+feed_dirty\M';
  IF txt IS NOT NULL THEN bad := bad || ' unqualified_feed_dirty:' || txt; END IF;
  -- the marks exist
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ponds'::regclass AND tgname = 'feed_mark_upd')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.pond_members'::regclass AND tgname = 'feed_mark_ins')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.pond_members'::regclass AND tgname = 'feed_mark_del') THEN
    bad := bad || ' pond_triggers';
  END IF;
  IF bad <> '' THEN
    RAISE EXCEPTION 'SCHEMA SELF-CHECK FAILED (pond leads feed):%', bad;
  END IF;
END $$;
