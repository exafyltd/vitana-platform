/**
 * VTID-04314: a timed-out `aws ecs wait services-stable` says nothing about
 * why the rollout failed. Seven consecutive staging deploys (2026-09-22 22:21
 * UTC onward) died that way with build and secret output identical to the
 * last green run. The staging deploy workflow must print the rollout state,
 * the service events and the stopped-task reasons when the roll step fails.
 */
import * as fs from 'fs';
import * as path from 'path';

const WF = fs.readFileSync(
  path.resolve(__dirname, '../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'),
  'utf8',
);

describe('VTID-04314 staging rollout diagnostics', () => {
  it('gives the roll step an id the diagnostic step can key off', () => {
    expect(WF).toMatch(/- name: Register task-definition revision \+ roll the service\n\s+id: roll\n/);
  });

  const step = WF.slice(WF.indexOf('- name: Diagnose failed rollout'));

  it('runs only when the roll step failed', () => {
    expect(step).toMatch(/if: failure\(\) && steps\.roll\.outcome == 'failure'/);
  });

  it('prints deployments, service events and stopped-task reasons', () => {
    const body = step.slice(0, step.indexOf('exit 0'));
    expect(body).toContain('rolloutStateReason');
    expect(body).toContain("services[0].events[:15]");
    expect(body).toContain('--desired-status STOPPED');
    expect(body).toContain('stoppedReason');
  });

  it('never fails the job on its own and never mutates ECS', () => {
    const body = step.slice(0, step.indexOf('exit 0') + 'exit 0'.length);
    expect(body).toContain('set +e');
    expect(body).toMatch(/exit 0$/);
    expect(body).not.toMatch(/update-service|register-task-definition|stop-task|run-task/);
  });

  it('sits before the smoke steps', () => {
    expect(WF.indexOf('- name: Diagnose failed rollout')).toBeLessThan(
      WF.indexOf('- name: Smoke — env=staging + deployed commit live'),
    );
  });
});
