-- =============================================================================
-- Marketing retract claim (module 29; DATA_MODEL R-MKT-12, R-MKT-4, R-MKT-9, R-GATE-15; ARCHITECTURE §21.11, §21.19).
-- The number is a placeholder: the orchestrator renumbers at merge, and nothing in code or tests names this file.
-- 0001-0053 are not edited. app.marketing_publications_guard starts from its only definition (0025) and changes only
-- the lines marked "0054".
--
-- The race (marketing/publish.ts retractPublication): two retractions of one published post both read 'published'
-- and both called SocialPublisher.deletePost. The first deleted the post; the second got POST_NOT_FOUND, decided
-- "remove it yourself", and when its last transaction ran before the first's 'retracted' UPDATE committed, it raised
-- a "remove it yourself" feed card for a post that was gone. Now one short transaction claims the retraction before
-- the provider call (the TX1/provider/TX2 shape publishing uses, R-MKT-12): exactly one caller holds the claim and
-- calls the provider; the others answer "in progress" and never call it. The provider call stays outside any
-- transaction. The claim is cleared with the outcome ('retracted', or the card for a post the provider could not
-- delete), and a claim whose process died is taken again once it is older than app.marketing_retract_claim_window()
-- (5 minutes; provider calls time out long before), so the reconcile pass (handlers.ts, every 5 minutes) still
-- retracts it.
--
-- What this adds:
--   * marketing_publications.retract_claim_id / retract_claimed_at: both or neither (CHECK), only on a
--     provider-confirmed 'published' row (CHECK; 'published' moves only to 'retracted', which clears the claim).
--   * app.marketing_publications_guard (0025 body): a publication is never born with a claim; only the system writes
--     one (the claim columns join the system-only tuple); a claim goes only on a 'published' row with a post id; a
--     live claim is never replaced (PUBLICATION_RETRACT_CLAIMED) until it is older than the window; the claim time is
--     the database's now(), stamped with the claim and never moved without a new claim.
--   * app.marketing_retract_claim_window(): the window, one place for the guard and publish.ts.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4; ARCHITECTURE §21.19 "marketing retract claim"):
--   * No new SECURITY DEFINER function, no new policy, no new table grant (0025's table-level SELECT, INSERT, UPDATE
--     to app_user covers the two columns; the system-only UPDATE policy publications_outcome is unchanged).
--   * app.marketing_publications_guard stays SECURITY INVOKER, EXECUTE revoked from PUBLIC (re-asserted). It only
--     refuses more (every 0025 refusal is kept verbatim and self-checked below) and stamps the claim time.
--   * app.marketing_retract_claim_window() is SECURITY INVOKER, IMMUTABLE, pinned search_path, reads nothing;
--     EXECUTE revoked from PUBLIC and granted to app_user (the guard runs as the writer: the system actor).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The claim columns
-- -----------------------------------------------------------------------------
ALTER TABLE marketing_publications
  ADD COLUMN retract_claim_id   uuid,
  ADD COLUMN retract_claimed_at timestamptz;
ALTER TABLE marketing_publications
  ADD CONSTRAINT marketing_publications_retract_claim_pair CHECK ((retract_claim_id IS NULL) = (retract_claimed_at IS NULL)),
  -- only a provider-confirmed post is claimed for retraction; 'retracted' (and every other state) holds no claim
  ADD CONSTRAINT marketing_publications_retract_claim_live CHECK (retract_claim_id IS NULL OR (status = 'published' AND external_post_id IS NOT NULL));

-- -----------------------------------------------------------------------------
-- 2. The claim window: a claim older than this belongs to a retraction that died and may be taken again
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.marketing_retract_claim_window() RETURNS interval
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$ SELECT interval '5 minutes' $$;
REVOKE ALL ON FUNCTION app.marketing_retract_claim_window() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.marketing_retract_claim_window() TO app_user;

