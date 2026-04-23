/**
 * new-scanner-needs-seed-migration
 *
 * If a new scanner module was added under scripts/ci/scanners/ (excluding
 * the shared helpers and the registry itself), the PR should also include
 * a migration under supabase/migrations/ that inserts the row into
 * dev_autopilot_scanners.
 *
 * Coarse check — we don't parse the migration's SQL, just assert that at
 * least one migration under supabase/migrations/ was added in the same PR.
 * The 20260424000000 migration's ON CONFLICT DO UPDATE means operators can
 * re-apply it with the new row appended.
 */

export const meta = {
  rule: 'new-scanner-needs-seed-migration',
  category: 'companion',
  severity: 'warning',
};

const SKIP_PATHS = new Set([
  'scripts/ci/scanners/_shared.mjs',
  'scripts/ci/scanners/registry.mjs',
]);

export async function check({ changedFiles }) {
  const newScanners = changedFiles.filter(f =>
    f.status === 'A'
    && /^scripts\/ci\/scanners\/.+\.mjs$/.test(f.path)
    && !SKIP_PATHS.has(f.path)
    && !f.path.startsWith('scripts/ci/scanners/_')
  );
  if (newScanners.length === 0) return [];

  const migrationTouched = changedFiles.some(f =>
    (f.status === 'A' || f.status === 'M')
    && /^supabase\/migrations\/.+\.sql$/.test(f.path)
  );
  if (migrationTouched) return [];

  return [{
    rule: meta.rule,
    severity: meta.severity,
    file_path: newScanners[0].path,
    line_number: null,
    message: `New scanner file(s) added [${newScanners.map(s => s.path).join(', ')}] but no supabase/migrations/*.sql was updated to seed the dev_autopilot_scanners row.`,
    suggested_action: `Append a migration that inserts the new scanner(s) into dev_autopilot_scanners with matching metadata (title, description, signal_type, category, maturity, severity, risk_class). Pattern: follow 20260424000000_BOOTSTRAP_dev_autopilot_scanners_registry.sql.`,
    raw: { new_scanners: newScanners.map(s => s.path) },
  }];
}
