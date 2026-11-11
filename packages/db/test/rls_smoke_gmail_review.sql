-- =============================================================================
-- Smoke proof of the D2 review fixes: the migration after the D2 one that hardens its Gmail and Meta objects
-- (findings "D2 review #1".."#6", named in the check text; docs/PHASE2_3_PLAN.md §4.1):
--   #1 consent_events_synced_gmail accepts the wrong_number revoke platform email writes (R-GMAIL-9, R-PAR-12);
--   #2 app.resolve_channel_account no longer routes ads_meta (R-TEN-11);
--   #3 app.mail_copy_live answers only callers the mail_messages read policies admit (R-GMAIL-6);
--   #4 only the system sets messages.rfc_message_id_sha256, once (R-GMAIL-12);
--   #5 mail_messages_select tests the mailbox link first, with the same rows (R-GMAIL-6, PERFORMANCE §5);
--   #6 the platform:gmail notes state the rollout precondition of the Gmail dedupe (R-GMAIL-12, E201).
-- Same shape as rls_smoke_gmail.sql: ONE transaction, rolled back; every application step runs as app_user;
-- platform maintenance steps (clearing platform:gmail, the reference rows of #5) run as the owner role between
-- RESET ROLE and SET LOCAL ROLE. Run by packages/db/test/rls_smoke_gmail_review.test.ts.
--
-- Every PASS line below depends on the fix it names: each was run against a database without the fix and failed
-- there. To repeat that, replace the RAISE EXCEPTION in pg_temp.fail with RAISE NOTICE (every check then runs to
-- the end and reports FAIL instead of stopping) and run the script against a clone of the template built before
-- the fix. Steps whose outcome depends on a fix go through pg_temp.try, so no fixture step fails there.
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
-- the system's synced copy of one Gmail message for one contact point (the columns module 68 writes)
CREATE FUNCTION pg_temp.copy_sql(p_id uuid, p_link uuid, p_contact uuid, p_point uuid, p_address text, p_msg text, p_thread text,
                                 p_rfc text DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT format($q$INSERT INTO mail_messages (tenant_id, id, link_id, contact_id, contact_point_id, contact_address_hmac,
    gmail_message_id, gmail_thread_id, rfc_message_id_sha256, sender, contact_role, other_recipient_count, subject, body,
    internal_at, origin) VALUES (app.tenant_id(), %L, %L, %L, %L, digest(%L, 'sha256'), %L, %L, %s, 'contact', 'from', 1,
    'Re: the Oak St house', 'Can we see it Saturday?', now(), 'live')$q$,
    p_id, p_link, p_contact, p_point, p_address, p_msg, p_thread,
    CASE WHEN p_rfc IS NULL THEN 'NULL' ELSE format('digest(%L, ''sha256'')', p_rfc) END)
$$;
-- the OAuth callback's link row (system actor)
CREATE FUNCTION pg_temp.link_sql(p_id uuid, p_user uuid, p_address text) RETURNS text LANGUAGE sql AS $$
  SELECT format($q$INSERT INTO user_mail_links (tenant_id, id, user_id, provider, mailbox_address, mailbox_address_hmac, scopes,
    disclosure_sha256, status, refresh_enc, key_version, connected_at) VALUES (app.tenant_id(), %L, %L, 'gmail', %L,
    digest(lower(%L), 'sha256'), ARRAY['https://www.googleapis.com/auth/gmail.readonly'], repeat('cd', 32), 'connected', '\x01', 1, now())$q$,
    p_id, p_user, p_address, p_address)
$$;
-- one consent event as module 68 (system) or a person would write it; the current context's tenant and user
CREATE FUNCTION pg_temp.event_sql(p_id uuid, p_address text, p_address_kind text, p_channel text, p_type text, p_level text,
                                  p_purpose text, p_source text, p_actor text, p_evidence jsonb,
                                  p_evidence_message uuid DEFAULT NULL, p_reverts uuid DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT format($q$INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose, event_type,
    consent_level, source, occurred_at, actor_kind, actor_user_id, evidence, evidence_message_id, reverts_event_id)
    VALUES (app.tenant_id(), %L, %L, digest(%L, 'sha256'), 'x•••', %L, %L, %L, %L, %L, now(), %L, %L, %L::jsonb, %L, %L)$q$,
    p_id, p_address_kind, p_address, p_channel, p_purpose, p_type, p_level, p_source, p_actor,
    CASE WHEN p_actor = 'user' THEN app.user_id() END, p_evidence, p_evidence_message, p_reverts)
$$;
-- an email a person writes as themselves (outbound, through the team identity), optionally carrying a Message-ID hash
CREATE FUNCTION pg_temp.email_sql(p_id uuid, p_user uuid, p_status text, p_rfc text) RETURNS text LANGUAGE sql AS $$
  SELECT format($q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, email_identity_id, from_address,
    to_address, subject, body, status, initiator, initiated_by_user_id, purpose, occurred_at, scheduled_for, rfc_message_id_sha256)
    VALUES (app.tenant_id(), %L, %L, %L, 'email', 'outbound', %L, 'team@a-realty.test', 'alice@example.test', 'Saturday', 'See you then',
    %L, 'human', %L, 'informational', now(), %s, %s)$q$,
    p_id, pg_temp.id('cv1'), pg_temp.id('c1'), pg_temp.id('eid'), p_status, p_user,
    CASE WHEN p_status = 'scheduled' THEN $s$now() + interval '1 day'$s$ ELSE 'NULL' END,
    CASE WHEN p_rfc IS NULL THEN 'NULL' ELSE format('digest(%L, ''sha256'')', p_rfc) END)
$$;
-- a client's email received by platform inbound (the system), optionally carrying its Message-ID hash
CREATE FUNCTION pg_temp.inbound_sql(p_id uuid, p_rfc text) RETURNS text LANGUAGE sql AS $$
  SELECT format($q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body,
    status, initiator, occurred_at, rfc_message_id_sha256) VALUES (app.tenant_id(), %L, %L, %L, 'email', 'inbound', 'alice@example.test',
    'r+token@in.example.test', 'Reply-all: Saturday works', 'received', 'client', now(), %s)$q$,
    p_id, pg_temp.id('cv1'), pg_temp.id('c1'),
    CASE WHEN p_rfc IS NULL THEN 'NULL' ELSE format('digest(%L, ''sha256'')', p_rfc) END)
$$;

-- the copies of tenant A the fixture stores (by name m1..m9), sorted
CREATE FUNCTION pg_temp.all_copies() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(id ORDER BY id), '{}') FROM pg_temp.fx WHERE name ~ '^m[0-9]$'
$$;
-- tenant A copies the current context can SELECT, sorted
CREATE FUNCTION pg_temp.copies_seen() RETURNS uuid[] LANGUAGE sql AS $$
  SELECT COALESCE(array_agg(id ORDER BY id), '{}') FROM mail_messages WHERE tenant_id = pg_temp.id('tA')
$$;
-- tenant A copies for which app.mail_copy_live, called directly in the current context, is true, sorted
CREATE FUNCTION pg_temp.copies_live() RETURNS uuid[] LANGUAGE sql AS $$
  SELECT COALESCE(array_agg(c ORDER BY c), '{}') FROM unnest(pg_temp.all_copies()) c WHERE app.mail_copy_live(pg_temp.id('tA'), c)
$$;
-- #5: every copy with its liveness under the D2 migration's own copy check, filled by the owner role
CREATE TEMP TABLE eq_rows (tenant_id uuid, id uuid, contact_id uuid, link_id uuid, live boolean) ON COMMIT DROP;

