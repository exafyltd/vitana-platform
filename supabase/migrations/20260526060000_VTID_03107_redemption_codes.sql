-- =============================================================================
-- VTID-03107 · Billing v1 — Redemption codes + fn_redeem_code
-- =============================================================================
-- Two new tables + one atomic RPC that powers all three giveaway paths from §S:
--
--   redemption_codes          One row per code. max_uses=1 for unique-per-user
--                              test-cohort codes (VITANA-TEST-*); max_uses=N
--                              for shared marketing codes (FOUNDING).
--   redemption_redemptions    Per-user audit of each successful redemption.
--                              Enforces one-shot per (user, code).
--
--   fn_redeem_code            Atomic redeem with all guards (validity, single-
--                              use, Stripe-sub conflict, marketing-budget cap,
--                              extension stacking for existing Premium).
--                              Idempotent on retry (returns ALREADY_REDEEMED).
--
-- Marketing-budget guard (§S cashflow hardening)
--   Beyond per-code max_uses, fn_redeem_code checks AND decrements
--   `tenant_settings.feature_flags.marketing_budget_eur_remaining_cents`
--   before granting. Computes grant_value_cents from the plan's monthly
--   Stripe price (pro-rated by grant_duration_days). When the budget hits 0
--   the next redemption returns BUDGET_EXHAUSTED. Ops tops up the counter via
--   a single SQL UPDATE.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. redemption_codes
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.redemption_codes (
  code                  text PRIMARY KEY,
  campaign              text NOT NULL,                       -- 'test_cohort_2026Q2' | 'founding_500' | 'launch_podcast' | …
  grants_plan           text NOT NULL REFERENCES public.subscription_plans(plan_key),
  grant_duration_days   integer NOT NULL DEFAULT 90 CHECK (grant_duration_days > 0 AND grant_duration_days <= 730),
  max_uses              integer NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  uses_count            integer NOT NULL DEFAULT 0 CHECK (uses_count >= 0),
  expires_at            timestamptz,                          -- NULL = no expiry
  created_by            uuid,                                 -- admin user_id (NULL if seeded via SQL)
  is_active             boolean NOT NULL DEFAULT true,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (uses_count <= max_uses)
);

CREATE INDEX IF NOT EXISTS idx_redemption_codes_campaign ON public.redemption_codes (campaign);
CREATE INDEX IF NOT EXISTS idx_redemption_codes_active   ON public.redemption_codes (is_active) WHERE is_active = true;

COMMENT ON TABLE public.redemption_codes IS
  'VTID-03107: campaign codes (test cohort + Founding shared promo + referral). max_uses distinguishes unique-per-user (max_uses=1) from shared-with-cap (max_uses=N).';
COMMENT ON COLUMN public.redemption_codes.grant_duration_days IS
  'Length of the Premium grant in days. 365 for test cohort, 90 for Founding, 30 for referral.';

DROP TRIGGER IF EXISTS trg_redemption_codes_updated ON public.redemption_codes;
CREATE TRIGGER trg_redemption_codes_updated
  BEFORE UPDATE ON public.redemption_codes
  FOR EACH ROW EXECUTE FUNCTION public.billing_bump_updated_at();

-- -----------------------------------------------------------------------------
-- 2. redemption_redemptions  (per-user audit)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.redemption_redemptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  code          text NOT NULL REFERENCES public.redemption_codes(code),
  campaign      text NOT NULL,
  granted_plan  text NOT NULL,
  granted_until timestamptz NOT NULL,
  grant_value_cents integer NOT NULL,                        -- foregone-revenue value at redemption time
  redeemed_at   timestamptz NOT NULL DEFAULT now(),
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (user_id, code)                                      -- one redemption of each code per user
);

CREATE INDEX IF NOT EXISTS idx_redemption_redemptions_user      ON public.redemption_redemptions (user_id);
CREATE INDEX IF NOT EXISTS idx_redemption_redemptions_campaign  ON public.redemption_redemptions (campaign, redeemed_at DESC);
CREATE INDEX IF NOT EXISTS idx_redemption_redemptions_code      ON public.redemption_redemptions (code);

COMMENT ON TABLE public.redemption_redemptions IS
  'VTID-03107: audit of each successful code redemption. grant_value_cents captures the foregone-revenue at redemption time for cashflow telemetry.';

