// Tests of scripts/eng/delivery-metrics.mjs (plan agentic-delivery §5, §8.3, §10 "Measurement", lane cutover, VTID-05545): the fields of
// vitana.delivery-metrics/v1 from fixture rows, null (never 0) when a source is missing, the §5 targets, and the read-only GitLab reader on a
// recording fake fetch. Dependency-free Node (node:test), so UNIT.yml runs it with no install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from './testing/fake-fetch.mjs';
import * as metrics from './delivery-metrics.mjs';

const T0 = '2026-11-10T08:00:00Z';
const at = (sec, base = T0) => new Date(Date.parse(base) + sec * 1000).toISOString();
const job = (name, stage, status, start, end, created = T0) => ({ name, stage, status, created_at: at(0, created), started_at: at(start, created), finished_at: end === null ? null : at(end, created) });
/** A merge-request pipeline: lane-scope done at 40 s, change-suite 55 s, a check at 200 s, the gate at `gateAt`; first result at 40 s. */
const mrPipeline = (id, gateAt, created = T0) => ({
  id, sha: `sha${id}`, status: 'success', created_at: created,
  jobs: [job('lane-scope', 'governance', 'success', 10, 40, created), job('change-suite', 'governance', 'success', 12, 55, created), job('typecheck', 'checks', 'success', 20, 200, created), job('gate', 'gate', 'success', gateAt - 5, gateAt, created)],
});
const INPUT = () => ({
  schema: 'vitana.delivery-metrics-input/v1', repository: 'vitana-v1', window: { from: T0, to: at(7200) },
  pipelines: [mrPipeline(1, 240), mrPipeline(2, 280), mrPipeline(3, 320), mrPipeline(4, 400), mrPipeline(5, 500)],
  landed: Array.from({ length: 12 }, (_, i) => ({ sha: `l${i}`, at: at(i * 600), accept_to_land_seconds: 120 + i * 30 })),
  verify: [
    { service: 'gateway', sha: 'l0', landed_at: at(0), result_at: at(500), result: 'passed' },
    { service: 'gateway', sha: 'l1', landed_at: at(600), result_at: at(1300), result: 'failed' },
    { service: 'gateway', sha: 'l2', landed_at: at(1200), result_at: at(2000), result: 'passed' },
    { service: 'community-app', sha: 'l3', landed_at: at(1800), result_at: at(2000), result: 'superseded' },
    { service: 'community-app', sha: 'l4', landed_at: at(2400), result_at: at(3000), result: 'passed' },
  ],
  reverts: [{ sha: 'l1' }],
  tasks: [{ seconds: 2400 }, { seconds: 3000 }, { seconds: 9000 }],
  queue: [{ at: at(0), depth: 1 }, { at: at(60), depth: 3 }, { at: at(120), depth: 2 }],
  cost: [{ date: '2026-11-09', usd: 120 }, { date: '2026-11-10', usd: 140 }],
});

test('targets: the typical and slowest 5 % columns of plan §5 and the GitHub baseline of §2.1, in seconds', () => {
  assert.deepEqual(metrics.TARGETS, {
    first_result_seconds: { typical: 60, slowest: 180 }, required_checks_seconds: { typical: 300, slowest: 600 }, accept_to_main_seconds: { typical: 300, slowest: 900 },
    landing_to_verify_seconds: { typical: 600, slowest: 1200 }, one_lane_task_seconds: { typical: 3600, slowest: 10_800 },
  });
  assert.deepEqual(metrics.GITHUB_BASELINE, { first_result_seconds: 666, required_checks_seconds: 3294, landing_to_verify_seconds: 3684 });
  assert.equal(metrics.SCHEMA, 'vitana.delivery-metrics/v1');
  assert.deepEqual(metrics.REQUIRED_JOBS, ['lane-scope', 'change-suite', 'gate']);
});