\set tA     '''a0000000-0000-7000-8000-000000000001'''
\set tB     '''b0000000-0000-7000-8000-000000000001'''
\set ownA   '''a0000000-0000-7000-8000-0000000000a0'''
\set agA1   '''a0000000-0000-7000-8000-0000000000a1'''
\set agA2   '''a0000000-0000-7000-8000-0000000000a2'''
\set tlA    '''a0000000-0000-7000-8000-0000000000a3'''
\set agA3   '''a0000000-0000-7000-8000-0000000000a4'''
\set admA   '''a0000000-0000-7000-8000-0000000000ad'''
\set ownB   '''b0000000-0000-7000-8000-0000000000b0'''
\set supU   '''00000000-0000-7000-8000-00000000ffff'''
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
\set p1     '''a0000000-0000-7000-8000-00000000f101'''
\set pW     '''a0000000-0000-7000-8000-00000000f102'''
\set p2     '''a0000000-0000-7000-8000-00000000f201'''
\set p3     '''a0000000-0000-7000-8000-00000000f301'''
\set p4     '''a0000000-0000-7000-8000-00000000f401'''
\set p5     '''a0000000-0000-7000-8000-00000000f501'''
\set p6     '''a0000000-0000-7000-8000-00000000f601'''
\set pB     '''b0000000-0000-7000-8000-00000000f101'''
\set lk1    '''a0000000-0000-7000-8000-0000000071a1'''
\set lk2    '''a0000000-0000-7000-8000-0000000071a2'''
\set lkB    '''b0000000-0000-7000-8000-0000000071b0'''
\set m1     '''a0000000-0000-7000-8000-000000007101'''
\set m2     '''a0000000-0000-7000-8000-000000007102'''
\set m3     '''a0000000-0000-7000-8000-000000007103'''
\set m4     '''a0000000-0000-7000-8000-000000007104'''
\set m5     '''a0000000-0000-7000-8000-000000007105'''
\set m6     '''a0000000-0000-7000-8000-000000007106'''
\set m7     '''a0000000-0000-7000-8000-000000007107'''
\set m8     '''a0000000-0000-7000-8000-000000007108'''
\set m9     '''a0000000-0000-7000-8000-000000007109'''
\set mB     '''b0000000-0000-7000-8000-000000007101'''
\set cv1    '''a0000000-0000-7000-8000-00000000cc01'''
\set eid    '''a0000000-0000-7000-8000-00000000ee01'''
\set deal   '''a0000000-0000-7000-8000-00000000de01'''
\set credA  '''a0000000-0000-7000-8000-00000000cd01'''
\set srcA   '''a0000000-0000-7000-8000-000000005001'''
\set PH     '''$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA'''
INSERT INTO pg_temp.fx (name, id) VALUES
  ('tA', :tA), ('tB', :tB), ('ownA', :ownA), ('agA1', :agA1), ('agA2', :agA2), ('tlA', :tlA), ('agA3', :agA3), ('admA', :admA),
  ('ownB', :ownB), ('supU', :supU), ('c1', :c1), ('c5', :c5), ('c6', :c6), ('p1', :p1), ('p6', :p6), ('lk1', :lk1), ('lk2', :lk2),
  ('m1', :m1), ('m2', :m2), ('m3', :m3), ('m4', :m4), ('m5', :m5), ('m6', :m6), ('m7', :m7), ('m8', :m8), ('m9', :m9), ('mB', :mB),
  ('cv1', :cv1), ('eid', :eid), ('credA', :credA), ('srcA', :srcA),
  ('ev0', 'a0000000-0000-7000-8000-00000000ce70'), ('ev1', 'a0000000-0000-7000-8000-00000000ce71'),
  ('ev2', 'a0000000-0000-7000-8000-00000000ce72'), ('ev3', 'a0000000-0000-7000-8000-00000000ce73'),
  ('msgTL', 'a0000000-0000-7000-8000-00000000ab01'), ('msgTL0', 'a0000000-0000-7000-8000-00000000ab02'),
  ('msgA1', 'a0000000-0000-7000-8000-00000000ab03'), ('msgOwn', 'a0000000-0000-7000-8000-00000000ab04'),
  ('msgIn', 'a0000000-0000-7000-8000-00000000ab05');

-- =============================================================================
-- 0. Fixture. Tenant A: an Owner, an Admin, a Team Lead (team: agent 1) and three agents; a platform support user
--    with an Owner grant; tenant B with its Owner. Agent 1 owns Alice (two addresses), Dora, Erin and Gail; agent 2
--    owns Finn and a duplicate of Alice with Alice's address (the peer); agent 3 collaborates on Alice and is a deal
--    member on Finn. Gmail sync cleared and on; agent 1 and agent 2 link their mailboxes and confirm their clients.
--    Then agent 1 removes thread t2, stops syncing Alice's work address, releases Erin to the pond, and the Owner
--    reassigns Dora to agent 3.
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
  (:tA, 'a0000000-0000-7000-8000-0000000001a1', 'agent1@example.test', 'agent', digest('rv-invite-a1', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a0000000-0000-7000-8000-0000000001a2', 'agent2@example.test', 'agent', digest('rv-invite-a2', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a0000000-0000-7000-8000-0000000001a4', 'agent3@example.test', 'agent', digest('rv-invite-a4', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a0000000-0000-7000-8000-0000000001a3', 'lead@example.test', 'team_lead', digest('rv-invite-a3', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a0000000-0000-7000-8000-0000000001ad', 'admin@example.test', 'admin', digest('rv-invite-ad', 'sha256'), :ownA, now() + interval '1 day');
SELECT pg_temp.ctx(NULL, NULL, NULL);
SELECT FROM auth.accept_invite(digest('rv-invite-a1', 'sha256'), :agA1, 'Ava Agent', :PH, now());
SELECT FROM auth.accept_invite(digest('rv-invite-a2', 'sha256'), :agA2, 'Ben Agent', :PH, now());
SELECT FROM auth.accept_invite(digest('rv-invite-a4', 'sha256'), :agA3, 'Cleo Agent', :PH, now());
SELECT FROM auth.accept_invite(digest('rv-invite-a3', 'sha256'), :tlA, 'Tess Lead', :PH, now());
SELECT FROM auth.accept_invite(digest('rv-invite-ad', 'sha256'), :admA, 'Adam Admin', :PH, now());
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO team_members (tenant_id, team_id, user_id, is_lead) VALUES (:tA, :teamA, :tlA, true), (:tA, :teamA, :agA1, false);
INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, expires_at)
VALUES (:tA, gen_random_uuid(), :supU, :ownA, 'Ticket 5120: timeline question', now() + interval '2 hours');
INSERT INTO email_identities (tenant_id, id, from_address, display_name) VALUES (:tA, :eid, 'team@a-realty.test', 'Team A');

SELECT pg_temp.self_create(:tA, :c1, :agA1, 'Alice Buyer', 'a0000000-0000-7000-8000-0000000c0001');
SELECT pg_temp.self_create(:tA, :c3, :agA1, 'Dora Buyer', 'a0000000-0000-7000-8000-0000000c0003');
SELECT pg_temp.self_create(:tA, :c4, :agA1, 'Erin Prospect', 'a0000000-0000-7000-8000-0000000c0004');
SELECT pg_temp.self_create(:tA, :c6, :agA1, 'Gail Seller', 'a0000000-0000-7000-8000-0000000c0006');
SELECT pg_temp.self_create(:tA, :c2, :agA2, 'Alice B. (duplicate)', 'a0000000-0000-7000-8000-0000000c0002');
SELECT pg_temp.self_create(:tA, :c5, :agA2, 'Finn Buyer', 'a0000000-0000-7000-8000-0000000c0005');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac) VALUES
  (:tA, :p1, :c1, 'email', 'alice@example.test', digest('alice@example.test', 'sha256')),
  (:tA, :pW, :c1, 'email', 'alice.work@example.test', digest('alice.work@example.test', 'sha256')),
  (:tA, :p3, :c3, 'email', 'dora@example.test', digest('dora@example.test', 'sha256')),
  (:tA, :p4, :c4, 'email', 'erin@example.test', digest('erin@example.test', 'sha256')),
  (:tA, :p6, :c6, 'email', 'gail@example.test', digest('gail@example.test', 'sha256'));
