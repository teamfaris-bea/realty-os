-- =============================================================================
-- RLS / integrity smoke test for the FUB parity schema (tags, notes and mentions, logged activity, stage
-- history, custom fields, relationships, templates, smart lists, bulk actions, the removed-phone opt-out fix).
-- Same shape as rls_smoke.sql and rls_smoke_p23.sql: ONE transaction, rolled back; every application step
-- runs as app_user; a failed expectation raises 'FAIL ...'. The fixture (helpers, two tenants, roles,
-- contacts) is the one rls_smoke_p23.sql builds, plus a TC on Alice's deal.
-- Run by packages/db/test/rls_smoke_parity.test.ts. Nothing here names the migration file (it is renumbered).
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
-- a client-portal session: no user, no actor kind, principal 'client', its own portal account
CREATE FUNCTION pg_temp.client(p_tenant uuid, p_account uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.tenant_id', COALESCE(p_tenant::text, ''), true);
  PERFORM set_config('app.user_id', '', true);
  PERFORM set_config('app.actor_kind', '', true);
  PERFORM set_config('app.principal_type', 'client', true);
  PERFORM set_config('app.portal_account_id', COALESCE(p_account::text, ''), true);
  PERFORM set_config('app.ownership_command', '', true);
END $$;
CREATE FUNCTION pg_temp.cmd(p_command uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('app.ownership_command', COALESCE(p_command::text, ''), true); END $$;
CREATE FUNCTION pg_temp.ok(p_cond boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL  %', p_label; END IF;
  RAISE NOTICE 'PASS  %', p_label;
END $$;
CREATE FUNCTION pg_temp.expect_error(p_sql text, p_label text, p_like text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF p_like IS NULL OR SQLERRM LIKE p_like THEN
      RAISE NOTICE 'PASS  % -> %', p_label, SQLERRM;
      RETURN;
    END IF;
    RAISE EXCEPTION 'FAIL  %: unexpected error: %', p_label, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL  %: statement succeeded but must fail', p_label;
END $$;
CREATE FUNCTION pg_temp.rows_affected(p_sql text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; RETURN n; END $$;
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
-- a contact self-created by its owning agent through the ownership protocol
CREATE FUNCTION pg_temp.self_create(p_tenant uuid, p_contact uuid, p_owner uuid, p_name text, p_cmd uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.ctx(p_tenant, p_owner, 'user');
  PERFORM pg_temp.cmd(p_cmd);
  INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, owner_user_id,
         actor_kind, actor_user_id, reason_code, command_id, occurred_at)
  VALUES (p_tenant, p_contact, 1, gen_random_uuid(), 'created', NULL, 'owned', p_owner, 'user', p_owner, 'SELF_CREATED', p_cmd, now());
  INSERT INTO contacts (tenant_id, id, display_name, ownership_state, owner_user_id, owned_at, ownership_period_seq, ownership_seq,
         ownership_command_id, ownership_actor_user_id, created_by_user_id)
  VALUES (p_tenant, p_contact, p_name, 'owned', p_owner, now(), 1, 1, p_cmd, p_owner, p_owner);
  PERFORM pg_temp.cmd(NULL);
END $$;

\set tA     '''a0000000-0000-7000-8000-000000000001'''
\set tB     '''b0000000-0000-7000-8000-000000000001'''
\set ownA   '''a0000000-0000-7000-8000-0000000000a0'''
\set agA1   '''a0000000-0000-7000-8000-0000000000a1'''
\set agA2   '''a0000000-0000-7000-8000-0000000000a2'''
\set tlA    '''a0000000-0000-7000-8000-0000000000a3'''
\set admA   '''a0000000-0000-7000-8000-0000000000ad'''
\set ownB   '''b0000000-0000-7000-8000-0000000000b0'''
\set polA   '''a0000000-0000-7000-8000-00000000c001'''
\set pondA  '''a0000000-0000-7000-8000-00000000d001'''
\set teamA  '''a0000000-0000-7000-8000-00000000f001'''
\set c1     '''a0000000-0000-7000-8000-00000000e001'''
\set c2     '''a0000000-0000-7000-8000-00000000e002'''
\set c3     '''a0000000-0000-7000-8000-00000000e003'''
\set c4     '''a0000000-0000-7000-8000-00000000e004'''
\set c5     '''a0000000-0000-7000-8000-00000000e005'''
\set c6     '''a0000000-0000-7000-8000-00000000e006'''
\set cB     '''b0000000-0000-7000-8000-00000000e001'''
\set srcA   '''a0000000-0000-7000-8000-000000005001'''
\set srcB   '''b0000000-0000-7000-8000-000000005001'''
\set credA  '''a0000000-0000-7000-8000-00000000cd01'''
\set credM  '''a0000000-0000-7000-8000-00000000cd02'''
\set credAd '''a0000000-0000-7000-8000-00000000cd03'''
\set credB  '''b0000000-0000-7000-8000-00000000cd01'''
\set icA    '''a0000000-0000-7000-8000-00000000ac01'''
\set mlsA   '''a0000000-0000-7000-8000-00000000ac02'''
\set icIG   '''a0000000-0000-7000-8000-00000000ac03'''
\set wcA    '''a0000000-0000-7000-8000-00000000ac04'''
\set adsA   '''a0000000-0000-7000-8000-00000000ac05'''
\set cvA    '''a0000000-0000-7000-8000-00000000cc01'''
\set cvA2   '''a0000000-0000-7000-8000-00000000cc02'''
\set cvA4   '''a0000000-0000-7000-8000-00000000cc04'''
\set cvA6   '''a0000000-0000-7000-8000-00000000cc06'''
\set dA1    '''a0000000-0000-7000-8000-00000000de01'''
\set dA2    '''a0000000-0000-7000-8000-00000000de02'''
\set dA3    '''a0000000-0000-7000-8000-00000000de03'''
\set lA     '''a0000000-0000-7000-8000-00000000f1aa'''
\set lC     '''a0000000-0000-7000-8000-00000000f1cc'''
\set lM     '''a0000000-0000-7000-8000-00000000f1a1'''
\set num    '''a0000000-0000-7000-8000-00000000a0a1'''
\set eid    '''a0000000-0000-7000-8000-00000000e1d1'''
\set PH     '''$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA'''
\set SHA    'repeat(''ab'', 32)'

-- =============================================================================
-- 0. Two tenants; in A an Owner, an Admin, a Team Lead (team: agent 1) and two agents; an Owner in B
-- =============================================================================
SELECT pg_temp.ctx(NULL, :ownA, 'user');
INSERT INTO users (id, email, display_name, password_hash) VALUES (:ownA, 'owner-a@example.test', 'Olivia Owner', :PH);
SELECT app.provision_tenant(:tA, 'team-a', 'Team A', 'America/New_York', 'A Realty LLC', :ownA, :polA,
       :teamA, :pondA, '\x01', '\x02', '\x03', 'kek-dev');
SELECT pg_temp.ctx(NULL, :ownB, 'user');
INSERT INTO users (id, email, display_name, password_hash) VALUES (:ownB, 'owner-b@example.test', 'Oscar Owner', :PH);
SELECT app.provision_tenant(:tB, 'team-b', 'Team B', 'America/Chicago', 'B Brokers Inc', :ownB,
       'b0000000-0000-7000-8000-00000000c001', 'b0000000-0000-7000-8000-00000000f001',
       'b0000000-0000-7000-8000-00000000d001', '\x01', '\x02', '\x03', 'kek-dev');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO invites (tenant_id, id, email, role, token_hash, invited_by_user_id, expires_at) VALUES
  (:tA, 'a0000000-0000-7000-8000-0000000001a1', 'agent1@example.test', 'agent', digest('p23-invite-a1', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a0000000-0000-7000-8000-0000000001a2', 'agent2@example.test', 'agent', digest('p23-invite-a2', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a0000000-0000-7000-8000-0000000001a3', 'lead@example.test', 'team_lead', digest('p23-invite-a3', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a0000000-0000-7000-8000-0000000001ad', 'admin@example.test', 'admin', digest('p23-invite-ad', 'sha256'), :ownA, now() + interval '1 day');
SELECT pg_temp.ctx(NULL, NULL, NULL);
SELECT FROM auth.accept_invite(digest('p23-invite-a1', 'sha256'), :agA1, 'Ava Agent', :PH, now());
SELECT FROM auth.accept_invite(digest('p23-invite-a2', 'sha256'), :agA2, 'Ben Agent', :PH, now());
SELECT FROM auth.accept_invite(digest('p23-invite-a3', 'sha256'), :tlA, 'Tess Lead', :PH, now());
SELECT FROM auth.accept_invite(digest('p23-invite-ad', 'sha256'), :admA, 'Adam Admin', :PH, now());
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO team_members (tenant_id, team_id, user_id, is_lead) VALUES (:tA, :teamA, :tlA, true), (:tA, :teamA, :agA1, false);
INSERT INTO phone_numbers (tenant_id, id, e164, provider, provider_ref, number_type, purpose, sms_capable, voice_capable, acquired_at)
VALUES (:tA, :num, '+15555559100', 'fake', 'PN1', 'local', 'team_main', true, true, now());
INSERT INTO email_identities (tenant_id, id, from_address, display_name) VALUES (:tA, :eid, 'team@a-realty.test', 'Team A');
INSERT INTO lead_sources (tenant_id, id, name, kind) VALUES (:tA, :srcA, 'Facebook Page', 'social_dm');

-- Alice, Dora, Eve and Finn belong to agent 1; Carol and her duplicate to agent 2
SELECT pg_temp.self_create(:tA, :c1, :agA1, 'Alice Buyer', 'a0000000-0000-7000-8000-0000000c0001');
SELECT pg_temp.self_create(:tA, :c3, :agA1, 'Dora Buyer', 'a0000000-0000-7000-8000-0000000c0003');
SELECT pg_temp.self_create(:tA, :c5, :agA1, 'Eve Prospect', 'a0000000-0000-7000-8000-0000000c0005');
SELECT pg_temp.self_create(:tA, :c6, :agA1, 'Finn Prospect', 'a0000000-0000-7000-8000-0000000c0006');
SELECT pg_temp.self_create(:tA, :c2, :agA2, 'Carol Seller', 'a0000000-0000-7000-8000-0000000c0002');
SELECT pg_temp.self_create(:tA, :c4, :agA2, 'Carol S. (duplicate)', 'a0000000-0000-7000-8000-0000000c0004');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, is_primary)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000f201', :c2, 'email', 'carol@example.test', digest('carol@example.test', 'sha256'), true),
       (:tA, 'a0000000-0000-7000-8000-00000000f202', :c2, 'phone', '+15555550202', digest('+15555550202', 'sha256'), true);
INSERT INTO conversations (tenant_id, id, contact_id) VALUES (:tA, :cvA2, :c2), (:tA, :cvA4, :c4);
INSERT INTO listings (tenant_id, id, source, status, address_line1, city, region, postal_code, listing_agent_user_id, list_price_cents)
VALUES (:tA, :lC, 'team', 'active', '40 Elm St', 'Town', 'SC', '29401', :agA2, 52000000);
INSERT INTO listing_contacts (tenant_id, listing_id, contact_id, role) VALUES (:tA, :lC, :c2, 'seller');
INSERT INTO deals (tenant_id, id, name, side, stage_entered_at, primary_contact_id, owner_user_id, listing_id, created_by_user_id)
VALUES (:tA, :dA2, 'Carol sale', 'sell', now(), :c2, :agA2, :lC, :agA2);
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000f103', :c1, 'email', 'alice@example.test', digest('alice@example.test', 'sha256')),
       (:tA, 'a0000000-0000-7000-8000-00000000f303', :c3, 'email', 'dora@example.test', digest('dora@example.test', 'sha256')),
       (:tA, 'a0000000-0000-7000-8000-00000000f601', :c6, 'email', 'finn@example.test', digest('finn@example.test', 'sha256'));
INSERT INTO conversations (tenant_id, id, contact_id) VALUES (:tA, :cvA, :c1), (:tA, :cvA6, :c6);
INSERT INTO listings (tenant_id, id, source, status, address_line1, city, region, postal_code, listing_agent_user_id, list_price_cents)
VALUES (:tA, :lA, 'team', 'active', '12 Oak St', 'Town', 'SC', '29401', :agA1, 45000000);
INSERT INTO deals (tenant_id, id, name, side, stage_entered_at, primary_contact_id, owner_user_id, created_by_user_id)
VALUES (:tA, :dA1, 'Alice purchase', 'buy', now(), :c1, :agA1, :agA1),
       (:tA, :dA3, 'Dora purchase', 'buy', now(), :c3, :agA1, :agA1);

-- tenant B's contact (system, pond)
SELECT pg_temp.ctx(:tB, NULL, 'system');
SELECT pg_temp.cmd('b0000000-0000-7000-8000-0000000c0001');
INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, pond_id,
       actor_kind, reason_code, command_id, occurred_at)
VALUES (:tB, :cB, 1, gen_random_uuid(), 'created', NULL, 'in_pond', 'b0000000-0000-7000-8000-00000000d001', 'system',
        'NO_RULE_MATCH', 'b0000000-0000-7000-8000-0000000c0001', now());
INSERT INTO contacts (tenant_id, id, display_name, ownership_state, pond_id, ownership_seq, ownership_command_id)
VALUES (:tB, :cB, 'Bob Seller', 'in_pond', 'b0000000-0000-7000-8000-00000000d001', 1, 'b0000000-0000-7000-8000-0000000c0001');
SELECT pg_temp.cmd(NULL);
INSERT INTO lead_sources (tenant_id, id, name, kind) VALUES (:tB, :srcB, 'B Facebook', 'social_dm');


\set tcA    '''a0000000-0000-7000-8000-0000000000ac'''
\set tgBuy  '''a0000000-0000-7000-8000-0000000a7001'''
\set tgVA   '''a0000000-0000-7000-8000-0000000a7002'''
\set n1     '''a0000000-0000-7000-8000-0000000a8001'''
\set n2     '''a0000000-0000-7000-8000-0000000a8002'''
\set fBud   '''a0000000-0000-7000-8000-0000000a9001'''
\set fBeds  '''a0000000-0000-7000-8000-0000000a9002'''
\set fBday  '''a0000000-0000-7000-8000-0000000a9003'''
\set fMil   '''a0000000-0000-7000-8000-0000000a9004'''
\set rel1   '''a0000000-0000-7000-8000-0000000aa001'''
\set rel2   '''a0000000-0000-7000-8000-0000000aa002'''
\set tplT   '''a0000000-0000-7000-8000-0000000ab001'''
\set tplP   '''a0000000-0000-7000-8000-0000000ab002'''
\set slT    '''a0000000-0000-7000-8000-0000000ac001'''
\set slP    '''a0000000-0000-7000-8000-0000000ac002'''
\set bk1    '''a0000000-0000-7000-8000-0000000ad001'''
\set bkE    '''a0000000-0000-7000-8000-0000000ad002'''
\set bkT    '''a0000000-0000-7000-8000-0000000ad003'''

-- a TC on Alice's purchase (sees Alice through the deal, nobody else)
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO invites (tenant_id, id, email, role, token_hash, invited_by_user_id, expires_at) VALUES
  (:tA, 'a0000000-0000-7000-8000-0000000001ac', 'tc@example.test', 'tc', digest('par-invite-tc', 'sha256'), :ownA, now() + interval '1 day');
SELECT pg_temp.ctx(NULL, NULL, NULL);
SELECT FROM auth.accept_invite(digest('par-invite-tc', 'sha256'), :tcA, 'Tara Coordinator', :PH, now());
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO deal_members (tenant_id, deal_id, user_id, role) VALUES (:tA, :dA1, :tcA, 'tc');

-- visible-row counter for one table and one contact under the current context
CREATE FUNCTION pg_temp.n(p_sql text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE r bigint; BEGIN EXECUTE p_sql INTO r; RETURN r; END $$;

-- =============================================================================
-- 1. Tags: a catalog, case-insensitive, members create, Owner/Admin manage; a contact's tags follow its detail
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO tags (tenant_id, id, name, created_by_kind, created_by_user_id) VALUES (:tA, :tgBuy, 'Buyer', 'user', :agA1);
SELECT pg_temp.expect_error(format($q$INSERT INTO tags (tenant_id, id, name, created_by_kind, created_by_user_id)
  VALUES (%L, gen_random_uuid(), 'BUYER', 'user', %L)$q$, :tA, :agA1),
  'R-PAR-6: tag names are unique per team regardless of case', '%tags_tenant_id_name_key_key%');
SELECT pg_temp.expect_error(format($q$INSERT INTO tags (tenant_id, id, name, created_by_kind, created_by_user_id)
  VALUES (%L, gen_random_uuid(), ' Seller', 'user', %L)$q$, :tA, :agA1),
  'tag names are stored trimmed', '%tags_name_check%');
SELECT pg_temp.ok(pg_temp.rows_affected(format($q$UPDATE tags SET name = 'Buyers' WHERE id = %L$q$, :tgBuy)) = 0,
  'R-PAR-9: an agent cannot rename a tag (0 rows)');
INSERT INTO contact_tags (tenant_id, contact_id, tag_id, added_by_kind, added_by_user_id) VALUES
  (:tA, :c1, :tgBuy, 'user', :agA1), (:tA, :c3, :tgBuy, 'user', :agA1);
SELECT pg_temp.expect_error(format($q$INSERT INTO contact_tags (tenant_id, contact_id, tag_id, added_by_kind, added_by_user_id)
  VALUES (%L, %L, %L, 'user', %L)$q$, :tA, :c2, :tgBuy, :agA1),
  'R-PAR-7: an agent cannot tag a person they cannot see', '%row-level security%');
SELECT pg_temp.expect_error(format($q$INSERT INTO contact_tags (tenant_id, contact_id, tag_id, added_by_kind, added_by_user_id)
  VALUES (%L, %L, %L, 'user', %L)$q$, :tA, :c5, :tgBuy, :agA2),
  'a tag is added as oneself', '%row-level security%');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
INSERT INTO contact_tags (tenant_id, contact_id, tag_id, added_by_kind, added_by_user_id) VALUES (:tA, :c2, :tgBuy, 'user', :agA2);
SELECT pg_temp.ok(pg_temp.n(format('SELECT count(*) FROM contact_tags WHERE contact_id = %L', :c1)) = 0
              AND pg_temp.n(format('SELECT count(*) FROM contact_tags WHERE contact_id = %L', :c2)) = 1,
  'R-PAR-7: agent 2 sees Carol''s tags and not Alice''s');
SELECT pg_temp.ok(pg_temp.n('SELECT count(*) FROM tags') = 1, 'R-PAR-6: the tag catalog is team metadata every member reads');
SELECT pg_temp.ctx(:tA, :tlA, 'user');
SELECT pg_temp.ok(pg_temp.n('SELECT count(*) FROM contact_tags') = 2,
  'the Team Lead sees the tags of the team''s people (Alice, Dora) and not of agent 2''s Carol');
SELECT pg_temp.ctx(:tA, :tcA, 'user');
SELECT pg_temp.ok(pg_temp.n('SELECT count(*) FROM contact_tags') = 1, 'the TC sees only Alice''s tag (her deal)');
SELECT pg_temp.expect_error(format($q$INSERT INTO contact_tags (tenant_id, contact_id, tag_id, added_by_kind, added_by_user_id)
  VALUES (%L, %L, %L, 'user', %L)$q$, :tA, :c1, :tgVA, :tcA),
  'a TC does not tag people', '%row-level security%');
SELECT pg_temp.expect_error(format($q$INSERT INTO tags (tenant_id, id, name, created_by_kind, created_by_user_id)
  VALUES (%L, gen_random_uuid(), 'TC tag', 'user', %L)$q$, :tA, :tcA),
  'a TC does not create tags', '%row-level security%');
SELECT pg_temp.ctx(:tA, :admA, 'user');
SELECT pg_temp.ok(pg_temp.n('SELECT count(*) FROM contact_tags') = 3, 'the Admin sees every contact''s tags');
UPDATE tags SET name = 'Buyers', color = 'blue' WHERE id = :tgBuy;
SELECT pg_temp.ok((SELECT name_key FROM tags WHERE id = :tgBuy) = 'buyers', 'R-PAR-9: an Admin renames a tag in one row');
INSERT INTO tags (tenant_id, id, name, created_by_kind, created_by_user_id, protected_proxy) VALUES (:tA, :tgVA, 'VA buyer', 'user', :admA, true);
SELECT pg_temp.expect_error(format($q$UPDATE tags SET protected_proxy = false WHERE id = %L$q$, :tgVA),
  'R-PAR-8: only the Owner lifts a tag''s fair-housing protection', '%TAG_PROTECTION_OWNER_ONLY%');
SELECT pg_temp.ctx(:tA, :ownB, 'user');
SELECT pg_temp.ok(pg_temp.n('SELECT count(*) FROM tags') + pg_temp.n('SELECT count(*) FROM contact_tags') = 0,
  'R-TEN-1: tenant B reads none of tenant A''s tags');
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*) FROM pg_trigger WHERE tgname = 'contact_tags_limit') = 1
              AND (SELECT prosrc LIKE '%>= 100%' FROM pg_proc WHERE proname = 'contact_tags_limit'),
  'R-PAR-6: a person carries at most 100 tags');
SET LOCAL ROLE app_user;

-- =============================================================================
-- 2. Notes, mentions and logged activity (R-PAR-1..5, R-PAR-30..32)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body) VALUES (:tA, :n1, :c1, :agA1, 'Pre-approved to 450k. @Tess please review.');
INSERT INTO note_mentions (tenant_id, note_id, user_id) VALUES (:tA, :n1, :tlA), (:tA, :n1, :agA2);
SELECT pg_temp.expect_error(format($q$INSERT INTO note_mentions (tenant_id, note_id, user_id) VALUES (%L, %L, %L)$q$, :tA, :n1, :agA1),
  'R-PAR-3: a note does not mention its author', '%MENTION_SELF%');
SELECT pg_temp.ok(pg_temp.rows_affected(format($q$UPDATE note_mentions SET status = 'notified', resolved_at = now() WHERE note_id = %L$q$, :n1)) = 0,
  'R-PAR-2: only the system resolves a mention (the author cannot mark it notified: 0 rows)');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok(pg_temp.n(format('SELECT count(*) FROM notes WHERE id = %L', :n1)) = 0
              AND pg_temp.n(format('SELECT count(*) FROM note_mentions WHERE note_id = %L', :n1)) = 0,
  'R-PAR-2: a mentioned user who cannot see Alice reads neither the note nor its mention rows');
SELECT pg_temp.expect_error(format($q$INSERT INTO note_mentions (tenant_id, note_id, user_id) VALUES (%L, %L, %L)$q$, :tA, :n1, :ownA),
  'only the note''s author adds mentions', '%row-level security%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
UPDATE note_mentions SET status = 'no_access', resolved_at = now() WHERE note_id = :n1 AND user_id = :agA2;
INSERT INTO notifications (tenant_id, id, user_id, kind, priority, title, subject_type, subject_id, dedupe_key)
VALUES (:tA, gen_random_uuid(), :tlA, 'mention', 'normal', 'Ava mentioned you', 'note', :n1, 'mention:' || :n1);
UPDATE note_mentions SET status = 'notified', resolved_at = now(),
       notification_id = (SELECT id FROM notifications WHERE user_id = :tlA AND kind = 'mention')
 WHERE note_id = :n1 AND user_id = :tlA;
SELECT pg_temp.ok((SELECT string_agg(status, ',' ORDER BY status) FROM note_mentions WHERE note_id = :n1) = 'no_access,notified',
  'R-PAR-2: the system notifies the Team Lead (who sees Alice) and records no_access for agent 2');
SELECT pg_temp.ctx(:tA, :tlA, 'user');
SELECT pg_temp.ok(pg_temp.n(format('SELECT count(*) FROM notes WHERE id = %L', :n1)) = 1
              AND (SELECT body IS NULL FROM notifications WHERE kind = 'mention'),
  'R-PAR-3: the mentioned Team Lead opens the note; the notification carries no note text');
SELECT pg_temp.ctx(:tA, :tcA, 'user');
SELECT pg_temp.ok(pg_temp.n(format('SELECT count(*) FROM notes WHERE id = %L', :n1)) = 1, 'R-PAR-1: the TC on Alice''s deal reads her notes');
SELECT pg_temp.ctx(:tA, :admA, 'user');
SELECT pg_temp.expect_error(format($q$UPDATE notes SET body = 'rewritten' WHERE id = %L$q$, :n1),
  'R-PAR-4: only the author edits a note, not even an Admin', '%NOTE_AUTHOR_ONLY%');
UPDATE notes SET pinned = true WHERE id = :n1;
SELECT pg_temp.ok((SELECT pinned FROM notes WHERE id = :n1), 'an Admin may pin a note');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
UPDATE notes SET body = 'Pre-approved to 475k.' WHERE id = :n1;
SELECT pg_temp.ok((SELECT edited_at IS NOT NULL FROM notes WHERE id = :n1), 'R-PAR-4: the author''s edit is marked edited');
SELECT pg_temp.expect_error(format($q$UPDATE notes SET contact_id = %L WHERE id = %L$q$, :c3, :n1),
  'a note keeps its parent', '%NOTE_IMMUTABLE%');
-- logged outside activity
INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body, source, activity_kind, activity_direction, activity_at, activity_outcome)
VALUES (:tA, :n2, :c1, :agA1, 'Called from my cell; she wants Saturday showings.', 'logged_activity', 'call', 'outbound',
        now() - interval '2 hours', 'connected');
SELECT pg_temp.expect_error(format($q$INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body, source, activity_kind, activity_at)
  VALUES (%L, gen_random_uuid(), %L, %L, 'x', 'logged_activity', 'call', now() + interval '1 day')$q$, :tA, :c1, :agA1),
  'R-PAR-31: a logged activity cannot be dated in the future', '%notes_activity_at_window%');
SELECT pg_temp.expect_error(format($q$INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body, source)
  VALUES (%L, gen_random_uuid(), %L, %L, 'x', 'logged_activity')$q$, :tA, :c1, :agA1),
  'R-PAR-30: a logged activity names what happened and when', '%notes_logged_activity_shape%');
SELECT pg_temp.expect_error(format($q$INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body, source, activity_kind, activity_at, activity_outcome)
  VALUES (%L, gen_random_uuid(), %L, %L, 'x', 'logged_activity', 'email', now(), 'connected')$q$, :tA, :c1, :agA1),
  'only a logged call has a call outcome', '%notes_logged_activity_shape%');
