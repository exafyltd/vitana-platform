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
    -- AI provider governance (CLAUDE.md ALWAYS 10a/10b/10c, IF-THEN 27,
    -- VTID-03563/03579). Claude runs on Bedrock, always; the direct
    -- Anthropic API has no credit balance and every call to it silently
    -- falls back to Google — a routing table can read "on Claude" while
    -- completion telemetry shows 100% Google. Checked across every
    -- currently-active policy row so this does not depend on knowing which
    -- `environment` string production runs under (LLM_ROUTING_ENV is not
    -- pinned in any tracked deploy workflow).
    --
    -- Vertex is forbidden here too, not merely watched: IF-THEN rule 27 is
    -- absolute — "IF you are about to point any stage at vertex or a Gemini
    -- model -> THEN STOP" — with the ORB voice fallback (Nova Sonic ->
    -- Vertex on premature close, §2e) named as the ONE sanctioned exception,
    -- and that fallback lives entirely in the raw ORB Live WS session code
    -- (routes/orb-live.ts), never in llm_routing_policy and never through
    -- startLLMCall/completeLLMCall/failLLMCall — so it cannot appear in
    -- either signal below. A stage or a completion on 'vertex' here is
    -- always the routing table, not ORB voice.
    -- -----------------------------------------------------------------------
    'llm_stages_on_forbidden_provider', (
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
       WHERE t.primary_provider IN ('anthropic', 'vertex')
          OR t.fallback_provider IN ('anthropic', 'vertex')
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
    --
    -- Completeness is judged per FIELD, not per row, and joined on the
    -- canonical row's own key (topic_id / catalog_id) rather than compared
    -- as bare counts: `applyTranslations()`
    -- (services/gateway/src/services/guided-journey/checklist-service.ts)
    -- falls each empty/NULL field back to the German source individually, so
    -- a locale can hold exactly one row per canonical topic — passing a
    -- row-count check outright — while every field on those rows is empty
    -- and every screen still renders German. A row only counts as covered
    -- here when it matches a real canonical key AND every translatable
    -- field on it is non-null and non-empty.
    -- -----------------------------------------------------------------------
    'locales_ga', (SELECT count(*) FROM public.supported_locales WHERE status = 'ga'),
    'locales_beta', (SELECT count(*) FROM public.supported_locales WHERE status = 'beta'),
    'journey_checklist_canonical_topics', (
      SELECT count(*) FROM public.journey_checklist_translations WHERE locale = 'en'
    ),
    'journey_checklist_incomplete_ga_locales', (
      SELECT coalesce(json_agg(json_build_object(
               'locale', x.code, 'complete_rows', x.complete_rows, 'expected', x.expected
             )), '[]'::json)
        FROM (
          SELECT sl.code,
                 count(*) FILTER (
                   WHERE jct.topic_id IS NOT NULL
                     AND coalesce(jct.display_label, '') <> ''
                     AND coalesce(jct.short_description, '') <> ''
                     AND coalesce(jct.explanation_what_it_is, '') <> ''
                     AND coalesce(jct.explanation_user_benefit, '') <> ''
                     AND coalesce(jct.explanation_when_to_use, '') <> ''
                     AND coalesce(jct.explanation_try_this, '') <> ''
                 ) AS complete_rows,
                 (SELECT count(*) FROM public.journey_checklist_translations WHERE locale = 'en') AS expected
            FROM public.supported_locales sl
            CROSS JOIN (
              SELECT topic_id FROM public.journey_checklist_translations WHERE locale = 'en'
            ) canon
            LEFT JOIN public.journey_checklist_translations jct
              ON jct.locale = sl.code AND jct.topic_id = canon.topic_id
           WHERE sl.status = 'ga' AND sl.code <> 'en'
           GROUP BY sl.code
        ) x
       WHERE x.complete_rows < x.expected
    ),
    'nav_catalog_canonical_entries', (
      SELECT count(*) FROM public.nav_catalog_i18n WHERE lang = 'en'
    ),
    'nav_catalog_incomplete_ga_locales', (
      SELECT coalesce(json_agg(json_build_object(
               'locale', x.code, 'complete_rows', x.complete_rows, 'expected', x.expected
             )), '[]'::json)
        FROM (
          SELECT sl.code,
                 count(*) FILTER (
                   WHERE nci.catalog_id IS NOT NULL
                     AND coalesce(nci.title, '') <> ''
                     AND coalesce(nci.description, '') <> ''
                     AND coalesce(nci.when_to_visit, '') <> ''
                 ) AS complete_rows,
                 (SELECT count(*) FROM public.nav_catalog_i18n WHERE lang = 'en') AS expected
            FROM public.supported_locales sl
            CROSS JOIN (
              SELECT catalog_id FROM public.nav_catalog_i18n WHERE lang = 'en'
            ) canon
            LEFT JOIN public.nav_catalog_i18n nci
              ON nci.lang = sl.code AND nci.catalog_id = canon.catalog_id
           WHERE sl.status = 'ga' AND sl.code <> 'en'
           GROUP BY sl.code
        ) x
       WHERE x.complete_rows < x.expected
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
  'VTID-03666: AI-provider governance (forbidden anthropic/vertex routing, '
  'credit-balance failures) + field-level DB-content locale coverage '
  '(journey_checklist_translations / nav_catalog_i18n vs GA status, joined '
  'on canonical topic/catalog keys with every translatable field required '
  'non-empty) + the VTID-03506 notification test-actor guard, for '
  'MORNING-SYSTEM-HEALTH-CHECK. service_role only, reachable over PostgREST '
  'because GitHub Actions runner IPs cannot reach the DB pooler directly '
  '(VTID-03485/03492).';
