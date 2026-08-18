-- VTID-03666 — Morning health check rebuild: AI-provider governance +
-- DB-content locale coverage, over PostgREST (service_role only), same
-- transport pattern as ci_system_health/ci_welcome_greeting_health
-- (20260804100000_vtid_03492_ci_health_rpcs_v2.sql) and
-- ci_orb_session_state_health/ci_ledger_integrity_check.
--
-- WHY THIS EXISTS
--
-- MORNING-SYSTEM-HEALTH-CHECK.yml was written the week gateway/community-app
-- were still on Cloud Run and before the standing "Claude always via Bedrock,
-- never anthropic" rule (VTID-03563) and the 8-language DB-content release
-- (VTID-03515/03580, live 18 Aug 2026) existed. It never asked about either.
-- Both have already broken silently once each — 268 anthropic credit-balance
-- failures over 14 days (VTID-03563) and es/sr/fr sitting at zero
-- nav_catalog_i18n rows while marked 'ga' in the picker (VTID-03519's own
-- finding) — and both failure shapes are silent by construction: a routing
-- table or a status column can say the right thing while the data behind it
-- disagrees. This RPC gives the daily check a way to ask the live database,
-- not the config that describes it.
--
-- SECURITY: SECURITY DEFINER, service_role only — same as its siblings.
-- Returns counts, provider/locale labels and small aggregate lists, never
-- user content or credentials.
--
-- impact-allow-solo-migration
--   No gateway/worker code change accompanies this migration on purpose:
--   the only caller is .github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml,
--   shipped in this same PR, which invokes the RPC directly over PostgREST
--   (the same shape as ci_system_health/ci_welcome_greeting_health/
--   ci_orb_session_state_health/ci_ledger_integrity_check, none of which
--   have a gateway call site either).