SELECT pg_temp.expect_error(format($q$UPDATE notes SET activity_at = now() - interval '1 day' WHERE id = %L$q$, :n2),
  'R-PAR-31: logged facts never change after save', '%NOTE_IMMUTABLE%');
SELECT pg_temp.ok((SELECT detail FROM contact_timeline WHERE item_id = :n2) = 'logged_activity:call'
              AND (SELECT occurred_at < now() - interval '1 hour' FROM contact_timeline WHERE item_id = :n2),
  'R-PAR-30: the timeline shows a logged call when it happened, labelled as logged');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM v_agent_activity_daily WHERE user_id = :agA1 AND touches > 0),
  'R-PAR-32: a logged call is not a touch');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok(pg_temp.rows_affected(format('DELETE FROM notes WHERE id = %L', :n2)) = 0, 'another agent cannot delete the note');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(pg_temp.rows_affected(format('DELETE FROM notes WHERE id = %L', :n2)) = 1, 'R-PAR-4: the author deletes their own note');

-- =============================================================================
-- 3. Stages: append-only history by trigger; an untouched routed lead is not parked (R-PAR-13..15)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA1, 'user');
UPDATE contacts SET stage = 'connected' WHERE id = :c1;
SELECT pg_temp.ok((SELECT from_stage = 'new' AND to_stage = 'connected' AND actor_kind = 'user' AND actor_user_id = :agA1
                     FROM contact_stage_events WHERE contact_id = :c1),
  'R-PAR-15: a stage change writes its history row, attributed to the person');
