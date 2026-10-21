/**
 * VTID-04643 — the Run Tests launch list.
 *
 * Pins the owner rule (2026-09-26): deploys are never launchable, production
 * gets only read-only health checks, and staging E2E is always read-only and
 * always the staging host. Also pins that every listed workflow exists in this
 * repository (or is a vitana-v1 workflow), so a rename cannot leave a dead
 * button behind.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  LAUNCH_POLICY, listLaunchable, validateLaunch, dispatchInputs, notLaunchableReason,
} from '../../../src/services/testing/test-launcher';

const WORKFLOWS = join(__dirname, '../../../../../.github/workflows');
const E2E = ['desktop-community', 'hub-shared'];
const STAGING = 'https://preview-aws.vitanaland.com';

describe('the launch list', () => {
  it('never lists a deploy, a job or a PR gate', () => {
    for (const p of LAUNCH_POLICY) expect(p.file).not.toMatch(/DEPLOY|PUBLISH|MIGRATION|RUN-MIGRATION/i);
  });

  it('lists only read-only health checks for production', () => {
    const prod = LAUNCH_POLICY.filter((p) => p.environment === 'production');
    expect(prod.length).toBeGreaterThan(0);
    for (const p of prod) {
      expect(p.file).toMatch(/^(ALERT-|SMOKE-)/);
      expect(p.effect).toMatch(/Read-only\./);
    }
  });

  it('every platform workflow on the list exists, is manually dispatchable, and never writes through a non-RPC POST', () => {
    for (const p of LAUNCH_POLICY.filter((x) => x.repo === 'exafyltd/vitana-platform')) {
      const file = join(WORKFLOWS, p.file);
      expect(existsSync(file)).toBe(true);
      const text = readFileSync(file, 'utf8');
      expect(text).toMatch(/workflow_dispatch/);
      if (p.environment === 'production') {
        const posts = text.split('\n').filter((l) => /-X (POST|PATCH|PUT|DELETE)/.test(l) && !l.trim().startsWith('#'));
        for (const l of posts) expect(l).toMatch(/\/rest\/v1\/rpc\/ci_/);
      }
    }
  });

  it('explains why other manually triggerable workflows are not launchable', () => {
    const out = listLaunchable({
      workflows: [
        { repo: 'exafyltd/vitana-platform', file: 'TEST-SUITE.yml', kind: 'test', environments: ['dev_pr'], flags: [], manual_trigger: true },
        { repo: 'exafyltd/vitana-platform', file: 'AWS-PROD-DEPLOY-GATEWAY.yml', kind: 'deploy_smoke', environments: ['production'], flags: [], manual_trigger: true },
        { repo: 'exafyltd/vitana-platform', file: 'MORNING-SYSTEM-HEALTH-CHECK.yml', kind: 'monitor', environments: ['production'], flags: ['ui_test_touches_production'], manual_trigger: true },
        { repo: 'exafyltd/vitana-platform', file: 'DAILY-STATUS-UPDATE.yml', kind: 'monitor', environments: ['production'], flags: [], manual_trigger: true },
        { repo: 'exafyltd/vitana-platform', file: 'SCHEDULED-ONLY.yml', kind: 'monitor', environments: [], flags: [], manual_trigger: false },
      ],
    } as any);
    expect(out.launchable.find((l) => l.file === 'TEST-SUITE.yml')).toMatchObject({ in_catalog: true, kind: 'test' });
    expect(out.launchable.find((l) => l.file === 'ALERT-PUSH-DISPATCH-HEALTH.yml')).toMatchObject({ in_catalog: false });
    const reasons = Object.fromEntries(out.not_launchable.map((n) => [n.file, n.reason]));
    expect(reasons['AWS-PROD-DEPLOY-GATEWAY.yml']).toMatch(/PUBLISH/);
    expect(reasons['MORNING-SYSTEM-HEALTH-CHECK.yml']).toMatch(/touches production/);
    expect(reasons['DAILY-STATUS-UPDATE.yml']).toMatch(/Not reviewed as read-only/);
    expect(reasons['SCHEDULED-ONLY.yml']).toBeUndefined();
    expect(notLaunchableReason({ kind: 'e2e', flags: ['dead_host'], file: 'X.yml' })).toMatch(/no longer exists/);
  });
});

describe('validateLaunch', () => {
  const ok = { repo: 'exafyltd/vitana-platform', workflow: 'TEST-SUITE.yml', reason: 'check main after merge' };

  it('refuses anything not on the list, including deploys', () => {
    expect(validateLaunch({ ...ok, workflow: 'AWS-PROD-DEPLOY-GATEWAY.yml' }, E2E)).toMatchObject({ ok: false, status: 403 });
    expect(validateLaunch({ ...ok, repo: 'someone/else' }, E2E)).toMatchObject({ ok: false, status: 403 });
    expect(validateLaunch({}, E2E)).toMatchObject({ ok: false, status: 403 });
  });

  it('requires a reason', () => {
    expect(validateLaunch({ ...ok, reason: '' }, E2E)).toMatchObject({ ok: false, status: 400 });
    expect(validateLaunch({ ...ok, reason: 'x'.repeat(501) }, E2E)).toMatchObject({ ok: false, status: 400 });
    expect(validateLaunch(ok, E2E)).toMatchObject({ ok: true, reason: 'check main after merge' });
  });

  it('requires known Playwright projects for staging E2E', () => {
    const e2e = { ...ok, workflow: 'E2E-TEST-RUN.yml' };
    expect(validateLaunch(e2e, E2E)).toMatchObject({ ok: false, status: 400 });
    expect(validateLaunch({ ...e2e, projects: ['nope'] }, E2E)).toMatchObject({ ok: false, error: expect.stringMatching(/nope/) });
    expect(validateLaunch({ ...e2e, projects: ['hub-shared', 'hub-shared'] }, E2E)).toMatchObject({ ok: true, projects: ['hub-shared'] });
  });
});

describe('dispatchInputs', () => {
  const policy = (file: string) => LAUNCH_POLICY.find((p) => p.file === file)!;

  it('always runs staging E2E read-only against the staging app', () => {
    expect(dispatchInputs(policy('E2E-TEST-RUN.yml'), ['hub-shared', 'desktop-community'], null, STAGING)).toEqual({
      projects: 'hub-shared,desktop-community', community_url: STAGING, read_only: 'true',
    });
  });

  it('pins STAGING-VERIFY to the commit staging serves, and refuses without one', () => {
    const sha = 'a'.repeat(40);
    expect(dispatchInputs(policy('STAGING-VERIFY.yml'), [], sha, STAGING)).toEqual({ service: 'gateway', commit_sha: sha });
    expect(() => dispatchInputs(policy('STAGING-VERIFY.yml'), [], null, STAGING)).toThrow(/commit staging serves/);
  });

  it('sends no inputs to workflows that take none', () => {
    expect(dispatchInputs(policy('TEST-SUITE.yml'), [], null, STAGING)).toEqual({});
  });
});
