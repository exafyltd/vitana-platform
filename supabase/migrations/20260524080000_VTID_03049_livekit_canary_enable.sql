-- =============================================================================
-- VTID-03049: LiveKit one-user canary enablement
-- =============================================================================
-- L2.2b.7 parity testing has reached 8/9 acceptance checks green (German real-
-- mic session): greeting, location/time, env, Life Compass, diary entry (post
-- VTID-03042), send chat (post VTID-03043), pillar focus, server-side tool
-- fires. The remaining #7 (Devon bug-report swap-back) is deferred to a
-- parallel session — does NOT block one-user canary because Devon already
-- has machine-readable diagnostics via VTID-03033's observability emits.
--
-- This migration flips the three system_config rows that gate LiveKit's
-- selection from the community surface (vitanaland.com → ORB tap →
-- /api/v1/orb/active-provider → effectiveProvider):
--
--   voice.livekit_agent_enabled       → true   (release the L2.2a safety pin)
--   voice.livekit_canary_enabled      → true   (turn the canary gate on)
--   voice.livekit_canary_allowlist    → { tenants:[], users:[<dstev's user_id>] }
--
-- Resolution rule (active-provider-resolver.ts):
--   1. global active_provider must request livekit (already TRUE)
--   2. creds present (already TRUE — verified by canaryEligible probe)
--   3. canary.enabled = TRUE                (this migration flips it)
--   4. caller in allowlist (tenant_id OR user_id)   (this migration adds dstev)
--   5. voice.livekit_agent_enabled = TRUE   (this migration releases the pin)
--
-- Each gate is independently togglable. Rollback = flip any ONE to false (or
-- run the matching DELETE / UPDATE against system_config), and the resolver
-- pins back to Vertex within 15s (the config cache TTL). No deploy needed.
--
-- The user_id is resolved by email lookup (`d.stevanovic@exafy.io`) so no
-- hardcoded UUID needs to live in this file. If the email isn't found we
-- emit a NOTICE and skip the allowlist update — the safety pins downstream
-- ensure the canary stays off in that case.
-- =============================================================================

BEGIN;

-- 1) Release the agent-ready safety pin.
INSERT INTO system_config (key, value, updated_by, updated_at)
VALUES ('voice.livekit_agent_enabled', 'true'::jsonb, 'VTID-03049', NOW())
ON CONFLICT (key) DO UPDATE
  SET value = 'true'::jsonb,
      updated_by = 'VTID-03049',
      updated_at = NOW();

-- 2) Enable the canary gate.
INSERT INTO system_config (key, value, updated_by, updated_at)
VALUES ('voice.livekit_canary_enabled', 'true'::jsonb, 'VTID-03049', NOW())
ON CONFLICT (key) DO UPDATE
  SET value = 'true'::jsonb,
      updated_by = 'VTID-03049',
      updated_at = NOW();

-- 3) Allowlist: lookup dstev's user_id by email; only update when found.
DO $$
DECLARE
  v_user_id UUID;
  v_payload JSONB;
BEGIN
  SELECT u.user_id INTO v_user_id
  FROM app_users u
  JOIN auth.users au ON au.id = u.user_id
  WHERE au.email = 'd.stevanovic@exafy.io'
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE NOTICE 'VTID-03049: app_users row for d.stevanovic@exafy.io not found; allowlist left untouched. Set manually via UPDATE system_config or supply the UUID explicitly.';
  ELSE
    v_payload := jsonb_build_object(
      'tenants', '[]'::jsonb,
      'users', jsonb_build_array(v_user_id::text)
    );
    INSERT INTO system_config (key, value, updated_by, updated_at)
    VALUES ('voice.livekit_canary_allowlist', v_payload, 'VTID-03049', NOW())
    ON CONFLICT (key) DO UPDATE
      SET value = v_payload,
          updated_by = 'VTID-03049',
          updated_at = NOW();
    RAISE NOTICE 'VTID-03049: canary allowlist set to user_id=%', v_user_id;
  END IF;
END $$;

COMMIT;
