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

describe('VTID-04573: production GitHub token secret', () => {
  const prod = fs.readFileSync(path.join(__dirname, '../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
  it('pins the full ARN of vitana/github/pat (the prod deploy role cannot describe secrets)', () => {
    expect(prod).toContain('GITHUB_TOKEN_SECRET_ARN: arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/github/pat-g82ixI');
  });
  it('replaces only the GITHUB_SAFE_MERGE_TOKEN secret, keeping every other secret', () => {
    expect(prod).toMatch(/\.containerDefinitions\[0\]\.secrets \|=\s*\( \[ \(\. \/\/ \[\]\)\[\] \| select\(\.name != "GITHUB_SAFE_MERGE_TOKEN"\) \]\s*\+ \[ \{name:"GITHUB_SAFE_MERGE_TOKEN", valueFrom:\$GH\} \] \)/);
  });
  it('runs unconditionally just before register, so an env-only dispatch applies it', () => {
    const step2 = prod.slice(prod.indexOf('Build task-definition (2/2'), prod.indexOf('NEW_ARN=$(aws ecs register-task-definition'));
    expect(step2).toContain('GITHUB_TOKEN_SECRET_ARN: arn:');
    expect(step2).toContain('valueFrom:$GH');
    // not inside any optional-input block: it sits before the env_overrides if, at the top level of the step
    expect(step2.indexOf('valueFrom:$GH')).toBeLessThan(step2.indexOf('if [ -n "$ENV_OVERRIDES_INPUT" ]'));
  });
});

