-- =============================================================================
-- Dev Autopilot — impact rule registry
-- =============================================================================
-- DB-side source of truth for the diff-aware rules that run on every PR
-- (scripts/ci/impact-rules/*.mjs, driven by scripts/ci/dev-autopilot-impact-scan.mjs).
--
-- Same pattern as dev_autopilot_scanners: the code file
-- scripts/ci/impact-rules/registry.mjs is the authoritative list; this
-- table is seeded from it so the Command Hub can show the inventory with
-- operator-controlled enabled/disabled state.
--
-- Join pattern (Command Hub GET /impact-rules):
--   SELECT r.* FROM dev_autopilot_impact_rules r ORDER BY category, rule;
--
-- Categories:
--   - companion : "if X changed, Y should change too"
--   - conflict  : "this PR contradicts or duplicates existing state"
--   - semantic  : "new code should match how the rest of the system does it"
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.dev_autopilot_impact_rules (
  rule              TEXT        PRIMARY KEY,
  title             TEXT        NOT NULL,
  description       TEXT        NOT NULL,
  category          TEXT        NOT NULL
    CHECK (category IN ('companion','conflict','semantic')),
  severity          TEXT        NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('blocker','warning','info')),
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  docs_url          TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dev_autopilot_impact_rules_category
  ON public.dev_autopilot_impact_rules (category, enabled);

ALTER TABLE public.dev_autopilot_impact_rules ENABLE ROW LEVEL SECURITY;
-- Service role reads/writes. No policies needed.

-- Seed the initial 11 rules. Re-runnable via ON CONFLICT DO UPDATE.
INSERT INTO public.dev_autopilot_impact_rules
  (rule, title, description, category, severity, enabled)
VALUES
  ('new-signal-type-requires-registry',
   'New SignalType needs a scanner registry entry',
   'When a new value is added to the SignalType union in services/gateway/src/services/dev-autopilot-synthesis.ts, scripts/ci/scanners/registry.mjs must declare the scanner that emits it. Without the registry entry, scan output for that type lands in the queue but the Command Hub Scanners tab cannot show it.',
   'companion', 'blocker', TRUE),
  ('new-scanner-needs-seed-migration',
   'New scanner file needs a DB seed migration',
   'Adding a file under scripts/ci/scanners/ without a corresponding INSERT into dev_autopilot_scanners means the scanner runs but the Command Hub registry table does not know about it — it shows up as an orphan.',
   'companion', 'warning', TRUE),
  ('new-impact-rule-needs-seed-migration',
   'New impact rule file needs a DB seed migration',
   'Adding a file under scripts/ci/impact-rules/ without a corresponding INSERT into dev_autopilot_impact_rules means the rule fires but the Command Hub Impact Rules tab does not reflect it.',
   'companion', 'warning', TRUE),
  ('new-oasis-event-requires-union',
   'emitOasisEvent({ type: X }) must have X in the OasisEventType union',
   'Calls to emitOasisEvent with a type string that is not in services/gateway/src/types/cicd.ts OasisEventType union are rejected by handlers that filter on the union. This rule extracts new event-type strings from the diff and asserts they exist in the union.',
   'companion', 'blocker', TRUE),
  ('migration-requires-code-touch',
   'Migration added without any gateway code change',
   'A new supabase/migrations/*.sql file that does not coincide with any change under services/gateway/src is often a sign of schema drift — the new column/table/policy exists in the DB but nothing in the code uses it yet. Opt-out via `-- impact-allow-solo-migration` comment inside the SQL.',
   'companion', 'warning', TRUE),
  ('new-env-var-requires-workflow-binding',
   'New process.env.X without a binding in any workflow / .env.example',
   'A new process.env.X reference in source code should be explicitly bound in at least one of .github/workflows/*.yml, .env.example, or the Cloud Run deploy config. Unbound env vars read as undefined in production and silently no-op the code path.',
   'companion', 'warning', TRUE),
  ('new-route-needs-test',
   'New gateway route without a sibling test',
   'A new file under services/gateway/src/routes/ without a matching *.test.ts under services/gateway/test/ means the route ships untested. The baseline missing-tests-scanner catches this eventually; catching it at PR time is cheaper to fix. Opt-out via `// impact-allow-no-test` as first line.',
   'companion', 'warning', TRUE),
  ('duplicate-route-registration',
   'New route path collides with an existing registration',
   'A new router.METHOD(path, ...) whose (method, path) already exists in another route file is a silent correctness bug: which handler wins depends on Express version and registration order. Blocks the PR.',
   'conflict', 'blocker', TRUE),
  ('duplicate-table-name',
   'New CREATE TABLE matches an existing table name',
   'A migration that runs CREATE TABLE foo where foo already exists at main will fail at psql time. Catches it before merge so migration dispatch does not trip. Use CREATE TABLE IF NOT EXISTS if intent is idempotent, ALTER TABLE for column changes, or rename to avoid collision.',
   'conflict', 'blocker', TRUE),
  ('new-route-without-auth-middleware',
   'New gateway route without auth middleware',
   'New handler in a route file that has no file-level router.use(requireAuth) AND no per-handler auth call. Mirrors the baseline route-auth-scanner but scoped to diff, so mistakes get flagged before merge. Opt-out via `// public-route` above the handler.',
   'semantic', 'warning', TRUE),
  ('new-mutation-without-oasis-emit',
   'New state-mutating route without an emitOasisEvent call',
   'CLAUDE.md invariant: "Always emit OASIS events for real state transitions." New POST/PUT/PATCH/DELETE handlers that never call emitOasisEvent break observability — Self-Heal and audit cannot see the state change. Opt-out via `// impact-allow-no-oasis` inside the handler body.',
   'semantic', 'warning', TRUE)
ON CONFLICT (rule) DO UPDATE SET
  title       = EXCLUDED.title,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  severity    = EXCLUDED.severity,
  -- Preserve operator-set `enabled`.
  updated_at  = NOW();
