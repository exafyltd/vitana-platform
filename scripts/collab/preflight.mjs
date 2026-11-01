#!/usr/bin/env node
/**
 * VTID-05336 — preflight: every CI governance check of a lane or `plan(` PR, locally, in one pass
 * (plan pipeline-speed §2.6 / D5, lane `preflight`).
 *
 *   node scripts/collab/preflight.mjs --repo <path> --base <ref> --head <ref> [--branch <ref>] [--title "<PR title>"]
 *                                     [--plan-repo <owner/repo>]... [--no-tests] [--json] [--required-only]
 *
 * Preflight re-implements nothing: it spawns the repository's own CI commands with the arguments PR-GATE.yml gives
 * them, collects every result and prints all failures grouped per check, labelled `required` (Collab handoff, Lane
 * scope) or `report-only in CI` (the PR-GATE Verdict checks, while scripts/ci/pr-gate/config.json `enforce` is not
 * true). Exit 1 when any check failed, 0 otherwise, 2 on usage errors. A part it could not check is a failure, never
 * a silent pass. CI stays the gate; preflight is advisory.
 *
 *   vitana-platform (--repo has scripts/collab/queue.mjs):
 *     Collab tests   node --test scripts/collab/*.test.mjs                         (skipped with --no-tests)
 *     Collab handoff queue.mjs validate (HEAD revision)  --base --head --branch
 *     Lane scope     queue.mjs scope-check (BASE revision + base protected-gate-files.json, as PR-GATE.yml:160-166)
 *                    --base --head --branch --plan-repo exafyltd/vitana-platform
 *   vitana-v1 (no queue.mjs of its own): both queue.mjs commands come from this vitana-platform checkout's
 *     origin/main copy with --lane-repo exafyltd/vitana-platform, as v1 PR-GATE.yml.
 *   both: gate.mjs scope | sparring | weakening | red-green --title (cwd = --repo), and
 *         node --test scripts/ci/kiro-steering/guard.test.cjs + guard.cjs . when the repo has them.
 *
 * No gateway call. The only network use is read-only `gh` inside queue.mjs (plan( PR lane files, vitana-platform
 * files for a v1 PR) plus one `gh api rate_limit` probe when that lookup is needed. No write outside its temp dir,
 * which is removed at exit. The working-tree checks (tests, gate.mjs, guard) judge the checked-out tree, so --head
 * should be the checked-out HEAD; a mismatch is reported.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLATFORM_SLUG = 'exafyltd/vitana-platform';
const V1_SLUG = 'exafyltd/vitana-v1';
const PLAN_LANE = '_plan';

class Usage extends Error {}

export function parseArgs(argv) {
  const out = { planRepo: [], tests: true, json: false, requiredOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = /^--([\w-]+)=(.*)$/.exec(a);
    const [k, v] = eq ? [eq[1], eq[2]] : a.startsWith('--') ? [a.slice(2), undefined] : [null, a];
    if (k === null) throw new Usage(`unexpected argument "${a}"`);
    if (k === 'no-tests') { out.tests = false; continue; }
    if (k === 'json') { out.json = true; continue; }
    if (k === 'required-only') { out.requiredOnly = true; continue; }
    const val = v ?? argv[++i];
    if (val === undefined) throw new Usage(`--${k} needs a value`);
    if (k === 'plan-repo') out.planRepo.push(val);
    else if (['repo', 'base', 'head', 'branch', 'title'].includes(k)) out[k] = val;
    else throw new Usage(`unknown option --${k}`);
  }
  if (!out.repo || !out.base || !out.head) throw new Usage('preflight needs --repo <path> --base <ref> --head <ref>');
  return out;
}

/** Child environment: no GitHub step summary (outputs go to stdout), no colour codes. */
function childEnv(extra = {}) {
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...extra };
  delete env.GITHUB_STEP_SUMMARY;
  return env;
}
function run(cmd, args, { cwd, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: env || childEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`.trim();
  return { status: r.error ? null : r.status, output };
}
function git(repo, args) {
  const r = run('git', ['-C', repo, ...args]);
  return r.status === 0 ? r.output : null;
}
/** `git show <rev>:<file>` into `dest`; false when the file is absent at that revision. */
function extract(repo, rev, file, dest) {
  const r = spawnSync('git', ['-C', repo, 'show', `${rev}:${file}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return false;
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, r.stdout);
  return true;
}

