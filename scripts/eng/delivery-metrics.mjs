#!/usr/bin/env node
// Delivery metrics of the cutover (plan agentic-delivery §5 targets, §8.3 exit criteria, §10 "Measurement", lane cutover, VTID-05545).
//
//   node scripts/eng/delivery-metrics.mjs compute --input FILE [--out FILE] [--now ISO]
//        FILE is a vitana.delivery-metrics-input/v1 document (below); the result is a vitana.delivery-metrics/v1 document.
//   node scripts/eng/delivery-metrics.mjs pipelines --project vitana/vitana-v1 [--ref main] [--limit 30] [--url URL] [--token-file FILE]
//        reads pipelines and their jobs from GitLab (read only) and prints the `pipelines` part of an input document.
//
// Input document: { schema, repository, window: { from, to }, pipelines: [{ id, sha, status, created_at, finished_at, jobs: [{ name, stage,
// status, created_at, started_at, finished_at }] }], landed: [{ sha, at, accept_to_land_seconds }], verify: [{ service, sha, landed_at,
// result_at, result: passed | failed | superseded }], reverts: [{ sha }], tasks: [{ seconds }], queue: [{ at, depth }], cost: [{ date, usd }],
// baseline: { <metric>: number } }. A field whose source is missing is null, never 0 (plan §10). The typical value is the median and
// the slowest 5 % the 95th percentile (nearest rank), the two columns of the §5 table.
//
// Read-only: the compute command reads one file, the pipelines command makes GET requests only. No secret is printed. Dependency-free
// Node 20; GitLab is reached through scripts/eng/gitlab-api.mjs and an injected fetch, so the tests use fakes.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createClient, projectId, redact } from './gitlab-api.mjs';

export const SCHEMA = 'vitana.delivery-metrics/v1';
export const INPUT_SCHEMA = 'vitana.delivery-metrics-input/v1';
/** Plan §5, seconds: typical / slowest 5 % (both repositories). */
export const TARGETS = Object.freeze({
  first_result_seconds: Object.freeze({ typical: 60, slowest: 180 }),
  required_checks_seconds: Object.freeze({ typical: 300, slowest: 600 }),
  accept_to_main_seconds: Object.freeze({ typical: 300, slowest: 900 }),
  landing_to_verify_seconds: Object.freeze({ typical: 600, slowest: 1200 }),
  one_lane_task_seconds: Object.freeze({ typical: 3600, slowest: 10_800 }),
});
export const BUDGET_USD_PER_MONTH = 5000;
/** The GitHub baseline of plan §2.1 (2026-11-04), seconds; the rest has no baseline in the plan. */
export const GITHUB_BASELINE = Object.freeze({ first_result_seconds: 666, required_checks_seconds: 3294, landing_to_verify_seconds: 3684 });
export const REQUIRED_JOBS = Object.freeze(['lane-scope', 'change-suite', 'gate']);
const FINISHED = new Set(['success', 'failed', 'canceled', 'skipped']);

const ms = (iso) => (typeof iso === 'string' ? Date.parse(iso) : Number.NaN);
const seconds = (from, to) => {
  const d = (ms(to) - ms(from)) / 1000;
  return Number.isFinite(d) && d >= 0 ? d : null;
};
const round = (n) => Math.round(n * 100) / 100;

/** Nearest-rank percentile of a list of numbers (null for an empty list). */
export function percentile(values, p) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
}

/**
 * Timings of one pipeline in seconds. first_result: from the pipeline's creation to the first job with a result. required_checks:
 * from creation to the last finish of the required jobs (lane-scope, change-suite, gate) when the pipeline has them, else of the jobs of
 * the full-suite stage (a main pipeline); null while one of them has not finished.
 */
export function pipelineTimings(pl) {
  const jobs = Array.isArray(pl?.jobs) ? pl.jobs : [];
  const done = jobs.filter((j) => FINISHED.has(j.status) && j.status !== 'skipped' && j.finished_at);
  const first = done.length ? Math.min(...done.map((j) => ms(j.finished_at))) : Number.NaN;
  const named = jobs.filter((j) => REQUIRED_JOBS.includes(j.name));
  const required = named.length ? named : jobs.filter((j) => j.stage === 'full-suite');
  const real = required.filter((j) => j.status !== 'skipped');
  let requiredSeconds = null;
  if (real.length > 0 && real.every((j) => FINISHED.has(j.status) && j.finished_at)) requiredSeconds = seconds(pl.created_at, new Date(Math.max(...real.map((j) => ms(j.finished_at)))).toISOString());
  return { first_result_seconds: Number.isFinite(first) ? seconds(pl.created_at, new Date(first).toISOString()) : null, required_checks_seconds: requiredSeconds };
}

