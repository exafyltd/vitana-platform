-- =============================================================================
-- BOOTSTRAP-ONBOARDING-AUTOPILOT-SEED — seed the community onboarding Autopilot
-- bundle on primary tenant membership insert.
-- =============================================================================
-- ROOT CAUSE (verified against prod 2026-06-01):
--   A freshly created community account opens the Autopilot popup and sees the
--   empty state. autopilot_recommendation_runs for source_type='community' only
--   ever carry trigger_type IN ('scheduled','manual') — ZERO 'first_login' and
--   ZERO 'auto_replenish' runs have ever fired, and NO 'onboarding_*' rows have
--   ever existed in autopilot_recommendations.
--
--   The intended seeding trigger was the gateway-side fire-and-forget in
--   services/gateway/src/routes/auth.ts (generatePersonalRecommendations with
--   trigger_type='first_login'). But vitana-v1 authenticates DIRECTLY against
--   Supabase Auth (supabase.auth.signInWithPassword / signUp) and never calls
--   the gateway /api/v1/auth/login endpoint — so that hook is dead code for the
--   community app. The GET /recommendations inline lazy-gen ('auto_replenish')
--   is the only other path and (a) never populates the badge /count endpoint and
--   (b) only fires when the popup is opened, which is after the day0 onboarding
--   window has often passed.
--
-- WHY A TRIGGER (and not an endpoint):
--   This is the SAME class of bug — and the SAME fix — as VTID-03089
--   (fire_welcome_chat_on_membership). The onboarding bundle must be seeded on
--   the atomic event "a new user becomes a primary community member", regardless
--   of which HTTP path created the rows. A trigger fires on the row insert
--   itself, so it is bypass-proof and makes BOTH /recommendations and
--   /recommendations/count return > 0 immediately, deterministically.
--
-- PARITY / NO-DRIFT:
--   The seeded rows mirror STAGE_TEMPLATES.day0 in
--   services/gateway/src/services/recommendation-engine/analyzers/
--   community-user-analyzer.ts EXACTLY (source_ref, title, summary, domain,
--   risk_level=priority, impact_score, effort_score, time_estimate_seconds).
--   English copy is used on purpose: a brand-new user has no
--   memory_facts.preferred_language fact yet, so the analyzer itself resolves
--   to 'en' for day0. Fingerprints use the SAME scheme the TS generator uses —
--   substring(sha256('community:'||user_id||':'||source_ref) for 16) — verified
--   against live rows — so when the gateway generator / cron later run for the
--   same user they treat these as duplicates (status new/snoozed) and skip them.
--   A gateway Jest test (autopilot-onboarding-seed-bundle.test.ts) guards the
--   parity so the two definitions cannot drift.
--
-- SAFETY:
--   SECURITY DEFINER + explicit search_path. The trigger wrapper is wrapped in
--   EXCEPTION WHEN OTHERS so a seeding failure NEVER blocks the user_tenants
--   insert (errors are RAISE WARNING'd for log capture). Idempotent: the
--   function no-ops when the user already has any community recommendation.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Core seeding function — callable directly (smoke tests / backfill) and from
-- the membership trigger below.
-- -----------------------------------------------------------------------------
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
      ('onboarding_maxina',           'Say hello to Maxina',           'Your AI companion Maxina is ready to get to know you. Start a conversation!',            'community', 'medium', 7, 1,  60),
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
  'BOOTSTRAP-ONBOARDING-AUTOPILOT-SEED: inserts the day0 community onboarding Autopilot bundle (8 onboarding_* rows) for a user. Idempotent (no-op if the user already has any community rec). Mirrors STAGE_TEMPLATES.day0 in community-user-analyzer.ts.';

-- -----------------------------------------------------------------------------
-- Trigger wrapper — fires on primary community membership insert (mirrors the
-- VTID-03089 welcome-chat trigger pattern). Fail-soft: never blocks signup.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.seed_onboarding_autopilot_on_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_bot uuid := '00000000-0000-0000-0000-000000000001';
  v_n   integer;
BEGIN
  IF NEW.is_primary IS NOT TRUE THEN RETURN NEW; END IF;
  IF NEW.user_id = v_bot       THEN RETURN NEW; END IF;
  -- Only community memberships get the community onboarding bundle.
  IF COALESCE(NEW.active_role, 'community') <> 'community' THEN RETURN NEW; END IF;

  v_n := public.seed_community_onboarding_autopilot(NEW.user_id);
  RAISE NOTICE '[seed_onboarding_autopilot] user %: seeded % onboarding recs', NEW.user_id, v_n;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Never block the user_tenants insert. Surface to logs for ops.
    RAISE WARNING '[seed_onboarding_autopilot] FAILED for user %: % / %', NEW.user_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.seed_onboarding_autopilot_on_membership() IS
  'BOOTSTRAP-ONBOARDING-AUTOPILOT-SEED: seeds the community onboarding Autopilot bundle when a user becomes a primary community member. Fail-soft, idempotent.';

DROP TRIGGER IF EXISTS seed_onboarding_autopilot_on_primary_membership ON public.user_tenants;

CREATE TRIGGER seed_onboarding_autopilot_on_primary_membership
AFTER INSERT ON public.user_tenants
FOR EACH ROW
WHEN (NEW.is_primary = true)
EXECUTE FUNCTION public.seed_onboarding_autopilot_on_membership();

COMMENT ON TRIGGER seed_onboarding_autopilot_on_primary_membership ON public.user_tenants IS
  'BOOTSTRAP-ONBOARDING-AUTOPILOT-SEED: seeds the day0 community onboarding Autopilot bundle on primary community membership insert. Bypass-proof (fires on row insert, independent of HTTP/login path).';

-- -----------------------------------------------------------------------------
-- Backfill: recent community members (signed up within the last 7 days, i.e.
-- still in/near the onboarding window) who never got an onboarding bundle.
-- Conservative + idempotent — the seed function no-ops anyone who already has
-- community recs.
-- -----------------------------------------------------------------------------
DO $backfill$
DECLARE
  r        RECORD;
  v_n      integer;
  v_total  integer := 0;
  v_users  integer := 0;
BEGIN
  FOR r IN
    SELECT ut.user_id
    FROM public.user_tenants ut
    JOIN public.app_users au ON au.user_id = ut.user_id
    WHERE ut.is_primary = true
      AND COALESCE(ut.active_role, 'community') = 'community'
      AND au.created_at > now() - interval '7 days'
      AND NOT EXISTS (
        SELECT 1 FROM public.autopilot_recommendations r2
        WHERE r2.user_id = ut.user_id AND r2.source_type = 'community'
      )
  LOOP
    v_n := public.seed_community_onboarding_autopilot(r.user_id);
    v_total := v_total + v_n;
    v_users := v_users + 1;
  END LOOP;
  RAISE NOTICE '[seed_onboarding_autopilot backfill] seeded % recs across % recent community users', v_total, v_users;
END;
$backfill$;
