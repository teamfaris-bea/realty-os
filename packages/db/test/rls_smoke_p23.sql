-- =============================================================================
-- RLS / integrity smoke test for 0018_phase2_3_schema.sql (Phase 2-3 tables, channels, client principal),
-- including the round-2 adversarial review cases (ARCHITECTURE §20: S1-S16, F4, F10, F12, F14).
-- Same shape as rls_smoke.sql: ONE transaction, rolled back; every application step runs as app_user;
-- a failed expectation raises 'FAIL ...'. Platform maintenance steps (counsel clearing a platform pack,
-- releasing a prediction model) run as the owner role between RESET ROLE and SET LOCAL ROLE.
-- Run by packages/db/test/rls_smoke_p23.test.ts.
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

-- =============================================================================
-- 1. Integrations: the routing key and the honest status are the provider callback's (R-INT-3, S2)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO integration_connections (tenant_id, id, kind, status, display_name, external_account_id,
  lead_source_id, connected_at, connected_by_user_id) VALUES (%L, gen_random_uuid(), 'messenger_page', 'connected', 'Team A Page', '1001',
  %L, now(), %L)$q$, :tA, :srcA, :ownA),
  'R-INT-3: an Owner cannot mark a Page connected by typing its id (no self-reported status)', '%CONNECTION_PROOF_REQUIRED%');
SELECT pg_temp.expect_error(format($q$INSERT INTO integration_connections (tenant_id, id, kind, status, display_name, external_account_id)
  VALUES (%L, gen_random_uuid(), 'messenger_page', 'pending_review', 'Squat', '2002')$q$, :tA),
  'R-INT-3: nobody squats a Page id ahead of its owner (pending_review is the callback''s too)', '%CONNECTION_PROOF_REQUIRED%');
INSERT INTO integration_connections (tenant_id, id, kind, display_name) VALUES (:tA, :icA, 'messenger_page', 'Team A Page');
SELECT pg_temp.ok((SELECT status = 'not_configured' FROM integration_connections WHERE id = :icA), 'the Owner creates an unconfigured connection');
-- the OAuth callback (system) proves control, stores the credential and connects
SELECT pg_temp.ctx(:tA, NULL, 'system');
INSERT INTO provider_credentials (tenant_id, id, provider, secret_enc, key_version) VALUES
  (:tA, :credA, 'meta', '\x01', 1), (:tA, :credM, 'mls', '\x01', 1), (:tA, :credAd, 'meta', '\x01', 1);
SELECT pg_temp.expect_error(format($q$UPDATE integration_connections SET status = 'connected', connected_at = now(), external_account_id = '1001',
  lead_source_id = %L WHERE id = %L$q$, :srcA, :icA),
  'a live external account needs the credential the callback stored', '%check constraint%');
SELECT pg_temp.expect_error(format($q$UPDATE integration_connections SET status = 'connected', connected_at = now(), external_account_id = '1001',
  credential_id = %L WHERE id = %L$q$, :credA, :icA),
  'a connected inbound channel must name the lead source it attributes contacts to', '%check constraint%');
UPDATE integration_connections SET status = 'connected', connected_at = now(), external_account_id = '1001', credential_id = :credA,
       lead_source_id = :srcA WHERE id = :icA;
INSERT INTO integration_connections (tenant_id, id, kind, status, display_name, external_account_id, credential_id, lead_source_id, connected_at)
VALUES (:tA, :icIG, 'instagram_account', 'connected', 'Team A Instagram', '2001', :credA, :srcA, now());
SELECT pg_temp.ok((SELECT count(*) FROM integration_connections WHERE status = 'connected') = 2, 'the provider callback connects the Page and the Instagram account');
SELECT pg_temp.ctx(:tA, :admA, 'user');
SELECT pg_temp.expect_error(format($q$UPDATE integration_connections SET external_account_id = '3003' WHERE id = %L$q$, :icA),
  'S2: an Admin cannot re-point a connected Page to another external account', '%CONNECTION_ACCOUNT_IMMUTABLE%');
SELECT pg_temp.expect_error(format($q$UPDATE integration_connections SET capabilities = '{"send": true}' WHERE id = %L$q$, :icA),
  'R-INT-2: capabilities are what the adapter reports, never typed in', '%CONNECTION_CAPABILITIES_REPORTED%');
UPDATE integration_connections SET display_name = 'Team A on Facebook' WHERE id = :icA;
SELECT pg_temp.ok((SELECT display_name = 'Team A on Facebook' FROM integration_connections WHERE id = :icA), 'Owner/Admin may rename a connection');
-- tenant B's callback cannot take a Page that is live in tenant A
SELECT pg_temp.ctx(:tB, NULL, 'system');
INSERT INTO provider_credentials (tenant_id, id, provider, secret_enc, key_version) VALUES (:tB, :credB, 'meta', '\x01', 1);
SELECT pg_temp.expect_error(format($q$INSERT INTO integration_connections (tenant_id, id, kind, status, display_name, external_account_id,
  credential_id, lead_source_id, connected_at) VALUES (%L, gen_random_uuid(), 'messenger_page', 'connected', 'Same Page', '1001', %L, %L, now())$q$,
  :tB, :credB, :srcB),
  'R-INT-3: a Facebook Page is live in at most one tenant (global unique live account)', '%integration_connections_live_account%');
SELECT pg_temp.ctx(:tB, :ownB, 'user');
INSERT INTO integration_connections (tenant_id, id, kind, status, display_name) VALUES (:tB, gen_random_uuid(), 'zillow_feed', 'needs_partner_access', 'Zillow');
SELECT pg_temp.ok((SELECT count(*) FROM integration_connections) = 1, 'owner B sees only tenant B connections');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM integration_connections) = 2, 'agents read connection status');
SELECT pg_temp.expect_error(format($q$INSERT INTO integration_connections (tenant_id, id, kind, display_name) VALUES (%L, gen_random_uuid(), 'showing_service', 'x')$q$, :tA),
  'agents cannot add connections', '%row-level security%');
-- a web-chat widget has no external account: its key is server-generated, so the Owner switches it on
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO integration_connections (tenant_id, id, kind, status, display_name, lead_source_id, connected_at, widget_key_hash, allowed_origins)
VALUES (:tA, :wcA, 'web_chat_widget', 'connected', 'Website chat', :srcA, now(), digest('widget-key', 'sha256'), '{https://a-realty.test}');
SELECT pg_temp.expect_error(format($q$INSERT INTO integration_connections (tenant_id, id, kind, display_name, allowed_sender_domains)
  VALUES (%L, gen_random_uuid(), 'messenger_page', 'x', '{zillow.com}')$q$, :tA),
  'R-INBOX-9: sender-domain allowlists exist only on lead-email inboxes', '%check constraint%');

-- =============================================================================
-- 2. Channels: DM identities, the explicit-map dispatch guard, counsel gate, person-level do-not-contact
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
  VALUES (%L, gen_random_uuid(), %L, 'messenger', 'jane.doe', digest('x', 'sha256'))$q$, :tA, :c1),
  'a Messenger identity must be fb:{page}:{psid}', '%contact_points_platform_address%');
INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000f101', :c1, 'messenger', 'fb:1001:777', digest('fb:1001:777', 'sha256')),
       (:tA, 'a0000000-0000-7000-8000-00000000f102', :c1, 'messenger', 'fb:1009:888', digest('fb:1009:888', 'sha256')),
       (:tA, 'a0000000-0000-7000-8000-00000000f104', :c1, 'instagram', 'ig:2001:555', digest('ig:2001:555', 'sha256')),
       (:tA, 'a0000000-0000-7000-8000-00000000f105', :c1, 'web_chat', 'wc:0123456789abcdef0123456789abcdef',
        digest('wc:0123456789abcdef0123456789abcdef', 'sha256'));
SELECT pg_temp.expect_error(format($q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, integration_connection_id,
  from_address, to_address, body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at) VALUES (%L, gen_random_uuid(),
  %L, %L, 'messenger', 'outbound', %L, 'fb:1001', 'fb:1001:777', 'Hi Alice', 'dispatching', 'human', %L, 'informational', now(), now())$q$,
  :tA, :cvA, :c1, :icA, :agA1),
  'R-INT-6: Messenger sending stays off until counsel clears the platform:meta pack', '%PLATFORM_NOT_CLEARED%');
-- platform maintenance records counsel's review of the pack
RESET ROLE;
UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:meta';
SET LOCAL ROLE app_user;
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address,
  to_address, body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at) VALUES (%L, gen_random_uuid(), %L, %L,
  'messenger', 'outbound', 'fb:1001', 'fb:1001:777', 'Hi Alice', 'dispatching', 'human', %L, 'informational', now(), now())$q$,
  :tA, :cvA, :c1, :agA1),
  'an outbound DM must name its channel connection', '%messages_platform_sender%');
INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, integration_connection_id, from_address,
       to_address, body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at)
VALUES (:tA, gen_random_uuid(), :cvA, :c1, 'messenger', 'outbound', :icA, 'fb:1001', 'fb:1001:777', 'Hi Alice, it''s Ava.',
        'dispatching', 'human', :agA1, 'informational', now(), now()),
       (:tA, gen_random_uuid(), :cvA, :c1, 'instagram', 'outbound', :icIG, 'ig:2001', 'ig:2001:555', 'Hi Alice, Ava here on Instagram.',
        'dispatching', 'human', :agA1, 'informational', now(), now()),
       (:tA, gen_random_uuid(), :cvA, :c1, 'web_chat', 'outbound', :wcA, 'wc', 'wc:0123456789abcdef0123456789abcdef', 'Thanks for writing in!',
        'dispatching', 'human', :agA1, 'informational', now(), now());
SELECT pg_temp.ok(true, 'once cleared, human Messenger, Instagram and web-chat replies to a contact who has not opted out dispatch');
SELECT pg_temp.expect_error(format($q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address,
  to_address, body, status, initiator, initiated_by_user_id, purpose, occurred_at) VALUES (%L, gen_random_uuid(), %L, %L,
  'portal', 'outbound', 'x', 'y', 'b', 'queued', 'human', %L, 'informational', now())$q$, :tA, :cvA, :c1, :agA1),
  'a channel the opt-out map does not know cannot even be stored', '%messages_channel_check%');
SELECT pg_temp.ok((SELECT prosrc LIKE '%CHANNEL_UNKNOWN%' AND prosrc NOT LIKE '%ELSE ''sms''%' FROM pg_proc
                    WHERE oid = 'app.messages_dispatch_guard()'::regprocedure),
                  'the dispatch guard maps channels explicitly and fails closed (no ELSE sms fallthrough)');

-- STOP on the first Messenger identity and on the Instagram identity, opt-out in the chat session (system, inbound)
SELECT pg_temp.ctx(:tA, NULL, 'system');
INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose, event_type, consent_level,
       source, occurred_at, actor_kind, contact_id, evidence_message_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ce01', 'messenger', digest('fb:1001:777', 'sha256'), 'fb:…777', 'messenger', 'all',
        'revoke', 'none', 'inbound_keyword', now(), 'system', :c1, gen_random_uuid()),
       (:tA, 'a0000000-0000-7000-8000-00000000ce04', 'instagram', digest('ig:2001:555', 'sha256'), 'ig:…555', 'instagram', 'all',
        'revoke', 'none', 'inbound_keyword', now(), 'system', :c1, gen_random_uuid()),
       (:tA, 'a0000000-0000-7000-8000-00000000ce05', 'web_chat', digest('wc:0123456789abcdef0123456789abcdef', 'sha256'), 'wc:…cdef',
        'web_chat', 'all', 'revoke', 'none', 'inbound_keyword', now(), 'system', :c1, gen_random_uuid());
INSERT INTO consent_state (tenant_id, channel, purpose, address_hmac, status, consent_level, basis_event_id, ledger_event_count)
VALUES (:tA, 'messenger', 'informational', digest('fb:1001:777', 'sha256'), 'revoked', 'none', 'a0000000-0000-7000-8000-00000000ce01', 1),
       (:tA, 'instagram', 'informational', digest('ig:2001:555', 'sha256'), 'revoked', 'none', 'a0000000-0000-7000-8000-00000000ce04', 1),
       (:tA, 'web_chat', 'informational', digest('wc:0123456789abcdef0123456789abcdef', 'sha256'), 'revoked', 'none',
        'a0000000-0000-7000-8000-00000000ce05', 1);
SELECT pg_temp.expect_error(format($q$INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose,
  event_type, consent_level, source, occurred_at, actor_kind) VALUES (%L, gen_random_uuid(), 'messenger', digest('fb:1:2', 'sha256'),
  'x', 'sms', 'all', 'revoke', 'none', 'inbound_keyword', now(), 'system')$q$, :tA),
  'a Messenger identity can only carry Messenger consent', '%consent_events_platform_kind%');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction,
  integration_connection_id, from_address, to_address, body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at)
  VALUES (%L, gen_random_uuid(), %L, %L, 'messenger', 'outbound', %L, 'fb:1001', 'fb:1001:777', 'Still there?', 'sent', 'human', %L,
  'informational', now(), now())$q$, :tA, :cvA, :c1, :icA, :agA1),
  'R-INBOX-3: a DM to an identity that sent STOP is refused for every initiator', '%RECIPIENT_OPTED_OUT%');
