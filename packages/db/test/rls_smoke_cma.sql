-- =============================================================================
-- Smoke proof of the D9 S0 schema step (the CMA schema migration; its number is assigned at merge, and nothing here
-- names the file): the stored-CMA table cma_reports (RLS, the cma_reports_guard trigger, the keys and the one-open-draft
-- index), the MLS sale and property columns on listings, the backfill state on integration_connections, and the
-- platform:cma clearance pack. docs/DATA_MODEL.md §6.x "D9 CMA (S0 migration)".
--   R-CMA-1  the listings columns and their database bounds (the coordinates pair, the sale-condition vocabulary,
--            the generated geo_cell; the geoCell() parity runs in rls_smoke_cma.test.ts), and that only the MLS sync
--            (the system actor) writes them and the backfill state;
--   R-CMA-6  a stored CMA is readable only by its creator (an active member), by people who see the contact's detail
--            and by tenant-wide roles (the database part);
--   R-CMA-7  the platform:cma pack exists, published and unreviewed (the pack part only);
--   R-CMA-8  a draft is edited by its creator or a tenant-wide role and keeps its contact; a shared or superseded CMA
--            never changes except links nulled by deletion; a person shares as themselves, linking an outbound email
--            they see; a contact's CMAs are erased with the contact.
-- Same shape as rls_smoke_gmail_review.sql: ONE transaction, rolled back; every application step runs as app_user;
-- platform maintenance steps (deleting an MLS listing or a message, which no application path does yet) run as the
-- owner role between RESET ROLE and SET LOCAL ROLE. Run by packages/db/test/rls_smoke_cma.test.ts.
--
-- Every check was first run against a database without the S0 migration and failed there (the fixture stops at the
-- first cma_reports statement). Steps whose outcome depends on the schema go through pg_temp.try.
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
-- fixture ids by name, so DO blocks (where psql variables do not expand) can use them
CREATE TEMP TABLE fx (name text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;
CREATE FUNCTION pg_temp.id(p_name text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT id FROM pg_temp.fx WHERE name = p_name $$;
-- the only place a check raises (see the header)
CREATE FUNCTION pg_temp.fail(p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FAIL  %', p_msg;
END $$;
CREATE FUNCTION pg_temp.ok(p_cond boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS NOT TRUE THEN PERFORM pg_temp.fail(p_label); RETURN; END IF;
  RAISE NOTICE 'PASS  %', p_label;
END $$;
-- passes when no sub-check failed; a failure lists every failed sub-check
CREATE FUNCTION pg_temp.check(p_failures text[], p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cardinality(p_failures) > 0 THEN PERFORM pg_temp.fail(p_label || ' [failed: ' || array_to_string(p_failures, '; ') || ']'); RETURN; END IF;
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
-- runs one UPDATE/DELETE in a subtransaction: the number of rows it touched, or the error it raised
CREATE FUNCTION pg_temp.rows(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n::text;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
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
-- a stored CMA as module 71 would write it, by the current user as themselves, in the current tenant
CREATE FUNCTION pg_temp.cma_sql(p_id uuid, p_contact uuid, p_address uuid, p_listing uuid,
                                p_creator uuid DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT format($q$INSERT INTO cma_reports (tenant_id, id, contact_id, contact_address_id, listing_id, purpose, method_version,
    valuation_date, mls_data_as_of, subject, result, value_cents, low_cents, high_cents, content_sha256, created_by_user_id)
    VALUES (app.tenant_id(), %L, %L, %L, %L, 'listing_price', 'cma/1', current_date, now() - interval '2 hours',
    '{"type": "single_family", "sqft": 1850, "source": "mls"}', '{"comps": [], "notUsed": []}',
    41500000, 39800000, 43200000, repeat('ab', 32), %L)$q$,
    p_id, p_contact, p_address, p_listing, COALESCE(p_creator, app.user_id()))
$$;
-- draft -> shared by the current user, as themselves, linking the queued share message
CREATE FUNCTION pg_temp.share_sql(p_id uuid, p_message uuid) RETURNS text LANGUAGE sql AS $$
  SELECT format($q$UPDATE cma_reports SET status = 'shared', shared_by_user_id = app.user_id(), shared_at = now(),
    shared_message_id = %L WHERE id = %L$q$, p_message, p_id)
$$;
-- the CMAs of tenant A the fixture stores (by name r*), sorted
CREATE FUNCTION pg_temp.ids(p_names text[]) RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(id ORDER BY id), '{}') FROM pg_temp.fx WHERE name = ANY (p_names)
$$;
-- tenant A CMAs the current context can SELECT, sorted
CREATE FUNCTION pg_temp.seen() RETURNS uuid[] LANGUAGE sql AS $$
  SELECT COALESCE(array_agg(id ORDER BY id), '{}') FROM cma_reports WHERE tenant_id = pg_temp.id('tA')
$$;
-- one CMA row as the owner role sees it (RLS bypassed), for before/after comparisons
CREATE TEMP TABLE snap (name text PRIMARY KEY, j jsonb) ON COMMIT DROP;
GRANT ALL ON pg_temp.snap TO PUBLIC;

\set tA     '''a9000000-0000-7000-8000-000000000001'''
\set tB     '''b9000000-0000-7000-8000-000000000001'''
\set ownA   '''a9000000-0000-7000-8000-0000000000a0'''
\set agA1   '''a9000000-0000-7000-8000-0000000000a1'''
\set agA2   '''a9000000-0000-7000-8000-0000000000a2'''
\set tlA    '''a9000000-0000-7000-8000-0000000000a3'''
\set agA3   '''a9000000-0000-7000-8000-0000000000a4'''
\set admA   '''a9000000-0000-7000-8000-0000000000ad'''
\set ownB   '''b9000000-0000-7000-8000-0000000000b0'''
\set supU   '''09000000-0000-7000-8000-00000000ffff'''
\set polA   '''a9000000-0000-7000-8000-00000000c001'''
\set pondA  '''a9000000-0000-7000-8000-00000000d001'''
\set teamA  '''a9000000-0000-7000-8000-00000000f001'''
\set c1     '''a9000000-0000-7000-8000-00000000e001'''
\set c2     '''a9000000-0000-7000-8000-00000000e002'''
\set c3     '''a9000000-0000-7000-8000-00000000e003'''
\set cE     '''a9000000-0000-7000-8000-00000000e00e'''
\set cB     '''b9000000-0000-7000-8000-00000000e001'''
\set a1     '''a9000000-0000-7000-8000-00000000aa11'''
\set a1b    '''a9000000-0000-7000-8000-00000000aa12'''
\set a2     '''a9000000-0000-7000-8000-00000000aa21'''
\set a3     '''a9000000-0000-7000-8000-00000000aa31'''
\set aE     '''a9000000-0000-7000-8000-00000000aae1'''
\set aB     '''b9000000-0000-7000-8000-00000000aa11'''
\set lA     '''a9000000-0000-7000-8000-0000000011a1'''
\set lDel   '''a9000000-0000-7000-8000-0000000011a2'''
\set lB     '''b9000000-0000-7000-8000-0000000011b1'''
\set cv1    '''a9000000-0000-7000-8000-00000000cc01'''
\set cvE    '''a9000000-0000-7000-8000-00000000cc0e'''
\set cvB    '''b9000000-0000-7000-8000-00000000cc01'''
\set cv2    '''a9000000-0000-7000-8000-00000000cc02'''
\set m2     '''a9000000-0000-7000-8000-000000007120'''
\set m1     '''a9000000-0000-7000-8000-000000007101'''
\set mDel   '''a9000000-0000-7000-8000-000000007102'''
\set mE     '''a9000000-0000-7000-8000-00000000710e'''
\set mB     '''b9000000-0000-7000-8000-000000007101'''
\set rR     '''a9000000-0000-7000-8000-00000000c3a0'''
\set r1     '''a9000000-0000-7000-8000-00000000c3a1'''
\set r2     '''a9000000-0000-7000-8000-00000000c3a2'''
\set r3     '''a9000000-0000-7000-8000-00000000c3a3'''
\set r4     '''a9000000-0000-7000-8000-00000000c3a4'''
\set rS     '''a9000000-0000-7000-8000-00000000c3a5'''
\set rC3    '''a9000000-0000-7000-8000-00000000c3a6'''
\set rE     '''a9000000-0000-7000-8000-00000000c3ae'''
\set rEd    '''a9000000-0000-7000-8000-00000000c3af'''
\set rOwn   '''a9000000-0000-7000-8000-00000000c3b0'''
\set rB     '''b9000000-0000-7000-8000-00000000c3a1'''
\set rA3    '''a9000000-0000-7000-8000-00000000c3b3'''
\set dN     '''a9000000-0000-7000-8000-00000000c3d1'''
\set dX     '''a9000000-0000-7000-8000-00000000c3d2'''
\set eid    '''a9000000-0000-7000-8000-00000000e1d0'''
\set cv3    '''a9000000-0000-7000-8000-00000000cc03'''
\set mS     '''a9000000-0000-7000-8000-000000007131'''
\set mIn    '''a9000000-0000-7000-8000-000000007130'''
\set m3     '''a9000000-0000-7000-8000-000000007103'''
\set aX     '''a9000000-0000-7000-8000-00000000aa99'''
\set mlsA   '''a9000000-0000-7000-8000-00000000ab01'''
\set lM     '''a9000000-0000-7000-8000-0000000011a9'''
\set PH     '''$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA'''
INSERT INTO pg_temp.fx (name, id) VALUES
  ('tA', :tA), ('tB', :tB), ('ownA', :ownA), ('agA1', :agA1), ('agA2', :agA2), ('tlA', :tlA), ('agA3', :agA3), ('admA', :admA),
  ('ownB', :ownB), ('supU', :supU), ('pondA', :pondA), ('c1', :c1), ('c2', :c2), ('c3', :c3), ('cE', :cE), ('cB', :cB),
  ('a1', :a1), ('a1b', :a1b), ('a2', :a2), ('a3', :a3), ('aE', :aE), ('aB', :aB), ('aX', :aX), ('lA', :lA), ('lDel', :lDel), ('lB', :lB),
  ('lM', :lM), ('mlsA', :mlsA),
  ('cv1', :cv1), ('m1', :m1), ('m2', :m2), ('m3', :m3), ('mS', :mS), ('mIn', :mIn), ('mDel', :mDel), ('mE', :mE), ('mB', :mB),
  ('rR', :rR), ('r1', :r1), ('r2', :r2), ('r3', :r3), ('r4', :r4), ('rS', :rS), ('rC3', :rC3), ('rE', :rE), ('rEd', :rEd),
  ('rOwn', :rOwn), ('rB', :rB), ('rA3', :rA3), ('dN', :dN), ('dX', :dX);

-- =============================================================================
-- 0. Fixture. Tenant A: an Owner, an Admin, a Team Lead (team: agent 1) and three agents; a platform support user with
--    an Owner grant; tenant B with its Owner. Agent 1 owns Alice (two addresses), Bob and Erin; agent 2 owns Cara;
--    agent 3 collaborates on Alice. Agent 1 has two team listings; tenant B has its own contact, address, listing and
--    message.
-- =============================================================================
SELECT pg_temp.ctx(NULL, :ownA, 'user');
INSERT INTO users (id, email, display_name, password_hash) VALUES (:ownA, 'owner-a@example.test', 'Olivia Owner', :PH);
SELECT app.provision_tenant(:tA, 'team-a', 'Team A', 'America/New_York', 'A Realty LLC', :ownA, :polA,
       :teamA, :pondA, '\x01', '\x02', '\x03', 'kek-dev');
SELECT pg_temp.ctx(NULL, :ownB, 'user');
INSERT INTO users (id, email, display_name, password_hash) VALUES (:ownB, 'owner-b@example.test', 'Oscar Owner', :PH);
SELECT app.provision_tenant(:tB, 'team-b', 'Team B', 'America/Chicago', 'B Brokers Inc', :ownB,
       'b9000000-0000-7000-8000-00000000c001', 'b9000000-0000-7000-8000-00000000f001',
       'b9000000-0000-7000-8000-00000000d001', '\x01', '\x02', '\x03', 'kek-dev');
SELECT pg_temp.ctx(NULL, :supU, 'user');
INSERT INTO users (id, email, display_name, password_hash) VALUES (:supU, 'support@realty-os.test', 'Sam Support', :PH);
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO invites (tenant_id, id, email, role, token_hash, invited_by_user_id, expires_at) VALUES
  (:tA, 'a9000000-0000-7000-8000-0000000001a1', 'agent1@example.test', 'agent', digest('cma-invite-a1', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a9000000-0000-7000-8000-0000000001a2', 'agent2@example.test', 'agent', digest('cma-invite-a2', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a9000000-0000-7000-8000-0000000001a4', 'agent3@example.test', 'agent', digest('cma-invite-a4', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a9000000-0000-7000-8000-0000000001a3', 'lead@example.test', 'team_lead', digest('cma-invite-a3', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a9000000-0000-7000-8000-0000000001ad', 'admin@example.test', 'admin', digest('cma-invite-ad', 'sha256'), :ownA, now() + interval '1 day');
SELECT pg_temp.ctx(NULL, NULL, NULL);
SELECT FROM auth.accept_invite(digest('cma-invite-a1', 'sha256'), :agA1, 'Ava Agent', :PH, now());
SELECT FROM auth.accept_invite(digest('cma-invite-a2', 'sha256'), :agA2, 'Ben Agent', :PH, now());
SELECT FROM auth.accept_invite(digest('cma-invite-a4', 'sha256'), :agA3, 'Cleo Agent', :PH, now());
SELECT FROM auth.accept_invite(digest('cma-invite-a3', 'sha256'), :tlA, 'Tess Lead', :PH, now());
SELECT FROM auth.accept_invite(digest('cma-invite-ad', 'sha256'), :admA, 'Adam Admin', :PH, now());
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO team_members (tenant_id, team_id, user_id, is_lead) VALUES (:tA, :teamA, :tlA, true), (:tA, :teamA, :agA1, false);
INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, expires_at)
VALUES (:tA, gen_random_uuid(), :supU, :ownA, 'Ticket 7310: CMA question', now() + interval '2 hours');

SELECT pg_temp.self_create(:tA, :c1, :agA1, 'Alice Seller', 'a9000000-0000-7000-8000-0000000c0001');
SELECT pg_temp.self_create(:tA, :c2, :agA1, 'Bob Seller', 'a9000000-0000-7000-8000-0000000c0002');
SELECT pg_temp.self_create(:tA, :cE, :agA1, 'Erin Seller', 'a9000000-0000-7000-8000-0000000c000e');
SELECT pg_temp.self_create(:tA, :c3, :agA2, 'Cara Seller', 'a9000000-0000-7000-8000-0000000c0003');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, line1, city, region, postal_code) VALUES
  (:tA, :a1, :c1, 'property', '12 Harbor Way', 'Seaside', 'SC', '29900'),
  (:tA, :a1b, :c1, 'home', '40 Inland Rd', 'Seaside', 'SC', '29901'),
  (:tA, :a2, :c2, 'property', '7 Marsh Ln', 'Seaside', 'SC', '29900'),
  (:tA, :aE, :cE, 'property', '3 Dune Ct', 'Seaside', 'SC', '29902');
INSERT INTO contact_collaborators (tenant_id, contact_id, user_id, role, added_by_user_id) VALUES (:tA, :c1, :agA3, 'co_agent', :agA1);
INSERT INTO listings (tenant_id, id, source, status, address_line1, city, region, postal_code, listing_agent_user_id) VALUES
  (:tA, :lA, 'team', 'active', '12 Harbor Way', 'Seaside', 'SC', '29900', :agA1),
  (:tA, :lDel, 'team', 'active', '9 Gull St', 'Seaside', 'SC', '29900', :agA1);
SELECT pg_temp.ctx(:tA, :agA2, 'user');
INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, line1, city, region, postal_code)
VALUES (:tA, :a3, :c3, 'property', '55 Pine Ave', 'Seaside', 'SC', '29903');
SELECT pg_temp.self_create(:tB, :cB, :ownB, 'Bea Seller', 'b9000000-0000-7000-8000-0000000c0001');
INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, line1, city, region, postal_code)
VALUES (:tB, :aB, :cB, 'property', '1 Prairie Rd', 'Plainfield', 'IL', '60500');
INSERT INTO listings (tenant_id, id, source, status, address_line1, city, region, postal_code, listing_agent_user_id)
VALUES (:tB, :lB, 'team', 'active', '1 Prairie Rd', 'Plainfield', 'IL', '60500', :ownB);
-- the conversations (platform inbound, written by the system) and one inbound email from Alice
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO email_identities (tenant_id, id, from_address, display_name) VALUES (:tA, :eid, 'team@a-realty.test', 'Team A');
SELECT pg_temp.ctx(:tA, NULL, 'system');
INSERT INTO conversations (tenant_id, id, contact_id) VALUES (:tA, :cv1, :c1), (:tA, :cvE, :cE), (:tA, :cv2, :c2), (:tA, :cv3, :c3);
INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body, status,
       initiator, occurred_at)
VALUES (:tA, :mIn, :cv1, :c1, 'email', 'inbound', 'alice@example.test', 'r+a@in.example.test', 'What is my home worth?', 'received', 'client', now());
-- the share emails: queued outbound informational emails, one per share (agent 1 for Alice, Erin and Bob; agent 2 for Cara)
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, email_identity_id, from_address, to_address,
       subject, body, status, initiator, initiated_by_user_id, purpose, occurred_at) VALUES
  (:tA, :m1, :cv1, :c1, 'email', 'outbound', :eid, 'team@a-realty.test', 'alice@example.test', 'Your home', 'The range and its comps', 'queued', 'human', :agA1, 'informational', now()),
  (:tA, :mDel, :cv1, :c1, 'email', 'outbound', :eid, 'team@a-realty.test', 'alice@example.test', 'Your home', 'The updated range', 'queued', 'human', :agA1, 'informational', now()),
  (:tA, :mS, :cv1, :c1, 'email', 'outbound', :eid, 'team@a-realty.test', 'alice@example.test', 'Your home', 'The range again', 'queued', 'human', :agA1, 'informational', now()),
  (:tA, :mE, :cvE, :cE, 'email', 'outbound', :eid, 'team@a-realty.test', 'erin@example.test', 'Your home', 'The range and its comps', 'queued', 'human', :agA1, 'informational', now()),
  (:tA, :m2, :cv2, :c2, 'email', 'outbound', :eid, 'team@a-realty.test', 'bob@example.test', 'Your home', 'The range and its comps', 'queued', 'human', :agA1, 'informational', now());
SELECT pg_temp.ctx(:tA, :agA2, 'user');
INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, email_identity_id, from_address, to_address,
       subject, body, status, initiator, initiated_by_user_id, purpose, occurred_at)
VALUES (:tA, :m3, :cv3, :c3, 'email', 'outbound', :eid, 'team@a-realty.test', 'cara@example.test', 'Your home', 'The range and its comps', 'queued', 'human', :agA2, 'informational', now());
-- an MLS feed and one MLS listing, written by the system (the MLS sync)
SELECT pg_temp.ctx(:tA, NULL, 'system');
INSERT INTO integration_connections (tenant_id, id, kind, display_name) VALUES (:tA, :mlsA, 'mls_feed', 'MLS feed');
INSERT INTO listings (tenant_id, id, source, mls_number, status, address_line1, city, region, postal_code, mls_connection_id,
       mls_modified_at, listing_brokerage_name)
VALUES (:tA, :lM, 'mls', 'C-200', 'active', '14 Harbor Way', 'Seaside', 'SC', '29900', :mlsA, now(), 'Other Brokerage');
SELECT pg_temp.ctx(:tB, NULL, 'system');
INSERT INTO conversations (tenant_id, id, contact_id) VALUES (:tB, :cvB, :cB);
INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body, status,
       initiator, occurred_at)
