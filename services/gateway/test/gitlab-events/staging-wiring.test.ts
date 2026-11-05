// VTID-05541 (plan eng-gitlab-m2 §3.5): GITLAB_WEBHOOK_SIGNING_TOKEN is wired on staging only when its secret
// exists, so the deploy can never fail or point a task at a missing secret; production is not wired in this milestone
// (AWS-PROD-* are protected gate files and no real project has a hook yet).
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../..');
const wf = (n: string) => readFileSync(join(root, '.github/workflows', n), 'utf8');

function stepRun(workflow: string, stepName: string): string {
  const at = workflow.indexOf(`- name: ${stepName}`);
  expect(at).toBeGreaterThan(0);
  const next = workflow.indexOf('\n      - name: ', at + 1);
  return workflow.slice(at, next === -1 ? undefined : next);
}

describe('VTID-05541 GITLAB_WEBHOOK_SIGNING_TOKEN wiring', () => {
  test('staging resolves the secret by name and wires it only when it exists', () => {
    const step = stepRun(wf('AWS-STAGE-DEPLOY-GATEWAY.yml'), 'Resolve GitLab webhook signing key');
    expect(step).toContain('NAME="vitana/gateway/staging/gitlab-webhook-signing-token"');
    expect(step).toContain('2>"$ERR" || true)');
    expect(step).toContain('{name:"GITLAB_WEBHOOK_SIGNING_TOKEN", valueFrom:$a}');
    expect(step).toContain('if [ -z "$ARN" ] || [ "$ARN" = "None" ]; then');
    expect(step).not.toMatch(/exit 1/);
    expect(step).not.toMatch(/secrets\./);
  });

  test('staging resolves it before the task definition is built (it rides connected-apps.json)', () => {
    const s = wf('AWS-STAGE-DEPLOY-GATEWAY.yml');
    expect(s.indexOf('- name: Resolve GitLab webhook signing key')).toBeGreaterThan(0);
    expect(s.indexOf('- name: Resolve GitLab webhook signing key')).toBeLessThan(s.indexOf('--slurpfile CA "$RUNNER_TEMP/connected-apps.json"'));
  });

  test('production is not wired in this milestone', () => {
    expect(wf('AWS-PROD-DEPLOY-GATEWAY.yml')).not.toContain('GITLAB_WEBHOOK_SIGNING_TOKEN');
    expect(wf('AWS-PROD-DEPLOY-GATEWAY.yml')).not.toContain('gitlab-webhook-signing-token');
  });

  test('the owner script copies the value without printing it and checks the accounts first', () => {
    const sh = readFileSync(join(root, 'scripts/aws/setup-gitlab-webhook-secret.sh'), 'utf8');
    expect(sh).toContain('vitana/engineering/gitlab/webhook-signing-token');
    expect(sh).toContain('vitana/gateway/staging/gitlab-webhook-signing-token');
    expect(sh).toContain('472838866351');
    expect(sh).toContain('841276716213');
    expect(sh).not.toMatch(/set -x/);
    expect(sh).not.toMatch(/echo[^\n]*\$VALUE/);
    expect(sh).toMatch(/APPLY=0/);
  });
});
