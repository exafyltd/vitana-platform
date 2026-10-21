/**
 * migration-requires-code-touch
 *
 * A new supabase/migrations/*.sql file that doesn't coincide with any
 * change under services/gateway/src (or services/autopilot-worker/src)
 * is often a red flag:
 *   - Schema drift: table/column added but nothing reads/writes it.
 *   - Forgotten rollout: the code that USES the new schema lives in another
 *     unmerged PR.
 *
 * Warning-level: there are legit cases (pure-RLS migration, data backfill,
 * index tweak) that don't touch code. A human reviewer can dismiss.
 *
 * Exclusions:
 *   - BOOTSTRAP-prefixed migrations that are known to be schema-only
 *     (index, RLS, retention cleanup) can add a `// impact-allow-solo-migration`
 *     comment anywhere in the SQL to opt out.
 */

import { readFileAtRepo } from './_shared.mjs';

export const meta = {
  rule: 'migration-requires-code-touch',
  category: 'companion',
  severity: 'warning',
};

export async function check({ changedFiles, repoRoot }) {
  const addedMigrations = changedFiles.filter(f =>
    f.status === 'A' && /^supabase\/migrations\/.+\.sql$/.test(f.path)
  );
  if (addedMigrations.length === 0) return [];

  const codeTouched = changedFiles.some(f =>
    (f.status === 'A' || f.status === 'M')
    && (/^services\/gateway\/src\//.test(f.path)
        || /^services\/autopilot-worker\/src\//.test(f.path))
  );
  if (codeTouched) return [];

  // Check for opt-out sentinel in each migration.
  const relevant = [];
  for (const m of addedMigrations) {
    const sql = readFileAtRepo(repoRoot, m.path);
    if (sql && /impact-allow-solo-migration/i.test(sql)) continue;
    relevant.push(m.path);
  }
  if (relevant.length === 0) return [];

  return [{
    rule: meta.rule,
    severity: meta.severity,
    file_path: relevant[0],
    line_number: null,
    message: `${relevant.length} migration(s) added with no gateway/worker code change: ${relevant.join(', ')}.`,
    suggested_action: `Confirm the schema change is already usable by existing code, or land the code change in the same PR. To silence this intentionally (pure-RLS / index / backfill / retention), add the comment \`-- impact-allow-solo-migration\` anywhere in the migration SQL.`,
    raw: { migrations: relevant },
  }];
}
