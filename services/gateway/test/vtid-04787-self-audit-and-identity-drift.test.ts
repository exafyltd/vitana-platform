/**
 * VTID-04787 — morning check 22 (scheduled-workflow self-audit).
 * MARKETPLACE-SYNC-CRON and DAILY-STATUS-UPDATE were green but reported red:
 * GitHub's filtered runs endpoint (?branch=main&status=completed) answered
 * with stale runs. ALERT-APP-USERS-IDENTITY-DRIFT failed on a stopped Aurora
 * instance and blamed permissions.
 */
import * as fs from 'fs';
import * as path from 'path';

const wf = (n: string) => fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows', n), 'utf8');

describe('VTID-04787', () => {
  it('self-audit lists runs unfiltered and picks the latest completed main run itself', () => {
    const s = wf('MORNING-SYSTEM-HEALTH-CHECK.yml');
    expect(s).not.toContain('runs?branch=main&status=completed&per_page=1');
    expect(s).toContain('/runs?per_page=30');
    expect(s).toContain('select(.head_branch=="main" and .status=="completed")][0]');
  });

  it('identity-drift skips (warning, green) when Aurora is stopped, and still fails on anything else', () => {
    const s = wf('ALERT-APP-USERS-IDENTITY-DRIFT.yml');
    expect(s).toContain("grep -q 'InvalidResourceStateException'");
    expect(s).toContain('echo "skip=true" >> "$GITHUB_OUTPUT"');
    expect(s.match(/if: steps\.aurora\.outputs\.skip != 'true'/g)?.length).toBe(2);
    expect(s).toMatch(/RDS Data API call failed\. Not a drift finding/);
    // the drift threshold itself is untouched
    expect(s).toContain('if [ "$DIFF" -gt "$DRIFT_THRESHOLD" ]; then');
  });
});
