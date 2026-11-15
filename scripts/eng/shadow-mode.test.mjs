// Shadow mode is side-effect free (owner rule 2026-11-15): the rendered delivery pipelines, evaluated for a shadow
// context, create no job that writes outside GitLab (ECR, ECS, S3/CloudFront, OASIS, VTID close, notifications, the
// preview), still create every check and build, and keep every `needs` edge satisfiable. Live pipelines keep the
// external jobs. Unset, empty or unknown modes are treated as shadow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServices, buildPipeline, evaluatePipeline, parseYaml } from './pipeline-gen.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CI_DIR = path.join(ROOT, 'infra', 'gitlab-engineering', 'ci');
const config = loadServices(ROOT);
const templates = readdirSync(CI_DIR).filter((f) => /^tpl-.*\.yml$/.test(f)).sort().map((f) => parseYaml(readFileSync(path.join(CI_DIR, f), 'utf8')));

// Jobs that write outside GitLab or change a live/previewed system. Each must be absent in shadow.
const EXTERNAL = /^(push-image:|deploy-staging:|rollback-staging:|staging-verify|record|vtid-close|notify-platform|assist:|preview-upload|preview-stop|e2e-preview-orb)/;

const MAIN_PUSH = { CI_COMMIT_BRANCH: 'main', CI_DEFAULT_BRANCH: 'main', CI_PIPELINE_SOURCE: 'push' };
const NIGHTLY = { CI_COMMIT_BRANCH: 'main', CI_DEFAULT_BRANCH: 'main', CI_PIPELINE_SOURCE: 'schedule', DELIVERY_SCHEDULE: 'nightly' };
const MR = { CI_COMMIT_BRANCH: 'feature/x', CI_DEFAULT_BRANCH: 'main', CI_PIPELINE_SOURCE: 'merge_request_event' };

function run(repoKey, ctx) {
  const generated = parseYaml(readFileSync(path.join(ROOT, config.repositories[repoKey].output), 'utf8'));
  // The rendered file must be the one the generator produces (drift is caught by --check; this guards the tests' input).
  assert.ok(generated && typeof generated === 'object', `${repoKey} renders`);
  const doc = buildPipeline(config, repoKey);
  return evaluatePipeline([...templates, doc], { variables: ctx.vars, changes: ctx.changes ?? null });
}

const MODE_CASES = {
  shadow: { DELIVERY_MODE: 'shadow' },
  unset: {},
  empty: { DELIVERY_MODE: '' },
  unknown: { DELIVERY_MODE: 'liev' },
};

for (const repoKey of Object.keys(config.repositories)) {
  for (const [label, ctxBase] of [['main push', MAIN_PUSH], ['nightly', NIGHTLY], ['merge request', MR]]) {
    for (const [mode, modeVars] of Object.entries(MODE_CASES)) {
      test(`${repoKey} ${label}, ${mode} mode: no external write job is created`, () => {
        const jobs = run(repoKey, { vars: { ...ctxBase, ...modeVars } });
        const leaked = Object.keys(jobs).filter((n) => EXTERNAL.test(n));
        assert.deepEqual(leaked, [], `external jobs created in ${mode} mode`);
      });

      test(`${repoKey} ${label}, ${mode} mode: every needs edge points at a created job`, () => {
        const jobs = run(repoKey, { vars: { ...ctxBase, ...modeVars } });
        for (const [name, job] of Object.entries(jobs)) {
          for (const n of job.needs || []) {
            if (n.optional) continue;
            const target = typeof n === 'string' ? n : n.job;
            assert.ok(target in jobs, `${name} needs ${target}, which is not created in ${mode} mode`);
          }
        }
      });
    }
  }

  test(`${repoKey} main push, shadow mode: checks and builds still run`, () => {
    const jobs = run(repoKey, { vars: { ...MAIN_PUSH, ...MODE_CASES.shadow } });
    const builds = Object.keys(jobs).filter((n) => n.startsWith('build-image:'));
    assert.ok(builds.length > 0, 'build-image jobs are created in shadow');
    assert.ok(Object.keys(jobs).some((n) => n.startsWith('full-suite:')), 'the full suite runs on main in shadow');
  });

  test(`${repoKey} merge request, shadow mode: the merge-request gate chain still runs`, () => {
    const jobs = run(repoKey, { vars: { ...MR, ...MODE_CASES.shadow }, changes: ['services/gateway/src/x.ts'] });
    for (const n of ['gate']) assert.ok(n in jobs, `${n} is created on a merge request in shadow`);
    assert.ok(Object.keys(jobs).some((n) => n.startsWith('change-suite') || n.startsWith('lane-scope')), 'governance jobs run');
  });

  test(`${repoKey} main push, live mode: external jobs are still created (live behaviour unchanged)`, () => {
    const jobs = run(repoKey, { vars: { ...MAIN_PUSH, DELIVERY_MODE: 'live' } });
    const names = Object.keys(jobs);
    assert.ok(names.some((n) => n.startsWith('push-image:')), 'push-image runs in live');
    assert.ok(names.some((n) => n.startsWith('deploy-staging:')), 'deploy-staging runs in live');
    assert.ok(names.some((n) => n.startsWith('rollback-staging:')), 'rollback-staging is armed in live');
  });
}

test('the live-mode external job set is pinned (a change to live behaviour must update this list on purpose)', () => {
  const jobs = run('vitana-platform', { vars: { ...MAIN_PUSH, DELIVERY_MODE: 'live' } });
  const live = Object.keys(jobs).filter((n) => /^(push-image:|deploy-staging:|rollback-staging:)/.test(n)).sort();
  const services = ['erp-bridge', 'gateway', 'kiro-runner', 'postgrest-aurora-proxy'];
  const expected = [
    ...services.map((s) => `deploy-staging:${s}`),
    ...services.map((s) => `push-image:${s}`),
    ...services.map((s) => `rollback-staging:${s}`),
  ].sort();
  assert.deepEqual(live, expected);
});

// report.sh sends notifications and events. Inside GitLab CI, anything but DELIVERY_MODE=live sends nothing.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync as rf } from 'node:fs';
import { tmpdir } from 'node:os';
function reportWith(env) {
  const dir = mkdtempSync(path.join(tmpdir(), 'report-shadow-'));
  const log = path.join(dir, 'curl.log');
  writeFileSync(path.join(dir, 'curl'), `#!/bin/sh\necho called >> "${log}"\nexit 0\n`);
  chmodSync(path.join(dir, 'curl'), 0o755);
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'report.sh'), 'ci-event', 'svc'], {
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, ...env }, encoding: 'utf8',
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, curled: existsSync(log) ? rf(log, 'utf8') : '' };
}
test('report.sh sends nothing inside GitLab CI unless DELIVERY_MODE is exactly live', () => {
  for (const mode of ['shadow', '', 'liev']) {
    const env = { GITLAB_CI: 'true' };
    if (mode !== '') env.DELIVERY_MODE = mode;
    const r = reportWith(env);
    assert.equal(r.status, 0, `exit status in mode '${mode}'`);
    assert.equal(r.curled, '', `no curl in mode '${mode}'`);
    assert.match(r.out, /not sent/);
  }
});
test('report.sh still posts in GitLab live mode and outside GitLab CI', () => {
  assert.match(reportWith({ GITLAB_CI: 'true', DELIVERY_MODE: 'live' }).curled, /called/);
  assert.match(reportWith({ DELIVERY_MODE: 'shadow' }).curled, /called/, 'outside GitLab CI behaviour is unchanged');
});