SELECT pg_temp.expect_error(format($q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction,
  integration_connection_id, from_address, to_address, body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at)
  VALUES (%L, gen_random_uuid(), %L, %L, 'messenger', 'outbound', %L, 'fb:1009', 'fb:1009:888', 'Other Page', 'sent', 'human', %L,
  'informational', now(), now())$q$, :tA, :cvA, :c1, :icA, :agA1),
  'E76: a Messenger STOP blocks the same person''s identity on the team''s other Page too', '%RECIPIENT_OPTED_OUT%');
SELECT pg_temp.expect_error(format($q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction,
  integration_connection_id, from_address, to_address, body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at)
  VALUES (%L, gen_random_uuid(), %L, %L, 'instagram', 'outbound', %L, 'ig:2001', 'ig:2001:555', 'Hello?', 'sent', 'human', %L,
  'informational', now(), now())$q$, :tA, :cvA, :c1, :icIG, :agA1),
  'R-CHAN-4: an Instagram STOP blocks Instagram for every initiator', '%RECIPIENT_OPTED_OUT%');
SELECT pg_temp.expect_error(format($q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction,
  integration_connection_id, from_address, to_address, body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at)
  VALUES (%L, gen_random_uuid(), %L, %L, 'web_chat', 'outbound', %L, 'wc', 'wc:0123456789abcdef0123456789abcdef', 'Hello?', 'sent', 'human', %L,
  'informational', now(), now())$q$, :tA, :cvA, :c1, :wcA, :agA1),
  'R-INBOX-3: an opted-out chat identity gets no further chat replies', '%RECIPIENT_OPTED_OUT%');

-- Person-level do-not-contact on c2 (agent 2 records "do not contact me")
SELECT pg_temp.ctx(:tA, :agA2, 'user');
INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose, event_type, consent_level,
       source, occurred_at, actor_kind, actor_user_id, contact_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ce02', 'email', digest('carol@example.test', 'sha256'), 'c…@example.test', 'email', 'all',
        'revoke', 'none', 'agent_revoke', now(), 'user', :agA2, :c2),
       (:tA, 'a0000000-0000-7000-8000-00000000ce03', 'phone', digest('+15555550202', 'sha256'), '•••-0202', 'sms', 'informational',
        'grant', 'express', 'agent_entry', now(), 'user', :agA2, :c2);
SELECT pg_temp.expect_error(format($q$UPDATE contacts SET do_not_contact_at = now(), do_not_contact_event_id = %L WHERE id = %L$q$,
  'a0000000-0000-7000-8000-00000000ce03', :c2),
  'a person-level do-not-contact must cite a revoke in the consent ledger', '%PERSON_OPT_OUT_EVIDENCE%');
UPDATE contacts SET do_not_contact_at = now(), do_not_contact_event_id = 'a0000000-0000-7000-8000-00000000ce02' WHERE id = :c2;
SELECT pg_temp.ok((SELECT do_not_contact_at IS NOT NULL FROM contacts WHERE id = :c2), 'agent records a person-level do-not-contact');
SELECT pg_temp.expect_error(format($q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id,
  from_address, to_address, body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at) VALUES (%L, gen_random_uuid(),
  %L, %L, 'sms', 'outbound', %L, '+15555559100', '+15555550202', 'Quick question', 'dispatching',
  'human', %L, 'informational', now(), now())$q$, :tA, :cvA2, :c2, :num, :agA2),
  'R-CHAN-2: a person-level do-not-contact blocks a text to a phone with no revoke of its own', '%PERSON_DO_NOT_CONTACT%');
SELECT pg_temp.expect_error(format($q$INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, phone_number_id, agent_user_id,
  client_address, initiator, handled_by, status, started_at, recording_mode, recording_decision) VALUES (%L, gen_random_uuid(), %L, %L,
  'outbound', %L, %L, '+15555550202', 'human', 'human', 'initiated', now(), 'off', '{}')$q$,
  :tA, :cvA2, :c2, :num, :agA2),
  'R-CHAN-2: a person-level do-not-contact blocks a call', '%PERSON_DO_NOT_CONTACT%');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.expect_error(format($q$UPDATE contacts SET do_not_contact_at = NULL, do_not_contact_event_id = NULL WHERE id = %L$q$, :c2),
  'nobody on the team can lift a person-level do-not-contact (Owner included)', '%PERSON_OPT_OUT_FINAL%');
-- E140 (S4): the duplicate merges; the survivor takes the do-not-contact, and a point added to it later is covered
UPDATE contacts SET merged_into_contact_id = :c4 WHERE id = :c2;
SELECT pg_temp.ok((SELECT do_not_contact_event_id = 'a0000000-0000-7000-8000-00000000ce02' AND do_not_contact_at IS NOT NULL
                     FROM contacts WHERE id = :c4),
                  'S4 E140: the merge survivor takes the person-level do-not-contact (earliest instant, its ledger event)');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000f401', :c4, 'email', 'carol.new@example.test', digest('carol.new@example.test', 'sha256'));
SELECT pg_temp.expect_error(format($q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, email_identity_id,
  from_address, to_address, subject, body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at) VALUES (%L,
  gen_random_uuid(), %L, %L, 'email', 'outbound', %L, 'team@a-realty.test', 'carol.new@example.test', 'Checking in', 'Hi Carol',
  'dispatching', 'human', %L, 'informational', now(), now())$q$, :tA, :cvA4, :c4, :eid, :agA2),
  'R-CHAN-2 E140: an address added to the merge survivor after the merge is blocked too', '%PERSON_DO_NOT_CONTACT%');

-- =============================================================================
-- 3. MLS listings and marketing pieces: approval bound to content and assets (R-MLS-1, R-MKT-1..5, S9, S10)
-- =============================================================================
SELECT pg_temp.ctx(:tA, NULL, 'system');
INSERT INTO integration_connections (tenant_id, id, kind, status, display_name, external_account_id, credential_id, connected_at, license_pack)
VALUES (:tA, :mlsA, 'mls_feed', 'connected', 'Coastal MLS', 'cmls-17', :credM, now(), '{"reviewed": false}');
SELECT pg_temp.expect_error(format($q$INSERT INTO listings (tenant_id, id, source, mls_number, status, address_line1, city, region, postal_code)
  VALUES (%L, gen_random_uuid(), 'mls', 'X1', 'active', '1 Main', 'Town', 'SC', '29401')$q$, :tA),
  'an MLS row needs its feed connection, modification time and listing brokerage', '%listings_mls_shape%');
INSERT INTO listings (tenant_id, id, source, mls_number, status, address_line1, city, region, postal_code, mls_connection_id,
       mls_modified_at, listing_brokerage_name)
VALUES (:tA, :lM, 'mls', 'C-100', 'active', '9 Elm', 'Town', 'SC', '29401', :mlsA, now(), 'Other Brokerage');
SELECT pg_temp.expect_error(format($q$UPDATE listings SET list_price_cents = 1, mls_modified_at = now() - interval '1 day' WHERE id = %L$q$, :lM),
  'R-MLS-1: an older MLS modification never overwrites a newer one', '%MLS_STALE_UPDATE%');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(pg_temp.rows_affected(format($q$UPDATE listings SET status = 'sold' WHERE id = %L$q$, :lM)) = 0,
  'MLS rows are written by the system only');
SELECT pg_temp.expect_error(format($q$INSERT INTO marketing_pieces (tenant_id, id, listing_id, kind, version_no, prose, template_key,
  guard_result) VALUES (%L, gen_random_uuid(), %L, 'flyer', 1, '{}', 'flyer/1', '{}')$q$, :tA, :lM),
  'R-MKT-5: only the team''s own listings get marketing (never an MLS listing)', '%MARKETING_TEAM_LISTING_ONLY%');
SELECT pg_temp.expect_error(format($q$INSERT INTO marketing_pieces (tenant_id, id, listing_id, kind, version_no, status, prose, template_key,
  guard_result, approved_by_user_id, approved_at) VALUES (%L, gen_random_uuid(), %L, 'flyer', 1, 'approved', '{}', 'flyer/1',
  '{"brokerage_name_present": true, "hard_count": 0, "pack_rule_failures": []}', %L, now())$q$, :tA, :lA, :agA1),
  'R-MKT-1: a piece version is born a draft', '%MARKETING_BORN_DRAFT%');
INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, key_version, dek_wrapped, created_by_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ab51', 'marketing_asset', 'tenants/' || :tA || '/mk/1', 'image/jpeg', 10, digest('p1', 'sha256'), 1, '\x01', :agA1),
       (:tA, 'a0000000-0000-7000-8000-00000000ab52', 'document', 'tenants/' || :tA || '/doc/private', 'application/pdf', 10, digest('p2', 'sha256'), 1, '\x01', :agA1),
       (:tA, 'a0000000-0000-7000-8000-00000000ab53', 'marketing_asset', 'tenants/' || :tA || '/mk/2', 'image/jpeg', 10, digest('p3', 'sha256'), 1, '\x01', :agA1);
INSERT INTO marketing_pieces (tenant_id, id, listing_id, kind, version_no, prose, template_key, guard_result, created_by_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000f301', :lA, 'website_page', 1, '{"headline": "Light-filled cottage"}', 'page/1',
        '{"brokerage_name_present": true, "hard_count": 1, "pack_rule_failures": []}', :agA1);
SELECT pg_temp.ok((SELECT content_sha256 = app.marketing_content_sha256(tenant_id, id, prose, template_key, bound_fields)
                     FROM marketing_pieces WHERE id = 'a0000000-0000-7000-8000-00000000f301'),
                  'S9: a piece''s content hash is the database''s own, never the writer''s');
SELECT pg_temp.expect_error(format($q$INSERT INTO marketing_piece_assets (tenant_id, piece_id, position, object_id) VALUES (%L, %L, 1, %L)$q$,
  :tA, 'a0000000-0000-7000-8000-00000000f301', 'a0000000-0000-7000-8000-00000000ab52'),
  'S10: a piece shows only live marketing assets (a private document cannot become a public image)', '%MARKETING_ASSET_INVALID%');