CREATE OR REPLACE FUNCTION public.ci_vital_systems_health()
RETURNS json
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
STABLE
AS $$
  SELECT json_build_object(

    -- -----------------------------------------------------------------------
    -- AI provider governance (CLAUDE.md ALWAYS 10a/10b/10c, VTID-03563/03579).
    -- Claude runs on Bedrock, always; the direct Anthropic API has no credit
    -- balance and every call to it silently falls back to Google — a routing
    -- table can read "on Claude" while completion telemetry shows 100%
    -- Google. Checked across every currently-active policy row so this does
    -- not depend on knowing which `environment` string production runs
    -- under (LLM_ROUTING_ENV is not pinned in any tracked deploy workflow).
    -- -----------------------------------------------------------------------
    'llm_stages_on_forbidden_anthropic', (
      SELECT coalesce(json_agg(json_build_object(
               'environment', t.environment, 'stage', t.stage,
               'primary_provider', t.primary_provider,
               'fallback_provider', t.fallback_provider
             )), '[]'::json)
        FROM (
          SELECT lrp.environment AS environment, s.key AS stage,
                 s.value ->> 'primary_provider' AS primary_provider,
                 s.value ->> 'fallback_provider' AS fallback_provider
            FROM public.llm_routing_policy lrp,
                 jsonb_each(lrp.policy) AS s(key, value)
           WHERE lrp.is_active = true
        ) t
       WHERE t.primary_provider = 'anthropic' OR t.fallback_provider = 'anthropic'
    ),
    'llm_anthropic_credit_failures_24h', (
      SELECT count(*) FROM public.oasis_events
       WHERE topic = 'llm.call.failed'
         AND created_at >= now() - interval '24 hours'
         AND metadata ->> 'provider' = 'anthropic'
    ),
    'llm_bedrock_completions_24h', (
      SELECT count(*) FROM public.oasis_events
       WHERE topic = 'llm.call.completed'
         AND created_at >= now() - interval '24 hours'
         AND metadata ->> 'provider' = 'bedrock'
    ),
    -- Informational, not a hard fail: some Vertex traffic is legitimate
    -- (ORB voice's Nova-Sonic-unavailable fallback, §2e). A silent Google
    -- fallback for a *Claude* stage is the incident (rule 10c); a sustained
    -- spike here is the signal worth chasing by hand, not an automatic FAIL.
    'llm_vertex_completions_24h', (
      SELECT count(*) FROM public.oasis_events
       WHERE topic = 'llm.call.completed'
         AND created_at >= now() - interval '24 hours'
         AND metadata ->> 'provider' = 'vertex'
    ),

    -- -----------------------------------------------------------------------
    -- DB-content locale coverage (VTID-03515/03580). `supported_locales` is
    -- the single registry gating what the seeder will write; a locale can be
    -- `status='ga'` (user-selectable in the picker) while its rows in these
    -- two tables are partial or zero, which renders as German content inside
    -- an otherwise fully translated UI with no error anywhere. 'en' is the
    -- canonical full-coverage locale per VTID-03644/03650's own measurements.
    -- -----------------------------------------------------------------------
    'locales_ga', (SELECT count(*) FROM public.supported_locales WHERE status = 'ga'),
    'locales_beta', (SELECT count(*) FROM public.supported_locales WHERE status = 'beta'),
    'journey_checklist_canonical_topics', (
      SELECT count(*) FROM public.journey_checklist_translations WHERE locale = 'en'
    ),
    'journey_checklist_incomplete_ga_locales', (
      SELECT coalesce(json_agg(json_build_object(
               'locale', x.code, 'rows', x.rows, 'expected', x.expected
             )), '[]'::json)
        FROM (
          SELECT sl.code, count(jct.locale) AS rows,
                 (SELECT count(*) FROM public.journey_checklist_translations WHERE locale = 'en') AS expected
            FROM public.supported_locales sl
            LEFT JOIN public.journey_checklist_translations jct ON jct.locale = sl.code
           WHERE sl.status = 'ga' AND sl.code <> 'en'
           GROUP BY sl.code
        ) x
       WHERE x.rows < x.expected
    ),
    'nav_catalog_canonical_entries', (
      SELECT count(*) FROM public.nav_catalog_i18n WHERE lang = 'en'
    ),
    'nav_catalog_incomplete_ga_locales', (
      SELECT coalesce(json_agg(json_build_object(
               'locale', x.code, 'rows', x.rows, 'expected', x.expected
             )), '[]'::json)
        FROM (
          SELECT sl.code, count(nci.lang) AS rows,
                 (SELECT count(*) FROM public.nav_catalog_i18n WHERE lang = 'en') AS expected
            FROM public.supported_locales sl
            LEFT JOIN public.nav_catalog_i18n nci ON nci.lang = sl.code
           WHERE sl.status = 'ga' AND sl.code <> 'en'
           GROUP BY sl.code
        ) x
       WHERE x.rows < x.expected
    ),

    -- -----------------------------------------------------------------------
    -- Notification test-actor safety guard (VTID-03506). Regression guard
    -- for the incident where a test account's writes fanned out to 192 real
    -- members as 960 notifications / 600 pushes. This does not verify the
    -- rule against production writes (forbidden — CLAUDE.md rule 31/31b) —
    -- it only asserts the DB-side guard that suppresses fan-out is still
    -- installed and enabled.
    -- -----------------------------------------------------------------------
    'notif_test_actor_guard_present', EXISTS (
      SELECT 1 FROM pg_proc WHERE proname = '_notif_is_test_actor'
    ),
    'notif_test_actor_trigger_enabled', COALESCE(
      (SELECT tgenabled::text = 'O' FROM pg_trigger
        WHERE tgname = 'trg_suppress_test_actor_notifications'), false
    )
  );
$$;

REVOKE ALL ON FUNCTION public.ci_vital_systems_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ci_vital_systems_health() TO service_role;

COMMENT ON FUNCTION public.ci_vital_systems_health() IS
  'VTID-03666: AI-provider governance (forbidden anthropic routing, credit-'
  'balance failures) + DB-content locale coverage (journey_checklist_'
  'translations / nav_catalog_i18n vs GA status) + the VTID-03506 '
  'notification test-actor guard, for MORNING-SYSTEM-HEALTH-CHECK. '
  'service_role only, reachable over PostgREST because GitHub Actions '
  'runner IPs cannot reach the DB pooler directly (VTID-03485/03492).';
