/**
 * Dev Autopilot — canonical scanner registry.
 *
 * This is the ONE list of scanners known to the autopilot. Source of truth for:
 *   - scripts/ci/dev-autopilot-scan.mjs (iterates + runs each scanner)
 *   - supabase/migrations/*_BOOTSTRAP_dev_autopilot_scanners_registry.sql
 *     (seeds the dev_autopilot_scanners table with matching rows)
 *   - services/gateway/src/routes/dev-autopilot.ts GET /scanners
 *     (joins the DB rows with live scan counts for the Command Hub view)
 *
 * Adding a new scanner:
 *   1. Create scripts/ci/scanners/<name>.mjs with `meta` + `run()` exports.
 *   2. Add an entry here (import + push to SCANNERS).
 *   3. Extend the SignalType union + TYPE_EFFORT + TYPE_RISK_CLASS in
 *      services/gateway/src/services/dev-autopilot-synthesis.ts if you
 *      introduced a new signal_type.
 *   4. Add a seed row to the next migration so the registry table stays
 *      aligned with what's actually running.
 *
 * category values: 'quality' | 'security' | 'dependencies' | 'architecture'
 *                  | 'data_integrity' | 'product'
 * maturity values: 'stable'  — heuristic ≥90% correct, safe to auto-approve
 *                  'beta'    — known false-positive rate, manual review recommended
 *                  'alpha'   — experimental, expect noise
 */