SELECT pg_temp.expect_error(format($q$INSERT INTO contact_stage_events (tenant_id, id, contact_id, to_stage, actor_kind)
  VALUES (%L, gen_random_uuid(), %L, 'closed', 'system')$q$, :tA, :c1),
  'R-PAR-15: nobody writes stage history by hand', '%permission denied%');
RESET ROLE;
SELECT pg_temp.expect_error(format($q$UPDATE contact_stage_events SET to_stage = 'lost' WHERE contact_id = %L$q$, :c1),
  'R-PAR-15: stage history never changes', '%APPEND_ONLY%');
-- platform maintenance: give Finn a routed SLA period nobody has met yet
SET LOCAL session_replication_role = replica;
UPDATE contacts SET first_touch_due_at = now() + interval '10 minutes' WHERE id = :c6;
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE app_user;
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format($q$UPDATE contacts SET stage = 'nurture' WHERE id = %L$q$, :c6),
  'R-PAR-14: an agent cannot park an untouched routed lead in nurture', '%STAGE_NEEDS_CONTACT%');
SELECT pg_temp.ctx(:tA, :tlA, 'user');
UPDATE contacts SET stage = 'nurture' WHERE id = :c6;
SELECT pg_temp.ok((SELECT stage FROM contacts WHERE id = :c6) = 'nurture', 'R-PAR-14: the Team Lead may (audited by the API)');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok(pg_temp.n(format('SELECT count(*) FROM contact_stage_events WHERE contact_id IN (%L, %L)', :c1, :c6)) = 0,
  'stage history is visible exactly when the contact''s detail is');
