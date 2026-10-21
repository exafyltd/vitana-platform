/**
 * new-route-needs-test
 *
 * A new file under services/gateway/src/routes/ should come with a sibling
 * test under services/gateway/test/. The baseline missing-tests-scanner
 * catches this in cron, but at PR-time we catch it before the debt is born.
 *
 * Exclusions:
 *   - Files that import nothing and export nothing (trivial routes — rare
 *     but exist — opt-out via `// impact-allow-no-test` on first line).
 *   - Files under 50 LOC skip (mirrors the missing-tests-scanner threshold).
 */

import path from 'node:path';
import { readFileAtRepo } from './_shared.mjs';

export const meta = {
  rule: 'new-route-needs-test',
  category: 'companion',
  severity: 'warning',
};

export async function check({ changedFiles, repoRoot }) {
  const newRoutes = changedFiles.filter(f =>
    f.status === 'A'
    && /^services\/gateway\/src\/routes\/.+\.(ts|tsx)$/.test(f.path)
    && !/\.(test|spec)\.(ts|tsx)$/.test(f.path)
    && !f.path.endsWith('.d.ts')
  );
  if (newRoutes.length === 0) return [];

  const findings = [];
  for (const r of newRoutes) {
    const src = readFileAtRepo(repoRoot, r.path);
    if (!src) continue;
    if (/^\s*\/\/\s*impact-allow-no-test/.test(src)) continue;
    if (src.split('\n').length < 50) continue;
    // Derive the expected test file name.
    const base = path.basename(r.path, path.extname(r.path));
    const testCandidates = [
      `services/gateway/test/${base}.test.ts`,
      `services/gateway/tests/${base}.test.ts`,
      `services/gateway/test/routes/${base}.test.ts`,
    ];
    const hasTest = changedFiles.some(f =>
      (f.status === 'A' || f.status === 'M') && testCandidates.includes(f.path)
    );
    if (hasTest) continue;
    findings.push({
      rule: meta.rule,
      severity: meta.severity,
      file_path: r.path,
      line_number: null,
      message: `${r.path} is a new route file but no companion test was added.`,
      suggested_action: `Add ${testCandidates[0]} covering the route's auth + happy-path + error-path. To opt out (rare), add \`// impact-allow-no-test\` as the first line of the route file.`,
      raw: { route_file: r.path, expected_test_files: testCandidates },
    });
  }
  return findings;
}