const spread = (values, target, baseline) => {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (v.length === 0) return null;
  const typical = round(percentile(v, 50));
  const slowest = round(percentile(v, 95));
  return { typical, slowest, samples: v.length, target: target ?? null, met: target ? typical <= target.typical && slowest <= target.slowest : null, github_baseline: baseline ?? null };
};

/** The vitana.delivery-metrics/v1 document of an input document (pure). */
export function computeMetrics(input, { now = new Date().toISOString() } = {}) {
  const baseline = { ...GITHUB_BASELINE, ...(input.baseline ?? {}) };
  const pipelines = Array.isArray(input.pipelines) ? input.pipelines : [];
  const timings = pipelines.map(pipelineTimings);
  const landed = Array.isArray(input.landed) ? input.landed : [];
  const verify = Array.isArray(input.verify) ? input.verify : [];
  const results = verify.filter((v) => v.result === 'passed' || v.result === 'failed');
  const failed = results.filter((v) => v.result === 'failed').length;
  const reverts = Array.isArray(input.reverts) ? input.reverts : [];

  const hours = input.window && ms(input.window.to) > ms(input.window.from) ? (ms(input.window.to) - ms(input.window.from)) / 3_600_000 : null;
  const restores = [];
  const byService = new Map();
  for (const v of [...results].sort((a, b) => ms(a.result_at) - ms(b.result_at))) {
    const open = byService.get(v.service ?? '');
    if (v.result === 'failed' && open === undefined) byService.set(v.service ?? '', v.result_at);
    if (v.result === 'passed' && open !== undefined) { restores.push(seconds(open, v.result_at)); byService.delete(v.service ?? ''); }
  }
  const costs = (Array.isArray(input.cost) ? input.cost : []).filter((c) => typeof c.usd === 'number');
  const perDay = BUDGET_USD_PER_MONTH / 30;
  const avgCost = costs.length ? costs.reduce((a, c) => a + c.usd, 0) / costs.length : null;

  const metrics = {
    first_result_seconds: spread(timings.map((t) => t.first_result_seconds), TARGETS.first_result_seconds, baseline.first_result_seconds),
    required_checks_seconds: spread(timings.map((t) => t.required_checks_seconds), TARGETS.required_checks_seconds, baseline.required_checks_seconds),
    accept_to_main_seconds: spread(landed.map((l) => l.accept_to_land_seconds), TARGETS.accept_to_main_seconds, baseline.accept_to_main_seconds),
    landings_per_hour: landed.length && hours ? { value: round(landed.length / hours), samples: landed.length, github_baseline: baseline.landings_per_hour ?? null } : null,
    queue_depth: (() => { const s = spread((Array.isArray(input.queue) ? input.queue : []).map((q) => q.depth), null, baseline.queue_depth); return s ? { typical: s.typical, slowest: s.slowest, samples: s.samples, github_baseline: s.github_baseline } : null; })(),
    landing_to_verify_seconds: spread(verify.map((v) => seconds(v.landed_at, v.result_at)), TARGETS.landing_to_verify_seconds, baseline.landing_to_verify_seconds),
    verify_pass_rate: results.length ? { value: round((results.length - failed) / results.length), samples: results.length, github_baseline: baseline.verify_pass_rate ?? null } : null,
    change_failure_rate: landed.length ? { value: round((failed + reverts.length) / landed.length), samples: landed.length, github_baseline: baseline.change_failure_rate ?? null } : null,
    time_to_restore_seconds: spread(restores, null, baseline.time_to_restore_seconds),
    one_lane_task_seconds: spread((Array.isArray(input.tasks) ? input.tasks : []).map((t) => t.seconds), TARGETS.one_lane_task_seconds, baseline.one_lane_task_seconds),
    cost_per_day_usd: avgCost === null ? null : { value: round(avgCost), samples: costs.length, budget_per_day: round(perDay), within_budget: avgCost <= perDay, github_baseline: baseline.cost_per_day_usd ?? null },
  };
  const checked = Object.values(metrics).filter((m) => m && m.met !== undefined && m.met !== null);
  return { schema: SCHEMA, generated_at: now, repository: input.repository ?? null, window: input.window ?? null, metrics, targets_met: checked.length ? checked.every((m) => m.met === true) : null };
}