VALUES (:tB, :mB, :cvB, :cB, 'email', 'inbound', 'bea@example.test', 'r+b@in.example.test', 'Hello', 'received', 'client', now());

-- =============================================================================
-- 1. Structure: cma_reports is a staff-only tenant table under FORCE RLS, with the support trigger, its policies and
--    an invoker guard; app_user may SELECT, INSERT and UPDATE but never DELETE; S0 adds no SECURITY DEFINER.
-- =============================================================================
RESET ROLE;
DO $$
DECLARE f text[] := '{}'; rel oid := to_regclass('public.cma_reports');
BEGIN
  IF rel IS NULL THEN PERFORM pg_temp.fail('R-CMA-8: the table cma_reports exists'); END IF;
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = rel) THEN f := f || 'RLS not enabled and forced'::text; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = rel AND p.polname = 'tenant_isolation' AND NOT p.polpermissive
                    AND pg_get_expr(p.polqual, p.polrelid) LIKE '%principal_type()%''staff''%') THEN
    f := f || 'no RESTRICTIVE staff-only tenant_isolation policy'::text;
  END IF;
  IF (SELECT count(*) FROM pg_policy p WHERE p.polrelid = rel AND NOT p.polpermissive
         AND p.polname IN ('support_read_only_ins','support_read_only_upd','support_read_only_del')) <> 3 THEN
    f := f || 'the three RESTRICTIVE support_read_only policies are missing'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = rel AND t.tgname = 'support_read_only'
                    AND t.tgfoid = 'app.reject_support_write()'::regprocedure) THEN
    f := f || 'no support_read_only statement trigger (0016)'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = rel AND p.polpermissive AND p.polcmd IN ('d','*')) THEN
    f := f || 'a permissive policy admits DELETE'::text;
  END IF;
  IF NOT has_table_privilege('app_user', 'public.cma_reports', 'SELECT') OR NOT has_table_privilege('app_user', 'public.cma_reports', 'INSERT')
     OR NOT has_table_privilege('app_user', 'public.cma_reports', 'UPDATE') THEN
    f := f || 'app_user lacks SELECT, INSERT or UPDATE'::text;
  END IF;
  IF has_table_privilege('app_user', 'public.cma_reports', 'DELETE') OR has_table_privilege('app_user', 'public.cma_reports', 'TRUNCATE') THEN
    f := f || 'app_user may DELETE or TRUNCATE'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                  WHERE t.tgrelid = rel AND t.tgname = 'cma_reports_guard' AND NOT p.prosecdef AND p.proconfig IS NULL) THEN
    f := f || 'cma_reports_guard is missing or is a definer / has a SET clause'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname IN ('app','auth','portal','public') AND p.prosecdef AND p.prosrc ~* 'cma_reports|platform:cma') THEN
    f := f || 'a SECURITY DEFINER function names cma_reports or platform:cma'::text;
  END IF;
  -- every foreign key of cma_reports is composite, tenant first
  IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = rel AND c.contype = 'f'
              AND (cardinality(c.conkey) < 2 OR c.conkey[1] <> (SELECT attnum FROM pg_attribute WHERE attrelid = rel AND attname = 'tenant_id'))) THEN
    f := f || 'a foreign key is not (tenant_id, ...)'::text;
  END IF;
  IF (SELECT count(*) FROM pg_constraint c WHERE c.conrelid = rel AND c.contype = 'f') <> 6 THEN
    f := f || ('expected 6 foreign keys, found ' || (SELECT count(*) FROM pg_constraint c WHERE c.conrelid = rel AND c.contype = 'f'));
  END IF;
  -- the address foreign key carries the contact, so the address stays one of the CMA's contact's from either side
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = rel AND c.contype = 'f' AND c.confrelid = 'public.contact_addresses'::regclass
                    AND c.confdeltype = 'n'
                    AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = rel AND a.attnum = k.n ORDER BY k.o)
                        = ARRAY['tenant_id','contact_id','contact_address_id']
                    AND ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.o)
                        = ARRAY['tenant_id','contact_id','id']) THEN
    f := f || 'the address foreign key is not (tenant_id, contact_id, contact_address_id) -> contact_addresses (tenant_id, contact_id, id) ON DELETE SET NULL'::text;
  END IF;
  -- each SET NULL link has an index for its foreign-key action (no scan of the tenant's CMAs per deleted row); one CMA per share email
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid WHERE i.indrelid = rel AND x.relname = 'cma_reports_share_message'
                    AND i.indisunique AND pg_get_indexdef(i.indexrelid) LIKE '%(tenant_id, shared_message_id) WHERE (shared_message_id IS NOT NULL)') THEN
    f := f || 'no UNIQUE cma_reports_share_message (tenant_id, shared_message_id) WHERE shared_message_id IS NOT NULL'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid WHERE i.indrelid = rel AND x.relname = 'cma_reports_address_idx'
                    AND pg_get_indexdef(i.indexrelid) LIKE '%(tenant_id, contact_address_id) WHERE (contact_address_id IS NOT NULL)') THEN
    f := f || 'no cma_reports_address_idx (tenant_id, contact_address_id) WHERE contact_address_id IS NOT NULL'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid WHERE i.indrelid = rel AND x.relname = 'cma_reports_listing_idx'
                    AND pg_get_indexdef(i.indexrelid) LIKE '%(tenant_id, listing_id) WHERE (listing_id IS NOT NULL)') THEN
    f := f || 'no cma_reports_listing_idx (tenant_id, listing_id) WHERE listing_id IS NOT NULL'::text;
  END IF;
  -- the S0 columns of listings and integration_connections are system-written through invoker guards
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                  WHERE t.tgrelid = 'public.listings'::regclass AND t.tgname = 'listings_valuation_facts_guard' AND NOT p.prosecdef AND p.proconfig IS NULL) THEN
    f := f || 'listings_valuation_facts_guard is missing or is a definer / has a SET clause'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                  WHERE t.tgrelid = 'public.integration_connections'::regclass AND t.tgname = 'integration_connections_backfill_guard'
                    AND NOT p.prosecdef AND p.proconfig IS NULL) THEN
    f := f || 'integration_connections_backfill_guard is missing or is a definer / has a SET clause'::text;
  END IF;
  PERFORM pg_temp.check(f,
    'R-CMA-8 R-TEN-1 R-PERM-11: cma_reports forces RLS with the staff-only tenant policy, the support_read_only policies and '
    || 'statement trigger, an invoker guard (no definer names the table), six composite tenant-first foreign keys (the address '
    || 'one through the contact), an index per SET NULL link (one CMA per share email), and SELECT/INSERT/UPDATE for app_user '
    || 'with no DELETE; the listings and backfill columns have invoker guards');
END $$;
SET LOCAL ROLE app_user;