INSERT INTO conversations (tenant_id, id, contact_id) VALUES (:tA, :cv1, :c1);
SELECT pg_temp.ctx(:tA, :agA2, 'user');
INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac) VALUES
  (:tA, :p2, :c2, 'email', 'alice@example.test', digest('alice@example.test', 'sha256')),
  (:tA, :p5, :c5, 'email', 'finn@example.test', digest('finn@example.test', 'sha256'));
SELECT pg_temp.self_create(:tB, :cB, :ownB, 'Bob Seller', 'b0000000-0000-7000-8000-0000000c0001');
INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
VALUES (:tB, :pB, :cB, 'email', 'bob@example.test', digest('bob@example.test', 'sha256'));

-- Gmail sync: counsel review and the vendor check (platform maintenance), then each Owner's switch
RESET ROLE;
UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now(), rules = rules || '{"vendor_ready_at": "2026-11-01T00:00:00Z"}'
 WHERE key = 'platform:gmail' AND status = 'published';
SET LOCAL ROLE app_user;
SELECT pg_temp.ctx(:tA, :ownA, 'user');
UPDATE tenant_settings SET mail_sync_enabled = true;
SELECT pg_temp.ctx(:tB, :ownB, 'user');
UPDATE tenant_settings SET mail_sync_enabled = true;
-- the OAuth callbacks link the mailboxes; each mailbox owner confirms their clients' addresses
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.try(pg_temp.link_sql(:lk1, :agA1, 'ava@gmail.test')) || pg_temp.try(pg_temp.link_sql(:lk2, :agA2, 'ben@gmail.test'));
SELECT pg_temp.ctx(:tB, NULL, 'system');
SELECT pg_temp.try(pg_temp.link_sql(:lkB, :ownB, 'oscar@gmail.test'));
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO mail_sync_points (tenant_id, link_id, contact_point_id, contact_id) VALUES
  (:tA, :lk1, :p1, :c1), (:tA, :lk1, :pW, :c1), (:tA, :lk1, :p3, :c3), (:tA, :lk1, :p4, :c4), (:tA, :lk1, :p6, :c6);
SELECT pg_temp.ctx(:tA, :agA2, 'user');
INSERT INTO mail_sync_points (tenant_id, link_id, contact_point_id, contact_id) VALUES (:tA, :lk2, :p5, :c5);
SELECT pg_temp.ctx(:tB, :ownB, 'user');
INSERT INTO mail_sync_points (tenant_id, link_id, contact_point_id, contact_id) VALUES (:tB, :lkB, :pB, :cB);
-- module 68 stores the copies
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.try(pg_temp.copy_sql(:m1, :lk1, :c1, :p1, 'alice@example.test', 'g1', 't1'))
    || pg_temp.try(pg_temp.copy_sql(:m2, :lk1, :c1, :p1, 'alice@example.test', 'g2', 't2'))
    || pg_temp.try(pg_temp.copy_sql(:m3, :lk1, :c1, :pW, 'alice.work@example.test', 'g3', 't3'))
    || pg_temp.try(pg_temp.copy_sql(:m4, :lk1, :c3, :p3, 'dora@example.test', 'g4', 't4'))
    || pg_temp.try(pg_temp.copy_sql(:m5, :lk1, :c4, :p4, 'erin@example.test', 'g5', 't5'))
    || pg_temp.try(pg_temp.copy_sql(:m6, :lk2, :c5, :p5, 'finn@example.test', 'h1', 'u1'))
    || pg_temp.try(pg_temp.copy_sql(:m7, :lk1, :c6, :p6, 'gail@example.test', 'g7', 't7'));
SELECT pg_temp.ctx(:tB, NULL, 'system');
SELECT pg_temp.try(pg_temp.copy_sql(:mB, :lkB, :cB, :pB, 'bob@example.test', 'b1', 'bt1'));
-- agent 3 collaborates on Alice and is a deal member on Finn's purchase
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO contact_collaborators (tenant_id, contact_id, user_id, role, added_by_user_id) VALUES (:tA, :c1, :agA3, 'co_agent', :agA1);
SELECT pg_temp.ctx(:tA, :agA2, 'user');
INSERT INTO deals (tenant_id, id, name, side, stage_entered_at, primary_contact_id, owner_user_id, created_by_user_id)
VALUES (:tA, :deal, 'Finn purchase', 'buy', now(), :c5, :agA2, :agA2);
INSERT INTO deal_members (tenant_id, deal_id, user_id, role) VALUES (:tA, :deal, :agA3, 'co_agent');
-- agent 1 removes thread t2 (R-GMAIL-7) and stops syncing Alice's work address (S-D2-2): m2 and m3 are hidden
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO mail_thread_exclusions (tenant_id, link_id, gmail_thread_id) VALUES (:tA, :lk1, 't2');
DELETE FROM mail_sync_points WHERE link_id = :lk1 AND contact_point_id = :pW;
-- agent 1 releases Erin to the team pond (her copy m5 stays: agent 1 reads it through the link, the TL through the
-- timeline; a pond member sees only her pond card)
SELECT pg_temp.cmd('a0000000-0000-7000-8000-0000000c0040');
INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, prev_owner_user_id, pond_id,
       actor_kind, actor_user_id, reason_code, command_id, occurred_at)
VALUES (:tA, :c4, 2, gen_random_uuid(), 'released', 'owned', 'in_pond', :agA1, :pondA, 'user', :agA1, 'NOT_A_FIT',
        'a0000000-0000-7000-8000-0000000c0040', now());
UPDATE contacts SET ownership_state = 'in_pond', owner_user_id = NULL, owned_at = NULL, ownership_period_seq = NULL,
       pond_id = :pondA, ownership_seq = 2, ownership_command_id = 'a0000000-0000-7000-8000-0000000c0040', ownership_actor_user_id = :agA1
 WHERE tenant_id = :tA AND id = :c4 AND ownership_seq = 1;
SELECT pg_temp.cmd(NULL);
-- the Owner reassigns Dora from agent 1 to agent 3 (E216: agent 1 keeps reading their own copy m4 through the link)
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.cmd('a0000000-0000-7000-8000-0000000c0030');
INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, owner_user_id,
       prev_owner_user_id, actor_kind, actor_user_id, reason_code, command_id, occurred_at)
VALUES (:tA, :c3, 2, gen_random_uuid(), 'reassigned', 'owned', 'owned', :agA3, :agA1, 'user', :ownA, 'EXCEPTION_QUEUE',
        'a0000000-0000-7000-8000-0000000c0030', now());
