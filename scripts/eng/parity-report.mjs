#!/usr/bin/env node
// Parity report of the shadow pipelines (plan agentic-delivery §8.1 steps 3 and the checklist, lane cutover, VTID-05545).
//
//   node scripts/eng/parity-report.mjs --repo vitana-v1|vitana-platform [--limit 30] [--min-shadow 10] [--map FILE] [--out FILE] [--gate]
//        [--gitlab-url URL] [--gitlab-token-file FILE] [--github-token-file FILE] [--github-api URL]
//
// For the last N commits of `main` it pairs what GitHub's workflows said with what GitLab's shadow pipeline said for the SAME SHA, through
// the workflow-to-job map (config/delivery/services.json, repositories.<repo>.github_workflows, written by lane pipelines), and lists every
// difference that nothing explains. A difference is explained when GitHub did not run or cancelled the workflow, when both are red, or when
// staging never served the commit (the deploy and verification workflows are then "not comparable", counted separately). A commit older than
// the first GitLab pipeline is before the shadow period and is not counted. The document (vitana.parity-report/v1) says in `summary.ready`
// whether the checklist items "at least 10 shadow commits with no unexplained difference" and "within the §5 targets" hold.
//
// Read only: GET requests to GitHub and GitLab; the tokens are read from files (never from argv) and never printed. Exit 0 with a report,
// 3 with --gate when the report is not ready, 1 on an error, 2 on a usage mistake. Dependency-free Node 20; both APIs are reached through an
// injected fetch, so the tests use fakes.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, projectId, redact } from './gitlab-api.mjs';
import { computeMetrics } from './delivery-metrics.mjs';

export const SCHEMA = 'vitana.parity-report/v1';
export const REPOS = Object.freeze({
  'vitana-platform': Object.freeze({ github: 'exafyltd/vitana-platform', gitlab: 'vitana/vitana-platform' }),
  'vitana-v1': Object.freeze({ github: 'exafyltd/vitana-v1', gitlab: 'vitana/vitana-v1' }),
});
const DEPLOY_WORKFLOW = /^AWS-STAGE-DEPLOY-/;
const STAGING_FATES = new Set(['t2', 't3']);
const GL_PENDING = new Set(['created', 'pending', 'running', 'manual', 'waiting_for_resource', 'preparing', 'scheduled', 'waiting_for_callback']);

/** The workflow map of one repository from the file of lane pipelines (or a plain { workflows } / { <file>: entry } object). */
export function mapFrom(doc, repository) {
  const direct = doc?.repositories?.[repository]?.github_workflows ?? doc?.github_workflows ?? doc?.workflows ?? null;
  if (direct) return direct;
  if (doc && typeof doc === 'object' && Object.values(doc).every((v) => v && typeof v === 'object' && 'fate' in v)) return doc;
  throw new Error(`no workflow map for ${repository} (expected repositories.${repository}.github_workflows)`);
}
export const jobKey = (name) => String(name).replace(/^full-suite:/, '');
const wanted = (name, job) => { const k = jobKey(name); return k === job || k.startsWith(`${job}:`); };

/** What the mapped jobs said in one GitLab pipeline: success | failure | skipped | pending | missing. */
export function gitlabResult(pipeline, jobs) {
  const hit = (pipeline?.jobs ?? []).filter((j) => jobs.some((w) => wanted(j.name, w)));
  if (hit.length === 0) return { result: 'missing', jobs: [] };
  const names = hit.map((j) => `${j.name}=${j.status}`);
  if (hit.some((j) => j.status === 'failed' || j.status === 'canceled')) return { result: 'failure', jobs: names };
  if (hit.some((j) => GL_PENDING.has(j.status))) return { result: 'pending', jobs: names };
  if (hit.every((j) => j.status === 'skipped')) return { result: 'skipped', jobs: names };
  return { result: 'success', jobs: names };
}
/** GitHub's conclusion as success | failure | cancelled | skipped | pending. */
export function githubResult(run) {
  if (run.status && run.status !== 'completed') return 'pending';
  switch (run.conclusion) {
    case 'success': return 'success';
    case 'failure': case 'timed_out': case 'startup_failure': case 'action_required': return 'failure';
    case 'cancelled': return 'cancelled';
    case 'skipped': case 'neutral': case 'stale': return 'skipped';
    default: return 'pending';
  }
}