-- =============================================================================
-- 2. Storing CMAs (the insert policy and the guard's insert rules)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA1, 'user');
DO $$
DECLARE f text[] := '{}'; r text;
BEGIN
  -- agent 1: a research CMA (no contact), drafts for Alice (two addresses, and none), Bob and Erin
  r := pg_temp.try(pg_temp.cma_sql(pg_temp.id('rR'), NULL, NULL, pg_temp.id('lA')));             IF r <> 'OK' THEN f := f || ('research: ' || r); END IF;
  r := pg_temp.try(pg_temp.cma_sql(pg_temp.id('r1'), pg_temp.id('c1'), pg_temp.id('a1'), pg_temp.id('lDel'))); IF r <> 'OK' THEN f := f || ('r1: ' || r); END IF;
  r := pg_temp.try(pg_temp.cma_sql(pg_temp.id('r3'), pg_temp.id('c1'), NULL, NULL));               IF r <> 'OK' THEN f := f || ('r3: ' || r); END IF;
  r := pg_temp.try(pg_temp.cma_sql(pg_temp.id('r4'), pg_temp.id('c1'), pg_temp.id('a1b'), NULL));  IF r <> 'OK' THEN f := f || ('r4: ' || r); END IF;
  r := pg_temp.try(pg_temp.cma_sql(pg_temp.id('r2'), pg_temp.id('c2'), pg_temp.id('a2'), NULL));   IF r <> 'OK' THEN f := f || ('r2: ' || r); END IF;
  r := pg_temp.try(pg_temp.cma_sql(pg_temp.id('rE'), pg_temp.id('cE'), pg_temp.id('aE'), NULL));   IF r <> 'OK' THEN f := f || ('rE: ' || r); END IF;
  r := pg_temp.try(pg_temp.cma_sql(pg_temp.id('rEd'), pg_temp.id('cE'), NULL, NULL));              IF r <> 'OK' THEN f := f || ('rEd: ' || r); END IF;
  IF (SELECT count(*) FROM cma_reports WHERE status = 'draft' AND created_by_user_id = pg_temp.id('agA1')) <> 7 THEN
    f := f || 'agent 1 does not read back the seven drafts'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM cma_reports WHERE inspection <> 'none' OR status <> 'draft' OR created_at IS NULL OR updated_at IS NULL) THEN
    f := f || 'defaults: status draft, inspection none, timestamps set'::text;
  END IF;
  PERFORM pg_temp.check(f, 'R-CMA-8: a user stores CMAs as themselves, with or without a contact, born as drafts');
END $$;
-- the Owner's research CMA, and agent 2's draft on their own Cara
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.ok(pg_temp.try(pg_temp.cma_sql(:rOwn, NULL, NULL, NULL)) = 'OK', 'R-CMA-8: the Owner stores a research CMA');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok(pg_temp.try(pg_temp.cma_sql(:rC3, :c3, :a3, NULL)) = 'OK', 'R-CMA-8: agent 2 stores a draft for their own contact');
-- tenant B's own CMA
SELECT pg_temp.ctx(:tB, :ownB, 'user');
SELECT pg_temp.ok(pg_temp.try(pg_temp.cma_sql(:rB, :cB, :aB, :lB)) = 'OK', 'R-CMA-8: tenant B''s Owner stores a CMA in tenant B');

DO $$
DECLARE f text[] := '{}'; r text;
BEGIN
  -- the system actor never stores a CMA (a CMA is a person's work)
  PERFORM pg_temp.ctx(pg_temp.id('tA'), NULL, 'system');
  r := pg_temp.try(pg_temp.cma_sql(gen_random_uuid(), NULL, NULL, NULL, pg_temp.id('agA1')));
  IF r !~ 'row-level security' THEN f := f || ('system insert: ' || r); END IF;
  -- nobody stores a CMA in another person's name
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA2'), 'user');
  r := pg_temp.try(pg_temp.cma_sql(gen_random_uuid(), NULL, NULL, NULL, pg_temp.id('agA1')));
  IF r !~ 'row-level security' THEN f := f || ('agent 2 as agent 1: ' || r); END IF;
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('ownA'), 'user');
  r := pg_temp.try(pg_temp.cma_sql(gen_random_uuid(), NULL, NULL, NULL, pg_temp.id('agA1')));
  IF r !~ 'row-level security' THEN f := f || ('the Owner as agent 1: ' || r); END IF;
  -- agent 2 sees neither Alice nor her detail: no CMA for her
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA2'), 'user');
  r := pg_temp.try(pg_temp.cma_sql(gen_random_uuid(), pg_temp.id('c1'), NULL, NULL));
  IF r !~ 'row-level security' THEN f := f || ('agent 2 on Alice: ' || r); END IF;
  -- a CMA is born a draft: never stored as shared or superseded, never with share fields
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
  r := pg_temp.try(format($q$INSERT INTO cma_reports (tenant_id, id, status, shared_by_user_id, shared_at, purpose, method_version, valuation_date,
         subject, result, content_sha256, created_by_user_id) VALUES (app.tenant_id(), gen_random_uuid(), 'shared', app.user_id(), now(),
         'other', 'cma/1', current_date, '{}', '{}', repeat('ab', 32), app.user_id())$q$));
  IF r !~ 'CMA_BORN_DRAFT' THEN f := f || ('born shared: ' || r); END IF;
  r := pg_temp.try(format($q$INSERT INTO cma_reports (tenant_id, id, status, purpose, method_version, valuation_date,
         subject, result, content_sha256, created_by_user_id) VALUES (app.tenant_id(), gen_random_uuid(), 'superseded',
         'other', 'cma/1', current_date, '{}', '{}', repeat('ab', 32), app.user_id())$q$));
  IF r !~ 'CMA_BORN_DRAFT' THEN f := f || ('born superseded: ' || r); END IF;
  r := pg_temp.try(format($q$INSERT INTO cma_reports (tenant_id, id, shared_message_id, purpose, method_version, valuation_date,
         subject, result, content_sha256, created_by_user_id) VALUES (app.tenant_id(), gen_random_uuid(), %L,
         'other', 'cma/1', current_date, '{}', '{}', repeat('ab', 32), app.user_id())$q$, pg_temp.id('m1')));
  IF r !~ 'CMA_BORN_DRAFT' THEN f := f || ('draft with a share message: ' || r); END IF;
  PERFORM pg_temp.check(f,
    'R-CMA-8 R-CMA-6: the system actor, a person in someone else''s name, and a person who does not see the contact''s detail '
    || 'store no CMA; a CMA is born a draft without share fields (CMA_BORN_DRAFT)');
END $$;

-- the table's CHECKs
DO $$
DECLARE f text[] := '{}'; r text; base text;
BEGIN
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
  base := $q$INSERT INTO cma_reports (tenant_id, id, contact_id, contact_address_id, purpose, inspection, inspected_on, method_version,
          valuation_date, subject, result, value_cents, low_cents, high_cents, agent_notes, intended_users, content_sha256,
          created_by_user_id) VALUES (app.tenant_id(), gen_random_uuid(), %s, %s, %s, %s, %s, 'cma/1', current_date, %s, %s,
          %s, %s, %s, %s, %s, %s, app.user_id())$q$;
  -- each line: contact, address, purpose, inspection, inspected_on, subject, result, value, low, high, notes, intended users, sha
  r := pg_temp.try(format(base, 'NULL', quote_literal(pg_temp.id('a1')), '''other''', '''none''', 'NULL', '''{}''', '''{}''', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'repeat(''ab'', 32)'));
  IF r !~ 'cma_reports_address_needs_contact' THEN f := f || ('an address without a contact: ' || r); END IF;
  r := pg_temp.try(format(base, 'NULL', 'NULL', '''appraisal''', '''none''', 'NULL', '''{}''', '''{}''', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'repeat(''ab'', 32)'));
  IF r !~ 'check constraint' THEN f := f || ('purpose appraisal: ' || r); END IF;
  r := pg_temp.try(format(base, 'NULL', 'NULL', '''other''', '''none''', 'current_date', '''{}''', '''{}''', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'repeat(''ab'', 32)'));
  IF r !~ 'check constraint' THEN f := f || ('inspected_on without an inspection: ' || r); END IF;
  r := pg_temp.try(format(base, 'NULL', 'NULL', '''other''', '''exterior''', 'current_date', '''{}''', '''{}''', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'repeat(''ab'', 32)'));
  IF r <> 'OK' THEN f := f || ('an exterior inspection with its date: ' || r); END IF;
  r := pg_temp.try(format(base, 'NULL', 'NULL', '''other''', '''drive_by''', 'NULL', '''{}''', '''{}''', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'repeat(''ab'', 32)'));
  IF r !~ 'check constraint' THEN f := f || ('inspection drive_by: ' || r); END IF;
  r := pg_temp.try(format(base, 'NULL', 'NULL', '''other''', '''none''', 'NULL', '''[]''', '''{}''', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'repeat(''ab'', 32)'));
  IF r !~ 'check constraint' THEN f := f || ('a subject array: ' || r); END IF;
  r := pg_temp.try(format(base, 'NULL', 'NULL', '''other''', '''none''', 'NULL', '''{}''', '''"x"''', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'repeat(''ab'', 32)'));
  IF r !~ 'check constraint' THEN f := f || ('a result string: ' || r); END IF;
  r := pg_temp.try(format(base, 'NULL', 'NULL', '''other''', '''none''', 'NULL', '''{}''', '''{}''', '100', 'NULL', '200', 'NULL', 'NULL', 'repeat(''ab'', 32)'));
  IF r !~ 'check constraint' THEN f := f || ('a value without its low: ' || r); END IF;
  r := pg_temp.try(format(base, 'NULL', 'NULL', '''other''', '''none''', 'NULL', '''{}''', '''{}''', '300', '100', '200', 'NULL', 'NULL', 'repeat(''ab'', 32)'));
  IF r !~ 'check constraint' THEN f := f || ('a value above its high: ' || r); END IF;
  r := pg_temp.try(format(base, 'NULL', 'NULL', '''other''', '''none''', 'NULL', '''{}''', '''{}''', '-1', '-1', '-1', 'NULL', 'NULL', 'repeat(''ab'', 32)'));
  IF r !~ 'check constraint' THEN f := f || ('a negative value: ' || r); END IF;
  r := pg_temp.try(format(base, 'NULL', 'NULL', '''other''', '''none''', 'NULL', '''{}''', '''{}''', '100', '100', '100', 'NULL', 'NULL', 'repeat(''ab'', 32)'));
  IF r <> 'OK' THEN f := f || ('low = value = high: ' || r); END IF;
  r := pg_temp.try(format(base, 'NULL', 'NULL', '''other''', '''none''', 'NULL', '''{}''', '''{}''', 'NULL', 'NULL', 'NULL', 'repeat(''n'', 4001)', 'NULL', 'repeat(''ab'', 32)'));
  IF r !~ 'check constraint' THEN f := f || ('notes of 4001 characters: ' || r); END IF;
  r := pg_temp.try(format(base, 'NULL', 'NULL', '''other''', '''none''', 'NULL', '''{}''', '''{}''', 'NULL', 'NULL', 'NULL', 'repeat(''n'', 4000)', 'repeat(''u'', 2000)', 'repeat(''ab'', 32)'));
  IF r <> 'OK' THEN f := f || ('notes of 4000 and intended users of 2000 characters: ' || r); END IF;
  r := pg_temp.try(format(base, 'NULL', 'NULL', '''other''', '''none''', 'NULL', '''{}''', '''{}''', 'NULL', 'NULL', 'NULL', 'NULL', 'repeat(''u'', 2001)', 'repeat(''ab'', 32)'));
  IF r !~ 'check constraint' THEN f := f || ('intended users of 2001 characters: ' || r); END IF;
  r := pg_temp.try(format(base, 'NULL', 'NULL', '''other''', '''none''', 'NULL', '''{}''', '''{}''', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'repeat(''AB'', 32)'));
  IF r !~ 'check constraint' THEN f := f || ('an upper-case digest: ' || r); END IF;
  r := pg_temp.try(format(base, 'NULL', 'NULL', '''other''', '''none''', 'NULL', '''{}''', '''{}''', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'repeat(''ab'', 31)'));
  IF r !~ 'check constraint' THEN f := f || ('a 62-digit digest: ' || r); END IF;
  -- the five SoP 11-1 columns each hold up to 2000 characters
  FOR r IN SELECT x FROM unnest(ARRAY['agent_interest','conflicts','value_definition','limiting_conditions']) x LOOP
    base := pg_temp.try(format($q$INSERT INTO cma_reports (tenant_id, id, purpose, method_version, valuation_date, subject, result,
             content_sha256, created_by_user_id, %I) VALUES (app.tenant_id(), gen_random_uuid(), 'other', 'cma/1', current_date, '{}', '{}',
             repeat('ab', 32), app.user_id(), repeat('s', 2001))$q$, r));
    IF base !~ 'check constraint' THEN f := f || (r || ' of 2001 characters: ' || base); END IF;
  END LOOP;
  PERFORM pg_temp.check(f,
    'R-CMA-8: the CHECKs hold: an address needs a contact; purpose, inspection and its date; object subject and result; '
    || 'value, low and high all set or all null with 0 <= low <= value <= high; notes <= 4000 and each SoP 11-1 item <= 2000 '
    || 'characters; a 64-hex content digest');
END $$;

-- =============================================================================
-- 3. Visibility (R-CMA-6, the database part)
-- =============================================================================
-- agent 1 shares Bob's CMA r2 (address a2, message m2), then releases Bob to the team pond: agent 2 (a pond member) then
-- sees Bob's pond card, never his detail, and agent 1 no longer sees Bob's detail (nor his address or message rows)
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(pg_temp.rows(pg_temp.share_sql(:r2, :m2)) = '1', 'R-CMA-8: agent 1 shares Bob''s CMA r2');
SELECT pg_temp.cmd('a9000000-0000-7000-8000-0000000c0040');
INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, prev_owner_user_id, pond_id,
       actor_kind, actor_user_id, reason_code, command_id, occurred_at)