function ciLabel(repo) {
  let enforce = false;
  try { enforce = JSON.parse(readFileSync(path.join(repo, 'scripts/ci/pr-gate/config.json'), 'utf8')).enforce === true; } catch { /* absent → report-only */ }
  return enforce ? 'required (config.enforce=true)' : 'report-only in CI (until config.enforce=true)';
}

/** Work lanes named by Collab-Lane / Collab-Review trailers in base..head (input for the gh-need decision only). */
function trailerLanes(repo, base, head) {
  const log = git(repo, ['log', '--format=%(trailers:key=Collab-Lane,valueonly)%(trailers:key=Collab-Review,valueonly)', `${base}..${head}`]) || '';
  return [...new Set(log.split(/[\n,]/).map((s) => s.trim()).filter((l) => /^[^/\s]+\/[^/\s]+$/.test(l) && !l.endsWith(`/${PLAN_LANE}`)))];
}

/** A check blocks a merge in CI only when its label says `required`; report-only labels never do. */
export const isRequired = (c) => String(c.ci).startsWith('required');
const withVerdicts = (r) => ({ ...r, requiredOk: !r.checks.some((c) => c.status === 'fail' && isRequired(c)) });

export function preflight(opts) {
  return withVerdicts(preflightChecks(opts));
}