INSERT INTO marketing_piece_assets (tenant_id, piece_id, position, object_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000f301', 1, 'a0000000-0000-7000-8000-00000000ab51');
SELECT pg_temp.expect_error(format($q$UPDATE marketing_pieces SET status = 'approved', approved_by_user_id = %L, approved_at = now() WHERE id = %L$q$,
  :agA1, 'a0000000-0000-7000-8000-00000000f301'),
  'R-FH-1: a hard fair-housing match blocks approval', '%marketing_pieces_check%');
INSERT INTO marketing_pieces (tenant_id, id, listing_id, kind, version_no, prose, template_key, guard_result, created_by_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000f305', :lA, 'flyer', 1, '{"headline": "12 Oak St"}', 'flyer/1', '{}', :agA1);
SELECT pg_temp.expect_error(format($q$UPDATE marketing_pieces SET status = 'approved', approved_by_user_id = %L, approved_at = now() WHERE id = %L$q$,
  :agA1, 'a0000000-0000-7000-8000-00000000f305'),
  'R-MKT-1: a guard result missing its checks is a refusal, never a NULL the CHECK lets through', '%marketing_pieces_check%');
UPDATE marketing_pieces SET prose = '{"headline": "Light-filled cottage near the park"}',
       guard_result = '{"brokerage_name_present": true, "hard_count": 0, "soft_count": 0, "pack_rule_failures": []}'
 WHERE id = 'a0000000-0000-7000-8000-00000000f301';
SELECT pg_temp.expect_error(format($q$UPDATE marketing_pieces SET status = 'approved', approved_by_user_id = %L, approved_at = now() WHERE id = %L$q$,
  :agA1, 'a0000000-0000-7000-8000-00000000f301'),
  'S9 R-MKT-1: approval needs a guard result computed over this exact content', '%marketing_pieces_check%');
UPDATE marketing_pieces SET guard_result = guard_result || jsonb_build_object('content_sha256', content_sha256)
 WHERE id = 'a0000000-0000-7000-8000-00000000f301';
UPDATE marketing_pieces SET prose = '{"headline": "Light-filled cottage, steps from the park"}' WHERE id = 'a0000000-0000-7000-8000-00000000f301';
SELECT pg_temp.expect_error(format($q$UPDATE marketing_pieces SET status = 'approved', approved_by_user_id = %L, approved_at = now() WHERE id = %L$q$,
  :agA1, 'a0000000-0000-7000-8000-00000000f301'),
  'S9: a draft edited after the guard ran cannot be approved with the old result', '%marketing_pieces_check%');
UPDATE marketing_pieces SET guard_result = guard_result || jsonb_build_object('content_sha256', content_sha256)
 WHERE id = 'a0000000-0000-7000-8000-00000000f301';
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok(pg_temp.rows_affected(format($q$UPDATE marketing_pieces SET status = 'approved', approved_by_user_id = %L, approved_at = now()
  WHERE id = %L$q$, :agA2, 'a0000000-0000-7000-8000-00000000f301')) = 0, 'an agent who is not the listing agent cannot approve the piece');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(format($q$UPDATE marketing_pieces SET status = 'approved', approved_by_user_id = %L, approved_at = now() WHERE id = %L$q$,
  :agA1, 'a0000000-0000-7000-8000-00000000f301'),
  'the system cannot approve a piece on a person''s behalf', '%MARKETING_HUMAN_APPROVAL%');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
UPDATE marketing_pieces SET status = 'approved', approved_by_user_id = :agA1, approved_at = now() WHERE id = 'a0000000-0000-7000-8000-00000000f301';
SELECT pg_temp.ok((SELECT status = 'approved' FROM marketing_pieces WHERE id = 'a0000000-0000-7000-8000-00000000f301'),
                  'the listing agent approves the version once, as themselves');
SELECT pg_temp.expect_error(format($q$UPDATE marketing_pieces SET prose = '{"headline": "Changed"}' WHERE id = %L$q$, 'a0000000-0000-7000-8000-00000000f301'),
  'R-MKT-2: approved copy is frozen; a change is a new version', '%MARKETING_FROZEN%');
SELECT pg_temp.expect_error(format($q$UPDATE marketing_pieces SET guard_result = guard_result || '{"note": "anything"}' WHERE id = %L$q$,
  'a0000000-0000-7000-8000-00000000f301'),
  'S9: the approved guard result is frozen with the copy', '%MARKETING_FROZEN%');
SELECT pg_temp.expect_error(format($q$INSERT INTO marketing_piece_assets (tenant_id, piece_id, position, object_id) VALUES (%L, %L, 2, %L)$q$,
  :tA, 'a0000000-0000-7000-8000-00000000f301', 'a0000000-0000-7000-8000-00000000ab53'),
  'S9: an approved version keeps its images (no image added)', '%MARKETING_FROZEN%');
SELECT pg_temp.expect_error(format($q$DELETE FROM marketing_piece_assets WHERE piece_id = %L$q$, 'a0000000-0000-7000-8000-00000000f301'),
  'S9: an approved version keeps its images (none removed)', '%MARKETING_FROZEN%');
SELECT pg_temp.expect_error(format($q$UPDATE marketing_pieces SET listing_id = %L WHERE id = %L$q$, :lM, 'a0000000-0000-7000-8000-00000000f301'),
  'R-MKT-5: a piece never moves to another (MLS) listing', '%MARKETING_IDENTITY_IMMUTABLE%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(format($q$UPDATE marketing_pieces SET status = 'published', published_at = now(), public_slug = '12-oak-st' WHERE id = %L$q$,
  'a0000000-0000-7000-8000-00000000f301'),
  'R-INT-6: publishing waits for counsel review of the platform:fair_housing pack', '%PLATFORM_NOT_CLEARED%');
-- an invite email goes out only from an approved open-house invite version (S9)
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO marketing_pieces (tenant_id, id, listing_id, kind, version_no, prose, template_key, guard_result, created_by_user_id, open_house)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000f302', :lA, 'open_house_invite', 1, '{"text": "Perfect for young families!"}', 'invite/1',
        '{"brokerage_name_present": false, "hard_count": 1, "pack_rule_failures": ["brokerage_name"]}', :agA1, '{"starts_at": "2026-11-15T13:00:00Z"}');
SELECT pg_temp.expect_error(format($q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, email_identity_id,
  from_address, to_address, subject, body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at, marketing_piece_id)
  VALUES (%L, gen_random_uuid(), %L, %L, 'email', 'outbound', %L, 'team@a-realty.test', 'alice@example.test', 'Open house Sunday',
  'Perfect for young families!', 'dispatching', 'human', %L, 'marketing', now(), now(), %L)$q$,
  :tA, :cvA, :c1, :eid, :agA1, 'a0000000-0000-7000-8000-00000000f302'),
  'S9 R-MKT-8: an invite email citing a draft piece never dispatches', '%MARKETING_PIECE_NOT_APPROVED%');
SELECT pg_temp.ctx(:tB, :ownB, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM marketing_pieces) + (SELECT count(*) FROM marketing_piece_assets) + (SELECT count(*) FROM listings) = 0,
                  'tenant B sees no tenant A listings, pieces or assets');

-- =============================================================================
-- 4. Trigger playbooks: a step run without an enrollment, at most once per fact (R-NURT-1)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO playbooks (tenant_id, id, kind, scope, owner_user_id, name)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000b001', 'trigger', 'agent', :agA1, 'Behavior alerts');
INSERT INTO playbook_versions (tenant_id, id, playbook_id, version_no, steps, content_sha256, created_by_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000b011', 'a0000000-0000-7000-8000-00000000b001', 1, '[]', :SHA, :agA1),
       (:tA, 'a0000000-0000-7000-8000-00000000b013', 'a0000000-0000-7000-8000-00000000b001', 2,
        '{"kind": "triggers", "triggers": [{"stepKey": "price_drop", "trigger": "price_drop", "channel": "email"}]}', :SHA, :agA1);
SELECT pg_temp.ok((SELECT jsonb_typeof(steps) = 'object' FROM playbook_versions WHERE id = 'a0000000-0000-7000-8000-00000000b013'),
                  'a trigger playbook version stores one content object, hashed and frozen like steps');
SELECT pg_temp.ctx(:tA, NULL, 'system');
INSERT INTO playbook_step_runs (tenant_id, id, enrollment_id, playbook_version_id, step_key, status, scheduled_for, contact_id, trigger_key, trigger_ref)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000b021', NULL, 'a0000000-0000-7000-8000-00000000b011', 'price_drop', 'scheduled', now(), :c1,
        'trig:b011:price_drop:e001:f1a1:1', '{"listing_id": "a0000000-0000-7000-8000-00000000f1a1"}');
SELECT pg_temp.expect_error(format($q$INSERT INTO playbook_step_runs (tenant_id, id, enrollment_id, playbook_version_id, step_key, status,
  scheduled_for, contact_id, trigger_key, trigger_ref) VALUES (%L, gen_random_uuid(), NULL, %L, 'price_drop', 'scheduled', now(), %L,
  'trig:b011:price_drop:e001:f1a1:1', '{}')$q$, :tA, 'a0000000-0000-7000-8000-00000000b011', :c1),
  'R-NURT-1: the same fact fires a trigger step at most once per contact', '%playbook_step_runs_trigger_key%');
SELECT pg_temp.expect_error(format($q$INSERT INTO playbook_step_runs (tenant_id, id, enrollment_id, playbook_version_id, step_key, status,
  scheduled_for) VALUES (%L, gen_random_uuid(), NULL, %L, 'x', 'scheduled', now())$q$, :tA, 'a0000000-0000-7000-8000-00000000b011'),
  'a step run is either an enrollment step or a keyed trigger firing', '%playbook_step_runs_trigger_shape%');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM playbook_step_runs WHERE enrollment_id IS NULL) = 1, 'the contact owner sees the trigger firing');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM playbook_step_runs WHERE enrollment_id IS NULL) = 0, 'another agent does not');

-- =============================================================================
-- 5. Assistant decisions are a person's, as themselves; seller updates carry a recommendation (R-AST-21, R-SELL-3)
-- =============================================================================
SELECT pg_temp.ctx(:tA, NULL, 'system');
INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, trigger_ref)
VALUES (:tA, 'a0000000-0000-7000-8000-0000000aa101', :c2, 'seller_update_draft', 'seller_update', 'requires_approval', 'proposed', :agA2,
        'Weekly update for 40 Elm St', '{"sections": []}', jsonb_build_object('listing_id', :lC)),
       (:tA, 'a0000000-0000-7000-8000-0000000aa102', :c1, 'message_draft', 'novel_message', 'requires_approval', 'proposed', :agA1,
        'Suggested follow-up', '{"channel": "sms", "body": "Hi Alice"}', '{}');
SELECT pg_temp.expect_error(format($q$UPDATE assistant_actions SET status = 'approved', decided_by_user_id = %L, decided_at = now(),
  edited_payload = '{"recommendation": "Hold the price two more weeks; showings are picking up."}' WHERE id = %L$q$,
  :agA2, 'a0000000-0000-7000-8000-0000000aa101'),
  'R-AST-21: the system cannot approve an action in a person''s name', '%DECISION_ACTOR%');
SELECT pg_temp.expect_error(format($q$UPDATE assistant_actions SET status = 'executed' WHERE id = %L$q$, 'a0000000-0000-7000-8000-0000000aa102'),
  'R-AST-21: an action that needs approval is never executed without one', '%ACTION_NOT_APPROVED%');
SELECT pg_temp.expect_error(format($q$INSERT INTO assistant_actions (tenant_id, id, kind, action_category, autonomy, playbook_version_id, status,
  explanation, payload) VALUES (%L, gen_random_uuid(), 'ad_reallocation', 'money', 'within_playbook', gen_random_uuid(), 'proposed', 'Shift', '{}')$q$, :tA),
  'an ad budget shift can never be autonomous', '%check constraint%');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.expect_error(format($q$UPDATE assistant_actions SET status = 'approved', decided_by_user_id = %L, decided_at = now(),
  edited_payload = '{"recommendation": "ok"}' WHERE id = %L$q$, :agA2, 'a0000000-0000-7000-8000-0000000aa101'),
  'R-SELL-3: a seller update is approved only with the agent''s own recommendation', '%assistant_actions_seller_update_recommendation%');
SELECT pg_temp.expect_error(format($q$UPDATE assistant_actions SET status = 'approved', decided_by_user_id = %L, decided_at = now(),
  edited_payload = '{"body": "."}' WHERE id = %L$q$, :agA2, 'a0000000-0000-7000-8000-0000000aa101'),
  'R-SELL-3: a body edit is not a recommendation (one shape)', '%assistant_actions_seller_update_recommendation%');
UPDATE assistant_actions SET status = 'approved', decided_by_user_id = :agA2, decided_at = now(),
       edited_payload = '{"recommendation": "Hold the price two more weeks; showings are picking up."}'
 WHERE id = 'a0000000-0000-7000-8000-0000000aa101';
SELECT pg_temp.ok((SELECT decided_by_role = 'agent' FROM assistant_actions WHERE id = 'a0000000-0000-7000-8000-0000000aa101'),
                  'R-AST-21: a seller update with a written recommendation is approved, with the decider''s role recorded');
SELECT pg_temp.expect_error(format($q$UPDATE assistant_actions SET decided_by_user_id = %L WHERE id = %L$q$, :ownA, 'a0000000-0000-7000-8000-0000000aa101'),
  'R-AST-21: a decision cannot be re-attributed to someone else', '%DECISION_ACTOR%');

-- =============================================================================
-- 6. Milestones: proposals drive nothing; a person confirms and moves dates (R-TXN-1, R-TXN-5, S16)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA2, 'user');
INSERT INTO deal_dates (tenant_id, id, deal_id, kind, due_on, source, status, basis)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000dd01', :dA2, 'inspection', current_date + 10, 'template', 'proposed', '{"offset_days": 10}');
SELECT pg_temp.expect_error(format($q$UPDATE deal_dates SET status = 'confirmed' WHERE id = %L$q$, 'a0000000-0000-7000-8000-00000000dd01'),
  'R-TXN-1: a template date is not confirmed without a confirming person', '%deal_dates_confirmed_by_human%');
SELECT pg_temp.expect_error(format($q$UPDATE deal_dates SET status = 'confirmed', confirmed_by_user_id = %L, confirmed_at = now() WHERE id = %L$q$,
  :ownA, 'a0000000-0000-7000-8000-00000000dd01'),
  'nobody confirms a date in someone else''s name', '%DATE_HUMAN_CONFIRMATION%');
UPDATE deal_dates SET status = 'confirmed', confirmed_by_user_id = :agA2, confirmed_at = now(), due_at = now() + interval '10 days',
       reminder_at = now() + interval '9 days' WHERE id = 'a0000000-0000-7000-8000-00000000dd01';
UPDATE deal_dates SET due_on = due_on + 2 WHERE id = 'a0000000-0000-7000-8000-00000000dd01';
SELECT pg_temp.ok((SELECT due_version = 2 AND due_at IS NULL AND reminder_at IS NULL FROM deal_dates WHERE id = 'a0000000-0000-7000-8000-00000000dd01'),
  'R-TXN-5: moving a confirmed date bumps its version and drops the stale stored instants');
UPDATE deal_dates SET due_at = now() + interval '12 days', reminder_at = now() + interval '11 days' WHERE id = 'a0000000-0000-7000-8000-00000000dd01';
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(format($q$INSERT INTO deal_dates (tenant_id, id, deal_id, kind, due_on, source, status, due_at, reminder_at)
  VALUES (%L, gen_random_uuid(), %L, 'closing', current_date + 30, 'manual', 'confirmed', now() + interval '30 days', now() + interval '29 days')$q$,
  :tA, :dA1),
  'S16 R-TXN-1: the system cannot create a confirmed date nobody entered', '%DATE_HUMAN_CONFIRMATION%');