UPDATE contacts SET owner_user_id = :agA3, owned_at = now(), first_touch_due_at = NULL, release_due_at = NULL,
       inactivity_warn_at = NULL, inactivity_release_at = NULL, ownership_period_seq = 2, ownership_seq = 2,
       ownership_command_id = 'a0000000-0000-7000-8000-0000000c0030', ownership_actor_user_id = :ownA
 WHERE tenant_id = :tA AND id = :c3 AND ownership_seq = 1;
SELECT pg_temp.cmd(NULL);
-- a platform email opt-out for another address (no Gmail citation), for the import-revert attempt in #1
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.try(pg_temp.event_sql(pg_temp.id('ev0'), 'henry@example.test', 'email', 'email', 'revoke', 'none', 'all',
                                     'inbound_keyword', 'system', '{"matched": "UNSUBSCRIBE"}'));
-- the fixture holds before any check (an error here is a broken fixture, not a failed check)
DO $$
BEGIN
  PERFORM pg_temp.ctx(pg_temp.id('tA'), NULL, 'system');
  IF (SELECT count(*) FROM mail_messages) <> 7 OR (SELECT count(*) FROM user_mail_links) <> 2
     OR (SELECT count(*) FROM consent_events WHERE id = pg_temp.id('ev0')) <> 1 THEN
    RAISE EXCEPTION 'FIXTURE: tenant A copies, links or the platform opt-out are missing';
  END IF;
  IF (SELECT owner_user_id FROM contacts WHERE id = 'a0000000-0000-7000-8000-00000000e003') IS DISTINCT FROM pg_temp.id('agA3')
     OR (SELECT ownership_state FROM contacts WHERE id = 'a0000000-0000-7000-8000-00000000e004') IS DISTINCT FROM 'in_pond' THEN
    RAISE EXCEPTION 'FIXTURE: Dora was not reassigned or Erin not released';
  END IF;
  PERFORM pg_temp.ctx(pg_temp.id('tB'), NULL, 'system');
  IF (SELECT count(*) FROM mail_messages) <> 1 THEN RAISE EXCEPTION 'FIXTURE: tenant B copy missing'; END IF;
END $$;

-- =============================================================================
-- 1. D2 review #1: synced Gmail records a wrong-number reply as platform email does; never lifts an opt-out
-- =============================================================================
DO $$
DECLARE f text[] := '{}'; r text; before_report text; after_report text; reason text;
        cite_copy jsonb := jsonb_build_object('kind', 'synced_gmail', 'mail_message_id', pg_temp.id('m7'), 'matched', 'wrong person');
        cite_ref jsonb := jsonb_build_object('kind', 'synced_gmail', 'matched', 'wrong person',
                                             'gmail_message_ref', encode(digest(pg_temp.id('lk1')::text || ':gX7', 'sha256'), 'hex'));
        removal text := format($q$UPDATE contact_points SET status = 'removed', removed_at = now(), removed_reason = 'wrong_number'
                                  WHERE id = %L$q$, pg_temp.id('p6'));
        refusal record;
BEGIN
  -- before any report, Gail's address cannot be removed as a confirmed wrong number (R-PAR-12)
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
  before_report := pg_temp.try(removal);
  -- module 68 finds "wrong person, please stop emailing me" from Gail in agent 1's Gmail: classifyInbound says
  -- wrong_number (checked before opt-out language), so it writes what platform email writes for that result
  PERFORM pg_temp.ctx(pg_temp.id('tA'), NULL, 'system');
  r := pg_temp.try(pg_temp.event_sql(pg_temp.id('ev1'), 'gail@example.test', 'email', 'email', 'revoke', 'none', 'all',
                                     'wrong_number', 'system', cite_copy));
  IF r <> 'OK' THEN f := f || ('wrong_number revoke citing the stored copy: ' || r); END IF;
  r := pg_temp.try(pg_temp.event_sql(pg_temp.id('ev2'), 'gail@example.test', 'email', 'email', 'revoke', 'none', 'all',
                                     'wrong_number', 'system', cite_ref));
  IF r <> 'OK' THEN f := f || ('wrong_number revoke citing an unstored message: ' || r); END IF;
  -- nothing that cites synced Gmail may lift an opt-out, or be anything but a cited system email revoke
  FOR refusal IN SELECT * FROM (VALUES
      ('a grant', pg_temp.event_sql(gen_random_uuid(), 'gail@example.test', 'email', 'email', 'grant', 'express', 'informational',
                                    'wrong_number', 'system', cite_copy)),
      ('a resubscribe', pg_temp.event_sql(gen_random_uuid(), '+15555550107', 'phone', 'sms', 'resubscribe', 'express', 'all',
                                          'inbound_keyword', 'system', cite_copy)),
      ('an import revert of an opt-out', pg_temp.event_sql(gen_random_uuid(), 'henry@example.test', 'email', 'email', 'import_revert',
                                          'none', 'all', 'wrong_number', 'system', cite_copy, NULL, pg_temp.id('ev0'))),
      ('an expiry', pg_temp.event_sql(gen_random_uuid(), 'gail@example.test', 'email', 'email', 'expire', 'none', 'all',
                                      'wrong_number', 'system', cite_copy)),
      ('an SMS revoke', pg_temp.event_sql(gen_random_uuid(), '+15555550107', 'phone', 'sms', 'revoke', 'none', 'all',
                                          'wrong_number', 'system', cite_copy)),
      ('a voice revoke', pg_temp.event_sql(gen_random_uuid(), '+15555550107', 'phone', 'voice', 'revoke', 'none', 'all',
                                           'wrong_number', 'system', cite_ref)),
      ('an evidence_message_id', pg_temp.event_sql(gen_random_uuid(), 'gail@example.test', 'email', 'email', 'revoke', 'none', 'all',
                                                   'wrong_number', 'system', cite_copy, gen_random_uuid())),
      ('both citations', pg_temp.event_sql(gen_random_uuid(), 'gail@example.test', 'email', 'email', 'revoke', 'none', 'all',
                                           'wrong_number', 'system', cite_copy || jsonb_build_object('gmail_message_ref', repeat('ab', 32)))),
      ('no citation', pg_temp.event_sql(gen_random_uuid(), 'gail@example.test', 'email', 'email', 'revoke', 'none', 'all',
                                        'wrong_number', 'system', '{"kind": "synced_gmail"}'))) v(what, stmt) LOOP
    r := pg_temp.try(refusal.stmt);
    IF r NOT LIKE '%consent_events_synced_gmail%' THEN f := f || (refusal.what || ' was not refused by the CHECK: ' || r); END IF;
  END LOOP;
  -- a person never writes an event that cites synced Gmail (the insert policy admits agent 1 as themselves)
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
  r := pg_temp.try(pg_temp.event_sql(gen_random_uuid(), 'gail@example.test', 'email', 'email', 'revoke', 'none', 'all',
                                     'wrong_number', 'user', cite_copy));
  IF r NOT LIKE '%consent_events_synced_gmail%' THEN f := f || ('a person''s event was not refused by the CHECK: ' || r); END IF;
  PERFORM pg_temp.check(f,
    'R-GMAIL-9 (D2 review #1): a wrong-number reply found in synced Gmail is recorded as platform email records it (a system email '
    || 'revoke, source wrong_number, citing the stored copy or the unstored message), and nothing citing synced Gmail lifts an '
    || 'opt-out: a grant, a resubscribe, an import revert and an expiry are refused, as are an SMS or voice revoke, a person''s '
    || 'event, an evidence_message_id, both citations and none');
  -- with that report in the ledger, agent 1 removes Gail's address as a confirmed wrong number (R-PAR-12)
  after_report := pg_temp.try(removal);
  reason := (SELECT removed_reason FROM contact_points WHERE id = pg_temp.id('p6'));
  PERFORM pg_temp.ok(before_report LIKE '%REMOVED_REASON_WRONG_NUMBER%' AND after_report = 'OK' AND reason = 'wrong_number',
    'R-PAR-12 R-GMAIL-9 (D2 review #1): with a wrong-number report from synced Gmail in the ledger the agent removes the address '
    || 'as a confirmed wrong number (refused before the report)');
