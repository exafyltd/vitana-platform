// The governance jobs of the GitLab merge-request pipeline (plan agentic-delivery §3.4 and §4, lane merge-queue).
//
//   node scripts/eng/gitlab-gates.mjs lane-scope     [--repo <dir>] [--base <sha>] [--head <sha>] [--branch <name>]
//   node scripts/eng/gitlab-gates.mjs collab-handoff [--repo <dir>] [--base <sha>] [--head <sha>] [--branch <name>]
//     options: --platform-url <git URL of vitana/vitana-platform>  --platform-dir <clone dir>  --project <name>
//     defaults from the GitLab CI variables: CI_PROJECT_DIR, CI_MERGE_REQUEST_DIFF_BASE_SHA, CI_COMMIT_SHA,
//     CI_MERGE_REQUEST_SOURCE_BRANCH_NAME, CI_PROJECT_NAME, CI_SERVER_URL; the job token CI_JOB_TOKEN reads the platform.
//
// `lane-scope` calls queue.mjs `scopeCheck` and `collab-handoff` calls queue.mjs `validateRange` (plus the programme and
// seat checks of `queue.mjs validate`), both unchanged, so the rules cannot drift from GitHub's PR-GATE. Only the sources
// of lane files change: GitHub's `gh api` fetchers become fetchers over a local clone of the vitana-platform project,
// fetched with the job's own short-lived token: `fetchLane` reads platform `main`, `fetchPlanLane` reads the
// `kiro/<slug>/plan` branch of the plan( merge request (the lane file at its newest ci-plan-spar commit, handoff.md at its
// head), the shape of queue.mjs `ghPlanLaneFetcher`. In the platform project itself `fetchLane` stays off, as PR-GATE
// runs it there (no --lane-repo). A platform project that cannot be fetched fails closed: exit 3, nothing passes.
// Exit: 0 pass, 1 problems, 2 usage, 3 the platform project is unreachable. The token never appears on a command line, in
// a file or in the output: git asks an askpass script that reads it from the environment. Dependency-free Node 20.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopeCheck, validateRange, loadPrograms, validatePrograms, loadSeats, validateRegistry, repoNameOf } from '../collab/queue.mjs';

export const PLATFORM_PROJECT = 'vitana-platform';
const MAIN = 'refs/remotes/origin/main';
const MAX_BUFFER = 64 * 1024 * 1024;
const CI_PLAN_SPAR = 'ci-plan-spar';

const git = (repo, args, env) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER, ...(env ? { env } : {}) }).trimEnd();
const show = (repo, rev, p) => { try { return git(repo, ['show', `${rev}:${p}`]); } catch { return null; } };

/** Git environment whose askpass script answers the CI job token user and the token, read from VITANA_GATES_TOKEN. */
export function askpassEnv({ dir, token, base = process.env }) {
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'askpass.sh');
  fs.writeFileSync(script, '#!/bin/sh\ncase "$1" in Username*) echo gitlab-ci-token ;; *) printf \'%s\\n\' "$VITANA_GATES_TOKEN" ;; esac\n', { mode: 0o700 });
  fs.chmodSync(script, 0o700);
  return { ...base, GIT_ASKPASS: script, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', ...(token ? { VITANA_GATES_TOKEN: token } : {}) };
}

/** A bare clone of the platform project at `dir` with main and every plan branch fetched. Throws (fails closed) when unreachable. */
export function preparePlatform({ dir, url, env }) {
  try {
    if (!fs.existsSync(path.join(dir, 'HEAD'))) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '--bare', '-q', dir], { stdio: 'ignore' });
      git(dir, ['remote', 'add', 'origin', url]);
    } else {
      git(dir, ['remote', 'set-url', 'origin', url]);
    }
    git(dir, ['fetch', '-q', '--prune', 'origin', `+refs/heads/main:${MAIN}`, '+refs/heads/kiro/*/plan:refs/remotes/origin/kiro/*/plan'], env);
    git(dir, ['rev-parse', '--verify', '-q', `${MAIN}^{commit}`]);
  } catch (e) {
    const err = new Error(`the vitana-platform project is unreachable (${String(e.stderr || e.message).trim().split('\n').slice(-1)[0].replace(/\/\/[^@/]*@/g, '//')}): the job fails closed`);
    err.code = 'unreachable';
    throw err;
  }
  return dir;
}

/** fetchLane / fetchPlanLane for queue.mjs over a prepared platform clone. */
export function platformFetchers(platformRepo) {
  const fetchLane = (p) => show(platformRepo, MAIN, p);
  const fetchPlanLane = (slug, lanePath) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(slug))) return null;
    const ref = `refs/remotes/origin/kiro/${slug}/plan`;
    let head;
    try { head = git(platformRepo, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]); } catch { return null; }
    const log = git(platformRepo, ['log', '--format=%H%x1f%(trailers:key=Collab-Session,valueonly,separator=%x2c)', head, '--', lanePath]).split('\n').filter(Boolean)
      .map((l) => { const [sha, session] = l.split('\x1f'); return { sha, session: (session || '').split(',')[0].trim() }; });
    if (!log.length) return null;
    const at = log.find((c) => c.session === CI_PLAN_SPAR) || log[0];
    const text = show(platformRepo, at.sha, lanePath);
    const handoffText = show(platformRepo, head, `.kiro/specs/${slug}/handoff.md`);
    if (text === null) return null;
    return { text, handoffText, lastSession: at.session, pr: null, ref: `kiro/${slug}/plan`, sha: at.sha };
  };
  return { fetchLane, fetchPlanLane };
}

/** The fetchers a job of `project` uses: in the platform project itself only the plan source, as PR-GATE does there. */
function fetchersFor(repo, platformRepo, project) {
  const f = platformFetchers(platformRepo);
  const own = (project || repoNameOf(repo)) === PLATFORM_PROJECT;
  return { fetchLane: own ? null : f.fetchLane, fetchPlanLane: f.fetchPlanLane };
}