SELECT pg_temp.expect_error(format($q$UPDATE deal_dates SET due_on = due_on + 1 WHERE id = %L$q$, 'a0000000-0000-7000-8000-00000000dd01'),
  'S16: only a person moves a confirmed date', '%DATE_HUMAN_CONFIRMATION%');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO deal_dates (tenant_id, id, deal_id, kind, due_on, reminder_at, due_at)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000dd02', :dA1, 'closing', current_date + 30, now() + interval '28 days', now() + interval '30 days');
UPDATE deal_dates SET completed_at = now() WHERE id = 'a0000000-0000-7000-8000-00000000dd02';
SELECT pg_temp.ok((SELECT reminder_at IS NULL AND status = 'confirmed' FROM deal_dates WHERE id = 'a0000000-0000-7000-8000-00000000dd02'),
  'F4: completion is completed_at alone, and a completed milestone is never reminded');

-- =============================================================================
-- 7. Owner view costs, calendar links (R-OWNER-5, R-CAL-1, S15)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO lead_source_costs (tenant_id, id, lead_source_id, month, amount_cents, origin, entered_by_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000c051', :srcA, date_trunc('month', now())::date, 250000, 'manual', :ownA);
SELECT pg_temp.ok((SELECT count(*) FROM lead_source_costs) = 1, 'the Owner records a source cost');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM lead_source_costs) = 0, 'agents never see source costs');
INSERT INTO user_calendar_links (tenant_id, id, user_id, provider, status) VALUES (:tA, gen_random_uuid(), :agA1, 'google_calendar', 'pending_review');
SELECT pg_temp.ok((SELECT count(*) FROM user_calendar_links) = 1, 'an agent sees their own calendar link');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(format($q$INSERT INTO lead_source_costs (tenant_id, id, lead_source_id, month, amount_cents, origin, entered_by_user_id)
  VALUES (%L, gen_random_uuid(), %L, date_trunc('month', now())::date, 1, 'manual', %L)$q$, :tA, :srcA, :ownA),
  'the system writes only ad-sync costs, never a person''s manual entry', '%row-level security%');
SELECT pg_temp.ok((SELECT count(*) FROM lead_source_costs) = 0, 'S15 R-OWNER-5: the system cannot read a person''s manual cost entries');
SELECT pg_temp.ok(pg_temp.rows_affected(format($q$UPDATE lead_source_costs SET origin = 'ads_sync', entered_by_user_id = NULL, amount_cents = 1
  WHERE id = %L$q$, 'a0000000-0000-7000-8000-00000000c051')) = 0, 'S15: the system cannot rewrite a manual cost row');
INSERT INTO lead_source_costs (tenant_id, id, lead_source_id, month, amount_cents, origin)
VALUES (:tA, gen_random_uuid(), :srcA, date_trunc('month', now())::date, 99000, 'ads_sync');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM lead_source_costs) = 2 AND (SELECT amount_cents FROM lead_source_costs WHERE id = 'a0000000-0000-7000-8000-00000000c051') = 250000,
                  'the Owner reads manual and ad-sync costs; the manual amount is untouched');
SELECT pg_temp.expect_error(format($q$UPDATE lead_source_costs SET origin = 'ads_sync', entered_by_user_id = NULL WHERE id = %L$q$,
  'a0000000-0000-7000-8000-00000000c051'),
  'S15: a cost row keeps its origin', '%COST_ROW_IMMUTABLE%');
SELECT pg_temp.ok((SELECT count(*) FROM user_calendar_links) = 0, 'R-CAL-1: the Owner cannot see an agent''s calendar link');

-- =============================================================================
-- 8. Calls: voice answering is inbound only, disclosed, cleared and the Owner's; call reviews follow the call
-- =============================================================================
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO playbooks (tenant_id, id, kind, scope, name) VALUES (:tA, 'a0000000-0000-7000-8000-00000000b002', 'voice_answering', 'team', 'After hours');
INSERT INTO playbook_versions (tenant_id, id, playbook_id, version_no, steps, content_sha256, created_by_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000b012', 'a0000000-0000-7000-8000-00000000b002', 1, '{"kind": "voice"}', :SHA, :ownA);
SELECT pg_temp.expect_error(format($q$INSERT INTO playbooks (tenant_id, id, kind, scope, owner_user_id, name) VALUES (%L, gen_random_uuid(),
  'voice_answering', 'agent', %L, 'Mine')$q$, :tA, :ownA), 'voice answering is a team playbook', '%playbooks_voice_team_scope%');
SELECT pg_temp.expect_error(format($q$INSERT INTO compliance_policy_versions (tenant_id, id, version_no, voice_answering_enabled, voice_answering_attestation)
  VALUES (%L, gen_random_uuid(), 50, true, 'I turn on after-hours voice answering.')$q$, :tA),
  'R-INT-6 R-VOICE-9: voice cannot be turned on before counsel and the vendor spike cleared platform:voice', '%VOICE_NOT_CLEARED%');
RESET ROLE;
UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now(), rules = rules || '{"vendor_ready_at": "2026-11-01T00:00:00Z"}'
 WHERE key = 'platform:voice';
SET LOCAL ROLE app_user;
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO compliance_policy_versions (tenant_id, id, version_no, voice_answering_enabled)
  VALUES (%L, gen_random_uuid(), 50, true)$q$, :tA),
  'R-VOICE-9: turning voice answering on needs the Owner''s attestation', '%compliance_policy_voice_attested%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000f106', :c1, 'phone', '+15555550101', digest('+15555550101', 'sha256'));
SELECT pg_temp.expect_error(format($q$INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, client_address, initiator,
  handled_by, status, started_at, recording_mode, recording_decision, voice_playbook_version_id) VALUES (%L, gen_random_uuid(), %L, %L,
  'inbound', '+15555550101', 'client', 'assistant', 'ringing', now(), 'announced_all_parties', '{}', %L)$q$,
  :tA, :cvA, :c1, 'a0000000-0000-7000-8000-00000000b012'),
  'R-VOICE-1: a draft voice playbook answers nothing', '%VOICE_PLAYBOOK_NOT_APPROVED%');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO playbook_approvals (tenant_id, id, playbook_version_id, decision, decided_by_user_id, decided_by_role, content_sha256, attestation, decided_at)
VALUES (:tA, gen_random_uuid(), 'a0000000-0000-7000-8000-00000000b012', 'approve', :ownA, 'owner', :SHA, 'I approve the after-hours voice playbook.', now());
UPDATE playbook_versions SET status = 'approved' WHERE id = 'a0000000-0000-7000-8000-00000000b012';
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(format($q$INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, client_address, initiator,
  handled_by, status, started_at, recording_mode, recording_decision, voice_playbook_version_id) VALUES (%L, gen_random_uuid(), %L, %L,
  'inbound', '+15555550101', 'client', 'assistant', 'ringing', now(), 'announced_all_parties', '{}', %L)$q$,
  :tA, :cvA, :c1, 'a0000000-0000-7000-8000-00000000b012'),
  'R-VOICE-9: voice answering ships dark until the Owner turns it on', '%VOICE_ANSWERING_OFF%');
SELECT pg_temp.ctx(:tA, :admA, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO compliance_policy_versions (tenant_id, id, version_no, voice_answering_enabled, voice_answering_attestation)
  VALUES (%L, gen_random_uuid(), 60, true, 'Admin turns it on.')$q$, :tA),
  'R-VOICE-9: an Admin cannot turn voice answering on', '%OWNER_ONLY_VOICE%');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO compliance_policy_versions (tenant_id, id, version_no, voice_answering_enabled, voice_answering_attestation)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000c0a2', 2, true, 'I turn on after-hours voice answering; counsel reviewed the disclosure.');
UPDATE tenant_settings SET active_policy_id = 'a0000000-0000-7000-8000-00000000c0a2';
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(format($q$INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, phone_number_id, client_address,
  initiator, handled_by, status, started_at, recording_mode, recording_decision, voice_playbook_version_id) VALUES (%L, gen_random_uuid(), %L, %L,
  'outbound', %L, '+15555550101', 'human', 'assistant', 'initiated', now(), 'announced_all_parties', '{}', %L)$q$,
  :tA, :cvA, :c1, :num, 'a0000000-0000-7000-8000-00000000b012'),
  'R-VOICE-1: no AI-handled outbound call can exist', '%calls_assistant_inbound_only%');
SELECT pg_temp.expect_error(format($q$INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, client_address, initiator,
  handled_by, status, started_at, answered_at, recording_mode, recording_announced_at, recording_decision, voice_playbook_version_id)
  VALUES (%L, gen_random_uuid(), %L, %L, 'inbound', 'fb:0', 'client', 'assistant', 'in_progress', now(), now(), 'announced_all_parties', now(),
  '{}', %L)$q$, :tA, :cvA, :c1, 'a0000000-0000-7000-8000-00000000b012'),
  'R-VOICE-2: nothing is processed before the assistant disclosed itself', '%calls_assistant_disclosed%');
SELECT pg_temp.expect_error(format($q$INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, client_address, initiator,
  handled_by, status, started_at, answered_at, recording_mode, recording_decision, voice_playbook_version_id, agent_user_id)
  VALUES (%L, gen_random_uuid(), %L, %L, 'inbound', '+15555550101', 'client', 'assistant', 'failed', now(), now(), 'announced_all_parties',
  '{}', %L, %L)$q$, :tA, :cvA, :c1, 'a0000000-0000-7000-8000-00000000b012', :agA2),
  'S14 R-VOICE-2: an answered AI call that ends failed still needed the disclosure and the announcement', '%calls_assistant_disclosed%');
INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, client_address, initiator, handled_by, status, started_at,
       answered_at, recording_mode, recording_announced_at, recording_decision, voice_playbook_version_id, ai_disclosed_at, agent_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ca01', :cvA, :c1, 'inbound', '+15555550101', 'client', 'assistant', 'completed', now(), now(),
        'announced_all_parties', now(), '{}', 'a0000000-0000-7000-8000-00000000b012', now(), :agA1),
       (:tA, 'a0000000-0000-7000-8000-00000000ca09', :cvA, :c1, 'inbound', '+15555550101', 'client', 'assistant', 'ringing', now(), NULL,
        'announced_all_parties', NULL, '{}', 'a0000000-0000-7000-8000-00000000b012', NULL, NULL);
SELECT pg_temp.expect_error(format($q$INSERT INTO voice_tool_calls (tenant_id, id, call_id, seq, tool, args, decision, reason_code, occurred_at)
  VALUES (%L, gen_random_uuid(), %L, 1, 'take_message', '{"topic": "Caller says she can pay $400k cash"}', 'allow', 'OK', now())$q$,
  :tA, 'a0000000-0000-7000-8000-00000000ca01'),
  'S14 R-VOICE-4: tool arguments are ids, codes and slot instants only (no free text in the ledger)', '%voice_tool_calls_args_check%');
SELECT pg_temp.expect_error(format($q$INSERT INTO voice_tool_calls (tenant_id, id, call_id, seq, tool, args, decision, reason_code, occurred_at)
  VALUES (%L, gen_random_uuid(), %L, 1, 'book_appointment', '{"slot_start": "2026-11-12T15:00:00Z", "slot_end": "2026-11-12T15:30:00Z"}',
  'allow', 'OK', now())$q$, :tA, 'a0000000-0000-7000-8000-00000000ca09'),
  'S14 R-VOICE-2: no tool request before the disclosure and the recording announcement', '%VOICE_TOOL_BEFORE_DISCLOSURE%');
INSERT INTO voice_tool_calls (tenant_id, id, call_id, seq, tool, args, decision, reason_code, occurred_at)
VALUES (:tA, gen_random_uuid(), 'a0000000-0000-7000-8000-00000000ca01', 1, 'warm_transfer', jsonb_build_object('target_user_id', :agA1),
        'deny', 'NOT_HOT', now());
SELECT pg_temp.expect_error($q$UPDATE voice_tool_calls SET decision = 'allow'$q$, 'voice tool decisions are append-only', '%permission denied%');
-- the Owner turns voice off; nobody else turns it back on (S8, E150)
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO compliance_policy_versions (tenant_id, id, version_no, voice_answering_enabled)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000c0a3', 3, false);
UPDATE tenant_settings SET active_policy_id = 'a0000000-0000-7000-8000-00000000c0a3';
SELECT pg_temp.ctx(:tA, :admA, 'user');
SELECT pg_temp.expect_error(format($q$UPDATE tenant_settings SET active_policy_id = %L$q$, 'a0000000-0000-7000-8000-00000000c0a2'),
  'S8 R-VOICE-9: an Admin cannot re-activate an older voice-on policy version', '%OWNER_ONLY_VOICE%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(format($q$UPDATE tenant_settings SET active_policy_id = %L$q$, 'a0000000-0000-7000-8000-00000000c0a2'),
  'S8: nor can the system actor', '%OWNER_ONLY_VOICE%');