END $$;

-- =============================================================================
-- 2. D2 review #2: the pre-tenant router never returns ads_meta (D2: no Meta ads); the other kinds still route
-- =============================================================================
SELECT pg_temp.ctx(:tA, NULL, 'system');
INSERT INTO provider_credentials (tenant_id, id, provider, secret_enc, key_version) VALUES (:tA, :credA, 'meta', '\x01', 1);
INSERT INTO lead_sources (tenant_id, id, name, kind) VALUES (:tA, :srcA, 'Partner feeds', 'portal');
-- the provider callback (system) connects one account of each kind
INSERT INTO integration_connections (tenant_id, id, kind, status, display_name, external_account_id, credential_id, lead_source_id, connected_at)
SELECT :tA, gen_random_uuid(), k.kind, k.status, 'Account ' || k.account, k.account, :credA, k.source, now()
  FROM (VALUES ('ads_meta', 'act_1', 'connected', NULL::uuid), ('ads_meta', 'act_2', 'degraded', NULL),
               ('zillow_feed', 'zf-1', 'connected', :srcA), ('realtor_feed', 'rf-1', 'connected', :srcA),
               ('mls_feed', 'mls-1', 'connected', NULL), ('showing_service', 'show-1', 'degraded', NULL),
               ('ads_google', 'g-1', 'connected', NULL), ('gbp_location', 'loc-1', 'connected', NULL),
               ('messenger_page', 'mp-1', 'connected', :srcA), ('facebook_page', 'fb-1', 'connected', NULL),
               ('instagram_business', 'ig-1', 'connected', NULL)) k(kind, account, status, source);