VALUES (:tA, :c2, 2, gen_random_uuid(), 'released', 'owned', 'in_pond', :agA1, :pondA, 'user', :agA1, 'NOT_A_FIT',
        'a9000000-0000-7000-8000-0000000c0040', now());
UPDATE contacts SET ownership_state = 'in_pond', owner_user_id = NULL, owned_at = NULL, ownership_period_seq = NULL,
       pond_id = :pondA, ownership_seq = 2, ownership_command_id = 'a9000000-0000-7000-8000-0000000c0040', ownership_actor_user_id = :agA1
 WHERE tenant_id = :tA AND id = :c2 AND ownership_seq = 1;
SELECT pg_temp.cmd(NULL);

DO $$
DECLARE f text[] := '{}'; got uuid[];
  everything uuid[] := pg_temp.ids(ARRAY['rR','r1','r2','r3','r4','rE','rEd','rOwn','rC3']);
  extra uuid[];
BEGIN
  -- the rows of section 2's CHECK cases that passed (two research CMAs by agent 1)
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('ownA'), 'user');
  extra := ARRAY(SELECT id FROM cma_reports WHERE id <> ALL (everything) ORDER BY id);
  everything := ARRAY(SELECT x FROM unnest(everything || extra) x ORDER BY x);
  IF cardinality(extra) <> 3 THEN f := f || ('fixture: ' || cardinality(extra) || ' extra research CMAs'); END IF;
  -- tenant-wide: Owner, Admin and the system read every CMA of the tenant (and none of tenant B)
  got := pg_temp.seen(); IF got <> everything THEN f := f || 'the Owner does not read every CMA'::text; END IF;
  IF EXISTS (SELECT 1 FROM cma_reports WHERE tenant_id = pg_temp.id('tB')) THEN f := f || 'the Owner reads tenant B'::text; END IF;
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('admA'), 'user');
  got := pg_temp.seen(); IF got <> everything THEN f := f || 'the Admin does not read every CMA'::text; END IF;
  PERFORM pg_temp.ctx(pg_temp.id('tA'), NULL, 'system');
  got := pg_temp.seen(); IF got <> everything THEN f := f || 'the system does not read every CMA'::text; END IF;
  -- the creator reads their own, including the CMA of a contact they no longer see the detail of (Bob, in the pond)
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
  got := pg_temp.seen();
  IF got <> ARRAY(SELECT x FROM unnest(pg_temp.ids(ARRAY['rR','r1','r2','r3','r4','rE','rEd']) || extra) x ORDER BY x) THEN
    f := f || ('agent 1 reads ' || cardinality(got) || ' CMAs');
  END IF;
  -- agent 2: their own draft only. Not agent 1's research CMAs, not Alice's (no detail), not Bob's: agent 2 sees Bob's pond
  -- card but not his detail
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA2'), 'user');
  got := pg_temp.seen();
  IF got <> pg_temp.ids(ARRAY['rC3']) THEN f := f || ('agent 2 reads ' || cardinality(got) || ' CMAs'); END IF;
  IF NOT EXISTS (SELECT 1 FROM contacts WHERE id = pg_temp.id('c2')) THEN f := f || 'fixture: agent 2 does not see Bob''s pond card'::text; END IF;
  IF app.contact_detail_visible(pg_temp.id('tA'), pg_temp.id('c2')) THEN f := f || 'fixture: agent 2 sees Bob''s detail'::text; END IF;
  -- agent 3 collaborates on Alice: Alice's CMAs, nothing else
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA3'), 'user');
  got := pg_temp.seen();
  IF got <> pg_temp.ids(ARRAY['r1','r3','r4']) THEN f := f || ('agent 3 reads ' || cardinality(got) || ' CMAs'); END IF;
  -- the Team Lead (not tenant-wide) sees the detail of the team's contacts and the pond, but no research CMA
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('tlA'), 'user');
  got := pg_temp.seen();
  IF got <> pg_temp.ids(ARRAY['r1','r2','r3','r4','rE','rEd']) THEN f := f || ('the Team Lead reads ' || cardinality(got) || ' CMAs'); END IF;
  PERFORM pg_temp.check(f,
    'R-CMA-6: a CMA is read by its creator (even after the contact went to the pond), by whoever sees the contact''s detail '
    || '(a collaborator, the Team Lead) and by tenant-wide roles (Owner, Admin, system); another agent cannot read agent 1''s '
    || 'research CMA, nor a CMA of a contact whose pond card they see without its detail');
END $$;

-- support reads with a grant but never writes; a client principal reads nothing; tenant B reads nothing of tenant A
DO $$
DECLARE f text[] := '{}'; r text; n bigint;
BEGIN
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('supU'), 'support');
  SELECT count(*) INTO n FROM cma_reports;
  IF n < 9 THEN f := f || ('support reads ' || n || ' CMAs'); END IF;
  r := pg_temp.try(pg_temp.cma_sql(gen_random_uuid(), NULL, NULL, NULL));
  IF r !~ 'SUPPORT_READ_ONLY|row-level security' THEN f := f || ('support insert: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET agent_notes = 'support was here' WHERE id = %L$q$, pg_temp.id('r3')));
  IF r !~ 'SUPPORT_READ_ONLY' THEN f := f || ('support update: ' || r); END IF;
  r := pg_temp.rows(format($q$DELETE FROM cma_reports WHERE id = %L$q$, pg_temp.id('r3')));
  IF r !~ 'SUPPORT_READ_ONLY|permission denied' THEN f := f || ('support delete: ' || r); END IF;
  PERFORM pg_temp.check(f, 'R-PERM-11 R-CMA-6: support with an Owner grant reads the tenant''s CMAs and cannot insert, update or delete one');
  f := '{}';
  PERFORM pg_temp.client(pg_temp.id('tA'), gen_random_uuid());
  SELECT count(*) INTO n FROM cma_reports;
  IF n <> 0 THEN f := f || ('the client principal reads ' || n || ' CMAs'); END IF;
  r := pg_temp.try(format($q$INSERT INTO cma_reports (tenant_id, id, purpose, method_version, valuation_date, subject, result,
         content_sha256, created_by_user_id) VALUES (app.tenant_id(), gen_random_uuid(), 'other', 'cma/1', current_date, '{}', '{}',
         repeat('ab', 32), %L)$q$, pg_temp.id('agA1')));
  IF r !~ 'row-level security' THEN f := f || ('client insert: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET agent_notes = 'x' WHERE id = %L$q$, pg_temp.id('r3')));
  IF r <> '0' THEN f := f || ('client update: ' || r); END IF;
  PERFORM pg_temp.ctx(pg_temp.id('tB'), pg_temp.id('ownB'), 'user');
  SELECT count(*) INTO n FROM cma_reports WHERE tenant_id = pg_temp.id('tA');
  IF n <> 0 THEN f := f || ('tenant B''s Owner reads ' || n || ' tenant A CMAs'); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET agent_notes = 'x' WHERE tenant_id = %L$q$, pg_temp.id('tA')));
  IF r <> '0' THEN f := f || ('tenant B''s Owner updates tenant A: ' || r); END IF;
  PERFORM pg_temp.ctx(NULL, pg_temp.id('agA1'), 'user');
  SELECT count(*) INTO n FROM cma_reports;
  IF n <> 0 THEN f := f || ('no tenant context reads ' || n || ' CMAs'); END IF;
  PERFORM pg_temp.check(f,
    'R-PORTAL-1 R-TEN-1 R-CMA-6: a client principal reads no CMA and writes none; tenant B and a context without a tenant read none');
END $$;

-- who may edit a draft: its creator and tenant-wide roles; not a collaborator who reads it, not the Team Lead (F15)
DO $$
DECLARE f text[] := '{}'; r text;
BEGIN
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA3'), 'user');
  r := pg_temp.rows(format($q$UPDATE cma_reports SET agent_notes = 'collaborator edit' WHERE id = %L$q$, pg_temp.id('r3')));
  IF r <> '0' THEN f := f || ('the collaborator updates agent 1''s draft: ' || r); END IF;
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('tlA'), 'user');
  r := pg_temp.rows(format($q$UPDATE cma_reports SET agent_notes = 'team lead edit' WHERE id = %L$q$, pg_temp.id('r3')));
  IF r <> '0' THEN f := f || ('the Team Lead updates agent 1''s draft: ' || r); END IF;
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
  r := pg_temp.rows(format($q$UPDATE cma_reports SET agent_notes = 'creator edit', subject = '{"type": "condo", "sqft": 900}' WHERE id = %L$q$, pg_temp.id('r3')));
  IF r <> '1' THEN f := f || ('the creator edits their draft: ' || r); END IF;
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('admA'), 'user');
  r := pg_temp.rows(format($q$UPDATE cma_reports SET agent_notes = 'admin edit' WHERE id = %L$q$, pg_temp.id('r3')));
  IF r <> '1' THEN f := f || ('the Admin edits agent 1''s draft: ' || r); END IF;
  -- a tenant-wide editor still cannot give the draft to someone else
  r := pg_temp.rows(format($q$UPDATE cma_reports SET created_by_user_id = %L WHERE id = %L$q$, pg_temp.id('admA'), pg_temp.id('r3')));
  IF r !~ 'CMA_CREATOR_IMMUTABLE' THEN f := f || ('the Admin re-attributes the draft: ' || r); END IF;
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
  r := pg_temp.rows(format($q$UPDATE cma_reports SET created_by_user_id = %L WHERE id = %L$q$, pg_temp.id('agA2'), pg_temp.id('r3')));
  IF r !~ 'CMA_CREATOR_IMMUTABLE|row-level security' THEN f := f || ('the creator hands the draft to agent 2: ' || r); END IF;
  r := pg_temp.rows(format($q$DELETE FROM cma_reports WHERE id = %L$q$, pg_temp.id('r3')));
  IF r !~ 'permission denied' THEN f := f || ('the creator deletes the draft: ' || r); END IF;
  PERFORM pg_temp.check(f,
    'R-CMA-8 R-CMA-6: a draft is edited only by its creator or a tenant-wide role (not a collaborator who reads it, not the '
    || 'Team Lead); created_by_user_id never changes (CMA_CREATOR_IMMUTABLE); nobody deletes a CMA');
END $$;

-- the creator's access needs an active membership as a user actor, like every other staff path (contacts_select)
SELECT pg_temp.ctx(:tA, :agA3, 'user');
SELECT pg_temp.ok(pg_temp.try(pg_temp.cma_sql(:rA3, NULL, NULL, NULL)) = 'OK', 'R-CMA-8: agent 3 stores a research CMA');
DO $$
DECLARE f text[] := '{}'; r text; n bigint;
BEGIN
  -- agent 1's user id with no actor kind: no read, no write, no insert of their own CMAs
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), NULL);
  SELECT count(*) INTO n FROM cma_reports;
  IF n <> 0 THEN f := f || ('agent 1 with no actor kind reads ' || n || ' CMAs'); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET agent_notes = 'no actor' WHERE id = %L$q$, pg_temp.id('rR')));
  IF r <> '0' THEN f := f || ('agent 1 with no actor kind edits their research CMA: ' || r); END IF;
  r := pg_temp.try(pg_temp.cma_sql(gen_random_uuid(), NULL, NULL, NULL, pg_temp.id('agA1')));
  IF r !~ 'row-level security' THEN f := f || ('agent 1 with no actor kind stores a CMA: ' || r); END IF;
  -- a suspended agent 3: their own research CMA is no longer theirs to read, edit or add to
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('ownA'), 'user');
  UPDATE memberships SET status = 'suspended' WHERE tenant_id = pg_temp.id('tA') AND user_id = pg_temp.id('agA3');
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA3'), 'user');
  SELECT count(*) INTO n FROM cma_reports;
  IF n <> 0 THEN f := f || ('the suspended agent 3 reads ' || n || ' CMAs'); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET agent_notes = 'suspended' WHERE id = %L$q$, pg_temp.id('rA3')));
  IF r <> '0' THEN f := f || ('the suspended agent 3 edits their research CMA: ' || r); END IF;
  r := pg_temp.try(pg_temp.cma_sql(gen_random_uuid(), NULL, NULL, NULL));
  IF r !~ 'row-level security' THEN f := f || ('the suspended agent 3 stores a CMA: ' || r); END IF;
  -- reactivated, they read it again
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('ownA'), 'user');
  UPDATE memberships SET status = 'active' WHERE tenant_id = pg_temp.id('tA') AND user_id = pg_temp.id('agA3');
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA3'), 'user');
  IF NOT EXISTS (SELECT 1 FROM cma_reports WHERE id = pg_temp.id('rA3')) THEN f := f || 'the reactivated agent 3 does not read their CMA'::text; END IF;
  PERFORM pg_temp.check(f,
    'R-CMA-6 R-CMA-8: the creator reads, edits and stores CMAs only with an active membership as a user actor (no actor '
    || 'kind, or a suspended member: nothing)');
END $$;

