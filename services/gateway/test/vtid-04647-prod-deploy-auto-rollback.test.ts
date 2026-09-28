/**
 * VTID-04647 — the gateway production deploy verifies itself read-only after
 * rolling the service and puts the previous task definition back on failure.
 *
 * Pinned against the workflow file: the order of the steps, that the
 * post-deploy check only reads, that the rollback targets the task definition
 * captured before the deploy, and that a rollback is recorded as its own
 * OASIS topic.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const WF_PATH = path.resolve(__dirname, '../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml');
const raw = fs.readFileSync(WF_PATH, 'utf8');
const wf = yaml.load(raw) as any;
const steps: any[] = wf.jobs['build-push-deploy'].steps;

function idx(id: string): number {
  const i = steps.findIndex((s) => s.id === id);
  expect(i).toBeGreaterThan(-1);
  return i;
}

describe('VTID-04647 prod deploy: post-deploy verification + automatic rollback', () => {
  it('captures the rollback target before the service is rolled', () => {
    const prev = steps[idx('prev')];
    expect(prev.run).toMatch(/describe-services[\s\S]*services\[0\]\.taskDefinition/);
    expect(prev.run).toMatch(/echo "arn=\$PREV_ARN" >> "\$GITHUB_OUTPUT"/);
    expect(prev.run).toMatch(/GIT_COMMIT_SHA/);
    // Refuses to deploy without a rollback target.
    expect(prev.run).toMatch(/refusing to deploy without a rollback target/);
    expect(idx('prev')).toBeLessThan(idx('roll'));
    expect(steps[idx('roll')].run).toMatch(/aws ecs update-service/);
  });

  it('checks after the smoke gate, with GET requests only', () => {
    expect(idx('smoke')).toBeGreaterThan(idx('roll'));
    expect(idx('postverify')).toBeGreaterThan(idx('smoke'));
    const run: string = steps[idx('postverify')].run;
    expect(run).toMatch(/curl -sS -o \/dev\/null/);
    // Read-only: no method override, no body, no auth header.
    expect(run).not.toMatch(/-X\s|--request|-d\s|--data|Authorization|apikey/i);
    expect(run).toMatch(/application\/json/);
    // Only routes that predate this change, so an env-only redeploy of an
    // older image cannot trip it.
    for (const p of ['/api/v1/admin/health', '/api/v1/admin/build-info', '/api/v1/orb/health']) {
      expect(run).toContain(p);
    }
  });

  it('rolls back to the captured task definition when a later step fails', () => {
    const rb = steps[idx('rollback')];
    expect(idx('rollback')).toBeGreaterThan(idx('postverify'));
    expect(rb.if).toContain('failure()');
    expect(rb.if).toContain("steps.prev.outputs.arn != ''");
    expect(rb.if).toContain("steps.roll.outcome != 'skipped'");
    expect(rb.if).toContain("vars.PROD_AUTO_ROLLBACK_DISABLED != 'true'");
    expect(rb.env.PREV_ARN).toBe('${{ steps.prev.outputs.arn }}');
    expect(rb.run).toMatch(/update-service[\s\S]*--task-definition "\$PREV_ARN"/);
    expect(rb.run).toMatch(/wait services-stable/);
    expect(rb.run).toMatch(/build-info/);
    expect(rb.run).toMatch(/rolled_back=true/);
    // The rollback never re-runs a build or registers a new revision.
    expect(rb.run).not.toMatch(/register-task-definition|docker/);
  });

  it('records a rollback as prod.deploy.rolled_back', () => {
    const emit = steps.find((s) => /Emit OASIS event/.test(s.name || ''));
    expect(emit.if).toBe('always()');
    expect(emit.env.ROLLED_BACK).toBe('${{ steps.rollback.outputs.rolled_back }}');
    expect(emit.run).toMatch(/if \[ "\$ROLLED_BACK" = "true" \]; then TOPIC=prod\.deploy\.rolled_back; fi/);
    expect(emit.run).toMatch(/rolled_back_to: \$prev/);
  });

  it('stays dispatch-only', () => {
    expect(Object.keys(wf.on || wf[true as any])).toEqual(['workflow_dispatch']);
    expect(raw).not.toMatch(/^\s+push:/m);
  });
});
