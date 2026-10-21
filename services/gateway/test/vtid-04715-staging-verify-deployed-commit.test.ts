/**
 * VTID-04715 — STAGING-VERIFY verifies the commit a staging deploy actually
 * deployed, not the deploy run's head_sha.
 *
 * With a commit_sha pin (VTID-04709) the deploy run's head_sha is main HEAD
 * while staging serves the pinned, older commit. On 2026-09-28 the automatic
 * verify after such a deploy expected 16ec35e while staging served a4adbbe
 * and recorded a meaningless failure. The deploy now uploads the commit it
 * deployed; STAGING-VERIFY reads it and falls back to head_sha only when an
 * older deploy run has no such artifact.
 */

import * as fs from 'fs';
import * as path from 'path';

const WF = path.resolve(__dirname, '../../../.github/workflows');
const deploy = fs.readFileSync(path.join(WF, 'AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
const verify = fs.readFileSync(path.join(WF, 'STAGING-VERIFY.yml'), 'utf8');

function step(src: string, name: string): string {
  const start = src.indexOf(`- name: ${name}`);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf('\n      - ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe('VTID-04715: the staging deploy records the commit it deployed', () => {
  it('writes the checked-out commit, never GITHUB_SHA, after a successful deploy', () => {
    const s = step(deploy, 'Record deployed commit for STAGING-VERIFY (VTID-04715)');
    expect(s).toContain('if: success()');
    expect(s).toContain('${{ steps.commit.outputs.sha }}');
    expect(s).not.toMatch(/GITHUB_SHA|github\.sha/);
  });

  it('uploads it as the deployed-commit artifact', () => {
    const s = step(deploy, 'Upload deployed commit (VTID-04715)');
    expect(s).toContain('uses: actions/upload-artifact@v4');
    expect(s).toContain('name: deployed-commit');
  });

  it('records it after the smoke check that proves staging serves it', () => {
    expect(deploy.indexOf('Record deployed commit for STAGING-VERIFY')).toBeGreaterThan(
      deploy.indexOf('Smoke — env=staging + deployed commit live'),
    );
  });
});

describe('VTID-04715: STAGING-VERIFY verifies the recorded commit', () => {
  it('downloads the artifact from the triggering deploy run, tolerating its absence', () => {
    const s = step(verify, 'Fetch the commit the deploy recorded (VTID-04715)');
    expect(s).toContain("if: github.event_name == 'workflow_run'");
    expect(s).toContain('continue-on-error: true');
    expect(s).toContain('uses: actions/download-artifact@v4');
    expect(s).toContain('name: deployed-commit');
    expect(s).toContain('run-id: ${{ github.event.workflow_run.id }}');
  });

  it('prefers the recorded commit, falls back to the event commit, and rejects a malformed one', () => {
    const s = step(verify, 'Resolve commit under test (VTID-04715)');
    expect(s).toContain('SHA="$EVENT_SHA"');
    expect(s).toContain('SHA="$DEPLOYED"');
    expect(s).toContain("grep -Eq '^[0-9a-f]{40}$'");
    expect(s).toContain('exit 1');
    expect(s).toContain('echo "SHA=$SHA" >> "$GITHUB_ENV"');
  });

  it('resolves the commit before anything reads it', () => {
    const resolveAt = verify.indexOf('- name: Resolve commit under test');
    for (const later of ['- name: Validate inputs', '- name: Checkout commit under test (gateway)', '- name: Run STAGING-VERIFY']) {
      expect(verify.indexOf(later)).toBeGreaterThan(resolveAt);
    }
  });

  it('never defines SHA at job level, so GITHUB_ENV is the single source', () => {
    const jobEnv = verify.slice(verify.indexOf('    env:\n      SERVICE:'), verify.indexOf('    outputs:'));
    expect(jobEnv).toContain('EVENT_SHA:');
    expect(jobEnv).not.toMatch(/\n\s{6}SHA:/);
  });
});
