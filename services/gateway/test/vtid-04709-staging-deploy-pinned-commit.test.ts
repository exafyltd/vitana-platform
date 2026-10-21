/**
 * VTID-04709 — AWS-STAGE-DEPLOY-GATEWAY.yml can deploy a pinned commit.
 *
 * Production is reached by promoting the image staging runs
 * (AWS-PROD-DEPLOY-GATEWAY.yml, promote-staging). Without a way to put
 * staging on an earlier, already-tested commit, an approval of N commits
 * could only ever ship "whatever main HEAD is now". The staging workflow
 * gains an optional `commit_sha` input; a push deploy is unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKFLOW = path.resolve(
  __dirname,
  '../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml',
);
const src = fs.readFileSync(WORKFLOW, 'utf8');

describe('VTID-04709: staging deploy accepts a pinned commit', () => {
  it('declares an optional commit_sha dispatch input defaulting to empty', () => {
    const block = src.slice(src.indexOf('workflow_dispatch:'), src.indexOf('\npermissions:'));
    expect(block).toMatch(/\n\s{6}commit_sha:\n\s+description: [^\n]+\n\s+required: false\n\s+default: ''/);
  });

  it('checks out the pinned commit, else the triggering commit (push unchanged)', () => {
    expect(src).toContain("ref: ${{ inputs.commit_sha || github.sha }}");
  });

  it('refuses a pin that is not a full SHA already on main', () => {
    const step = src.slice(
      src.indexOf('Pinned commit must already be on main'),
      src.indexOf('Checkout vitana-v1'),
    );
    expect(step).toContain("if: ${{ inputs.commit_sha != '' }}");
    expect(step).toContain('^[0-9a-f]{40}$');
    expect(step).toContain('git merge-base --is-ancestor "$PIN" origin/main');
    expect(step.match(/exit 1/g)?.length).toBe(2);
  });

  it('stamps the commit actually checked out, never GITHUB_SHA', () => {
    const step = src.slice(
      src.indexOf('Resolve commit metadata + refresh BUILD_INFO'),
      src.indexOf('Configure AWS credentials'),
    );
    expect(step).toContain('SHA="$(git rev-parse HEAD)"');
    expect(step).toContain('echo "sha=$SHA"');
    expect(step).not.toMatch(/\$GITHUB_SHA/);
  });

  it('leaves the push trigger in place', () => {
    expect(src).toMatch(/\non:\n\s+push:\n\s+branches: \[main\]/);
  });
});
