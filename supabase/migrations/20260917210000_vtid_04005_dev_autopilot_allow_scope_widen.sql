-- VTID-04005: widen dev_autopilot_config.allow_scope so operator-instructed
-- executions can touch the trees a Claude Code session touches routinely.
--
-- Before: services/gateway/src/{frontend/command-hub,lib,orb,routes,services,types}/**
--         + services/gateway/test(s)/** + services/agents/** + services/worker-runner/**.
-- Gaps that blocked real work (docs/OPERATOR-CONSOLE-GAP-ANALYSIS-2026-09-17.md §3.8):
--   * services/gateway/src/{i18n,providers,constants,middleware,...}/** — not listed
--   * docs/**                 — the evidence pack the validator REQUIRES lives here
--   * scripts/**              — CI guard scripts (scripts/ci/*.cjs) and ops scripts
--   * DATABASE_SCHEMA.md      — the doc every schema change must update
--   * services/oasis-*/**, config/** — sibling services and the service-path map
--
-- Deliberately NOT added: CLAUDE.md (the governance rules an autonomous
-- executor runs under must stay human-edited) and anything in deny_scope.
-- deny_scope is UNCHANGED: supabase/migrations/**, **/auth*, .github/workflows/**,
-- services/gateway/src/lib/supabase.ts, **/.env*, **/credentials* still block,
-- and deny wins over allow in evaluateSafetyGate(). Additive: existing entries kept.

UPDATE dev_autopilot_config
SET allow_scope = (
  SELECT jsonb_agg(DISTINCT v)
  FROM jsonb_array_elements_text(
    COALESCE(allow_scope, '[]'::jsonb) || '[
      "services/gateway/src/**",
      "services/gateway/test/**",
      "services/gateway/tests/**",
      "services/gateway/Dockerfile",
      "services/gateway/Dockerfile.job",
      "services/oasis-operator/**",
      "services/oasis-projector/**",
      "services/autopilot-worker/**",
      "docs/**",
      "scripts/**",
      "config/**",
      "DATABASE_SCHEMA.md"
    ]'::jsonb
  ) AS v
),
updated_at = now()
WHERE id = 1;