-- -----------------------------------------------------------------------------
-- 3. The guard (0025 body; lines marked 0054 are new)
-- -----------------------------------------------------------------------------
-- INSERT: a person's tap, as themselves, on an approved social or GBP post, to a connected account of the matching
-- kind, once counsel cleared platform:fair_housing; born 'publishing' with no outcome and no retract claim. UPDATE:
-- the row never moves to another piece, account or requester; only the system writes the outcome (status, post id,
-- times, error) and the retract claim; states only move forward; the provider's post id is written once; a retract
-- claim goes only on a published post, is never replaced while live, and carries the database's time.
CREATE OR REPLACE FUNCTION app.marketing_publications_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sys boolean := COALESCE(app.actor_kind() = 'system', false) OR current_user IN ('app_definer','app_retention');
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'publishing' OR NEW.external_post_id IS NOT NULL OR NEW.published_at IS NOT NULL
       OR NEW.error_code IS NOT NULL OR NEW.retracted_at IS NOT NULL
       OR NEW.retract_claim_id IS NOT NULL OR NEW.retract_claimed_at IS NOT NULL THEN                             -- 0054
      RAISE EXCEPTION 'PUBLICATION_BORN_PUBLISHING: a publication starts as an attempt, with no outcome' USING ERRCODE = 'check_violation';
    END IF;
    IF app.actor_kind() IS DISTINCT FROM 'user' OR NEW.requested_by_user_id IS DISTINCT FROM app.user_id() THEN
      RAISE EXCEPTION 'PUBLICATION_HUMAN_TAP: a person publishes, as themselves' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.requested_at := now();
    IF NOT EXISTS (SELECT 1 FROM public.marketing_pieces mp
                     JOIN public.integration_connections ic ON ic.tenant_id = mp.tenant_id AND ic.id = NEW.connection_id
                    WHERE mp.tenant_id = NEW.tenant_id AND mp.id = NEW.piece_id AND mp.status IN ('approved','published')
                      AND ((mp.kind = 'social_post' AND ic.kind IN ('facebook_page','instagram_business'))
                           OR (mp.kind = 'gbp_post' AND ic.kind = 'gbp_location'))) THEN
      RAISE EXCEPTION 'PUBLISH_TARGET_INVALID: an approved social post goes to a Facebook Page or Instagram business account, a GBP post to a GBP location'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.integration_connections ic
                    WHERE ic.tenant_id = NEW.tenant_id AND ic.id = NEW.connection_id AND ic.status IN ('connected','degraded')) THEN
      RAISE EXCEPTION 'CHANNEL_NOT_CONNECTED: publish only to a connected account; export otherwise' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT app.platform_cleared('platform:fair_housing') THEN
      RAISE EXCEPTION 'PLATFORM_NOT_CLEARED: publishing waits for counsel review of the platform:fair_housing pack'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.piece_id, NEW.connection_id, NEW.requested_by_user_id, NEW.requested_at, NEW.created_at)
     IS DISTINCT FROM (OLD.piece_id, OLD.connection_id, OLD.requested_by_user_id, OLD.requested_at, OLD.created_at) THEN
    RAISE EXCEPTION 'PUBLICATION_IMMUTABLE: a publication keeps its piece, account and requester' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT sys AND (NEW.status, NEW.external_post_id, NEW.published_at, NEW.error_code, NEW.retracted_at,
                  NEW.retract_claim_id, NEW.retract_claimed_at)                                                    -- 0054
                 IS DISTINCT FROM (OLD.status, OLD.external_post_id, OLD.published_at, OLD.error_code, OLD.retracted_at,
                  OLD.retract_claim_id, OLD.retract_claimed_at) THEN                                               -- 0054
    RAISE EXCEPTION 'PUBLICATION_SYSTEM_ONLY: only the provider''s outcome, recorded by the system, says a post went live, failed or came down'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (OLD.external_post_id IS NOT NULL AND NEW.external_post_id IS DISTINCT FROM OLD.external_post_id)
     OR (OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
    RAISE EXCEPTION 'PUBLICATION_POST_ID_FINAL: the provider''s post id and publish time are written once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'publishing' AND NEW.status IN ('published','failed','unknown'))
    OR (OLD.status = 'unknown' AND NEW.status IN ('published','failed'))
    OR (OLD.status = 'published' AND NEW.status = 'retracted')) THEN
    RAISE EXCEPTION 'PUBLICATION_FORWARD_ONLY: % cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  -- 0054: the retract claim (R-MKT-12). One retraction at a time calls the provider; a claim whose process died is
  -- taken again only after the window; a released claim has no time; a claim's time is never moved by itself.
  IF NEW.retract_claim_id IS NOT NULL AND NEW.retract_claim_id IS DISTINCT FROM OLD.retract_claim_id THEN
    IF OLD.status <> 'published' OR NEW.status <> 'published' OR OLD.external_post_id IS NULL THEN
      RAISE EXCEPTION 'PUBLICATION_RETRACT_CLAIM: only a provider-confirmed post is claimed for retraction' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.retract_claim_id IS NOT NULL AND OLD.retract_claimed_at >= now() - app.marketing_retract_claim_window() THEN
      RAISE EXCEPTION 'PUBLICATION_RETRACT_CLAIMED: another retraction of this post is in flight' USING ERRCODE = 'check_violation';
    END IF;
    NEW.retract_claimed_at := now();
  ELSIF NEW.retract_claim_id IS NULL THEN
    NEW.retract_claimed_at := NULL;
  ELSIF NEW.retract_claimed_at IS DISTINCT FROM OLD.retract_claimed_at THEN
    RAISE EXCEPTION 'PUBLICATION_RETRACT_CLAIM: a claim''s time is written with the claim' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.marketing_publications_guard() FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 4. Self-check
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  bad text := '';
  src text := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'app.marketing_publications_guard()'::regprocedure);