function preflightChecks(opts) {
  const repo = path.resolve(opts.repo);
  const checks = [];
  const add = (id, name, ci, status, output = '') => checks.push({ id, name, ci, status, output: String(output).trim() });
  const tmp = mkdtempSync(path.join(tmpdir(), 'preflight-'));
  try {
    const base = git(repo, ['rev-parse', '--verify', `${opts.base}^{commit}`]);
    const head = git(repo, ['rev-parse', '--verify', `${opts.head}^{commit}`]);
    if (!base || !head) {
      add('refs', 'Refs', 'required', 'fail', `cannot resolve ${!base ? `--base ${opts.base}` : `--head ${opts.head}`} in ${repo}`);
      return { ok: false, repo, base: opts.base, head: opts.head, checks };
    }
    const branch = opts.branch ?? (git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']) || '');
    const isPlatform = git(repo, ['cat-file', '-e', `${head}:scripts/collab/queue.mjs`]) !== null;
    const mode = isPlatform ? 'vitana-platform' : 'vitana-v1';
    const node = process.execPath;
    const verdict = ciLabel(repo);

    const wt = git(repo, ['rev-parse', 'HEAD']);
    if (wt !== head) add('worktree', 'Working tree at --head', 'required', 'fail', `the checked-out HEAD (${(wt || 'none').slice(0, 12)}) is not --head (${head.slice(0, 12)}); Collab tests, PR-GATE and Kiro steering judge the checked-out tree, as CI checks out the PR head`);
    if (opts.title === undefined) add('title', 'PR title', 'required', 'fail', 'no --title: PR-GATE scope / sparring / red-green read the VTIDs from the PR title (CI uses the live title); pass --title "<PR title>"');

    // 1. Collab tests (Collab handoff job, required).
    if (isPlatform) {
      const dir = path.join(repo, 'scripts/collab');
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join('scripts/collab', f)) : [];
      if (!opts.tests) add('collab-tests', 'Collab tests', 'required', 'skip', '--no-tests');
      else if (files.length === 0) add('collab-tests', 'Collab tests', 'required', 'skip', 'no scripts/collab/*.test.mjs');
      else {
        const r = run(node, ['--test', ...files], { cwd: repo });
        add('collab-tests', 'Collab tests', 'required', r.status === 0 ? 'pass' : 'fail', r.status === 0 ? lastLines(r.output, 8) : r.output);
      }
    }

    // Queue copies: platform → head copy for validate, base copy for scope-check; v1 → this checkout's origin/main copy.
    const qHead = path.join(tmp, 'head', 'queue.mjs');
    const qBase = path.join(tmp, 'base', 'queue.mjs');
    let haveHead;
    let haveBase;
    if (isPlatform) {
      haveHead = extract(repo, head, 'scripts/collab/queue.mjs', qHead);
      extract(repo, head, 'scripts/collab/protected-gate-files.json', path.join(tmp, 'head', 'protected-gate-files.json'));
      haveBase = extract(repo, base, 'scripts/collab/queue.mjs', qBase);
      extract(repo, base, 'scripts/collab/protected-gate-files.json', path.join(tmp, 'base', 'protected-gate-files.json'));
    } else {
      const ref = git(PLATFORM_ROOT, ['rev-parse', '--verify', 'origin/main^{commit}']) ? 'origin/main' : 'HEAD';
      haveHead = extract(PLATFORM_ROOT, ref, 'scripts/collab/queue.mjs', qHead);
      extract(PLATFORM_ROOT, ref, 'scripts/collab/protected-gate-files.json', path.join(tmp, 'head', 'protected-gate-files.json'));
      haveBase = haveHead;
    }
    const laneRepo = isPlatform ? [] : ['--lane-repo', PLATFORM_SLUG];
    const branchArg = branch ? ['--branch', branch] : [];

    // 2. Collab handoff (required on vitana-platform; report-only step on vitana-v1).
    const handoffCi = isPlatform ? 'required' : 'report-only in CI (vitana-v1 Collab handoff step)';
    if (!haveHead) add('collab-handoff', 'Collab handoff', handoffCi, 'fail', `not checked: scripts/collab/queue.mjs not found (${isPlatform ? `at ${head.slice(0, 12)}` : `in ${PLATFORM_ROOT} origin/main`})`);
    else {
      const r = run(node, [qHead, 'validate', '--repo', repo, '--base', base, '--head', head, ...branchArg, ...laneRepo], { cwd: repo });
      add('collab-handoff', 'Collab handoff', handoffCi, r.status === 0 ? 'pass' : 'fail', r.output);
    }

    // 3. Lane scope (required) — base revision of the checker, as PR-GATE.yml:160-166.
    const planRepos = opts.planRepo.length ? opts.planRepo : isPlatform ? [PLATFORM_SLUG] : [V1_SLUG, PLATFORM_SLUG];
    const qScope = isPlatform ? qBase : qHead;
    if (!haveBase) add('lane-scope', 'Lane scope', 'required', 'fail', 'not checked: scripts/collab/queue.mjs is absent at --base');
    else {
      const r = run(node, [qScope, 'scope-check', '--repo', repo, '--base', base, '--head', head, ...branchArg,
        ...planRepos.flatMap((p) => ['--plan-repo', p]), ...laneRepo], { cwd: repo });
      add('lane-scope', 'Lane scope', 'required', r.status === 0 ? 'pass' : 'fail', r.output);
    }
    // gh is needed when a lane file must come from an open plan( PR (absent at the merge-base) or from vitana-platform
    // (a v1 PR). queue.mjs treats an unreachable gh as "not found"; preflight names it instead.
    const mergeBase = git(repo, ['merge-base', base, head]);
    const needGh = !isPlatform || trailerLanes(repo, base, head).some((key) => {
        const [slug, id] = key.split('/');
        return !mergeBase || git(repo, ['cat-file', '-e', `${mergeBase}:.kiro/specs/${slug}/lanes/${id}.md`]) === null;
      });
    if (needGh) {
      const gh = process.env.PREFLIGHT_GH || 'gh';
      const r = run(gh, ['api', 'rate_limit', '--jq', '.resources.core.remaining']);
      add('plan-pr-lane', 'gh for plan( PR / vitana-platform lane files', 'required', r.status === 0 ? 'pass' : 'fail',
        r.status === 0 ? `gh reachable (${r.output} API calls left)` : `plan-PR lane not checked: gh is missing, not signed in or offline (${lastLines(r.output, 2) || 'no output'}); Lane scope / Collab handoff above could not read lane files from GitHub`);
    }

    // 4. PR-GATE Verdict checks of the target repo (report-only until config.enforce=true).
    const gate = path.join(repo, 'scripts/ci/pr-gate/gate.mjs');
    for (const c of ['scope', 'sparring', 'weakening', 'red-green']) {
      const id = `pr-gate-${c}`;
      if (!existsSync(gate)) { add(id, `PR-GATE ${c}`, verdict, 'fail', 'not checked: scripts/ci/pr-gate/gate.mjs is missing'); continue; }
      const r = run(node, [gate, c, '--base', base, '--head', head, '--title', opts.title ?? ''], { cwd: repo });
      add(id, `PR-GATE ${c}`, verdict, r.status === 0 ? 'pass' : 'fail', r.output);
    }

    // 5. Kiro steering (part of the PR-GATE Verdict).
    const guard = path.join(repo, 'scripts/ci/kiro-steering/guard.cjs');
    const guardTest = path.join(repo, 'scripts/ci/kiro-steering/guard.test.cjs');
    if (!existsSync(guard)) add('kiro-steering', 'Kiro steering', verdict, 'skip', 'this repo has no scripts/ci/kiro-steering/guard.cjs');
    else {
      const t = existsSync(guardTest) ? run(node, ['--test', guardTest], { cwd: repo }) : { status: 0, output: '' };
      const g = run(node, [guard, '.'], { cwd: repo });
      const ok = t.status === 0 && g.status === 0;
      add('kiro-steering', 'Kiro steering', verdict, ok ? 'pass' : 'fail',
        [t.status === 0 ? lastLines(t.output, 4) : t.output, g.output].filter(Boolean).join('\n'));
    }
    if (!isPlatform) {
      add('not-covered', 'Not run by preflight', 'report-only in CI', 'skip',
        'vitana-v1 PR-GATE also runs migrations, typecheck / ESLint / design ratchets, regression scripts and the build: run npm test, npm run lint and npm run build (lane-code.md step 7)');
    }
    return { ok: !checks.some((c) => c.status === 'fail'), repo, mode, base, head, branch, title: opts.title ?? null, checks };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function lastLines(text, n) {
  return String(text || '').trim().split(/\r?\n/).slice(-n).join('\n');
}

export function render(report) {
  const icon = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' };
  const lines = [`preflight ${report.mode || ''} ${report.repo}`, `  base ${report.base}  head ${report.head}${report.branch ? `  branch ${report.branch}` : ''}`, ''];
  for (const c of report.checks) {
    lines.push(`${icon[c.status]}  ${c.name} [${c.ci}]`);
    if (c.status !== 'pass' && c.output) for (const l of c.output.split(/\r?\n/)) lines.push(`      ${l}`);
  }
  const failedChecks = report.checks.filter((c) => c.status === 'fail');
  lines.push('', failedChecks.length
    ? `preflight: ${failedChecks.length} check(s) failed: ${failedChecks.map((c) => c.name).join(', ')} — fix every error above, then push`
    : 'preflight: every check passed');
  return lines.join('\n');
}

function main(argv) {
  const opts = parseArgs(argv);
  const report = preflight(opts);
  process.stdout.write(`${opts.json ? JSON.stringify(report, null, 2) : render(report)}\n`);
  // --required-only: exit status follows the checks CI requires; report-only failures are still printed above.
  return (opts.requiredOnly ? report.requiredOk : report.ok) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    console.error(`preflight.mjs: ${e.message}`);
    process.exitCode = e instanceof Usage ? 2 : 1;
  }
}
