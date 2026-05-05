/**
 * VTID-02783: drift detection — `nav:check` must pass on every PR.
 *
 * Runs the sync script in --check mode. If the auto-managed block in
 * `navigation-catalog.ts` is stale relative to
 * `vitana-v1/src/navigation/screens.manifest.ts`, the script exits 1 and
 * this test fails. CI on every PR re-runs the script and fails the build.
 *
 * In local dev (no vitana-v1 sibling, no $VITANA_V1_REPO_PATH), the script
 * skips silently — this test follows the same skip-when-unreachable rule.
 */

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const GATEWAY_ROOT = resolve(__dirname, '..');
const SCRIPT = join(GATEWAY_ROOT, 'scripts/sync-nav-catalog-from-manifest.ts');

function findV1(): string | null {
  const candidates = [
    process.env.VITANA_V1_REPO_PATH,
    resolve(GATEWAY_ROOT, '../../../vitana-v1'),
    '/home/dstev/vitana-v1',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(join(c, 'src/navigation/screens.manifest.ts'))) return c;
  }
  return null;
}

describe('VTID-02783 — manifest → catalog drift gate', () => {
  test('navigation-catalog.ts auto-managed block is in sync with vitana-v1 manifest', () => {
    const v1 = findV1();
    if (!v1) {
      // CI environments must set $VITANA_V1_REPO_PATH; locally we skip.
      console.warn('[nav-manifest-sync.test] vitana-v1 not reachable — skipping');
      return;
    }
    expect(() =>
      execSync(`npx tsx ${SCRIPT} --check`, {
        cwd: GATEWAY_ROOT,
        env: { ...process.env, VITANA_V1_REPO_PATH: v1 },
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});
