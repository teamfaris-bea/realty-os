-- Batch 19, team-queue lane step 2 (handoff visibility; owner decisions 2026-11-19, 1 and 2): the minute-three
-- backup alert. DATA_MODEL R-TEAMQ-14 to R-TEAMQ-17. Security notes: docs/ARCHITECTURE.md §21.73.
--
--   When a covered source's inbound inquiry has had no human attempt after three minutes of staffed time, the
--   source's backup is alerted (apps/api leads/backupAlert.ts, the job `leads.backup_alert`). It alerts only: it
--   never changes an owner, an offer or a pond, and it never sends anything to the client.
--
--   * lead_backup_alerts: the record of each minute-three decision, ONE row per inquiry (lead_backup_alerts_inquiry_once
--     is what makes the job idempotent on the inquiry id), written once by the system and never changed:
--       inquiry_id, lead_source_id   which inquiry, of which source (the person is the inquiry's contact, so a merge
--                                    or an erasure follows the inquiry: no second pointer to a person is kept)
--       arrived_at, due_at, decided_at  the arrival, three staffed minutes after it, and when the job decided
--       outcome                      alerted | human_attempt (a person had already called, texted, emailed or replied
--                                    in chat) | answered_call (a person had answered the lead's own call) |
--                                    source_not_covered (coverage was switched off in between) | no_recipient (the
--                                    backup is unavailable and whoever has the lead has no team lead) | lead_closed
--       alerted_user_id, recipient   who was alerted: the source's named `backup`, or, when that person is absent or
--                                    suspended, the `team_lead` of whoever has the lead (owner decision 2)
--       holder, holder_user_id, holder_pond_id   who the lead was with then (owner, on offer, a pond, nobody)
--       grant_expires_at             until when the alerted backup may open the lead (their collaborator row)
--     Ids, codes and instants only: no name, number, address or message text. FORCE row-level security, the
--     restrictive tenant policy, the three support read-only policies and the statement trigger. Read: the
--     tenant-wide (Owner, Admin, system, support with a grant), the alerted member, and anyone who can read the
--     row's inquiry (lead_inquiries' own policy: the person's detail). Insert: the system actor only. No UPDATE or
--     DELETE grant: a row leaves only with its inquiry (ON DELETE CASCADE, when the person is erased or purged).
--   * contact_collaborators.role gains 'backup': the alerted backup's time-boxed access to that one lead. It is an
--     ordinary collaborator row (the existing visibility rule, app.my_collab_contact_ids: live rows only), so it
--     shows that member that one person and nothing else, and nothing once expires_at has passed. No policy, no
--     helper and no other member's sight changes.
--   No SECURITY DEFINER function is added or replaced. No existing row is changed.

ALTER TABLE contact_collaborators DROP CONSTRAINT contact_collaborators_role_check;
ALTER TABLE contact_collaborators ADD CONSTRAINT contact_collaborators_role_check CHECK (role IN ('isa','tc','co_agent','backup'));

CREATE TABLE lead_backup_alerts (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  id               uuid NOT NULL,
  inquiry_id       uuid NOT NULL,
  lead_source_id   uuid NOT NULL,
  arrived_at       timestamptz NOT NULL,
  due_at           timestamptz NOT NULL,
  decided_at       timestamptz NOT NULL,
  outcome          text NOT NULL CHECK (outcome IN ('alerted','human_attempt','answered_call','source_not_covered','no_recipient','lead_closed')),
  alerted_user_id  uuid,
  recipient        text CHECK (recipient IN ('backup','team_lead')),
  holder           text CHECK (holder IN ('owner','on_offer','pond','unassigned')),
  holder_user_id   uuid,
  holder_pond_id   uuid,
  grant_expires_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT lead_backup_alerts_inquiry_once UNIQUE (tenant_id, inquiry_id),
  FOREIGN KEY (tenant_id, inquiry_id)      REFERENCES lead_inquiries (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, lead_source_id)  REFERENCES lead_sources (tenant_id, id),
  FOREIGN KEY (tenant_id, alerted_user_id) REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, holder_user_id)  REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, holder_pond_id)  REFERENCES ponds (tenant_id, id) ON DELETE SET NULL (holder_pond_id),
  CHECK ((outcome = 'alerted') = (alerted_user_id IS NOT NULL)),
  CHECK ((alerted_user_id IS NULL) = (recipient IS NULL)),
  CHECK (grant_expires_at IS NULL OR recipient = 'backup')
);
COMMENT ON TABLE lead_backup_alerts IS
  'b19 (R-TEAMQ-14..17): one row per inbound inquiry of a covered source, written once by the minute-three job: who was alerted (the source''s backup, or the team lead of whoever had the lead), when and why, or why nobody was. Ids, codes and instants only. The job never changes an owner and never sends to the client.';

ALTER TABLE lead_backup_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_backup_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lead_backup_alerts AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff');
CREATE POLICY support_read_only_ins ON lead_backup_alerts AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_upd ON lead_backup_alerts AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_del ON lead_backup_alerts AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support');
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON lead_backup_alerts FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();
-- read: the tenant-wide, the alerted member (while a member), and whoever can read the row's inquiry (its own policy)
CREATE POLICY backup_alerts_select ON lead_backup_alerts FOR SELECT USING (
  (SELECT app.is_tenant_wide())
  OR (alerted_user_id = (SELECT app.user_id()) AND (SELECT app.my_role()) IS NOT NULL)
  OR EXISTS (SELECT 1 FROM lead_inquiries i WHERE i.tenant_id = lead_backup_alerts.tenant_id AND i.id = lead_backup_alerts.inquiry_id));
-- written by the minute-three job only (the system actor of the tenant)
CREATE POLICY backup_alerts_insert ON lead_backup_alerts FOR INSERT WITH CHECK ((SELECT app.actor_kind()) = 'system');
GRANT SELECT, INSERT ON lead_backup_alerts TO app_user;

-- Self-check: the table forces row-level security with the restrictive tenant policy, the support read-only trigger and
-- policies; app_user can neither change nor delete a row; the collaborator role check admits 'backup'.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.lead_backup_alerts'::regclass AND c.relrowsecurity AND c.relforcerowsecurity) THEN
    RAISE EXCEPTION '0108: lead_backup_alerts must force row-level security';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.lead_backup_alerts'::regclass AND polname = 'tenant_isolation' AND NOT polpermissive) THEN
    RAISE EXCEPTION '0108: lead_backup_alerts needs the restrictive tenant policy';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.lead_backup_alerts'::regclass AND polname LIKE 'support_read_only_%' AND NOT polpermissive) <> 3
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.lead_backup_alerts'::regclass AND tgname = 'support_read_only' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION '0108: lead_backup_alerts needs the support read-only policies and trigger';
  END IF;
  IF has_table_privilege('app_user', 'public.lead_backup_alerts', 'UPDATE') OR has_table_privilege('app_user', 'public.lead_backup_alerts', 'DELETE')
     OR has_table_privilege('app_user', 'public.lead_backup_alerts', 'TRUNCATE') THEN
    RAISE EXCEPTION '0108: app_user must not change or delete lead_backup_alerts rows';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.contact_collaborators'::regclass AND conname = 'contact_collaborators_role_check'
                   AND pg_get_constraintdef(oid) LIKE '%backup%') THEN
    RAISE EXCEPTION '0108: contact_collaborators.role must admit backup';
  END IF;
END $$;