DO $$
DECLARE f text[] := '{}'; k record; n integer; ok_row boolean; d record;
BEGIN
  PERFORM pg_temp.ctx(NULL, NULL, NULL);    -- pre-tenant: no tenant, user or actor (the webhook router's context)
  FOR k IN SELECT * FROM (VALUES ('zillow_feed', 'zf-1'), ('realtor_feed', 'rf-1'), ('mls_feed', 'mls-1'),
                                 ('showing_service', 'show-1'), ('ads_google', 'g-1'), ('gbp_location', 'loc-1')) v(kind, account) LOOP
    SELECT count(*), bool_and(r.tenant_id = pg_temp.id('tA') AND r.connection_id IS NOT NULL) INTO n, ok_row
      FROM app.resolve_channel_account(k.kind, k.account) r;
    IF n <> 1 OR NOT ok_row THEN f := f || (k.kind || ' routes ' || n || ' rows'); END IF;
  END LOOP;
  FOR k IN SELECT * FROM (VALUES ('ads_meta', 'act_1'), ('ads_meta', 'act_2'), ('messenger_page', 'mp-1'),
                                 ('facebook_page', 'fb-1'), ('instagram_business', 'ig-1')) v(kind, account) LOOP
    SELECT count(*) INTO n FROM app.resolve_channel_account(k.kind, k.account);
    IF n <> 0 THEN f := f || (k.kind || ' ' || k.account || ' routes ' || n || ' rows'); END IF;
  END LOOP;
  SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.provolatile, p.proconfig,
         has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_exec, has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
    INTO d FROM pg_proc p WHERE p.oid = 'app.resolve_channel_account(text,text)'::regprocedure;
  IF d.owner <> 'app_definer' OR NOT d.prosecdef OR d.provolatile <> 's' OR d.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
     OR NOT d.app_user_exec OR d.public_exec THEN
    f := f || 'the resolver lost its reviewed owner, volatility, search_path or grants'::text;
  END IF;
  PERFORM pg_temp.check(f,
    'R-TEN-11 R-INT-3 (D2 review #2): a connected or degraded ads_meta account routes nothing (D2: no Meta ads), like every '
    || 'other Meta kind, while zillow_feed, realtor_feed, mls_feed, showing_service, ads_google and gbp_location still route '
    || 'to their one tenant; the resolver keeps owner app_definer, SECURITY DEFINER, STABLE, its pinned search_path and '
    || 'EXECUTE for app_user only');
END $$;

-- =============================================================================
-- 3. D2 review #3: app.mail_copy_live answers only callers the mail_messages read policies admit
-- =============================================================================
-- module 68 records an unsubscribe found in Alice's copy m1; the event's evidence names the copy, and every reader
-- of a contact point with Alice's address sees it (here: agent 2, through their duplicate contact)
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.try(pg_temp.event_sql(pg_temp.id('ev3'), 'alice@example.test', 'email', 'email', 'revoke', 'none', 'all',
                                     'inbound_keyword', 'system', jsonb_build_object('kind', 'synced_gmail', 'mail_message_id', :m1,
                                     'matched', 'UNSUBSCRIBE')));
DO $$
DECLARE f text[] := '{}'; held uuid; tA uuid := pg_temp.id('tA'); a record; d record;
BEGIN
  -- the peer: agent 2 holds the copy id from consent evidence, but reads no copy of Alice's and Erin's pond card only
  PERFORM pg_temp.ctx(tA, pg_temp.id('agA2'), 'user');
  held := (SELECT (evidence->>'mail_message_id')::uuid FROM consent_events WHERE id = pg_temp.id('ev3'));
  IF held IS DISTINCT FROM pg_temp.id('m1') OR (SELECT count(*) FROM mail_messages WHERE id IN (pg_temp.id('m1'), pg_temp.id('m5'))) <> 0 THEN
    f := f || 'fixture: the peer should see the copy id and no copy'::text;
  END IF;
  IF app.mail_copy_live(tA, held) OR app.mail_copy_live(tA, pg_temp.id('m5')) THEN
    f := f || 'the peer learns that agent 1''s copy is live'::text;
  END IF;
  -- support under the Owner's grant (it sees the consent event, being tenant-wide), a client principal, a staff session
  -- with no actor, and tenant B: false for every copy, live or hidden
  PERFORM pg_temp.ctx(tA, pg_temp.id('supU'), 'support');
  IF (SELECT count(*) FROM consent_events WHERE id = pg_temp.id('ev3')) <> 1 THEN f := f || 'fixture: support should see the event'::text; END IF;
  IF cardinality(pg_temp.copies_live()) <> 0 THEN f := f || ('support: ' || pg_temp.copies_live()::text); END IF;
  PERFORM pg_temp.client(tA, 'a0000000-0000-7000-8000-0000000c1a01');
  IF cardinality(pg_temp.copies_live()) <> 0 THEN f := f || ('client principal: ' || pg_temp.copies_live()::text); END IF;
  PERFORM pg_temp.ctx(tA, pg_temp.id('agA1'), NULL);
  IF cardinality(pg_temp.copies_live()) <> 0 THEN f := f || ('staff with no actor: ' || pg_temp.copies_live()::text); END IF;
  PERFORM pg_temp.ctx(pg_temp.id('tB'), pg_temp.id('ownB'), 'user');
  IF app.mail_copy_live(tA, pg_temp.id('m1')) OR app.mail_copy_live(pg_temp.id('tB'), pg_temp.id('m1')) THEN
    f := f || 'tenant B learns about a tenant A copy'::text;
  END IF;
  -- the mailbox owner and the system keep their answers: m1 (live), m2 (thread removed), m3 (address no longer
  -- synced), m4 (Dora, reassigned: still live), m5 (Erin, in the pond: still live), m6 (agent 2's mailbox)
  FOR a IN SELECT * FROM (VALUES ('agA1', 'user', ARRAY[true, false, false, true, true, false]),
                                 (NULL, 'system', ARRAY[true, false, false, true, true, true])) v(who, kind, want) LOOP
    PERFORM pg_temp.ctx(tA, pg_temp.id(a.who), a.kind);
    IF ARRAY[app.mail_copy_live(tA, pg_temp.id('m1')), app.mail_copy_live(tA, pg_temp.id('m2')), app.mail_copy_live(tA, pg_temp.id('m3')),
             app.mail_copy_live(tA, pg_temp.id('m4')), app.mail_copy_live(tA, pg_temp.id('m5')), app.mail_copy_live(tA, pg_temp.id('m6'))]
       IS DISTINCT FROM a.want THEN
      f := f || (a.kind || ' ' || COALESCE(a.who, '') || ' changed its answers');
    END IF;
  END LOOP;
  SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.provolatile, p.proconfig,
         has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_exec, has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
    INTO d FROM pg_proc p WHERE p.oid = 'app.mail_copy_live(uuid,uuid)'::regprocedure;
  IF d.owner <> 'app_definer' OR NOT d.prosecdef OR d.provolatile <> 's' OR d.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
     OR NOT d.app_user_exec OR d.public_exec THEN
    f := f || 'app.mail_copy_live lost its reviewed owner, volatility, search_path or grants'::text;
  END IF;
  PERFORM pg_temp.check(f,
    'R-GMAIL-6 E220 E221 (D2 review #3): app.mail_copy_live is false for a support actor under the Owner''s grant, a client '
    || 'principal, a staff session with no actor, tenant B, and a peer who holds the copy''s id from consent evidence or sees only '
    || 'the pond card, whatever the copy''s state; the mailbox owner (for their own copies) and the system keep their answers '
    || '(live copies true, a removed thread''s and an unsynced address''s copies false), and the mailbox owner learns nothing '
    || 'about another agent''s copy; owner, search_path and grants unchanged');
END $$;
DO $$
DECLARE f text[] := '{}'; a record; seen uuid[]; live uuid[]; all_live uuid[];
BEGIN
  -- every member: the copies app.mail_copy_live calls live are exactly the copies they can read
  FOR a IN SELECT * FROM (VALUES ('agA1'), ('agA2'), ('agA3'), ('tlA'), ('admA'), ('ownA')) v(who) LOOP
    PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id(a.who), 'user');
    seen := pg_temp.copies_seen();
    live := pg_temp.copies_live();
    IF seen IS DISTINCT FROM live THEN f := f || (a.who || ' reads ' || seen::text || ' but is told ' || live::text); END IF;
    IF a.who = 'ownA' THEN all_live := seen; END IF;
  END LOOP;
  -- the system reads every copy (to purge the hidden ones: m2, m3, and m7 since #1 removed Gail's point) and is
  -- told which are live (m1, m4, m5, m6: what the Owner reads)
  PERFORM pg_temp.ctx(pg_temp.id('tA'), NULL, 'system');
  IF pg_temp.copies_seen() IS DISTINCT FROM ARRAY[pg_temp.id('m1'), pg_temp.id('m2'), pg_temp.id('m3'), pg_temp.id('m4'),
                                                  pg_temp.id('m5'), pg_temp.id('m6'), pg_temp.id('m7')]
     OR pg_temp.copies_live() IS DISTINCT FROM all_live
     OR all_live IS DISTINCT FROM ARRAY[pg_temp.id('m1'), pg_temp.id('m4'), pg_temp.id('m5'), pg_temp.id('m6')] THEN
    f := f || ('system reads ' || pg_temp.copies_seen()::text || ', is told ' || pg_temp.copies_live()::text || ', Owner reads ' || all_live::text);
  END IF;
  PERFORM pg_temp.check(f,
    'R-GMAIL-6 (D2 review #3): for every member (both mailbox owners, the collaborator and deal member who is also Dora''s new '
    || 'owner, the Team Lead, the Admin and the Owner) app.mail_copy_live is true for exactly the copies they can read, so it '
    || 'reveals nothing a SELECT does not; for the system it is true for exactly the live copies');
END $$;

-- =============================================================================
-- 4. D2 review #4: only the system sets messages.rfc_message_id_sha256, and only once
-- =============================================================================
DO $$
DECLARE f text[] := '{}'; r text;
BEGIN
  -- the Team Lead plants the hash of a client's reply on a canceled, never-sent email (and once without a hash)
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('tlA'), 'user');
  r := pg_temp.try(pg_temp.email_sql(pg_temp.id('msgTL'), pg_temp.id('tlA'), 'canceled', '<client-reply-42@mail.example.test>'));
  IF r NOT LIKE '%RFC_MESSAGE_ID_SYSTEM_ONLY%' THEN f := f || ('the TL''s planted hash: ' || r); END IF;
  r := pg_temp.try(pg_temp.email_sql(pg_temp.id('msgTL0'), pg_temp.id('tlA'), 'canceled', NULL));
  IF r <> 'OK' THEN f := f || ('the TL''s email without a hash: ' || r); END IF;
  -- agent 1 schedules an email (no hash), then tries to set one on it; other edits stay theirs
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
  r := pg_temp.try(pg_temp.email_sql(pg_temp.id('msgA1'), pg_temp.id('agA1'), 'scheduled', NULL));
  IF r <> 'OK' THEN f := f || ('agent 1''s scheduled email: ' || r); END IF;
  r := pg_temp.try(format($q$UPDATE messages SET rfc_message_id_sha256 = digest('<client-reply-45@mail.example.test>', 'sha256') WHERE id = %L$q$,
                          pg_temp.id('msgA1')));
  IF r NOT LIKE '%RFC_MESSAGE_ID_SYSTEM_ONLY%' THEN f := f || ('agent 1''s UPDATE of the hash: ' || r); END IF;
  r := pg_temp.try(format($q$UPDATE messages SET subject = 'Saturday at 10' WHERE id = %L$q$, pg_temp.id('msgA1')));
  IF r <> 'OK' THEN f := f || ('agent 1''s subject edit: ' || r); END IF;
  -- the Owner (tenant-wide) forges a client's inbound email with a hash
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('ownA'), 'user');
  r := pg_temp.try(pg_temp.inbound_sql(pg_temp.id('msgOwn'), '<client-reply-46@mail.example.test>'));
  IF r NOT LIKE '%RFC_MESSAGE_ID_SYSTEM_ONLY%' THEN f := f || ('the Owner''s forged inbound email: ' || r); END IF;
  -- tenant B (a foreign tenant: the guard leaves the refusal to RLS) and a support actor are refused as before
  PERFORM pg_temp.ctx(pg_temp.id('tB'), pg_temp.id('ownB'), 'user');
  r := pg_temp.try(replace(pg_temp.inbound_sql(gen_random_uuid(), '<client-reply-47@mail.example.test>'), 'app.tenant_id()',
                           quote_literal(pg_temp.id('tA'))));
  IF r NOT LIKE '%row-level security%' THEN f := f || ('tenant B writing into tenant A: ' || r); END IF;
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('supU'), 'support');
  r := pg_temp.try(pg_temp.inbound_sql(gen_random_uuid(), '<client-reply-48@mail.example.test>'));
  IF r NOT LIKE '%SUPPORT_READ_ONLY%' THEN f := f || ('a support actor: ' || r); END IF;
  -- the plant did not land: the system stores agent 1's Gmail copy of the client's real reply 42
  PERFORM pg_temp.ctx(pg_temp.id('tA'), NULL, 'system');
  r := pg_temp.try(pg_temp.copy_sql(pg_temp.id('m8'), pg_temp.id('lk1'), pg_temp.id('c1'), pg_temp.id('p1'), 'alice@example.test',
                                    'g42', 't42', '<client-reply-42@mail.example.test>'));
  IF r <> 'OK' THEN f := f || ('the system''s copy of reply 42: ' || r); END IF;
  PERFORM pg_temp.check(f,
    'R-GMAIL-12 E201 (D2 review #4): a person cannot set the platform email Message-ID hash that the Gmail dedupe trusts: the '
    || 'Team Lead''s planted never-sent email, an agent''s UPDATE of their own scheduled email and the Owner''s forged inbound '
    || 'email are refused (RFC_MESSAGE_ID_SYSTEM_ONLY), so the system still stores the copy the plant targeted; people still '
    || 'write email without a hash and edit other columns; tenant B and a support actor are refused as before');