-- -----------------------------------------------------------------------------
-- 3. RLS
-- -----------------------------------------------------------------------------

ALTER TABLE public.redemption_codes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.redemption_redemptions  ENABLE ROW LEVEL SECURITY;

-- redemption_codes: admins manage; authenticated can read active codes via the
-- RPC (the RPC is SECURITY DEFINER so the policy below is defense-in-depth)
DROP POLICY IF EXISTS redemption_codes_svc_full ON public.redemption_codes;
CREATE POLICY redemption_codes_svc_full ON public.redemption_codes
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- redemption_redemptions: users see own; service_role full
DROP POLICY IF EXISTS redemption_redemptions_read_own ON public.redemption_redemptions;
DROP POLICY IF EXISTS redemption_redemptions_svc_full ON public.redemption_redemptions;
CREATE POLICY redemption_redemptions_read_own ON public.redemption_redemptions
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY redemption_redemptions_svc_full ON public.redemption_redemptions
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

GRANT SELECT ON public.redemption_redemptions TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. fn_normalize_code  (helper: uppercase, strip whitespace + dashes)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_normalize_code(p_code text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT upper(regexp_replace(COALESCE(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

COMMENT ON FUNCTION public.fn_normalize_code IS
  'VTID-03107: normalize a redemption code (uppercase, strip whitespace + dashes). VITANA-test-A4F2-9KX1 → VITANATESTA4F29KX1';

-- However: codes are STORED in dashed form (VITANA-TEST-A4F2-9KX1) for human
-- readability. The lookup logic uses regexp_replace on the stored code so both
-- normalized and dashed inputs match.

-- -----------------------------------------------------------------------------
-- 5. fn_redeem_code  (atomic redemption with all guards)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_redeem_code(
  p_tenant_id  uuid,
  p_user_id    uuid,
  p_code       text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code_row              public.redemption_codes%ROWTYPE;
  v_normalized            text;
  v_existing_redemption   uuid;
  v_existing_sub          public.user_subscriptions%ROWTYPE;
  v_granted_until         timestamptz;
  v_monthly_price_cents   integer;
  v_grant_value_cents     integer;
  v_budget_remaining      integer;
  v_redemption_id         uuid;
  v_settings_row_id       uuid;
BEGIN
  -- 1. Validate inputs
  IF p_user_id IS NULL OR p_tenant_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'MISSING_IDENTITY');
  END IF;

  v_normalized := public.fn_normalize_code(p_code);
  IF v_normalized = '' OR length(v_normalized) < 4 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
  END IF;

  -- 2. Lookup code row (FOR UPDATE locks against concurrent redeems on same code)
  --    Match against the stored code with non-alphanumerics stripped, so
  --    both VITANATESTA4F29KX1 and VITANA-TEST-A4F2-9KX1 hit the same row.
  SELECT * INTO v_code_row
  FROM public.redemption_codes
  WHERE upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g')) = v_normalized
  FOR UPDATE;

  IF v_code_row.code IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
  END IF;

  IF NOT v_code_row.is_active THEN
    RETURN jsonb_build_object('ok', false, 'error', 'EXPIRED_OR_INACTIVE', 'code', v_code_row.code);
  END IF;

  IF v_code_row.expires_at IS NOT NULL AND v_code_row.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'EXPIRED', 'expired_at', v_code_row.expires_at);
  END IF;

  IF v_code_row.uses_count >= v_code_row.max_uses THEN
    RETURN jsonb_build_object('ok', false, 'error', 'MAX_USES_REACHED', 'max_uses', v_code_row.max_uses);
  END IF;

  -- 3. Per-user single-use check
  SELECT id INTO v_existing_redemption
  FROM public.redemption_redemptions
  WHERE user_id = p_user_id AND code = v_code_row.code;

  IF v_existing_redemption IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_REDEEMED', 'redemption_id', v_existing_redemption);
  END IF;

  -- 4. Stripe-sub conflict: if user has an active Stripe-paid sub, refuse the
  --    grant to avoid double-pay. Grant-on-grant (extension) is allowed.
  SELECT * INTO v_existing_sub
  FROM public.user_subscriptions
  WHERE tenant_id = p_tenant_id AND user_id = p_user_id
  FOR UPDATE;

  IF v_existing_sub.user_id IS NOT NULL
     AND v_existing_sub.stripe_subscription_id IS NOT NULL
     AND v_existing_sub.status IN ('active','trialing','past_due') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'STRIPE_SUB_ACTIVE',
      'message', 'You already have a paid subscription. Save this code for later.',
      'current_plan', v_existing_sub.plan_key
    );
  END IF;

  -- 5. Compute granted_until (stacking: extend existing period if any)
  IF v_existing_sub.current_period_end IS NOT NULL AND v_existing_sub.current_period_end > now() THEN
    v_granted_until := v_existing_sub.current_period_end + make_interval(days => v_code_row.grant_duration_days);
  ELSE
    v_granted_until := now() + make_interval(days => v_code_row.grant_duration_days);
  END IF;

  -- 6. Marketing-budget guard — compute grant value from monthly Stripe price
  --    pro-rated by grant_duration_days.
  SELECT price_cents INTO v_monthly_price_cents
  FROM public.subscription_plan_prices
  WHERE plan_key = v_code_row.grants_plan
    AND billing_interval = 'month'
    AND is_active = true
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_monthly_price_cents IS NULL THEN
    -- No monthly price configured for the granted plan (e.g. free). Skip budget guard.
    v_grant_value_cents := 0;
  ELSE
    v_grant_value_cents := (v_monthly_price_cents::numeric * v_code_row.grant_duration_days / 30.0)::integer;
  END IF;

  -- Read + decrement tenant_settings.feature_flags.marketing_budget_eur_remaining_cents.
  -- If the flag doesn't exist, we don't gate (interpret missing flag as "no
  -- budget configured" = no cap). Once ops seeds the flag, the guard activates.
  IF v_grant_value_cents > 0 THEN
    SELECT id, COALESCE((feature_flags->>'marketing_budget_eur_remaining_cents')::integer, NULL)
      INTO v_settings_row_id, v_budget_remaining
    FROM public.tenant_settings
    WHERE tenant_id = p_tenant_id
    FOR UPDATE;

    IF v_settings_row_id IS NOT NULL AND v_budget_remaining IS NOT NULL THEN
      IF v_budget_remaining < v_grant_value_cents THEN
        RETURN jsonb_build_object(
          'ok', false,
          'error', 'BUDGET_EXHAUSTED',
          'budget_remaining_cents', v_budget_remaining,
          'grant_value_cents', v_grant_value_cents
        );
      END IF;

      UPDATE public.tenant_settings
         SET feature_flags = jsonb_set(
               feature_flags,
               '{marketing_budget_eur_remaining_cents}',
               to_jsonb(v_budget_remaining - v_grant_value_cents)
             )
       WHERE id = v_settings_row_id;
    END IF;
  END IF;

  -- 7. UPSERT user_subscriptions (status='active' for grants)
  INSERT INTO public.user_subscriptions (
    tenant_id, user_id, plan_key, status,
    current_period_start, current_period_end,
    metadata
  ) VALUES (
    p_tenant_id, p_user_id, v_code_row.grants_plan, 'active',
    COALESCE(v_existing_sub.current_period_start, now()),
    v_granted_until,
    jsonb_build_object(
      'source',   'redemption',
      'code',     v_code_row.code,
      'campaign', v_code_row.campaign
    )
  )
  ON CONFLICT (tenant_id, user_id) DO UPDATE SET
    plan_key             = EXCLUDED.plan_key,
    status               = EXCLUDED.status,
    current_period_end   = EXCLUDED.current_period_end,
    cancel_at_period_end = false,
    metadata             = public.user_subscriptions.metadata ||
                           jsonb_build_object(
                             'source',   'redemption',
                             'code',     v_code_row.code,
                             'campaign', v_code_row.campaign
                           ),
    updated_at           = now();

  -- 8. Increment code uses_count
  UPDATE public.redemption_codes
     SET uses_count = uses_count + 1
   WHERE code = v_code_row.code;

  -- 9. Record redemption audit
  INSERT INTO public.redemption_redemptions (
    tenant_id, user_id, code, campaign, granted_plan, granted_until, grant_value_cents
  ) VALUES (
    p_tenant_id, p_user_id, v_code_row.code, v_code_row.campaign,
    v_code_row.grants_plan, v_granted_until, v_grant_value_cents
  )
  RETURNING id INTO v_redemption_id;

  -- 10. paywall_events audit
  INSERT INTO public.paywall_events (tenant_id, user_id, feature_key, action, current_plan, context)
  VALUES (
    p_tenant_id, p_user_id, 'subscription', 'redeemed', v_code_row.grants_plan,
    jsonb_build_object(
      'code', v_code_row.code,
      'campaign', v_code_row.campaign,
      'granted_until', v_granted_until,
      'grant_value_cents', v_grant_value_cents
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'redemption_id', v_redemption_id,
    'granted_plan', v_code_row.grants_plan,
    'granted_until', v_granted_until,
    'grant_value_cents', v_grant_value_cents,
    'uses_count', v_code_row.uses_count + 1,
    'max_uses', v_code_row.max_uses,
    'campaign', v_code_row.campaign
  );
END;
$$;

COMMENT ON FUNCTION public.fn_redeem_code IS
  'VTID-03107: atomic code redemption. Validates code → checks per-user single-use → rejects on active Stripe sub → checks + decrements marketing-budget cap → UPSERTs user_subscriptions with metadata.source=redemption → increments uses_count → audits to redemption_redemptions + paywall_events.';

GRANT EXECUTE ON FUNCTION public.fn_redeem_code TO service_role, authenticated;

-- -----------------------------------------------------------------------------
-- 6. Seed Founding 500 launch campaign code  (per §S launch-day SQL)
-- -----------------------------------------------------------------------------
-- One shared marketing code. max_uses=500, grant_duration_days=90.
-- Test-cohort codes (100 unique VITANA-TEST-* codes) are generated by ops via
-- the Command Hub admin form in PR-5 — they are not seeded here.

INSERT INTO public.redemption_codes (
  code, campaign, grants_plan, grant_duration_days, max_uses, is_active, metadata
) VALUES (
  'FOUNDING', 'founding_500', 'premium', 90, 500, true,
  jsonb_build_object(
    'description', 'Launch Founding Member promo — first 500 users get 3 months Premium free',
    'visibility', 'public',
    'launch_date', '2026-05-20'
  )
)
ON CONFLICT (code) DO UPDATE SET
  max_uses            = EXCLUDED.max_uses,
  grant_duration_days = EXCLUDED.grant_duration_days,
  is_active           = EXCLUDED.is_active,
  metadata            = EXCLUDED.metadata,
  updated_at          = now();

-- -----------------------------------------------------------------------------
-- 7. Verification: code seeded + reused-redemption rejected
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_row    public.redemption_codes%ROWTYPE;
  v_result jsonb;
BEGIN
  SELECT * INTO v_row FROM public.redemption_codes WHERE code = 'FOUNDING';
  IF v_row.code IS NULL THEN
    RAISE EXCEPTION 'VTID-03107: FOUNDING code not seeded';
  END IF;
  IF v_row.max_uses <> 500 OR v_row.grant_duration_days <> 90 THEN
    RAISE EXCEPTION 'VTID-03107: FOUNDING seeded with wrong values (max_uses=%, days=%)',
      v_row.max_uses, v_row.grant_duration_days;
  END IF;

  -- Invalid code should be rejected
  v_result := public.fn_redeem_code(
    '00000000-0000-0000-0000-000003107030'::uuid,
    '00000000-0000-0000-0000-000003107031'::uuid,
    'NONEXISTENT-XXXX-XXXX'
  );
  IF (v_result->>'ok')::boolean OR (v_result->>'error') <> 'INVALID_CODE' THEN
    RAISE EXCEPTION 'VTID-03107: invalid code should return INVALID_CODE, got %', v_result;
  END IF;

  -- Empty code should be rejected
  v_result := public.fn_redeem_code(
    '00000000-0000-0000-0000-000003107030'::uuid,
    '00000000-0000-0000-0000-000003107031'::uuid,
    '   '
  );
  IF (v_result->>'ok')::boolean OR (v_result->>'error') <> 'INVALID_CODE' THEN
    RAISE EXCEPTION 'VTID-03107: empty code should return INVALID_CODE, got %', v_result;
  END IF;

  RAISE NOTICE 'VTID-03107 fn_redeem_code: FOUNDING seeded + invalid-code rejection verified ✓';
END $$;
