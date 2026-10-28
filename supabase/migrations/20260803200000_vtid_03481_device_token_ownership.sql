-- VTID-03481 — One device, one account.
--
-- SYMPTOM (reported with a lock-screen screenshot, 2026-08-03): every
-- notification arrived on the same phone TWICE, once in German and once in
-- English, ~1 minute apart — "Neuer Beitrag / Mariia Maksina hat einen neuen
-- Beitrag geteilt" next to "New post / Mariia Maksina shared a new post", and
-- "Tagebuch-Erinnerung" next to "Diary Reminder".
--
-- IT WAS NEVER A WORDING BUG. user_notifications held exactly ONE correctly
-- localized row per recipient. The duplication happened at DELIVERY: the same
-- physical device was registered under SEVERAL accounts, so a tenant-wide
-- fan-out sent one push per stale account, each rendered in THAT account's
-- language. Verified on production data:
--
--   fcm_token eVlsdh6zTBiP…  (one Android phone)
--     → 0adc6ff6 "Alex BLUE" (stt_language en-US) → "New post"     19:12:33Z
--     → c5a4daf9 "Alex RED"  (stt_language de-DE) → "Neuer Beitrag" 19:13:08Z
--   fcm_token eZzu7fszMacS…  (one Windows browser) → FIVE accounts
--
-- ROOT CAUSE: POST /api/v1/notifications/token upserts with
-- onConflict='user_id,fcm_token'. An FCM token identifies a DEVICE
-- INSTALLATION, not a (user, device) pair — FCM itself hands the token to
-- whoever registered last. But because the conflict target includes user_id,
-- a token re-registered by a DIFFERENT account INSERTS a second row instead of
-- taking the device over, and sign-out never removed the old one. Every
-- account that has ever signed in on a device accumulates forever.
--
-- This migration makes the invariant structural: at most one ACTIVE owner per
-- fcm_token. Losing rows are SOFT-revoked rather than deleted, because
-- revoked_at is also the signal the gateway needs to suppress Appilix pushes
-- (Appilix targets by user_identity, not by token, and its own device registry
-- can't be purged from our side — see notification-service.ts).

-- ── 1. Ownership columns ─────────────────────────────────────────────────────
ALTER TABLE user_device_tokens
  ADD COLUMN IF NOT EXISTS revoked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_reason TEXT;

COMMENT ON COLUMN user_device_tokens.revoked_at IS
  'NULL = this user is the current owner of the device and may receive push. '
  'Non-NULL = the device was taken over by another account or the user signed '
  'out; keep the row (not a DELETE) so the gateway can tell "signed out on a '
  'known device" apart from "never had a device token", which still needs the '
  'legacy Appilix user_identity fallback. VTID-03481.';

COMMENT ON COLUMN user_device_tokens.revoked_reason IS
  'taken_over | signed_out | backfill — why the row stopped being active.';

-- ── 2. Backfill: resolve devices that already have several owners ────────────
-- Keep the most recently updated row per token (that is the account actually
-- signed in on the device now) and revoke the rest. This is what stops the
-- duplicate lock-screen notifications for devices that are ALREADY polluted —
-- without it users would keep double-buzzing until every device happened to
-- re-register.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY fcm_token
           ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id
         ) AS rn
  FROM user_device_tokens
  WHERE revoked_at IS NULL
)
UPDATE user_device_tokens t
   SET revoked_at = now(),
       revoked_reason = 'backfill'
  FROM ranked r
 WHERE r.id = t.id
   AND r.rn > 1;

-- ── 3. Enforce it ────────────────────────────────────────────────────────────
-- At most one ACTIVE row per device token. Revoked rows are exempt, so a
-- device's full sign-in history is retained.
--
-- Safe against the multi-tenant case: the pre-existing UNIQUE(user_id,
-- fcm_token) already allowed a user only ONE row per token across all tenants,
-- so this adds no restriction beyond the cross-account one it is meant to fix.
--
-- Callers MUST revoke other owners BEFORE upserting their own row (see
-- routes/notifications.ts) — the reverse order transiently violates this index.
CREATE UNIQUE INDEX IF NOT EXISTS user_device_tokens_one_active_owner
  ON user_device_tokens (fcm_token)
  WHERE revoked_at IS NULL;

-- Dispatch reads "active tokens for this user in this tenant" on every push.
CREATE INDEX IF NOT EXISTS user_device_tokens_active_by_user
  ON user_device_tokens (user_id, tenant_id)
  WHERE revoked_at IS NULL;
