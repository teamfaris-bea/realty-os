-- =============================================================================
-- RLS / integrity smoke test for the homeowner-profile migration (owner decision D10; modules 77-79;
-- R-HOME-3, R-HOME-4, R-HOME-7, R-HOME-8, R-HOME-9; E570, E571, E583, E584, E587, E589).
-- Same shape as rls_smoke_p23.sql: ONE transaction, rolled back; every application step runs as app_user; a
-- failed expectation raises 'FAIL ...'. Run by packages/db/test/rls_smoke_homeowner.test.ts. The migration's
-- file name is not named here (the orchestrator renumbers it at merge). Every address and name is fictional.
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
-- the only place a check raises
CREATE FUNCTION pg_temp.fail(p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FAIL  %', p_msg;
END $$;
CREATE FUNCTION pg_temp.ok(p_cond boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS NOT TRUE THEN PERFORM pg_temp.fail(p_label); RETURN; END IF;
  RAISE NOTICE 'PASS  %', p_label;
END $$;
-- runs one statement in a subtransaction: 'OK', or the error it raised
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END $$;
CREATE FUNCTION pg_temp.refused(p_sql text, p_label text, p_like text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r text := pg_temp.try(p_sql);
BEGIN
  PERFORM pg_temp.ok(r <> 'OK' AND r ~ p_like, p_label || ' -> ' || r);
END $$;
CREATE FUNCTION pg_temp.rows_affected(p_sql text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; RETURN n; END $$;
CREATE FUNCTION pg_temp.self_create(p_tenant uuid, p_contact uuid, p_owner uuid, p_name text, p_cmd uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.ctx(p_tenant, p_owner, 'user');
  PERFORM pg_temp.cmd(p_cmd);
  INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, owner_user_id,
         actor_kind, actor_user_id, reason_code, command_id, occurred_at)
  VALUES (p_tenant, p_contact, 1, gen_random_uuid(), 'created', NULL, 'owned', p_owner, 'user', p_owner, 'SELF_CREATED', p_cmd, now());
  INSERT INTO contacts (tenant_id, id, display_name, ownership_state, owner_user_id, owned_at, ownership_period_seq, ownership_seq,
         ownership_command_id, ownership_actor_user_id, created_by_user_id, intent)
  VALUES (p_tenant, p_contact, p_name, 'owned', p_owner, now(), 1, 1, p_cmd, p_owner, p_owner, 'seller');
  PERFORM pg_temp.cmd(NULL);
END $$;
-- the system's profile row (the columns homeowner.refresh writes)
CREATE FUNCTION pg_temp.profile_sql(p_id uuid, p_contact uuid, p_address uuid, p_status text DEFAULT 'matched') RETURNS text LANGUAGE sql AS $$
  SELECT format($q$INSERT INTO homeowner_profiles (tenant_id, id, contact_id, contact_address_id, county_key, status, match_detail,
    recognized_by, parcel_ref, source, checked_at, address_updated_at, next_refresh_at, retention_until)
    VALUES (app.tenant_id(), %L, %L, %L, 'sc-beaufort', %L, %s, '{seller_intent}', 'TEST-0001', 'Beaufort County GIS parcel layer',
    now(), now(), now() + interval '30 days', now() + interval '365 days')$q$,
    p_id, p_contact, p_address, p_status, CASE WHEN p_status = 'not_matched' THEN quote_literal('owner_name_mismatch') ELSE 'NULL' END)
$$;
CREATE FUNCTION pg_temp.fact_sql(p_profile uuid, p_field text, p_column text, p_value text) RETURNS text LANGUAGE sql AS $$
  SELECT format($q$INSERT INTO homeowner_profile_facts (tenant_id, profile_id, field, %I, source, as_of)
    VALUES (app.tenant_id(), %L, %L, %s, 'Beaufort County GIS parcel layer', NULL)$q$, p_column, p_profile, p_field, p_value)
$$;
CREATE FUNCTION pg_temp.seen(p_profile uuid) RETURNS integer LANGUAGE sql AS $$
  SELECT (SELECT count(*) FROM homeowner_profiles WHERE id = p_profile)::integer
       + (SELECT count(*) FROM homeowner_profile_facts WHERE profile_id = p_profile)::integer
$$;

\set tA     '''a0000000-0000-7000-8000-000000000001'''
\set tB     '''b0000000-0000-7000-8000-000000000001'''
\set ownA   '''a0000000-0000-7000-8000-0000000000a0'''
\set agA1   '''a0000000-0000-7000-8000-0000000000a1'''
\set agA2   '''a0000000-0000-7000-8000-0000000000a2'''
\set tlA    '''a0000000-0000-7000-8000-0000000000a3'''
\set isaA   '''a0000000-0000-7000-8000-0000000000a4'''
\set tcA    '''a0000000-0000-7000-8000-0000000000a5'''
\set admA   '''a0000000-0000-7000-8000-0000000000ad'''
\set supU   '''a0000000-0000-7000-8000-0000000000ff'''
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
\set h1     '''a0000000-0000-7000-8000-00000000a001'''
\set h2     '''a0000000-0000-7000-8000-00000000a002'''
\set h3     '''a0000000-0000-7000-8000-00000000a003'''
\set h4     '''a0000000-0000-7000-8000-00000000a004'''
\set h5     '''a0000000-0000-7000-8000-00000000a005'''
\set h6     '''a0000000-0000-7000-8000-00000000a006'''
\set p1     '''a0000000-0000-7000-8000-00000000b001'''
\set p2     '''a0000000-0000-7000-8000-00000000b002'''
\set p3     '''a0000000-0000-7000-8000-00000000b003'''
\set p4     '''a0000000-0000-7000-8000-00000000b004'''
\set p5     '''a0000000-0000-7000-8000-00000000b005'''
\set p6     '''a0000000-0000-7000-8000-00000000b006'''
\set dA     '''a0000000-0000-7000-8000-00000000de01'''
\set PH     '''$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA'''

-- =============================================================================
-- 0. Tenant A: Owner, Admin, Team Lead (team: agent 1), agents 1 and 2, an ISA, a TC, a support user with the
--    Owner's grant. Tenant B: an Owner. Contacts: c1, c5, c6 agent 1's; c2, c4 agent 2's (c4 on a deal the TC
--    works); c3 the ISA's. Each has one home address.
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
SELECT pg_temp.ctx(NULL, :supU, 'user');
INSERT INTO users (id, email, display_name, password_hash) VALUES (:supU, 'support@realty-os.test', 'Sam Support', :PH);
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO invites (tenant_id, id, email, role, token_hash, invited_by_user_id, expires_at) VALUES
  (:tA, 'a0000000-0000-7000-8000-0000000001a1', 'agent1@example.test', 'agent', digest('ho-invite-a1', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a0000000-0000-7000-8000-0000000001a2', 'agent2@example.test', 'agent', digest('ho-invite-a2', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a0000000-0000-7000-8000-0000000001a3', 'lead@example.test', 'team_lead', digest('ho-invite-a3', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a0000000-0000-7000-8000-0000000001a4', 'isa@example.test', 'isa', digest('ho-invite-a4', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a0000000-0000-7000-8000-0000000001a5', 'tc@example.test', 'tc', digest('ho-invite-a5', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a0000000-0000-7000-8000-0000000001ad', 'admin@example.test', 'admin', digest('ho-invite-ad', 'sha256'), :ownA, now() + interval '1 day');
SELECT pg_temp.ctx(NULL, NULL, NULL);
SELECT FROM auth.accept_invite(digest('ho-invite-a1', 'sha256'), :agA1, 'Ava Agent', :PH, now());
SELECT FROM auth.accept_invite(digest('ho-invite-a2', 'sha256'), :agA2, 'Ben Agent', :PH, now());
SELECT FROM auth.accept_invite(digest('ho-invite-a3', 'sha256'), :tlA, 'Tess Lead', :PH, now());
SELECT FROM auth.accept_invite(digest('ho-invite-a4', 'sha256'), :isaA, 'Ida Isa', :PH, now());
SELECT FROM auth.accept_invite(digest('ho-invite-a5', 'sha256'), :tcA, 'Theo Coordinator', :PH, now());
SELECT FROM auth.accept_invite(digest('ho-invite-ad', 'sha256'), :admA, 'Adam Admin', :PH, now());
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO team_members (tenant_id, team_id, user_id, is_lead) VALUES (:tA, :teamA, :tlA, true), (:tA, :teamA, :agA1, false);
INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, expires_at)
VALUES (:tA, gen_random_uuid(), :supU, :ownA, 'Ticket 1: profile question', now() + interval '2 hours');

SELECT pg_temp.self_create(:tA, :c1, :agA1, 'Alice Seller', 'a0000000-0000-7000-8000-0000000c0001');
SELECT pg_temp.self_create(:tA, :c5, :agA1, 'Erin Seller', 'a0000000-0000-7000-8000-0000000c0005');
SELECT pg_temp.self_create(:tA, :c6, :agA1, 'Finn Seller', 'a0000000-0000-7000-8000-0000000c0006');
SELECT pg_temp.self_create(:tA, :c2, :agA2, 'Carol Seller', 'a0000000-0000-7000-8000-0000000c0002');
SELECT pg_temp.self_create(:tA, :c4, :agA2, 'Dan Seller', 'a0000000-0000-7000-8000-0000000c0004');
SELECT pg_temp.self_create(:tA, :c3, :isaA, 'Gail Seller', 'a0000000-0000-7000-8000-0000000c0003');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, line1, city, region, postal_code) VALUES
  (:tA, :h1, :c1, 'home', '1 Sample Way', 'Exampleton', 'SC', '29902'),
  (:tA, :h5, :c5, 'home', '5 Sample Way', 'Exampleton', 'SC', '29902'),
  (:tA, :h6, :c6, 'home', '6 Sample Way', 'Exampleton', 'SC', '29902');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, line1, city, region, postal_code) VALUES
  (:tA, :h2, :c2, 'home', '2 Sample Way', 'Exampleton', 'SC', '29902'),
  (:tA, :h4, :c4, 'home', '4 Sample Way', 'Exampleton', 'SC', '29902');
INSERT INTO deals (tenant_id, id, name, side, stage_entered_at, primary_contact_id, owner_user_id, created_by_user_id)
VALUES (:tA, :dA, 'Dan sale', 'sell', now(), :c4, :agA2, :agA2);
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO deal_members (tenant_id, deal_id, user_id, role) VALUES (:tA, :dA, :tcA, 'tc');
SELECT pg_temp.ctx(:tA, :isaA, 'user');
INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, line1, city, region, postal_code) VALUES
  (:tA, :h3, :c3, 'home', '3 Sample Way', 'Exampleton', 'SC', '29902');

-- the system writes a matched profile with facts for c1..c6
SELECT pg_temp.ctx(:tA, NULL, 'system');
DO $$
DECLARE i int;
BEGIN
  FOR i IN 1..6 LOOP
    EXECUTE pg_temp.profile_sql(('a0000000-0000-7000-8000-00000000b00' || i)::uuid, ('a0000000-0000-7000-8000-00000000e00' || i)::uuid,
                                ('a0000000-0000-7000-8000-00000000a00' || i)::uuid);
    EXECUTE pg_temp.fact_sql(('a0000000-0000-7000-8000-00000000b00' || i)::uuid, 'last_transfer_date', 'date_value', $v$'2015-06-01'$v$);
    EXECUTE pg_temp.fact_sql(('a0000000-0000-7000-8000-00000000b00' || i)::uuid, 'owner_mailing_address', 'text_value', $v$'PO BOX 1, EXAMPLETON SC 29902'$v$);
  END LOOP;
END $$;
SELECT pg_temp.ok((SELECT count(*) FROM homeowner_profiles) = 6 AND (SELECT count(*) FROM homeowner_profile_facts) = 12,
                  'R-HOME-7: the system writes profiles and facts (tenant-wide)');

-- =============================================================================
-- 1. Reads (R-HOME-8)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(pg_temp.seen(:p1) = 3, 'R-HOME-8: agent A reads their contact''s profile and both facts');
SELECT pg_temp.ok(pg_temp.seen(:p2) = 0 AND pg_temp.seen(:p4) = 0 AND pg_temp.seen(:p3) = 0, 'R-HOME-8: agent A reads 0 rows of another agent''s contacts');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok(pg_temp.seen(:p1) = 0 AND pg_temp.seen(:p2) = 3, 'R-HOME-8: agent B reads 0 rows of agent A''s profile and reads their own');
SELECT pg_temp.ctx(:tA, :tlA, 'user');
SELECT pg_temp.ok(pg_temp.seen(:p1) = 3, 'R-HOME-8: a Team Lead reads their team''s profile');
SELECT pg_temp.ctx(:tA, :tcA, 'user');
SELECT pg_temp.ok(pg_temp.seen(:p4) = 3 AND pg_temp.seen(:p1) = 0, 'R-HOME-8: a TC reads the profile of a contact on their deal, and nothing else');
SELECT pg_temp.ctx(:tA, :isaA, 'user');
SELECT pg_temp.ok(pg_temp.seen(:p3) = 3 AND pg_temp.seen(:p1) = 0, 'R-HOME-8: an ISA reads their own contact''s profile');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM homeowner_profiles) = 6, 'R-HOME-8: the Owner reads every profile of the tenant');
SELECT pg_temp.ctx(:tB, :ownB, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM homeowner_profiles) = 0 AND (SELECT count(*) FROM homeowner_profile_facts) = 0,
                  'R-HOME-8 R-TEN-1: tenant B''s Owner reads 0 tenant A rows');

