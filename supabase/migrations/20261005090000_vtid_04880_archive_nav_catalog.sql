-- VTID-04880 — archive the legacy voice navigator's tables.
--
-- WHY
--
-- VTID-04846 (gateway) and VTID-04853 (frontend) retired the legacy voice
-- navigator: the voice navigator reads the screen registry (vitana-v1
-- src/navigation/registry/, published as /nav-registry.json). Since the same
-- change merged, nothing in either repo reads or writes these tables:
--   * the db-i18n `nav-catalog` surface (the nightly I18N-DB-SEED seeder, the
--     last writer) is removed in the same PR as this file;
--   * ci_vital_systems_health() no longer reports nav_catalog coverage
--     (step 1), so the morning check and /ops locale-coverage stop raising a
--     false "incomplete locale" about a table nobody reads.
--
-- WHAT — ARCHIVE, NOT DROP
--
-- The three tables and their trigger function move into `legacy_archive`.
-- No row is deleted (live 2026-10-05: nav_catalog 291, nav_catalog_i18n
-- 3,201, nav_catalog_audit 0). PostgREST only exposes `public`, so the tables
-- disappear from the API. The `nav_catalog_i18n.lang` FK to
-- public.supported_locales is dropped, so archived rows never block removing a
-- locale; the FK inside the archive (catalog_id -> nav_catalog) stays.
--
-- APPLY ORDER: exafyltd/vitana-platform PR merged (no reader on main), then
-- the exafyltd/vitana-v1 PR (its i18n gate stops querying nav_catalog), then
-- RUN-MIGRATION.yml with this file. Owner-approved in-session 2026-10-05.
--
-- ROLLBACK (run by hand if ever needed):
--   ALTER TABLE legacy_archive.nav_catalog       SET SCHEMA public;
--   ALTER TABLE legacy_archive.nav_catalog_audit SET SCHEMA public;
--   ALTER TABLE legacy_archive.nav_catalog_i18n  SET SCHEMA public;
--   ALTER FUNCTION legacy_archive.nav_catalog_touch_updated_at() SET SCHEMA public;
--   DELETE FROM public.nav_catalog_i18n i
--    WHERE NOT EXISTS (SELECT 1 FROM public.supported_locales s WHERE s.code = i.lang);
--   ALTER TABLE public.nav_catalog_i18n ADD CONSTRAINT nav_catalog_i18n_lang_fkey
--     FOREIGN KEY (lang) REFERENCES public.supported_locales(code) ON UPDATE CASCADE NOT VALID;
--   ALTER TABLE public.nav_catalog_i18n VALIDATE CONSTRAINT nav_catalog_i18n_lang_fkey;
--   -- then re-apply 20260819085846_vtid_03679_*.sql for the old health function.
--
-- impact-allow-solo-migration
--   Its code half (the db-i18n surface, the /ops evaluator, the morning check)
--   ships in the same PR; this file only follows it.

BEGIN;

-- 1. The health function without the two nav_catalog keys (otherwise the
--    same body as 20260819085846_vtid_03679, the live definition).
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
    -- `status='ga'` (user-selectable in the picker) while its rows in
    -- journey_checklist_translations are partial or zero, which renders as German content inside
    -- an otherwise fully translated UI with no error anywhere. 'en' is the
    -- canonical full-coverage locale per VTID-03644/03650's own measurements.
    --
    -- Completeness is judged per FIELD, not per row, and joined on the
    -- canonical row's own key (topic_id) rather than compared
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
           -- VTID-03679: 'de' excluded — it is the checklist's SOURCE
           -- language, authored outside this overlay table. Only 4 explicit
           -- override rows exist for it (by design, see migration header),
           -- so comparing it against the 254-row 'en' overlay count is a
           -- category error, not a translation gap.
           WHERE sl.status = 'ga' AND sl.code NOT IN ('en', 'de')
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
  'VTID-03666/03679/04880: AI-provider governance (forbidden anthropic/vertex '
  'routing, credit-balance failures) + field-level DB-content locale '
  'coverage (journey_checklist_translations vs GA status, joined on the '
  'canonical topic key with every translatable field required non-empty; '
  'de excluded — it is the source language, VTID-03679) + the VTID-03506 '
  'notification test-actor guard, for MORNING-SYSTEM-HEALTH-CHECK. The '
  'Navigator catalog keys were removed in VTID-04880. service_role only.';

-- 2. The archive schema: not exposed, not readable by clients.
CREATE SCHEMA IF NOT EXISTS legacy_archive;
REVOKE ALL ON SCHEMA legacy_archive FROM PUBLIC, anon, authenticated;
COMMENT ON SCHEMA legacy_archive IS
  'Retired tables kept for reference, never read by the app (VTID-04880).';

-- 3. Uncouple the archived translations from the live locale registry.
ALTER TABLE public.nav_catalog_i18n DROP CONSTRAINT IF EXISTS nav_catalog_i18n_lang_fkey;

-- 4. Move the tables (their triggers, indexes, policies and the internal FK
--    move with them) and the trigger function they share.
ALTER TABLE public.nav_catalog       SET SCHEMA legacy_archive;
ALTER TABLE public.nav_catalog_audit SET SCHEMA legacy_archive;
ALTER TABLE public.nav_catalog_i18n  SET SCHEMA legacy_archive;
ALTER FUNCTION public.nav_catalog_touch_updated_at() SET SCHEMA legacy_archive;

-- 5. Guard: nothing left in public may still depend on or name the tables.
DO $$
DECLARE
  v_views text;
  v_funcs text;
BEGIN
  SELECT string_agg(DISTINCT v.relname, ', ') INTO v_views
    FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_class v ON v.oid = r.ev_class
    JOIN pg_namespace vn ON vn.oid = v.relnamespace
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_namespace tn ON tn.oid = t.relnamespace
   WHERE tn.nspname = 'legacy_archive'
     AND t.relname IN ('nav_catalog', 'nav_catalog_audit', 'nav_catalog_i18n')
     AND vn.nspname = 'public';
  IF v_views IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-04880: public views still depend on nav_catalog*: %', v_views;
  END IF;

  SELECT string_agg(p.proname, ', ') INTO v_funcs
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc ~ '\mnav_catalog(_i18n|_audit)?\M';
  IF v_funcs IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-04880: public functions still reference nav_catalog*: %', v_funcs;
  END IF;
END $$;

COMMIT;