END $$;
DO $$
DECLARE f text[] := '{}'; r text;
BEGIN
  -- the system writes the hash: platform inbound with it, and TX2 setting it once on agent 1's email
  PERFORM pg_temp.ctx(pg_temp.id('tA'), NULL, 'system');
  r := pg_temp.try(pg_temp.inbound_sql(pg_temp.id('msgIn'), '<client-reply-50@mail.example.test>'));
  IF r <> 'OK' THEN f := f || ('platform inbound with its hash: ' || r); END IF;
  r := pg_temp.try(format($q$UPDATE messages SET rfc_message_id_sha256 = digest('<agent1-51@a-realty.test>', 'sha256') WHERE id = %L$q$,
                          pg_temp.id('msgA1')));
  IF r <> 'OK' THEN f := f || ('TX2 setting the hash: ' || r); END IF;
  -- each dedupes the Gmail copy (R-GMAIL-12: the platform row wins)
  r := pg_temp.try(pg_temp.copy_sql(gen_random_uuid(), pg_temp.id('lk1'), pg_temp.id('c1'), pg_temp.id('p1'), 'alice@example.test',
                                    'g50', 't50', '<client-reply-50@mail.example.test>'));
  IF r NOT LIKE '%MAIL_DUPLICATE_OF_PLATFORM_EMAIL%' THEN f := f || ('copy of the inbound email: ' || r); END IF;
  r := pg_temp.try(pg_temp.copy_sql(gen_random_uuid(), pg_temp.id('lk1'), pg_temp.id('c1'), pg_temp.id('p1'), 'alice@example.test',
                                    'g51', 't51', '<agent1-51@a-realty.test>'));
  IF r NOT LIKE '%MAIL_DUPLICATE_OF_PLATFORM_EMAIL%' THEN f := f || ('copy of the sent email: ' || r); END IF;
  -- once set, nobody changes or clears it: not the system, not the Owner, not the initiator; the same value is a no-op
  r := pg_temp.try(format($q$UPDATE messages SET rfc_message_id_sha256 = digest('<agent1-52@a-realty.test>', 'sha256') WHERE id = %L$q$,
                          pg_temp.id('msgA1')));
  IF r NOT LIKE '%RFC_MESSAGE_ID_FINAL%' THEN f := f || ('the system rewriting the hash: ' || r); END IF;
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('ownA'), 'user');
  r := pg_temp.try(format($q$UPDATE messages SET rfc_message_id_sha256 = NULL WHERE id = %L$q$, pg_temp.id('msgIn')));
  IF r NOT LIKE '%RFC_MESSAGE_ID_FINAL%' THEN f := f || ('the Owner clearing the inbound hash: ' || r); END IF;
  r := pg_temp.try(format($q$UPDATE messages SET rfc_message_id_sha256 = rfc_message_id_sha256 WHERE id = %L$q$, pg_temp.id('msgIn')));
  IF r <> 'OK' THEN f := f || ('the Owner writing the same value: ' || r); END IF;
  PERFORM pg_temp.ctx(pg_temp.id('tA'), pg_temp.id('agA1'), 'user');
  r := pg_temp.try(format($q$UPDATE messages SET rfc_message_id_sha256 = NULL WHERE id = %L$q$, pg_temp.id('msgA1')));
  IF r NOT LIKE '%RFC_MESSAGE_ID_FINAL%' THEN f := f || ('the initiator clearing the hash: ' || r); END IF;
  PERFORM pg_temp.check(f,
    'R-GMAIL-12 E201 (D2 review #4): the system writes the hash once (platform inbound, and TX2 on an email from NULL), and '
    || 'each dedupes the Gmail copy; afterwards nobody changes or clears it (RFC_MESSAGE_ID_FINAL), not the system, not the '
    || 'Owner and not the initiator; writing the same value again is a no-op');
END $$;

-- the platform:gmail notes carry the rollout precondition (D2 review docs: the dedupe covers only hashed platform rows)
SELECT pg_temp.ok((SELECT bool_and(notes LIKE '%Rollout precondition (R-GMAIL-12, E201)%' AND notes LIKE '%at least 90 days%'
                                   AND notes LIKE 'Gmail inbox sync (C14, N19).%')
                     FROM jurisdiction_packs WHERE key = 'platform:gmail' AND status = 'published'),
                  'R-GMAIL-12 E201 (D2 review #6): the platform:gmail notes state the rollout precondition (vendor_ready_at only after '
                  || '90 days of Message-ID hashing or a one-time repair, since the database dedupes only platform email that carries '
                  || 'the hash), after the D2 text');

-- =============================================================================
-- 5. D2 review #5: mail_messages_select tests the mailbox link first, and admits exactly the same rows
-- =============================================================================
-- reference: every copy (all tenants, as the owner role) with its liveness under the D2 migration's copy check,
-- evaluated in its own tenant's context exactly as that definer (BYPASSRLS) evaluated it
RESET ROLE;
DO $$
DECLARE t uuid;
BEGIN
  FOREACH t IN ARRAY ARRAY[pg_temp.id('tA'), pg_temp.id('tB')] LOOP
    PERFORM pg_temp.ctx(t, NULL, 'system');
    INSERT INTO pg_temp.eq_rows (tenant_id, id, contact_id, link_id, live)
    SELECT mm.tenant_id, mm.id, mm.contact_id, mm.link_id,
           EXISTS (SELECT 1 FROM public.mail_messages x
                     JOIN public.contact_points p
                       ON p.tenant_id = x.tenant_id AND p.id = x.contact_point_id AND p.contact_id = x.contact_id AND p.removed_at IS NULL
                     JOIN public.mail_sync_points sp
                       ON sp.tenant_id = x.tenant_id AND sp.link_id = x.link_id AND sp.contact_point_id = x.contact_point_id
                    WHERE x.tenant_id = mm.tenant_id AND x.id = mm.id
                      AND app.mail_link_live(x.tenant_id, x.link_id)
                      AND NOT EXISTS (SELECT 1 FROM public.mail_thread_exclusions e
                                       WHERE e.tenant_id = x.tenant_id AND e.link_id = x.link_id AND e.gmail_thread_id = x.gmail_thread_id)
                      AND NOT EXISTS (SELECT 1 FROM public.user_mail_links ml
                                       WHERE ml.tenant_id = x.tenant_id AND ml.status <> 'revoked'
                                         AND ml.mailbox_address_hmac = x.contact_address_hmac))
      FROM public.mail_messages mm WHERE mm.tenant_id = t;
  END LOOP;
