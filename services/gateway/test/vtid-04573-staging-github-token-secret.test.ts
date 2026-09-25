/**
 * VTID-04573 — the staging gateway reads its GitHub token from
 * vitana/github/pat, not vitana/github/token.
 *
 * vitana/github/token (last set 2026-08-26 09:54 UTC) started returning 401
 * from GitHub on 2026-09-25, so every GitHub call from staging failed —
 * including opening the PR when a held Dev Autopilot execution is approved.
 * vitana/github/pat is the secret the autopilot executor already pushes with,
 * under the same ECS execution role.
 */
import * as fs from 'fs';
import * as path from 'path';

const wf = fs.readFileSync(path.join(__dirname, '../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');

describe('VTID-04573: staging GitHub token secret', () => {
  it('resolves SEC_GITHUB_TOKEN from vitana/github/pat', () => {
    expect(wf).toContain('"SEC_GITHUB_TOKEN:vitana/github/pat"');
    expect(wf).not.toContain('"SEC_GITHUB_TOKEN:vitana/github/token"');
  });
  it('still wires it as GITHUB_SAFE_MERGE_TOKEN, a secret reference, never a plain value', () => {
    expect(wf).toMatch(/\{name:"GITHUB_SAFE_MERGE_TOKEN", valueFrom:\$SEC_GITHUB_TOKEN\}/);
  });
});