SELECT pg_temp.ctx(:tA, :admA, 'user');
SELECT pg_temp.expect_error($q$UPDATE tenant_settings SET stage_labels = '{"hot": "Hot"}'$q$,
  'R-PAR-13: a label renames one of the eight stages, nothing else', '%STAGE_LABEL_INVALID%');
UPDATE tenant_settings SET stage_labels = '{"active": "Hot"}';
SELECT pg_temp.ok((SELECT stage_labels->>'active' FROM tenant_settings) = 'Hot', 'R-PAR-13: an Admin relabels a fixed stage');

-- =============================================================================
-- 4. Custom fields: typed, limited, Owner/Admin define; values follow the contact (R-PAR-17..20)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO custom_field_defs (tenant_id, id, key, label, field_type, created_by_user_id)
  VALUES (%L, gen_random_uuid(), 'budget', 'Budget', 'number', %L)$q$, :tA, :agA1),
  'R-PAR-17: an agent cannot define a custom field', '%row-level security%');
SELECT pg_temp.ctx(:tA, :admA, 'user');
INSERT INTO custom_field_defs (tenant_id, id, key, label, field_type, options, annual, protected_proxy, created_by_user_id) VALUES
  (:tA, :fBud,  'budget', 'Budget', 'number', '[]', false, false, :admA),
  (:tA, :fBeds, 'beds', 'Bedrooms wanted', 'single_select', '[{"id":"b2","label":"2"},{"id":"b3","label":"3"},{"id":"b4","label":"4+"}]', false, false, :admA),
  (:tA, :fBday, 'birthday', 'Birthday', 'date', '[]', true, false, :admA),
  (:tA, :fMil,  'service_branch', 'Service branch', 'text', '[]', false, true, :admA);
SELECT pg_temp.expect_error(format($q$INSERT INTO custom_field_defs (tenant_id, id, key, label, field_type, created_by_user_id)
  VALUES (%L, gen_random_uuid(), 'military_status', 'Military status', 'text', %L)$q$, :tA, :admA),
  'R-PAR-18: a custom field cannot recreate a built-in protected attribute', '%custom_field_defs_key_check%');
SELECT pg_temp.expect_error(format($q$INSERT INTO custom_field_defs (tenant_id, id, key, label, field_type, annual, created_by_user_id)
  VALUES (%L, gen_random_uuid(), 'zip', 'Zip', 'text', true, %L)$q$, :tA, :admA),
  'only a date field recurs every year', '%custom_field_defs_check%');
SELECT pg_temp.expect_error(format($q$UPDATE custom_field_defs SET field_type = 'text' WHERE id = %L$q$, :fBud),
  'R-PAR-17: a field keeps its type', '%CUSTOM_FIELD_IMMUTABLE%');
SELECT pg_temp.expect_error(format($q$UPDATE custom_field_defs SET options = '[{"id":"b2","label":"2"}]' WHERE id = %L$q$, :fBeds),
  'R-PAR-17: an option is archived, never removed', '%CUSTOM_FIELD_OPTION_REMOVED%');
DO $$
BEGIN
  FOR i IN 1..46 LOOP
    INSERT INTO custom_field_defs (tenant_id, id, key, label, field_type, created_by_user_id)
    VALUES ('a0000000-0000-7000-8000-000000000001', gen_random_uuid(), 'extra_' || i, 'Extra ' || i, 'text',
            'a0000000-0000-7000-8000-0000000000ad');
  END LOOP;