-- support reads under the Owner's grant, and writes nothing (RLS and the statement trigger)
SELECT pg_temp.ctx(:tA, :supU, 'support');
SELECT pg_temp.ok(pg_temp.seen(:p1) = 3, 'R-HOME-8: a support actor under the Owner''s grant reads the profile');
SELECT pg_temp.refused(format('UPDATE homeowner_profiles SET next_refresh_at = now() WHERE id = %L', :p1), 'R-HOME-7: support cannot update a profile', 'SUPPORT_READ_ONLY');
SELECT pg_temp.refused(format('DELETE FROM homeowner_profile_facts WHERE profile_id = %L', :p1), 'R-HOME-7: support cannot delete a fact', 'SUPPORT_READ_ONLY');
SELECT pg_temp.refused(pg_temp.fact_sql(:p1, 'tax_year', 'int_value', '2025'), 'R-HOME-7: support cannot insert a fact', 'SUPPORT_READ_ONLY');

-- E583: the client principal reads nothing while rows exist
SELECT pg_temp.client(:tA, gen_random_uuid());
SELECT pg_temp.ok((SELECT count(*) FROM homeowner_profiles) = 0 AND (SELECT count(*) FROM homeowner_profile_facts) = 0,
                  'R-HOME-8 E583: a client-portal session reads 0 profile and fact rows while they exist');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.ok((SELECT count(*) FROM homeowner_profiles) = 6, 'E583: the rows the client could not read do exist');

