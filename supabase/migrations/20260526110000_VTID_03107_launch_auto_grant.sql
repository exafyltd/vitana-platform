-- =============================================================================
-- VTID-03107 · Billing v1 — Launch auto-grant for existing onboarded users
-- =============================================================================
-- One-time idempotent grant: every user who was onboarded BEFORE this migration
-- runs gets a 12-month Premium subscription automatically — no codes, no clicks,
-- no email. They open the app on next launch and see they have Premium until
-- {now + 365d}.
--
-- Rationale (locked with operator 2026-05-26):
--   "We cannot go back to existing users and tell them: hey, now you have a
--    hard cut, unlock with a code. Too complicated. Everyone already onboarded
--    receives a 12-month free subscription automatically."
--
-- Source-of-truth for "who is onboarded"
--   user_tenants → app_users (canonical, since the Phase A bootstrap migration
--   20251231000000_vtid_01101). One row per (user_id, tenant_id) membership.
--   Filtering by is_primary=true picks the user's primary tenant so multi-
--   tenant accounts get exactly one grant.
--
-- Boundary
--   app_users.created_at < (now() - 24h)  →  "already onboarded"
--   Newer signups go through the normal trial flow. The 24h skirt avoids
--   racing a fresh signup that's happening at migration time.
--
-- Idempotency
--   Skip any user who already has an active/trialing/past_due subscription
--   (Stripe-paid, redemption-coded, or otherwise). The auto-grant is a
--   floor, not an override.
--
-- Tagging
--   metadata.source = 'launch_auto_grant_2026'
--   metadata.granted_at = <timestamp>
--   metadata.no_friction = true
--   metadata.grant_duration_days = 365
--
--   The frontend reads metadata.source to render the one-time welcome banner
--   on Settings → Subscription. Once dismissed (localStorage) it never appears
--   again, but the plan card subtitle keeps showing "auto-granted at launch"
--   for the full 12 months so the user can always check why.
--
-- Cashflow note
--   Foregone-revenue worst case: <onboarded_count> × €9.99 × 12 months.
--   Real cost is infra (voice + storage). At ~2,000 users on Premium quotas
--   (30 min voice/mo + 5h rooms/mo + small features) ≈ €10/user/mo worst case
--   ≈ €240k infra worst case over 12 months. Acceptable: existing users are
--   the highest-value cohort we have.
-- =============================================================================

DO $$
DECLARE
  v_inserted       integer;
  v_skipped_active integer;
  v_total_eligible integer;
  v_total_users    integer;
  v_granted_until  timestamptz := now() + interval '365 days';
  v_source         text := 'launch_auto_grant_2026';
BEGIN
  -- Count total app_users (sanity check for empty environments)
  SELECT COUNT(*) INTO v_total_users FROM public.app_users;

  -- Count eligible: primary-tenant memberships of users onboarded >24h ago
  -- who don't already have an active sub
  SELECT COUNT(*) INTO v_total_eligible
  FROM public.user_tenants ut
  JOIN public.app_users au ON au.user_id = ut.user_id
  WHERE ut.is_primary = true
    AND au.created_at < (now() - interval '24 hours')
    AND NOT EXISTS (
      SELECT 1 FROM public.user_subscriptions us
      WHERE us.user_id = ut.user_id
        AND us.status IN ('trialing','active','past_due')
    );

  -- Count already-protected (active sub) — these get skipped
  SELECT COUNT(*) INTO v_skipped_active
  FROM public.user_tenants ut
  JOIN public.app_users au ON au.user_id = ut.user_id
  JOIN public.user_subscriptions us ON us.user_id = ut.user_id
  WHERE ut.is_primary = true
    AND au.created_at < (now() - interval '24 hours')
    AND us.status IN ('trialing','active','past_due');

  -- Do the grant
  INSERT INTO public.user_subscriptions (
    tenant_id,
    user_id,
    plan_key,
    price_key,
    status,
    current_period_start,
    current_period_end,
    cancel_at_period_end,
    trial_end,
    metadata
  )
  SELECT
    ut.tenant_id,
    ut.user_id,
    'premium',
    NULL,                                 -- grant has no Stripe Price binding
    'active',
    now(),
    v_granted_until,
    false,
    NULL,                                 -- grant ≠ trial
    jsonb_build_object(
      'source',              v_source,
      'granted_at',          now(),
      'no_friction',         true,
      'grant_duration_days', 365,
      'reason',              'launch_auto_grant_existing_onboarded_users'
    )
  FROM public.user_tenants ut
  JOIN public.app_users au ON au.user_id = ut.user_id
  WHERE ut.is_primary = true
    AND au.created_at < (now() - interval '24 hours')
    AND NOT EXISTS (
      SELECT 1 FROM public.user_subscriptions us
      WHERE us.user_id = ut.user_id
        AND us.status IN ('trialing','active','past_due')
    )
  ON CONFLICT (tenant_id, user_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- Audit: write a paywall_events row per grant so the Command Hub dashboard
  -- can see the launch event in the funnel telemetry.
  INSERT INTO public.paywall_events (tenant_id, user_id, feature_key, action, current_plan, context)
  SELECT
    us.tenant_id,
    us.user_id,
    'subscription_grant',
    'redeemed',
    'premium',
    jsonb_build_object(
      'source', v_source,
      'granted_until', v_granted_until,
      'campaign', 'launch_auto_grant_2026'
    )
  FROM public.user_subscriptions us
  WHERE us.metadata->>'source' = v_source
    AND us.created_at > (now() - interval '5 minutes');

  RAISE NOTICE 'VTID-03107 launch_auto_grant_2026:';
  RAISE NOTICE '  total app_users in tenant:            %', v_total_users;
  RAISE NOTICE '  eligible (onboarded, no active sub):  %', v_total_eligible;
  RAISE NOTICE '  granted now:                          %', v_inserted;
  RAISE NOTICE '  skipped (already on a sub):           %', v_skipped_active;
  RAISE NOTICE '  current_period_end:                   %', v_granted_until;
END $$;

-- -----------------------------------------------------------------------------
-- Verification: if there are eligible users, at least one row was written
-- (empty-environment / fresh-DB case: this is a no-op)
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_count          integer;
  v_eligible_count integer;
BEGIN
  SELECT COUNT(*) INTO v_eligible_count
  FROM public.user_tenants ut
  JOIN public.app_users au ON au.user_id = ut.user_id
  WHERE ut.is_primary = true
    AND au.created_at < (now() - interval '24 hours');

  SELECT COUNT(*) INTO v_count
  FROM public.user_subscriptions
  WHERE metadata->>'source' = 'launch_auto_grant_2026';

  IF v_eligible_count > 0 AND v_count = 0 THEN
    RAISE EXCEPTION 'VTID-03107 launch_auto_grant: % eligible memberships but 0 grants written', v_eligible_count;
  END IF;

  IF v_eligible_count = 0 THEN
    RAISE NOTICE 'VTID-03107 launch_auto_grant: no eligible memberships (empty env / fresh DB) — skipping ✓';
  ELSE
    RAISE NOTICE 'VTID-03107 launch_auto_grant: % subscriptions tagged source=launch_auto_grant_2026 ✓', v_count;
  END IF;
END $$;
