-- =============================================================================
-- Batch 8 interaction review fixes, group "deal recipients, home values and merges".
-- The number is a placeholder: the orchestrator renumbers at merge, and nothing in code or tests names this file.
-- 0001-0058 are not edited. The replaced function starts from its newest definition (0053_b7_review_sends_merges,
-- app.contacts_merge_roles; no later migration replaces it) and changes only the lines marked "b8".
--
-- 1. ownership-data/F5, sends/F5(b) (R-OWN-24, R-TXN-4): a merge keeps the STRONGER deal role. 0053 kept whatever
--    role the survivor already held on the deal (ON CONFLICT DO NOTHING), so a buyer merged into a duplicate recorded
--    as 'other' or 'lender' lost milestone updates for good. The rank follows the deal's side (K1):
--      1 the team's own client role (buyer on a buy deal, seller on a sell deal, either on a dual deal)
--      2 the team's own co-client role (co_buyer / co_seller on the same rule)
--      3 a client role of the other side (or any client role of a lease deal)
--      4 lender, title, attorney
--      5 other
--    A lower rank wins; on a tie the survivor's role is kept (as before).
-- 2. db-public/F3 (R-AVM-1, R-AVM-3): home_valuations writes are system-only. 0001's FOR ALL contact_detail policy let
--    any member who sees the contact INSERT or UPDATE a valuation, and those rows now drive automatic client notes
--    under the vendor's name. RESTRICTIVE INSERT and UPDATE policies require app.actor_kind() = 'system' (as 0018's
--    property_records_write and predictions_write do). Reads are unchanged (contact_detail). app_user has no DELETE
--    (0001), so nothing else changes; foreign-key actions (an address delete sets contact_address_id NULL, an
--    erasure cascades) are referential actions and do not pass through these policies.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4; ARCHITECTURE §21.25 "batch 8 review fixes, deal recipients, home values and
-- merges"):
--   * app.contacts_merge_roles() is replaced with CREATE OR REPLACE (same signature, so the trigger binding stays) and
--     re-asserted: owner app_definer, search_path pinned to pg_catalog, public, EXECUTE revoked from PUBLIC (nobody may
--     execute it; it is a trigger function). It reads deals.side (app_definer already reads deals). One new
--     least-privilege grant: UPDATE (role) ON deal_contacts TO app_definer (the ON CONFLICT DO UPDATE of the stronger
--     role). It still acts only for a merge the ownership engine just made, only in that row's tenant, only on rows
--     naming the loser, and only towards the chosen survivor.
--   * Two new RESTRICTIVE policies on home_valuations (insert, update). No table, grant to app_user or definer added.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. ownership-data/F5: the stronger deal role survives a merge (0053 body; lines marked b8)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.contacts_merge_roles() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  s uuid := NEW.merged_into_contact_id;
  l uuid := NEW.id;
  t uuid := NEW.tenant_id;
  sold uuid[];
BEGIN
  IF app.tenant_id() IS NOT NULL AND t IS DISTINCT FROM app.tenant_id() THEN RETURN NULL; END IF;
  IF s IS NULL OR s = l OR NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = t AND c.id = s) THEN
    RETURN NULL;
  END IF;
  -- only the ownership engine's merge: merged_into_contact_id set in the same ownership command that appended the
  -- loser's merged_away event (contacts_guard does not cover the column, so a bare UPDATE of it moves nothing here)
  IF app.ownership_command() IS NULL OR NEW.ownership_command_id IS DISTINCT FROM app.ownership_command()
     OR NOT EXISTS (SELECT 1 FROM public.lead_ownership_events e
                     WHERE e.tenant_id = t AND e.contact_id = l AND e.type = 'merged_away' AND e.command_id = app.ownership_command()) THEN
    RETURN NULL;
  END IF;

  -- the listings on which the loser was a seller (their open seller-update card says the seller moved)
  sold := ARRAY(SELECT lc.listing_id FROM public.listing_contacts lc
                 WHERE lc.tenant_id = t AND lc.contact_id = l AND lc.role IN ('seller','co_seller'));

  -- listing roles: the survivor keeps the stronger role (seller > co_seller > interested)
  INSERT INTO public.listing_contacts AS x (tenant_id, listing_id, contact_id, role, created_at)
  SELECT t, lc.listing_id, s, lc.role, lc.created_at FROM public.listing_contacts lc WHERE lc.tenant_id = t AND lc.contact_id = l
  ON CONFLICT (tenant_id, listing_id, contact_id) DO UPDATE SET role = EXCLUDED.role
   WHERE (CASE EXCLUDED.role WHEN 'seller' THEN 1 WHEN 'co_seller' THEN 2 ELSE 3 END)
       < (CASE x.role WHEN 'seller' THEN 1 WHEN 'co_seller' THEN 2 ELSE 3 END);
  DELETE FROM public.listing_contacts lc WHERE lc.tenant_id = t AND lc.contact_id = l;

  -- b8 ownership-data/F5: deal roles: the survivor keeps the stronger role, ranked by the deal's side (K1)
  INSERT INTO public.deal_contacts AS x (tenant_id, deal_id, contact_id, role)
  SELECT t, dc.deal_id, s, dc.role FROM public.deal_contacts dc WHERE dc.tenant_id = t AND dc.contact_id = l
  ON CONFLICT (tenant_id, deal_id, contact_id) DO UPDATE SET role = EXCLUDED.role
   WHERE app.deal_role_rank((SELECT d.side FROM public.deals d WHERE d.tenant_id = x.tenant_id AND d.id = x.deal_id), EXCLUDED.role)
       < app.deal_role_rank((SELECT d.side FROM public.deals d WHERE d.tenant_id = x.tenant_id AND d.id = x.deal_id), x.role);
  DELETE FROM public.deal_contacts dc WHERE dc.tenant_id = t AND dc.contact_id = l;

  -- a deal's primary person
  UPDATE public.deals d SET primary_contact_id = s WHERE d.tenant_id = t AND d.primary_contact_id = l;

  -- the open seller-update card of such a listing says what happened (the draft's recipients are the listing's
  -- sellers when it is sent, so it now goes to the merged record; nothing names either record)
  IF cardinality(sold) > 0 THEN
    UPDATE public.priority_feed_items f
       SET reasons = jsonb_build_array(jsonb_build_object('code', 'SELLER_UPDATE_SELLER_MERGED',
                       'label', 'A seller on this listing was merged with a duplicate record, so who this update goes to may have changed. Check the recipients, add your recommendation and send')),
           updated_at = now()
     WHERE f.tenant_id = t AND f.item_type = 'seller_update' AND f.subject_type = 'listing' AND f.subject_id = ANY (sold)
       AND f.assistant_action_id IS NOT NULL   -- a draft's card only, never the "no active listing agent" card
       AND f.state IN ('open','snoozed');
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION app.contacts_merge_roles() OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.contacts_merge_roles() FROM PUBLIC;
GRANT UPDATE (role) ON deal_contacts TO app_definer;   -- b8: ON CONFLICT DO UPDATE (stronger deal role kept) needs it

