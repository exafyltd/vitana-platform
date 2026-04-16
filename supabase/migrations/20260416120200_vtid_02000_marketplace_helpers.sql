-- Migration: 20260416120200_vtid_02000_marketplace_helpers.sql
-- Purpose: VTID-02000 Helper functions — lifecycle stage compute, canonical
--          fact key validation, limitations impact count.
--
-- Depends on: 20260416120000 (schema), 20260416120100 (seed data for canonical keys)

-- ===========================================================================
-- LIFECYCLE STAGE — derive stage from user signup date + engagement signals.
-- Called by nightly cron to update app_users.lifecycle_stage.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.compute_user_lifecycle_stage(p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_days_since_signup INT;
  v_wearable_connected BOOLEAN := FALSE;
  v_purchase_count INT := 0;
  v_conversation_count INT := 0;
  v_limitations_set BOOLEAN := FALSE;
  v_base_stage TEXT;
BEGIN
  SELECT GREATEST(0, EXTRACT(DAY FROM NOW() - created_at)::INT)
    INTO v_days_since_signup
    FROM public.app_users
    WHERE user_id = p_user_id;

  IF v_days_since_signup IS NULL THEN
    RETURN NULL;
  END IF;

  -- Base stage from days since signup
  v_base_stage := CASE
    WHEN v_days_since_signup < 30 THEN 'onboarding'
    WHEN v_days_since_signup < 60 THEN 'early'
    WHEN v_days_since_signup < 90 THEN 'established'
    ELSE 'mature'
  END;

  -- Engagement uplift: advance by one stage if user has strong early signal
  -- (connected wearable OR made purchase OR set limitations explicitly).
  SELECT EXISTS (
    SELECT 1 FROM public.wearable_waitlist WHERE user_id = p_user_id
  ) INTO v_wearable_connected;

  SELECT COUNT(*) INTO v_purchase_count
    FROM public.product_orders
    WHERE user_id = p_user_id AND state = 'converted';

  SELECT (user_set_fields != '{}'::JSONB) INTO v_limitations_set
    FROM public.user_limitations WHERE user_id = p_user_id;

  IF v_base_stage = 'onboarding' AND v_days_since_signup >= 7
     AND (COALESCE(v_limitations_set, FALSE) AND (v_wearable_connected OR v_purchase_count > 0))
  THEN
    -- Advance onboarding -> early for highly engaged users after day 7
    RETURN 'early';
  END IF;

  RETURN v_base_stage;
END;
$$;

COMMENT ON FUNCTION public.compute_user_lifecycle_stage(UUID) IS
  'VTID-02000: Compute lifecycle stage for a user based on days-since-signup + engagement uplift. Called by nightly cron.';

-- Refresh-all helper: safe to call from any scheduler (idempotent).
CREATE OR REPLACE FUNCTION public.refresh_all_user_lifecycle_stages()
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated INT;
BEGIN
  WITH updates AS (
    SELECT user_id, public.compute_user_lifecycle_stage(user_id) AS new_stage
      FROM public.app_users
  )
  UPDATE public.app_users u
    SET lifecycle_stage = upd.new_stage,
        lifecycle_stage_updated_at = NOW()
    FROM updates upd
    WHERE u.user_id = upd.user_id
      AND (u.lifecycle_stage IS DISTINCT FROM upd.new_stage);

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

COMMENT ON FUNCTION public.refresh_all_user_lifecycle_stages() IS
  'VTID-02000: Refresh lifecycle_stage for all users. Returns number of rows updated.';

-- ===========================================================================
-- CANONICAL FACT KEY CHECK — called from gateway's write_fact path.
-- Returns { ok, canonical_key, mapped, logged_for_review }.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.check_canonical_fact_key(
  p_key TEXT,
  p_sample_value TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_is_canonical BOOLEAN;
  v_canonical_mapping TEXT;
BEGIN
  -- Direct canonical key match
  SELECT EXISTS (
    SELECT 1 FROM public.canonical_fact_keys
    WHERE key = p_key AND is_active = TRUE
  ) INTO v_is_canonical;

  IF v_is_canonical THEN
    RETURN jsonb_build_object('ok', TRUE, 'canonical_key', p_key, 'mapped', FALSE, 'logged_for_review', FALSE);
  END IF;

  -- Already mapped in review queue?
  SELECT canonicalized_to INTO v_canonical_mapping
    FROM public.canonical_fact_key_review_queue
    WHERE observed_key = p_key;

  IF v_canonical_mapping IS NOT NULL THEN
    -- Admin has already canonicalized this observed key — use the mapping.
    RETURN jsonb_build_object('ok', TRUE, 'canonical_key', v_canonical_mapping, 'mapped', TRUE, 'logged_for_review', FALSE);
  END IF;

  -- New non-canonical key — log to review queue.
  INSERT INTO public.canonical_fact_key_review_queue (observed_key, observed_sample_value, observation_count)
    VALUES (p_key, p_sample_value, 1)
    ON CONFLICT (observed_key) DO UPDATE
      SET observation_count = public.canonical_fact_key_review_queue.observation_count + 1,
          last_seen_at = NOW(),
          observed_sample_value = COALESCE(public.canonical_fact_key_review_queue.observed_sample_value, EXCLUDED.observed_sample_value);

  RETURN jsonb_build_object('ok', TRUE, 'canonical_key', p_key, 'mapped', FALSE, 'logged_for_review', TRUE);
END;
$$;

COMMENT ON FUNCTION public.check_canonical_fact_key(TEXT, TEXT) IS
  'VTID-02000: Validates a memory_facts fact_key against the canonical taxonomy. Non-canonical keys land in the review queue for admin canonicalization.';

-- ===========================================================================
-- LIMITATIONS IMPACT — count of products filtered for a user right now.
-- Feeds the live counter on /ecosystem/preferences.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.get_user_limitations_impact(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limits RECORD;
  v_user_country CHAR(2);
  v_allergies_hidden INT := 0;
  v_dietary_hidden INT := 0;
  v_budget_hidden INT := 0;
  v_contraindications_hidden INT := 0;
  v_geo_hidden INT := 0;
  v_total_hidden INT := 0;
  v_active_products INT;
BEGIN
  SELECT * INTO v_limits FROM public.user_limitations WHERE user_id = p_user_id;
  SELECT COALESCE(delivery_country_code, country_code) INTO v_user_country
    FROM public.app_users WHERE user_id = p_user_id;

  SELECT COUNT(*) INTO v_active_products FROM public.products WHERE is_active = TRUE;

  -- Count by category (these are rough counts; they can overlap).
  IF v_limits.allergies IS NOT NULL AND array_length(v_limits.allergies, 1) > 0 THEN
    SELECT COUNT(*) INTO v_allergies_hidden
      FROM public.products
      WHERE is_active = TRUE
        AND contains_allergens && v_limits.allergies;
  END IF;

  IF v_limits.dietary_restrictions IS NOT NULL AND array_length(v_limits.dietary_restrictions, 1) > 0 THEN
    SELECT COUNT(*) INTO v_dietary_hidden
      FROM public.products
      WHERE is_active = TRUE
        AND NOT (dietary_tags @> v_limits.dietary_restrictions);
  END IF;

  IF v_limits.budget_max_per_product_cents IS NOT NULL THEN
    SELECT COUNT(*) INTO v_budget_hidden
      FROM public.products
      WHERE is_active = TRUE
        AND price_cents IS NOT NULL
        AND price_cents > v_limits.budget_max_per_product_cents;
  END IF;

  IF v_limits.contraindications IS NOT NULL AND array_length(v_limits.contraindications, 1) > 0 THEN
    SELECT COUNT(*) INTO v_contraindications_hidden
      FROM public.products
      WHERE is_active = TRUE
        AND contraindicated_with_conditions && v_limits.contraindications;
  END IF;

  IF v_user_country IS NOT NULL THEN
    SELECT COUNT(*) INTO v_geo_hidden
      FROM public.products
      WHERE is_active = TRUE
        AND NOT (
          v_user_country = ANY(ships_to_countries)
          OR public.get_region_group(v_user_country) = ANY(ships_to_regions)
        );
  END IF;

  -- Rough de-dup: products may be hidden by multiple rules. Sum overestimates total; union is expensive.
  -- For the counter UX, we show the sum with a note that reasons can overlap.
  v_total_hidden := v_allergies_hidden + v_dietary_hidden + v_budget_hidden + v_contraindications_hidden + v_geo_hidden;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'total_active_products', v_active_products,
    'hidden_breakdown', jsonb_build_object(
      'allergies', v_allergies_hidden,
      'dietary', v_dietary_hidden,
      'budget', v_budget_hidden,
      'contraindications', v_contraindications_hidden,
      'geo', v_geo_hidden
    ),
    'hidden_total_approx', v_total_hidden,
    'note', 'Counts may overlap across categories — a single product can be hidden for multiple reasons.'
  );
END;
$$;

COMMENT ON FUNCTION public.get_user_limitations_impact(UUID) IS
  'VTID-02000: Returns a breakdown of how many products each limitation category is hiding for the given user. Feeds the live counter on /ecosystem/preferences.';

GRANT EXECUTE ON FUNCTION public.compute_user_lifecycle_stage(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.refresh_all_user_lifecycle_stages() TO service_role;
GRANT EXECUTE ON FUNCTION public.check_canonical_fact_key(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_user_limitations_impact(UUID) TO authenticated, service_role;