const finished = (pl) => pl && (pl.jobs ?? []).length > 0 && !(pl.jobs ?? []).some((j) => GL_PENDING.has(j.status));

/**
 * The report (pure). `commits` is newest first: [{ sha, subject?, github: { runs: [{ workflow, conclusion, status }], stagingServed }, gitlab: { pipeline | null } }].
 */
export function buildReport({ repository, map, commits, minShadow = 10, now = new Date().toISOString() }) {
  const firstShadow = (() => { let i = -1; commits.forEach((c, n) => { if (c.gitlab?.pipeline) i = n; }); return i; })(); // index of the oldest commit with a pipeline
  const rows = [];
  const diffs = [];
  const pipelines = [];
  for (const [n, c] of commits.entries()) {
    const row = { sha: c.sha, subject: c.subject ?? null, state: 'compared', staging_served: c.github?.stagingServed !== false, comparisons: 0, matches: 0, not_comparable: 0 };
    rows.push(row);
    const pl = c.gitlab?.pipeline ?? null;
    if (!pl) {
      if (n > firstShadow) { row.state = 'before_shadow'; continue; }
      row.state = 'no_gitlab_pipeline';
      diffs.push({ sha: c.sha, workflow: null, kind: 'no_gitlab_pipeline', github: 'built', gitlab: 'no pipeline', jobs: [], explained: false, reason: 'GitLab has no shadow pipeline for this commit of main' });
      continue;
    }
    if (!finished(pl) || (c.github?.runs ?? []).some((r) => githubResult(r) === 'pending')) { row.state = 'in_progress'; continue; }
    pipelines.push(pl);
    const latest = new Map();
    for (const r of c.github?.runs ?? []) { const prev = latest.get(r.workflow); if (!prev || String(r.created_at ?? '') >= String(prev.created_at ?? '')) latest.set(r.workflow, r); }
    for (const [workflow, run] of [...latest].sort(([a], [b]) => a.localeCompare(b))) {
      const entry = map[workflow];
      if (!entry || entry.fate === 'kept' || entry.fate === 'dead') continue;
      const gh = githubResult(run);
      const gl = gitlabResult(pl, entry.jobs ?? []);
      const base = { sha: c.sha, workflow, jobs: gl.jobs, github: gh, gitlab: gl.result };
      if (STAGING_FATES.has(entry.fate) && c.github?.stagingServed === false) { row.not_comparable += 1; continue; }
      row.comparisons += 1;
      if (gh === 'cancelled' || gh === 'skipped') { diffs.push({ ...base, kind: 'github_did_not_run', explained: true, reason: `GitHub ${gh} the workflow` }); continue; }
      if (gl.result === 'missing') { diffs.push({ ...base, kind: 'no_gitlab_job', explained: false, reason: `GitLab has no job for ${(entry.jobs ?? []).join(', ') || 'this workflow'} in the pipeline of this commit` }); continue; }
      if (gh === 'success' && gl.result === 'success') { row.matches += 1; continue; }
      if (gh === 'failure' && gl.result === 'failure') { row.matches += 1; diffs.push({ ...base, kind: 'both_failed', explained: true, reason: 'both hosts say failed' }); continue; }
      if (gh === 'success' && gl.result === 'failure') { diffs.push({ ...base, kind: 'gitlab_failed_github_passed', explained: false, reason: 'GitLab failed what GitHub passed' }); continue; }
      if (gh === 'failure' && gl.result === 'success') { diffs.push({ ...base, kind: 'github_failed_gitlab_passed', explained: false, reason: 'GitLab passed what GitHub failed' }); continue; }
      if (gh === 'success' && gl.result === 'skipped') { diffs.push({ ...base, kind: 'gitlab_skipped_github_ran', explained: false, reason: 'GitLab skipped the jobs of a workflow GitHub ran' }); continue; }
      diffs.push({ ...base, kind: 'other', explained: false, reason: `GitHub ${gh}, GitLab ${gl.result}` });
    }
    if (row.comparisons === 0 && row.not_comparable > 0) row.state = 'not_comparable';
  }
  const shadow = rows.filter((r) => ['compared', 'not_comparable'].includes(r.state));
  const unexplained = diffs.filter((d) => !d.explained);
  const m = computeMetrics({ pipelines }, { now }).metrics;
  const targets = { first_result: m.first_result_seconds, required_checks: m.required_checks_seconds };
  const enough = shadow.length >= minShadow;
  const clean = unexplained.length === 0;
  const targetsMet = targets.first_result && targets.required_checks ? targets.first_result.met === true && targets.required_checks.met === true : null;
  return {
    schema: SCHEMA, generated_at: now, repository, commits: rows, differences: diffs,
    summary: {
      examined: rows.length, shadow_commits: shadow.length, before_shadow: rows.filter((r) => r.state === 'before_shadow').length, in_progress: rows.filter((r) => r.state === 'in_progress').length,
      compared: rows.filter((r) => r.state === 'compared').length, not_comparable: rows.filter((r) => r.state === 'not_comparable').length, staging_not_served: shadow.filter((r) => !r.staging_served).length,
      unexplained: unexplained.length, explained: diffs.length - unexplained.length, min_shadow: minShadow, targets,
      ready: { commits: enough, parity: clean, targets: targetsMet, all: enough && clean && targetsMet === true },
    },
  };
}