SELECT pg_temp.expect_error(format($q$INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, client_address, initiator,
  handled_by, status, started_at, recording_mode, recording_decision, voice_playbook_version_id) VALUES (%L, gen_random_uuid(), %L, %L,
  'inbound', '+15555550101', 'client', 'assistant', 'ringing', now(), 'announced_all_parties', '{}', %L)$q$,
  :tA, :cvA, :c1, 'a0000000-0000-7000-8000-00000000b012'),
  'E150: with voice answering turned off, new AI-handled calls are refused', '%VOICE_ANSWERING_OFF%');
-- call reviews: human calls only, the agent on the call, readable with the recording (S14, R-COACH-3)
INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, client_address, initiator, handled_by, status, started_at,
       recording_mode, recording_decision, agent_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ca02', :cvA, :c1, 'inbound', '+15555550101', 'client', 'human', 'completed', now(), 'off', '{}', :agA1),
       (:tA, 'a0000000-0000-7000-8000-00000000ca03', :cvA, :c1, 'inbound', '+15555550101', 'client', 'human', 'completed', now(), 'off', '{}', :agA1);
INSERT INTO recordings (tenant_id, id, call_id, contact_id, agent_user_id, source, consent_basis, retain_until)
VALUES (:tA, gen_random_uuid(), 'a0000000-0000-7000-8000-00000000ca02', :c1, :agA1, 'provider', 'announced_all_parties', now() + interval '730 days'),
       (:tA, 'a0000000-0000-7000-8000-00000000ca13', 'a0000000-0000-7000-8000-00000000ca03', :c1, :agA1, 'provider', 'announced_all_parties', now() + interval '730 days');
SELECT pg_temp.expect_error(format($q$INSERT INTO call_scores (tenant_id, call_id, rubric_version, agent_user_id, contact_id, items, met_count, scored_count)
  VALUES (%L, %L, 'rubric/1', %L, %L, '[]', 0, 0)$q$, :tA, 'a0000000-0000-7000-8000-00000000ca01', :agA1, :c1),
  'S14: an AI-handled call is never a coaching review', '%CALL_REVIEW_SUBJECT%');
SELECT pg_temp.expect_error(format($q$INSERT INTO call_scores (tenant_id, call_id, rubric_version, agent_user_id, contact_id, items, met_count, scored_count)
  VALUES (%L, %L, 'rubric/1', %L, %L, '[]', 0, 0)$q$, :tA, 'a0000000-0000-7000-8000-00000000ca02', :agA2, :c1),
  'S14 R-COACH-3: a review is attributed only to the agent on the call', '%CALL_REVIEW_SUBJECT%');
INSERT INTO call_scores (tenant_id, call_id, rubric_version, agent_user_id, contact_id, items, met_count, scored_count)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ca02', 'rubric/1', :agA1, :c1, '[]', 0, 0),
       (:tA, 'a0000000-0000-7000-8000-00000000ca03', 'rubric/1', :agA1, :c1, '[]', 0, 0);
-- module 36 (0052): a review needs a lawful recording; once that recording is shredded the review is unreadable
RESET ROLE;
UPDATE recordings SET status = 'shredded', shredded_at = now() WHERE id = 'a0000000-0000-7000-8000-00000000ca13';
SET LOCAL ROLE app_user;
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM call_scores) = 1, 'R-COACH-3: the agent on the call sees the review of a call they can play, only');
SELECT pg_temp.ok((SELECT count(*) FROM voice_tool_calls) = 1, 'the contact owner sees the voice session''s tool decisions');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM call_scores) = 0, 'another agent sees no call reviews');
SELECT pg_temp.ctx(:tA, :tlA, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM call_scores) = 0, 'R-COACH-3: the agent''s Team Lead sees no reviews while tl_sees_call_scores is off (default)');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM call_scores) = 1, 'the Owner sees the playable call''s review (recording scope all)');
SELECT pg_temp.expect_error($q$UPDATE tenant_settings SET call_scoring_enabled = true$q$,
  'R-INT-6: call scoring stays off until counsel clears the platform:coaching pack', '%COACHING_NOT_CLEARED%');
UPDATE tenant_settings SET tl_sees_call_scores = true;
SELECT pg_temp.ctx(:tA, :admA, 'user');
SELECT pg_temp.expect_error($q$UPDATE tenant_settings SET tl_sees_call_scores = false$q$,
  'only the Owner changes who sees call reviews', '%OWNER_ONLY_SETTING%');
SELECT pg_temp.ctx(:tA, :tlA, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM call_scores) = 1,
                  'R-COACH-3: with the Owner''s setting on, the agent''s Team Lead sees the review of a call they may play');

-- =============================================================================
-- 9. Prediction: bands from an approved, back-tested model; withdrawal hides scores and cards at once (R-PRED-1/5, S13)
-- =============================================================================
RESET ROLE;
SELECT pg_temp.expect_error($q$INSERT INTO prediction_models (version, status, features, counsel_reviewed_at) VALUES ('predict/0.9', 'approved', '{years_in_home}', now())$q$,
  'F9: a model is approved only with the platform back-test it is shown with', '%check constraint%');
SELECT pg_temp.expect_error($q$INSERT INTO prediction_models (version, status, features) VALUES ('predict/0.8', 'draft', '{years_in_home,zip_code}')$q$,
  'R-PRED-1: a model can name only the allowed property and first-party features', '%prediction_models_features_check%');
INSERT INTO prediction_models (version, status, features, counsel_reviewed_at, backtest_flagged, backtest_transacted, backtest_window_days, backtest_dataset)
VALUES ('predict/1.0', 'approved', '{years_in_home,recent_saves}', now(), 1240, 186, 90, 'Platform back-test on licensed 2025 closings');
SET LOCAL ROLE app_user;
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(format($q$INSERT INTO contact_predictions (tenant_id, contact_id, model_version, band, reasons, inputs_sha256, computed_on)
  VALUES (%L, %L, 'predict/1.0', 'likely_90d', '[]', %L, current_date)$q$, :tA, :c1, :SHA),
  'a likely band always carries its reasons', '%check constraint%');
SELECT pg_temp.expect_error(format($q$INSERT INTO contact_predictions (tenant_id, contact_id, model_version, band, reasons, inputs_sha256, computed_on)
  VALUES (%L, %L, 'predict/1.0', 'likely_90d', '[{"feature": "household_size", "points": 3}]', %L, current_date)$q$, :tA, :c1, :SHA),
  'R-PRED-1: a reason cites only a feature of its own model', '%PREDICTION_REASON_FEATURE%');
INSERT INTO contact_predictions (tenant_id, contact_id, model_version, band, reasons, inputs_sha256, computed_on)
VALUES (:tA, :c1, 'predict/1.0', 'likely_90d', '[{"feature": "years_in_home", "points": 3}]', :SHA, current_date);
INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, reasons, dedupe_key)
VALUES (:tA, gen_random_uuid(), :agA1, 'likely_to_move', 'scored', :c1, 'contact', :c1,
        '[{"code": "LIKELY_90D", "text": "11 years in the home"}]', 'likely:' || :c1);
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM contact_predictions) = 1 AND (SELECT count(*) FROM priority_feed_items WHERE item_type = 'likely_to_move') = 1,
                  'the owner of the contact sees the band, its reasons and its feed card');
SELECT pg_temp.expect_error(format($q$INSERT INTO contact_predictions (tenant_id, contact_id, model_version, band, reasons, inputs_sha256, computed_on)
  VALUES (%L, %L, 'predict/1.0', 'none', '[]', %L, current_date)$q$, :tA, :c3, :SHA),
  'people cannot write predictions', '%row-level security%');
RESET ROLE;
UPDATE prediction_models SET status = 'withdrawn' WHERE version = 'predict/1.0';
SET LOCAL ROLE app_user;
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM contact_predictions) = 0, 'R-PRED-5: withdrawing a model hides its scores at once');
SELECT pg_temp.ok((SELECT count(*) FROM priority_feed_items WHERE item_type = 'likely_to_move') = 0,
                  'S13 R-PRED-5 E144: withdrawing a model hides the feed cards made from it at once too');

-- =============================================================================
-- 10. Ads: Owner cap versions; every planned shift approved, single-use and under the ceiling in force (R-ADS-1/2, S6, S7)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO ad_budget_caps (tenant_id, id, version_no, monthly_cap_cents, daily_ceiling_cents, effective_from,
  approved_by_user_id, attestation) VALUES (%L, gen_random_uuid(), 1, 100000, 5000, now(), %L, 'I approve this cap.')$q$, :tA, :agA1),
  'R-ADS-1: only the Owner sets the ad cap', '%OWNER_ONLY_AD_CAP%');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO ad_budget_caps (tenant_id, id, version_no, monthly_cap_cents, daily_ceiling_cents, effective_from, approved_by_user_id, attestation)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ad01', 1, 300000, 10000, now() - interval '1 day', :ownA, 'I approve a $3,000 monthly cap.'),
       (:tA, 'a0000000-0000-7000-8000-00000000ad02', 2, 150000, 5000, now(), :ownA, 'I lower the cap to $1,500 a month, $50 a day.');
SELECT pg_temp.expect_error($q$UPDATE ad_budget_caps SET monthly_cap_cents = 999999$q$, 'cap versions are append-only', '%permission denied%');
-- the ads account (callback) and an approved creative of 12 Oak St
SELECT pg_temp.ctx(:tA, NULL, 'system');
INSERT INTO integration_connections (tenant_id, id, kind, status, display_name, external_account_id, credential_id, connected_at)
VALUES (:tA, :adsA, 'ads_meta', 'connected', 'Meta Ads', 'act_1', :credAd, now());
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO marketing_pieces (tenant_id, id, listing_id, kind, version_no, prose, template_key, guard_result, created_by_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000f303', :lA, 'social_post', 1, '{"text": "Open house Sunday at 12 Oak St"}', 'social/1',
        '{"brokerage_name_present": true, "hard_count": 0, "pack_rule_failures": []}', :agA1),
       (:tA, 'a0000000-0000-7000-8000-00000000f304', :lA, 'social_post', 2, '{"text": "Perfect for young families"}', 'social/1',
        '{"brokerage_name_present": false, "hard_count": 1, "pack_rule_failures": []}', :agA1);
UPDATE marketing_pieces SET guard_result = guard_result || jsonb_build_object('content_sha256', content_sha256)
 WHERE id = 'a0000000-0000-7000-8000-00000000f303';
UPDATE marketing_pieces SET status = 'approved', approved_by_user_id = :agA1, approved_at = now() WHERE id = 'a0000000-0000-7000-8000-00000000f303';
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO ad_campaigns (tenant_id, id, connection_id, external_campaign_id, name, lead_source_id, campaign_ref,
  listing_id, creative_piece_id, status, daily_budget_cents) VALUES (%L, gen_random_uuid(), %L, 'c-x', 'Oak St', %L, 'oak', %L, %L, 'active', 0)$q$,
  :tA, :adsA, :srcA, :lA, 'a0000000-0000-7000-8000-00000000f304'),
  'S9 R-ADS-4: a campaign never runs an unapproved creative', '%AD_CREATIVE_NOT_APPROVED%');
SELECT pg_temp.expect_error(format($q$INSERT INTO ad_campaigns (tenant_id, id, connection_id, external_campaign_id, name, lead_source_id, campaign_ref,
  listing_id, creative_piece_id, status, daily_budget_cents) VALUES (%L, gen_random_uuid(), %L, 'c-y', 'Oak St', %L, 'oak', %L, %L, 'draft', 5000)$q$,
  :tA, :adsA, :srcA, :lA, 'a0000000-0000-7000-8000-00000000f303'),
  'R-ADS-3: nobody types a budget in; budgets move only through the approved ledger', '%AD_BUDGET_THROUGH_LEDGER%');
INSERT INTO ad_campaigns (tenant_id, id, connection_id, external_campaign_id, name, lead_source_id, campaign_ref, listing_id, creative_piece_id, status, daily_budget_cents)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000cb01', :adsA, 'c-1', 'Oak St A', :srcA, 'oak-a', :lA, 'a0000000-0000-7000-8000-00000000f303', 'draft', 0),
       (:tA, 'a0000000-0000-7000-8000-00000000cb02', :adsA, 'c-2', 'Oak St B', :srcA, 'oak-b', :lA, 'a0000000-0000-7000-8000-00000000f303', 'draft', 0);