test('percentile: nearest rank, the median and the 95th percentile of small and large samples, null for no sample', () => {
  assert.equal(metrics.percentile([], 50), null);
  assert.equal(metrics.percentile([7], 50), 7);
  assert.equal(metrics.percentile([7], 95), 7);
  assert.equal(metrics.percentile([1, 2, 3, 4], 50), 2);
  assert.equal(metrics.percentile([4, 1, 3, 2], 95), 4);
  assert.equal(metrics.percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95);
  assert.equal(metrics.percentile(Array.from({ length: 100 }, (_, i) => i + 1), 50), 50);
  assert.equal(metrics.percentile([1, Number.NaN, null, 3], 100), 3, 'only numbers count');
});

test('pipeline timings: first result at the first finished job, required checks at the last of lane-scope, change-suite and gate; a main pipeline is measured on its full-suite jobs; unfinished means null', () => {
  assert.deepEqual(metrics.pipelineTimings(mrPipeline(1, 240)), { first_result_seconds: 40, required_checks_seconds: 240 });
  const main = { id: 9, created_at: T0, jobs: [job('full-suite:unit', 'full-suite', 'success', 5, 70), job('full-suite:sql', 'full-suite', 'success', 5, 130), job('build-image:gateway', 'build', 'success', 5, 900)] };
  assert.deepEqual(metrics.pipelineTimings(main), { first_result_seconds: 70, required_checks_seconds: 130 });
  const running = mrPipeline(2, 240);
  running.jobs.find((j) => j.name === 'gate').status = 'running';
  running.jobs.find((j) => j.name === 'gate').finished_at = null;
  assert.deepEqual(metrics.pipelineTimings(running), { first_result_seconds: 40, required_checks_seconds: null }, 'a pipeline that is still running has no required-checks time yet');
  const skipped = { id: 3, created_at: T0, jobs: [job('docs', 'checks', 'skipped', 0, 1)] };
  assert.deepEqual(metrics.pipelineTimings(skipped), { first_result_seconds: null, required_checks_seconds: null }, 'a skipped job is not a result');
  assert.deepEqual(metrics.pipelineTimings({ id: 4, created_at: T0, jobs: [] }), { first_result_seconds: null, required_checks_seconds: null });
  assert.deepEqual(metrics.pipelineTimings({ id: 5, created_at: T0 }), { first_result_seconds: null, required_checks_seconds: null });
});

test('compute: every field of vitana.delivery-metrics/v1 from fixture rows, with samples, target, met and the GitHub baseline', () => {
  const d = metrics.computeMetrics(INPUT(), { now: '2026-11-10T10:00:00Z' });
  assert.equal(d.schema, 'vitana.delivery-metrics/v1');
  assert.equal(d.generated_at, '2026-11-10T10:00:00Z');
  assert.equal(d.repository, 'vitana-v1');
  const m = d.metrics;
  assert.deepEqual(m.first_result_seconds, { typical: 40, slowest: 40, samples: 5, target: { typical: 60, slowest: 180 }, met: true, github_baseline: 666 });
  assert.deepEqual(m.required_checks_seconds, { typical: 320, slowest: 500, samples: 5, target: { typical: 300, slowest: 600 }, met: false, github_baseline: 3294 });
  assert.deepEqual([m.accept_to_main_seconds.typical, m.accept_to_main_seconds.slowest, m.accept_to_main_seconds.samples, m.accept_to_main_seconds.met], [270, 450, 12, true]);
  assert.deepEqual(m.landings_per_hour, { value: 6, samples: 12, github_baseline: null }, '12 landings in a 2-hour window');
  assert.deepEqual(m.queue_depth, { typical: 2, slowest: 3, samples: 3, github_baseline: null });
  assert.deepEqual([m.landing_to_verify_seconds.typical, m.landing_to_verify_seconds.slowest, m.landing_to_verify_seconds.samples, m.landing_to_verify_seconds.met], [600, 800, 5, true]);
  assert.deepEqual(m.verify_pass_rate, { value: 0.75, samples: 4, github_baseline: null }, 'superseded runs are neither passed nor failed');
  assert.deepEqual(m.change_failure_rate, { value: 0.17, samples: 12, github_baseline: null }, 'one failed verification and one revert over 12 landings');
  assert.deepEqual([m.time_to_restore_seconds.typical, m.time_to_restore_seconds.samples], [700, 1], 'failed at 1300, the next pass of that service at 2000');
  assert.deepEqual([m.one_lane_task_seconds.typical, m.one_lane_task_seconds.slowest, m.one_lane_task_seconds.met], [3000, 9000, true]);
  assert.deepEqual(m.cost_per_day_usd, { value: 130, samples: 2, budget_per_day: 166.67, within_budget: true, github_baseline: null });
  assert.equal(d.targets_met, false, 'one measured target (required checks) is missed');
  const good = INPUT();
  good.pipelines = [mrPipeline(1, 240), mrPipeline(2, 250)];
  assert.equal(metrics.computeMetrics(good).targets_met, true);
});

