/**
 * Dev Autopilot — impact rule registry.
 *
 * Source of truth for:
 *   - scripts/ci/dev-autopilot-impact-scan.mjs (the driver iterates this list)
 *   - supabase/migrations/*_dev_autopilot_impact_rules.sql (seed rows match)
 *   - services/gateway/src/routes/dev-autopilot.ts GET /impact-rules
 *
 * Categories:
 *   - companion — "if X changed, Y should change too" (missing companions)
 *   - conflict  — "this PR contradicts or duplicates existing state"
 *   - semantic  — "new code should match how the rest of the system does it"
 *
 * Severity:
 *   - blocker  — fails the PR check; merge should not happen without resolution
 *   - warning  — posts comment, does NOT fail the check
 *   - info     — observational, surfaces for review but doesn't gate
 *
 * Adding a new rule:
 *   1. Create scripts/ci/impact-rules/<name>.mjs with meta + check() exports.
 *   2. Add an entry here.
 *   3. Append a seed row to the next migration.
 */

export const IMPACT_RULES = [
  // ── companion rules ──────────────────────────────────────────────────────
  {
    rule: 'new-signal-type-requires-registry',
    title: 'New SignalType needs a scanner registry entry',
    description: 'When a new value is added to the SignalType union in services/gateway/src/services/dev-autopilot-synthesis.ts, scripts/ci/scanners/registry.mjs must declare the scanner that emits it. Without the registry entry, scan output for that type lands in the queue but the Command Hub Scanners tab can\'t show it.',
    category: 'companion',
    severity: 'blocker',
    enabled: true,
  },
  {
    rule: 'new-scanner-needs-seed-migration',
    title: 'New scanner file needs a DB seed migration',
    description: 'Adding a file under scripts/ci/scanners/ without a corresponding INSERT into dev_autopilot_scanners means the scanner runs but the Command Hub registry table doesn\'t know about it — it shows up as an orphan.',
    category: 'companion',
    severity: 'warning',
    enabled: true,
  },
  {
    rule: 'new-impact-rule-needs-seed-migration',
    title: 'New impact rule file needs a DB seed migration',
    description: 'Adding a file under scripts/ci/impact-rules/ without a corresponding INSERT into dev_autopilot_impact_rules means the rule fires but the Command Hub Impact Rules tab doesn\'t reflect it.',
    category: 'companion',
    severity: 'warning',
    enabled: true,
  },
  {
    rule: 'new-oasis-event-requires-union',
    title: 'emitOasisEvent({ type: \'X\' }) must have X in the OasisEventType union',
    description: 'Calls to emitOasisEvent with a type string that isn\'t in services/gateway/src/types/cicd.ts OasisEventType union will be rejected at runtime. This rule extracts new event-type strings from the diff and asserts they exist in the union.',
    category: 'companion',
    severity: 'blocker',
    enabled: true,
  },
  {
    rule: 'migration-requires-code-touch',
    title: 'Migration added without any gateway code change',
    description: 'A new supabase/migrations/*.sql file that doesn\'t coincide with any change under services/gateway/src is often a sign of schema drift — the new column/table/policy exists in the DB but nothing in the code uses it yet.',
    category: 'companion',
    severity: 'warning',
    enabled: true,
  },
  {
    rule: 'new-env-var-requires-workflow-binding',
    title: 'New process.env.X without a binding in .github/workflows',
    description: 'A new process.env.X reference in source code should be explicitly bound in at least one of .github/workflows/*.yml, .env.example, or the Cloud Run deploy config. Unbound env vars read as undefined in production.',
    category: 'companion',
    severity: 'warning',
    enabled: true,
  },
  {
    rule: 'new-route-needs-test',
    title: 'New gateway route without a sibling test',
    description: 'A new file under services/gateway/src/routes/ without a matching *.test.ts under services/gateway/test/ means the route ships untested. The baseline missing-tests-scanner would catch this eventually, but the impact-scan catches it at PR time, which is cheaper to fix.',
    category: 'companion',
    severity: 'warning',
    enabled: true,
  },

  // ── conflict rules ───────────────────────────────────────────────────────
  {
    rule: 'duplicate-route-registration',
    title: 'New route path collides with an existing registration',
    description: 'A new router.METHOD(path, ...) whose (method, full_path) already exists in another route file at main. Duplicate registrations cause the handler that wins to be Express-version-dependent — don\'t ship one.',
    category: 'conflict',
    severity: 'blocker',
    enabled: true,
  },
  {
    rule: 'duplicate-table-name',
    title: 'New CREATE TABLE matches an existing table name',
    description: 'A migration that does CREATE TABLE foo where foo already exists at main will fail at psql time. This catches it before merge rather than at migration-dispatch time.',
    category: 'conflict',
    severity: 'blocker',
    enabled: true,
  },

  // ── semantic rules ───────────────────────────────────────────────────────
  {
    rule: 'new-route-without-auth-middleware',
    title: 'New gateway route without auth middleware',
    description: 'New state-mutating handler (POST/PUT/PATCH/DELETE) in a route file that has no file-level router.use(requireAuth) OR per-handler auth. Mirrors the baseline route-auth-scanner but scoped to the diff, so mistakes get flagged before merge.',
    category: 'semantic',
    severity: 'warning',
    enabled: true,
  },
  {
    rule: 'new-mutation-without-oasis-emit',
    title: 'New state-mutating route without an emitOasisEvent call',
    description: 'CLAUDE.md invariant: "Always emit OASIS events for real state transitions." New POST/PUT/PATCH/DELETE handlers that never call emitOasisEvent break the observability contract — Self-Heal and audit can\'t see the state change.',
    category: 'semantic',
    severity: 'warning',
    enabled: true,
  },
];

export function byRule() {
  const map = new Map();
  for (const r of IMPACT_RULES) map.set(r.rule, r);
  return map;
}
