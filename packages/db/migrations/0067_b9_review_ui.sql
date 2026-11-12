-- Batch 9 review fixes, web UI and copy (ui/F7; DATA_MODEL R-TWL-1, R-TWL-11).
--
-- With TELEPHONY_LIVE_REQUESTS off, every MMS media and text-part fetch is refused by our own kill switch before any
-- request is made. Both paths recorded that as FETCH_FAILED, which the thread says as "it couldn't be downloaded from
-- the carrier": the carrier sent it, our switch refused it. A refused fetch now records its own reason,
-- LIVE_REQUESTS_OFF, so the thread can say what happened. Nothing else changes: the part stays skipped (R-TWL-11, as
-- before), the handler still gets the one unreadable-part notice, and no existing row is rewritten (rows recorded
-- before this migration keep FETCH_FAILED; the switch's refusals among them cannot be told apart afterwards).
--
-- Only the reason CHECK widens. No table, policy, grant or function is added or changed; the table keeps FORCE RLS,
-- its tenant policies and its support_read_only policies from 0019.

ALTER TABLE message_media_skipped DROP CONSTRAINT message_media_skipped_reason_check;
ALTER TABLE message_media_skipped ADD CONSTRAINT message_media_skipped_reason_check
  CHECK (reason IN ('TYPE_NOT_ALLOWED','TOO_LARGE','TOO_MANY','CONTENT_MISMATCH','FETCH_FAILED','LIVE_REQUESTS_OFF'));
