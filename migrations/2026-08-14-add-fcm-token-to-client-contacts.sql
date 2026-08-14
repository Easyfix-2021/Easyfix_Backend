-- Push notifications: store each SPOC's device FCM registration token so
-- firebase-admin (services/push.service.js) can target the device to send push.
--
-- The client app's registerPush() fetches the token from
-- @react-native-firebase/messaging on login and POSTs it to
-- POST /api/client/device-token, which UPDATEs this column.
--
-- Nullable + additive — existing rows and every other query are unaffected.
-- Safe to run on QA then Production. Column sized 512 to comfortably hold the
-- current FCM token format (~150-200 chars) with headroom.

ALTER TABLE tbl_client_contacts
  ADD COLUMN fcm_token VARCHAR(512) NULL AFTER device_id;