export const SCANNERS = [
  {
    scanner: 'todo-scanner-v1',
    title: 'TODO / FIXME / HACK markers',
    description: 'Flags unresolved TODO, FIXME, HACK, XXX markers in source files. Skips bare placeholders without an actual message.',
    signal_type: 'todo',
    category: 'quality',
    maturity: 'stable',
    default_severity: 'low',
    default_risk_class: 'medium',
    docs_url: null,
    enabled: true,
  },
  {
    scanner: 'large-file-scanner-v1',
    title: 'Files above line threshold',
    description: 'Flags files over 1000 LOC (medium) or 2000 LOC (high). Large files are harder to test, review, and refactor safely.',
    signal_type: 'large_file',
    category: 'quality',
    maturity: 'stable',
    default_severity: 'medium',
    default_risk_class: 'high',
    docs_url: null,
    enabled: true,
  },
  {
    scanner: 'missing-tests-scanner-v1',
    title: 'Routes/services without tests',
    description: 'Flags .ts files under src/routes or src/services without a paired *.test.ts. Filters out pure-export modules, config/types/constants files, and files under 50 LOC.',
    signal_type: 'missing_tests',
    category: 'quality',
    maturity: 'stable',
    default_severity: 'medium',
    default_risk_class: 'medium',
    docs_url: null,
    enabled: true,
  },
  {
    scanner: 'safety-gap-scanner-v1',
    title: 'Infrastructure test gaps',
    description: 'Flags missing infrastructure-class guard tests: route-guard startup, admin-auth coverage, RLS-deny assertions, OASIS emission contracts, governance kill-switch tests, deploy smoke, and e2e Playwright coverage.',
    signal_type: 'safety_gap',
    category: 'architecture',
    maturity: 'stable',
    default_severity: 'medium',
    default_risk_class: 'medium',
    docs_url: null,
    enabled: true,
  },
  {
    scanner: 'rls-policy-scanner-v1',
    title: 'Unprotected write-target tables',
    description: 'Parses supabase/migrations to find tables that accept writes without a matching anon-deny RLS policy. The bug pattern behind incident #845 (vitana_index_scores shipped with RLS disabled).',
    signal_type: 'rls_gap',
    category: 'security',
    maturity: 'beta',
    default_severity: 'high',
    default_risk_class: 'medium',
    docs_url: null,
    enabled: true,
  },
  {
    scanner: 'schema-drift-scanner-v1',
    title: 'Gateway reads missing columns',
    description: 'Greps gateway TypeScript for `.from("xxx").select("a,b,c")` and asserts every column exists in the latest supabase/migrations SQL. Catches incident #842 (column drift after a migration rename).',
    signal_type: 'schema_drift',
    category: 'data_integrity',
    maturity: 'beta',
    default_severity: 'high',
    default_risk_class: 'medium',
    docs_url: null,
    enabled: true,
  },
  {
    scanner: 'route-auth-scanner-v1',
    title: 'Routes without auth middleware',
    description: 'Walks services/gateway/src/routes and flags router handlers (router.get/post/put/patch/delete) that do not pass through requireAuth, requireAdmin, requireDevRole, or optionalAuth. Excludes explicitly-public routes marked with `// public-route` sentinel.',
    signal_type: 'missing_auth',
    category: 'security',
    maturity: 'beta',
    default_severity: 'high',
    default_risk_class: 'medium',
    docs_url: null,
    enabled: true,
  },
  {
    scanner: 'secret-exposure-scanner-v1',
    title: 'Hardcoded secrets in source',
    description: 'Regex-scans source files for secret-like patterns (OpenAI keys, Anthropic keys, GitHub PATs, JWT tokens, URLs with embedded credentials). Skips test fixtures and files matching a configurable allowlist.',
    signal_type: 'secret_exposure',
    category: 'security',
    maturity: 'beta',
    default_severity: 'high',
    default_risk_class: 'high',
    docs_url: null,
    enabled: true,
  },
  {
    scanner: 'npm-audit-scanner-v1',
    title: 'Dependency CVEs',
    description: 'Runs `npm audit --json` per service with a package-lock.json and emits one finding per high/critical advisory. Requires node + internet access on the scanner runner.',
    signal_type: 'cve',
    category: 'dependencies',
    maturity: 'stable',
    default_severity: 'high',
    default_risk_class: 'medium',
    docs_url: null,
    enabled: true,
  },
  {
    scanner: 'stale-feature-flag-scanner-v1',
    title: 'Feature flags stale for 90+ days',
    description: 'Reads dev_autopilot_config + any tracked config files with *_enabled boolean toggles, flags entries whose updated_at is older than 90 days. Dead flags accumulate and create invisible coupling between code and DB.',
    signal_type: 'stale_flag',
    category: 'quality',
    maturity: 'beta',
    default_severity: 'low',
    default_risk_class: 'low',
    docs_url: null,
    enabled: true,
  },
  {
    scanner: 'dead-code-scanner-v1',
    title: 'Unreferenced exports',
    description: 'Hand-rolled symbol graph over services/gateway/src: collects every `export const|function|class|interface X` then greps for imports of X across the codebase. Flags exports with zero referenced imports outside their own file.',
    signal_type: 'dead_code',
    category: 'quality',
    maturity: 'alpha',
    default_severity: 'low',
    default_risk_class: 'low',
    docs_url: null,
    enabled: true,
  },
  {
    scanner: 'product-gap-scanner-v1',
    title: 'LLM-proposed extension opportunities',
    description: 'Periodically (max 1x/day) sends the autopilot worker a prompt summarizing the repo structure + recent OASIS events + open findings, asks it to propose 1-3 concrete improvement opportunities the scanners have missed. Emits them as findings for human review.',
    signal_type: 'product_gap',
    category: 'product',
    maturity: 'alpha',
    default_severity: 'low',
    default_risk_class: 'medium',
    docs_url: null,
    enabled: false, // opt-in — requires worker queue + Anthropic budget
  },
  {
    // VTID-02866: Voice experience readiness scanner.
    // Filesystem-only checks. DB-dependent voice checks (provider drift,
    // failure-classes-without-rule) live in the Voice Improve aggregator
    // (PR A source #7) instead — keeps scanner CI free of Supabase env coupling.
    scanner: 'voice-experience-scanner-v1',
    title: 'Voice experience readiness',
    description: 'Filesystem checks for the voice stack: stale awareness signals (wired:not_wired without enforcement_pending), watchdogs without an oasis_topic, voice routes missing auth middleware, hardcoded TTS speakingRate literals (regression of VTID-02857 wiring).',
    signal_type: 'voice_health',
    category: 'quality',
    maturity: 'beta',
    default_severity: 'medium',
    default_risk_class: 'medium',
    docs_url: null,
    enabled: true,
  },
];

export function byKey() {
  const map = new Map();
  for (const s of SCANNERS) map.set(s.scanner, s);
  return map;
}
