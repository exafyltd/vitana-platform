/**
 * new-impact-rule-needs-seed-migration
 *
 * Mirror of new-scanner-needs-seed-migration but for impact rules. A new
 * file under scripts/ci/impact-rules/ should come with a seed migration row.
 */

export const meta = {
  rule: 'new-impact-rule-needs-seed-migration',
  category: 'companion',
  severity: 'warning',
};

const SKIP_PATHS = new Set([
  'scripts/ci/impact-rules/_shared.mjs',
  'scripts/ci/impact-rules/registry.mjs',
]);

export async function check({ changedFiles }) {
  const newRules = changedFiles.filter(f =>
    f.status === 'A'
    && /^scripts\/ci\/impact-rules\/.+\.mjs$/.test(f.path)
    && !SKIP_PATHS.has(f.path)
    && !f.path.startsWith('scripts/ci/impact-rules/_')
  );
  if (newRules.length === 0) return [];

  const migrationTouched = changedFiles.some(f =>
    (f.status === 'A' || f.status === 'M')
    && /^supabase\/migrations\/.+\.sql$/.test(f.path)
  );
  if (migrationTouched) return [];

  return [{
    rule: meta.rule,
    severity: meta.severity,
    file_path: newRules[0].path,
    line_number: null,
    message: `New impact rule file(s) added [${newRules.map(r => r.path).join(', ')}] but no supabase/migrations/*.sql was updated to seed the dev_autopilot_impact_rules row.`,
    suggested_action: `Append a migration that inserts the new rule(s) into dev_autopilot_impact_rules with matching metadata. Pattern: follow the initial dev_autopilot_impact_rules migration's INSERT ... ON CONFLICT DO UPDATE shape.`,
    raw: { new_rules: newRules.map(r => r.path) },
  }];
}