-- provider sync: both campaigns are live at $30 and $15 a day (the system mirrors the platform)
SELECT pg_temp.ctx(:tA, NULL, 'system');
UPDATE ad_campaigns SET status = 'active', daily_budget_cents = 3000 WHERE id = 'a0000000-0000-7000-8000-00000000cb01';
UPDATE ad_campaigns SET status = 'active', daily_budget_cents = 1500 WHERE id = 'a0000000-0000-7000-8000-00000000cb02';
INSERT INTO assistant_actions (tenant_id, id, kind, action_category, autonomy, status, owner_user_id, explanation, payload) VALUES
  (:tA, 'a0000000-0000-7000-8000-0000000aa201', 'ad_reallocation', 'money', 'requires_approval', 'proposed', :ownA, 'Move $5/day from B to A',
   '{"changes": [{"campaign_id": "a0000000-0000-7000-8000-00000000cb01", "to_daily_cents": 4000},
                 {"campaign_id": "a0000000-0000-7000-8000-00000000cb02", "to_daily_cents": 1000}]}'),
  (:tA, 'a0000000-0000-7000-8000-0000000aa202', 'ad_reallocation', 'money', 'requires_approval', 'proposed', :agA1, 'Raise A',
   '{"changes": [{"campaign_id": "a0000000-0000-7000-8000-00000000cb01", "to_daily_cents": 3500}]}'),
  (:tA, 'a0000000-0000-7000-8000-0000000aa203', 'ad_reallocation', 'money', 'requires_approval', 'proposed', :admA, 'Raise both',
   '{"changes": [{"campaign_id": "a0000000-0000-7000-8000-00000000cb01", "to_daily_cents": 4500},
                 {"campaign_id": "a0000000-0000-7000-8000-00000000cb02", "to_daily_cents": 1500}]}'),
  (:tA, 'a0000000-0000-7000-8000-0000000aa204', 'ad_reallocation', 'money', 'requires_approval', 'proposed', :ownA, 'Raise B',
   '{"changes": [{"campaign_id": "a0000000-0000-7000-8000-00000000cb02", "to_daily_cents": 2000}]}');
SELECT pg_temp.expect_deferred_error(format($q$INSERT INTO ad_allocation_events (tenant_id, id, run_id, campaign_id, event_kind, cap_version_id,
  assistant_action_id, from_daily_cents, to_daily_cents, reason_code, occurred_at) VALUES (%L, gen_random_uuid(), gen_random_uuid(),
  'a0000000-0000-7000-8000-00000000cb01', 'planned', 'a0000000-0000-7000-8000-00000000ad02', 'a0000000-0000-7000-8000-0000000aa201',
  3000, 4000, 'BETTER_COST_PER_APPT', now())$q$, :tA),
  'R-ADS-2: a budget shift nobody approved is refused', '%AD_SHIFT_NOT_APPROVED%');
SELECT pg_temp.expect_error(format($q$UPDATE assistant_actions SET status = 'approved', decided_by_user_id = %L, decided_at = now() WHERE id = %L$q$,
  :ownA, 'a0000000-0000-7000-8000-0000000aa201'),
  'S6 R-AST-21: the system cannot approve a money action in the Owner''s name', '%DECISION_ACTOR%');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format($q$UPDATE assistant_actions SET status = 'approved', decided_by_user_id = %L, decided_at = now() WHERE id = %L$q$,
  :agA1, 'a0000000-0000-7000-8000-0000000aa202'),
  'S6 R-ADS-2: an agent''s tap never moves the team''s ad money', '%assistant_actions_ad_shift_approver%');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
UPDATE assistant_actions SET status = 'approved', decided_by_user_id = :ownA, decided_at = now()
 WHERE id IN ('a0000000-0000-7000-8000-0000000aa201', 'a0000000-0000-7000-8000-0000000aa204');
SELECT pg_temp.ctx(:tA, :admA, 'user');
UPDATE assistant_actions SET status = 'approved', decided_by_user_id = :admA, decided_at = now() WHERE id = 'a0000000-0000-7000-8000-0000000aa203';
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_deferred_error(format($q$INSERT INTO ad_allocation_events (tenant_id, id, run_id, campaign_id, event_kind, cap_version_id,
  assistant_action_id, from_daily_cents, to_daily_cents, reason_code, occurred_at) VALUES
  (%1$L, gen_random_uuid(), 'a0000000-0000-7000-8000-00000000ad90', 'a0000000-0000-7000-8000-00000000cb01', 'planned', %2$L, %3$L, 3000, 4000, 'SHIFT', now()),
  (%1$L, gen_random_uuid(), 'a0000000-0000-7000-8000-00000000ad90', 'a0000000-0000-7000-8000-00000000cb02', 'planned', %2$L, %3$L, 1500, 1000, 'SHIFT', now())$q$,
  :tA, 'a0000000-0000-7000-8000-00000000ad01', 'a0000000-0000-7000-8000-0000000aa201'),
  'S7 R-ADS-2: a plan cites the cap version in force (the Owner lowered it)', '%AD_CAP_VERSION_STALE%');
SELECT pg_temp.expect_deferred_error(format($q$INSERT INTO ad_allocation_events (tenant_id, id, run_id, campaign_id, event_kind, cap_version_id,
  assistant_action_id, from_daily_cents, to_daily_cents, reason_code, occurred_at) VALUES
  (%L, gen_random_uuid(), gen_random_uuid(), 'a0000000-0000-7000-8000-00000000cb01', 'planned', %L, %L, 3000, 9000, 'SHIFT', now())$q$,
  :tA, 'a0000000-0000-7000-8000-00000000ad02', 'a0000000-0000-7000-8000-0000000aa201'),
  'S7: a plan moves exactly the amounts the Owner approved', '%AD_SHIFT_NOT_IN_APPROVAL%');
SELECT pg_temp.expect_deferred_error(format($q$INSERT INTO ad_allocation_events (tenant_id, id, run_id, campaign_id, event_kind, cap_version_id,
  assistant_action_id, from_daily_cents, to_daily_cents, reason_code, occurred_at) VALUES
  (%L, gen_random_uuid(), gen_random_uuid(), 'a0000000-0000-7000-8000-00000000cb01', 'planned', %L, %L, 3000, 4000, 'SHIFT', now())$q$,
  :tA, 'a0000000-0000-7000-8000-00000000ad02', 'a0000000-0000-7000-8000-0000000aa201'),
  'S7 F14 R-ADS-2: untouched campaigns count, so a partial run cannot overflow the ceiling', '%AD_CAP_EXCEEDED%');
SELECT pg_temp.expect_deferred_error(format($q$INSERT INTO ad_allocation_events (tenant_id, id, run_id, campaign_id, event_kind, cap_version_id,
  assistant_action_id, from_daily_cents, to_daily_cents, reason_code, occurred_at) VALUES
  (%1$L, gen_random_uuid(), 'a0000000-0000-7000-8000-00000000ad91', 'a0000000-0000-7000-8000-00000000cb01', 'planned', %2$L, %3$L, 3000, 4500, 'SHIFT', now()),
  (%1$L, gen_random_uuid(), 'a0000000-0000-7000-8000-00000000ad91', 'a0000000-0000-7000-8000-00000000cb02', 'planned', %2$L, %3$L, 1500, 1500, 'SHIFT', now())$q$,
  :tA, 'a0000000-0000-7000-8000-00000000ad02', 'a0000000-0000-7000-8000-0000000aa203'),
  'R-ADS-2: a planned run above the cap''s daily ceiling is refused', '%AD_CAP_EXCEEDED%');
INSERT INTO ad_allocation_events (tenant_id, id, run_id, campaign_id, event_kind, cap_version_id, assistant_action_id, from_daily_cents,
       to_daily_cents, reason_code, occurred_at)
VALUES (:tA, gen_random_uuid(), 'a0000000-0000-7000-8000-00000000ad98', 'a0000000-0000-7000-8000-00000000cb01', 'planned',
        'a0000000-0000-7000-8000-00000000ad02', 'a0000000-0000-7000-8000-0000000aa201', 3000, 4000, 'SHIFT', now()),
       (:tA, gen_random_uuid(), 'a0000000-0000-7000-8000-00000000ad98', 'a0000000-0000-7000-8000-00000000cb02', 'planned',
        'a0000000-0000-7000-8000-00000000ad02', 'a0000000-0000-7000-8000-0000000aa201', 1500, 1000, 'SHIFT', now());
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.ok(true, 'an approved shift that keeps the tenant''s daily total at the ceiling is planned');
SELECT pg_temp.expect_error(format($q$INSERT INTO ad_allocation_events (tenant_id, id, run_id, campaign_id, event_kind, cap_version_id,
  assistant_action_id, from_daily_cents, to_daily_cents, reason_code, occurred_at) VALUES
  (%L, gen_random_uuid(), gen_random_uuid(), 'a0000000-0000-7000-8000-00000000cb01', 'planned', %L, %L, 3000, 4000, 'SHIFT', now())$q$,
  :tA, 'a0000000-0000-7000-8000-00000000ad02', 'a0000000-0000-7000-8000-0000000aa201'),
  'S7: an approval is single-use (it cannot be replayed in another run)', '%ad_allocation_events_approval_once%');
SELECT pg_temp.expect_deferred_error(format($q$INSERT INTO ad_allocation_events (tenant_id, id, run_id, campaign_id, event_kind, cap_version_id,
  assistant_action_id, from_daily_cents, to_daily_cents, reason_code, occurred_at) VALUES
  (%L, gen_random_uuid(), gen_random_uuid(), 'a0000000-0000-7000-8000-00000000cb02', 'planned', %L, %L, 1000, 2000, 'SHIFT', now())$q$,
  :tA, 'a0000000-0000-7000-8000-00000000ad02', 'a0000000-0000-7000-8000-0000000aa204'),
  'S7: a second run on top of the first is measured against the same tenant-wide ceiling', '%AD_CAP_EXCEEDED%');
SELECT pg_temp.expect_deferred_error(format($q$INSERT INTO ad_allocation_events (tenant_id, id, run_id, campaign_id, event_kind, cap_version_id,
  from_daily_cents, to_daily_cents, reason_code, occurred_at) VALUES
  (%L, gen_random_uuid(), gen_random_uuid(), 'a0000000-0000-7000-8000-00000000cb01', 'applied', %L, 0, 999999, 'APPLIED', now())$q$,
  :tA, 'a0000000-0000-7000-8000-00000000ad02'),
  'S7 R-ADS-3: nothing is applied that was not planned and approved', '%AD_APPLY_WITHOUT_PLAN%');
INSERT INTO ad_allocation_events (tenant_id, id, run_id, campaign_id, event_kind, cap_version_id, from_daily_cents, to_daily_cents, reason_code, provider_ref, occurred_at)
VALUES (:tA, gen_random_uuid(), 'a0000000-0000-7000-8000-00000000ad98', 'a0000000-0000-7000-8000-00000000cb01', 'applied',
        'a0000000-0000-7000-8000-00000000ad02', 3000, 4000, 'APPLIED', 'prov-1', now());
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.ok(true, 'R-ADS-3: the provider result is recorded against its planned, approved change');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM ad_budget_caps) + (SELECT count(*) FROM ad_allocation_events) + (SELECT count(*) FROM ad_campaigns) = 0,
                  'agents see no ad money');

-- =============================================================================
-- 11. Documents: quarantined until the scan, never moved, held and retained; erasure respects both (R-DOC-1..4, S5, S11, S12)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, key_version, dek_wrapped, created_by_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ab01', 'document', 'tenants/' || :tA || '/doc/1', 'application/pdf', 10, digest('x', 'sha256'), 1, '\x01', :ownA);
INSERT INTO documents (tenant_id, id, deal_id, object_id, kind, display_name, uploaded_by_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000d0c1', :dA2, 'a0000000-0000-7000-8000-00000000ab01', 'purchase_contract', 'Contract.pdf', :ownA);
SELECT pg_temp.expect_error(format($q$UPDATE documents SET shared_to_portal = true WHERE id = %L$q$, 'a0000000-0000-7000-8000-00000000d0c1'),
  'an unscanned document cannot be shared to the portal', '%check constraint%');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, key_version, dek_wrapped, created_by_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ab02', 'document', 'tenants/' || :tA || '/doc/2', 'application/pdf', 10, digest('y', 'sha256'), 1, '\x01', :agA2);
INSERT INTO documents (tenant_id, id, deal_id, object_id, kind, display_name, uploaded_by_user_id, scan_status, shared_to_portal)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000d0c2', :dA2, 'a0000000-0000-7000-8000-00000000ab02', 'disclosure', 'evil.pdf', :agA2, 'clean', true);
SELECT pg_temp.ok((SELECT scan_status = 'pending' AND NOT shared_to_portal FROM documents WHERE id = 'a0000000-0000-7000-8000-00000000d0c2'),
                  'S5 R-DOC-3: an upload always starts quarantined and unshared, whatever the writer says');
SELECT pg_temp.expect_error(format($q$UPDATE documents SET scan_status = 'clean' WHERE id = %L$q$, 'a0000000-0000-7000-8000-00000000d0c2'),
  'S5 R-DOC-3: the uploader cannot mark their own upload clean', '%DOCUMENT_SCAN_SYSTEM_ONLY%');
SELECT pg_temp.ok((SELECT count(*) FROM documents WHERE id = 'a0000000-0000-7000-8000-00000000d0c1') = 0,
                  'R-DOC-3: the deal owner cannot open a document before its scan is clean');
SELECT pg_temp.ctx(:tA, NULL, 'system');
UPDATE documents SET scan_status = 'clean' WHERE id = 'a0000000-0000-7000-8000-00000000d0c1';
SELECT pg_temp.expect_error(format($q$UPDATE documents SET scan_status = 'pending' WHERE id = %L$q$, 'a0000000-0000-7000-8000-00000000d0c1'),
  'S5: a scan result is final', '%DOCUMENT_SCAN_SYSTEM_ONLY%');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM documents WHERE id = 'a0000000-0000-7000-8000-00000000d0c1') = 1, 'after a clean scan the deal owner sees it');