-- =============================================================================
-- 2. Writes: every user role is refused; the system writes and deletes (R-HOME-7)
-- =============================================================================
DO $$
DECLARE u record; bad text := ''; r text; n int;
BEGIN
  FOR u IN SELECT * FROM (VALUES ('owner','a0000000-0000-7000-8000-0000000000a0'::uuid), ('admin','a0000000-0000-7000-8000-0000000000ad'::uuid),
                                 ('team_lead','a0000000-0000-7000-8000-0000000000a3'::uuid), ('agent','a0000000-0000-7000-8000-0000000000a1'::uuid),
                                 ('isa','a0000000-0000-7000-8000-0000000000a4'::uuid), ('tc','a0000000-0000-7000-8000-0000000000a5'::uuid)) v(role, id) LOOP
    PERFORM pg_temp.ctx('a0000000-0000-7000-8000-000000000001', u.id, 'user');
    r := pg_temp.try(pg_temp.profile_sql(gen_random_uuid(), 'a0000000-0000-7000-8000-00000000e001', 'a0000000-0000-7000-8000-00000000a001'));
    IF r = 'OK' THEN bad := bad || ' ' || u.role || ':insert_profile'; END IF;
    r := pg_temp.try(pg_temp.fact_sql('a0000000-0000-7000-8000-00000000b001', 'tax_year', 'int_value', '2025'));
    IF r = 'OK' THEN bad := bad || ' ' || u.role || ':insert_fact'; END IF;
    n := pg_temp.rows_affected($q$UPDATE homeowner_profiles SET next_refresh_at = now() WHERE tenant_id = app.tenant_id()$q$);
    IF n <> 0 THEN bad := bad || ' ' || u.role || ':update_profile'; END IF;
    n := pg_temp.rows_affected($q$UPDATE homeowner_profile_facts SET as_of = current_date WHERE tenant_id = app.tenant_id()$q$);
    IF n <> 0 THEN bad := bad || ' ' || u.role || ':update_fact'; END IF;
    n := pg_temp.rows_affected($q$DELETE FROM homeowner_profile_facts WHERE tenant_id = app.tenant_id()$q$);
    IF n <> 0 THEN bad := bad || ' ' || u.role || ':delete_fact'; END IF;
    n := pg_temp.rows_affected($q$DELETE FROM homeowner_profiles WHERE tenant_id = app.tenant_id()$q$);
    IF n <> 0 THEN bad := bad || ' ' || u.role || ':delete_profile'; END IF;
  END LOOP;
  IF bad <> '' THEN PERFORM pg_temp.fail('R-HOME-7: user roles wrote homeowner rows:' || bad); END IF;
  RAISE NOTICE 'PASS  R-HOME-7: every user role (owner, admin, team lead, agent, ISA, TC) is refused INSERT and changes 0 rows by UPDATE or DELETE';