-- The rank of a deal role on a deal of `side` (lower is stronger). Pure (IMMUTABLE), plain SQL, NOT security
-- definer; mirrors core transactions/recipients.ts teamClientRoles.
CREATE FUNCTION app.deal_role_rank(p_side text, p_role text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN p_role IN ('buyer','seller') AND (p_side = 'dual' OR (p_side = 'buy' AND p_role = 'buyer') OR (p_side = 'sell' AND p_role = 'seller')) THEN 1
    WHEN p_role IN ('co_buyer','co_seller') AND (p_side = 'dual' OR (p_side = 'buy' AND p_role = 'co_buyer') OR (p_side = 'sell' AND p_role = 'co_seller')) THEN 2
    WHEN p_role IN ('buyer','seller','co_buyer','co_seller') THEN 3
    WHEN p_role IN ('lender','title','attorney') THEN 4
    ELSE 5 END
$$;
REVOKE ALL ON FUNCTION app.deal_role_rank(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.deal_role_rank(text, text) TO app_definer;

-- -----------------------------------------------------------------------------
-- 2. db-public/F3: home_valuations writes are system-only (people still read through contact_detail)
-- -----------------------------------------------------------------------------
CREATE POLICY home_valuations_system_insert ON home_valuations AS RESTRICTIVE FOR INSERT
  WITH CHECK ((SELECT app.actor_kind()) = 'system');
CREATE POLICY home_valuations_system_update ON home_valuations AS RESTRICTIVE FOR UPDATE
  USING ((SELECT app.actor_kind()) = 'system')
  WITH CHECK ((SELECT app.actor_kind()) = 'system');

-- -----------------------------------------------------------------------------
-- 3. Self-check
-- -----------------------------------------------------------------------------
DO $$
DECLARE bad text := '';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid = 'app.contacts_merge_roles()'::regprocedure
                AND (pg_get_userbyid(p.proowner) <> 'app_definer' OR NOT p.prosecdef
                     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
                     OR has_function_privilege('public', p.oid, 'EXECUTE'))) THEN
    bad := bad || ' definer_shape';
  END IF;
  IF has_function_privilege('app_user', 'app.contacts_merge_roles()', 'EXECUTE') THEN bad := bad || ' merge_roles_grant'; END IF;
  -- every 0053 rule is still in the body, plus this migration's
  IF (SELECT position('merged_away' IN p.prosrc) = 0 OR position('SELLER_UPDATE_SELLER_MERGED' IN p.prosrc) = 0
             OR position('primary_contact_id = s' IN p.prosrc) = 0 OR position('WHEN ''co_seller'' THEN 2' IN p.prosrc) = 0
             OR position('app.deal_role_rank' IN p.prosrc) = 0
        FROM pg_proc p WHERE p.oid = 'app.contacts_merge_roles()'::regprocedure) THEN
    bad := bad || ' merge_roles_rules';
  END IF;
  IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'app.deal_role_rank(text,text)'::regprocedure)
     OR has_function_privilege('public', 'app.deal_role_rank(text,text)', 'EXECUTE') THEN
    bad := bad || ' rank_shape';
  END IF;
  IF app.deal_role_rank('buy', 'co_buyer') >= app.deal_role_rank('buy', 'seller')
     OR app.deal_role_rank('sell', 'seller') >= app.deal_role_rank('sell', 'buyer')
     OR app.deal_role_rank('lease', 'buyer') >= app.deal_role_rank('lease', 'lender')
     OR app.deal_role_rank('buy', 'lender') >= app.deal_role_rank('buy', 'other') THEN
    bad := bad || ' rank_order';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.home_valuations'::regclass AND NOT polpermissive
         AND polname IN ('home_valuations_system_insert','home_valuations_system_update')) <> 2 THEN
    bad := bad || ' valuation_policies';
  END IF;
  IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.home_valuations'::regclass) THEN bad := bad || ' valuation_force_rls'; END IF;
  IF has_table_privilege('app_user', 'public.home_valuations', 'DELETE') THEN bad := bad || ' valuation_delete_grant'; END IF;
  IF bad <> '' THEN RAISE EXCEPTION 'SCHEMA SELF-CHECK FAILED (b8 review deals):%', bad; END IF;
END $$;