// ── reading GitLab (read only) ──────────────────────────────────────────────────────────────────────────────────────────────────
/** The latest pipelines of a ref with their jobs: the `pipelines` part of an input document. */
export async function fetchPipelines({ client, project, ref = 'main', limit = 30 }) {
  const pid = projectId(project);
  const list = await client.get(`/projects/${pid}/pipelines`, { query: { ref, order_by: 'id', sort: 'desc', per_page: Math.min(100, limit) } });
  const out = [];
  for (const row of (Array.isArray(list) ? list : []).slice(0, limit)) {
    const detail = await client.get(`/projects/${pid}/pipelines/${row.id}`);
    const jobs = await client.paginate(`/projects/${pid}/pipelines/${row.id}/jobs`, { query: { per_page: 100 } });
    out.push({
      id: detail.id, sha: detail.sha, ref, status: detail.status, created_at: detail.created_at, started_at: detail.started_at ?? null, finished_at: detail.finished_at ?? null,
      jobs: jobs.map((j) => ({ name: j.name, stage: j.stage, status: j.status, created_at: j.created_at ?? null, started_at: j.started_at ?? null, finished_at: j.finished_at ?? null })),
    });
  }
  return out;
}

const USAGE = `usage: delivery-metrics.mjs compute --input FILE [--out FILE] [--now ISO]
       delivery-metrics.mjs pipelines --project vitana/vitana-v1 [--ref main] [--limit 30] [--url URL] [--token-file FILE]
  exit: 0 done, 1 error, 2 usage mistake. Read only; a field without a source is null.`;
class UsageError extends Error {}

export function parseArgs(argv) {
  const o = { command: null };
  const flags = { '--input': 'input', '--out': 'out', '--now': 'now', '--project': 'project', '--ref': 'ref', '--limit': 'limit', '--url': 'url', '--token-file': 'tokenFile' };
  const args = [...argv];
  while (args.length) {
    const a = args.shift();
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    if (a === 'compute' || a === 'pipelines') { if (o.command) throw new UsageError('give one command'); o.command = a; continue; }
    if (Object.hasOwn(flags, a)) {
      const v = args.shift();
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      o[flags[a]] = v;
      continue;
    }
    throw new UsageError(a.startsWith('-') ? `unknown option ${a.slice(0, 40)}` : `unknown command ${a.slice(0, 40)}`);
  }
  if (o.limit !== undefined && !/^\d{1,3}$/.test(o.limit)) throw new UsageError('--limit must be a number from 1 to 999');
  return o;
}

export async function main(argv, deps = {}) {
  const out = deps.stdout ?? ((t) => process.stdout.write(t));
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, 'utf8'));
  const writeFile = deps.writeFile ?? ((p, t) => fs.writeFileSync(p, t));
  let o;
  try { o = parseArgs(argv); } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    out(`delivery-metrics: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  if (o.help) { out(`${USAGE}\n`); return 0; }
  try {
    if (o.command === 'compute') {
      if (!o.input) { out(`delivery-metrics: compute needs --input\n${USAGE}\n`); return 2; }
      const input = JSON.parse(readFile(o.input));
      if (input.schema !== INPUT_SCHEMA) throw new Error(`${o.input} is not a ${INPUT_SCHEMA} document`);
      const doc = computeMetrics(input, o.now ? { now: o.now } : {});
      const text = `${JSON.stringify(doc, null, 2)}\n`;
      if (o.out) writeFile(o.out, text); else out(text);
      return 0;
    }
    if (o.command === 'pipelines') {
      if (!o.project) { out(`delivery-metrics: pipelines needs --project\n${USAGE}\n`); return 2; }
      const token = readFile(o.tokenFile ?? '/etc/vitana/bot-metrics-token').trim();
      const client = createClient({ baseUrl: o.url ?? 'http://127.0.0.1', token, fetch: deps.fetch ?? globalThis.fetch, sleep: deps.sleep ?? ((t) => new Promise((r) => setTimeout(r, t))) });
      const pipelines = await fetchPipelines({ client, project: o.project, ref: o.ref ?? 'main', limit: Number(o.limit ?? 30) });
      out(`${JSON.stringify({ schema: INPUT_SCHEMA, repository: o.project.split('/').pop(), pipelines }, null, 2)}\n`);
      return 0;
    }
    out(`delivery-metrics: give a command\n${USAGE}\n`);
    return 2;
  } catch (e) {
    out(`delivery-metrics: ${redact(String(e?.message ?? e), null).slice(0, 300)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