SELECT pg_temp.ok((SELECT count(*) FROM stored_objects WHERE id = 'a0000000-0000-7000-8000-00000000ab01') = 1,
                  'a clean document''s file is readable to whoever reads the document (to stream it)');
UPDATE documents SET shared_to_portal = true WHERE id = 'a0000000-0000-7000-8000-00000000d0c1';
SELECT pg_temp.ctx(:tA, :ownA, 'user');
UPDATE documents SET legal_hold = true, retention_until = now() + interval '7 years' WHERE id = 'a0000000-0000-7000-8000-00000000d0c1';
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.expect_error(format($q$UPDATE documents SET legal_hold = false WHERE id = %L$q$, 'a0000000-0000-7000-8000-00000000d0c1'),
  'S5 R-DOC-4: an agent cannot lift the Owner''s legal hold', '%DOCUMENT_HOLD_OWNER_ADMIN%');
SELECT pg_temp.expect_error(format($q$UPDATE documents SET retention_until = now() WHERE id = %L$q$, 'a0000000-0000-7000-8000-00000000d0c1'),
  'S5 R-DOC-4: an agent cannot shorten retention', '%DOCUMENT_RETENTION_OWNER_ADMIN%');
SELECT pg_temp.expect_error(format($q$UPDATE documents SET deal_id = %L WHERE id = %L$q$, :dA1, 'a0000000-0000-7000-8000-00000000d0c2'),
  'S5: a document never moves to another deal', '%DOCUMENT_IMMUTABLE%');
-- a listing agreement is for the listing's writers, not every member (S12)
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, key_version, dek_wrapped, created_by_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ab04', 'document', 'tenants/' || :tA || '/doc/4', 'application/pdf', 10, digest('w', 'sha256'), 1, '\x01', :agA1);
INSERT INTO documents (tenant_id, id, listing_id, object_id, kind, display_name, uploaded_by_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000d0c4', :lA, 'a0000000-0000-7000-8000-00000000ab04', 'listing_agreement',
        'Listing agreement (6% commission).pdf', :agA1);
SELECT pg_temp.ctx(:tA, NULL, 'system');
UPDATE documents SET scan_status = 'clean' WHERE id = 'a0000000-0000-7000-8000-00000000d0c4';
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM documents WHERE id = 'a0000000-0000-7000-8000-00000000d0c4') = 1, 'the listing agent reads their listing agreement');
SELECT pg_temp.ctx(:tA, :tlA, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM documents WHERE id = 'a0000000-0000-7000-8000-00000000d0c4') = 1, 'the Team Lead reads it (a listing writer)');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM documents WHERE id = 'a0000000-0000-7000-8000-00000000d0c4') = 0
                  AND (SELECT count(*) FROM stored_objects WHERE id = 'a0000000-0000-7000-8000-00000000ab04') = 0,
                  'S12 R-PERM-10: another agent reads neither the listing agreement nor its file (commission terms)');
-- erasure refuses while a contact document is held, and otherwise removes every contact-scoped row (S11, R-DATA-7)
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, key_version, dek_wrapped, created_by_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ab05', 'document', 'tenants/' || :tA || '/doc/5', 'application/pdf', 10, digest('v', 'sha256'), 1, '\x01', :agA1),
       (:tA, 'a0000000-0000-7000-8000-00000000ab06', 'document', 'tenants/' || :tA || '/doc/6', 'application/pdf', 10, digest('u', 'sha256'), 1, '\x01', :agA1);
INSERT INTO documents (tenant_id, id, contact_id, object_id, kind, display_name, uploaded_by_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000d0c5', :c5, 'a0000000-0000-7000-8000-00000000ab05', 'other', 'Eve ID.pdf', :agA1),
       (:tA, 'a0000000-0000-7000-8000-00000000d0c6', :c6, 'a0000000-0000-7000-8000-00000000ab06', 'other', 'Finn ID.pdf', :agA1);
INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, line1, city, region, postal_code)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000a6a1', :c6, 'home', '7 Pine St', 'Town', 'SC', '29401');
INSERT INTO portal_accounts (tenant_id, id, contact_id, login_point_id, status, invited_by_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-0000000c6a01', :c6, 'a0000000-0000-7000-8000-00000000f601', 'invited', :agA1);
SELECT pg_temp.ctx(:tA, NULL, 'system');
INSERT INTO property_records (tenant_id, id, contact_id, contact_address_id, owner_name_match, fetched_at, retention_until)
VALUES (:tA, gen_random_uuid(), :c6, 'a0000000-0000-7000-8000-00000000a6a1', true, now(), now() + interval '1 year');
INSERT INTO contact_predictions (tenant_id, contact_id, model_version, band, reasons, inputs_sha256, computed_on)
VALUES (:tA, :c6, 'predict/1.0', 'none', '[]', :SHA, current_date);
INSERT INTO webchat_sessions (tenant_id, id, connection_id, token_hash, origin, started_at, last_seen_at, contact_id, claimed_kind, claimed_address)
VALUES (:tA, gen_random_uuid(), :wcA, digest('chat-session-finn', 'sha256'), 'https://a-realty.test', now(), now(), :c6, 'phone', '+15555550666');
INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, client_address, initiator, handled_by, status, started_at,
       recording_mode, recording_decision, agent_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ca06', :cvA6, :c6, 'inbound', '+15555550666', 'client', 'human', 'completed', now(), 'off', '{}', :agA1);
INSERT INTO recordings (tenant_id, id, call_id, contact_id, agent_user_id, source, consent_basis, retain_until)
VALUES (:tA, gen_random_uuid(), 'a0000000-0000-7000-8000-00000000ca06', :c6, :agA1, 'provider', 'one_party_policy', now() + interval '730 days');
INSERT INTO call_scores (tenant_id, call_id, rubric_version, agent_user_id, contact_id, items, met_count, scored_count)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ca06', 'rubric/1', :agA1, :c6, '[]', 0, 0);
SELECT pg_temp.ctx(:tA, :ownA, 'user');
UPDATE documents SET legal_hold = true WHERE id = 'a0000000-0000-7000-8000-00000000d0c5';
SELECT pg_temp.expect_error(format($q$SELECT app.erase_contact(%L, gen_random_uuid(), 'privacy request')$q$, :c5),
  'S11 R-DOC-4: erasure refuses while a contact document is on legal hold', '%DOCUMENT_RETAINED%');
SELECT app.erase_contact(:c6, gen_random_uuid(), 'privacy request');
SELECT pg_temp.ok((SELECT count(*) FROM documents WHERE contact_id = :c6) + (SELECT count(*) FROM property_records WHERE contact_id = :c6)
                  + (SELECT count(*) FROM contact_predictions WHERE contact_id = :c6) + (SELECT count(*) FROM webchat_sessions WHERE contact_id = :c6)
                  + (SELECT count(*) FROM portal_accounts WHERE contact_id = :c6) + (SELECT count(*) FROM call_scores WHERE contact_id = :c6) = 0,
                  'R-DATA-7: erasure removes every contact-scoped Phase 2-3 row');
SELECT pg_temp.ok((SELECT dek_wrapped IS NULL AND deleted_at IS NOT NULL FROM stored_objects WHERE id = 'a0000000-0000-7000-8000-00000000ab06'),
                  'S11 R-DATA-7: erasure shreds the contact document''s file');

-- =============================================================================
-- 12. Client portal: a separate principal that reaches only its own grants, on deals it is a party to (R-PORTAL-1..6, S1)
-- =============================================================================
-- Seller Carol (c2) is invited to her sale dA2; buyer Alice (c1) to her purchase dA1.
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO portal_accounts (tenant_id, id, contact_id, login_point_id, status, invited_by_user_id, activated_at)
VALUES (:tA, 'a0000000-0000-7000-8000-0000000c1a01', :c1, 'a0000000-0000-7000-8000-00000000f103', 'active', :agA1, now());
SELECT pg_temp.expect_error(format($q$UPDATE portal_accounts SET login_point_id = %L WHERE id = %L$q$,
  'a0000000-0000-7000-8000-00000000f201', 'a0000000-0000-7000-8000-0000000c1a01'),
  'S1 R-PORTAL-5: the magic link goes only to one of the client''s own points (no re-pointing to another contact)', '%PORTAL_LOGIN_POINT%');
SELECT pg_temp.expect_error(format($q$UPDATE portal_accounts SET login_point_id = %L WHERE id = %L$q$,
  'a0000000-0000-7000-8000-00000000f101', 'a0000000-0000-7000-8000-0000000c1a01'),
  'R-PORTAL-5: the login point is an email or a phone', '%PORTAL_LOGIN_POINT%');
INSERT INTO portal_grants (tenant_id, id, portal_account_id, deal_id, granted_by_user_id, granted_at)
VALUES (:tA, 'a0000000-0000-7000-8000-0000000c1b01', 'a0000000-0000-7000-8000-0000000c1a01', :dA1, :agA1, now());
SELECT pg_temp.expect_error(format($q$INSERT INTO portal_grants (tenant_id, id, portal_account_id, deal_id, granted_by_user_id, granted_at)
  VALUES (%L, gen_random_uuid(), %L, %L, %L, now())$q$, :tA, 'a0000000-0000-7000-8000-0000000c1a01', :dA3, :agA1),
  'S1 R-PORTAL-2: a grant names only a deal the client is a party to (not another client''s deal)', '%PORTAL_NOT_A_PARTY%');
SELECT pg_temp.expect_error(format($q$UPDATE portal_grants SET deal_id = %L WHERE id = %L$q$, :dA3, 'a0000000-0000-7000-8000-0000000c1b01'),
  'S1: a grant never moves to another deal', '%PORTAL_GRANT_IMMUTABLE%');
INSERT INTO deal_dates (tenant_id, id, deal_id, kind, due_on) VALUES (:tA, 'a0000000-0000-7000-8000-00000000dd03', :dA1, 'appraisal', current_date + 20);
SELECT pg_temp.ctx(:tA, :agA2, 'user');
INSERT INTO portal_accounts (tenant_id, id, contact_id, login_point_id, status, invited_by_user_id, activated_at)
VALUES (:tA, 'a0000000-0000-7000-8000-0000000c2a01', :c2, 'a0000000-0000-7000-8000-00000000f201', 'active', :agA2, now());
INSERT INTO portal_grants (tenant_id, id, portal_account_id, deal_id, granted_by_user_id, granted_at)
VALUES (:tA, 'a0000000-0000-7000-8000-0000000c2b01', 'a0000000-0000-7000-8000-0000000c2a01', :dA2, :agA2, now()),
       (:tA, 'a0000000-0000-7000-8000-0000000c2b02', 'a0000000-0000-7000-8000-0000000c2a01', :dA2, :agA2, now() - interval '2 days');
UPDATE portal_grants SET expires_at = now() - interval '1 day' WHERE id = 'a0000000-0000-7000-8000-0000000c2b02';
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO portal_grants (tenant_id, id, portal_account_id, deal_id, granted_by_user_id, granted_at)
  VALUES (%L, gen_random_uuid(), %L, %L, %L, now())$q$, :tA, 'a0000000-0000-7000-8000-0000000c2a01', :dA2, :agA1),
  'staff can grant only deals they may write (even to a real party)', '%row-level security%');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.expect_error(format($q$UPDATE portal_grants SET expires_at = NULL WHERE id = %L$q$, 'a0000000-0000-7000-8000-0000000c2b02'),
  'S1: a grant''s expiry is only ever brought forward', '%PORTAL_GRANT_EXPIRY%');
