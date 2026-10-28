#!/usr/bin/env node
// VTID-05272 (plan kiro-autonomy-fallback §5 H) — one re-run of a failed TEST-SUITE run, only for an infra death.
//
//   node scripts/ci/test-suite/rerun-policy.mjs --repo <owner/name> --run-id <id> [--dry-run true] [--summary <file>]
//
// docs/DEPLOYMENT-PIPELINE.md: "One re-run is allowed only when the job died before any test ran
// (runner/checkout/install)". So the failed jobs are re-run (`gh run rerun <id> --failed`) only when the run is on its
// first attempt, concluded `failure`, and EVERY failed job either failed before its test step started, or its test
// step failed without printing a Jest summary (the runner died mid-step). A job whose tests ran and failed is a real
// red: nothing is re-run. Jobs that only roll up others (the summary, the shard union while a shard failed) are judged
// by the jobs they roll up. Reads the run with the read-only Actions API; the only write is the re-run itself.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The step whose failure means "the tests ran and failed" (Jest/vitest), and the union check.
export const TEST_STEPS = ['Run Jest suite', 'Run tests'];
export const UNION_STEP = 'Check shard union';
export const SUMMARY_JOB = 'Test Suite Summary';
export const UNION_JOB = 'gateway-shard-union';
const JEST_SUMMARY_RE = /^\s*(?:\S+\s+)?(Tests|Test Suites):\s+.*\btotal\b/m;
export const hasJestSummary = (log) => JEST_SUMMARY_RE.test(String(log || ''));

/**
 * Decide one job: 'infra' (died before its tests ran), 'real' (its tests or the union check failed), 'derived'
 * (rolls up other jobs), or 'unknown' (no recognised test step: never re-run).
 */
export function classifyJob(job, { logHasSummary = null, shardFailed = false } = {}) {
  if (job.name === SUMMARY_JOB) return 'derived';
  if (job.name === UNION_JOB && shardFailed) return 'derived';
  const steps = job.steps || [];
  const decisive = steps.findIndex((s) => TEST_STEPS.includes(s.name) || s.name === UNION_STEP);
  if (decisive < 0) return 'unknown';
  const failedAt = steps.findIndex((s) => s.conclusion === 'failure');
  const step = steps[decisive];
  if (failedAt >= 0 && failedAt < decisive) return 'infra';
  if (step.conclusion === 'failure') {
    if (step.name === UNION_STEP) return 'real';
    return logHasSummary === false ? 'infra' : 'real';
  }
  // The test step never ran (skipped/queued) or the job died with no failed step (runner lost, cancelled mid-run).
  if (step.status !== 'completed' || step.conclusion === 'skipped' || step.conclusion === null || step.conclusion === undefined) return 'infra';
  return 'unknown';
}

/** The run-level rule. `logs` maps job id → log text (only needed for jobs whose test step failed). */
export function shouldRerun({ run, jobs, logs = {} }) {
  if (!run || Number(run.run_attempt) !== 1) return { rerun: false, reason: `attempt ${run?.run_attempt ?? '?'} — at most one re-run` };
  if (run.conclusion !== 'failure') return { rerun: false, reason: `run concluded ${run.conclusion}` };
  const failed = (jobs || []).filter((j) => j.conclusion === 'failure');
  if (failed.length === 0) return { rerun: false, reason: 'no failed job' };
  const shardFailed = failed.some((j) => /^Gateway \(Jest, shard \d+\/\d+\)$/.test(j.name));
  const verdicts = failed.map((j) => {
    const log = logs[j.id];
    return { job: j.name, kind: classifyJob(j, { logHasSummary: log === undefined ? null : hasJestSummary(log), shardFailed }) };
  });
  const judged = verdicts.filter((v) => v.kind !== 'derived');
  if (judged.length === 0) return { rerun: false, reason: 'only roll-up jobs failed', verdicts };
  const notInfra = judged.filter((v) => v.kind !== 'infra');
  if (notInfra.length) return { rerun: false, reason: `real failure: ${notInfra.map((v) => `${v.job} (${v.kind})`).join(', ')}`, verdicts };
  return { rerun: true, reason: `every failed job died before its tests ran: ${judged.map((v) => v.job).join(', ')}`, verdicts };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}
function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  const { repo } = args;
  const id = String(args['run-id'] || '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^\d+$/.test(id)) { console.error('usage: --repo <owner/name> --run-id <id>'); return 2; }
  const run = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${id}`]));
  const jobs = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${id}/attempts/${run.run_attempt}/jobs?per_page=100`])).jobs || [];
  const logs = {};
  for (const j of jobs) {
    if (j.conclusion !== 'failure') continue;
    const s = (j.steps || []).find((x) => TEST_STEPS.includes(x.name));
    if (s && s.conclusion === 'failure') {
      try { logs[j.id] = gh(['api', `repos/${repo}/actions/jobs/${j.id}/logs`]); } catch { /* unreadable log → treated as a real failure */ }
    }
  }
  const d = shouldRerun({ run, jobs, logs });
  const line = `TEST-SUITE run ${id} attempt ${run.run_attempt}: ${d.rerun ? 'RE-RUN failed jobs' : 'no re-run'} — ${d.reason}`;
  console.log(line);
  for (const v of d.verdicts || []) console.log(`  ${v.job}: ${v.kind}`);
  if (args.summary) appendFileSync(args.summary, `${line}\n`);
  if (d.rerun && args['dry-run'] !== 'true') gh(['run', 'rerun', id, '--failed', '--repo', repo]);
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`rerun-policy.mjs: ${e.message}`); process.exitCode = 1; }
}