test('a field without a source is null, never 0: an empty input, a window without landings, no verify results, no cost rows', () => {
  const d = metrics.computeMetrics({ schema: 'vitana.delivery-metrics-input/v1' }, { now: '2026-11-10T10:00:00Z' });
  for (const [k, v] of Object.entries(d.metrics)) assert.equal(v, null, `${k} is null`);
  assert.equal(d.targets_met, null);
  assert.equal(d.repository, null);
  assert.equal(d.window, null);
  const noWindow = INPUT();
  delete noWindow.window;
  assert.equal(metrics.computeMetrics(noWindow).metrics.landings_per_hour, null, 'landings per hour needs the window');
  const onlySuperseded = INPUT();
  onlySuperseded.verify = onlySuperseded.verify.filter((v) => v.result === 'superseded');
  const o = metrics.computeMetrics(onlySuperseded).metrics;
  assert.equal(o.verify_pass_rate, null);
  assert.equal(o.time_to_restore_seconds, null);
  const noLanding = INPUT();
  noLanding.landed = [];
  assert.equal(metrics.computeMetrics(noLanding).metrics.change_failure_rate, null, 'no landings, no rate');
  const unfinished = INPUT();
  unfinished.pipelines = [{ id: 1, created_at: T0, jobs: [{ name: 'gate', stage: 'gate', status: 'running', created_at: T0, started_at: at(5), finished_at: null }] }];
  assert.equal(metrics.computeMetrics(unfinished).metrics.required_checks_seconds, null);
  assert.equal(metrics.computeMetrics(unfinished).metrics.first_result_seconds, null);
});

test('compute: the baseline of the input overrides the plan values field by field; a cost above the budget per day is outside the budget', () => {
  const input = INPUT();
  input.baseline = { first_result_seconds: 700, landings_per_hour: 1.5, cost_per_day_usd: 80 };
  input.cost = [{ date: '2026-11-09', usd: 200 }, { date: '2026-11-10', usd: 200 }];
  const m = metrics.computeMetrics(input).metrics;
  assert.equal(m.first_result_seconds.github_baseline, 700);
  assert.equal(m.required_checks_seconds.github_baseline, 3294, 'the plan value stays where the input says nothing');
  assert.equal(m.landings_per_hour.github_baseline, 1.5);
  assert.deepEqual([m.cost_per_day_usd.value, m.cost_per_day_usd.within_budget, m.cost_per_day_usd.github_baseline], [200, false, 80]);
});