// ── reading GitHub and GitLab (GET only) ────────────────────────────────────────────────────────────────────────────────────────
export function githubClient({ fetch, apiUrl = 'https://api.github.com', token }) {
  const get = async (p, query = {}) => {
    const url = new URL(`${apiUrl.replace(/\/$/, '')}${p}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const res = await fetch(url.href, { method: 'GET', redirect: 'error', headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'vitana-parity-report', authorization: `Bearer ${token}` } });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`GitHub GET ${p} answered ${res.status}: ${redact(text, token).replace(/\s+/g, ' ').slice(0, 160)}`);
    return JSON.parse(text);
  };
  return { get };
}

/** Collects the commits of main with both hosts' results. */
export async function collect({ repository, github, gitlabClient, limit = 30 }) {
  const repo = REPOS[repository];
  if (!repo) throw new Error(`unknown repository ${repository} (vitana-platform or vitana-v1)`);
  const list = await github.get(`/repos/${repo.github}/commits`, { sha: 'main', per_page: Math.min(100, limit) });
  const pid = projectId(repo.gitlab);
  const commits = [];
  for (const row of list.slice(0, limit)) {
    const runs = await github.get(`/repos/${repo.github}/actions/runs`, { head_sha: row.sha, per_page: 100 });
    const rows = (runs.workflow_runs ?? []).map((r) => ({ workflow: path.posix.basename(String(r.path ?? '')), conclusion: r.conclusion ?? null, status: r.status ?? null, created_at: r.created_at ?? null }));
    const deploys = rows.filter((r) => DEPLOY_WORKFLOW.test(r.workflow));
    const found = await gitlabClient.get(`/projects/${pid}/pipelines`, { query: { sha: row.sha, ref: 'main', order_by: 'id', sort: 'desc', per_page: 1 } });
    let pipeline = null;
    if (Array.isArray(found) && found[0]) {
      const detail = await gitlabClient.get(`/projects/${pid}/pipelines/${found[0].id}`);
      const jobs = await gitlabClient.paginate(`/projects/${pid}/pipelines/${found[0].id}/jobs`, { query: { per_page: 100 } });
      pipeline = { id: detail.id, sha: detail.sha, status: detail.status, created_at: detail.created_at, finished_at: detail.finished_at ?? null, jobs: jobs.map((j) => ({ name: j.name, stage: j.stage, status: j.status, created_at: j.created_at ?? null, started_at: j.started_at ?? null, finished_at: j.finished_at ?? null })) };
    }
    commits.push({ sha: row.sha, subject: String(row.commit?.message ?? '').split('\n')[0].slice(0, 120), github: { runs: rows.filter((r) => r.workflow), stagingServed: deploys.length === 0 ? false : deploys.some((r) => githubResult(r) === 'success') }, gitlab: { pipeline } });
  }
  return commits;
}

const USAGE = `usage: parity-report.mjs --repo vitana-platform|vitana-v1 [--limit 30] [--min-shadow 10] [--map FILE] [--out FILE] [--gate]
         [--gitlab-url URL] [--gitlab-token-file FILE] [--github-token-file FILE] [--github-api URL]
  exit: 0 report written, 3 with --gate when the report is not ready, 1 error, 2 usage mistake. Read only.`;
class UsageError extends Error {}
export function parseArgs(argv) {
  const o = { gate: false };
  const flags = { '--repo': 'repo', '--limit': 'limit', '--min-shadow': 'minShadow', '--map': 'map', '--out': 'out', '--gitlab-url': 'gitlabUrl', '--gitlab-token-file': 'gitlabTokenFile', '--github-token-file': 'githubTokenFile', '--github-api': 'githubApi' };
  const args = [...argv];
  while (args.length) {
    const a = args.shift();
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    if (a === '--gate') { o.gate = true; continue; }
    if (Object.hasOwn(flags, a)) { const v = args.shift(); if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`); o[flags[a]] = v; continue; }
    throw new UsageError(a.startsWith('-') ? `unknown option ${a.slice(0, 40)}` : `unknown argument ${a.slice(0, 40)}`);
  }
  for (const k of ['limit', 'minShadow']) if (o[k] !== undefined && !/^\d{1,3}$/.test(o[k])) throw new UsageError(`--${k === 'limit' ? 'limit' : 'min-shadow'} must be a number from 0 to 999`);
  return o;
}
const DEFAULT_MAP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'config', 'delivery', 'services.json');

