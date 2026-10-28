/**
 * VTID-05080 — OPT-IN sync check (REGEN_SCREENS_CHECK=1, or
 * `npm run test:screens-catalog-sync`). Verifies the committed screen catalog
 * matches what the regen script would generate from main's own sources.
 *
 * Opt-in on purpose: in the default gateway run it would turn every PR that
 * edits Command Hub navigation red until the bot's catalog PR lands, and in
 * STAGING-VERIFY it would judge sync timing instead of the deployed build.
 * The REGEN-SCREENS-CATALOG workflow runs the same `--check` before it pushes.
 */
import { spawnSync } from 'child_process';
import * as path from 'path';

const GATEWAY = path.resolve(__dirname, '..');
const enabled = process.env.REGEN_SCREENS_CHECK === '1';

(enabled ? describe : describe.skip)('VTID-05080 screen catalog is in sync with its sources', () => {
  it('regen-screens-catalog.mjs --check exits 0 (DEV rows, navigation-config.js, overrides)', () => {
    const r = spawnSync('node', [path.join(GATEWAY, 'scripts/regen-screens-catalog.mjs'), '--check'], {
      encoding: 'utf8',
      env: { ...process.env, VITANA_V1_ROOT: path.join(GATEWAY, '.no-such-vitana-v1') },
    });
    expect(r.stderr).not.toContain('out of sync');
    expect(r.status).toBe(0);
  });
});