INSERT INTO showings (tenant_id, id, listing_id, starts_at, status, created_by_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-000000005a01', :lC, now() - interval '1 day', 'completed', :agA2);
INSERT INTO showing_feedback (tenant_id, id, showing_id, rating, comments, source, received_at)
VALUES (:tA, 'a0000000-0000-7000-8000-000000005f01', 'a0000000-0000-7000-8000-000000005a01', 4, 'Loved the kitchen', 'manual', now());
INSERT INTO tasks (tenant_id, id, assignee_user_id, deal_id, kind, title, created_by_kind, created_by_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-000000007a01', :agA2, :dA2, 'todo', 'Send the HOA documents', 'user', :agA2);
INSERT INTO portal_items (tenant_id, id, grant_id, kind, title, occurs_on, source_type, source_id, published_by_kind, published_by_user_id, published_at, document_id)
VALUES (:tA, 'a0000000-0000-7000-8000-0000000c2c01', 'a0000000-0000-7000-8000-0000000c2b01', 'milestone', 'Inspection deadline', current_date + 12,
        'deal_date', 'a0000000-0000-7000-8000-00000000dd01', 'user', :agA2, now(), NULL),
       (:tA, 'a0000000-0000-7000-8000-0000000c2c02', 'a0000000-0000-7000-8000-0000000c2b01', 'document', 'Signed contract', NULL,
        'document', 'a0000000-0000-7000-8000-00000000d0c1', 'user', :agA2, now(), 'a0000000-0000-7000-8000-00000000d0c1'),
       (:tA, 'a0000000-0000-7000-8000-0000000c2c03', 'a0000000-0000-7000-8000-0000000c2b01', 'feedback', 'Feedback (retracted)', NULL,
        'showing_feedback', 'a0000000-0000-7000-8000-000000005f01', 'user', :agA2, now(), NULL),
       (:tA, 'a0000000-0000-7000-8000-0000000c2c04', 'a0000000-0000-7000-8000-0000000c2b02', 'next_step', 'On the expired grant', NULL,
        'task', 'a0000000-0000-7000-8000-000000007a01', 'user', :agA2, now(), NULL);
UPDATE portal_items SET retracted_at = now() WHERE id = 'a0000000-0000-7000-8000-0000000c2c03';
SELECT pg_temp.expect_error(format($q$UPDATE portal_items SET retracted_at = NULL WHERE id = %L$q$, 'a0000000-0000-7000-8000-0000000c2c03'),
  'S1 R-PORTAL-3: a retraction is final', '%PORTAL_ITEM_RETRACTED%');
SELECT pg_temp.expect_error(format($q$UPDATE portal_items SET title = 'Edited' WHERE id = %L$q$, 'a0000000-0000-7000-8000-0000000c2c01'),
  'S1: a published item never changes; retract it and publish again', '%PORTAL_ITEM_IMMUTABLE%');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO portal_items (tenant_id, id, grant_id, kind, title, source_type, source_id, published_by_kind,
  published_by_user_id, published_at, document_id) VALUES (%L, gen_random_uuid(), %L, 'document', 'Contract', 'document', %L, 'user', %L, now(), %L)$q$,
  :tA, 'a0000000-0000-7000-8000-0000000c1b01', 'a0000000-0000-7000-8000-00000000d0c1', :agA1, 'a0000000-0000-7000-8000-00000000d0c1'),
  'S1 R-PORTAL-3: an item copies only a source of its grant''s own deal (not another deal''s contract)', '%PORTAL_SOURCE_NOT_IN_GRANT%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(format($q$INSERT INTO portal_items (tenant_id, id, grant_id, kind, title, source_type, source_id, published_by_kind,
  published_at, document_id) VALUES (%L, gen_random_uuid(), %L, 'document', 'Contract', 'document', %L, 'system', now(), %L)$q$,
  :tA, 'a0000000-0000-7000-8000-0000000c1b01', 'a0000000-0000-7000-8000-00000000d0c1', 'a0000000-0000-7000-8000-00000000d0c1'),
  'S1: not even the tenant-wide sync job copies another deal''s document into a grant', '%PORTAL_SOURCE_NOT_IN_GRANT%');
SELECT pg_temp.expect_error(format($q$INSERT INTO portal_items (tenant_id, id, grant_id, kind, title, source_type, source_id, published_by_kind, published_at)
  VALUES (%L, gen_random_uuid(), %L, 'feedback', 'Auto feedback', 'showing_feedback', %L, 'system', now())$q$,
  :tA, 'a0000000-0000-7000-8000-0000000c2b01', 'a0000000-0000-7000-8000-000000005f01'),
  'showing feedback is never rule-published (a person shares it)', '%check constraint%');
INSERT INTO portal_items (tenant_id, id, grant_id, kind, title, source_type, source_id, published_by_kind, published_at)
VALUES (:tA, gen_random_uuid(), 'a0000000-0000-7000-8000-0000000c1b01', 'milestone', 'Appraisal', 'deal_date', 'a0000000-0000-7000-8000-00000000dd03', 'system', now());
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.expect_error(format($q$UPDATE portal_items SET grant_id = %L$q$, 'a0000000-0000-7000-8000-0000000c1b01'),
  'S1: no actor, not even the Owner, moves items between grants (an UPDATE with no WHERE clause)', '%PORTAL_ITEM_IMMUTABLE%');
-- a co-buyer on Alice's deal: Dora, until she is removed (E147)
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO deal_contacts (tenant_id, deal_id, contact_id, role) VALUES (:tA, :dA1, :c3, 'co_buyer');
INSERT INTO portal_accounts (tenant_id, id, contact_id, login_point_id, status, invited_by_user_id, activated_at)
VALUES (:tA, 'a0000000-0000-7000-8000-0000000c3a01', :c3, 'a0000000-0000-7000-8000-00000000f303', 'active', :agA1, now());
INSERT INTO portal_grants (tenant_id, id, portal_account_id, deal_id, granted_by_user_id, granted_at)
VALUES (:tA, 'a0000000-0000-7000-8000-0000000c3b01', 'a0000000-0000-7000-8000-0000000c3a01', :dA1, :agA1, now());
SELECT pg_temp.client(:tA, 'a0000000-0000-7000-8000-0000000c3a01');
SELECT pg_temp.ok((SELECT count(*) FROM portal_grants) = 1, 'a co-buyer sees the deal they are a party to');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
DELETE FROM deal_contacts WHERE deal_id = :dA1 AND contact_id = :c3;
SELECT pg_temp.client(:tA, 'a0000000-0000-7000-8000-0000000c3a01');
SELECT pg_temp.ok((SELECT count(*) FROM portal_grants) = 0, 'S1 E147 R-PORTAL-6: removing a co-buyer from the deal hides their grant at once');

-- Carol's client session
SELECT pg_temp.client(:tA, 'a0000000-0000-7000-8000-0000000c2a01');
SELECT pg_temp.ok((SELECT count(*) FROM portal_accounts) = 1, 'a client sees exactly its own account');
SELECT pg_temp.ok((SELECT count(*) FROM portal_grants) = 1, 'R-PORTAL-2: a client sees only its own active grant (the expired one lapsed at once)');
SELECT pg_temp.ok((SELECT string_agg(title, ',' ORDER BY title) FROM portal_items) = 'Inspection deadline,Signed contract',
                  'a client sees only unretracted items of its own grants; never Alice''s, never the retracted or expired ones');
SELECT pg_temp.expect_error(format($q$INSERT INTO portal_items (tenant_id, id, grant_id, kind, title, source_type, source_id, published_by_kind, published_at)
  VALUES (%L, gen_random_uuid(), %L, 'next_step', 'x', 'task', %L, 'system', now())$q$, :tA, 'a0000000-0000-7000-8000-0000000c2b01',
  'a0000000-0000-7000-8000-000000007a01'),
  'a client can never write portal rows', '%CLIENT_READ_ONLY%');
SELECT pg_temp.ok(pg_temp.rows_affected($q$UPDATE portal_items SET retracted_at = NULL$q$) = 0, 'a client updates nothing');
-- the generated sweep: every other table in the database returns zero rows (or refuses) to a client
DO $$
DECLARE r record; n bigint; bad text := '';
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
            WHERE ns.nspname = 'public' AND c.relkind IN ('r','v')
              AND c.relname NOT IN ('portal_accounts','portal_grants','portal_items',
                                    'jurisdiction_packs','prediction_models')  -- platform reference data, no tenant rows
  LOOP
    BEGIN
      EXECUTE format('SELECT count(*) FROM public.%I', r.relname) INTO n;
      IF n <> 0 THEN bad := bad || ' ' || r.relname || '=' || n; END IF;
    EXCEPTION WHEN insufficient_privilege THEN NULL;   -- no grant at all is also a refusal
    END;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'FAIL  a client principal read staff rows:%', bad; END IF;
  RAISE NOTICE 'PASS  R-PORTAL-1 E129: a client principal reads 0 rows from every table and view outside the portal allowlist';
END $$;
SELECT pg_temp.ok(app.my_role() IS NULL AND NOT app.is_member() AND NOT app.is_tenant_wide(), 'a client is never a staff member');
-- the same session, pointed at tenant B or at another person's account
SELECT pg_temp.client(:tB, 'a0000000-0000-7000-8000-0000000c2a01');
SELECT pg_temp.ok((SELECT count(*) FROM portal_accounts) + (SELECT count(*) FROM portal_grants) + (SELECT count(*) FROM portal_items) = 0,
                  'a client context in another tenant sees nothing (cross-tenant denial)');
SELECT pg_temp.client(:tA, NULL);
SELECT pg_temp.ok((SELECT count(*) FROM portal_accounts) + (SELECT count(*) FROM portal_grants) + (SELECT count(*) FROM portal_items) = 0,
                  'a client context without an account id sees nothing (fail closed)');
SELECT pg_temp.client(:tA, 'a0000000-0000-7000-8000-0000000c1a01');
SELECT pg_temp.ok((SELECT count(*) FROM portal_items) = 1 AND NOT EXISTS (SELECT 1 FROM portal_items WHERE grant_id = 'a0000000-0000-7000-8000-0000000c2b01'),
                  'Alice''s session never reaches Carol''s deal (cross-deal denial)');
-- a staff session cannot borrow the client branch by setting the account GUC
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT set_config('app.portal_account_id', 'a0000000-0000-7000-8000-0000000c2a01', true);
SELECT pg_temp.ok((SELECT count(*) FROM portal_items WHERE grant_id = 'a0000000-0000-7000-8000-0000000c2b01') = 0,
                  'a staff session with a portal account GUC still sees only what staff RLS allows');
-- revoking the grant and disabling the account take effect on the next query; neither is undone
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.expect_error(format($q$UPDATE portal_grants SET revoked_at = now(), revoked_by_user_id = %L WHERE id = %L$q$,
  :ownA, 'a0000000-0000-7000-8000-0000000c2b01'),
  'a person revokes a grant as themselves', '%PORTAL_REVOKER%');
UPDATE portal_grants SET revoked_at = now(), revoked_by_user_id = :agA2 WHERE id = 'a0000000-0000-7000-8000-0000000c2b01';
SELECT pg_temp.client(:tA, 'a0000000-0000-7000-8000-0000000c2a01');
SELECT pg_temp.ok((SELECT count(*) FROM portal_grants) + (SELECT count(*) FROM portal_items) = 0, 'R-PORTAL-6: a revoked grant hides everything at once');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.expect_error(format($q$UPDATE portal_grants SET revoked_at = NULL, revoked_by_user_id = NULL WHERE id = %L$q$,
  'a0000000-0000-7000-8000-0000000c2b01'),
  'S1 R-PORTAL-6: a revoked grant stays revoked', '%PORTAL_GRANT_REVOKED%');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
UPDATE portal_accounts SET status = 'disabled', disabled_at = now(), disabled_reason = 'CONTACT_MERGED' WHERE id = 'a0000000-0000-7000-8000-0000000c1a01';
SELECT pg_temp.client(:tA, 'a0000000-0000-7000-8000-0000000c1a01');
SELECT pg_temp.ok((SELECT count(*) FROM portal_accounts) + (SELECT count(*) FROM portal_grants) + (SELECT count(*) FROM portal_items) = 0,
                  'a disabled account sees nothing, even through a live grant');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format($q$UPDATE portal_accounts SET status = 'active', disabled_at = NULL, disabled_reason = NULL WHERE id = %L$q$,
  'a0000000-0000-7000-8000-0000000c1a01'),
  'a disabled account stays disabled (invite again)', '%PORTAL_ACCOUNT_DISABLED%');

-- =============================================================================
-- 13. Tenant isolation of every new table, from tenant B's Owner and system
-- =============================================================================
SELECT pg_temp.ctx(:tB, :ownB, 'user');
DO $$
DECLARE t text; n bigint; bad text := '';
BEGIN
  FOREACH t IN ARRAY ARRAY['integration_connections','user_calendar_links','webchat_sessions','marketing_pieces','marketing_piece_assets',
     'lead_source_costs','call_scores','voice_tool_calls','property_records','contact_predictions','ad_campaigns','ad_budget_caps',
     'ad_allocation_events','documents','gbp_reviews','portal_accounts','portal_grants','portal_items'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE tenant_id = %L', t, 'a0000000-0000-7000-8000-000000000001') INTO n;
    IF n <> 0 THEN bad := bad || ' ' || t; END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'FAIL  tenant B read tenant A rows:%', bad; END IF;
  RAISE NOTICE 'PASS  R-TEN-1: tenant B''s Owner reads 0 tenant A rows from every Phase 2-3 table';
END $$;
SELECT pg_temp.expect_error(format($q$INSERT INTO portal_grants (tenant_id, id, portal_account_id, deal_id, granted_by_user_id, granted_at)
  VALUES (%L, gen_random_uuid(), %L, %L, %L, now())$q$, :tA, 'a0000000-0000-7000-8000-0000000c2a01', :dA2, :ownB),
  'tenant B cannot grant into tenant A', '%row-level security%');

SELECT pg_temp.ok(true, 'ALL PHASE 2-3 RLS SMOKE CHECKS PASSED');
ROLLBACK;