END $$;
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.ok((SELECT count(*) FROM homeowner_profiles) = 6 AND (SELECT count(*) FROM homeowner_profile_facts) = 12,
                  'R-HOME-7: after every user attempt the rows are unchanged');
SELECT pg_temp.ok(pg_temp.rows_affected(format('DELETE FROM homeowner_profile_facts WHERE profile_id = %L AND field = %L', :p6, 'last_transfer_date')) = 1,
                  'R-HOME-9: the system deletes a fact');

-- E589: a cross-tenant reference is refused (composite foreign keys; tenant B's system names tenant A's rows)
SELECT pg_temp.ctx(:tB, NULL, 'system');
SELECT pg_temp.refused(pg_temp.profile_sql(gen_random_uuid(), :c1, :h1), 'R-HOME-9 E589: tenant B''s system cannot profile tenant A''s contact and address',
                       'foreign key|HOMEOWNER_ADDRESS_NOT_CONTACTS');
SELECT pg_temp.refused(pg_temp.fact_sql(:p1, 'tax_year', 'int_value', '2025'), 'R-HOME-9 E589: tenant B''s system cannot attach a fact to tenant A''s profile',
                       'foreign key|HOMEOWNER_FACT_NOT_MATCHED');
SELECT pg_temp.refused(format($q$INSERT INTO homeowner_profiles (tenant_id, id, contact_id, contact_address_id, county_key, status, recognized_by,
    checked_at, address_updated_at, next_refresh_at, retention_until) VALUES (%L, gen_random_uuid(), %L, %L, 'sc-beaufort', 'not_available',
    '{seller_intent}', now(), now(), now(), now())$q$, :tA, :c1, :h1), 'R-HOME-9 E589: tenant B''s system cannot write a tenant A row', 'row-level security');

