-- =============================================================================
-- SMOKE TEST — BOOTSTRAP-ONBOARDING-AUTOPILOT-SEED
-- =============================================================================
-- Drops a fixture user through the onboarding-seed flow and asserts that the
-- exact query the Autopilot popup uses returns the 8-row onboarding bundle —
-- within a deterministic window (synchronously, no async generation).
--
-- Fully reversible: the whole test runs inside a transaction that ROLLBACKs, so
-- it leaves NO trace in any environment it is run against.
--
-- Run:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     supabase/tests/smoke_onboarding_autopilot_seed.sql
--
-- Exit code 0 + "SMOKE OK" notice = pass. Any RAISE EXCEPTION = fail.
-- =============================================================================

BEGIN;

DO $smoke$
DECLARE
  v_user    uuid;
  v_n       integer;
  v_again   integer;
  v_visible integer;
BEGIN
  -- Use a real community member (FK: autopilot_recommendations.user_id → users).
  SELECT ut.user_id
    INTO v_user
  FROM public.user_tenants ut
  WHERE ut.is_primary = true
    AND COALESCE(ut.active_role, 'community') = 'community'
  LIMIT 1;

  IF v_user IS NULL THEN
    RAISE EXCEPTION 'SMOKE FAIL: no primary community user available to test';
  END IF;

  -- Simulate a brand-new account: clear any existing community recs *inside the
  -- transaction* (rolled back at the end, so the real user is untouched).
  DELETE FROM public.autopilot_recommendations
  WHERE user_id = v_user AND source_type = 'community';

  -- 1. First seed → expect the full 8-row onboarding bundle.
  v_n := public.seed_community_onboarding_autopilot(v_user);
  IF v_n <> 8 THEN
    RAISE EXCEPTION 'SMOKE FAIL: expected 8 seeded onboarding recs, got %', v_n;
  END IF;

  -- 2. Re-seed → expect 0 (idempotent; the gate no-ops users who already have recs).
  v_again := public.seed_community_onboarding_autopilot(v_user);
  IF v_again <> 0 THEN
    RAISE EXCEPTION 'SMOKE FAIL: second seed not idempotent, inserted %', v_again;
  END IF;

  -- 3. The EXACT query the popup role-endpoint runs (queryRecommendationsByRole
  --    for community: source_type=community, user scoped, status in
  --    (new,activated), not snoozed, not expired) must surface all 8.
  SELECT count(*)
    INTO v_visible
  FROM public.autopilot_recommendations r
  WHERE r.user_id = v_user
    AND r.source_type = 'community'
    AND r.status IN ('new', 'activated')
    AND (r.snoozed_until IS NULL OR r.snoozed_until < now())
    AND (r.expires_at IS NULL OR r.expires_at > now())
    AND r.source_ref LIKE 'onboarding_%';

  IF v_visible <> 8 THEN
    RAISE EXCEPTION 'SMOKE FAIL: popup query expected 8 visible onboarding recs, got %', v_visible;
  END IF;

  RAISE NOTICE 'SMOKE OK: user % → seeded 8 onboarding recs, idempotent on re-seed, all 8 visible to the popup role-query', v_user;
END
$smoke$;

-- Reverse everything — the smoke test must never mutate the target environment.
ROLLBACK;