/** queue.mjs scopeCheck with the GitLab fetchers. */
export function laneScope(repo, { base, head, branch = '', platformRepo, project }) {
  return scopeCheck(repo, { base, head, branch, ...fetchersFor(repo, platformRepo, project) });
}

/** queue.mjs validateRange plus the programme and seat checks of `queue.mjs validate`, with the GitLab fetchers. */
export function collabHandoff(repo, { base, head, branch = '', platformRepo, project }) {
  const fetchers = fetchersFor(repo, platformRepo, project);
  const allowInitial = [];
  for (const p of git(repo, ['diff', '--name-only', `${base}...${head}`]).split('\n')) {
    if (!/^docs\/validation\/VTID-\d{5}\/scope\.json$/.test(p)) continue;
    try { const v = JSON.parse(show(repo, head, p) || '{}').collab_allow_initial; if (Array.isArray(v)) allowInitial.push(...v.map(String)); } catch { /* the scope guard reports bad JSON */ }
  }
  const r = validateRange(repo, { base, head, branch, allowInitial, ...fetchers });
  const programs = loadPrograms(repo, head);
  r.errors.push(...validatePrograms(programs));
  let seats = loadSeats(repo, head);
  if (!seats && fetchers.fetchLane) {
    const t = fetchers.fetchLane('docs/programs/areas.yaml');
    if (t) {
      seats = new Set();
      let on = false;
      for (const l of t.split(/\r?\n/)) { if (/^\S/.test(l)) { on = /^seats:/.test(l); continue; } const m = on && /^ {2}([a-z]{1,12}):/.exec(l); if (m) seats.add(m[1]); }
    }
  }
  r.errors.push(...validateRegistry(repo, { head, touched: r.touched, repoName: repoNameOf(repo), seats, programs }));
  return r;
}

/** The status line of `queue.mjs scope-check`, word for word. */
export function scopeStatus(r) {
  const status = !r.applies ? '➖ **lane scope** — not a lane PR'
    : r.errors.length ? `❌ **lane scope** — ${r.errors.length} problem(s)${r.lane ? ` (lane ${r.lane})` : ''}:\n${r.errors.map((e) => `- ${e}`).join('\n')}`
      : `✅ **lane scope** — lane ${r.lane}: every change is inside its paths`;
  const warn = r.warnings.length ? `\n\n⚠️ ${r.warnings.join('\n⚠️ ')}` : '';
  return `${status}${warn}`;
}

/** The status line of `queue.mjs validate` (without its queue table). */
export function handoffStatus(r) {
  const status = r.errors.length ? `❌ **collab handoff** — ${r.errors.length} problem(s):\n${r.errors.map((e) => `- ${e}`).join('\n')}`
    : `✅ **collab handoff** — ${r.touched.length} handoff/lane file(s) changed, all valid`;
  const warn = r.warnings.length ? `\n\n⚠️ ${r.warnings.join('\n⚠️ ')}` : '';
  return `${status}${warn}`;
}

const VALUE_OPTIONS = new Set(['repo', 'base', 'head', 'branch', 'platform-url', 'platform-dir', 'project']);
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (!VALUE_OPTIONS.has(k)) throw new Error(`unknown option ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
    o[k] = v;
    i++;
  }
  return o;
}

export function main(argv, { env = process.env, stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s) } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) { stderr(`gitlab-gates: ${e.message}\n`); return 2; }
  const job = o._[0];
  if (!['lane-scope', 'collab-handoff'].includes(job)) {
    stderr('usage: gitlab-gates.mjs lane-scope|collab-handoff [--repo d] [--base sha] [--head sha] [--branch b] [--platform-url u] [--platform-dir d]\n');
    return 2;
  }
  const repo = o.repo || env.CI_PROJECT_DIR;
  const base = o.base || env.CI_MERGE_REQUEST_DIFF_BASE_SHA;
  const head = o.head || env.CI_COMMIT_SHA;
  const branch = o.branch ?? env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ?? '';
  const url = o['platform-url'] || (env.CI_SERVER_URL ? `${env.CI_SERVER_URL.replace(/\/+$/, '')}/vitana/${PLATFORM_PROJECT}.git` : '');
  if (!repo || !base || !head || !url) { stderr('gitlab-gates: needs --repo, --base, --head and --platform-url (or the GitLab CI variables)\n'); return 2; }
  const dir = o['platform-dir'] || path.join(os.tmpdir(), `vitana-gates-${process.pid}`, 'platform.git');
  let platformRepo;
  try {
    const gitEnv = env.CI_JOB_TOKEN ? askpassEnv({ dir: path.join(path.dirname(dir), 'askpass'), token: env.CI_JOB_TOKEN, base: env }) : { ...env, GIT_TERMINAL_PROMPT: '0' };
    platformRepo = preparePlatform({ dir, url, env: gitEnv });
  } catch (e) {
    stdout(`❌ **${job.replace('-', ' ')}** — ${e.message}\n`);
    return 3;
  }
  try {
    const project = o.project || env.CI_PROJECT_NAME || undefined;
    if (job === 'lane-scope') {
      const r = laneScope(repo, { base, head, branch, platformRepo, project });
      stdout(`${scopeStatus(r)}\n`);
      return r.errors.length ? 1 : 0;
    }
    const r = collabHandoff(repo, { base, head, branch, platformRepo, project });
    stdout(`${handoffStatus(r)}\n`);
    return r.errors.length ? 1 : 0;
  } catch (e) {
    stdout(`❌ **${job.replace('-', ' ')}** — ${String(e.message).split('\n')[0]}: fails closed\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