-- =============================================================================
-- 4. The guard: addresses, sharing, status transitions and the immutability of shared and superseded rows
-- =============================================================================
DO $$
DECLARE f text[] := '{}'; r text;
BEGIN
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
  -- Bob's address on a CMA of Alice: agent 1 owns both (so this is the guard, not visibility)
  r := pg_temp.try(pg_temp.cma_sql(gen_random_uuid(), pg_temp.id('c1'), pg_temp.id('a2'), NULL));
  IF r !~ 'CMA_ADDRESS_NOT_OF_CONTACT' THEN f := f || ('insert with Bob''s address on Alice: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET contact_address_id = %L WHERE id = %L$q$, pg_temp.id('aE'), pg_temp.id('r3')));
  IF r !~ 'CMA_ADDRESS_NOT_OF_CONTACT' THEN f := f || ('a draft moved to Erin''s address: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET contact_id = %L WHERE id = %L$q$, pg_temp.id('cE'), pg_temp.id('r4')));
  IF r !~ 'CMA_CONTACT_IMMUTABLE' THEN f := f || ('a draft moved to Erin keeping Alice''s address: ' || r); END IF;
  -- the Owner sees every address; Cara's address on Alice is still refused
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('ownA'), 'user');
  r := pg_temp.try(pg_temp.cma_sql(gen_random_uuid(), pg_temp.id('c1'), pg_temp.id('a3'), NULL));
  IF r !~ 'CMA_ADDRESS_NOT_OF_CONTACT' THEN f := f || ('the Owner puts Cara''s address on Alice: ' || r); END IF;
  -- a draft drops its address and takes it again (agent 2, on their own Cara)
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA2'), 'user');
  r := pg_temp.rows(format($q$UPDATE cma_reports SET contact_address_id = NULL WHERE id = %L$q$, pg_temp.id('rC3')));
  IF r <> '1' THEN f := f || ('a draft drops its address: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET contact_address_id = %L WHERE id = %L$q$, pg_temp.id('a3'), pg_temp.id('rC3')));
  IF r <> '1' THEN f := f || ('and takes it again: ' || r); END IF;
  PERFORM pg_temp.check(f,
    'R-CMA-8: contact_address_id must be an address of the CMA''s contact, on insert and on every change '
    || '(CMA_ADDRESS_NOT_OF_CONTACT), whoever writes it');
END $$;

-- a CMA stays with the contact it was prepared for: the insert policy checked that contact's detail, and no update moves
-- it (onto a contact whose detail the caller does not see, or one that does not exist: no foreign-key oracle either)
DO $$
DECLARE f text[] := '{}'; r text;
BEGIN
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
  IF app.contact_detail_visible(pg_temp.id('tA'), pg_temp.id('c3')) THEN f := f || 'fixture: agent 1 sees Cara''s detail'::text; END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET contact_id = %L WHERE id = %L$q$, pg_temp.id('c3'), pg_temp.id('rR')));
  IF r !~ 'CMA_CONTACT_IMMUTABLE' THEN f := f || ('agent 1 moves their research CMA onto Cara, hidden from them: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET contact_id = gen_random_uuid() WHERE id = %L$q$, pg_temp.id('rR')));
  IF r !~ 'CMA_CONTACT_IMMUTABLE' THEN f := f || ('agent 1 probes a contact id that does not exist: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET contact_id = %L WHERE id = %L$q$, pg_temp.id('cE'), pg_temp.id('rR')));
  IF r !~ 'CMA_CONTACT_IMMUTABLE' THEN f := f || ('agent 1 moves their research CMA onto their own Erin: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET contact_id = NULL WHERE id = %L$q$, pg_temp.id('r3')));
  IF r !~ 'CMA_CONTACT_IMMUTABLE' THEN f := f || ('agent 1 detaches Alice''s draft from her: ' || r); END IF;
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('ownA'), 'user');
  r := pg_temp.rows(format($q$UPDATE cma_reports SET contact_id = %L WHERE id = %L$q$, pg_temp.id('c1'), pg_temp.id('rOwn')));
  IF r !~ 'CMA_CONTACT_IMMUTABLE' THEN f := f || ('the Owner moves their research CMA onto Alice: ' || r); END IF;
  -- agent 2 (Cara's owner) still reads no CMA of agent 1
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA2'), 'user');
  IF EXISTS (SELECT 1 FROM cma_reports WHERE id = pg_temp.id('rR')) THEN f := f || 'agent 2 reads agent 1''s research CMA'::text; END IF;
  PERFORM pg_temp.check(f,
    'R-CMA-6 R-CMA-8: a CMA keeps its contact (CMA_CONTACT_IMMUTABLE): no update moves a CMA onto a contact the caller does '
    || 'not see, onto an id that does not exist, onto another contact or off its contact, for the creator or the Owner');
END $$;

-- sharing: one UPDATE, by a user actor as themselves, with shared_at and the share message
DO $$
DECLARE f text[] := '{}'; r text;
BEGIN
  -- the system actor (tenant-wide, so its UPDATE reaches the row) never shares
  PERFORM pg_temp.ctx(pg_temp.id('tA'), NULL, 'system');
  r := pg_temp.rows(format($q$UPDATE cma_reports SET status = 'shared', shared_by_user_id = %L, shared_at = now(), shared_message_id = %L
         WHERE id = %L$q$, pg_temp.id('agA1'), pg_temp.id('m1'), pg_temp.id('r1')));
  IF r !~ 'CMA_SHARE_AS_SELF' THEN f := f || ('the system shares: ' || r); END IF;
  -- a person shares as themselves: not in another person's name
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('ownA'), 'user');
  r := pg_temp.rows(format($q$UPDATE cma_reports SET status = 'shared', shared_by_user_id = %L, shared_at = now(), shared_message_id = %L
         WHERE id = %L$q$, pg_temp.id('agA1'), pg_temp.id('m1'), pg_temp.id('r1')));
  IF r !~ 'CMA_SHARE_AS_SELF' THEN f := f || ('the Owner shares in agent 1''s name: ' || r); END IF;
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
  -- all three share fields in the same UPDATE
  r := pg_temp.rows(format($q$UPDATE cma_reports SET status = 'shared', shared_by_user_id = app.user_id(), shared_at = now() WHERE id = %L$q$, pg_temp.id('r1')));
  IF r !~ 'CMA_SHARE_AS_SELF' THEN f := f || ('a share without its message: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET status = 'shared', shared_at = now(), shared_message_id = %L WHERE id = %L$q$,
         pg_temp.id('m1'), pg_temp.id('r1')));
  IF r !~ 'CMA_SHARE_AS_SELF' THEN f := f || ('a share without shared_by: ' || r); END IF;
  -- share fields never appear on a draft
  r := pg_temp.rows(format($q$UPDATE cma_reports SET shared_message_id = %L WHERE id = %L$q$, pg_temp.id('m1'), pg_temp.id('r1')));
  IF r !~ 'CMA_SHARE_FIELDS' THEN f := f || ('a draft linked to a message: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET shared_at = now(), shared_by_user_id = app.user_id() WHERE id = %L$q$, pg_temp.id('r1')));
  IF r !~ 'CMA_SHARE_FIELDS' THEN f := f || ('a draft stamped as shared: ' || r); END IF;
  -- the share message is an outbound email the sharer sees: not another tenant's, not an inbound one, not one hidden by RLS
  r := pg_temp.rows(pg_temp.share_sql(pg_temp.id('r1'), pg_temp.id('mB')));
  IF r !~ 'CMA_SHARE_MESSAGE|foreign key' THEN f := f || ('a share linking tenant B''s message: ' || r); END IF;
  r := pg_temp.rows(pg_temp.share_sql(pg_temp.id('r1'), pg_temp.id('mIn')));
  IF r !~ 'CMA_SHARE_MESSAGE' THEN f := f || ('a share linking Alice''s inbound email: ' || r); END IF;
  IF EXISTS (SELECT 1 FROM messages WHERE id = pg_temp.id('m3')) THEN f := f || 'fixture: agent 1 sees Cara''s email'::text; END IF;
  r := pg_temp.rows(pg_temp.share_sql(pg_temp.id('r1'), pg_temp.id('m3')));
  IF r !~ 'CMA_SHARE_MESSAGE' THEN f := f || ('a share linking Cara''s email, hidden from agent 1: ' || r); END IF;
  -- agent 1 shares r1 (Alice, address a1, listing lDel, message mDel) with a back-dated shared_at, r4 (Alice, a1b, m1) without
  -- one, and Erin's rE (aE, mE); r3 stays a draft. The database stamps shared_at with its own clock.
  r := pg_temp.rows(format($q$UPDATE cma_reports SET status = 'shared', shared_by_user_id = app.user_id(), shared_at = now() - interval '3 days',
         shared_message_id = %L WHERE id = %L$q$, pg_temp.id('mDel'), pg_temp.id('r1')));
  IF r <> '1' THEN f := f || ('share r1: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET status = 'shared', shared_by_user_id = app.user_id(), shared_message_id = %L WHERE id = %L$q$,
         pg_temp.id('m1'), pg_temp.id('r4')));
  IF r <> '1' THEN f := f || ('share r4 without shared_at: ' || r); END IF;
  r := pg_temp.rows(pg_temp.share_sql(pg_temp.id('rE'), pg_temp.id('mE')));    IF r <> '1' THEN f := f || ('share rE: ' || r); END IF;
  IF (SELECT count(*) FROM cma_reports WHERE status = 'shared' AND shared_by_user_id = pg_temp.id('agA1') AND shared_at = now()
         AND shared_message_id IS NOT NULL) <> 4 THEN
    f := f || 'the four shared rows (r2 shared earlier) do not carry their share fields with shared_at = the database clock'::text;
  END IF;
  PERFORM pg_temp.check(f,
    'R-CMA-8: draft -> shared is one UPDATE by a user actor as themselves (shared_by = app.user_id()) that links the share '
    || 'message, and the database stamps shared_at; the system actor and a person in someone else''s name cannot share '
    || '(CMA_SHARE_AS_SELF); share fields never appear on a draft (CMA_SHARE_FIELDS); the share message is an outbound email '
    || 'the sharer sees, never another tenant''s, an inbound one or one hidden from them (CMA_SHARE_MESSAGE)');
END $$;
-- a shared CMA with no address: the contact change case below
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(pg_temp.try(pg_temp.cma_sql(:rS, :c1, NULL, :lA)) ~ 'cma_reports_one_open_draft',
       'R-CMA-8 (F15): a second open draft of agent 1 for Alice with no address (r3 is open) is refused (cma_reports_one_open_draft)');
SELECT pg_temp.rows(format($q$UPDATE cma_reports SET status = 'superseded' WHERE id = %L$q$, :r3));
SELECT pg_temp.ok(pg_temp.try(pg_temp.cma_sql(:rS, :c1, NULL, :lA)) = 'OK'
                  AND pg_temp.rows(pg_temp.share_sql(:rS, :m1)) ~ 'cma_reports_share_message'
                  AND pg_temp.rows(pg_temp.share_sql(:rS, :mS)) = '1',
       'R-CMA-8: once the open draft is superseded, a new draft for the same contact and address is stored, and shared; '
       || 'its share email is its own (r4''s email is refused: cma_reports_share_message)');

-- the address stays the CMA's contact's from the address side too: an address a CMA names never moves to another contact
DO $$
DECLARE f text[] := '{}'; r text;
BEGIN
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('ownA'), 'user');
  r := pg_temp.rows(format($q$UPDATE contact_addresses SET contact_id = %L WHERE id = %L$q$, pg_temp.id('cE'), pg_temp.id('a1')));
  IF r !~ 'foreign key' THEN f := f || ('the Owner moves Alice''s address a1 (the shared r1 names it) to Erin: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE contact_addresses SET contact_id = %L WHERE id = %L$q$, pg_temp.id('c1'), pg_temp.id('a3')));
  IF r !~ 'foreign key' THEN f := f || ('the Owner moves Cara''s address a3 (agent 2''s draft names it) to Alice: ' || r); END IF;
  -- an address no CMA names moves as before
  INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, line1, city, region, postal_code)
  VALUES (pg_temp.id('tA'), pg_temp.id('aX'), pg_temp.id('c1'), 'mailing', '2 Spare Ln', 'Seaside', 'SC', '29900');
  r := pg_temp.rows(format($q$UPDATE contact_addresses SET contact_id = %L WHERE id = %L$q$, pg_temp.id('cE'), pg_temp.id('aX')));
  IF r <> '1' THEN f := f || ('the Owner moves an address no CMA names: ' || r); END IF;
  IF (SELECT contact_id FROM contact_addresses WHERE id = pg_temp.id('a1')) IS DISTINCT FROM pg_temp.id('c1')
     OR (SELECT contact_id FROM contact_addresses WHERE id = pg_temp.id('a3')) IS DISTINCT FROM pg_temp.id('c3') THEN
    f := f || 'a named address changed its contact'::text;
  END IF;
  PERFORM pg_temp.check(f,
    'R-CMA-8: an address a CMA names (shared or draft) cannot move to another contact, even for the Owner (the address '
    || 'foreign key carries the contact); an address no CMA names still can');
END $$;
SELECT pg_temp.ok((SELECT status FROM cma_reports WHERE id = :r3) = 'superseded', 'R-CMA-8: draft -> superseded is allowed');

-- the shared rows as they are now (owner role: RLS bypassed), for the unchanged checks below
RESET ROLE;
INSERT INTO pg_temp.snap (name, j)
SELECT f.name, to_jsonb(c) - 'updated_at' FROM public.cma_reports c JOIN pg_temp.fx f ON f.id = c.id WHERE f.name IN ('r1','r4','rS','r3');
SET LOCAL ROLE app_user;