END $$;
SELECT pg_temp.expect_error(format($q$INSERT INTO custom_field_defs (tenant_id, id, key, label, field_type, created_by_user_id)
  VALUES (%L, gen_random_uuid(), 'one_too_many', 'One too many', 'text', %L)$q$, :tA, :admA),
  'R-PAR-17: a team has at most 50 live custom fields', '%CUSTOM_FIELD_LIMIT%');
UPDATE custom_field_defs SET archived_at = now() WHERE key = 'extra_46';
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO contact_field_values (tenant_id, contact_id, field_id, value_number, updated_by_kind, updated_by_user_id)
VALUES (:tA, :c1, :fBud, 475000, 'user', :agA1);
INSERT INTO contact_field_values (tenant_id, contact_id, field_id, value_options, updated_by_kind, updated_by_user_id)
VALUES (:tA, :c1, :fBeds, '{b3}', 'user', :agA1);
INSERT INTO contact_field_values (tenant_id, contact_id, field_id, value_date, updated_by_kind, updated_by_user_id)
VALUES (:tA, :c1, :fBday, '1990-06-14', 'user', :agA1);
SELECT pg_temp.expect_error(format($q$INSERT INTO contact_field_values (tenant_id, contact_id, field_id, value_text, updated_by_kind, updated_by_user_id)
  VALUES (%L, %L, %L, 'lots', 'user', %L)$q$, :tA, :c3, :fBud, :agA1),
  'R-PAR-17: a value has its field''s type', '%CUSTOM_VALUE_TYPE%');
SELECT pg_temp.expect_error(format($q$INSERT INTO contact_field_values (tenant_id, contact_id, field_id, value_options, updated_by_kind, updated_by_user_id)
  VALUES (%L, %L, %L, '{b2,b3}', 'user', %L)$q$, :tA, :c3, :fBeds, :agA1),
  'a single select holds one option', '%CUSTOM_VALUE_TYPE%');
SELECT pg_temp.expect_error(format($q$INSERT INTO contact_field_values (tenant_id, contact_id, field_id, value_options, updated_by_kind, updated_by_user_id)
  VALUES (%L, %L, %L, '{b9}', 'user', %L)$q$, :tA, :c3, :fBeds, :agA1),
  'a select value is a live option', '%CUSTOM_VALUE_OPTION%');
SELECT pg_temp.expect_error(format($q$INSERT INTO contact_field_values (tenant_id, contact_id, field_id, value_text, updated_by_kind, updated_by_user_id)
  VALUES (%L, %L, %L, 'Army', 'user', %L)$q$, :tA, :c1, :fMil, :agA1),
  'R-PAR-18: a protected field holds only what the person said (self-reported)', '%CUSTOM_VALUE_SELF_REPORTED%');
INSERT INTO contact_field_values (tenant_id, contact_id, field_id, value_text, self_reported, updated_by_kind, updated_by_user_id)
VALUES (:tA, :c1, :fMil, 'Army', true, 'user', :agA1);
SELECT pg_temp.expect_error(format($q$INSERT INTO contact_field_values (tenant_id, contact_id, field_id, value_text, updated_by_kind, updated_by_user_id)
  SELECT %L, %L, id, 'x', 'user', %L FROM custom_field_defs WHERE key = 'extra_46'$q$, :tA, :c1, :agA1),
  'R-PAR-17: an archived field is read-only', '%CUSTOM_FIELD_ARCHIVED%');
SELECT pg_temp.expect_error(format($q$INSERT INTO contact_field_values (tenant_id, contact_id, field_id, value_number, updated_by_kind, updated_by_user_id)
  VALUES (%L, %L, %L, 1, 'user', %L)$q$, :tA, :c2, :fBud, :agA1),
  'R-PAR-19: no value is written on a person the writer cannot see', '%row-level security%');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok(pg_temp.n(format('SELECT count(*) FROM contact_field_values WHERE contact_id = %L', :c1)) = 0
              AND pg_temp.n('SELECT count(*) FROM custom_field_defs') = 50,
  'R-PAR-19: agent 2 reads the field definitions but none of Alice''s values');
SELECT pg_temp.ctx(:tA, :tcA, 'user');
SELECT pg_temp.ok(pg_temp.n('SELECT count(*) FROM contact_field_values') = 4, 'the TC reads Alice''s values through her deal');
SELECT pg_temp.expect_error(format($q$INSERT INTO contact_field_values (tenant_id, contact_id, field_id, value_number, updated_by_kind, updated_by_user_id)
  VALUES (%L, %L, %L, 1, 'user', %L)$q$, :tA, :c3, :fBud, :tcA),
  'a TC does not write custom values', '%row-level security%');
SELECT pg_temp.ctx(:tA, :ownB, 'user');
SELECT pg_temp.ok(pg_temp.n('SELECT count(*) FROM contact_field_values') + pg_temp.n('SELECT count(*) FROM custom_field_defs') = 0,
  'R-TEN-1: tenant B reads none of tenant A''s fields or values');

-- =============================================================================
-- 5. Relationships: a row exists for a viewer only when both people are visible to them (R-PAR-21, R-PAR-22)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO contact_relationships (tenant_id, id, contact_id, related_contact_id, kind, created_by_user_id)
VALUES (:tA, :rel1, :c1, :c3, 'co_buyer', :agA1);
SELECT pg_temp.expect_error(format($q$INSERT INTO contact_relationships (tenant_id, id, contact_id, related_contact_id, kind, created_by_user_id)
  VALUES (%L, gen_random_uuid(), %L, %L, 'spouse_partner', %L)$q$, :tA, :c1, :c2, :agA1),
  'R-PAR-21: nobody links a person they cannot see', '%row-level security%');
SELECT pg_temp.expect_error(format($q$INSERT INTO contact_relationships (tenant_id, id, contact_id, related_contact_id, kind, created_by_user_id)
  VALUES (%L, gen_random_uuid(), %L, %L, 'co_buyer', %L)$q$, :tA, :c3, :c1, :agA1),
  'one row per pair and kind, whichever way round', '%contact_relationships_pair%');
SELECT pg_temp.ctx(:tA, :admA, 'user');
INSERT INTO contact_relationships (tenant_id, id, contact_id, related_contact_id, kind, created_by_user_id)
VALUES (:tA, :rel2, :c1, :c2, 'family', :admA);
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(pg_temp.n('SELECT count(*) FROM contact_relationships') = 1,
  'R-PAR-21: agent 1 sees Alice-Dora but not Alice-Carol (no hidden count)');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok(pg_temp.n('SELECT count(*) FROM contact_relationships') = 0,
  'R-PAR-21: agent 2 (sees Carol, not Alice) sees no relationship at all');
SELECT pg_temp.ctx(:tA, :tcA, 'user');
SELECT pg_temp.ok(pg_temp.n('SELECT count(*) FROM contact_relationships') = 0,
  'the TC sees Alice but not Dora: no relationship');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.ok(pg_temp.n('SELECT count(*) FROM contact_relationships') = 2, 'the Owner sees both');

-- =============================================================================
-- 6. Templates: team ones are Owner/Admin's; personal ones are their owner's alone (R-PAR-23..26)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO message_templates (tenant_id, id, scope, channel, name, body, updated_by_user_id)
  VALUES (%L, gen_random_uuid(), 'team', 'sms', 'Team hello', 'Hi {{contact.first_name}}', %L)$q$, :tA, :agA1),
  'R-PAR-23: an agent cannot write a team template', '%row-level security%');
INSERT INTO message_templates (tenant_id, id, scope, owner_user_id, channel, name, body, merge_fields, updated_by_user_id)
VALUES (:tA, :tplP, 'personal', :agA1, 'sms', 'My follow-up', 'Hi {{contact.first_name|there}}, it''s {{agent.first_name}}.',
        '{contact.first_name,agent.first_name}', :agA1);
SELECT pg_temp.expect_error(format($q$INSERT INTO message_templates (tenant_id, id, scope, owner_user_id, channel, name, body, merge_fields, updated_by_user_id)
  VALUES (%L, gen_random_uuid(), 'personal', %L, 'sms', 'Leak', 'x', '{other_contact.phone}', %L)$q$, :tA, :agA1, :agA1),
  'R-PAR-24: a template names only the closed merge-field set', '%message_templates_merge_fields_check%');