export async function main(argv, deps = {}) {
  const out = deps.stdout ?? ((t) => process.stdout.write(t));
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, 'utf8'));
  const writeFile = deps.writeFile ?? ((p, t) => fs.writeFileSync(p, t));
  let o;
  try { o = parseArgs(argv); } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    out(`parity-report: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  if (o.help) { out(`${USAGE}\n`); return 0; }
  if (!o.repo || !REPOS[o.repo]) { out(`parity-report: --repo must be vitana-platform or vitana-v1\n${USAGE}\n`); return 2; }
  const secrets = [];
  try {
    const map = mapFrom(JSON.parse(readFile(o.map ?? DEFAULT_MAP)), o.repo);
    const ghToken = readFile(o.githubTokenFile ?? '/etc/vitana/github-bridge-token').trim();
    const glToken = readFile(o.gitlabTokenFile ?? '/etc/vitana/bot-metrics-token').trim();
    secrets.push(ghToken, glToken);
    const fetch = deps.fetch ?? globalThis.fetch;
    const sleep = deps.sleep ?? ((t) => new Promise((r) => setTimeout(r, t)));
    const commits = await collect({
      repository: o.repo, limit: Number(o.limit ?? 30),
      github: githubClient({ fetch, apiUrl: o.githubApi ?? 'https://api.github.com', token: ghToken }),
      gitlabClient: createClient({ baseUrl: o.gitlabUrl ?? 'http://127.0.0.1', token: glToken, fetch, sleep }),
    });
    const report = buildReport({ repository: o.repo, map, commits, minShadow: Number(o.minShadow ?? 10), now: deps.now ?? new Date().toISOString() });
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (o.out) writeFile(o.out, text); else out(text);
    return o.gate && !report.summary.ready.all ? 3 : 0;
  } catch (e) {
    let msg = redact(String(e?.message ?? e), null);
    for (const s of secrets) if (s) msg = msg.split(s).join('[redacted]');
    out(`parity-report: ${msg.slice(0, 300)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
