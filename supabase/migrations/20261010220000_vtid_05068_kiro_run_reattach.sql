-- VTID-05068 — Kiro runs survive a gateway deploy (Phase 3 of the sparred plan).
--
-- A running Kiro run whose gateway task goes away (a deploy, a crash) is taken
-- over by another gateway task: the kiro-runner keeps kiro-cli alive for the
-- reattach window (KIRO_RUNNER_REATTACH_MS, default 10 min) and hands the
-- session to the task presenting the session's reattach token.
--
-- The token itself is NEVER stored (sparring finding F7). It is derived:
--   token = HMAC-SHA256(HKDF(GATEWAY_INTERNAL_TOKEN), 'kiro-reattach:' || nonce)
-- so a database reader alone cannot present it. The row keeps:
--   reattach_nonce       random per Kiro session (the input of the derivation)
--   reattach_token_hash  hex sha256 of the token (checked before it is presented)
--   reattach_expires_at  end of the window once the owning task let the session
--                        go on shutdown (null while it runs; after a crash the
--                        window is counted from last_heartbeat_at)
--   turn_context         how the turn was asked (mode, channel, request id …), so
--                        the task that finishes it records it the same way
--
-- Additive, nullable columns on a service-role-only table (RLS on, no policies,
-- anon/authenticated revoked by 20261010210000). Nothing else reads them.
-- impact-allow-solo-migration: columns read and written only by the gateway in the same PR.

ALTER TABLE public.kiro_runs
  ADD COLUMN IF NOT EXISTS reattach_nonce       text,
  ADD COLUMN IF NOT EXISTS reattach_token_hash  text,
  ADD COLUMN IF NOT EXISTS reattach_expires_at  timestamptz,
  ADD COLUMN IF NOT EXISTS turn_context         jsonb;

COMMENT ON COLUMN public.kiro_runs.reattach_nonce IS
  'VTID-05068: random per Kiro session; the reattach token is HMAC(gateway secret, nonce) and is never stored.';
COMMENT ON COLUMN public.kiro_runs.reattach_token_hash IS
  'VTID-05068: hex sha256 of the session reattach token (the runner keeps only the hash as well).';
COMMENT ON COLUMN public.kiro_runs.reattach_expires_at IS
  'VTID-05068: end of the reattach window after the owning gateway task let the session go (null while it runs).';
COMMENT ON COLUMN public.kiro_runs.turn_context IS
  'VTID-05068: how the turn was asked (mode, channel, request id, conversation id, VTID, attachments) for the task that finishes it after a reattach.';