-- =============================================================================
-- 3. Guards (R-HOME-3; E584)
-- =============================================================================
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.refused(pg_temp.profile_sql(gen_random_uuid(), :c1, :h2), 'R-HOME-3: a profile of another contact''s address is refused', 'HOMEOWNER_ADDRESS_NOT_CONTACTS');
SELECT pg_temp.refused(format('UPDATE homeowner_profiles SET contact_id = %L WHERE id = %L', :c2, :p1), 'R-HOME-3: a profile''s contact never changes', 'HOMEOWNER_PROFILE_SUBJECT_FIXED');
SELECT pg_temp.refused(format('UPDATE homeowner_profiles SET contact_address_id = %L WHERE id = %L', :h5, :p1), 'R-HOME-3: a profile''s address never changes', 'HOMEOWNER_PROFILE_SUBJECT_FIXED');
SELECT pg_temp.refused(format($q$UPDATE homeowner_profiles SET status = 'not_matched', match_detail = 'owner_name_mismatch' WHERE id = %L$q$, :p1),
                       'R-HOME-3 E584: a profile cannot leave matched while facts remain', 'HOMEOWNER_FACTS_REMAIN');
SELECT pg_temp.ok(pg_temp.try(format('DELETE FROM homeowner_profile_facts WHERE profile_id = %L', :p5)) = 'OK'
                  AND pg_temp.try(format($q$UPDATE homeowner_profiles SET status = 'not_matched', match_detail = 'owner_name_mismatch' WHERE id = %L$q$, :p5)) = 'OK',
                  'R-HOME-3 E584: facts deleted first, the profile then leaves matched');
