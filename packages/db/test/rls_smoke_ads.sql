-- =============================================================================
-- Smoke proof of the ads platform pack and its two gates (PHASE2_3_PLAN module 52; owner decisions D2, D7, D-ADS;
-- DATA_MODEL R-ADS-7, R-ADS-8, R-ADS-9, R-ADS-10; E440, E441, E442, E443, E444, E455):
--   * platform:ads ships published, unreviewed and uncleared;
--   * while it is not cleared (and with counsel review alone), nobody records a planned ledger row or approves an
--     ad_reallocation: not the Owner, not an Admin, not the system;
--   * once cleared, 0018's deferred cap check decides as before;
--   * a planned row needs a Google Ads campaign the caller sees on a live connection (ads_meta and revoked refused);
--   * outcomes (applied, failed, paused) and finishing a run (executed, trigger_ref) are never gated (E442);
--   * a pack bumped to an unreviewed version is dark from the next statement: a pending proposal is not approved (E443);
--   * an approved budget shift is never edited and keeps its kind; message drafts are unaffected;
--   * the counsel-review command's vendor-check scan lists platform:ads.
-- Same shape as rls_smoke_p23.sql: ONE transaction, rolled back; every application step runs as app_user; clearing
-- and withdrawing the pack (a platform maintenance step) runs as the owner role between RESET ROLE and SET LOCAL ROLE.
-- Run by packages/db/test/rls_smoke_ads.test.ts. No test names this migration's file: the orchestrator renumbers it.
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
BEGIN;
SET LOCAL ROLE app_user;

