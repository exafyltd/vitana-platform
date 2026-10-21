-- VTID-04498 — get_index_standing(p_user_id): the real "Top X%" badge on the
-- profile Vitana Index card.
--
-- Read-only. Writes nothing, creates no table.
--
-- The profile used to show a "Top X%" that was the score's share of the 999
-- maximum, not a rank (removed in VTID-04470). This is the real rank, built
-- on the same cohort rule get_profile_health_summary (VTID-04483) uses:
-- the subject's tenant, each member's latest score in the last 30 days,
-- excluding service_bot_accounts and notification_test_actors (platform
-- rule 45: test/service accounts never shape what members see).
--
-- The badge is shown only when all of these hold, and the function decides
-- that here so no client can get it wrong:
--   * at least c_min_cohort members are in the cohort (a rank among a
--     handful of people says nothing);
--   * at least one member scores lower than the subject. Measured
--     2026-09-24: 48 of 66 members sit tied at the starting score of 50, and
--     a tied rank would label each of them "Top 29%" for having done
--     nothing yet;
--   * the rank is in the top half (top_percent <= c_max_badge_percent). A
--     "Top 90%" badge is not something anyone shares.
-- Otherwise `show` is false and no percentage is returned.
--
-- Visibility: the score itself is already visible to every signed-in member
-- (get_public_vitana_index), and the badge is derived from it, so it follows
-- the same rule: any signed-in viewer, nobody anonymous.

CREATE OR REPLACE FUNCTION public.get_index_standing(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  c_min_cohort        CONSTANT integer := 20;
  c_max_badge_percent CONSTANT integer := 50;
  v_viewer   uuid := auth.uid();
  v_tenant   uuid;
  v_score    integer;
  v_cohort   integer := 0;
  v_higher   integer := 0;
  v_lower    integer := 0;
  v_top      integer;
BEGIN
  IF p_user_id IS NULL OR v_viewer IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT s.tenant_id, s.score_total
    INTO v_tenant, v_score
    FROM public.vitana_index_scores s
   WHERE s.user_id = p_user_id
     AND s.date > current_date - 30
   ORDER BY s.date DESC
   LIMIT 1;

  IF NOT FOUND OR v_score IS NULL THEN
    RETURN jsonb_build_object('show', false, 'reason', 'no_recent_score');
  END IF;

  WITH latest AS (
    SELECT DISTINCT ON (s.user_id) s.user_id, s.score_total
      FROM public.vitana_index_scores s
     WHERE s.tenant_id = v_tenant
       AND s.date > current_date - 30
     ORDER BY s.user_id, s.date DESC
  )
  SELECT count(*),
         count(*) FILTER (WHERE l.score_total > v_score),
         count(*) FILTER (WHERE l.score_total < v_score)
    INTO v_cohort, v_higher, v_lower
    FROM latest l
   WHERE l.user_id <> p_user_id
     AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts b WHERE b.user_id = l.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.notification_test_actors a WHERE a.user_id = l.user_id);

  -- The subject counts toward the cohort.
  v_cohort := v_cohort + 1;

  IF v_cohort < c_min_cohort THEN
    RETURN jsonb_build_object('show', false, 'reason', 'cohort_too_small',
                              'cohort_size', v_cohort, 'min_cohort', c_min_cohort);
  END IF;

  IF v_lower = 0 THEN
    RETURN jsonb_build_object('show', false, 'reason', 'no_one_below', 'cohort_size', v_cohort);
  END IF;

  -- "Top X%": rank (1 = highest; ties share the better rank) as a share of the cohort.
  v_top := greatest(1, ceil(100.0 * (v_higher + 1) / v_cohort))::integer;

  IF v_top > c_max_badge_percent THEN
    RETURN jsonb_build_object('show', false, 'reason', 'not_top_half', 'cohort_size', v_cohort);
  END IF;

  RETURN jsonb_build_object('show', true, 'top_percent', v_top, 'cohort_size', v_cohort);
END;
$fn$;

COMMENT ON FUNCTION public.get_index_standing(uuid) IS
  'VTID-04498: real community rank behind the profile "Top X%" badge. show=true only with >= 20 members in the tenant cohort (latest score in 30 days, service/test accounts excluded), at least one member scoring lower, and a rank in the top half; otherwise no percentage is returned.';

REVOKE ALL ON FUNCTION public.get_index_standing(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_index_standing(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_index_standing(uuid) TO authenticated;
