-- =============================================================================
-- VTID-03461 — Watcher Phase 2: lessons + rules
-- =============================================================================
-- Plan: docs/WATCHER-AGENT-PLAN.md (VTID-03454). Phase 1: VTID-03460.
--
-- Two stores, deliberately separate:
--
--   watcher_lessons — LEARNED. Derived from observed failures in
--     watcher_steps. Earns confidence through recurrence, decays, can be
--     auto-muted when it stops correlating with anything.
--   watcher_rules   — AUTHORED. Governance invariants from CLAUDE.md that
--     are true on day one, before any history exists. Never auto-derived,
--     never auto-muted.
--
-- Conflating them would be a mistake: a learned lesson with frequency=1 is a
-- guess, while "never dispatch EXEC-DEPLOY to prod post-cutover" is canon.
-- They rank differently and they age differently.
--
-- =============================================================================
-- THIS MIGRATION DROPS dev_autopilot_prompt_learnings
-- =============================================================================
-- Its rows are migrated into watcher_lessons first. The old table is dropped
-- in the SAME migration rather than left behind, because two learning stores
-- reading into the same prompts is precisely how they drift apart — one gets
-- written, the other gets read, and nobody notices for months.
--
-- Deploy-order safety (both orders are safe, verified against the call sites):
--
--   migration first, code second → old code queries a dropped table,
--     PostgREST returns 404, loadRecentLessons() / loadExecutionLessons()
--     both check `r.ok` and are wrapped in try/catch returning [] — the
--     prompt simply carries no lessons block for one deploy window.
--   code first, migration second → new code queries watcher_lessons before
--     it exists, same 404, same [] fallback.
--
-- Neither order breaks planning or execution. That is not luck: those two
-- readers were already written best-effort (see the comment on
-- loadExecutionLessons in dev-autopilot-execute.ts), and this migration
-- depends on that property. If you ever make a lessons read fatal, this
-- migration's safety argument dies with it.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- watcher_lessons — learned memory
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.watcher_lessons (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- WHICH lifecycle step this lesson applies to. The axis
  -- dev_autopilot_prompt_learnings never had — it could only ever describe
  -- pre-PR validation, so nothing learned at CI/deploy/verify time had
  -- anywhere to live.
  stage             TEXT        NOT NULL
    CHECK (stage IN ('planning', 'execute', 'validate', 'ci', 'merge', 'deploy', 'verify', 'any')),

  pattern_type      TEXT        NOT NULL
    CHECK (pattern_type IN (
      -- inherited from dev_autopilot_prompt_learnings
      'tsc_error', 'jest_failure', 'parse_error', 'out_of_scope', 'validation_other',
      -- new in Phase 2: the second half of the lifecycle
      'ci_failure', 'deploy_failure', 'verification_failure',
      'governance_violation', 'review_rejection'
    )),

  -- Normalized signature, e.g. 'TS2307:cannot-find-module'.
  pattern_key       TEXT        NOT NULL,

  -- Replaces the old single `scanner` column. A jsonb scope can express
  -- {scanner}, {service}, {path_glob}, {repo} or any combination — which is
  -- what lets a lesson reach the worker-runner, which has no scanner at all
  -- and was therefore structurally unable to read the old table.
  scope             JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- The actual reminder text. Imperative, short. This is what gets injected,
  -- so vagueness here is what makes a reminder useless downstream.
  lesson            TEXT        NOT NULL,
  example_message   TEXT,
  mitigation_note   TEXT,       -- human-authored upgrade; preferred over `lesson` when set

  evidence_step_ids UUID[]      NOT NULL DEFAULT '{}',
  source_finding_id UUID,
  source_execution_id UUID,

  frequency         INTEGER     NOT NULL DEFAULT 1,
  -- Raised by recurrence, lowered when a reminder was shown and the mistake
  -- happened anyway (which means the text is too vague to act on).
  confidence        REAL        NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),

  -- active    → eligible for injection
  -- muted     → stopped correlating with anything; costing prompt budget for nothing
  -- graduated → promoted into CLAUDE.md or a lint rule, so stop paying for it
  status            TEXT        NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'muted', 'graduated')),

  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (stage, pattern_type, pattern_key)
);

