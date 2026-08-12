-- Notice Board: event date + explicit push flags.
--
-- event_date      Optional calendar date the notice is ABOUT (a celebration, a
--                 maintenance window, a holiday). Distinct from publish_at
--                 (when it goes live) and expire_at (when it stops showing).
--                 NULL = an ordinary notice; NOT NULL = it also appears in the
--                 dashboard's Upcoming Events rail. DATE, not DATETIME: ops
--                 announce the day, and a time would force a fake 00:00.
--
-- push_technician Whether publishing should fan a push out to the Technician
--                 App. DEFAULT 1 deliberately: today the push fires implicitly
--                 whenever target_surfaces contains 'technician', so 1 keeps
--                 every existing row and every non-CRM caller behaving exactly
--                 as before. The flag only NARROWS — the surface must still be
--                 targeted for anything to send.
--
-- push_client     Whether to push to the Client App. Stored now so the CRM can
--                 capture ops intent, but note it CANNOT deliver yet: the
--                 client app registers a locally-generated UUID in
--                 tbl_client_contacts.device_id, not an FCM token, and ships no
--                 Firebase Messaging. Until the app registers real tokens this
--                 records intent only; the notice still reaches clients through
--                 the in-app notice-board feed (target_surfaces containing
--                 'client'). DEFAULT 0 so nothing silently claims to push.

ALTER TABLE tbl_notice ADD COLUMN event_date DATE NULL AFTER expire_at;
ALTER TABLE tbl_notice ADD COLUMN push_technician TINYINT(1) NOT NULL DEFAULT 1 AFTER event_date;
ALTER TABLE tbl_notice ADD COLUMN push_client TINYINT(1) NOT NULL DEFAULT 0 AFTER push_technician;

-- Drives the Upcoming Events rail: "event notices from today forward, soonest
-- first". Partial-ish by virtue of most rows being NULL, which MySQL skips.
CREATE INDEX idx_notice_event_date ON tbl_notice (event_date);