SELECT pg_temp.expect_error(format($q$INSERT INTO message_templates (tenant_id, id, scope, owner_user_id, channel, name, subject, body, updated_by_user_id)
  VALUES (%L, gen_random_uuid(), 'personal', %L, 'email', 'Inject', E'Hi\r\nBcc: x@evil.test', 'x', %L)$q$, :tA, :agA1, :agA1),
  'R-PAR-24: a subject cannot carry a header break', '%message_templates_subject_check%');
SELECT pg_temp.expect_error(format($q$UPDATE message_templates SET body = 'changed' WHERE id = %L$q$, :tplP),
  'R-PAR-26: a content change bumps the version', '%TEMPLATE_VERSION%');
UPDATE message_templates SET body = 'Hi {{contact.first_name|there}}!', version = 2 WHERE id = :tplP;
SELECT pg_temp.ctx(:tA, :admA, 'user');
INSERT INTO message_templates (tenant_id, id, scope, channel, name, subject, body, updated_by_user_id)
VALUES (:tA, :tplT, 'team', 'email', 'New listing', 'A home you might like', 'Hi {{contact.first_name}}', :admA);
SELECT pg_temp.ok(pg_temp.n(format('SELECT count(*) FROM message_templates WHERE id = %L', :tplP)) = 0,
  'R-PAR-23: an Admin does not read an agent''s personal template');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok(pg_temp.n('SELECT count(*) FROM message_templates') = 1, 'agent 2 reads the team template only');
SELECT pg_temp.ctx(:tA, :ownB, 'user');
SELECT pg_temp.ok(pg_temp.n('SELECT count(*) FROM message_templates') = 0, 'R-TEN-1: tenant B reads no tenant A template');

-- =============================================================================
-- 7. Smart lists: shared definitions, never shared rows (R-PAR-27, R-PAR-28)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO smart_lists (tenant_id, id, scope, owner_user_id, name, definition, definition_version, updated_by_user_id)
VALUES (:tA, :slP, 'personal', :agA1, 'My buyers', format('{"v":1,"all":[{"field":"tag","op":"has_any","value":["%s"]}]}', :tgBuy)::jsonb, 1, :agA1);
SELECT pg_temp.expect_error(format($q$INSERT INTO smart_lists (tenant_id, id, scope, name, definition, definition_version, updated_by_user_id)
  VALUES (%L, gen_random_uuid(), 'team', 'Team list', '{"v":1,"all":[]}', 1, %L)$q$, :tA, :agA1),
  'R-PAR-27: an agent cannot publish a team list', '%row-level security%');
SELECT pg_temp.ctx(:tA, :tlA, 'user');
INSERT INTO smart_lists (tenant_id, id, scope, name, definition, definition_version, updated_by_user_id)
VALUES (:tA, :slT, 'team', 'Buyers', format('{"v":1,"all":[{"field":"tag","op":"has_any","value":["%s"]}]}', :tgBuy)::jsonb, 1, :tlA);
SELECT pg_temp.ok(pg_temp.n(format('SELECT count(*) FROM smart_lists WHERE id = %L', :slP)) = 0,
  'a Team Lead does not read an agent''s personal list');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok(pg_temp.n('SELECT count(*) FROM smart_lists') = 1
              AND pg_temp.n(format($q$SELECT count(*) FROM contacts c WHERE EXISTS (SELECT 1 FROM contact_tags t
                    WHERE t.tenant_id = c.tenant_id AND t.contact_id = c.id AND t.tag_id = %L)$q$, :tgBuy)) = 1,
  'R-PAR-28: agent 2 runs the team list and gets only Carol (a definition, not a result set)');
SELECT pg_temp.ctx(:tA, :admA, 'user');
SELECT pg_temp.ok(pg_temp.n(format($q$SELECT count(*) FROM contacts c WHERE EXISTS (SELECT 1 FROM contact_tags t
                    WHERE t.tenant_id = c.tenant_id AND t.contact_id = c.id AND t.tag_id = %L)$q$, :tgBuy)) = 3,
  'R-PAR-28: the Admin runs the same list and gets Alice, Dora and Carol');

-- =============================================================================
-- 8. Removing a phone never un-blocks the person (R-PAR-11, R-PAR-12)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, label) VALUES
  (:tA, 'a0000000-0000-7000-8000-0000000ae001', :c6, 'phone', '+15555550601', digest('+15555550601', 'sha256'), 'mobile'),
  (:tA, 'a0000000-0000-7000-8000-0000000ae002', :c6, 'phone', '+15555550602', digest('+15555550602', 'sha256'), 'work'),
  (:tA, 'a0000000-0000-7000-8000-0000000ae003', :c5, 'phone', '+15555550501', digest('+15555550501', 'sha256'), 'mobile'),
  (:tA, 'a0000000-0000-7000-8000-0000000ae004', :c5, 'phone', '+15555550502', digest('+15555550502', 'sha256'), 'work');
INSERT INTO conversations (tenant_id, id, contact_id) VALUES (:tA, 'a0000000-0000-7000-8000-00000000cc05', :c5);
SELECT pg_temp.expect_error(format($q$UPDATE contact_points SET address = '+15555550699', address_hmac = digest('+15555550699', 'sha256')
  WHERE id = %L$q$, 'a0000000-0000-7000-8000-0000000ae001'),
  'R-PAR-11: a phone number is never edited in place (remove and add)', '%CONTACT_POINT_IMMUTABLE%');
-- Finn's mobile and Eve's mobile text STOP
SELECT pg_temp.ctx(:tA, NULL, 'system');
INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose, event_type, consent_level,
       source, occurred_at, actor_kind, contact_id, evidence_message_id)
VALUES (:tA, 'a0000000-0000-7000-8000-0000000ae101', 'phone', digest('+15555550601', 'sha256'), '…0601', 'sms', 'all',
        'revoke', 'none', 'inbound_keyword', now(), 'system', :c6, gen_random_uuid()),
       (:tA, 'a0000000-0000-7000-8000-0000000ae102', 'phone', digest('+15555550501', 'sha256'), '…0501', 'sms', 'all',
        'revoke', 'none', 'inbound_keyword', now(), 'system', :c5, gen_random_uuid());
INSERT INTO consent_state (tenant_id, channel, purpose, address_hmac, status, consent_level, basis_event_id, ledger_event_count)
VALUES (:tA, 'sms', 'informational', digest('+15555550601', 'sha256'), 'revoked', 'none', 'a0000000-0000-7000-8000-0000000ae101', 1),
       (:tA, 'sms', 'informational', digest('+15555550501', 'sha256'), 'revoked', 'none', 'a0000000-0000-7000-8000-0000000ae102', 1);
SELECT pg_temp.ctx(:tA, :agA1, 'user');
UPDATE contact_points SET status = 'removed', removed_at = now(), removed_reason = 'replaced' WHERE id = 'a0000000-0000-7000-8000-0000000ae001';
SELECT pg_temp.expect_error(format($q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id,
  from_address, to_address, body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at) VALUES (%L, gen_random_uuid(),
  %L, %L, 'sms', 'outbound', %L, '+15555559100', '+15555550602', 'Hi Finn', 'dispatching', 'human', %L, 'informational', now(), now())$q$,
  :tA, :cvA6, :c6, :num, :agA1),
  'R-PAR-12: removing the phone that texted STOP does not make Finn''s other phone textable', '%RECIPIENT_OPTED_OUT%');
SELECT pg_temp.expect_error(format($q$UPDATE contact_points SET status = 'removed', removed_at = now(), removed_reason = 'wrong_number'
  WHERE id = %L$q$, 'a0000000-0000-7000-8000-0000000ae003'),
  'R-PAR-12: only a point already marked wrong number is removed as one', '%REMOVED_REASON_WRONG_NUMBER%');
-- the STOP came from a wrong number: the call-outcome path marks it, then the agent removes it as such
UPDATE contact_points SET status = 'wrong_number' WHERE id = 'a0000000-0000-7000-8000-0000000ae003';
UPDATE contact_points SET status = 'removed', removed_at = now(), removed_reason = 'wrong_number' WHERE id = 'a0000000-0000-7000-8000-0000000ae003';
INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body,
       status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at)
VALUES (:tA, gen_random_uuid(), 'a0000000-0000-7000-8000-00000000cc05', :c5, 'sms', 'outbound', :num, '+15555559100', '+15555550502',
        'Hi Eve', 'dispatching', 'human', :agA1, 'informational', now(), now());
