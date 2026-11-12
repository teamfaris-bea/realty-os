-- Batch 9 review fixes, group comms / routing / opt-outs (sends/F1). Placeholder number (the orchestrator renumbers at
-- merge).
--
-- Sender health is per NUMBER, not per shared registration (R-TWL-9). A Twilio 30032 / 30034 on a text marks only the
-- number that sent it not ready to text: phone_numbers.sender_not_verified_at (+ a short detail naming the code). The
-- gate's sender facts read it (comms/repos/gate.ts numberFacts: a flagged number reports its registration as pending,
-- so texts from it are SENDER_NOT_REGISTERED while calls keep working). Before this, the error marked the number's
-- sender_registrations row, which is normally shared by every team number (the Numbers page attaches the first
-- registration to each purchase), so one misconfigured tracking number stopped texting for the whole team.
-- "Check registration status" (numbers.ts refreshRegistration) clears the flag on the registration's numbers when the
-- carrier reports the campaign approved; attaching a different registration to the number clears it too (new facts).
--
-- The columns are written by the system in the status event's / dispatch TX2 transaction and by an Owner/Admin's
-- refresh, both through the existing tenant policies on phone_numbers (FORCE RLS, composite keys unchanged). No new
-- table, policy, grant or SECURITY DEFINER function.

ALTER TABLE phone_numbers
  ADD COLUMN sender_not_verified_at     timestamptz,
  ADD COLUMN sender_not_verified_detail text CHECK (length(sender_not_verified_detail) <= 200),
  ADD CONSTRAINT phone_numbers_sender_not_verified_pair
    CHECK ((sender_not_verified_at IS NULL) = (sender_not_verified_detail IS NULL));
