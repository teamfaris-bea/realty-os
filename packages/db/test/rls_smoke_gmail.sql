-- =============================================================================
-- RLS / integrity smoke test for the D2 migration (owner decision D2: Meta publishing only, Gmail inbox sync):
-- marketing_publications (R-MKT-12), user_mail_links, mail_thread_exclusions, mail_sync_points, mail_messages
-- (R-GMAIL-1..14), and the security-review fixes S-D2-1..S-D2-6 and S-D2-8 (named in the check text).
-- Same shape as rls_smoke_p23.sql: ONE transaction, rolled back; every application step runs as app_user;
-- a failed expectation raises 'FAIL ...'. Platform maintenance steps (counsel clearing a platform pack, the
-- vendor check) run as the owner role between RESET ROLE and SET LOCAL ROLE.
-- Run by packages/db/test/rls_smoke_gmail.test.ts.
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
                                 p_internal text DEFAULT 'now()', p_rfc text DEFAULT NULL, p_attachments text DEFAULT '[]')
RETURNS text LANGUAGE sql AS $$
  SELECT format($q$INSERT INTO mail_messages (tenant_id, id, link_id, contact_id, contact_point_id, contact_address_hmac,
    gmail_message_id, gmail_thread_id, rfc_message_id_sha256, sender, contact_role, other_recipient_count, subject, body, attachments,
    internal_at, origin) VALUES (app.tenant_id(), %L, %L, %L, %L, digest(%L, 'sha256'), %L, %L, %s, 'contact', 'from', 1,
    'Re: the Oak St house', 'Can we see it Saturday?', %L, %s, 'live')$q$,
    p_id, p_link, p_contact, p_point, p_address, p_msg, p_thread,
    CASE WHEN p_rfc IS NULL THEN 'NULL' ELSE format('digest(%L, ''sha256'')', p_rfc) END, p_attachments, p_internal)