SELECT pg_temp.ok(true, 'R-PAR-12: a phone removed as a confirmed wrong number no longer blocks Eve''s real phone');
SELECT pg_temp.expect_error(format($q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id,
  from_address, to_address, body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at) VALUES (%L, gen_random_uuid(),
  %L, %L, 'sms', 'outbound', %L, '+15555559100', '+15555550501', 'Hi again', 'dispatching', 'human', %L, 'informational', now(), now())$q$,
  :tA, 'a0000000-0000-7000-8000-00000000cc05', :c5, :num, :agA1),
  'the removed wrong number itself stays blocked (its own STOP)', '%RECIPIENT_%');
-- Finn also asked not to be called from his old mobile: the call guard reads removed phones too
SELECT pg_temp.ctx(:tA, NULL, 'system');
INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose, event_type, consent_level,
       source, occurred_at, actor_kind, contact_id, evidence_call_id)
VALUES (:tA, 'a0000000-0000-7000-8000-0000000ae103', 'phone', digest('+15555550601', 'sha256'), '…0601', 'voice', 'all',
        'revoke', 'none', 'agent_revoke', now(), 'system', :c6, gen_random_uuid());
INSERT INTO consent_state (tenant_id, channel, purpose, address_hmac, status, consent_level, basis_event_id, ledger_event_count)
VALUES (:tA, 'voice', 'informational', digest('+15555550601', 'sha256'), 'revoked', 'none', 'a0000000-0000-7000-8000-0000000ae103', 1);
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, phone_number_id, agent_user_id,
  client_address, initiator, handled_by, status, started_at, recording_mode, recording_decision) VALUES (%L, gen_random_uuid(), %L, %L,
  'outbound', %L, %L, '+15555550602', 'human', 'human', 'initiated', now(), 'off', '{}')$q$, :tA, :cvA6, :c6, :num, :agA1),
  'R-PAR-12: removing the phone that said "do not call" does not make Finn''s other phone callable', '%RECIPIENT_OPTED_OUT%');

-- =============================================================================
-- 9. Bulk actions: frozen targets from what the creator sees, confirmed by the creator, sends through the
--    opt-out guard with no exemption, never a touch, batch text behind the Owner's switch (R-PAR-33..42)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO bulk_actions (tenant_id, id, kind, created_by_user_id, created_by_role, source, params, idempotency_key)
VALUES (:tA, :bk1, 'tag', :agA1, 'agent', 'selection', format('{"tag_id":"%s"}', :tgBuy)::jsonb, 'bulk-tag-0001');
INSERT INTO bulk_action_items (tenant_id, bulk_action_id, contact_id) VALUES (:tA, :bk1, :c1), (:tA, :bk1, :c5);
SELECT pg_temp.expect_error(format($q$INSERT INTO bulk_action_items (tenant_id, bulk_action_id, contact_id) VALUES (%L, %L, %L)$q$, :tA, :bk1, :c2),
  'R-PAR-34: a bulk target holds only people whose detail the creator sees', '%row-level security%');
SELECT pg_temp.expect_error(format($q$INSERT INTO bulk_actions (tenant_id, id, kind, created_by_user_id, created_by_role, source, idempotency_key)
  VALUES (%L, gen_random_uuid(), 'assign', %L, 'agent', 'selection', 'bulk-assign-01')$q$, :tA, :agA1),
  'R-PAR-35: an agent cannot bulk-assign (Owner, Admin, Team Lead only)', '%bulk_actions_check%');
SELECT pg_temp.expect_error(format($q$INSERT INTO bulk_actions (tenant_id, id, kind, created_by_user_id, created_by_role, source, idempotency_key)
  VALUES (%L, gen_random_uuid(), 'tag', %L, 'admin', 'selection', 'bulk-forged-1')$q$, :tA, :agA1),
  'R-PAR-33: a bulk action records its creator''s true role', '%row-level security%');
SELECT pg_temp.expect_error(format($q$INSERT INTO bulk_actions (tenant_id, id, kind, status, created_by_user_id, created_by_role, source, idempotency_key,
  confirmed_at, target_count) VALUES (%L, gen_random_uuid(), 'tag', 'confirmed', %L, 'agent', 'selection', 'bulk-skip-draft', now(), 1)$q$, :tA, :agA1),
  'a bulk action is born a draft', '%BULK_LIFECYCLE%');
SELECT pg_temp.ctx(:tA, :admA, 'user');
SELECT pg_temp.expect_error(format($q$UPDATE bulk_actions SET status = 'confirmed', confirmed_at = now(), target_count = 2 WHERE id = %L$q$, :bk1),
  'R-PAR-33: only its creator confirms a bulk action (not an Admin)', '%BULK_CONFIRM_CREATOR%');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok(pg_temp.n(format('SELECT count(*) FROM bulk_actions WHERE id = %L', :bk1)) = 0, 'another agent does not see the action');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
UPDATE bulk_actions SET status = 'confirmed', confirmed_at = now(), target_count = 2 WHERE id = :bk1;
SELECT pg_temp.expect_error(format($q$INSERT INTO bulk_action_items (tenant_id, bulk_action_id, contact_id) VALUES (%L, %L, %L)$q$, :tA, :bk1, :c3),
  'R-PAR-34: the target is frozen at confirm', '%BULK_FROZEN%');
SELECT pg_temp.expect_error(format($q$UPDATE bulk_actions SET params = '{}' WHERE id = %L$q$, :bk1),
  'a bulk action keeps its parameters', '%BULK_IMMUTABLE%');
SELECT pg_temp.expect_error(format($q$UPDATE bulk_actions SET status = 'draft' WHERE id = %L$q$, :bk1),
  'a confirmed action never goes back to draft', '%BULK_LIFECYCLE%');
-- the runner acts as the creator, one item per transaction
UPDATE bulk_actions SET status = 'running', started_at = now() WHERE id = :bk1;
INSERT INTO contact_tags (tenant_id, contact_id, tag_id, added_by_kind, added_by_user_id, bulk_action_id)
VALUES (:tA, :c5, :tgBuy, 'bulk', :agA1, :bk1);
UPDATE bulk_action_items SET status = 'done', processed_at = now() WHERE bulk_action_id = :bk1 AND contact_id = :c5;
UPDATE bulk_action_items SET status = 'skipped', reason_code = 'ALREADY_TAGGED', processed_at = now() WHERE bulk_action_id = :bk1 AND contact_id = :c1;
UPDATE bulk_actions SET status = 'completed', finished_at = now(), counts = '{"done":1,"skipped":1}' WHERE id = :bk1;
SELECT pg_temp.ctx(:tA, :tlA, 'user');
SELECT pg_temp.ok(pg_temp.n(format('SELECT count(*) FROM bulk_action_items WHERE bulk_action_id = %L', :bk1)) = 2,
  'the creator''s Team Lead reads the action and its items');
SELECT pg_temp.ctx(:tA, :tcA, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO bulk_actions (tenant_id, id, kind, created_by_user_id, created_by_role, source, idempotency_key)
  VALUES (%L, gen_random_uuid(), 'tag', %L, 'tc', 'selection', 'bulk-tc-00001')$q$, :tA, :tcA),
  'a TC does not run bulk actions', '%bulk_actions_created_by_role_check%');

-- bulk email: one human marketing message per person, through the same opt-out guard
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO bulk_actions (tenant_id, id, kind, created_by_user_id, created_by_role, source, template_id, template_version, idempotency_key)
VALUES (:tA, :bkE, 'email', :agA1, 'agent', 'selection', :tplT, 1, 'bulk-email-001');
INSERT INTO bulk_action_items (tenant_id, bulk_action_id, contact_id, address_hmac)
VALUES (:tA, :bkE, :c1, digest('alice@example.test', 'sha256'));
SELECT pg_temp.expect_error(format($q$INSERT INTO bulk_action_items (tenant_id, bulk_action_id, contact_id, address_hmac)
  VALUES (%L, %L, %L, digest('alice@example.test', 'sha256'))$q$, :tA, :bkE, :c3),
  'R-PAR-38: one bulk send per address (spouses sharing an email get one)', '%bulk_action_items_one_per_address%');
SELECT pg_temp.expect_error(format($q$UPDATE bulk_actions SET status = 'confirmed', confirmed_at = now(), target_count = 1 WHERE id = %L$q$, :bkE),
  'a send is confirmed only with its frozen content', '%bulk_actions_check%');