-- a shared or superseded CMA never changes
DO $$
DECLARE f text[] := '{}'; r text; col record;
BEGIN
  FOR col IN SELECT * FROM (VALUES
      ('contact_id', format('%L', pg_temp.id('c2'))), ('subject', $v$'{"type": "condo"}'$v$), ('result', $v$'{"comps": [1]}'$v$),
      ('value_cents', '41600000'), ('low_cents', '39000000'), ('high_cents', '45000000'), ('agent_notes', $v$'edited after sharing'$v$),
      ('purpose', $v$'buyer_offer'$v$), ('inspection', $v$'exterior'$v$), ('inspected_on', 'current_date'),
      ('intended_users', $v$'the seller'$v$), ('agent_interest', $v$'none'$v$), ('conflicts', $v$'none'$v$),
      ('value_definition', $v$'market value'$v$), ('limiting_conditions', $v$'no interior visit'$v$),
      ('method_version', $v$'cma/2'$v$), ('valuation_date', 'current_date - 1'), ('mls_data_as_of', 'now() - interval ''1 day'''),
      ('content_sha256', $v$repeat('cd', 32)$v$), ('shared_at', 'now() - interval ''1 day'''), ('shared_by_user_id', format('%L', pg_temp.id('ownA'))),
      ('created_at', 'now() - interval ''1 day'''), ('listing_id', format('%L', pg_temp.id('lDel'))), ('id', 'gen_random_uuid()')) AS v(c, e) LOOP
    -- as the creator, on the shared row with no address (rS); a contact change there is not also an address mismatch
    PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
    r := pg_temp.rows(format('UPDATE cma_reports SET %I = %s WHERE id = %L', col.c, col.e, pg_temp.id('rS')));
    IF r !~ 'CMA_NOT_DRAFT|CMA_SHARE_FIELDS|CMA_CONTACT_IMMUTABLE' THEN f := f || (col.c || ' on a shared row: ' || r); END IF;
    -- as the Owner, on the superseded draft r3
    PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('ownA'), 'user');
    r := pg_temp.rows(format('UPDATE cma_reports SET %I = %s WHERE id = %L', col.c, col.e, pg_temp.id('r3')));
    IF r !~ 'CMA_NOT_DRAFT|CMA_SHARE_FIELDS|CMA_CONTACT_IMMUTABLE|CMA_ADDRESS_NOT_OF_CONTACT|cma_reports_shared_state' THEN f := f || (col.c || ' on a superseded row: ' || r); END IF;
  END LOOP;
  -- the links never move to another target on a shared row, and are nulled only by the deletion of their target
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
  r := pg_temp.rows(format($q$UPDATE cma_reports SET listing_id = NULL WHERE id = %L$q$, pg_temp.id('r1')));
  IF r !~ 'CMA_NOT_DRAFT' THEN f := f || ('the creator nulls a shared row''s listing: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET contact_address_id = NULL WHERE id = %L$q$, pg_temp.id('r1')));
  IF r !~ 'CMA_NOT_DRAFT' THEN f := f || ('the creator nulls a shared row''s address: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET contact_address_id = %L WHERE id = %L$q$, pg_temp.id('a1b'), pg_temp.id('r1')));
  IF r !~ 'CMA_NOT_DRAFT' THEN f := f || ('the creator moves a shared row to another address of the contact: ' || r); END IF;
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('ownA'), 'user');
  r := pg_temp.rows(format($q$UPDATE cma_reports SET shared_message_id = NULL WHERE id = %L$q$, pg_temp.id('r1')));
  IF r !~ 'CMA_NOT_DRAFT|CMA_SHARE_FIELDS' THEN f := f || ('the Owner unlinks a shared row''s message: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET shared_message_id = %L WHERE id = %L$q$, pg_temp.id('m1'), pg_temp.id('r1')));
  IF r !~ 'CMA_NOT_DRAFT|CMA_SHARE_FIELDS' THEN f := f || ('the Owner relinks a shared row''s message: ' || r); END IF;
  PERFORM pg_temp.ctx(pg_temp.id('tA'), NULL, 'system');
  r := pg_temp.rows(format($q$UPDATE cma_reports SET listing_id = NULL WHERE id = %L$q$, pg_temp.id('r1')));
  IF r !~ 'CMA_NOT_DRAFT' THEN f := f || ('the system nulls a shared row''s listing: ' || r); END IF;
  -- agent 1 no longer sees Bob's address or message rows (RLS), yet they still exist: the creator cannot null them on r2
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
  IF EXISTS (SELECT 1 FROM contact_addresses WHERE id = pg_temp.id('a2')) OR EXISTS (SELECT 1 FROM messages WHERE id = pg_temp.id('m2')) THEN
    f := f || 'fixture: agent 1 still sees Bob''s address or message'::text;
  END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET contact_address_id = NULL WHERE id = %L$q$, pg_temp.id('r2')));
  IF r !~ 'CMA_NOT_DRAFT' THEN f := f || ('the creator nulls the address of Bob''s shared CMA, hidden from them: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET shared_message_id = NULL WHERE id = %L$q$, pg_temp.id('r2')));
  IF r !~ 'CMA_NOT_DRAFT|CMA_SHARE_FIELDS' THEN f := f || ('the creator unlinks the message of Bob''s shared CMA, hidden from them: ' || r); END IF;
  PERFORM pg_temp.check(f,
    'R-CMA-8: a shared or superseded CMA never changes: none of its content columns (contact, subject, result, '
    || 'value/low/high, notes, purpose, inspection and date, the five SoP 11-1 items, method version, valuation date, MLS '
    || 'date, digest), its share fields, created_at or id, for the creator, the Owner or the system (CMA_NOT_DRAFT); a '
    || 'listing, address or message link is not nulled or moved by a direct UPDATE, even when the link''s target is '
    || 'hidden from the caller (the allowance is the foreign-key action only)');
END $$;

-- status transitions
DO $$
DECLARE f text[] := '{}'; r text;
BEGIN
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
  r := pg_temp.rows(format($q$UPDATE cma_reports SET status = 'draft' WHERE id = %L$q$, pg_temp.id('rS')));
  IF r !~ 'CMA_STATUS_TRANSITION' THEN f := f || ('shared -> draft: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET status = 'draft' WHERE id = %L$q$, pg_temp.id('r3')));
  IF r !~ 'CMA_STATUS_TRANSITION' THEN f := f || ('superseded -> draft: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET status = 'shared', shared_by_user_id = app.user_id(), shared_at = now(),
         shared_message_id = %L WHERE id = %L$q$, pg_temp.id('m1'), pg_temp.id('r3')));
  IF r !~ 'CMA_STATUS_TRANSITION|CMA_NOT_DRAFT' THEN f := f || ('superseded -> shared: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET status = 'archived' WHERE id = %L$q$, pg_temp.id('r2')));
  IF r !~ 'CMA_STATUS_TRANSITION|check constraint' THEN f := f || ('draft -> archived: ' || r); END IF;
  -- shared -> superseded, by the creator; superseded is final
  r := pg_temp.rows(format($q$UPDATE cma_reports SET status = 'superseded' WHERE id = %L$q$, pg_temp.id('r4')));
  IF r <> '1' THEN f := f || ('shared -> superseded: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE cma_reports SET status = 'shared' WHERE id = %L$q$, pg_temp.id('r4')));
  IF r !~ 'CMA_STATUS_TRANSITION' THEN f := f || ('superseded -> shared again: ' || r); END IF;
  -- a no-op UPDATE of a shared row passes (updated_at only)
  r := pg_temp.rows(format($q$UPDATE cma_reports SET status = status WHERE id = %L$q$, pg_temp.id('rS')));
  IF r <> '1' THEN f := f || ('a no-op update of a shared row: ' || r); END IF;
  PERFORM pg_temp.check(f,
    'R-CMA-8: status moves only draft -> shared, draft -> superseded and shared -> superseded (CMA_STATUS_TRANSITION); '
    || 'superseded is final; a no-op update of a shared row passes');
END $$;

RESET ROLE;
SELECT pg_temp.ok(
  (SELECT bool_and((to_jsonb(c) - 'updated_at' - 'status') = (s.j - 'status'))
     FROM public.cma_reports c JOIN pg_temp.fx f ON f.id = c.id JOIN pg_temp.snap s ON s.name = f.name)
  AND (SELECT count(*) FROM pg_temp.snap) = 4,
  'R-CMA-8: after every refused change, the shared and superseded rows hold exactly what they held (status aside: r4 was superseded)');
SET LOCAL ROLE app_user;

-- =============================================================================
-- 5. Foreign-key actions on a shared row (F9): deleting its address, its listing or its message nulls the link and passes
-- =============================================================================
-- the agent deletes Alice's property address (an application path: 0037's address delete)
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(pg_temp.rows(format($q$DELETE FROM contact_addresses WHERE id = %L$q$, :a1)) = '1',
       'R-CMA-8 (F9): agent 1 deletes Alice''s address a1, which the shared r1 names');
-- agent 1 holds an open draft for Alice with no address (dN) and one for her home address a1b (dX); the superseded r4 also
-- names a1b. Deleting a1b nulls r4's link, and supersedes dX instead of turning it into a second no-address draft (the
-- one-open-draft index would otherwise refuse the deletion, and the contact's erasure)
SELECT pg_temp.ok(pg_temp.try(pg_temp.cma_sql(:dN, :c1, NULL, NULL)) = 'OK' AND pg_temp.try(pg_temp.cma_sql(:dX, :c1, :a1b, NULL)) = 'OK',
       'R-CMA-8: agent 1 opens a no-address draft and a draft for Alice''s home address');
SELECT pg_temp.ok(pg_temp.rows(format($q$DELETE FROM contact_addresses WHERE id = %L$q$, :a1b)) = '1',
       'R-CMA-8 (F9, F15): agent 1 deletes Alice''s home address a1b while an open draft names it');
SELECT pg_temp.ok((SELECT status = 'superseded' AND contact_address_id IS NULL FROM cma_reports WHERE id = :dX)
  AND (SELECT status = 'draft' AND contact_address_id IS NULL FROM cma_reports WHERE id = :dN)
  AND (SELECT status = 'superseded' AND contact_address_id IS NULL FROM cma_reports WHERE id = :r4),
  'R-CMA-8 (F9, F15): deleting an address nulls it on a superseded CMA, and an open draft prepared for it that would '
  || 'collide with the creator''s open no-address draft (dN) is superseded instead');
-- with no such collision the draft stays open: agent 2 deletes Cara's address a3, which their draft rC3 names (agent 2 has no
-- other open draft for Cara)
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok(pg_temp.rows(format($q$DELETE FROM contact_addresses WHERE id = %L$q$, :a3)) = '1',
       'R-CMA-8 (F9, F15): agent 2 deletes Cara''s address a3 while their open draft names it');
SELECT pg_temp.ok((SELECT status = 'draft' AND contact_address_id IS NULL FROM cma_reports WHERE id = :rC3),
  'R-CMA-8 (F9, F15): deleting the address of a draft that collides with no open draft keeps the draft open, its address nulled');
-- platform maintenance (no application path deletes an MLS listing or a message yet): the listing and the message
RESET ROLE;
DELETE FROM public.listings WHERE tenant_id = :tA AND id = :lDel;
DELETE FROM public.messages WHERE tenant_id = :tA AND id = :mDel;
SELECT pg_temp.ok(
  (SELECT c.status = 'shared' AND c.contact_address_id IS NULL AND c.listing_id IS NULL AND c.shared_message_id IS NULL
          AND (to_jsonb(c) - ARRAY['updated_at','contact_address_id','listing_id','shared_message_id'])
            = (s.j - ARRAY['contact_address_id','listing_id','shared_message_id'])
     FROM public.cma_reports c JOIN pg_temp.snap s ON s.name = 'r1' WHERE c.id = :r1),
  'R-CMA-8 (F9): the foreign-key actions null a shared row''s contact_address_id, listing_id and shared_message_id, and '
  || 'nothing else of the row changes');
-- the owner role itself cannot null a link whose target still exists (the allowance is the foreign-key action only)
SELECT pg_temp.ok(pg_temp.rows(format($q$UPDATE public.cma_reports SET listing_id = NULL WHERE id = %L$q$, :rS)) ~ 'CMA_NOT_DRAFT',
       'R-CMA-8 (F9): a direct UPDATE nulling a shared row''s live listing is refused even for the table owner');
-- each foreign-key action finds its rows through an index on the link (not a scan of the tenant's CMAs)
CREATE FUNCTION pg_temp.plan_of(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE l text; out text := '';
BEGIN
  FOR l IN EXECUTE 'EXPLAIN ' || p_sql LOOP out := out || l || ' / '; END LOOP;
  RETURN out;
END $$;
DO $$
DECLARE f text[] := '{}'; plan text; t uuid := pg_temp.id('tA');
BEGIN
  SET LOCAL enable_seqscan = off;
  plan := pg_temp.plan_of(format('UPDATE ONLY public.cma_reports SET listing_id = NULL WHERE tenant_id = %L AND listing_id = %L', t, pg_temp.id('lA')));
  IF plan !~ 'cma_reports_listing_idx' THEN f := f || ('listing: ' || plan); END IF;
  plan := pg_temp.plan_of(format('UPDATE ONLY public.cma_reports SET shared_message_id = NULL WHERE tenant_id = %L AND shared_message_id = %L', t, pg_temp.id('m1')));
  IF plan !~ 'cma_reports_share_message' THEN f := f || ('message: ' || plan); END IF;
  plan := pg_temp.plan_of(format('UPDATE ONLY public.cma_reports SET contact_address_id = NULL WHERE tenant_id = %L AND contact_address_id = %L', t, pg_temp.id('a2')));
  IF plan !~ 'cma_reports_address_idx' THEN f := f || ('address: ' || plan); END IF;
  SET LOCAL enable_seqscan = on;
  PERFORM pg_temp.check(f, 'R-CMA-8 (F9): the listing, address and share-message foreign-key actions each find their rows through the link''s index');
END $$;
SET LOCAL ROLE app_user;

-- =============================================================================
-- 6. Keys and the one-open-draft index
-- =============================================================================
DO $$
DECLARE f text[] := '{}'; r text;
BEGIN
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
  -- tenant B's listing
  r := pg_temp.try(pg_temp.cma_sql(gen_random_uuid(), NULL, NULL, pg_temp.id('lB')));
  IF r !~ 'foreign key' THEN f := f || ('a CMA of tenant A on tenant B''s listing: ' || r); END IF;
  -- a user of tenant B (no membership in A) storing a CMA under tenant A's context: no active membership, so the insert
  -- policy refuses it first (the foreign key on the creator is proven below with RLS bypassed)
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('ownB'), 'user');
  r := pg_temp.try(pg_temp.cma_sql(gen_random_uuid(), NULL, NULL, NULL));
  IF r !~ 'row-level security|foreign key' THEN f := f || ('a CMA created by a non-member: ' || r); END IF;
  PERFORM pg_temp.check(f, 'R-TEN-1: a CMA cannot name another tenant''s listing, nor be stored by a user who is not a member of the tenant');
END $$;
-- as the owner role (RLS bypassed, triggers on): tenant B's contact, and tenant B's address on a tenant A contact
RESET ROLE;
DO $$
DECLARE f text[] := '{}'; r text;
BEGIN
  r := pg_temp.try(format($q$INSERT INTO public.cma_reports (tenant_id, id, contact_id, purpose, method_version, valuation_date, subject,
         result, content_sha256, created_by_user_id) VALUES (%L, gen_random_uuid(), %L, 'other', 'cma/1', current_date, '{}', '{}',
         repeat('ab', 32), %L)$q$, pg_temp.id('tA'), pg_temp.id('cB'), pg_temp.id('agA1')));
  IF r !~ 'foreign key' THEN f := f || ('tenant B''s contact: ' || r); END IF;
  r := pg_temp.try(format($q$INSERT INTO public.cma_reports (tenant_id, id, contact_id, contact_address_id, purpose, method_version,
         valuation_date, subject, result, content_sha256, created_by_user_id) VALUES (%L, gen_random_uuid(), %L, %L, 'other', 'cma/1',
         current_date, '{}', '{}', repeat('ab', 32), %L)$q$, pg_temp.id('tA'), pg_temp.id('c1'), pg_temp.id('aB'), pg_temp.id('agA1')));
  IF r !~ 'foreign key|CMA_ADDRESS_NOT_OF_CONTACT' THEN f := f || ('tenant B''s address: ' || r); END IF;
  r := pg_temp.try(format($q$INSERT INTO public.cma_reports (tenant_id, id, purpose, method_version, valuation_date, subject, result,
         content_sha256, created_by_user_id) VALUES (%L, gen_random_uuid(), 'other', 'cma/1', current_date, '{}', '{}', repeat('ab', 32), %L)$q$,
         pg_temp.id('tA'), pg_temp.id('ownB')));
  IF r !~ 'foreign key' THEN f := f || ('a creator who is not a member of tenant A: ' || r); END IF;
  PERFORM pg_temp.check(f, 'R-TEN-1: even with RLS bypassed, a tenant A CMA cannot name tenant B''s contact or address, nor a creator who is not a member (composite foreign keys)');
END $$;
SET LOCAL ROLE app_user;

DO $$
DECLARE f text[] := '{}'; r text; d1 uuid := gen_random_uuid();
BEGIN
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
  -- Erin has an open draft with no address (rEd): a second one is refused, with the null address compared as equal
  r := pg_temp.try(pg_temp.cma_sql(gen_random_uuid(), pg_temp.id('cE'), NULL, NULL));
  IF r !~ 'cma_reports_one_open_draft' THEN f := f || ('a second open draft for Erin with no address: ' || r); END IF;
  -- Erin's address aE has only the shared rE: a draft for it is stored, a second is refused
  r := pg_temp.try(pg_temp.cma_sql(d1, pg_temp.id('cE'), pg_temp.id('aE'), NULL));
  IF r <> 'OK' THEN f := f || ('a draft for Erin''s address beside the shared CMA: ' || r); END IF;
  r := pg_temp.try(pg_temp.cma_sql(gen_random_uuid(), pg_temp.id('cE'), pg_temp.id('aE'), NULL));
  IF r !~ 'cma_reports_one_open_draft' THEN f := f || ('a second open draft for Erin''s address: ' || r); END IF;
  -- research CMAs are not limited
  r := pg_temp.try(pg_temp.cma_sql(gen_random_uuid(), NULL, NULL, NULL));
  IF r <> 'OK' THEN f := f || ('another research CMA: ' || r); END IF;
  -- another creator has their own open draft for the same contact and address
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('ownA'), 'user');
  r := pg_temp.try(pg_temp.cma_sql(gen_random_uuid(), pg_temp.id('cE'), NULL, NULL));
  IF r <> 'OK' THEN f := f || ('the Owner''s own open draft for Erin: ' || r); END IF;
  -- superseding the open draft frees the slot
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
  r := pg_temp.rows(format($q$UPDATE cma_reports SET status = 'superseded' WHERE id = %L$q$, d1));
  IF r <> '1' THEN f := f || ('superseding the draft: ' || r); END IF;
  r := pg_temp.try(pg_temp.cma_sql(gen_random_uuid(), pg_temp.id('cE'), pg_temp.id('aE'), NULL));
  IF r <> 'OK' THEN f := f || ('a new draft after superseding: ' || r); END IF;
  PERFORM pg_temp.check(f,
    'R-CMA-8 (F15): one open draft per (creator, contact, address), a null address included (NULLS NOT DISTINCT); shared and '
    || 'superseded rows, research CMAs and other creators are not counted');
END $$;

-- =============================================================================
-- 7. Erasure: the contact's CMAs go with the contact, a shared one included (its address and message links are
--    nulled first by their own cascades, which the guard lets through)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT app.erase_contact(:cE, 'a9000000-0000-7000-8000-0000000ae001', 'Seller asked to be forgotten');
RESET ROLE;
SELECT pg_temp.ok(
  NOT EXISTS (SELECT 1 FROM public.cma_reports WHERE tenant_id = :tA AND contact_id = :cE)
  AND NOT EXISTS (SELECT 1 FROM public.cma_reports WHERE id IN (:rE, :rEd))
  AND EXISTS (SELECT 1 FROM public.cma_reports WHERE id = :r1)
  AND (SELECT count(*) FROM public.cma_reports WHERE tenant_id = :tB) = 1,
  'R-DATA-7 R-CMA-8: erasing Erin removes all her CMAs, the shared one included, and no other CMA');