CREATE FUNCTION pg_temp.ctx(p_tenant uuid, p_user uuid, p_actor text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.tenant_id', COALESCE(p_tenant::text, ''), true);
  PERFORM set_config('app.user_id', COALESCE(p_user::text, ''), true);
  PERFORM set_config('app.actor_kind', COALESCE(p_actor, ''), true);
  PERFORM set_config('app.principal_type', 'staff', true);
  PERFORM set_config('app.portal_account_id', '', true);
  PERFORM set_config('app.ownership_command', '', true);
END $$;
CREATE FUNCTION pg_temp.ok(p_cond boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL  %', p_label; END IF;
  RAISE NOTICE 'PASS  %', p_label;
END $$;
CREATE FUNCTION pg_temp.expect_error(p_sql text, p_label text, p_like text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE p_like THEN
      RAISE NOTICE 'PASS  % -> %', p_label, SQLERRM;
      RETURN;
    END IF;
    RAISE EXCEPTION 'FAIL  %: unexpected error: %', p_label, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL  %: statement succeeded but must fail', p_label;
END $$;
-- runs a deferred-constraint statement and reports its error at COMMIT time (SET CONSTRAINTS ALL IMMEDIATE)
CREATE FUNCTION pg_temp.expect_deferred_error(p_sql text, p_label text, p_like text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN
    SET CONSTRAINTS ALL DEFERRED;
    IF SQLERRM LIKE p_like THEN RAISE NOTICE 'PASS  % -> %', p_label, SQLERRM; RETURN; END IF;
    RAISE EXCEPTION 'FAIL  %: unexpected error: %', p_label, SQLERRM;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  RAISE EXCEPTION 'FAIL  %: statement succeeded but must fail', p_label;
END $$;
-- runs a statement (and the deferred checks) in a subtransaction: 'OK', or the error it raised
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    RETURN 'OK';
  EXCEPTION WHEN OTHERS THEN
    SET CONSTRAINTS ALL DEFERRED;
    RETURN SQLERRM;
  END;
END $$;
-- one planned ledger row (the run, campaign, approval and amounts given), as ads/dispatch.ts writes it
CREATE FUNCTION pg_temp.planned_sql(p_run uuid, p_campaign uuid, p_cap uuid, p_action uuid, p_from bigint, p_to bigint) RETURNS text
LANGUAGE sql AS $$
  SELECT format($q$INSERT INTO ad_allocation_events (tenant_id, id, run_id, campaign_id, event_kind, cap_version_id, assistant_action_id,
    from_daily_cents, to_daily_cents, reason_code, occurred_at) VALUES (app.tenant_id(), gen_random_uuid(), %L, %L, 'planned', %L, %L, %s, %s,
    'RAISED_LOWER_COST_PER_OUTCOME', now())$q$, p_run, p_campaign, p_cap, p_action, p_from, p_to)
$$;
-- one outcome row (applied / failed / paused) of a run
CREATE FUNCTION pg_temp.outcome_sql(p_kind text, p_run uuid, p_campaign uuid, p_cap uuid, p_from bigint, p_to bigint, p_reason text) RETURNS text
LANGUAGE sql AS $$
  SELECT format($q$INSERT INTO ad_allocation_events (tenant_id, id, run_id, campaign_id, event_kind, cap_version_id, from_daily_cents,
    to_daily_cents, reason_code, provider_ref, occurred_at) VALUES (app.tenant_id(), gen_random_uuid(), %L, %L, %L, %L, %s, %s, %L, 'fake-ads-ref', now())$q$,
    p_run, p_campaign, p_kind, p_cap, p_from, p_to, p_reason)
$$;
-- an ownerless, contactless ad_reallocation (as ads/propose.ts stores it) naming the given changes
CREATE FUNCTION pg_temp.proposal_sql(p_id uuid, p_changes jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT format($q$INSERT INTO assistant_actions (tenant_id, id, kind, action_category, autonomy, status, explanation, payload)
    VALUES (app.tenant_id(), %L, 'ad_reallocation', 'money', 'requires_approval', 'proposed', 'Move budget toward agreements', %L::jsonb)$q$,
    p_id, jsonb_build_object('v', 1, 'changes', p_changes))
$$;
CREATE FUNCTION pg_temp.approve_sql(p_id uuid) RETURNS text LANGUAGE sql AS $$
  SELECT format($q$UPDATE assistant_actions SET status = 'approved', decided_by_user_id = app.user_id(), decided_at = now() WHERE id = %L$q$, p_id)
$$;
CREATE FUNCTION pg_temp.changes(p_campaign uuid, p_to bigint) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_array(jsonb_build_object('campaign_id', p_campaign::text, 'to_daily_cents', p_to))
$$;

\set tA     '''a0000000-0000-7000-8000-0000000000aa'''
\set ownA   '''a0000000-0000-7000-8000-0000000000a0'''
\set admA   '''a0000000-0000-7000-8000-0000000000ad'''
\set agA1   '''a0000000-0000-7000-8000-0000000000a1'''
\set polA   '''a0000000-0000-7000-8000-00000000c001'''
\set pondA  '''a0000000-0000-7000-8000-00000000d001'''
\set teamA  '''a0000000-0000-7000-8000-00000000f001'''
\set srcA   '''a0000000-0000-7000-8000-000000005001'''
\set lA     '''a0000000-0000-7000-8000-00000000f1aa'''
\set pcA    '''a0000000-0000-7000-8000-00000000f303'''
\set credG  '''a0000000-0000-7000-8000-00000000cd01'''
\set credM  '''a0000000-0000-7000-8000-00000000cd02'''
\set credR  '''a0000000-0000-7000-8000-00000000cd03'''
\set gconn  '''a0000000-0000-7000-8000-00000000ac01'''
\set mconn  '''a0000000-0000-7000-8000-00000000ac02'''
\set rconn  '''a0000000-0000-7000-8000-00000000ac03'''
\set cG1    '''a0000000-0000-7000-8000-00000000cb01'''
\set cG2    '''a0000000-0000-7000-8000-00000000cb02'''
\set cM     '''a0000000-0000-7000-8000-00000000cb03'''
\set cR     '''a0000000-0000-7000-8000-00000000cb04'''
\set cap1   '''a0000000-0000-7000-8000-00000000ad01'''
\set act1   '''a0000000-0000-7000-8000-0000000aa201'''
\set act2   '''a0000000-0000-7000-8000-0000000aa202'''
\set act3   '''a0000000-0000-7000-8000-0000000aa203'''
\set act4   '''a0000000-0000-7000-8000-0000000aa204'''
\set act5   '''a0000000-0000-7000-8000-0000000aa205'''
\set actD   '''a0000000-0000-7000-8000-0000000aa2d1'''
\set run1   '''a0000000-0000-7000-8000-00000000ad90'''
\set run2   '''a0000000-0000-7000-8000-00000000ad91'''
\set PH     '''$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA'''

-- =============================================================================
-- 0. Fixture. Tenant A: an Owner, an Admin and an agent; a lead source; a listing with an approved creative; a
--    Google Ads account (connected), a Meta ads account made before D2 (connected) and a revoked Google Ads account,
--    each with one campaign the system mirrored live; the Owner's cap ($3,000 a month, $100 a day).
-- =============================================================================
SELECT pg_temp.ctx(NULL, :ownA, 'user');
INSERT INTO users (id, email, display_name, password_hash) VALUES (:ownA, 'owner-a@example.test', 'Olivia Owner', :PH);
SELECT app.provision_tenant(:tA, 'team-a', 'Team A', 'America/New_York', 'A Realty LLC', :ownA, :polA,
       :teamA, :pondA, '\x01', '\x02', '\x03', 'kek-dev');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO invites (tenant_id, id, email, role, token_hash, invited_by_user_id, expires_at) VALUES
  (:tA, 'a0000000-0000-7000-8000-0000000001a1', 'agent1@example.test', 'agent', digest('ads-invite-a1', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a0000000-0000-7000-8000-0000000001ad', 'admin@example.test', 'admin', digest('ads-invite-ad', 'sha256'), :ownA, now() + interval '1 day');
SELECT pg_temp.ctx(NULL, NULL, NULL);
SELECT FROM auth.accept_invite(digest('ads-invite-a1', 'sha256'), :agA1, 'Ava Agent', :PH, now());
SELECT FROM auth.accept_invite(digest('ads-invite-ad', 'sha256'), :admA, 'Adam Admin', :PH, now());
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO lead_sources (tenant_id, id, name, kind) VALUES (:tA, :srcA, 'Google Ads', 'ads');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO listings (tenant_id, id, source, status, address_line1, city, region, postal_code, listing_agent_user_id, list_price_cents)
VALUES (:tA, :lA, 'team', 'active', '12 Oak St', 'Town', 'SC', '29401', :agA1, 45000000);
INSERT INTO marketing_pieces (tenant_id, id, listing_id, kind, version_no, prose, template_key, guard_result, created_by_user_id)
VALUES (:tA, :pcA, :lA, 'social_post', 1, '{"text": "Open house Sunday at 12 Oak St"}', 'social/1',
        '{"brokerage_name_present": true, "hard_count": 0, "pack_rule_failures": []}', :agA1);
UPDATE marketing_pieces SET guard_result = guard_result || jsonb_build_object('content_sha256', content_sha256) WHERE id = :pcA;
UPDATE marketing_pieces SET status = 'approved', approved_by_user_id = :agA1, approved_at = now() WHERE id = :pcA;
-- the provider callback (system) links the three accounts; Meta ads predates D2 and stays listed only
SELECT pg_temp.ctx(:tA, NULL, 'system');
INSERT INTO provider_credentials (tenant_id, id, provider, secret_enc, key_version) VALUES
  (:tA, :credG, 'google', '\x01', 1), (:tA, :credM, 'meta', '\x01', 1), (:tA, :credR, 'google', '\x01', 1);
INSERT INTO integration_connections (tenant_id, id, kind, status, display_name, external_account_id, credential_id, lead_source_id, connected_at)
VALUES (:tA, :gconn, 'ads_google', 'connected', 'Google Ads', 'fake-ads-1', :credG, :srcA, now()),
       (:tA, :mconn, 'ads_meta', 'connected', 'Meta ads', 'fake-meta-ads-1', :credM, NULL, now()),
       (:tA, :rconn, 'ads_google', 'connected', 'Google Ads (old)', 'fake-ads-2', :credR, :srcA, now());
UPDATE integration_connections SET status = 'revoked', status_reason = 'TOKEN_REVOKED' WHERE id = :rconn;
-- the mirror (system): four campaigns, live at $30, $15, $20 and $10 a day
INSERT INTO ad_campaigns (tenant_id, id, connection_id, external_campaign_id, name, lead_source_id, campaign_ref, listing_id, creative_piece_id,
       status, daily_budget_cents)
VALUES (:tA, :cG1, :gconn, 'fake-c-1', 'Oak St A', :srcA, 'gads:fake-c-1', :lA, :pcA, 'active', 3000),
       (:tA, :cG2, :gconn, 'fake-c-2', 'Oak St B', :srcA, 'gads:fake-c-2', :lA, :pcA, 'active', 1500),
       (:tA, :cM, :mconn, 'fake-m-1', 'Oak St M', :srcA, 'meta:fake-m-1', :lA, :pcA, 'active', 2000),
       (:tA, :cR, :rconn, 'fake-c-9', 'Oak St R', :srcA, 'gads:fake-c-9', :lA, :pcA, 'active', 1000);
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO ad_budget_caps (tenant_id, id, version_no, monthly_cap_cents, daily_ceiling_cents, effective_from, approved_by_user_id, attestation)
VALUES (:tA, :cap1, 1, 300000, 10000, now() - interval '1 day', :ownA, 'I approve a $3,000 monthly cap.');
-- proposals the system stored (ownerless, contactless): act1 moves A up, act2 B up, act3 is never approved,
-- act4 overflows the ceiling, act5 names the Meta campaign, actD is an unrelated message draft
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.ok(pg_temp.try(pg_temp.proposal_sql(:act1, pg_temp.changes(:cG1, 3500))) = 'OK', 'the system stores a proposed ad_reallocation while dark');
SELECT pg_temp.try(pg_temp.proposal_sql(:act2, pg_temp.changes(:cG2, 2000)));
SELECT pg_temp.try(pg_temp.proposal_sql(:act3, pg_temp.changes(:cG1, 4000)));
SELECT pg_temp.try(pg_temp.proposal_sql(:act4, pg_temp.changes(:cG1, 9000)));
SELECT pg_temp.try(pg_temp.proposal_sql(:act5, pg_temp.changes(:cM, 2500)));
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO assistant_actions (tenant_id, id, kind, action_category, autonomy, status, owner_user_id, explanation, payload)
VALUES (:tA, :actD, 'message_draft', 'novel_message', 'requires_approval', 'proposed', :agA1, 'Reply to the open-house question', '{"body": "See you Sunday"}');

-- =============================================================================
-- 1. The pack ships published, unreviewed and uncleared (R-ADS-7, D7); D11 does not cover it
-- =============================================================================
SELECT pg_temp.ok((SELECT count(*) = 1 AND bool_and(status = 'published') AND bool_and(reviewed_by_counsel_at IS NULL)
                          AND bool_and(NOT (rules ? 'vendor_ready_at')) AND bool_and(notes LIKE '%Not part of owner decision D11%')
                     FROM jurisdiction_packs WHERE key = 'platform:ads'),
                  'R-ADS-7: platform:ads ships published and unreviewed, with no vendor check, outside D11');
SELECT pg_temp.ok(NOT app.platform_cleared('platform:ads', true) AND NOT app.platform_cleared('platform:ads', false),
                  'R-ADS-7: platform:ads is not cleared on a fresh database');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM (SELECT DISTINCT m[1] AS key FROM pg_proc p
                     CROSS JOIN LATERAL regexp_matches(p.prosrc, 'platform_cleared\(''(platform:[a-z_]+)'',\s*true\)', 'g') AS m) k
                    WHERE k.key = 'platform:ads'),
                  'R-ADS-7: the counsel-review command''s vendor-check scan (pg_proc) lists platform:ads, so its notes say it still waits for the vendor check');

-- =============================================================================
-- 2. While dark, nobody plans or approves: the Owner, an Admin, the system (R-ADS-7, E440)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.expect_error(pg_temp.approve_sql(:act1), 'R-ADS-7 E440: while platform:ads is not cleared the Owner''s approval is refused', 'ADS_NOT_CLEARED%');
SELECT pg_temp.expect_error(format($q$INSERT INTO assistant_actions (tenant_id, id, kind, action_category, autonomy, status, explanation, payload,
  decided_by_user_id, decided_at) VALUES (%L, gen_random_uuid(), 'ad_reallocation', 'money', 'requires_approval', 'approved', 'Pre-approved', %L::jsonb, %L, now())$q$,
  :tA, jsonb_build_object('changes', pg_temp.changes(:cG1, 3500)), :ownA),
  'R-ADS-7 E440: while dark nobody inserts an ad_reallocation already approved', 'ADS_NOT_CLEARED%');
SELECT pg_temp.expect_error(pg_temp.planned_sql(:run1, :cG1, :cap1, :act1, 3000, 3500),
  'R-ADS-7 E440: while dark the Owner records no planned budget change', 'ADS_NOT_CLEARED%');
SELECT pg_temp.ctx(:tA, :admA, 'user');
SELECT pg_temp.expect_error(pg_temp.approve_sql(:act1), 'R-ADS-7 E440: while dark an Admin''s approval is refused', 'ADS_NOT_CLEARED%');
SELECT pg_temp.expect_error(pg_temp.planned_sql(:run1, :cG1, :cap1, :act1, 3000, 3500),
  'R-ADS-7 E440: while dark an Admin records no planned budget change', 'ADS_NOT_CLEARED%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(pg_temp.planned_sql(:run1, :cG1, :cap1, :act1, 3000, 3500),
  'R-ADS-7 E440: while dark the system records no planned budget change', 'ADS_NOT_CLEARED%');
SELECT pg_temp.expect_error(format($q$UPDATE assistant_actions SET status = 'approved', decided_by_user_id = %L, decided_at = now() WHERE id = %L$q$, :ownA, :act1),
  'R-ADS-7 E440: the gate fires before the decision guard (VERIFY trigger order): the system''s approval while dark is ADS_NOT_CLEARED', 'ADS_NOT_CLEARED%');
SELECT pg_temp.ok((SELECT count(*) FROM ad_allocation_events) = 0 AND (SELECT count(*) FROM assistant_actions WHERE kind = 'ad_reallocation' AND status <> 'proposed') = 0,
                  'R-ADS-7 E440: nothing was recorded while dark');

-- =============================================================================
-- 3. Counsel review alone does not clear it: the vendor check is separate (R-ADS-7, E441)
-- =============================================================================
RESET ROLE;
UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:ads';
SET LOCAL ROLE app_user;
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.expect_error(pg_temp.approve_sql(:act1), 'R-ADS-7 E441: counsel review without the vendor check: the Owner''s approval is still refused', 'ADS_NOT_CLEARED%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(pg_temp.planned_sql(:run1, :cG1, :cap1, :act1, 3000, 3500),
  'R-ADS-7 E441: counsel review without the vendor check: no planned row either', 'ADS_NOT_CLEARED%');

-- =============================================================================
-- 4. Cleared (counsel review AND rules.vendor_ready_at): 0018's cap check decides as before (R-ADS-2)
-- =============================================================================
RESET ROLE;
UPDATE jurisdiction_packs SET rules = rules || '{"vendor_ready_at": "2026-11-01T00:00:00Z"}' WHERE key = 'platform:ads';
SET LOCAL ROLE app_user;
SELECT pg_temp.ok(app.platform_cleared('platform:ads', true), 'platform:ads is cleared with counsel review and the vendor check');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_deferred_error(pg_temp.planned_sql(:run1, :cG1, :cap1, :act3, 3000, 4000),
  'R-ADS-7 R-ADS-2: once cleared, a shift nobody approved is refused by the cap check', '%AD_SHIFT_NOT_APPROVED%');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.ok(pg_temp.try(pg_temp.approve_sql(:act1)) = 'OK', 'R-ADS-7: once cleared the Owner approves a shift in one tap');
SELECT pg_temp.ok(pg_temp.try(pg_temp.approve_sql(:act4)) = 'OK', 'the Owner approves an over-ceiling shift (the cap check refuses its plan)');
SELECT pg_temp.ctx(:tA, :admA, 'user');
SELECT pg_temp.ok(pg_temp.try(pg_temp.approve_sql(:act2)) = 'OK', 'R-ADS-7: once cleared an Admin approves a shift');
SELECT pg_temp.ok(pg_temp.try(pg_temp.approve_sql(:act5)) = 'OK', 'an Admin approves a shift naming the Meta campaign (the gate refuses its plan)');
SELECT pg_temp.ctx(:tA, NULL, 'system');
-- total today: A 3000 + B 1500 + M 2000 + R 1000 = 7500; act4 takes A to 9000 → 13 500 > 10 000
SELECT pg_temp.expect_deferred_error(pg_temp.planned_sql(:run2, :cG1, :cap1, :act4, 3000, 9000),
  'R-ADS-7 R-ADS-2: once cleared, an approved plan above the daily ceiling is refused by the cap check', '%AD_CAP_EXCEEDED%');
SELECT pg_temp.ok(pg_temp.try(pg_temp.planned_sql(:run1, :cG1, :cap1, :act1, 3000, 3500)) = 'OK',
                  'R-ADS-7: once cleared, the approved shift is planned for the Google Ads campaign');

-- =============================================================================
-- 5. Google Ads only, on a live connection; a campaign the caller cannot see is refused (R-ADS-8, D2, E455)
-- =============================================================================
SELECT pg_temp.expect_error(pg_temp.planned_sql(gen_random_uuid(), :cM, :cap1, :act5, 2000, 2500),
  'R-ADS-8 E455 D2: a planned change for an ads_meta campaign is refused even with an approval naming it', 'ADS_GOOGLE_ONLY%');
SELECT pg_temp.expect_error(pg_temp.planned_sql(gen_random_uuid(), :cR, :cap1, :act1, 1000, 3500),
  'R-ADS-8: a planned change on a revoked Google Ads connection is refused', 'ADS_CONNECTION_NOT_LIVE%');
SELECT pg_temp.expect_error(pg_temp.planned_sql(gen_random_uuid(), gen_random_uuid(), :cap1, :act1, 0, 3500),
  'R-ADS-8: a campaign that does not exist (or that the caller cannot see) is refused at once, before the cap check''s AD_CAMPAIGN_UNKNOWN', 'ADS_GOOGLE_ONLY%');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(pg_temp.planned_sql(gen_random_uuid(), :cG2, :cap1, :act2, 1500, 2000),
  'R-ADS-8: an agent sees no campaign, so the gate refuses the agent''s planned row (fail closed; RLS refuses it too)', 'ADS_GOOGLE_ONLY%');

-- =============================================================================
-- 6. An approval is never edited and keeps its kind; message drafts are unaffected (R-ADS-9, E444)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.expect_error(format($q$UPDATE assistant_actions SET edited_payload = %L::jsonb WHERE id = %L$q$,
  jsonb_build_object('changes', pg_temp.changes(:cG2, 9000)), :act2),
  'R-ADS-9 E444: an approved budget shift''s edited_payload cannot change (a later plan could name an unplanned campaign)', 'AD_APPROVAL_FROZEN%');
SELECT pg_temp.expect_error(format($q$UPDATE assistant_actions SET payload = payload || '{"changes": []}'::jsonb WHERE id = %L$q$, :act2),
  'R-ADS-9 E444: an approved budget shift''s payload cannot change', 'AD_APPROVAL_FROZEN%');
SELECT pg_temp.expect_error(format($q$UPDATE assistant_actions SET kind = 'message_draft', action_category = 'novel_message' WHERE id = %L$q$, :act2),
  'R-ADS-9: an approved budget shift keeps its kind (it cannot leave the gate and come back edited)', 'AD_APPROVAL_FROZEN%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(format($q$UPDATE assistant_actions SET edited_payload = %L::jsonb WHERE id = %L$q$,
  jsonb_build_object('changes', pg_temp.changes(:cG2, 9000)), :act2),
  'R-ADS-9 E444: the system cannot edit an approved budget shift either', 'AD_APPROVAL_FROZEN%');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.ok(pg_temp.try(format($q$UPDATE assistant_actions SET edited_payload = %L::jsonb WHERE id = %L$q$,
                    jsonb_build_object('changes', pg_temp.changes(:cG1, 3600)), :act3)) = 'OK',
                  'R-ADS-9: a shift still proposed may be re-proposed (the freeze starts at approval)');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(pg_temp.try(pg_temp.approve_sql(:actD)) = 'OK', 'the ads gate leaves other kinds alone: an agent''s message draft is approved as before');

-- =============================================================================
-- 7. Withdrawn mid-flight: outcomes and finishing a run are never gated (E442, R-ADS-10)
-- =============================================================================
RESET ROLE;
UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL, rules = rules - 'vendor_ready_at' WHERE key = 'platform:ads';
SET LOCAL ROLE app_user;
SELECT pg_temp.ok(NOT app.platform_cleared('platform:ads', true), 'counsel withdrew platform:ads after the plan');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.ok(pg_temp.try(pg_temp.outcome_sql('applied', :run1, :cG1, :cap1, 3000, 3500, 'APPLIED')) = 'OK',
                  'E442 R-ADS-10: while dark the system still records the applied outcome of a plan made while cleared (a sent call is recorded as it resolves)');
SELECT pg_temp.ok(pg_temp.try(pg_temp.outcome_sql('failed', :run1, :cG1, :cap1, 3000, 3500, 'PACK_WITHDRAWN')) = 'OK',
                  'E442 R-ADS-10: while dark the system still records a failed outcome (PACK_WITHDRAWN)');
SELECT pg_temp.ok(pg_temp.try(pg_temp.outcome_sql('paused', gen_random_uuid(), :cG2, :cap1, 1500, 0, 'MONTHLY_CAP_REACHED')) = 'OK',
                  'E442: a pause (it only lowers spend) is recorded while dark');
SELECT pg_temp.ok(pg_temp.try(format($q$UPDATE assistant_actions SET trigger_ref = trigger_ref || '{"reapplied": ["a0000000-0000-7000-8000-00000000cb01"]}'::jsonb WHERE id = %L$q$, :act1)) = 'OK',
                  'E442 R-ADS-10: while dark the system marks a re-apply on the approved action (trigger_ref)');
SELECT pg_temp.ok(pg_temp.try(format($q$UPDATE assistant_actions SET status = 'executed' WHERE id = %L$q$, :act1)) = 'OK',
                  'E442 R-ADS-10: while dark the system finishes the run it started (executed)');
SELECT pg_temp.expect_error(pg_temp.planned_sql(gen_random_uuid(), :cG2, :cap1, :act2, 1500, 2000),
  'R-ADS-7 E440: withdrawn again, the next planned row is refused although the approval was given while cleared', 'ADS_NOT_CLEARED%');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.expect_error(format($q$UPDATE assistant_actions SET edited_payload = '{"changes": []}'::jsonb WHERE id = %L$q$, :act1),
  'R-ADS-9 E444: an executed budget shift is not edited either', 'AD_APPROVAL_FROZEN%');
SELECT pg_temp.ok((SELECT count(*) FROM ad_allocation_events WHERE event_kind = 'planned') = 1,
                  'exactly one planned row exists: the one approved while cleared');

-- =============================================================================
-- 8. A published bump to an unreviewed version (E443): one published row per key (0001), so the gates read the new
--    version from the next statement; a proposal still pending cannot be approved and nothing is planned
-- =============================================================================
RESET ROLE;
UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now(), rules = rules || '{"vendor_ready_at": "2026-11-01T00:00:00Z"}' WHERE key = 'platform:ads';
SET LOCAL ROLE app_user;
SELECT pg_temp.ok(app.platform_cleared('platform:ads', true), 'E443: platform:ads 2026.11.0 is cleared again before the bump');
RESET ROLE;
UPDATE jurisdiction_packs SET status = 'retired' WHERE key = 'platform:ads' AND version = '2026.11.0';
-- the new version keeps rules.vendor_ready_at: counsel review of it alone is missing
INSERT INTO jurisdiction_packs (key, version, status, rules, reviewed_by_counsel_at, notes)
SELECT key, '2026.11.1', 'published', rules, NULL, 'Smoke bump: not reviewed by counsel.' FROM jurisdiction_packs WHERE key = 'platform:ads' AND version = '2026.11.0';
SET LOCAL ROLE app_user;
SELECT pg_temp.ok(NOT app.platform_cleared('platform:ads', true) AND NOT app.platform_cleared('platform:ads', false),
                  'R-ADS-7 E443: after a bump to the unreviewed 2026.11.1 (vendor check carried over), platform:ads is not cleared from the next statement');
SELECT pg_temp.ok((SELECT status FROM assistant_actions WHERE id = :act3) = 'proposed', 'E443: act3 is still a pending proposal');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.expect_error(pg_temp.approve_sql(:act3), 'R-ADS-7 E443: after the bump the Owner''s approval of a pending proposal is refused', 'ADS_NOT_CLEARED%');
SELECT pg_temp.ctx(:tA, :admA, 'user');
SELECT pg_temp.expect_error(pg_temp.approve_sql(:act3), 'R-ADS-7 E443: after the bump an Admin''s approval of a pending proposal is refused', 'ADS_NOT_CLEARED%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(pg_temp.planned_sql(gen_random_uuid(), :cG2, :cap1, :act2, 1500, 2000),
  'R-ADS-7 E443: after the bump no planned row is written, although the approval was given while cleared', 'ADS_NOT_CLEARED%');
SELECT pg_temp.ok((SELECT count(*) FROM ad_allocation_events WHERE event_kind = 'planned') = 1 AND (SELECT status FROM assistant_actions WHERE id = :act3) = 'proposed',
                  'E443: nothing was recorded after the bump');

SELECT pg_temp.ok(true, 'ALL ADS PACK SMOKE CHECKS PASSED');
ROLLBACK;