// ── the command line ────────────────────────────────────────────────────────────────────────────────────────────────────────────
function cli(argv, files = {}, extra = {}) {
  const out = [];
  const written = {};
  const deps = { stdout: (t) => out.push(t), readFile: (p) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]; }, writeFile: (p, t) => { written[p] = t; }, ...extra };
  return metrics.main(argv, deps).then((code) => ({ code, out: out.join(''), written }));
}
test('cli: compute reads the input file and prints or writes the document; a wrong schema, a missing file or bad JSON is exit 1 with nothing written; usage mistakes are exit 2', async () => {
  const files = { '/in.json': JSON.stringify(INPUT()), '/other.json': JSON.stringify({ schema: 'x' }), '/bad.json': '{' };
  const printed = await cli(['compute', '--input', '/in.json', '--now', '2026-11-10T10:00:00Z'], files);
  assert.equal(printed.code, 0);
  assert.equal(JSON.parse(printed.out).schema, 'vitana.delivery-metrics/v1');
  const toFile = await cli(['compute', '--input', '/in.json', '--out', '/out.json'], files);
  assert.equal(toFile.code, 0);
  assert.equal(toFile.out, '');
  assert.equal(JSON.parse(toFile.written['/out.json']).metrics.first_result_seconds.samples, 5);
  for (const [argv, re] of [[['compute', '--input', '/other.json'], /not a vitana\.delivery-metrics-input\/v1 document/], [['compute', '--input', '/nope.json'], /ENOENT/], [['compute', '--input', '/bad.json'], /JSON/]]) {
    const r = await cli(argv, files);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.out, re);
    assert.deepEqual(r.written, {});
  }
  for (const argv of [[], ['nonsense'], ['compute'], ['compute', '--input'], ['compute', '--wat', '1'], ['pipelines'], ['pipelines', '--project', 'a/b', '--limit', 'many']]) {
    const r = await cli(argv, files);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.match(r.out, /usage: delivery-metrics\.mjs/);
  }
  assert.equal((await cli(['--help'], files)).code, 0);
});

// ── GitLab, read only ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const TOKEN = ['glp', 'at-metricsAAAAAAAAAAAA'].join('');
function gitlab() {
  const f = fakeFetch();
  f.route('GET', '/api/v4/projects/vitana%2Fvitana-v1/pipelines', (call) => {
    assert.equal(call.query.ref[0], 'main');
    assert.equal(call.query.sort[0], 'desc');
    return { json: [{ id: 22, sha: 'bbb' }, { id: 21, sha: 'aaa' }] };
  });
  for (const [id, sha] of [[22, 'bbb'], [21, 'aaa']]) {
    f.route('GET', `/api/v4/projects/vitana%2Fvitana-v1/pipelines/${id}`, { json: { id, sha, status: 'success', created_at: T0, started_at: at(3), finished_at: at(300) } });
    f.route('GET', `/api/v4/projects/vitana%2Fvitana-v1/pipelines/${id}/jobs`, { json: [{ name: 'full-suite:unit', stage: 'full-suite', status: 'success', created_at: T0, started_at: at(5), finished_at: at(90) }] });
  }
  return f;
}
test('pipelines: reads the latest pipelines of a ref with their jobs using GET only, newest first, and the token appears nowhere in the output', async () => {
  const f = gitlab();
  const r = await cli(['pipelines', '--project', 'vitana/vitana-v1', '--limit', '2', '--url', 'https://gitlab.test', '--token-file', '/tok'], { '/tok': `${TOKEN}\n` }, { fetch: f, sleep: async () => {} });
  assert.equal(r.code, 0, r.out);
  const doc = JSON.parse(r.out);
  assert.equal(doc.schema, 'vitana.delivery-metrics-input/v1');
  assert.equal(doc.repository, 'vitana-v1');
  assert.deepEqual(doc.pipelines.map((p) => [p.id, p.sha, p.jobs.length]), [[22, 'bbb', 1], [21, 'aaa', 1]]);
  assert.deepEqual(f.writes(), [], 'read only');
  assert.equal(r.out.includes(TOKEN), false);
  // the output is exactly what compute accepts
  const m = metrics.computeMetrics(doc);
  assert.deepEqual([m.metrics.first_result_seconds.samples, m.metrics.required_checks_seconds.samples], [2, 2]);
  assert.equal(f.calls.every((c) => c.headers['private-token'] === TOKEN), true);
});
test('pipelines: a GitLab that refuses the token is exit 1 with the status, and the token is not printed', async () => {
  const f = fakeFetch();
  f.route('GET', /.*/, { status: 401, json: { message: `401 Unauthorized ${TOKEN}` } });
  const r = await cli(['pipelines', '--project', 'vitana/vitana-v1', '--url', 'https://gitlab.test', '--token-file', '/tok'], { '/tok': `${TOKEN}\n` }, { fetch: f, sleep: async () => {} });
  assert.equal(r.code, 1);
  assert.match(r.out, /401/);
  assert.equal(r.out.includes(TOKEN), false);
});