SET LOCAL ROLE app_user;

-- =============================================================================
-- 8. listings: the MLS sale and property columns (R-CMA-1), written by the MLS sync (the system actor) only
-- =============================================================================
DO $$
DECLARE f text[] := '{}'; r text; base text; v record;
BEGIN
  PERFORM pg_temp.ctx(pg_temp.id('tA'), NULL, 'system');
  base := format($q$INSERT INTO listings (tenant_id, id, source, status, address_line1, city, region, postal_code, mls_connection_id,
                    mls_modified_at, listing_brokerage_name, %%s) VALUES (app.tenant_id(), gen_random_uuid(), 'mls', 'sold', '8 Tern Pl',
                    'Seaside', 'SC', '29900', %L, now(), 'Other Brokerage', %%s)$q$, pg_temp.id('mlsA'));
  FOR v IN SELECT * FROM (VALUES
      ('latitude_e6', '32776500', 'coordinates_pair', 'latitude without longitude'),
      ('longitude_e6', '-79931100', 'coordinates_pair', 'longitude without latitude'),
      ('latitude_e6, longitude_e6', '90000001, 0', 'latitude_e6', 'latitude above 90'),
      ('latitude_e6, longitude_e6', '-90000001, 0', 'latitude_e6', 'latitude below -90'),
      ('latitude_e6, longitude_e6', '0, 180000001', 'longitude_e6', 'longitude above 180'),
      ('latitude_e6, longitude_e6', '0, -180000001', 'longitude_e6', 'longitude below -180'),
      ('sale_conditions', $s$ARRAY['standard','foreclosure']$s$, 'sale_conditions', 'an unknown sale condition'),
      ('sale_conditions', 'NULL', 'null value|sale_conditions', 'null sale conditions'),
      ('close_price_cents', '-1', 'close_price_cents', 'a negative close price'),
      ('original_list_price_cents', '-1', 'original_list_price_cents', 'a negative original list price'),
      ('concessions_cents', '-1', 'concessions_cents', 'negative concessions'),
      ('days_on_market', '-1', 'days_on_market', 'negative days on market'),
      ('year_built', '1599', 'year_built', 'year built 1599'),
      ('year_built', '2101', 'year_built', 'year built 2101'),
      ('lot_sqft', '-1', 'lot_sqft', 'a negative lot'),
      ('garage_spaces_x10', '-5', 'garage_spaces_x10', 'negative garage spaces'),
      ('stories_x10', '-10', 'stories_x10', 'negative stories'),
      ('geo_cell', '1', 'geo_cell', 'a written geo_cell')) AS t(cols, vals, err, label) LOOP
    r := pg_temp.try(format(base, v.cols, v.vals));
    IF r = 'OK' OR r !~ v.err THEN f := f || (v.label || ': ' || r); END IF;
  END LOOP;
  -- the accepted shapes: tenths kept, conditions from the vocabulary, a pair of coordinates, a closed sale
  r := pg_temp.try(format(base, 'mls_number, close_price_cents, close_date, purchase_contract_date, original_list_price_cents, concessions_cents, '
         || 'sale_conditions, days_on_market, latitude_e6, longitude_e6, year_built, lot_sqft, subdivision_name, garage_spaces_x10, '
         || 'stories_x10, pool_private, size_source, is_lease, avm_display_allowed, address_key, mls_normalize_version',
         $s$'T-1001', 41250000, current_date - 20, current_date - 50, 42500000, 1500000, ARRAY['standard','short_sale','reo','auction','probate','other'],
         31, 32776500, -79931100, 1600, 8712, 'Marsh Point', 25, 15, true, 'BuildingAreaTotal', false, true, '8 tern pl|29900|sc', 2$s$));
  IF r <> 'OK' THEN f := f || ('a full closed sale: ' || r); END IF;
  IF NOT EXISTS (SELECT 1 FROM listings WHERE mls_number = 'T-1001' AND stories_x10 = 15 AND garage_spaces_x10 = 25
                    AND geo_cell = ((floor(32776500 / 14493.0) + 6300) * 25000 + (floor(-79931100 / 14493.0) + 12500))::integer) THEN
    f := f || 'the full closed sale does not read back with 1.5 stories, 2.5 garage spaces and its cell'::text;
  END IF;
  r := pg_temp.try(format(base, 'mls_number, year_built', $s$'T-1002', 2100$s$));
  IF r <> 'OK' THEN f := f || ('year built 2100: ' || r); END IF;
  -- a listing without coordinates has no cell; the defaults never allow automated valuations and never call it a lease
  r := pg_temp.try(format(base, 'mls_number', $s$'T-1003'$s$));
  IF r <> 'OK' THEN f := f || ('a bare listing: ' || r); END IF;
  IF NOT EXISTS (SELECT 1 FROM listings WHERE mls_number = 'T-1003' AND geo_cell IS NULL AND latitude_e6 IS NULL AND sale_conditions = '{}'
                    AND NOT is_lease AND NOT avm_display_allowed AND mls_normalize_version = 1 AND close_price_cents IS NULL
                    AND address_key IS NULL) THEN
    f := f || 'the bare listing''s defaults: no cell, no conditions, not a lease, AVM display not allowed, normalize version 1'::text;
  END IF;
  -- the cell follows the coordinates, and clears with them
  r := pg_temp.rows($q$UPDATE listings SET latitude_e6 = -1, longitude_e6 = -1 WHERE mls_number = 'T-1003'$q$);
  IF r <> '1' OR (SELECT geo_cell FROM listings WHERE mls_number = 'T-1003') <> (6299 * 25000 + 12499) THEN
    f := f || ('the cell of (-1, -1) µ°: ' || r);
  END IF;
  r := pg_temp.rows($q$UPDATE listings SET latitude_e6 = NULL, longitude_e6 = NULL WHERE mls_number = 'T-1003'$q$);
  IF r <> '1' OR (SELECT geo_cell FROM listings WHERE mls_number = 'T-1003') IS NOT NULL THEN f := f || ('clearing the coordinates: ' || r); END IF;
  PERFORM pg_temp.check(f,
    'R-CMA-1: the listings sale and property columns hold their bounds: coordinates in microdegrees within +-90/+-180 and '
    || 'set as a pair, sale conditions from the vocabulary (never null), non-negative money, days, lot, garage and stories '
    || '(tenths: 1.5 stories kept), year built 1600-2100, geo_cell generated and never written; the defaults never allow '
    || 'automated valuations');
END $$;

-- a person never writes them: not on a team listing they store or own, and not by relabelling an MLS row as a team one
DO $$
DECLARE f text[] := '{}'; r text; ins text; v record;
  sets text[] := ARRAY['close_price_cents = 41250000', 'close_date = current_date', 'purchase_contract_date = current_date',
    'original_list_price_cents = 1', 'concessions_cents = 1', $s$sale_conditions = ARRAY['standard']$s$, 'days_on_market = 3',
    'latitude_e6 = 1, longitude_e6 = 1', 'year_built = 1990', 'lot_sqft = 100', $s$subdivision_name = 'Marsh Point'$s$,
    'garage_spaces_x10 = 20', 'stories_x10 = 10', 'pool_private = false', $s$size_source = 'LivingArea'$s$, 'is_lease = true',
    'avm_display_allowed = true', $s$address_key = '12 harbor way|29900|sc'$s$, 'mls_normalize_version = 2'];
  s text;
