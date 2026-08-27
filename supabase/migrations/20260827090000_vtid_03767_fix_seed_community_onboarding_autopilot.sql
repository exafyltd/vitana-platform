-- =============================================================================
-- VTID-03767 — fix "Say hello to Maxina" in the day0 onboarding Autopilot seed.
-- =============================================================================
-- The in-app AI assistant is named Vitana, not Maxina — MAXINA is only the
-- app/brand name (see vitana-v1's src/i18n/<locale>/portals.json: "Maxina is
-- part of the VITANA ecosystem"). The original seed migration
-- (20260607000000_BOOTSTRAP_seed_community_onboarding_autopilot.sql) hardcoded
-- the wrong name into the onboarding_maxina row's title/summary, and every
-- new community member since has had that wrong copy inserted into their
-- Autopilot recommendations by the AFTER INSERT trigger on public.user_tenants.
--
-- This migration only redefines seed_community_onboarding_autopilot() with the
-- corrected onboarding_maxina title/summary — CREATE OR REPLACE FUNCTION, so
-- it's a straight superseding definition, not an edit of the already-applied
-- 20260607000000 migration's history. Every other row, and every other field
-- of this row (source_ref, domain, risk_level, impact_score, effort_score,
-- time_estimate_seconds, fingerprint scheme), is byte-for-byte unchanged from
-- the original — only the two text values change. Mirrors
-- STAGE_TEMPLATES.day0['onboarding_maxina'] in community-user-analyzer.ts
-- exactly (guarded by autopilot-onboarding-seed-bundle.test.ts).
--
-- Deliberately NOT included here: a backfill of already-seeded rows that
-- still carry the old "Maxina" copy for users who onboarded before this
-- migration. Those are real user-facing recommendation rows already sitting
-- in front of real members; correcting their text in place is a separate,
-- larger decision (does it re-surface as unread/new, does it matter given
-- Autopilot recommendations expire after 14 days per the seed function's own
-- `expires_at`) that this VTID's scope doesn't need to make. Flagging as an
-- explicit follow-up rather than silently declaring it done.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.seed_community_onboarding_autopilot(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
-- `extensions` is on the path so pgcrypto's digest() (Supabase installs
-- pgcrypto into the `extensions` schema) resolves under the pinned search_path.
SET search_path = public, extensions
AS $fn$
DECLARE
  v_inserted integer := 0;
  v_existing integer;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Gate: only seed when the user has NO community recommendations yet. This
  -- makes the seed a true "first contact" action and prevents it from
  -- re-firing for users who already progressed past onboarding (whose queue
  -- the gateway generator / scheduled cron now own).
  SELECT count(*) INTO v_existing
  FROM public.autopilot_recommendations
  WHERE user_id = p_user_id
    AND source_type = 'community';

  IF v_existing > 0 THEN
    RETURN 0;
  END IF;

  -- The day0 onboarding bundle. MUST stay in sync with STAGE_TEMPLATES.day0 in
  -- community-user-analyzer.ts (guarded by autopilot-onboarding-seed-bundle.test.ts).
  WITH bundle(source_ref, title, summary, domain, risk_level,
              impact_score, effort_score, time_estimate_seconds) AS (
    VALUES
      ('onboarding_profile',          'Complete your profile',         'A complete profile helps us understand you and give better recommendations.',          'community', 'high',   9, 2, 120),
      ('onboarding_avatar',           'Add your photo',                'A profile photo helps others recognize you and builds trust in the community.',         'community', 'high',   9, 1,  60),
      ('onboarding_explore',          'Explore your community',        'See who is nearby and which groups exist.',                                             'community', 'high',   8, 1,  60),
      ('onboarding_interests',        'Share your interests',          'Tell us what you enjoy so we can connect you with like-minded people.',                  'community', 'high',   8, 1,  60),
      ('onboarding_diary_day0',       'Write your first diary entry',  'Start your well-being journey by recording how you feel today.',                        'health',    'high',   8, 2, 120),
      ('onboarding_health',           'Check your health status',      'Take a quick look at your Vitana health index to get started.',                         'health',    'medium', 7, 1,  60),
      ('onboarding_maxina',           'Say hello to Vitana',           'Your AI companion Vitana is ready to get to know you. Start a conversation!',            'community', 'medium', 7, 1,  60),
      ('onboarding_discover_matches', 'Discover your matches',         'See who the community has matched you with based on your interests.',                    'community', 'medium', 6, 1,  30)
  )
  INSERT INTO public.autopilot_recommendations (
    title, summary, domain, risk_level, impact_score, effort_score,
    source_type, source_ref, fingerprint, run_id,
    status, user_id, time_estimate_seconds,
    expires_at, economic_axis, autonomy_level, contribution_vector, role_scope
  )
  SELECT
    b.title, b.summary, b.domain, b.risk_level, b.impact_score, b.effort_score,
    'community',
    b.source_ref,
    substring(encode(digest('community:' || p_user_id::text || ':' || b.source_ref, 'sha256'), 'hex') for 16),
    'onboarding-seed',
    'new',
    p_user_id,
    b.time_estimate_seconds,
    now() + interval '14 days',
    'none',
    'manual',
    public.vitana_contribution_vector_from_source_ref(b.source_ref),
    'any'
  FROM bundle b
  -- Belt-and-suspenders against re-runs / concurrent inserts: never create a
  -- second live row for the same per-user fingerprint.
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.autopilot_recommendations r
    WHERE r.user_id = p_user_id
      AND r.fingerprint = substring(encode(digest('community:' || p_user_id::text || ':' || b.source_ref, 'sha256'), 'hex') for 16)
      AND r.status IN ('new', 'snoozed')
  );

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$fn$;

COMMENT ON FUNCTION public.seed_community_onboarding_autopilot(uuid) IS
  'BOOTSTRAP-ONBOARDING-AUTOPILOT-SEED (VTID-03767 naming fix): inserts the day0 community onboarding Autopilot bundle (8 onboarding_* rows) for a user. Idempotent (no-op if the user already has any community rec). Mirrors STAGE_TEMPLATES.day0 in community-user-analyzer.ts.';