CREATE INDEX IF NOT EXISTS idx_watcher_lessons_retrieval
  ON public.watcher_lessons (stage, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_watcher_lessons_scope
  ON public.watcher_lessons USING GIN (scope);

ALTER TABLE public.watcher_lessons ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.watcher_lessons IS 'VTID-03461 (Watcher Phase 2): learned engineering memory distilled from watcher_steps failures. Supersedes dev_autopilot_prompt_learnings, which this migration drops.';

-- -----------------------------------------------------------------------------
-- watcher_rules — authored invariants
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.watcher_rules (
  rule_key          TEXT        PRIMARY KEY,
  -- Where the rule comes from, so an injected reminder can cite its authority
  -- instead of sounding like the model's own opinion.
  source_ref        TEXT        NOT NULL,
  stage             TEXT        NOT NULL
    CHECK (stage IN ('planning', 'execute', 'validate', 'ci', 'merge', 'deploy', 'verify', 'any')),
  -- Declarative match: {steps:[], touches:[glob], services:[], actors:[]}.
  -- Empty object = always applicable at this stage.
  trigger           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  reminder          TEXT        NOT NULL,
  severity          TEXT        NOT NULL DEFAULT 'warn'
    CHECK (severity IN ('info', 'warn', 'block_candidate')),
  -- block_candidate does NOT block in v1 — it is advisory like the rest, and
  -- only marks a rule as a candidate should gating ever be turned on. A
  -- blocking watcher that is wrong once gets disabled forever.
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_watcher_rules_stage
  ON public.watcher_rules (stage, enabled);

ALTER TABLE public.watcher_rules ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.watcher_rules IS 'VTID-03461: authored governance invariants (seeded from CLAUDE.md). Advisory in v1 — severity block_candidate marks a gating candidate, it does not gate.';

-- -----------------------------------------------------------------------------
-- Migrate dev_autopilot_prompt_learnings → watcher_lessons, then drop it
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.dev_autopilot_prompt_learnings') IS NOT NULL THEN
    INSERT INTO public.watcher_lessons (
      stage, pattern_type, pattern_key, scope, lesson, example_message,
      mitigation_note, source_finding_id, source_execution_id,
      frequency, confidence, first_seen_at, last_seen_at
    )
    SELECT
      -- Every old row was a pre-PR validation failure by construction.
      'execute',
      l.pattern_type,
      l.pattern_key,
      CASE WHEN l.scanner IS NULL THEN '{}'::jsonb
           ELSE jsonb_build_object('scanner', l.scanner) END,
      COALESCE(NULLIF(TRIM(l.mitigation_note), ''), l.pattern_type || ': ' || l.pattern_key),
      l.example_message,
      l.mitigation_note,
      l.finding_id,
      l.execution_id,
      GREATEST(COALESCE(l.frequency, 1), 1),
      -- Migrated rows arrive at the default 0.5. They were real observed
      -- failures, but the old table never tracked whether a lesson actually
      -- helped, so claiming higher confidence would be inventing evidence.
      0.5,
      l.first_seen_at,
      l.last_seen_at
    FROM public.dev_autopilot_prompt_learnings l
    -- The old UNIQUE was (pattern_type, pattern_key, scanner); the new one is
    -- (stage, pattern_type, pattern_key). Two old rows differing only by
    -- scanner therefore collapse — keep the most recent and widen its scope
    -- rather than dropping one on the floor.
    ON CONFLICT (stage, pattern_type, pattern_key) DO UPDATE
      SET frequency = public.watcher_lessons.frequency + EXCLUDED.frequency,
          last_seen_at = GREATEST(public.watcher_lessons.last_seen_at, EXCLUDED.last_seen_at),
          first_seen_at = LEAST(public.watcher_lessons.first_seen_at, EXCLUDED.first_seen_at),
          scope = public.watcher_lessons.scope || EXCLUDED.scope;

    RAISE NOTICE 'VTID-03461: migrated % row(s) from dev_autopilot_prompt_learnings',
      (SELECT count(*) FROM public.dev_autopilot_prompt_learnings);

    DROP TABLE public.dev_autopilot_prompt_learnings;
  ELSE
    RAISE NOTICE 'VTID-03461: dev_autopilot_prompt_learnings absent, nothing to migrate';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Seed authored rules from CLAUDE.md
-- -----------------------------------------------------------------------------
-- These are the invariants that are true before any history accumulates, so
-- the Watcher is useful on its first day rather than after a month of
-- watching. Each cites its source so a reminder carries authority.
--
-- ON CONFLICT DO UPDATE keeps re-running this migration idempotent AND lets a
-- later migration correct a rule's text without a manual UPDATE.
-- -----------------------------------------------------------------------------
INSERT INTO public.watcher_rules (rule_key, source_ref, stage, trigger, reminder, severity) VALUES

-- Deploy / staging-first (§16, §15)
('staging_first.push_deploys_staging_only', 'CLAUDE.md §16', 'deploy', '{}'::jsonb,
 'Push/merge to main deploys STAGING only (gateway-staging). Verify on preview-gateway.vitanaland.com and expect env=staging. Do not look for a prod deploy here.', 'warn'),
('staging_first.no_exec_deploy_to_prod', 'CLAUDE.md §16', 'deploy', '{"touches":[".github/workflows/**"]}'::jsonb,
 'Do NOT hand-dispatch EXEC-DEPLOY to prod as a routine step. Prod is the PUBLISH button or publish-to-prod.sh with a recorded reason.', 'block_candidate'),
('deploy.verify_json_not_html', 'CLAUDE.md §15', 'verify', '{}'::jsonb,
 'After deploy, curl a route that only exists in the new code and check content-type. application/json = route exists; text/html = the route is NOT deployed.', 'warn'),
('deploy.verify_serving_revision', 'CLAUDE.md §15', 'verify', '{}'::jsonb,
 'Confirm the NEW revision is actually serving (gcloud run revisions list). A green deploy job is not proof the new code is live.', 'warn'),
('deploy.never_claim_success_unverified', 'CLAUDE.md §15 Failure Protocol', 'verify', '{}'::jsonb,
 'Never report "deployment succeeded" without post-deploy verification. If verification fails, say it failed.', 'block_candidate'),

-- Feature flags (BOOTSTRAP-ORB-FASTSTART-DRIFT)
('feature_flags.set_is_not_live', 'CLAUDE.md changelog 2026-07-31 (ORB-FASTSTART-DRIFT)', 'deploy', '{}'::jsonb,
 'A set env var is NOT a live feature: isFeatureLive maps staging-only -> false in prod. Check the RESOLVED value, not the presence of the var.', 'warn'),
('config.carry_env_vars_across_stacks', 'CLAUDE.md changelog 2026-07-31', 'deploy', '{}'::jsonb,
 'When a service moves stacks, diff its env vars against the old one. The ORB outage was pure config drift on a cutover, with no code change involved.', 'warn'),

-- VTID governance (§4.1)
('vtid.self_allocate_first', 'CLAUDE.md §4.1 / rule 2b', 'planning', '{}'::jsonb,
 'Allocate the VTID yourself BEFORE touching code (POST /api/v1/vtid/allocate). Never ask the user whether a VTID is needed.', 'warn'),
('vtid.one_per_distinct_work', 'CLAUDE.md §4.1', 'planning', '{}'::jsonb,
 'One VTID per distinct piece of work. Two unrelated fixes in one conversation get two VTIDs, not one shared across both.', 'info'),
('vtid.set_real_title', 'CLAUDE.md §4.1 step 4', 'planning', '{}'::jsonb,
 'Set a real title/summary on the freshly allocated ledger row — never leave the "Allocated - Pending Title" placeholder.', 'info'),
('vtid.terminalize_when_done', 'CLAUDE.md ALWAYS rule 6', 'verify', '{}'::jsonb,
 'Terminalize the task (is_terminal=true, terminal_outcome set) when the work is finished.', 'warn'),

-- Database (§3, ALWAYS 24)
('db.snake_case_tables', 'CLAUDE.md §3', 'execute', '{"touches":["supabase/migrations/**"]}'::jsonb,
 'PostgreSQL tables MUST be snake_case, and TypeScript must reference the exact name. VtidLedger (PascalCase) is deprecated and empty.', 'warn'),
('db.update_schema_doc', 'CLAUDE.md ALWAYS rule 24', 'execute', '{"touches":["supabase/migrations/**"]}'::jsonb,
 'Update DATABASE_SCHEMA.md in the SAME commit as the migration. It is the single source of truth for table names.', 'warn'),
('db.migration_is_dispatch_only', 'RUN-MIGRATION.yml', 'deploy', '{"touches":["supabase/migrations/**"]}'::jsonb,
 'Migrations do NOT auto-apply. RUN-MIGRATION.yml is workflow_dispatch-only — a merged migration has not run until someone dispatches it.', 'warn'),

-- Infra (NEVER 13/14, §1b)
('gcp.artifact_registry_not_gcr', 'CLAUDE.md NEVER rule 14', 'deploy', '{}'::jsonb,
 'Use Artifact Registry (us-central1-docker.pkg.dev), never the deprecated gcr.io.', 'warn'),
('gcp.alive_not_healthz', 'CLAUDE.md NEVER rule 13', 'execute', '{}'::jsonb,
 'Cloud Run health endpoint is /alive, never /healthz.', 'warn'),
('aws.alb_rule_priority_below_10', 'CLAUDE.md §1b', 'deploy', '{}'::jsonb,
 'New host-header rules on vitana-alb-prod need priority < 10. The existing path rules at priority 10 match first regardless of Host and will silently route to staging.', 'warn'),
('aws.prod_deploy_dispatch_only', 'CLAUDE.md §1b', 'deploy', '{}'::jsonb,
 'Every AWS-PROD-DEPLOY-*.yml is workflow_dispatch-only with a required reason. Never add an on:push trigger.', 'block_candidate'),

-- OASIS (§6)
('oasis.no_polling_events', 'CLAUDE.md §6', 'execute', '{}'::jsonb,
 'OASIS is for state transitions and decisions. Polling is not progress, a heartbeat is not an event, repetition is not signal.', 'warn'),

-- i18n (§13b + vitana-v1 CLAUDE.md)
('i18n.no_raw_user_strings', 'CLAUDE.md §13b', 'execute', '{"touches":["services/gateway/src/routes/**"]}'::jsonb,
 'Never hardcode a user-visible string in a gateway response. Use tt(key, locale, params) from i18n/catalog and add all four locales.', 'warn'),
('i18n.llm_needs_user_locale', 'vitana-v1 CLAUDE.md (AI-generated content)', 'execute', '{}'::jsonb,
 'Any LLM call on behalf of a user MUST inject the user preferred language into the system prompt, or it silently answers in English.', 'warn'),

-- Paper trail (the VTID-03419 lesson)
('docs.push_the_paper_trail', 'CLAUDE.md changelog 2026-07-29', 'verify', '{}'::jsonb,
 'Commit and PUSH the doc/changelog update before the session ends. VTID-03419 executed a real production cutover whose paper trail was never pushed, and a later session had to rediscover it.', 'warn'),

-- Architecture (NEVER 1/5)
('arch.no_new_services', 'CLAUDE.md NEVER rule 1', 'planning', '{}'::jsonb,
 'Never invent new projects, environments or services. Extend what exists; the AWS-DR set is the only sanctioned exception and each addition needs its own VTID.', 'block_candidate'),
('arch.prefer_existing_systems', 'CLAUDE.md ALWAYS rule 9 / NEVER rule 5', 'planning', '{}'::jsonb,
 'Check for an existing system before building a new one. Rebuilding something that already exists is a rejected change, not a shortcut.', 'warn'),

-- Testing (verified in this repo, 2026-07-31)
('tests.gateway_tests_live_in_test_dir', 'services/gateway/jest.config.js roots', 'validate', '{"touches":["services/gateway/**"]}'::jsonb,
 'Gateway jest.config.js sets roots:[<rootDir>/test], so a *.test.ts placed next to the source NEVER RUNS. Three such files already exist in src/ and are silently dead. Put gateway tests in services/gateway/test/.', 'warn')

ON CONFLICT (rule_key) DO UPDATE
  SET source_ref = EXCLUDED.source_ref,
      stage      = EXCLUDED.stage,
      trigger    = EXCLUDED.trigger,
      reminder   = EXCLUDED.reminder,
      severity   = EXCLUDED.severity,
      updated_at = NOW();
