-- =============================================================================
-- Dev Autopilot — scanner registry
-- =============================================================================
-- The registry table is the DB-side source of truth for "what scanners does
-- the autopilot know how to run?". The authoritative list lives in code at
-- scripts/ci/scanners/registry.mjs; this table is seeded from that list so
-- the Command Hub can surface the same inventory with live counts.
--
-- Join pattern (Command Hub GET /dev-autopilot/scanners):
--   SELECT r.*,
--     (SELECT COUNT(*) FROM autopilot_recommendations
--        WHERE source_type='dev_autopilot'
--          AND status='new'
--          AND spec_snapshot->>'scanner' = r.scanner) AS open_findings,
--     (SELECT MAX(created_at) FROM dev_autopilot_signals
--        WHERE scanner = r.scanner) AS last_seen_signal_at
--   FROM dev_autopilot_scanners r;
--
-- Schema choices:
--   - scanner (PK, TEXT) — matches the signal fingerprint field; unique.
--   - enabled (BOOLEAN) — operator-controlled; the scan driver respects it
--     via SCANNER_ALLOWLIST/DENYLIST env vars but we also expose the flag
--     here for UI toggling once the /scanners PATCH endpoint lands.
--   - maturity (TEXT) — stable | beta | alpha; surfaces in the UI so
--     operators know which scanners produce reliable output.
--   - category (TEXT) — quality | security | dependencies | architecture
--     | data_integrity | product.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.dev_autopilot_scanners (
  scanner             TEXT        PRIMARY KEY,
  title               TEXT        NOT NULL,
  description         TEXT        NOT NULL,
  signal_type         TEXT        NOT NULL,
  category            TEXT        NOT NULL
    CHECK (category IN ('quality','security','dependencies','architecture','data_integrity','product')),
  maturity            TEXT        NOT NULL DEFAULT 'beta'
    CHECK (maturity IN ('stable','beta','alpha')),
  default_severity    TEXT        NOT NULL DEFAULT 'low'
    CHECK (default_severity IN ('low','medium','high')),
  default_risk_class  TEXT        NOT NULL DEFAULT 'medium'
    CHECK (default_risk_class IN ('low','medium','high')),
  enabled             BOOLEAN     NOT NULL DEFAULT TRUE,
  docs_url            TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dev_autopilot_scanners_category
  ON public.dev_autopilot_scanners (category, enabled);

ALTER TABLE public.dev_autopilot_scanners ENABLE ROW LEVEL SECURITY;
-- Service role reads/writes; no policies needed.

-- Seed the 12 known scanners. Uses ON CONFLICT to make the migration
-- re-runnable when the registry evolves.
INSERT INTO public.dev_autopilot_scanners
  (scanner, title, description, signal_type, category, maturity, default_severity, default_risk_class, enabled)
VALUES
  ('todo-scanner-v1',
   'TODO / FIXME / HACK markers',
   'Flags unresolved TODO, FIXME, HACK, XXX markers in source files. Skips bare placeholders without an actual message.',
   'todo', 'quality', 'stable', 'low', 'medium', TRUE),
  ('large-file-scanner-v1',
   'Files above line threshold',
   'Flags files over 1000 LOC (medium) or 2000 LOC (high). Large files are harder to test, review, and refactor safely.',
   'large_file', 'quality', 'stable', 'medium', 'high', TRUE),
  ('missing-tests-scanner-v1',
   'Routes/services without tests',
   'Flags .ts files under src/routes or src/services without a paired *.test.ts. Filters out pure-export modules, config/types/constants files, and files under 50 LOC.',
   'missing_tests', 'quality', 'stable', 'medium', 'medium', TRUE),
  ('safety-gap-scanner-v1',
   'Infrastructure test gaps',
   'Flags missing infrastructure-class guard tests: route-guard startup, admin-auth coverage, RLS-deny assertions, OASIS emission contracts, governance kill-switch tests, deploy smoke, and e2e Playwright coverage.',
   'safety_gap', 'architecture', 'stable', 'medium', 'medium', TRUE),
  ('rls-policy-scanner-v1',
   'Unprotected write-target tables',
   'Parses supabase/migrations to find tables that accept writes without a matching anon-deny RLS policy. The bug pattern behind incident #845 (vitana_index_scores shipped with RLS disabled).',
   'rls_gap', 'security', 'beta', 'high', 'medium', TRUE),
  ('schema-drift-scanner-v1',
   'Gateway reads missing columns',
   'Greps gateway TypeScript for .from("xxx").select("a,b,c") and asserts every column exists in the latest supabase/migrations SQL. Catches incident #842 (column drift after a migration rename).',
   'schema_drift', 'data_integrity', 'beta', 'high', 'medium', TRUE),
  ('route-auth-scanner-v1',
   'Routes without auth middleware',
   'Walks services/gateway/src/routes and flags router handlers that do not pass through requireAuth, requireAdmin, requireDevRole, or optionalAuth. Excludes explicitly-public routes marked with a // public-route sentinel.',
   'missing_auth', 'security', 'beta', 'high', 'medium', TRUE),
  ('secret-exposure-scanner-v1',
   'Hardcoded secrets in source',
   'Regex-scans source files for secret-like patterns (OpenAI keys, Anthropic keys, GitHub PATs, JWT tokens, URLs with embedded credentials). Skips test fixtures and files matching a configurable allowlist.',
   'secret_exposure', 'security', 'beta', 'high', 'high', TRUE),
  ('npm-audit-scanner-v1',
   'Dependency CVEs',
   'Runs `npm audit --json` per service with a package-lock.json and emits one finding per high/critical advisory. Requires node + internet access on the scanner runner.',
   'cve', 'dependencies', 'stable', 'high', 'medium', TRUE),
  ('stale-feature-flag-scanner-v1',
   'Feature flags stale for 90+ days',
   'Reads dev_autopilot_config plus env-var-driven flags in source, flags entries whose toggle state has been unchanged for 90 days. Dead flags accumulate and create invisible coupling.',
   'stale_flag', 'quality', 'beta', 'low', 'low', TRUE),
  ('dead-code-scanner-v1',
   'Unreferenced exports',
   'Hand-rolled symbol graph over services/gateway/src: collects every `export const|function|class|interface X` then greps for imports of X across the codebase. Flags exports with zero referenced imports outside their own file.',
   'dead_code', 'quality', 'alpha', 'low', 'low', TRUE),
  ('product-gap-scanner-v1',
   'LLM-proposed extension opportunities',
   'Once per day, sends the autopilot worker a prompt summarizing the repo structure + recent OASIS events + open findings; asks it to propose 1-3 concrete improvement opportunities the heuristic scanners have missed. Emits those as findings for human review.',
   'product_gap', 'product', 'alpha', 'low', 'medium', FALSE) -- opt-in; needs worker queue + Anthropic budget
ON CONFLICT (scanner) DO UPDATE SET
  title              = EXCLUDED.title,
  description        = EXCLUDED.description,
  signal_type        = EXCLUDED.signal_type,
  category           = EXCLUDED.category,
  maturity           = EXCLUDED.maturity,
  default_severity   = EXCLUDED.default_severity,
  default_risk_class = EXCLUDED.default_risk_class,
  -- Preserve operator-set `enabled` — don't overwrite a manual toggle.
  updated_at         = NOW();