SELECT pg_temp.refused(pg_temp.fact_sql(:p5, 'tax_year', 'int_value', '2025'), 'R-HOME-3: a fact on a not_matched profile is refused', 'HOMEOWNER_FACT_NOT_MATCHED');

-- =============================================================================
-- 4. CHECKs: nothing but the closed, typed field list (R-HOME-4); retention (E587)
-- =============================================================================
SELECT pg_temp.refused(pg_temp.fact_sql(:p1, 'loan_balance_cents', 'cents_value', '100'), 'R-HOME-4: a loan balance is not expressible', 'check constraint');
SELECT pg_temp.refused(pg_temp.fact_sql(:p1, 'equity_cents', 'cents_value', '100'), 'R-HOME-4: equity is not expressible', 'check constraint');
SELECT pg_temp.refused(pg_temp.fact_sql(:p1, 'estimated_value_cents', 'cents_value', '100'), 'R-HOME-4: an estimate is not expressible', 'check constraint');
SELECT pg_temp.refused(pg_temp.fact_sql(:p1, 'owner_age', 'int_value', '50'), 'R-HOME-4: an unknown field is refused', 'check constraint');
SELECT pg_temp.refused(pg_temp.fact_sql(:p1, 'assessed_value_cents', 'date_value', $v$'2020-01-01'$v$), 'R-HOME-4: a value in the wrong column is refused', 'check constraint');
SELECT pg_temp.refused(pg_temp.fact_sql(:p1, 'assessed_value_cents', 'cents_value', '-1'), 'R-HOME-4: negative cents are refused', 'check constraint');
SELECT pg_temp.refused(pg_temp.fact_sql(:p1, 'tax_year', 'int_value', '1800'), 'R-HOME-4: a tax year outside 1900-2200 is refused', 'check constraint');
SELECT pg_temp.refused(pg_temp.fact_sql(:p1, 'owner_mailing_address', 'text_value', $v$E'PO BOX 1\nX'$v$), 'R-HOME-4: control characters in text are refused', 'check constraint');
SELECT pg_temp.refused(pg_temp.fact_sql(:p1, 'owner_mailing_address', 'text_value', format('%L', repeat('A', 301))), 'R-HOME-4: text over 300 characters is refused', 'check constraint');
SELECT pg_temp.refused(format($q$INSERT INTO homeowner_profile_facts (tenant_id, profile_id, field, int_value, source) VALUES (app.tenant_id(), %L, 'tax_year', 2025, NULL)$q$, :p1),
                       'R-HOME-4: a fact without a source is refused', 'null value|not-null');
SELECT pg_temp.refused(format($q$INSERT INTO homeowner_profile_facts (tenant_id, profile_id, field, int_value, source) VALUES (app.tenant_id(), %L, 'tax_year', 2025, 'bad<source>')$q$, :p1),
                       'R-HOME-4: a malformed source label is refused', 'check constraint');