BEGIN
  -- every 0025 refusal is still in the replaced body, plus this migration's
  IF position('PUBLICATION_BORN_PUBLISHING' IN src) = 0 OR position('PUBLICATION_HUMAN_TAP' IN src) = 0
     OR position('PUBLISH_TARGET_INVALID' IN src) = 0 OR position('CHANNEL_NOT_CONNECTED' IN src) = 0
     OR position('PLATFORM_NOT_CLEARED' IN src) = 0 OR position('PUBLICATION_IMMUTABLE' IN src) = 0
     OR position('PUBLICATION_SYSTEM_ONLY' IN src) = 0 OR position('PUBLICATION_POST_ID_FINAL' IN src) = 0
     OR position('PUBLICATION_FORWARD_ONLY' IN src) = 0 OR position('PUBLICATION_RETRACT_CLAIMED' IN src) = 0
     OR position('NEW.retract_claimed_at := now()' IN src) = 0 THEN
    bad := bad || ' guard_rules';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN ('app.marketing_publications_guard()'::regprocedure, 'app.marketing_retract_claim_window()'::regprocedure)
                AND (p.prosecdef OR has_function_privilege('public', p.oid, 'EXECUTE'))) THEN
    bad := bad || ' function_shape';
  END IF;
  IF (SELECT p.proconfig FROM pg_proc p WHERE p.oid = 'app.marketing_retract_claim_window()'::regprocedure) IS DISTINCT FROM ARRAY['search_path=pg_catalog']
     OR NOT has_function_privilege('app_user', 'app.marketing_retract_claim_window()', 'EXECUTE') THEN
    bad := bad || ' window_shape';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.marketing_publications'::regclass AND tgname = 'marketing_publications_guard') THEN
    bad := bad || ' guard_trigger';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.marketing_publications'::regclass
        AND conname IN ('marketing_publications_retract_claim_pair','marketing_publications_retract_claim_live')) <> 2 THEN
    bad := bad || ' claim_checks';
  END IF;
  IF bad <> '' THEN RAISE EXCEPTION 'SCHEMA SELF-CHECK FAILED (marketing retract claim):%', bad; END IF;
END $$;