$$;
CREATE FUNCTION pg_temp.copy(p_id uuid, p_link uuid, p_contact uuid, p_point uuid, p_address text, p_msg text, p_thread text,
                             p_internal text DEFAULT 'now()', p_rfc text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN EXECUTE pg_temp.copy_sql(p_id, p_link, p_contact, p_point, p_address, p_msg, p_thread, p_internal, p_rfc); END $$;
-- the OAuth callback's link row (system actor)
CREATE FUNCTION pg_temp.link_sql(p_id uuid, p_user uuid, p_address text,
                                 p_scopes text DEFAULT 'ARRAY[''https://www.googleapis.com/auth/gmail.readonly'']',
                                 p_token text DEFAULT '''\x01''::bytea') RETURNS text LANGUAGE sql AS $$
  SELECT format($q$INSERT INTO user_mail_links (tenant_id, id, user_id, provider, mailbox_address, mailbox_address_hmac, scopes,
    disclosure_sha256, status, refresh_enc, key_version, connected_at) VALUES (app.tenant_id(), %L, %L, 'gmail', %L,
    digest(lower(%L), 'sha256'), %s, repeat('cd', 32), 'connected', %s, 1, now())$q$,
    p_id, p_user, p_address, p_address, p_scopes, p_token)
$$;
-- the mailbox owner's confirmation that one client address syncs (S-D2-1)
CREATE FUNCTION pg_temp.point_sql(p_link uuid, p_point uuid, p_contact uuid) RETURNS text LANGUAGE sql AS $$
  SELECT format($q$INSERT INTO mail_sync_points (tenant_id, link_id, contact_point_id, contact_id) VALUES (app.tenant_id(), %L, %L, %L)$q$,
                p_link, p_point, p_contact)
$$;
-- visible copies in the current context
CREATE FUNCTION pg_temp.copies(p_link uuid DEFAULT NULL, p_contact uuid DEFAULT NULL) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM mail_messages WHERE (p_link IS NULL OR link_id = p_link) AND (p_contact IS NULL OR contact_id = p_contact)
$$;

\set tA     '''a0000000-0000-7000-8000-000000000001'''
\set tB     '''b0000000-0000-7000-8000-000000000001'''
\set ownA   '''a0000000-0000-7000-8000-0000000000a0'''
\set agA1   '''a0000000-0000-7000-8000-0000000000a1'''
\set agA2   '''a0000000-0000-7000-8000-0000000000a2'''
\set tlA    '''a0000000-0000-7000-8000-0000000000a3'''
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
\set cB     '''b0000000-0000-7000-8000-00000000e001'''
\set p1     '''a0000000-0000-7000-8000-00000000f101'''
\set p1w    '''a0000000-0000-7000-8000-00000000f102'''
\set p2     '''a0000000-0000-7000-8000-00000000f201'''
\set p3     '''a0000000-0000-7000-8000-00000000f301'''
\set p4     '''a0000000-0000-7000-8000-00000000f401'''
\set p5     '''a0000000-0000-7000-8000-00000000f501'''
\set pB     '''b0000000-0000-7000-8000-00000000f101'''
\set pX     '''a0000000-0000-7000-8000-00000000f9a1'''
\set pM     '''a0000000-0000-7000-8000-00000000f9a2'''
\set pBen   '''a0000000-0000-7000-8000-00000000f9a3'''
\set pW2    '''a0000000-0000-7000-8000-00000000f9a4'''
\set m8     '''a0000000-0000-7000-8000-000000007108'''
\set m9     '''a0000000-0000-7000-8000-000000007109'''
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
\set mB     '''b0000000-0000-7000-8000-000000007101'''
\set cv1    '''a0000000-0000-7000-8000-00000000cc01'''
\set cv4    '''a0000000-0000-7000-8000-00000000cc04'''
\set lA     '''a0000000-0000-7000-8000-00000000f1aa'''
\set credA  '''a0000000-0000-7000-8000-00000000cd01'''
\set fbA    '''a0000000-0000-7000-8000-00000000ac11'''
\set igA    '''a0000000-0000-7000-8000-00000000ac12'''
\set gbpA   '''a0000000-0000-7000-8000-00000000ac13'''
\set srcA   '''a0000000-0000-7000-8000-000000005001'''
\set pcS    '''a0000000-0000-7000-8000-00000000a501'''
\set pcG    '''a0000000-0000-7000-8000-00000000a502'''
\set pcF    '''a0000000-0000-7000-8000-00000000a503'''
\set pub1   '''a0000000-0000-7000-8000-00000000a601'''
\set pub2   '''a0000000-0000-7000-8000-00000000a602'''
\set pub3   '''a0000000-0000-7000-8000-00000000a603'''
\set PH     '''$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA'''
\set GOOD   '''{"brokerage_name_present": true, "hard_count": 0, "soft_count": 0, "pack_rule_failures": []}'''

-- =============================================================================
-- 0. Two tenants; in A an Owner, an Admin, a Team Lead (team: agent 1) and two agents; an Owner in B; a
--    platform support user. Contacts: Alice (+ her duplicate), Dora and Erin are agent 1's, Carol agent 2's.
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
  (:tA, 'a0000000-0000-7000-8000-0000000001a1', 'agent1@example.test', 'agent', digest('gm-invite-a1', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a0000000-0000-7000-8000-0000000001a2', 'agent2@example.test', 'agent', digest('gm-invite-a2', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a0000000-0000-7000-8000-0000000001a3', 'lead@example.test', 'team_lead', digest('gm-invite-a3', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a0000000-0000-7000-8000-0000000001ad', 'admin@example.test', 'admin', digest('gm-invite-ad', 'sha256'), :ownA, now() + interval '1 day');
SELECT pg_temp.ctx(NULL, NULL, NULL);
SELECT FROM auth.accept_invite(digest('gm-invite-a1', 'sha256'), :agA1, 'Ava Agent', :PH, now());
SELECT FROM auth.accept_invite(digest('gm-invite-a2', 'sha256'), :agA2, 'Ben Agent', :PH, now());
SELECT FROM auth.accept_invite(digest('gm-invite-a3', 'sha256'), :tlA, 'Tess Lead', :PH, now());
SELECT FROM auth.accept_invite(digest('gm-invite-ad', 'sha256'), :admA, 'Adam Admin', :PH, now());
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO team_members (tenant_id, team_id, user_id, is_lead) VALUES (:tA, :teamA, :tlA, true), (:tA, :teamA, :agA1, false);
-- the Owner's time-boxed support grant (R-PERM-11)
INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, expires_at)
VALUES (:tA, gen_random_uuid(), :supU, :ownA, 'Ticket 4411: timeline question', now() + interval '2 hours');

SELECT pg_temp.self_create(:tA, :c1, :agA1, 'Alice Buyer', 'a0000000-0000-7000-8000-0000000c0001');
SELECT pg_temp.self_create(:tA, :c3, :agA1, 'Dora Buyer', 'a0000000-0000-7000-8000-0000000c0003');
SELECT pg_temp.self_create(:tA, :c4, :agA1, 'Alice B. (duplicate)', 'a0000000-0000-7000-8000-0000000c0004');
SELECT pg_temp.self_create(:tA, :c5, :agA1, 'Erin Prospect', 'a0000000-0000-7000-8000-0000000c0005');
SELECT pg_temp.self_create(:tA, :c2, :agA2, 'Carol Seller', 'a0000000-0000-7000-8000-0000000c0002');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
VALUES (:tA, :p2, :c2, 'email', 'carol@example.test', digest('carol@example.test', 'sha256'));
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac) VALUES
  (:tA, :p1,  :c1, 'email', 'alice@example.test', digest('alice@example.test', 'sha256')),
  (:tA, :p1w, :c1, 'email', 'alice.work@example.test', digest('alice.work@example.test', 'sha256')),
  (:tA, :p3,  :c3, 'email', 'dora@example.test', digest('dora@example.test', 'sha256')),
  (:tA, :p4,  :c4, 'email', 'alice@example.test', digest('alice@example.test', 'sha256')),
  (:tA, :p5,  :c5, 'email', 'erin@example.test', digest('erin@example.test', 'sha256'));
INSERT INTO listings (tenant_id, id, source, status, address_line1, city, region, postal_code, listing_agent_user_id, list_price_cents)
VALUES (:tA, :lA, 'team', 'active', '12 Oak St', 'Town', 'SC', '29401', :agA1, 45000000);
SELECT pg_temp.self_create(:tB, :cB, :ownB, 'Bob Seller', 'b0000000-0000-7000-8000-0000000c0001');
INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
VALUES (:tB, :pB, :cB, 'email', 'bob@example.test', digest('bob@example.test', 'sha256'));

-- =============================================================================
-- 1. Dark until cleared and switched on by the Owner (R-GMAIL-1)
-- =============================================================================
SELECT pg_temp.ok((SELECT reviewed_by_counsel_at IS NULL AND (rules->>'max_messages_per_thread')::int = 200
                          AND (rules->>'backfill_max_messages')::int = 5000 AND NOT (rules ? 'vendor_ready_at')
                     FROM jurisdiction_packs WHERE key = 'platform:gmail' AND status = 'published'),
                  'R-GMAIL-1: platform:gmail ships published but unreviewed, with its sync limits and no vendor check');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.ok((SELECT NOT mail_sync_enabled AND mail_backfill_days = 30 FROM tenant_settings WHERE tenant_id = :tA),
                  'R-GMAIL-1 R-GMAIL-8: Gmail sync starts off with a 30-day backfill window');
SELECT pg_temp.expect_error($q$UPDATE tenant_settings SET mail_sync_enabled = true$q$,
  'R-GMAIL-1: the Owner cannot turn Gmail sync on before counsel clears platform:gmail', '%MAIL_SYNC_NOT_CLEARED%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(pg_temp.link_sql(:lk1, :agA1, 'ava@gmail.test'),
  'R-GMAIL-1: no mailbox links while sync is off', '%MAIL_SYNC_OFF%');
RESET ROLE;
UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:gmail';
SET LOCAL ROLE app_user;
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.expect_error($q$UPDATE tenant_settings SET mail_sync_enabled = true$q$,
  'R-GMAIL-1: counsel review alone is not enough: Google''s verification (vendor_ready_at) must pass too', '%MAIL_SYNC_NOT_CLEARED%');
RESET ROLE;
UPDATE jurisdiction_packs SET rules = rules || '{"vendor_ready_at": "2026-11-01T00:00:00Z"}' WHERE key = 'platform:gmail';
SET LOCAL ROLE app_user;
SELECT pg_temp.ctx(:tA, :admA, 'user');
SELECT pg_temp.expect_error($q$UPDATE tenant_settings SET mail_sync_enabled = true$q$,
  'R-GMAIL-1: an Admin cannot turn Gmail sync on (Owner only)', '%OWNER_ONLY_MAIL_SYNC%');
SELECT pg_temp.expect_error($q$UPDATE tenant_settings SET mail_backfill_days = 60$q$,
  'R-GMAIL-8: an Admin cannot change the backfill window (Owner only)', '%OWNER_ONLY_MAIL_SYNC%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error($q$UPDATE tenant_settings SET mail_sync_enabled = true$q$,
  'R-GMAIL-1: the system cannot turn Gmail sync on for the Owner', '%OWNER_ONLY_MAIL_SYNC%');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(pg_temp.rows_affected($q$UPDATE tenant_settings SET mail_sync_enabled = true$q$) = 0,
  'R-GMAIL-1: an agent cannot touch the switch');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.expect_error($q$UPDATE tenant_settings SET mail_backfill_days = 91$q$,
  'R-GMAIL-8: the backfill window is at most 90 days', '%check constraint%');
UPDATE tenant_settings SET mail_sync_enabled = true;
SELECT pg_temp.ok((SELECT mail_sync_enabled FROM tenant_settings WHERE tenant_id = :tA),
                  'R-GMAIL-1: the Owner turns Gmail sync on once platform:gmail is cleared (counsel + vendor)');
SELECT pg_temp.ctx(:tB, :ownB, 'user');
UPDATE tenant_settings SET mail_sync_enabled = true;

-- =============================================================================
-- 2. The agent's own read-only mailbox link (R-GMAIL-2, -3, -4)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(pg_temp.link_sql(:lk1, :agA1, 'ava@gmail.test'),
  'R-GMAIL-2: a person cannot link a mailbox by typing its address (only the OAuth callback, after reading the profile)',
  '%MAIL_LINK_PROOF_REQUIRED%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(pg_temp.link_sql(:lk1, :agA1, 'ava@gmail.test',
  'ARRAY[''https://www.googleapis.com/auth/gmail.readonly'', ''https://www.googleapis.com/auth/gmail.modify'']'),
  'R-GMAIL-3 E225: a token that also grants gmail.modify cannot be stored', '%user_mail_links_scopes_check%');
SELECT pg_temp.expect_error(pg_temp.link_sql(:lk1, :agA1, 'ava@gmail.test', 'ARRAY[''https://www.googleapis.com/auth/gmail.send'']'),
  'R-GMAIL-3: a send scope instead of gmail.readonly cannot be stored', '%user_mail_links_scopes_check%');
SELECT pg_temp.expect_error(pg_temp.link_sql(:lk1, :agA1, 'ava@gmail.test', p_token => 'NULL'),
  'R-GMAIL-4: a live link holds its encrypted refresh token', '%check constraint%');
SELECT pg_temp.expect_error(replace(pg_temp.link_sql(:lk1, :agA1, 'ava@gmail.test'), '''connected''', '''degraded'''),
  'R-GMAIL-2: a link starts connected', '%MAIL_LINK_BORN_CONNECTED%');
SELECT pg_temp.expect_error(pg_temp.link_sql(:lk1, :agA1, 'Ava@Gmail.test'),
  'R-GMAIL-2: the stored mailbox is the profile''s normalized address', '%check constraint%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.ok(pg_temp.rows_affected(pg_temp.link_sql(:lk1, :agA1, 'ava@gmail.test')) = 1
                  AND pg_temp.rows_affected(pg_temp.link_sql(:lk2, :agA2, 'ben@gmail.test')) = 1,
                  'R-GMAIL-2: the OAuth callback (system) links each agent''s own mailbox');
SELECT pg_temp.expect_error(pg_temp.link_sql(gen_random_uuid(), :agA1, 'ava.other@gmail.test'),
  'R-GMAIL-2: one live link per user', '%user_mail_links_one_live%');
SELECT pg_temp.expect_error(pg_temp.link_sql(gen_random_uuid(), :admA, 'ava@gmail.test'),
  'R-GMAIL-2 E210: a teammate cannot link a mailbox that is already linked (no shared mailbox)', '%user_mail_links_live_mailbox%');
SELECT pg_temp.ctx(:tB, NULL, 'system');
SELECT pg_temp.expect_error(pg_temp.link_sql(:lkB, :ownB, 'ava@gmail.test'),
  'R-GMAIL-2 E211: the same Gmail cannot be linked in a second workspace (one live link across all tenants)',
  '%user_mail_links_live_mailbox%');
SELECT pg_temp.ok(pg_temp.rows_affected(replace(pg_temp.link_sql(:lkB, :ownB, 'oscar@gmail.test'), '1, now())',
                  '1, now() - interval ''1 year'')')) = 1, 'tenant B''s Owner links their own mailbox');
SELECT pg_temp.ok((SELECT connected_at = now() FROM user_mail_links WHERE id = :lkB),
                  'R-GMAIL-8: the connect time (the live/backfill boundary) is the database clock, never the writer''s');
-- who sees the link, its token and sync state
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM user_mail_links) = 1 AND (SELECT user_id FROM user_mail_links) = :agA1,
                  'R-GMAIL-2: the mailbox owner sees their own link');
DO $$
DECLARE who uuid; n bigint;
BEGIN
  FOREACH who IN ARRAY ARRAY['a0000000-0000-7000-8000-0000000000a0','a0000000-0000-7000-8000-0000000000ad',
                             'a0000000-0000-7000-8000-0000000000a3']::uuid[] LOOP
    PERFORM pg_temp.ctx('a0000000-0000-7000-8000-000000000001', who, 'user');
    SELECT count(*) INTO n FROM user_mail_links WHERE user_id = 'a0000000-0000-7000-8000-0000000000a1';
    IF n <> 0 THEN RAISE EXCEPTION 'FAIL  % sees agent 1''s mail link', who; END IF;
  END LOOP;
  PERFORM pg_temp.ctx('a0000000-0000-7000-8000-000000000001', 'a0000000-0000-7000-8000-0000000000a2', 'user');
  SELECT count(*) INTO n FROM user_mail_links WHERE user_id = 'a0000000-0000-7000-8000-0000000000a1';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL  agent 2 sees agent 1''s mail link'; END IF;
  RAISE NOTICE 'PASS  R-GMAIL-2: the Owner, the Admin, the Team Lead and another agent see no link, token or sync state';
END $$;
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.ok((SELECT count(*) FROM user_mail_links) = 2, 'R-GMAIL-4: the system sees every link (it runs the sync)');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.ok(pg_temp.rows_affected(format($q$UPDATE user_mail_links SET next_sync_at = now() WHERE id = %L$q$, :lk1)) = 0,
                  'R-GMAIL-2: the Owner cannot touch an agent''s link');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format($q$UPDATE user_mail_links SET history_id = '999' WHERE id = %L$q$, :lk1),
  'R-GMAIL-4: the sync cursor is the system''s', '%MAIL_LINK_SYSTEM_ONLY%');
SELECT pg_temp.expect_error(format($q$UPDATE user_mail_links SET refresh_enc = '\x02' WHERE id = %L$q$, :lk1),
  'R-GMAIL-4: a person cannot write the refresh token', '%MAIL_LINK_SYSTEM_ONLY%');
SELECT pg_temp.expect_error(format($q$UPDATE user_mail_links SET mailbox_address = 'ben@gmail.test' WHERE id = %L$q$, :lk1),
  'R-GMAIL-2: a link keeps its mailbox (connecting another one is a new link)', '%MAIL_LINK_IMMUTABLE%');
SELECT pg_temp.expect_error(format($q$UPDATE user_mail_links SET scopes = ARRAY['https://www.googleapis.com/auth/gmail.modify'] WHERE id = %L$q$, :lk1),
  'R-GMAIL-3: a link keeps its read-only scope', '%MAIL_LINK_IMMUTABLE%');
UPDATE user_mail_links SET backfill_requested_at = now() - interval '1 year' WHERE id = :lk1;
SELECT pg_temp.ok((SELECT backfill_requested_at = now() FROM user_mail_links WHERE id = :lk1),
                  'R-GMAIL-8: the mailbox owner asks to import again (a request stamped with the database clock)');
SELECT pg_temp.ok((SELECT octet_length(mailbox_address_hmac) = 32 FROM user_mail_links WHERE id = :lk1),
                  'S-D2-1: a link carries the HMAC of its mailbox address (written by the callback)');
SELECT pg_temp.expect_error(format($q$UPDATE user_mail_links SET mailbox_address_hmac = digest('other@gmail.test', 'sha256') WHERE id = %L$q$, :lk1),
  'S-D2-1: a link keeps its mailbox HMAC', '%MAIL_LINK_IMMUTABLE%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(format($q$UPDATE user_mail_links SET mailbox_address_hmac = digest('other@gmail.test', 'sha256') WHERE id = %L$q$, :lk1),
  'S-D2-1: not even the system rewrites a mailbox HMAC', '%MAIL_LINK_IMMUTABLE%');

-- =============================================================================
-- 2b. Which client addresses sync: the mailbox owner confirms each one (S-D2-1, E203)
-- =============================================================================
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk1, :c1, :p1, 'alice@example.test', 'g0', 't0'),
  'S-D2-1 R-GMAIL-5: nothing syncs for a client address the mailbox owner did not confirm', '%MAIL_POINT_NOT_CONFIRMED%');
SELECT pg_temp.expect_error(pg_temp.point_sql(:lk1, :p1, :c1),
  'S-D2-1: the system cannot confirm an address for the mailbox owner', '%MAIL_POINT_OWNER_ONLY%');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.expect_error(pg_temp.point_sql(:lk1, :p1, :c1),
  'S-D2-1: another agent cannot confirm an address on agent 1''s link', '%MAIL_POINT_OWNER_ONLY%');
SELECT pg_temp.ctx(:tA, :tlA, 'user');
SELECT pg_temp.expect_error(pg_temp.point_sql(:lk1, :p1, :c1),
  'S-D2-1: neither can the Team Lead', '%MAIL_POINT_OWNER_ONLY%');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(pg_temp.point_sql(:lk1, :p2, :c2),
  'S-D2-1: the mailbox owner confirms only addresses of contacts they own, collaborate on or share a deal with', '%MAIL_CONTACT_NOT_RELATED%');
SELECT pg_temp.expect_error(pg_temp.point_sql(:lk1, :p3, :c1),
  'S-D2-1: a confirmation names the contact''s own current email point', '%MAIL_ADDRESS_NOT_A_CONTACT_POINT%');
-- "Sync Gmail with these clients?": one bulk confirm at connect (a forged confirmation time is replaced)
INSERT INTO mail_sync_points (tenant_id, link_id, contact_point_id, contact_id, confirmed_at) VALUES
  (:tA, :lk1, :p1, :c1, now() - interval '1 year'), (:tA, :lk1, :p3, :c3, now()), (:tA, :lk1, :p4, :c4, now()),
  (:tA, :lk1, :p5, :c5, now());
SELECT pg_temp.ok((SELECT count(*) FROM mail_sync_points WHERE link_id = :lk1 AND confirmed_at = now()) = 4,
                  'S-D2-1 S-D2-6: the mailbox owner confirms their clients'' addresses in one step; the confirmation time is the database clock');
SELECT pg_temp.expect_error(format($q$UPDATE mail_sync_points SET confirmed_at = now() - interval '1 day' WHERE link_id = %L$q$, :lk1),
  'S-D2-1: a confirmation is never edited', '%permission denied%');
DO $$
DECLARE who uuid; n bigint;
BEGIN
  FOREACH who IN ARRAY ARRAY['a0000000-0000-7000-8000-0000000000a0','a0000000-0000-7000-8000-0000000000ad',
                             'a0000000-0000-7000-8000-0000000000a3','a0000000-0000-7000-8000-0000000000a2']::uuid[] LOOP
    PERFORM pg_temp.ctx('a0000000-0000-7000-8000-000000000001', who, 'user');
    SELECT count(*) INTO n FROM mail_sync_points;
    IF n <> 0 THEN RAISE EXCEPTION 'FAIL  % sees agent 1''s confirmed addresses', who; END IF;
  END LOOP;
  RAISE NOTICE 'PASS  S-D2-1: the Owner, the Admin, the Team Lead and another agent see no confirmed addresses';
END $$;
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok(pg_temp.rows_affected(pg_temp.point_sql(:lk2, :p2, :c2)) = 1, 'S-D2-1: agent 2 confirms Carol''s address on their own link');
-- the attack: a peer adds a stranger's address (agent 1's spouse) to their own contact and makes agent 1 a collaborator
INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
VALUES (:tA, :pX, :c2, 'email', 'spouse-of-ava@family.test', digest('spouse-of-ava@family.test', 'sha256'));
INSERT INTO contact_collaborators (tenant_id, contact_id, user_id, role, added_by_user_id) VALUES (:tA, :c2, :agA1, 'co_agent', :agA2);
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk1, :c2, :pX, 'spouse-of-ava@family.test', 'gS1', 'tS1'),
  'S-D2-1 E203: a peer who adds a stranger''s address to a contact and makes the agent a collaborator cannot make the sync capture the agent''s personal mail',
  '%MAIL_POINT_NOT_CONFIRMED%');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
UPDATE contact_collaborators SET removed_at = now() WHERE tenant_id = :tA AND contact_id = :c2 AND user_id = :agA1;
-- the attack: a TL adds agent 1's own mailbox address to agent 1's contact
SELECT pg_temp.ctx(:tA, :tlA, 'user');
INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
VALUES (:tA, :pM, :c3, 'email', 'ava@gmail.test', digest('ava@gmail.test', 'sha256'));
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(pg_temp.point_sql(:lk1, :pM, :c3),
  'S-D2-1 E203: the agent''s own mailbox is never a client address, even when a TL adds it to a contact', '%MAIL_ADDRESS_IS_A_MAILBOX%');
INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
VALUES (:tA, :pBen, :c1, 'email', 'ben@gmail.test', digest('ben@gmail.test', 'sha256'));
SELECT pg_temp.expect_error(pg_temp.point_sql(:lk1, :pBen, :c1),
  'S-D2-1: nor is a teammate''s linked mailbox', '%MAIL_ADDRESS_IS_A_MAILBOX%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk1, :c3, :pM, 'ava@gmail.test', 'gS2', 'tS2'),
  'S-D2-1 E203: the sync refuses a copy filed under a live mailbox address of the tenant', '%MAIL_ADDRESS_IS_A_MAILBOX%');

-- =============================================================================
-- 3. What is stored (R-GMAIL-5, -8, -11, -12, -14)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(pg_temp.copy_sql(:m1, :lk1, :c1, :p1, 'alice@example.test', 'g1', 't1'),
  'R-GMAIL-5: a person cannot write synced mail, not even into their own mailbox''s copies (only the system)', '%MAIL_SYSTEM_ONLY%');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.expect_error(pg_temp.copy_sql(:m1, :lk1, :c1, :p1, 'alice@example.test', 'g1', 't1'),
  'R-GMAIL-5: an Owner cannot write synced mail either', '%MAIL_SYSTEM_ONLY%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.copy(:m1, :lk1, :c1, :p1, 'alice@example.test', 'g1', 't1');
SELECT pg_temp.ok((SELECT origin = 'live' FROM mail_messages WHERE id = :m1),
                  'R-GMAIL-8: mail that reached the mailbox after the link connected is live (origin computed by the DB)');
SELECT pg_temp.copy(:m2, :lk1, :c1, :p1, 'alice@example.test', 'g2', 't2', $$now() - interval '10 days'$$);
SELECT pg_temp.ok((SELECT origin = 'backfill' FROM mail_messages WHERE id = :m2),
                  'R-GMAIL-8: older mail inside the window is backfill, whatever the writer claimed');
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk1, :c1, :p1, 'alice@example.test', 'g-old', 't-old',
  $$now() - interval '31 days'$$),
  'R-GMAIL-8: history older than the backfill window is refused', '%MAIL_OLDER_THAN_BACKFILL%');
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk1, :c1, :p1, 'alice@example.test', 'g1', 't1'),
  'R-GMAIL-11: a replayed message is stored once (unique per link, message and contact)',
  '%duplicate key%mail_messages_tenant_id_link_id_gmail_message_id_contact_id_key%');
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk1, :c2, :p2, 'carol@example.test', 'g9', 't9'),
  'R-GMAIL-5: mail is stored only for a contact the mailbox owner owns, collaborates on or shares a deal with',
  '%MAIL_CONTACT_NOT_RELATED%');
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk1, :c1, :p1, 'lender@bank.test', 'g10', 't10'),
  'R-GMAIL-5 E204: a copy is filed only under the contact''s own address (never a third party''s)', '%MAIL_ADDRESS_NOT_A_CONTACT_POINT%');
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk1, :c1, :p3, 'dora@example.test', 'g11', 't11'),
  'R-GMAIL-5: a copy cannot borrow another contact''s point', '%MAIL_ADDRESS_NOT_A_CONTACT_POINT%');
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk1, :c1, :p1, 'alice@example.test', 'g12', 't12', 'now()', NULL,
  '[{"name": "contract.pdf", "mime_type": "application/pdf", "size_bytes": 1200, "data": "JVBERi0x"}]'),
  'R-GMAIL-5 E208: attachment content is never stored (name, MIME type and size only)', '%mail_messages_attachments_check%');
SELECT pg_temp.copy(:m3, :lk1, :c1, :p1, 'alice@example.test', 'g3', 't1');
SELECT pg_temp.ok((SELECT count(*) FROM mail_messages WHERE link_id = :lk1) = 3, 'the system stores copies for related contacts');
SELECT pg_temp.expect_error(format($q$UPDATE mail_messages SET body = 'edited' WHERE id = %L$q$, :m1),
  'R-GMAIL-5: a synced copy is immutable', '%permission denied%');
SELECT pg_temp.expect_error(format($q$UPDATE mail_messages SET contact_point_id = %L WHERE id = %L$q$, :p1w, :m1),
  'R-GMAIL-13: a copy is re-pointed only to a merge survivor', '%MAIL_REPOINT_INVALID%');
-- dedupe with platform email (R-GMAIL-12, E201)
INSERT INTO conversations (tenant_id, id, contact_id) VALUES (:tA, :cv1, :c1), (:tA, :cv4, :c4);
INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body, status,
       initiator, occurred_at, rfc_message_id_sha256)
VALUES (:tA, gen_random_uuid(), :cv1, :c1, 'email', 'inbound', 'alice@example.test', 'r+token@in.example.test',
        'Reply-all: Saturday works', 'received', 'client', now(), digest('<reply-all-1@mail.example.test>', 'sha256'));
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk1, :c1, :p1, 'alice@example.test', 'g13', 't13', 'now()',
  '<reply-all-1@mail.example.test>'),
  'R-GMAIL-12 E201: a Reply-All platform email already holds is not stored again (the platform row wins)',
  '%MAIL_DUPLICATE_OF_PLATFORM_EMAIL%');
-- the thread cap (E209), measured with a small cap
RESET ROLE;
UPDATE jurisdiction_packs SET rules = rules || '{"max_messages_per_thread": 2}' WHERE key = 'platform:gmail';
SET LOCAL ROLE app_user;
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk1, :c1, :p1, 'alice@example.test', 'g14', 't1'),
  'R-GMAIL-5 E209: a thread keeps at most max_messages_per_thread messages per link', '%MAIL_THREAD_TOO_LARGE%');
SELECT pg_temp.copy(gen_random_uuid(), :lk1, :c4, :p4, 'alice@example.test', 'g3', 't1');
SELECT pg_temp.ok((SELECT count(*) FROM mail_messages WHERE gmail_thread_id = 't1') = 3,
                  'R-GMAIL-5: the cap counts messages, so a second matched contact of a stored message still gets its copy');
RESET ROLE;
UPDATE jurisdiction_packs SET rules = rules - 'max_messages_per_thread' WHERE key = 'platform:gmail';
SET LOCAL ROLE app_user;
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.copy(:m4, :lk1, :c1, :p1, 'alice@example.test', 'g4', 't1');
SELECT pg_temp.ok(true, 'R-GMAIL-5: without the rule the thread cap defaults to 200');
-- assistant evidence cites a synced copy by id and time, never by quoting it (R-GMAIL-14)
RESET ROLE;
SET LOCAL session_replication_role = replica;   -- the claim row is not needed for a CHECK
SELECT pg_temp.expect_error(format($q$INSERT INTO evidence_refs (tenant_id, id, claim_id, source_type, source_id, locator, snippet,
  verbatim_verified) VALUES (%L, gen_random_uuid(), gen_random_uuid(), 'mail_message', %L, '{"kind": "mail_message"}',
  'Can we see it Saturday?', true)$q$, :tA, :m1),
  'R-GMAIL-14: evidence never quotes a synced copy', '%evidence_refs_mail_not_quoted%');
INSERT INTO evidence_refs (tenant_id, id, claim_id, source_type, source_id, locator, verbatim_verified)
VALUES (:tA, gen_random_uuid(), gen_random_uuid(), 'mail_message', :m1, '{"kind": "mail_message"}', false);
SELECT pg_temp.ok(true, 'R-GMAIL-14: evidence cites a synced copy by id (evidence_refs.source_type = mail_message)');
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE app_user;

-- =============================================================================
-- 4. Who reads the copies (R-GMAIL-6)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(pg_temp.copies(:lk1) = 5, 'R-GMAIL-6: the mailbox owner reads their own copies');
SELECT pg_temp.ctx(:tA, :tlA, 'user');
SELECT pg_temp.ok(pg_temp.copies(NULL, :c1) = 4 AND (SELECT count(*) FROM user_mail_links) = 0,
                  'R-GMAIL-6: the Team Lead reads the team''s client mail like the timeline, but never the link');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.ok(pg_temp.copies(NULL, :c1) = 4, 'R-GMAIL-6: the Owner reads it like the contact''s timeline');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok(pg_temp.copies() = 0, 'R-GMAIL-6: another agent reads none of it while Alice''s detail is hidden from them');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO contact_collaborators (tenant_id, contact_id, user_id, role, added_by_user_id) VALUES (:tA, :c1, :agA2, 'co_agent', :agA1);
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok(pg_temp.copies(NULL, :c1) = 4 AND (SELECT count(*) FROM user_mail_links) = 1,
                  'R-GMAIL-6: a collaborator reads the copies with the timeline (contact_detail_visible), not agent 1''s link');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
UPDATE contact_collaborators SET removed_at = now() WHERE tenant_id = :tA AND contact_id = :c1 AND user_id = :agA2;
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok(pg_temp.copies(NULL, :c1) = 0, 'R-GMAIL-6: and nothing once the collaboration ends');
-- a support actor under the Owner's grant (R-PERM-11) sees the tenant, but no synced mail (E220)
SELECT pg_temp.ctx(:tA, :supU, 'support');
SELECT pg_temp.ok((SELECT count(*) FROM contacts) > 0 AND pg_temp.copies() = 0 AND (SELECT count(*) FROM user_mail_links) = 0
                  AND (SELECT count(*) FROM mail_thread_exclusions) = 0 AND (SELECT count(*) FROM mail_sync_points) = 0,
                  'R-GMAIL-6 E220: a support actor reads no synced mail, link, exclusion or confirmed address, even under an Owner''s support grant');
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk1, :c1, :p1, 'alice@example.test', 'g-sup', 't-sup'),
  'R-PERM-11: a support actor writes no synced mail', '%SUPPORT_READ_ONLY%');
-- a client principal (Layer 1 is staff-only, E221)
SELECT pg_temp.client(:tA, 'a0000000-0000-7000-8000-0000000c1a01');
SELECT pg_temp.ok(pg_temp.copies() + (SELECT count(*) FROM user_mail_links) + (SELECT count(*) FROM mail_thread_exclusions)
                  + (SELECT count(*) FROM mail_sync_points) + (SELECT count(*) FROM marketing_publications) = 0,
                  'R-GMAIL-6 E221: a client principal reads no synced mail, link, exclusion, confirmed address or publication');
-- reassignment (E216): the new owner reads the earlier copies; the former owner's new mail is no longer stored
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.copy(:m5, :lk1, :c3, :p3, 'dora@example.test', 'g5', 't5');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.cmd('a0000000-0000-7000-8000-0000000c0030');
INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, owner_user_id,
       prev_owner_user_id, actor_kind, actor_user_id, reason_code, command_id, occurred_at)
VALUES (:tA, :c3, 2, gen_random_uuid(), 'reassigned', 'owned', 'owned', :agA2, :agA1, 'user', :ownA, 'EXCEPTION_QUEUE',
        'a0000000-0000-7000-8000-0000000c0030', now());
SELECT pg_temp.ok(pg_temp.rows_affected(format(
  $q$UPDATE contacts SET owner_user_id = %L, owned_at = now(), first_touch_due_at = NULL, release_due_at = NULL,
     inactivity_warn_at = NULL, inactivity_release_at = NULL, ownership_period_seq = 2, ownership_seq = 2,
     ownership_command_id = 'a0000000-0000-7000-8000-0000000c0030', ownership_actor_user_id = %L
     WHERE tenant_id = %L AND id = %L AND ownership_seq = 1$q$, :agA2, :ownA, :tA, :c3)) = 1,
  'the Owner reassigns Dora from agent 1 to agent 2');
SELECT pg_temp.cmd(NULL);
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok(pg_temp.copies(NULL, :c3) = 1,
                  'R-GMAIL-6 E216 S-D2-2: the new owner reads agent 1''s earlier mail with Dora, like the timeline (losing the relation hides nothing)');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(pg_temp.copies(NULL, :c3) = 1, 'R-GMAIL-6: the mailbox owner still reads their own copy');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk1, :c3, :p3, 'dora@example.test', 'g6', 't5'),
  'R-GMAIL-5 E216: agent 1''s new mail with a contact they no longer relate to is not stored', '%MAIL_CONTACT_NOT_RELATED%');
-- copies outlive neither their contact point nor the mailbox owner's confirmation (S-D2-2)
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
VALUES (:tA, :pW2, :c1, 'email', 'alice.home@example.test', digest('alice.home@example.test', 'sha256'));
INSERT INTO mail_sync_points (tenant_id, link_id, contact_point_id, contact_id) VALUES (:tA, :lk1, :p1w, :c1), (:tA, :lk1, :pW2, :c1);
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.copy(:m8, :lk1, :c1, :p1w, 'alice.work@example.test', 'gw1', 'tw1');
SELECT pg_temp.copy(:m9, :lk1, :c1, :pW2, 'alice.home@example.test', 'gw2', 'tw2');
SELECT pg_temp.ctx(:tA, :tlA, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM mail_messages WHERE id IN (:m8, :m9)) = 2, 'S-D2-2: the Team Lead reads copies under both confirmed addresses');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(pg_temp.rows_affected(format($q$DELETE FROM mail_sync_points WHERE link_id = %L AND contact_point_id = %L$q$, :lk1, :p1w)) = 1,
                  'S-D2-1: the mailbox owner stops syncing an address (deletes the confirmation)');
SELECT pg_temp.ok((SELECT count(*) FROM mail_messages WHERE id = :m8) = 0,
                  'S-D2-2: copies under a withdrawn confirmation are hidden at once from the mailbox owner');
UPDATE contact_points SET status = 'removed', removed_at = now() WHERE tenant_id = :tA AND id = :pW2;
SELECT pg_temp.ctx(:tA, :tlA, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM mail_messages WHERE id IN (:m8, :m9)) = 0,
                  'S-D2-2: copies under a removed contact point or a withdrawn confirmation are hidden at once from the timeline');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk1, :c1, :p1w, 'alice.work@example.test', 'gw3', 'tw3'),
  'S-D2-2: nothing new syncs for an address whose confirmation was withdrawn', '%MAIL_POINT_NOT_CONFIRMED%');
SELECT pg_temp.ok(pg_temp.rows_affected(format($q$DELETE FROM mail_messages WHERE id IN (%L, %L)$q$, :m8, :m9)) = 2,
                  'S-D2-2: the system still sees them, and the reconcile pass deletes copies whose point was removed or whose confirmation was withdrawn');

-- =============================================================================
-- 5. Private threads (R-GMAIL-7)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO mail_thread_exclusions (tenant_id, link_id, gmail_thread_id) VALUES (%L, %L, 't1')$q$, :tA, :lk1),
  'R-GMAIL-7: only the mailbox owner removes a thread', '%row-level security%');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO mail_thread_exclusions (tenant_id, link_id, gmail_thread_id) VALUES (%L, %L, 't1')$q$, :tA, :lk1),
  'R-GMAIL-7: the Owner cannot remove (or reveal) an agent''s thread', '%row-level security%');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO mail_thread_exclusions (tenant_id, link_id, gmail_thread_id, excluded_at) VALUES (:tA, :lk1, 't1', now() - interval '5 years');
SELECT pg_temp.ok((SELECT excluded_at = now() FROM mail_thread_exclusions WHERE link_id = :lk1 AND gmail_thread_id = 't1'),
                  'S-D2-6: the exclusion time is the database clock, never the caller''s');
SELECT pg_temp.ok(app.mail_link_live(:tA, :lk1), 'S-D2-4: the mailbox owner''s own link reads as live');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok(NOT app.mail_link_live(:tA, :lk1) AND NOT app.mail_copy_live(:tA, gen_random_uuid()),
                  'S-D2-4: another agent learns nothing about agent 1''s link (the link check reads under their own RLS; the copy check needs a copy)');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(pg_temp.copies(NULL, :c1) = 1, 'R-GMAIL-7 E212: the removed thread''s copies are hidden at once from the mailbox owner');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.ok(pg_temp.copies(NULL, :c1) = 1, 'R-GMAIL-7: and from everyone else');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.ok(pg_temp.copies(NULL, :c1) = 4, 'R-GMAIL-7: the system still sees the hidden copies, to delete them');
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk1, :c1, :p1, 'alice@example.test', 'g7', 't1'),
  'R-GMAIL-7: later messages in a removed thread are never stored', '%MAIL_THREAD_EXCLUDED%');
SELECT pg_temp.ok(pg_temp.rows_affected(format($q$DELETE FROM mail_thread_exclusions WHERE link_id = %L$q$, :lk1)) = 0,
                  'R-GMAIL-7: the system does not lift an exclusion while the link lives');
SELECT pg_temp.ok(pg_temp.rows_affected($q$DELETE FROM mail_messages WHERE gmail_thread_id = 't1'$q$) = 4,
                  'R-GMAIL-7: the reconcile pass deletes the removed thread''s copies');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(pg_temp.rows_affected(format($q$DELETE FROM mail_thread_exclusions WHERE link_id = %L$q$, :lk1)) = 0,
                  'R-GMAIL-7: an exclusion is final (the mailbox owner cannot un-exclude)');
SELECT pg_temp.expect_error(format($q$UPDATE mail_thread_exclusions SET gmail_thread_id = 't2' WHERE link_id = %L$q$, :lk1),
  'R-GMAIL-7: an exclusion is never edited', '%permission denied%');

-- =============================================================================
-- 6. Merge re-point and erasure (R-GMAIL-13, E223, E224), opt-out provenance (R-GMAIL-9)
-- =============================================================================
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.copy(:m6, :lk1, :c4, :p4, 'alice@example.test', 'g8', 't8');
SELECT pg_temp.copy(:m7, :lk1, :c5, :p5, 'erin@example.test', 'g15', 't15');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
UPDATE contacts SET merged_into_contact_id = :c1 WHERE id = :c4;
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk1, :c4, :p4, 'alice@example.test', 'g16', 't16'),
  'R-GMAIL-5: nothing new is stored for a merged contact', '%MAIL_CONTACT_NOT_RELATED%');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(pg_temp.rows_affected(format($q$UPDATE mail_messages SET contact_id = %L, contact_point_id = %L WHERE id = %L$q$,
                  :c1, :p1, :m6)) = 0, 'R-GMAIL-13: a person cannot re-point a copy');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(format($q$UPDATE mail_messages SET contact_id = %L, contact_point_id = %L WHERE id = %L$q$, :c2, :p2, :m6),
  'R-GMAIL-13: a copy moves only to the merge survivor', '%MAIL_REPOINT_INVALID%');
SELECT pg_temp.expect_error(format($q$UPDATE mail_messages SET contact_id = %L, contact_point_id = %L WHERE id = %L$q$, :c1, :p1w, :m6),
  'R-GMAIL-13: the survivor''s point must carry the same address HMAC', '%MAIL_REPOINT_INVALID%');
SELECT pg_temp.expect_error(format($q$UPDATE mail_messages SET contact_id = %L, contact_point_id = %L, subject = 'x' WHERE id = %L$q$,
  :c1, :p1, :m6), 'R-GMAIL-13: a re-point changes nothing else', '%permission denied%');
UPDATE mail_messages SET contact_id = :c1, contact_point_id = :p1 WHERE id = :m6;
SELECT pg_temp.ok((SELECT contact_id = :c1 FROM mail_messages WHERE id = :m6),
                  'R-GMAIL-13 E223: the system re-points a merged contact''s copy to the survivor (same address HMAC)');
INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body, status,
       initiator, occurred_at, rfc_message_id_sha256)
VALUES (:tA, gen_random_uuid(), :cv4, :c4, 'email', 'inbound', 'alice@example.test', 'r+token@in.example.test',
        'From the duplicate''s thread', 'received', 'client', now(), digest('<dup-thread-1@mail.example.test>', 'sha256'));
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk1, :c1, :p1, 'alice@example.test', 'g17', 't17', 'now()',
  '<dup-thread-1@mail.example.test>'),
  'R-GMAIL-12: dedupe also covers platform email held by a contact merged into this one', '%MAIL_DUPLICATE_OF_PLATFORM_EMAIL%');
-- opt-out provenance (R-GMAIL-9): the consent event cites the copy in evidence and outlives it
INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose, event_type, consent_level,
       source, occurred_at, contact_id, actor_kind, evidence)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ce71', 'email', digest('erin@example.test', 'sha256'), 'e•••@example.test', 'email', 'all',
        'revoke', 'none', 'inbound_keyword', now(), :c5, 'system',
        jsonb_build_object('kind', 'synced_gmail', 'mail_message_id', :m7, 'matched', 'UNSUBSCRIBE'));
SELECT pg_temp.ok(true, 'R-GMAIL-9: an unsubscribe in a synced Gmail message is a revoke citing the copy (source inbound_keyword)');
SELECT pg_temp.expect_error(format($q$INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel,
  purpose, event_type, consent_level, source, occurred_at, contact_id, actor_kind, evidence) VALUES (%L, gen_random_uuid(), 'email',
  digest('erin@example.test', 'sha256'), 'e@', 'email', 'marketing', 'grant', 'express', 'inbound_keyword', now(), %L, 'system',
  jsonb_build_object('kind', 'synced_gmail', 'mail_message_id', %L))$q$, :tA, :c5, :m7),
  'R-GMAIL-9: synced mail never lifts an opt-out (no grant from a synced copy)', '%consent_events_synced_gmail%');
SELECT pg_temp.expect_error(format($q$INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel,
  purpose, event_type, consent_level, source, occurred_at, contact_id, actor_kind, evidence) VALUES (%L, gen_random_uuid(), 'email',
  digest('erin@example.test', 'sha256'), 'e@', 'email', 'all', 'revoke', 'none', 'inbound_keyword', now(), %L, 'system',
  '{"kind": "synced_gmail"}')$q$, :tA, :c5),
  'R-GMAIL-9: an opt-out from synced mail names the copy it came from', '%consent_events_synced_gmail%');
-- S-D2-3, E229: an opt-out in a Gmail message that was not stored (here: in the excluded thread t1) is still recorded,
-- citing the message by reference (sha256 hex of link id + Gmail message id)
INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose, event_type, consent_level,
       source, occurred_at, contact_id, actor_kind, evidence)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ce72', 'email', digest('alice@example.test', 'sha256'), 'a•••@example.test', 'email', 'all',
        'revoke', 'none', 'inbound_keyword', now(), :c1, 'system',
        jsonb_build_object('kind', 'synced_gmail', 'gmail_message_ref', encode(digest(:lk1 || ':gX1', 'sha256'), 'hex'), 'matched', 'UNSUBSCRIBE'));
SELECT pg_temp.ok((SELECT evidence->>'gmail_message_ref' ~ '^[0-9a-f]{64}$' FROM consent_events WHERE id = 'a0000000-0000-7000-8000-00000000ce72'),
                  'S-D2-3 R-GMAIL-9 E229: an unsubscribe in a Gmail thread the agent excluded is recorded (citing the message by reference); nothing is stored');
SELECT pg_temp.expect_error(format($q$INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel,
  purpose, event_type, consent_level, source, occurred_at, contact_id, actor_kind, evidence_message_id, evidence) VALUES (%L, gen_random_uuid(),
  'email', digest('erin@example.test', 'sha256'), 'e@', 'email', 'informational', 'grant', 'express', 'inbound_first_contact', now(), %L,
  'system', %L, jsonb_build_object('mail_message_id', %L))$q$, :tA, :c5, :m7, :m7),
  'S-D2-5: an unlabelled grant that cites a synced copy is refused (the CHECK keys on the citation, not the label)', '%consent_events_synced_gmail%');
SELECT pg_temp.expect_error(format($q$INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel,
  purpose, event_type, consent_level, source, occurred_at, contact_id, actor_kind, evidence) VALUES (%L, gen_random_uuid(), 'email',
  digest('erin@example.test', 'sha256'), 'e@', 'email', 'all', 'revoke', 'none', 'inbound_keyword', now(), %L, 'system',
  jsonb_build_object('gmail_message_ref', repeat('ab', 32)))$q$, :tA, :c5),
  'S-D2-5: a Gmail message reference must come with the synced_gmail label', '%consent_events_synced_gmail%');
SELECT pg_temp.expect_error(format($q$INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel,
  purpose, event_type, consent_level, source, occurred_at, contact_id, actor_kind, evidence) VALUES (%L, gen_random_uuid(), 'email',
  digest('erin@example.test', 'sha256'), 'e@', 'email', 'all', 'revoke', 'none', 'inbound_keyword', now(), %L, 'system',
  jsonb_build_object('kind', 'synced_gmail', 'gmail_message_ref', 'not-a-hash'))$q$, :tA, :c5),
  'S-D2-3 S-D2-5: a Gmail message reference is a SHA-256 hex digest', '%consent_events_synced_gmail%');
SELECT pg_temp.expect_error(format($q$INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel,
  purpose, event_type, consent_level, source, occurred_at, contact_id, actor_kind, evidence) VALUES (%L, gen_random_uuid(), 'email',
  digest('erin@example.test', 'sha256'), 'e@', 'email', 'all', 'revoke', 'none', 'inbound_keyword', now(), %L, 'system',
  jsonb_build_object('kind', 'synced_gmail', 'gmail_message_ref', repeat('ab', 32), 'mail_message_id', %L))$q$, :tA, :c5, :m7),
  'S-D2-5: an event cites either the stored copy or the message reference, not both', '%consent_events_synced_gmail%');
-- erasure (R-DATA-7, E224): the contact goes, and so do its copies
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT app.erase_contact(:c5, gen_random_uuid(), 'privacy request');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.ok(pg_temp.copies(NULL, :c5) = 0 AND NOT EXISTS (SELECT 1 FROM contacts WHERE id = :c5),
                  'R-GMAIL-13 R-DATA-7 E224: erasing a contact deletes its synced copies');
SELECT pg_temp.ok((SELECT evidence->>'mail_message_id' = :m7 FROM consent_events WHERE id = 'a0000000-0000-7000-8000-00000000ce71'),
                  'R-GMAIL-9: the opt-out survives the deletion of the copy it cites');

-- =============================================================================
-- 7. Sync off, pack uncleared, member inactive, disconnect: hidden at once, then purged (R-GMAIL-1, -13)
-- =============================================================================
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.copy(gen_random_uuid(), :lk2, :c2, :p2, 'carol@example.test', 'h1', 'u1');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.ok(pg_temp.copies() = 4, 'the Owner reads the live copies before any switch changes');
SELECT pg_temp.ctx(:tA, :admA, 'user');
UPDATE tenant_settings SET mail_sync_enabled = false;
SELECT pg_temp.ok(pg_temp.copies() = 0, 'R-GMAIL-1 E222: an Admin may turn Gmail sync off, and every copy is hidden at once');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(pg_temp.copies() = 0, 'R-GMAIL-1: hidden from the mailbox owner too');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.ok(pg_temp.copies() = 4, 'R-GMAIL-13: the system still sees them, to delete them in the next pass');
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk1, :c1, :p1, 'alice@example.test', 'g18', 't18'),
  'R-GMAIL-1: nothing is stored while sync is off', '%MAIL_SYNC_OFF%');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
UPDATE tenant_settings SET mail_sync_enabled = true;
SELECT pg_temp.ok(pg_temp.copies() = 4, 'the Owner turns it back on');
RESET ROLE;
UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:gmail';
SET LOCAL ROLE app_user;
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.ok(pg_temp.copies() = 0, 'R-GMAIL-1: a pack that is no longer cleared hides every copy at once');
RESET ROLE;
UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:gmail';
SET LOCAL ROLE app_user;
SELECT pg_temp.ctx(:tA, :ownA, 'user');
UPDATE memberships SET status = 'suspended' WHERE tenant_id = :tA AND user_id = :agA2;
SELECT pg_temp.ok(pg_temp.copies(:lk2) = 0 AND pg_temp.copies(:lk1) = 3,
                  'R-GMAIL-13 E215: an inactive member''s copies are hidden at once (others'' stay)');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk2, :c2, :p2, 'carol@example.test', 'h2', 'u2'),
  'R-GMAIL-13: nothing is stored for an inactive member''s link', '%MAIL_SYNC_OFF%');
-- disconnect (R-GMAIL-4, -13)
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format($q$UPDATE user_mail_links SET status = 'revoked', revoke_reason = 'USER_DISCONNECTED', refresh_enc = NULL,
  purge_after = now() + interval '30 days', history_id = '1', last_error_code = 'FORGED_BY_USER', next_sync_at = now(),
  backfill_done_at = '2000-01-01', key_version = 999 WHERE id = %L$q$, :lk1),
  'S-D2-6: a person''s disconnect cannot also rewrite the system''s sync state', '%MAIL_LINK_SYSTEM_ONLY%');
SELECT pg_temp.expect_error(format($q$UPDATE user_mail_links SET status = 'revoked', revoked_at = now(), revoke_reason = 'PROVIDER_REVOKED',
  refresh_enc = NULL, purge_after = now() + interval '30 days' WHERE id = %L$q$, :lk1),
  'R-GMAIL-13: a person disconnects only as USER_DISCONNECTED', '%MAIL_LINK_SYSTEM_ONLY%');
SELECT pg_temp.expect_error(format($q$UPDATE user_mail_links SET status = 'revoked', revoked_at = now(), revoke_reason = 'USER_DISCONNECTED',
  purge_after = now() + interval '30 days' WHERE id = %L$q$, :lk1),
  'R-GMAIL-4: a revoked link holds no token (deleted in the same transaction)', '%check constraint%');
SELECT pg_temp.expect_error(format($q$UPDATE user_mail_links SET status = 'revoked', revoked_at = now() + interval '1 year',
  revoke_reason = 'USER_DISCONNECTED', refresh_enc = NULL, purge_after = now() + interval '1 year' WHERE id = %L$q$, :lk1),
  'R-GMAIL-13: the link is purged within 30 days of the revoke (the revoke time is the database''s)', '%check constraint%');
UPDATE user_mail_links SET status = 'revoked', revoke_reason = 'USER_DISCONNECTED', refresh_enc = NULL, purge_after = now() + interval '30 days'
 WHERE id = :lk1;
SELECT pg_temp.ok((SELECT refresh_enc IS NULL AND revoked_at = now() FROM user_mail_links WHERE id = :lk1),
                  'R-GMAIL-4 R-GMAIL-13: the mailbox owner disconnects; the token is gone at once');
SELECT pg_temp.ok(pg_temp.copies() = 0, 'R-GMAIL-13: a disconnected mailbox''s copies are hidden at once');
SELECT pg_temp.expect_error(format($q$UPDATE user_mail_links SET backfill_requested_at = NULL WHERE id = %L$q$, :lk1),
  'R-GMAIL-13: a disconnected link cannot be used again', '%MAIL_LINK_REVOKED%');
SELECT pg_temp.expect_error(format($q$INSERT INTO mail_thread_exclusions (tenant_id, link_id, gmail_thread_id) VALUES (%L, %L, 't9')$q$, :tA, :lk1),
  'R-GMAIL-7: a revoked link takes no new exclusions', '%row-level security%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(format($q$UPDATE user_mail_links SET status = 'connected', revoked_at = NULL, revoke_reason = NULL,
  purge_after = NULL, refresh_enc = '\x01' WHERE id = %L$q$, :lk1),
  'R-GMAIL-13: a revoked link stays revoked (connecting again is a new link)', '%MAIL_LINK_REVOKED%');
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lk1, :c1, :p1, 'alice@example.test', 'g19', 't19'),
  'R-GMAIL-13: nothing is stored for a disconnected link', '%MAIL_SYNC_OFF%');
-- a new link for the same mailbox is allowed once the old one is revoked
SELECT pg_temp.ok(pg_temp.rows_affected(pg_temp.link_sql(gen_random_uuid(), :agA1, 'ava@gmail.test')) = 1,
                  'R-GMAIL-2: after a disconnect the agent may connect the same mailbox again (a new link)');
-- purge (module 68's reconcile pass, system actor)
SELECT pg_temp.ok(pg_temp.rows_affected(format($q$DELETE FROM user_mail_links WHERE id = %L$q$, :lk2)) = 0,
                  'R-GMAIL-13: a live link is never purged');
SELECT pg_temp.ok(pg_temp.rows_affected(format($q$DELETE FROM mail_messages WHERE link_id = %L$q$, :lk1)) = 3,
                  'R-GMAIL-13: the reconcile pass deletes a disconnected link''s copies');
SELECT pg_temp.ok(pg_temp.rows_affected(format($q$DELETE FROM user_mail_links WHERE id = %L$q$, :lk1)) = 1,
                  'R-GMAIL-13: the system purges the revoked link');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM mail_thread_exclusions WHERE link_id = :lk1),
                  'R-GMAIL-7 R-GMAIL-13: its exclusions go with it (cascade)');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(pg_temp.rows_affected($q$DELETE FROM user_mail_links$q$) + pg_temp.rows_affected($q$DELETE FROM mail_messages$q$) = 0,
                  'R-GMAIL-13: only the system purges (a person deletes no link or copy)');

SELECT pg_temp.ctx(:tA, :ownA, 'user');
UPDATE memberships SET status = 'active' WHERE tenant_id = :tA AND user_id = :agA2;

-- =============================================================================
-- 8. Publishing to Facebook Pages, Instagram business accounts and GBP (R-MKT-12)
-- =============================================================================
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO lead_sources (tenant_id, id, name, kind) VALUES (:tA, :srcA, 'Facebook Page', 'social_dm');
SELECT pg_temp.expect_error(format($q$INSERT INTO integration_connections (tenant_id, id, kind, status, display_name, external_account_id,
  connected_at) VALUES (%L, gen_random_uuid(), 'facebook_page', 'connected', 'Team A Page', '5001', now())$q$, :tA),
  'R-MKT-12: an Owner cannot mark a Facebook Page connected (only the provider callback links an external account)',
  '%CONNECTION_PROOF_REQUIRED%');
INSERT INTO integration_connections (tenant_id, id, kind, display_name) VALUES
  (:tA, :fbA, 'facebook_page', 'Team A Page'), (:tA, :igA, 'instagram_business', 'Team A Instagram'),
  (:tA, :gbpA, 'gbp_location', 'Team A on Google');
SELECT pg_temp.ctx(:tA, NULL, 'system');
INSERT INTO provider_credentials (tenant_id, id, provider, secret_enc, key_version) VALUES (:tA, :credA, 'meta', '\x01', 1);
SELECT pg_temp.expect_error(format($q$UPDATE integration_connections SET status = 'connected', connected_at = now(), external_account_id = '5001',
  credential_id = %L, lead_source_id = %L WHERE id = %L$q$, :credA, :srcA, :fbA),
  'R-MKT-12 E228: a publishing-only Page is never an inbound channel (no lead source)', '%integration_connections_publishing_no_source%');
UPDATE integration_connections SET status = 'connected', connected_at = now(), external_account_id = '5001', credential_id = :credA WHERE id = :fbA;
UPDATE integration_connections SET status = 'connected', connected_at = now(), external_account_id = 'loc-1', credential_id = :credA WHERE id = :gbpA;
SELECT pg_temp.ok((SELECT count(*) FROM integration_connections WHERE status = 'connected') = 2,
                  'R-MKT-12: the callback connects the Page and the GBP location without a lead source');
-- approved pieces: a social post, a GBP post and a flyer
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO marketing_pieces (tenant_id, id, listing_id, kind, version_no, prose, template_key, guard_result, created_by_user_id) VALUES
  (:tA, :pcS, :lA, 'social_post', 1, '{"headline": "Open Saturday at 12 Oak St"}', 'social/1', :GOOD, :agA1),
  (:tA, :pcG, :lA, 'gbp_post', 1, '{"headline": "New listing: 12 Oak St"}', 'gbp/1', :GOOD, :agA1),
  (:tA, :pcF, :lA, 'flyer', 1, '{"headline": "12 Oak St"}', 'flyer/1', :GOOD, :agA1);
UPDATE marketing_pieces SET guard_result = guard_result || jsonb_build_object('content_sha256', content_sha256),
       status = 'approved', approved_by_user_id = :agA1, approved_at = now() WHERE listing_id = :lA;
SELECT pg_temp.ok((SELECT count(*) FROM marketing_pieces WHERE status = 'approved') = 3, 'the listing agent approves the three pieces');
SELECT pg_temp.expect_error(format($q$INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, requested_by_user_id)
  VALUES (%L, %L, %L, %L, %L)$q$, :tA, :pub1, :pcS, :fbA, :agA1),
  'R-MKT-12: publishing waits for counsel review of platform:fair_housing (export otherwise)', '%PLATFORM_NOT_CLEARED%');
RESET ROLE;
UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:fair_housing';
SET LOCAL ROLE app_user;
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, status, external_post_id,
  published_at, requested_by_user_id) VALUES (%L, %L, %L, %L, 'published', 'fb_post_1', now(), %L)$q$, :tA, :pub1, :pcS, :fbA, :agA1),
  'R-MKT-12: a person cannot record a post as published (a publication starts as an attempt)', '%PUBLICATION_BORN_PUBLISHING%');
SELECT pg_temp.expect_error(format($q$INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, requested_by_user_id)
  VALUES (%L, %L, %L, %L, %L)$q$, :tA, :pub1, :pcS, :fbA, :agA2),
  'R-MKT-12: a person publishes as themselves', '%PUBLICATION_HUMAN_TAP%');
SELECT pg_temp.expect_error(format($q$INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, requested_by_user_id)
  VALUES (%L, %L, %L, %L, %L)$q$, :tA, :pub1, :pcS, :gbpA, :agA1),
  'R-MKT-12: a social post goes only to a Facebook Page or Instagram business account', '%PUBLISH_TARGET_INVALID%');
SELECT pg_temp.expect_error(format($q$INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, requested_by_user_id)
  VALUES (%L, %L, %L, %L, %L)$q$, :tA, :pub1, :pcG, :fbA, :agA1),
  'R-MKT-12: a GBP post goes only to a GBP location', '%PUBLISH_TARGET_INVALID%');
SELECT pg_temp.expect_error(format($q$INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, requested_by_user_id)
  VALUES (%L, %L, %L, %L, %L)$q$, :tA, :pub1, :pcF, :fbA, :agA1),
  'R-MKT-12: a flyer is exported, never published to a social account', '%PUBLISH_TARGET_INVALID%');
SELECT pg_temp.expect_error(format($q$INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, requested_by_user_id)
  VALUES (%L, %L, %L, %L, %L)$q$, :tA, :pub1, :pcS, :igA, :agA1),
  'R-MKT-12: only a connected account takes a post (export otherwise)', '%CHANNEL_NOT_CONNECTED%');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, requested_by_user_id)
  VALUES (%L, %L, %L, %L, %L)$q$, :tA, :pub1, :pcS, :fbA, :agA2),
  'R-MKT-12: only the listing''s writers publish its pieces', '%row-level security%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(format($q$INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, requested_by_user_id)
  VALUES (%L, %L, %L, %L, %L)$q$, :tA, :pub1, :pcS, :fbA, :agA1),
  'R-MKT-12: the system never publishes on a person''s behalf (TX1 is a person''s tap)', '%PUBLICATION_HUMAN_TAP%');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, requested_by_user_id, requested_at)
VALUES (:tA, :pub1, :pcS, :fbA, :agA1, now() - interval '3 days');
SELECT pg_temp.ok((SELECT status = 'publishing' AND requested_at = now() FROM marketing_publications WHERE id = :pub1),
                  'R-MKT-12: the listing agent taps Publish; TX1 records the attempt as themselves (database clock)');
SELECT pg_temp.expect_error(format($q$INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, requested_by_user_id)
  VALUES (%L, gen_random_uuid(), %L, %L, %L)$q$, :tA, :pcS, :fbA, :agA1),
  'R-MKT-12: one live publication per piece and target (a second tap never double-posts)', '%marketing_publications_one_live%');
SELECT pg_temp.ok(pg_temp.rows_affected(format($q$UPDATE marketing_publications SET status = 'published', external_post_id = 'fb_post_1',
  published_at = now() WHERE id = %L$q$, :pub1)) = 0, 'R-MKT-12: the person cannot mark the post published');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.ok(pg_temp.rows_affected(format($q$UPDATE marketing_publications SET status = 'published', external_post_id = 'fb_post_1',
  published_at = now() WHERE id = %L$q$, :pub1)) = 0
                  AND (SELECT count(*) FROM marketing_publications) = 1,
                  'R-MKT-12: neither can the Owner, who still reads the attempt');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(format($q$UPDATE marketing_publications SET status = 'published', published_at = now() WHERE id = %L$q$, :pub1),
  'R-MKT-12: "published" only with the provider''s post id', '%check constraint%');
SELECT pg_temp.expect_error(format($q$UPDATE marketing_publications SET external_post_id = 'fb_post_1' WHERE id = %L$q$, :pub1),
  'R-MKT-12: an attempt carries no post id', '%check constraint%');
UPDATE marketing_publications SET status = 'unknown', error_code = 'PROVIDER_TIMEOUT' WHERE id = :pub1;
SELECT pg_temp.ok((SELECT status = 'unknown' FROM marketing_publications WHERE id = :pub1),
                  'R-MKT-12 E227: a timed-out publish is recorded as unknown by the system');
SELECT pg_temp.expect_error(format($q$UPDATE marketing_publications SET status = 'publishing', error_code = NULL WHERE id = %L$q$, :pub1),
  'R-MKT-12 E227: an unknown attempt is reconciled by lookup, never re-posted (forward only)', '%PUBLICATION_FORWARD_ONLY%');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, requested_by_user_id)
  VALUES (%L, gen_random_uuid(), %L, %L, %L)$q$, :tA, :pcS, :fbA, :agA1),
  'R-MKT-12 E227: an unknown attempt blocks a blind re-post', '%marketing_publications_one_live%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
UPDATE marketing_publications SET status = 'published', external_post_id = 'fb_post_1', published_at = now(), error_code = NULL WHERE id = :pub1;
SELECT pg_temp.ok((SELECT status = 'published' AND external_post_id = 'fb_post_1' FROM marketing_publications WHERE id = :pub1),
                  'R-MKT-12: the lookup confirms the post; the system records it with the provider''s post id');
SELECT pg_temp.expect_error(format($q$UPDATE marketing_publications SET external_post_id = 'fb_post_2' WHERE id = %L$q$, :pub1),
  'R-MKT-12: the provider''s post id is written once', '%PUBLICATION_POST_ID_FINAL%');
SELECT pg_temp.expect_error(format($q$UPDATE marketing_publications SET status = 'failed', error_code = 'X' WHERE id = %L$q$, :pub1),
  'R-MKT-12: a published post never becomes failed (forward only)', '%PUBLICATION_FORWARD_ONLY%');
SELECT pg_temp.expect_error(format($q$UPDATE marketing_publications SET connection_id = %L WHERE id = %L$q$, :igA, :pub1),
  'R-MKT-12: a publication never moves to another account', '%PUBLICATION_IMMUTABLE%');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok(pg_temp.rows_affected(format($q$UPDATE marketing_publications SET status = 'retracted', retracted_at = now() WHERE id = %L$q$,
                  :pub1)) = 0, 'R-MKT-12: a person cannot record a retraction (the provider confirms the deletion)');
SELECT pg_temp.ctx(:tA, NULL, 'system');
UPDATE marketing_publications SET status = 'retracted', retracted_at = now() WHERE id = :pub1;
SELECT pg_temp.expect_error(format($q$UPDATE marketing_publications SET status = 'published', retracted_at = NULL WHERE id = %L$q$, :pub1),
  'R-MKT-12: a retraction is final (forward only)', '%PUBLICATION_FORWARD_ONLY%');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, requested_by_user_id) VALUES
  (:tA, :pub2, :pcS, :fbA, :agA1), (:tA, :pub3, :pcG, :gbpA, :agA1);
SELECT pg_temp.ok((SELECT count(*) FROM marketing_publications WHERE status = 'publishing') = 2,
                  'R-MKT-12: after a retraction the piece may be published again; a GBP post goes to its location');
SELECT pg_temp.ctx(:tA, NULL, 'system');
UPDATE marketing_publications SET status = 'failed', error_code = 'PROVIDER_REJECTED' WHERE id = :pub3;
SELECT pg_temp.expect_error(format($q$UPDATE marketing_publications SET status = 'published', external_post_id = 'g1', published_at = now(),
  error_code = NULL WHERE id = %L$q$, :pub3), 'R-MKT-12: a failed attempt stays failed (a retry is a new attempt)', '%PUBLICATION_FORWARD_ONLY%');

-- =============================================================================
-- 9. Tenant isolation of every new table (R-TEN-1), from tenant B's Owner and system
-- =============================================================================
SELECT pg_temp.ctx(:tB, :ownB, 'user');
SELECT pg_temp.ok(pg_temp.rows_affected(pg_temp.point_sql(:lkB, :pB, :cB)) = 1, 'tenant B''s Owner confirms Bob''s address');
SELECT pg_temp.ctx(:tB, NULL, 'system');
SELECT pg_temp.copy(:mB, :lkB, :cB, :pB, 'bob@example.test', 'b1', 'bt1');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.ok((SELECT count(*) FROM mail_messages WHERE tenant_id = :tB) + (SELECT count(*) FROM user_mail_links WHERE tenant_id = :tB) = 0,
                  'R-TEN-1: tenant A''s system reads none of tenant B''s mail or links');
SELECT pg_temp.expect_error(pg_temp.copy_sql(gen_random_uuid(), :lkB, :cB, :pB, 'bob@example.test', 'b2', 'bt2'),
  'R-TEN-1: tenant A''s system cannot file mail under tenant B''s link', '%MAIL_SYNC_OFF%');
DO $$
DECLARE t text; n bigint; bad text := ''; ctxs text[] := ARRAY['owner','system']; c text;
BEGIN
  FOREACH c IN ARRAY ctxs LOOP
    IF c = 'owner' THEN PERFORM pg_temp.ctx('b0000000-0000-7000-8000-000000000001', 'b0000000-0000-7000-8000-0000000000b0', 'user');
    ELSE PERFORM pg_temp.ctx('b0000000-0000-7000-8000-000000000001', NULL, 'system'); END IF;
    FOREACH t IN ARRAY ARRAY['marketing_publications','user_mail_links','mail_thread_exclusions','mail_sync_points','mail_messages'] LOOP
      EXECUTE format('SELECT count(*) FROM public.%I WHERE tenant_id = %L', t, 'a0000000-0000-7000-8000-000000000001') INTO n;
      IF n <> 0 THEN bad := bad || ' ' || c || ':' || t; END IF;
      EXECUTE format('SELECT count(*) FROM public.%I WHERE tenant_id <> %L', t, 'b0000000-0000-7000-8000-000000000001') INTO n;
      IF n <> 0 THEN bad := bad || ' ' || c || ':' || t || '(any)'; END IF;
    END LOOP;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'FAIL  tenant B read tenant A rows:%', bad; END IF;
  RAISE NOTICE 'PASS  R-TEN-1 R-GMAIL-6 R-MKT-12: cross-tenant denial: tenant B''s Owner and system read 0 tenant A rows from every D2 table';
END $$;
SELECT pg_temp.ctx(:tB, NULL, 'system');
SELECT pg_temp.expect_error(format($q$INSERT INTO user_mail_links (tenant_id, id, user_id, provider, mailbox_address, mailbox_address_hmac,
  scopes, disclosure_sha256, status, refresh_enc, key_version, connected_at) VALUES (%L, gen_random_uuid(), %L, 'gmail', 'x@gmail.test',
  digest('x@gmail.test', 'sha256'), ARRAY['https://www.googleapis.com/auth/gmail.readonly'], repeat('cd', 32), 'connected', '\x01', 1, now())$q$,
  :tA, :agA1),
  'R-TEN-1: tenant B cannot link a mailbox into tenant A', '%row-level security%');
SELECT pg_temp.expect_error(format($q$INSERT INTO mail_thread_exclusions (tenant_id, link_id, gmail_thread_id) VALUES (%L, %L, 'x')$q$, :tA, :lk2),
  'R-TEN-1: tenant B cannot exclude a tenant A thread', '%row-level security%');
SELECT pg_temp.expect_error(format($q$INSERT INTO mail_sync_points (tenant_id, link_id, contact_point_id, contact_id) VALUES (%L, %L, %L, %L)$q$,
  :tA, :lk2, :p2, :c2), 'R-TEN-1: tenant B cannot confirm an address on a tenant A link', '%row-level security%');
SELECT pg_temp.expect_error(format($q$INSERT INTO mail_messages (tenant_id, id, link_id, contact_id, contact_point_id, contact_address_hmac,
  gmail_message_id, gmail_thread_id, sender, contact_role, body, internal_at, origin) VALUES (%L, gen_random_uuid(), %L, %L, %L,
  digest('carol@example.test', 'sha256'), 'x', 'x', 'contact', 'from', 'x', now(), 'live')$q$, :tA, :lk2, :c2, :p2),
  'R-TEN-1: tenant B cannot write mail into tenant A', '%row-level security%');
SELECT pg_temp.ctx(:tB, :ownB, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, requested_by_user_id)
  VALUES (%L, gen_random_uuid(), %L, %L, %L)$q$, :tA, :pcS, :fbA, :ownB),
  'R-TEN-1: tenant B cannot publish tenant A''s piece', '%row-level security%');
SELECT pg_temp.ctx(NULL, NULL, NULL);
SELECT pg_temp.ok((SELECT count(*) FROM marketing_publications) + (SELECT count(*) FROM user_mail_links)
                  + (SELECT count(*) FROM mail_thread_exclusions) + (SELECT count(*) FROM mail_sync_points)
                  + (SELECT count(*) FROM mail_messages) = 0
                  AND NOT app.mail_link_live(:tA, :lk2) AND NOT app.mail_copy_live(:tB, :mB),
                  'R-TEN-2: with no tenant context every D2 table reads empty and app.mail_link_live / app.mail_copy_live are false');
SELECT pg_temp.expect_error(format($q$INSERT INTO mail_sync_points (tenant_id, link_id, contact_point_id, contact_id) VALUES (%L, %L, %L, %L)$q$,
  :tB, :lkB, :pB, :cB), 'R-TEN-2 S-D2-4: with no tenant context the definer guard reads nothing and RLS refuses the confirmation', '%row-level security%');

-- =============================================================================
-- 10. Definers and dropped objects (S-D2-4, S-D2-8)
-- =============================================================================
SELECT pg_temp.ok(to_regprocedure('app.mail_sync_live(uuid,uuid,text)') IS NULL
                  AND (SELECT prosecdef FROM pg_proc WHERE oid = 'app.mail_copy_live(uuid,uuid)'::regprocedure)
                  AND NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'app.mail_link_live(uuid,uuid)'::regprocedure)
                  AND NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'app.mail_contact_related(uuid,uuid,uuid)'::regprocedure),
                  'S-D2-4: no definer answers for a link or a thread by id; app.mail_copy_live takes only a copy''s identity and the link check is an invoker function');
SELECT pg_temp.ok((SELECT bool_and(pg_get_userbyid(proowner) = 'app_definer' AND proconfig @> ARRAY['search_path=pg_catalog, public'])
                     FROM pg_proc WHERE oid IN ('app.mail_copy_live(uuid,uuid)'::regprocedure, 'app.mail_sync_points_guard()'::regprocedure))
                  AND NOT has_function_privilege('app_user', 'app.mail_sync_points_guard()', 'EXECUTE')
                  AND NOT has_function_privilege('public', 'app.mail_copy_live(uuid,uuid)', 'EXECUTE'),
                  'S-D2-4: both new definers are owned by app_definer with a pinned search_path; the definer trigger is executable by nobody');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'mail_messages' AND column_name = 'search_tsv')
                  AND to_regclass('public.mail_messages_tsv_idx') IS NULL,
                  'S-D2-8: mail_messages has no full-text column or index (synced mail is not searched in v1)');

SELECT pg_temp.ok(true, 'ALL D2 GMAIL RLS SMOKE CHECKS PASSED');
ROLLBACK;
