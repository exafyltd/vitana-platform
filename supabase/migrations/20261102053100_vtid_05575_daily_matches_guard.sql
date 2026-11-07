-- VTID-05575 (mt-network-r2/matching-intent-scope-db) M2: the daily_matches write guard and the health-reason filter.
--
-- Three rules, enforced by a BEFORE INSERT OR UPDATE trigger so that every writer (the nightly edge function, a later
-- gateway path, a member's client) is held to them:
--  1. D25 - no health-derived reason. A match_reasons entry whose code names the Vitana Index, a pillar or health
--     (shared_pillar, similar_index, anything containing index/pillar/health) is removed; an empty result becomes the honest
--     fallback [{"code":"active_member"}]. Legacy string entries are filtered by the same words. Only the code decides:
--     a parameter that merely contains the word is kept. Existing rows are cleaned by this file (their reasons are
--     regenerated nightly; the removed entries are derived values and are not archived, see the rollback note).
--  2. Network rows (scope = 'network') may only point at a member who opted in (global_community_profiles.network_visible,
--     VTID-05582) and is not a service bot, notification test actor or platform-only account (rules 43-45): SQLSTATE 42501.
--     "Registered after it opted in" is caught here, at write time, by is_network_excluded_account().
--  3. Community rows with a tenant_id need a real (non-platform) tenant both members belong to: 42501. A community row with
--     NO tenant_id is still accepted - today's writer sends none - until matching-discover-scope-v1 stamps it.
-- A member (JWT role authenticated / anon) can only mark a match (action, viewed_at): user, matched user, score, reasons,
-- scope and tenant are pinned to their stored values. Service-role and trusted writers are not pinned. An UPDATE that
-- changes neither scope nor the matched user is not re-checked, so a member who opts out later does not break
-- "mark as viewed" on an existing row.
--
-- Depends on VTID-05582 (20261102051000: network_visible, is_network_excluded_account). The functions are plpgsql, so this file
-- applies without it; a network row then errors until it exists. Helpers are service_role only (nobody enumerates who is visible).
-- Safe to re-run. Rollback: docs/validation/VTID-05575/rollback-053100-daily-matches-guard.sql

-- impact-allow-solo-migration: adds three functions and one trigger on one table; the writers that depend on them ship later.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.is_network_candidate(p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.global_community_profiles g WHERE g.user_id = p_user_id AND g.network_visible)
     AND NOT public.is_network_excluded_account(p_user_id);
END;
$$;
REVOKE ALL ON FUNCTION public.is_network_candidate(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_network_candidate(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_network_candidate(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.strip_health_match_reasons(p_reasons jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_reasons) = 'array' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_reasons) e
       WHERE NOT (CASE jsonb_typeof(e)
                    WHEN 'object' THEN coalesce(e ->> 'code', '') ~* '(index|pillar|health)'
                    WHEN 'string' THEN (e #>> '{}') ~* '(similar_index|shared_pillar|vitana index|pillar|health)'
                    ELSE false END))
    THEN (SELECT jsonb_agg(e ORDER BY ord)
            FROM jsonb_array_elements(p_reasons) WITH ORDINALITY AS t(e, ord)
           WHERE NOT (CASE jsonb_typeof(e)
                        WHEN 'object' THEN coalesce(e ->> 'code', '') ~* '(index|pillar|health)'
                        WHEN 'string' THEN (e #>> '{}') ~* '(similar_index|shared_pillar|vitana index|pillar|health)'
                        ELSE false END))
    ELSE '[{"code":"active_member"}]'::jsonb
  END
$$;
REVOKE ALL ON FUNCTION public.strip_health_match_reasons(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.strip_health_match_reasons(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.strip_health_match_reasons(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.daily_matches_scope_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND coalesce((SELECT auth.role()), '') IN ('authenticated', 'anon') THEN
    NEW.user_id := OLD.user_id;
    NEW.matched_user_id := OLD.matched_user_id;
    NEW.match_score := OLD.match_score;
    NEW.match_reasons := OLD.match_reasons;
    NEW.scope := OLD.scope;
    NEW.tenant_id := OLD.tenant_id;
  END IF;

  NEW.match_reasons := public.strip_health_match_reasons(NEW.match_reasons);

  IF TG_OP = 'INSERT'
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.matched_user_id IS DISTINCT FROM OLD.matched_user_id THEN
    IF NEW.scope = 'network' THEN
      IF NOT public.is_network_candidate(NEW.matched_user_id) THEN
        RAISE EXCEPTION 'network_candidate_not_visible' USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.tenant_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1
          FROM public.user_tenants a
          JOIN public.user_tenants b ON b.tenant_id = a.tenant_id
         WHERE a.tenant_id = NEW.tenant_id AND a.user_id = NEW.user_id AND b.user_id = NEW.matched_user_id
           AND NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.tenant_id = a.tenant_id AND t.is_platform)
      ) THEN
        RAISE EXCEPTION 'no_shared_tenant' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.daily_matches_scope_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.daily_matches_scope_guard() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.daily_matches_scope_guard() TO service_role;

DO $mig$
BEGIN
  IF to_regclass('public.daily_matches') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'daily_matches' AND column_name = 'scope') THEN
    RAISE NOTICE 'VTID-05575: daily_matches.scope is absent (apply 20261102053000 first); trigger and clean-up skipped';
    RETURN;
  END IF;

  -- Clean the existing rows BEFORE the trigger exists (so the clean-up is not itself guarded).
  UPDATE public.daily_matches
     SET match_reasons = public.strip_health_match_reasons(match_reasons)
   WHERE match_reasons IS DISTINCT FROM public.strip_health_match_reasons(match_reasons);

  DROP TRIGGER IF EXISTS trg_daily_matches_scope_guard ON public.daily_matches;
  CREATE TRIGGER trg_daily_matches_scope_guard
    BEFORE INSERT OR UPDATE ON public.daily_matches
    FOR EACH ROW EXECUTE FUNCTION public.daily_matches_scope_guard();
END
$mig$;

COMMIT;