END $$;
SET LOCAL ROLE app_user;
DO $$
DECLARE f text[] := '{}'; a record; actual uuid[]; expected uuid[]; q text;
BEGIN
  q := (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_policy p
         WHERE p.polrelid = 'public.mail_messages'::regclass AND p.polname = 'mail_messages_select');
  IF NOT (position('user_mail_links' IN q) > 0 AND position('user_mail_links' IN q) < position('contact_detail_visible' IN q)) THEN
    f := f || 'mail_messages_select still tests contact_detail_visible first'::text;
  END IF;
  FOR a IN SELECT * FROM (VALUES ('tA', 'agA1', 'user'), ('tA', 'agA2', 'user'), ('tA', 'agA3', 'user'), ('tA', 'tlA', 'user'),
                                 ('tA', 'admA', 'user'), ('tA', 'ownA', 'user'), ('tA', NULL, 'system'), ('tA', 'supU', 'support'),
                                 ('tA', 'client', NULL), ('tA', 'agA1', 'none'), ('tB', 'ownB', 'user'), ('tB', NULL, 'system')) v(t, who, kind) LOOP
    IF a.who = 'client' THEN PERFORM pg_temp.client(pg_temp.id(a.t), 'a0000000-0000-7000-8000-0000000c1a01');
    ELSE PERFORM pg_temp.ctx(pg_temp.id(a.t), pg_temp.id(a.who), a.kind); END IF;
    actual := (SELECT COALESCE(array_agg(id ORDER BY id), '{}') FROM mail_messages);
    -- the D2 migration's read rules for this caller: Layer 1, never support, live unless the system, and the policy's
    -- two branches (timeline visibility, the caller's own sight of the link) as the caller's own RLS evaluates them
    expected := (SELECT COALESCE(array_agg(e.id ORDER BY e.id), '{}') FROM pg_temp.eq_rows e
                  WHERE e.tenant_id = app.tenant_id() AND app.principal_type() = 'staff' AND app.actor_kind() <> 'support'
                    AND (app.actor_kind() = 'system' OR e.live)
                    AND (app.contact_detail_visible(e.tenant_id, e.contact_id)
                         OR EXISTS (SELECT 1 FROM user_mail_links l WHERE l.tenant_id = e.tenant_id AND l.id = e.link_id)));
    IF actual IS DISTINCT FROM expected THEN
      f := f || (COALESCE(a.who, a.kind) || '@' || a.t || ' reads ' || actual::text || ', the D2 rules give ' || expected::text);
    END IF;
    -- every branch of the policy is exercised: the link only (agent 1: Dora and Erin are no longer theirs), the
    -- timeline only (the Team Lead through the pond, agent 3 as collaborator and deal member), and the system's purge view
    IF (a.who = 'agA1' AND a.kind = 'user' AND NOT actual @> ARRAY[pg_temp.id('m1'), pg_temp.id('m4'), pg_temp.id('m5')])
       OR (a.who = 'tlA' AND NOT actual @> ARRAY[pg_temp.id('m5')])
       OR (a.who = 'agA3' AND NOT actual @> ARRAY[pg_temp.id('m1'), pg_temp.id('m4'), pg_temp.id('m6')])
       OR (a.kind = 'system' AND a.t = 'tA' AND NOT actual @> ARRAY[pg_temp.id('m2'), pg_temp.id('m3')])
       OR (a.who = 'ownB' AND actual IS DISTINCT FROM ARRAY[pg_temp.id('mB')]) THEN
      f := f || ('fixture: ' || COALESCE(a.who, a.kind) || '@' || a.t || ' should read ' || 'more than ' || actual::text);
    END IF;
  END LOOP;
  PERFORM pg_temp.check(f,
    'R-GMAIL-6 (D2 review #5): mail_messages_select tests the mailbox link before app.contact_detail_visible and admits exactly '
    || 'the rows of the D2 migration''s order and copy check for both mailbox owners, the peer, the collaborator and new owner, '
    || 'the Team Lead, the Admin, the Owner, a support actor, a client principal, a staff session with no actor, tenant B''s '
    || 'Owner and both tenants'' system actors');
END $$;
-- what the reorder buys: the system's passes over the copies call app.contact_detail_visible no more
RESET ROLE;
SET LOCAL track_functions = 'all';
SET LOCAL ROLE app_user;
DO $$
DECLARE f text[] := '{}'; c0 bigint; c1 bigint; c2 bigint; c3 bigint; n bigint; r1 text; r2 text;
        fn regprocedure := 'app.contact_detail_visible(uuid,uuid)'::regprocedure;
BEGIN
  PERFORM pg_temp.ctx(pg_temp.id('tA'), NULL, 'system');
  c0 := COALESCE(pg_stat_get_xact_function_calls(fn), 0);
  SELECT count(*) INTO n FROM mail_messages;                                                -- a purge pass's scan
  UPDATE mail_messages SET contact_id = contact_id WHERE tenant_id = pg_temp.id('tA');      -- a re-point pass's scan (no-op)
  c1 := COALESCE(pg_stat_get_xact_function_calls(fn), 0);
  -- the insert guard counts the thread's messages; its other reads (the contact point, under contact_points' own
  -- policy) cost the same for every insert, so a thread one message longer must cost no more
  r1 := pg_temp.try(pg_temp.copy_sql(pg_temp.id('m9'), pg_temp.id('lk1'), pg_temp.id('c1'), pg_temp.id('p1'), 'alice@example.test',
                                     'g9', 't1'));
  c2 := COALESCE(pg_stat_get_xact_function_calls(fn), 0);
  r2 := pg_temp.try(pg_temp.copy_sql(gen_random_uuid(), pg_temp.id('lk1'), pg_temp.id('c1'), pg_temp.id('p1'), 'alice@example.test',
                                     'g10', 't1'));
  c3 := COALESCE(pg_stat_get_xact_function_calls(fn), 0);
  IF n < 7 OR r1 <> 'OK' OR r2 <> 'OK' THEN f := f || ('fixture: ' || n || ' copies, inserts ' || r1 || ' / ' || r2); END IF;
  -- the counter is live: one direct call counts once
  PERFORM app.contact_detail_visible(pg_temp.id('tA'), pg_temp.id('c1'));
  IF COALESCE(pg_stat_get_xact_function_calls(fn), 0) <> c3 + 1 THEN f := f || 'fixture: function calls are not being counted'::text; END IF;
  IF c1 <> c0 THEN f := f || ('the scan and the re-point pass ran app.contact_detail_visible ' || (c1 - c0) || ' times'); END IF;
  IF c3 - c2 <> c2 - c1 THEN
    f := f || ('the guard ran it ' || (c2 - c1) || ' then ' || (c3 - c2) || ' times as the thread grew by one message');
  END IF;
  PERFORM pg_temp.check(f,
    'R-GMAIL-13 (D2 review #5, PERFORMANCE §5): the system''s scan of every copy and a re-point pass call '
    || 'app.contact_detail_visible no times, and the insert guard''s per-thread count no longer calls it per message already '
    || 'in the thread (the D2 order called it once per row)');
END $$;

SELECT pg_temp.ok(true, 'ALL D2 REVIEW FIX SMOKE CHECKS PASSED');
ROLLBACK;