SELECT pg_temp.refused(format($q$UPDATE homeowner_profiles SET retention_until = checked_at + interval '367 days' WHERE id = %L$q$, :p1),
                       'R-HOME-9 E587: retention beyond 366 days of the last check is refused', 'check constraint');
SELECT pg_temp.refused(format($q$INSERT INTO homeowner_profiles (tenant_id, id, contact_id, contact_address_id, county_key, status, recognized_by,
    checked_at, last_failure_at, last_failure_code, address_updated_at, next_refresh_at, retention_until) VALUES (app.tenant_id(), gen_random_uuid(), %L, %L,
    'sc-beaufort', 'failed', '{seller_intent}', now(), now(), 'timeout', now(), now(), now())$q$, :c6, :h6),
                       'R-HOME-7: a failed profile with checked_at is refused (unique address aside)', 'check constraint|duplicate key');
SELECT pg_temp.refused(format($q$UPDATE homeowner_profiles SET status = 'failed', checked_at = now(), last_failure_at = now(), last_failure_code = 'timeout' WHERE id = %L$q$, :p5),
                       'R-HOME-7: failed with checked_at is refused', 'check constraint');
SELECT pg_temp.refused(format($q$UPDATE homeowner_profiles SET status = 'not_matched', match_detail = NULL WHERE id = %L$q$, :p5),
                       'R-HOME-3: not_matched without its detail is refused', 'check constraint');
SELECT pg_temp.refused(format($q$UPDATE homeowner_profiles SET last_failure_at = now(), last_failure_code = NULL WHERE id = %L$q$, :p5),
                       'R-HOME-7: a half failure stamp is refused', 'check constraint');
SELECT pg_temp.refused(format($q$UPDATE homeowner_profiles SET recognized_by = '{investor}' WHERE id = %L$q$, :p5),
                       'R-HOME-1: an unknown recognition reason is refused', 'check constraint');
SELECT pg_temp.refused(format($q$UPDATE homeowner_profiles SET county_key = 'Beaufort County' WHERE id = %L$q$, :p5),
                       'R-HOME-2: a malformed county key is refused', 'check constraint');

-- E587: an expired row is hidden from every user, still visible to the system (which purges it)
UPDATE homeowner_profiles SET checked_at = now() - interval '400 days', retention_until = now() - interval '40 days' WHERE id = :p2;
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok(pg_temp.seen(:p2) = 0, 'R-HOME-9 E587: an expired profile and its facts are hidden from its agent');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.ok(pg_temp.seen(:p2) = 0, 'R-HOME-9 E587: an expired profile is hidden from the Owner');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.ok((SELECT count(*) FROM homeowner_profile_facts WHERE profile_id = :p2) = 2, 'E587: the system still sees the expired profile''s facts');
SELECT pg_temp.ok(pg_temp.rows_affected(format('DELETE FROM homeowner_profiles WHERE id = %L AND retention_until <= now()', :p2)) = 1,
                  'R-HOME-9 E587: the system purges the expired profile');
SELECT pg_temp.ok((SELECT count(*) FROM homeowner_profile_facts WHERE profile_id = :p2) = 0,
                  'R-HOME-9 E587: the system purges the expired profile, and its facts cascade');

-- =============================================================================
-- 5. Cascades: erasure (E570) and address deletion (E571)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT app.erase_contact(:c1, gen_random_uuid(), 'privacy request');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.ok(pg_temp.seen(:p1) = 0, 'R-HOME-9 E570: erasure removes the contact''s profile and facts');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(pg_temp.rows_affected(format('DELETE FROM contact_addresses WHERE id = %L', :h6)) = 1, 'E571: the agent deletes the address');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.ok(pg_temp.seen(:p6) = 0, 'R-HOME-9 E571: deleting the address removes its profile and facts');

SELECT pg_temp.ok(true, 'ALL HOMEOWNER RLS SMOKE CHECKS PASSED');
ROLLBACK;