BEGIN
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
  ins := $q$INSERT INTO listings (tenant_id, id, source, status, address_line1, city, region, postal_code, listing_agent_user_id, %s)
             VALUES (app.tenant_id(), gen_random_uuid(), 'team', 'active', '8 Tern Pl', 'Seaside', 'SC', '29900', app.user_id(), %s)$q$;
  FOREACH s IN ARRAY sets LOOP
    -- the insert form of the same assignment: "a = 1, b = 2" -> columns "a, b" and values "1, 2"
    r := pg_temp.try(format(ins, regexp_replace(s, ' = [^,]+', '', 'g'), regexp_replace(s, '[a-z_0-9]+ = ', '', 'g')));
    IF r !~ 'LISTING_VALUATION_FACTS_SYSTEM' THEN f := f || ('agent 1 stores a team listing with ' || s || ': ' || r); END IF;
    r := pg_temp.rows(format('UPDATE listings SET %s WHERE id = %L', s, pg_temp.id('lA')));
    IF r !~ 'LISTING_VALUATION_FACTS_SYSTEM' THEN f := f || ('agent 1 sets ' || s || ' on their team listing: ' || r); END IF;
  END LOOP;
  -- a person's team listing without them, and its other columns, are written as before
  r := pg_temp.try(format(ins, 'mls_number', $s$'T-2001'$s$));
  IF r <> 'OK' THEN f := f || ('agent 1 stores a plain team listing: ' || r); END IF;
  r := pg_temp.rows(format('UPDATE listings SET list_price_cents = 41000000, beds = 3, sqft = 1850 WHERE id = %L', pg_temp.id('lA')));
  IF r <> '1' THEN f := f || ('agent 1 edits their team listing''s price, beds and size: ' || r); END IF;
  -- the Owner (tenant-wide) is a person too
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('ownA'), 'user');
  r := pg_temp.rows(format('UPDATE listings SET avm_display_allowed = true WHERE id = %L', pg_temp.id('lA')));
  IF r !~ 'LISTING_VALUATION_FACTS_SYSTEM' THEN f := f || ('the Owner allows automated valuations on a team listing: ' || r); END IF;
  -- relabelling an MLS row as a team listing (0001's update policy admits the Team Lead and tenant-wide roles on MLS rows,
  -- and its WITH CHECK needs source = 'team'): refused, with or without new sale facts
  FOR v IN SELECT * FROM (VALUES ('tlA', ''), ('tlA', ', close_price_cents = 1, avm_display_allowed = true'), ('ownA', '')) AS t(who, extra) LOOP
    PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id(v.who), 'user');
    r := pg_temp.rows(format($q$UPDATE listings SET source = 'team', mls_connection_id = NULL, listing_agent_user_id = app.user_id()%s
                               WHERE id = %L$q$, v.extra, pg_temp.id('lM')));
    IF r !~ 'LISTING_MLS_ROW_SYSTEM_ONLY' THEN f := f || (v.who || ' relabels the MLS row' || v.extra || ': ' || r); END IF;
  END LOOP;
  -- the system (the MLS sync) writes them on its own row
  PERFORM pg_temp.ctx(pg_temp.id('tA'), NULL, 'system');
  r := pg_temp.rows(format($q$UPDATE listings SET close_price_cents = 41000000, avm_display_allowed = true, address_key = '14 harbor way|29900|sc',
         mls_normalize_version = 2 WHERE id = %L$q$, pg_temp.id('lM')));
  IF r <> '1' THEN f := f || ('the system fills the MLS row: ' || r); END IF;
  IF NOT EXISTS (SELECT 1 FROM listings WHERE id = pg_temp.id('lM') AND source = 'mls' AND mls_connection_id = pg_temp.id('mlsA')
                    AND close_price_cents = 41000000 AND avm_display_allowed)
     OR EXISTS (SELECT 1 FROM listings WHERE id = pg_temp.id('lA') AND (avm_display_allowed OR close_price_cents IS NOT NULL)) THEN
    f := f || 'the MLS row is not the system''s, or the team listing carries sale facts'::text;
  END IF;
  PERFORM pg_temp.check(f,
    'R-CMA-1 R-MLS-1: the sale and property facts (and avm_display_allowed, address_key, mls_normalize_version) are written '
    || 'by the MLS sync only: a person, the Owner included, never stores or changes them on a team listing '
    || '(LISTING_VALUATION_FACTS_SYSTEM) and never relabels an MLS row as a team listing (LISTING_MLS_ROW_SYSTEM_ONLY); the '
    || 'other team-listing columns are written as before');
END $$;

-- the price-history trigger fires only on a list-price change; the new columns are outside listings_mls_shape
DO $$
DECLARE f text[] := '{}'; r text; lid uuid; shape text;
BEGIN
  PERFORM pg_temp.ctx(pg_temp.id('tA'), NULL, 'system');
  SELECT id INTO lid FROM listings WHERE mls_number = 'T-1001';
  r := pg_temp.rows(format($q$UPDATE listings SET close_price_cents = 41000000, close_date = current_date - 19, days_on_market = 32,
         original_list_price_cents = 43000000 WHERE id = %L$q$, lid));
  IF r <> '1' THEN f := f || ('a sale update: ' || r); END IF;
  IF EXISTS (SELECT 1 FROM listing_price_history WHERE listing_id = lid) THEN f := f || 'a sale update wrote price history'::text; END IF;
  r := pg_temp.rows(format($q$UPDATE listings SET list_price_cents = 42000000 WHERE id = %L$q$, lid));
  IF r <> '1' OR (SELECT count(*) FROM listing_price_history WHERE listing_id = lid) <> 1 THEN f := f || ('a list-price update: ' || r); END IF;
  SELECT pg_get_constraintdef(c.oid) INTO shape FROM pg_constraint c WHERE c.conrelid = 'public.listings'::regclass AND c.conname = 'listings_mls_shape';
  IF shape IS NULL OR shape ~ 'close_|latitude|longitude|geo_cell|sale_conditions|address_key|avm_display|is_lease|normalize' THEN
    f := f || ('listings_mls_shape: ' || COALESCE(shape, 'missing'));
  END IF;
  PERFORM pg_temp.check(f,
    'R-CMA-1 R-MLS-1: writing sale facts writes no price history (the 0001 trigger fires on a list-price change only), and '
    || 'the new columns stay out of listings_mls_shape');
END $$;

-- =============================================================================
-- 9. integration_connections: the backfill state (F14), written by the MLS sync (the system actor) only
-- =============================================================================
DO $$
DECLARE f text[] := '{}'; r text; c2 uuid := gen_random_uuid(); feed uuid := pg_temp.id('mlsA');
BEGIN
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('ownA'), 'user');
  r := pg_temp.try(format($q$INSERT INTO integration_connections (tenant_id, id, kind, display_name) VALUES (app.tenant_id(), %L, 'mls_feed', 'MLS feed 2')$q$, c2));
  IF r <> 'OK' THEN f := f || ('the Owner adds an unconfigured MLS feed: ' || r); END IF;
  IF NOT EXISTS (SELECT 1 FROM integration_connections WHERE id = c2 AND NOT mls_backfill_pending AND mls_backfill_cursor IS NULL) THEN
    f := f || 'defaults: not pending, no cursor'::text;
  END IF;
  r := pg_temp.rows(format($q$UPDATE integration_connections SET display_name = 'MLS feed (renamed)' WHERE id = %L$q$, c2));
  IF r <> '1' THEN f := f || ('the Owner renames the feed: ' || r); END IF;
  -- the Owner never writes the backfill state
  r := pg_temp.try($q$INSERT INTO integration_connections (tenant_id, id, kind, display_name, mls_backfill_pending)
                      VALUES (app.tenant_id(), gen_random_uuid(), 'mls_feed', 'MLS feed 3', true)$q$);
  IF r !~ 'CONNECTION_BACKFILL_SYSTEM' THEN f := f || ('the Owner adds a feed with a pending backfill: ' || r); END IF;
  r := pg_temp.try($q$INSERT INTO integration_connections (tenant_id, id, kind, display_name, mls_backfill_pending, mls_backfill_cursor)
                      VALUES (app.tenant_id(), gen_random_uuid(), 'mls_feed', 'MLS feed 4', true, '2026-11-01T00:00:00Z|L-1')$q$);
  IF r !~ 'CONNECTION_BACKFILL_SYSTEM' THEN f := f || ('the Owner adds a feed with a backfill cursor: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE integration_connections SET mls_backfill_pending = true WHERE id = %L$q$, c2));
  IF r !~ 'CONNECTION_BACKFILL_SYSTEM' THEN f := f || ('the Owner starts a backfill: ' || r); END IF;
  -- the system starts one, with its cursor; a cursor exists only while a backfill is pending
  PERFORM pg_temp.ctx(pg_temp.id('tA'), NULL, 'system');
  r := pg_temp.try($q$INSERT INTO integration_connections (tenant_id, id, kind, display_name, mls_backfill_cursor)
                      VALUES (app.tenant_id(), gen_random_uuid(), 'mls_feed', 'MLS feed 5', '2026-11-01T00:00:00Z|L-1')$q$);
  IF r !~ 'integration_connections_backfill_cursor_pending' THEN f := f || ('a cursor without a pending backfill: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE integration_connections SET mls_backfill_pending = true, mls_backfill_cursor = '2026-11-01T00:00:00Z|L-1' WHERE id = %L$q$, feed));
  IF r <> '1' THEN f := f || ('the system starts a backfill with its cursor: ' || r); END IF;
  -- the Owner moves neither the cursor nor the end
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('ownA'), 'user');
  r := pg_temp.rows(format($q$UPDATE integration_connections SET mls_backfill_cursor = '2020-01-01T00:00:00Z|L-0' WHERE id = %L$q$, feed));
  IF r !~ 'CONNECTION_BACKFILL_SYSTEM' THEN f := f || ('the Owner moves the cursor: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE integration_connections SET mls_backfill_pending = false, mls_backfill_cursor = NULL WHERE id = %L$q$, feed));
  IF r !~ 'CONNECTION_BACKFILL_SYSTEM' THEN f := f || ('the Owner ends the backfill: ' || r); END IF;
  PERFORM pg_temp.ctx(pg_temp.id('tA'), NULL, 'system');
  r := pg_temp.rows(format($q$UPDATE integration_connections SET mls_backfill_pending = false WHERE id = %L$q$, feed));
  IF r !~ 'integration_connections_backfill_cursor_pending' THEN f := f || ('ending the backfill but keeping the cursor: ' || r); END IF;
  r := pg_temp.rows(format($q$UPDATE integration_connections SET mls_backfill_pending = false, mls_backfill_cursor = NULL WHERE id = %L$q$, feed));
  IF r <> '1' THEN f := f || ('the system ends the backfill: ' || r); END IF;
  PERFORM pg_temp.check(f,
    'R-CMA-1 (F14): integration_connections carries the backfill state, written by the MLS sync only: the Owner adds and '
    || 'renames a feed but never starts, moves or ends a backfill (CONNECTION_BACKFILL_SYSTEM); a cursor exists only while a '
    || 'backfill is pending');
END $$;
-- the migration that starts the backfill (lane V1-A's, run as the table owner) may set it, whatever the session's actor
SELECT pg_temp.ctx(:tA, :ownA, 'user');
RESET ROLE;
SELECT pg_temp.ok(
  pg_temp.rows(format($q$UPDATE public.integration_connections SET mls_backfill_pending = true, mls_backfill_cursor = NULL WHERE tenant_id = %L AND kind = 'mls_feed'$q$, :tA)) = '2'
  AND pg_temp.rows(format($q$UPDATE public.integration_connections SET mls_backfill_pending = false WHERE tenant_id = %L AND kind = 'mls_feed'$q$, :tA)) = '2',
  'R-CMA-1 (F14): the table owner (a migration) starts and clears the backfill state');
SET LOCAL ROLE app_user;

-- =============================================================================
-- 10. The platform:cma pack (R-CMA-7, the pack part; R-INT-6)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(
  (SELECT count(*) FROM jurisdiction_packs WHERE key = 'platform:cma') = 1
  AND EXISTS (SELECT 1 FROM jurisdiction_packs WHERE key = 'platform:cma' AND version = '2026.11.0' AND status = 'published'
                 AND reviewed_by_counsel_at IS NULL AND rules = '{}'::jsonb AND notes LIKE '%VERIFY WITH COUNSEL.'
                 AND notes LIKE 'Client CMAs and seller-update value ranges%')
  AND NOT app.platform_cleared('platform:cma') AND NOT app.platform_cleared('platform:avm'),
  'R-CMA-7 R-INT-6: platform:cma ships published and unreviewed (2026.11.0, no rules), so app.platform_cleared(''platform:cma'') '
  || 'is false; platform:avm is unchanged and uncleared');
SELECT pg_temp.ok(pg_temp.try($q$UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:cma'$q$) ~ 'permission denied',
  'R-INT-6: app_user cannot mark platform:cma reviewed');

SELECT pg_temp.ok(true, 'ALL CMA S0 SMOKE CHECKS PASSED');
ROLLBACK;