UPDATE bulk_actions SET status = 'confirmed', confirmed_at = now(), target_count = 1,
       subject_snapshot = 'A home you might like', body_snapshot = 'Hi {{contact.first_name}}' WHERE id = :bkE;
SELECT pg_temp.expect_error(format($q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, email_identity_id,
  from_address, to_address, subject, body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at, bulk_action_id)
  VALUES (%L, gen_random_uuid(), %L, %L, 'email', 'outbound', %L, 'team@a-realty.test', 'alice@example.test', 'A home', 'Hi Alice',
  'dispatching', 'human', %L, 'marketing', now(), now(), %L)$q$, :tA, :cvA, :c1, :eid, :agA1, :bkE),
  'R-PAR-36: nothing is sent for a bulk action that is not running', '%BULK_MESSAGE_INVALID%');
UPDATE bulk_actions SET status = 'running', started_at = now() WHERE id = :bkE;
SELECT pg_temp.expect_error(format($q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, email_identity_id,
  from_address, to_address, subject, body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at, bulk_action_id)
  VALUES (%L, gen_random_uuid(), %L, %L, 'email', 'outbound', %L, 'team@a-realty.test', 'alice@example.test', 'A home', 'Hi Alice',
  'dispatching', 'human', %L, 'informational', now(), now(), %L)$q$, :tA, :cvA, :c1, :eid, :agA1, :bkE),
  'R-PAR-39: a bulk email is always marketing (brokerage identity and unsubscribe)', '%messages_bulk_human_marketing%');
SELECT pg_temp.expect_error(format($q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, email_identity_id,
  from_address, to_address, subject, body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at, bulk_action_id)
  VALUES (%L, gen_random_uuid(), %L, %L, 'email', 'outbound', %L, 'team@a-realty.test', 'finn@example.test', 'A home', 'Hi Finn',
  'dispatching', 'human', %L, 'marketing', now(), now(), %L)$q$, :tA, :cvA6, :c6, :eid, :agA1, :bkE),
  'R-PAR-36: a bulk message goes only to a person in the frozen target', '%BULK_MESSAGE_INVALID%');
INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, email_identity_id, from_address, to_address,
       subject, body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at, bulk_action_id)
VALUES (:tA, gen_random_uuid(), :cvA, :c1, 'email', 'outbound', :eid, 'team@a-realty.test', 'alice@example.test', 'A home you might like',
        'Hi Alice', 'sent', 'human', :agA1, 'marketing', now(), now(), :bkE);
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM v_agent_activity_daily WHERE user_id = :agA1 AND touches > 0),
  'R-PAR-37: a sent bulk email is not a touch in the activity view');
-- Alice unsubscribes; the next bulk email to her is refused by the database guard, whatever the app does
SELECT pg_temp.ctx(:tA, NULL, 'system');
INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose, event_type, consent_level,
       source, occurred_at, actor_kind, contact_id, evidence_message_id)
VALUES (:tA, 'a0000000-0000-7000-8000-0000000ae201', 'email', digest('alice@example.test', 'sha256'), 'a…@example.test', 'email',
        'marketing', 'revoke', 'none', 'provider_report', now(), 'system', :c1, gen_random_uuid());
INSERT INTO consent_state (tenant_id, channel, purpose, address_hmac, status, consent_level, basis_event_id, ledger_event_count)
VALUES (:tA, 'email', 'marketing', digest('alice@example.test', 'sha256'), 'revoked', 'none', 'a0000000-0000-7000-8000-0000000ae201', 1);
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, email_identity_id,
  from_address, to_address, subject, body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at, bulk_action_id)
  VALUES (%L, gen_random_uuid(), %L, %L, 'email', 'outbound', %L, 'team@a-realty.test', 'alice@example.test', 'Another home', 'Hi Alice',
  'dispatching', 'human', %L, 'marketing', now(), now(), %L)$q$, :tA, :cvA, :c1, :eid, :agA1, :bkE),
  'R-PAR-36 D1: an unsubscribe blocks every remaining bulk email, with no override', '%RECIPIENT_OPTED_OUT%');

-- batch text: off by default, only the Owner turns it on, small actions only
INSERT INTO bulk_actions (tenant_id, id, kind, created_by_user_id, created_by_role, source, idempotency_key)
VALUES (:tA, :bkT, 'text', :agA1, 'agent', 'selection', 'bulk-text-0001');
INSERT INTO bulk_action_items (tenant_id, bulk_action_id, contact_id, address_hmac) VALUES (:tA, :bkT, :c5, digest('+15555550502', 'sha256'));
SELECT pg_temp.expect_error(format($q$UPDATE bulk_actions SET status = 'confirmed', confirmed_at = now(), target_count = 1,
  body_snapshot = 'Open house Sat 1-3. Reply STOP to opt out.' WHERE id = %L$q$, :bkT),
  'R-PAR-40: batch text is off by default', '%BATCH_TEXT_DISABLED%');
SELECT pg_temp.ctx(:tA, :admA, 'user');
SELECT pg_temp.expect_error($q$UPDATE tenant_settings SET batch_text_enabled = true$q$,
  'R-PAR-40: an Admin cannot turn batch text on', '%BATCH_TEXT_OWNER_ONLY%');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
UPDATE tenant_settings SET batch_text_enabled = true;
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format($q$UPDATE bulk_actions SET status = 'confirmed', confirmed_at = now(), target_count = 201,
  body_snapshot = 'x' WHERE id = %L$q$, :bkT),
  'R-PAR-40: a batch text reaches at most 200 people', '%bulk_actions_check%');
UPDATE bulk_actions SET status = 'confirmed', confirmed_at = now(), target_count = 1,
       body_snapshot = 'Open house Sat 1-3. Reply STOP to opt out.' WHERE id = :bkT;
UPDATE bulk_actions SET status = 'running', started_at = now() WHERE id = :bkT;
SELECT pg_temp.ctx(:tA, :admA, 'user');
UPDATE tenant_settings SET batch_text_enabled = false;
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id,
  from_address, to_address, body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at, bulk_action_id)
  VALUES (%L, gen_random_uuid(), %L, %L, 'sms', 'outbound', %L, '+15555559100', '+15555550502', 'Open house Sat', 'dispatching',
  'human', %L, 'marketing', now(), now(), %L)$q$, :tA, 'a0000000-0000-7000-8000-00000000cc05', :c5, :num, :agA1, :bkT),
  'R-PAR-40: switching batch text off stops a running batch at the next message', '%BATCH_TEXT_DISABLED%');

-- =============================================================================
-- 10. Tenancy sweep: tenant B reads nothing of tenant A in any parity table
-- =============================================================================
SELECT pg_temp.ctx(:tB, :ownB, 'user');
DO $$
DECLARE t text; n bigint; bad text := '';
BEGIN
  FOREACH t IN ARRAY ARRAY['note_mentions','tags','contact_tags','contact_stage_events','custom_field_defs','contact_field_values',
     'contact_relationships','message_templates','smart_lists','bulk_actions','bulk_action_items'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE tenant_id = %L', t, 'a0000000-0000-7000-8000-000000000001') INTO n;
    IF n <> 0 THEN bad := bad || ' ' || t; END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'FAIL  tenant B read tenant A rows:%', bad; END IF;
  RAISE NOTICE 'PASS  R-TEN-1: tenant B''s Owner reads 0 tenant A rows from every parity table';
END $$;
SELECT pg_temp.expect_error(format($q$INSERT INTO contact_tags (tenant_id, contact_id, tag_id, added_by_kind, added_by_user_id)
  VALUES (%L, %L, %L, 'user', %L)$q$, :tA, :c1, :tgBuy, :ownB),
  'tenant B cannot tag a tenant A contact', '%row-level security%');
SELECT pg_temp.ok((SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
                    WHERE ns.nspname = 'public' AND c.relname IN ('note_mentions','tags','contact_tags','contact_stage_events',
                      'custom_field_defs','contact_field_values','contact_relationships','message_templates','smart_lists',
                      'bulk_actions','bulk_action_items') AND c.relrowsecurity AND c.relforcerowsecurity) = 11,
  'every parity table has FORCE row-level security');

SELECT pg_temp.ok(true, 'ALL FUB PARITY RLS SMOKE CHECKS PASSED');
ROLLBACK;
