#!/usr/bin/env node
/**
 * VTID-05336 — preflight: every CI governance check of a lane or `plan(` PR, locally, in one pass
 * (plan pipeline-speed §2.6 / D5, lane `preflight`).
 *
 *   node scripts/collab/preflight.mjs --repo <path> --base <ref> --head <ref> [--branch <ref>] [--title "<PR title>"]
 *                                     [--plan-repo <owner/repo>]... [--body-file <PR body>] [--no-tests] [--json]
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
 *   VALIDATOR-CHECK (VTID-05360, required where it runs) — only when a changed file (base...head) matches the
 *         workflow's on.pull_request.paths: every `run:` step of job validate-pr of the HEAD revision of
 *         .github/workflows/VALIDATOR-CHECK.yml, in order, except `Build Gate` (reported as not run), each in the
 *         shell GitHub uses (`bash -e`; `shell: bash` → `bash --noprofile --norc -eo pipefail`) with cwd = --repo,
 *         its `env:`, the ${{ }} expressions
 *         github.base_ref / github.event.pull_request.title|body / steps.<id>.outputs.<K> substituted and every
 *         `/tmp/` path moved into the preflight temp dir. The PR body comes from --body-file, else the open PR's body
 *         (gh api). Any other expression, a parse error or a missing body fails the check.
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
  const out = { planRepo: [], tests: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = /^--([\w-]+)=(.*)$/.exec(a);
    const [k, v] = eq ? [eq[1], eq[2]] : a.startsWith('--') ? [a.slice(2), undefined] : [null, a];
    if (k === null) throw new Usage(`unexpected argument "${a}"`);
    if (k === 'no-tests') { out.tests = false; continue; }
    if (k === 'json') { out.json = true; continue; }
    const val = v ?? argv[++i];
    if (val === undefined) throw new Usage(`--${k} needs a value`);
    if (k === 'plan-repo') out.planRepo.push(val);
    else if (k === 'body-file') out.bodyFile = val;
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

export function preflight(opts) {
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
    // 6. VALIDATOR-CHECK (required on the PRs it runs on).
    const vc = validatorCheck({ repo, base, head, mergeBase, branch, title: opts.title ?? '', baseRef: opts.base, bodyFile: opts.bodyFile, tmp });
    add('validator-check', 'VALIDATOR-CHECK', 'required', vc.status, vc.output);
    if (vc.applies) {
      add('not-covered-validator', 'Not run by preflight', 'required (VALIDATOR-CHECK)', 'skip',
        'Not run by preflight: VALIDATOR-CHECK Build Gate (`npm run build`, and for `command_hub_frontend` the src+dist both-updated check): '
        + 'a command_hub_frontend PR can pass preflight and still fail that CI step; run `cd services/gateway && npm ci && npm run build`');
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

// ── VALIDATOR-CHECK (VTID-05360) ──
const VALIDATOR_WORKFLOW = '.github/workflows/VALIDATOR-CHECK.yml';
const VALIDATOR_JOB = 'validate-pr';
const STEP_KEYS = new Set(['name', 'id', 'env', 'run', 'shell', 'uses', 'with', 'timeout-minutes']);
// GitHub Actions on Linux: a `run:` step without `shell:` runs in `bash -e {0}`; `shell: bash` runs in
// `bash --noprofile --norc -eo pipefail {0}` (the runner logs show `shell: /usr/bin/bash -e {0}` for this workflow).
const SHELLS = { '': ['-e'], bash: ['--noprofile', '--norc', '-eo', 'pipefail'] };
class Unsupported extends Error {}

/**
 * The YAML subset GitHub workflows here use, without dependencies: block maps, block lists (also at the parent key's
 * indentation), `|` / `|-` block scalars, plain / quoted scalars and flow lists of scalars. Anything else throws.
 */
export function parseYaml(text) {
  const lines = String(text).split(/\r?\n/);
  let i = 0;
  const fail = (msg) => { throw new Error(`line ${i + 1}: ${msg}`); };
  const indentOf = (l) => /^ */.exec(l)[0].length;
  const isItem = (l) => /^ *-(?: |$)/.test(l);
  const KEY = /^([^\s#'"\-:][^:]*?|-[^\s:][^:]*?|'[^']*'|"[^"]*"):(?: +(.*))?$/;
  const skip = () => { while (i < lines.length && (!lines[i].trim() || /^\s*#/.test(lines[i]))) i++; };
  const stripComment = (v) => (/^['"]/.test(v) ? v : v.replace(/\s+#.*$/, '')).trim();
  function scalar(v) {
    if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
    if (/^".*"$/.test(v)) { try { return JSON.parse(v); } catch { fail(`bad double-quoted scalar ${v}`); } }
    if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean).map(scalar);
    if (/^[{&*!|>%@`]/.test(v)) fail(`unsupported YAML value ${v}`);
    return v;
  }
  function block(indent, style) {
    if (style.startsWith('>')) fail('folded block scalars are not supported');
    const body = [];
    let bi = null;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { body.push(''); i++; continue; }
      const ind = indentOf(l);
      if (bi === null) { if (ind <= indent) break; bi = ind; }
      if (ind < bi) break;
      body.push(l.slice(bi));
      i++;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    return body.join('\n') + (style.endsWith('-') ? '' : '\n');
  }
  function value(rest, indent) {
    const v = stripComment(rest);
    if (/^[|>][+-]?$/.test(v)) return block(indent, v);
    if (v !== '') return scalar(v);
    skip();
    if (i >= lines.length) return null;
    const ind = indentOf(lines[i]);
    if (ind > indent) return node(ind);
    if (ind === indent && isItem(lines[i])) return list(indent);
    return null;
  }
  function map(indent) {
    const out = {};
    for (;;) {
      skip();
      if (i >= lines.length) return out;
      const l = lines[i];
      if (/^ *\t/.test(l)) fail('tab indentation');
      const ind = indentOf(l);
      if (ind < indent) return out;
      if (ind > indent) fail('unexpected indentation');
      if (isItem(l)) fail('unexpected list item');
      const m = KEY.exec(l.slice(ind));
      if (!m) fail('expected "key: value"');
      i++;
      out[scalar(m[1])] = value(m[2] ?? '', indent);
    }
  }
  function list(indent) {
    const out = [];
    for (;;) {
      skip();
      if (i >= lines.length) return out;
      const l = lines[i];
      const ind = indentOf(l);
      if (ind < indent || (ind === indent && !isItem(l))) return out;
      if (ind > indent) fail('unexpected indentation');
      const rest = l.slice(ind + 1).replace(/^ /, '');
      if (KEY.test(rest)) { lines[i] = `${' '.repeat(ind + 2)}${rest}`; out.push(map(ind + 2)); continue; }
      i++;
      out.push(rest.trim() === '' ? value('', ind) : scalar(stripComment(rest)));
    }
  }
  function node(indent) {
    skip();
    if (i >= lines.length) return null;
    return isItem(lines[i]) ? list(indent) : map(indent);
  }
  const doc = node(0);
  skip();
  if (i < lines.length) fail('unexpected content');
  return doc;
}

/** A workflow `paths` glob (`*`, `**`, `?`) as a RegExp; negated patterns are not supported. */
export function globToRegExp(glob) {
  if (glob.startsWith('!')) throw new Unsupported(`unsupported negated path pattern ${glob}`);
  let re = '';
  for (let k = 0; k < glob.length; k++) {
    const c = glob[k];
    if (c === '*' && glob[k + 1] === '*') {
      if (glob[k + 2] === '/') { re += '(?:.*/)?'; k += 2; } else { re += '.*'; k++; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Lines `K=V` and `K<<DELIM … DELIM` of a $GITHUB_OUTPUT file. */
function readOutputs(file) {
  const out = {};
  const ls = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
  for (let k = 0; k < ls.length; k++) {
    const h = /^([^=<]+)<<(.+)$/.exec(ls[k]);
    if (h) {
      const v = [];
      for (k++; k < ls.length && ls[k] !== h[2]; k++) v.push(ls[k]);
      out[h[1]] = v.join('\n');
      continue;
    }
    const e = ls[k].indexOf('=');
    if (e > 0) out[ls[k].slice(0, e)] = ls[k].slice(e + 1);
  }
  return out;
}

const EXPR = /\$\{\{\s*(.*?)\s*\}\}/g;
function expressionValue(expr, ctx) {
  if (expr === 'github.base_ref') return ctx.baseBranch;
  if (expr === 'github.event.pull_request.title') return ctx.title;
  if (expr === 'github.event.pull_request.body') return ctx.body;
  const m = /^steps\.([\w-]+)\.outputs\.([\w-]+)$/.exec(expr);
  if (m) return ctx.outputs[m[1]]?.[m[2]] ?? '';
  throw new Unsupported(`unsupported expression \${{ ${expr} }}`);
}
const substitute = (text, ctx) => String(text ?? '').replace(EXPR, (_, expr) => expressionValue(expr, ctx));

/** The branch name `${{ github.base_ref }}` stands for: `origin/main` → `main`; a local branch → itself; else `main`. */
function baseBranchOf(repo, base) {
  const name = base.replace(/^refs\/(?:heads|remotes)\//, '');
  if (git(repo, ['rev-parse', '--verify', '-q', `refs/remotes/${name}`]) && name.includes('/')) return name.slice(name.indexOf('/') + 1);
  if (git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${name}`])) return name;
  return 'main';
}

/** The open PR's body for `branch` through gh (as the push guard finds its title); '' when there is none. */
function openPrBody(repo, branch) {
  // The configured URL, not `remote get-url` (that applies url.*.insteadOf rewrites, e.g. a sandbox git proxy).
  const url = git(repo, ['config', '--get', 'remote.origin.url']) || git(repo, ['remote', 'get-url', 'origin']) || '';
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m || !branch) return '';
  const r = run(process.env.PREFLIGHT_GH || 'gh', ['api', `repos/${m[1]}/${m[2]}/pulls?head=${m[1]}:${branch}&state=open`, '--jq', '.[0].body // ""']);
  return r.status === 0 ? r.output : '';
}

/** VALIDATOR-CHECK: { applies, status, output }. Runs the workflow's own step scripts; re-implements none. */
function validatorCheck({ repo, base, head, mergeBase, branch, title, baseRef, bodyFile, tmp }) {
  const res = (applies, status, output) => ({ applies, status, output });
  const raw = spawnSync('git', ['-C', repo, 'show', `${head}:${VALIDATOR_WORKFLOW}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (raw.status !== 0) return res(false, 'skip', `no ${VALIDATOR_WORKFLOW} at --head`);
  let steps;
  let patterns;
  try {
    const doc = parseYaml(raw.stdout);
    const job = doc?.jobs?.[VALIDATOR_JOB];
    if (!job || !Array.isArray(job.steps)) throw new Error(`no job ${VALIDATOR_JOB} with a steps: list`);
    if (doc.env || job.env || doc.defaults || job.defaults) throw new Unsupported('workflow/job env or defaults are not supported');
    const pr = doc.on?.pull_request;
    if (pr?.['paths-ignore']) throw new Unsupported('on.pull_request.paths-ignore is not supported');
    patterns = pr && pr.paths != null ? [].concat(pr.paths).map(globToRegExp) : null;
    steps = job.steps.map((st, n) => {
      if (!st || typeof st !== 'object' || Array.isArray(st)) throw new Error(`step ${n + 1} is not a map`);
      const bad = Object.keys(st).filter((k) => !STEP_KEYS.has(k));
      if (st.run != null && bad.length) throw new Unsupported(`step "${st.name ?? n + 1}": unsupported key(s) ${bad.join(', ')}`);
      if (st.env != null && (typeof st.env !== 'object' || Array.isArray(st.env))) throw new Error(`step "${st.name ?? n + 1}": env is not a map`);
      const shell = st.shell == null ? '' : String(st.shell);
      if (st.run != null && !SHELLS[shell]) throw new Unsupported(`step "${st.name ?? n + 1}": unsupported shell ${shell}`);
      return { name: String(st.name ?? `step ${n + 1}`), id: st.id, env: st.env || {}, run: st.run, shell: SHELLS[shell] };
    });
  } catch (e) {
    return res(false, 'fail', e instanceof Unsupported ? e.message : `cannot parse ${VALIDATOR_WORKFLOW} at --head: ${e.message}`);
  }
  const changed = git(repo, ['diff', '--name-only', `${mergeBase || base}`, head]);
  if (changed === null) return res(false, 'fail', `cannot list the changed files ${base.slice(0, 12)}...${head.slice(0, 12)}`);
  const files = changed.split(/\r?\n/).filter(Boolean);
  if (patterns && !files.some((f) => patterns.some((re) => re.test(f)))) return res(false, 'skip', "no changed file is in VALIDATOR-CHECK's paths: not in VALIDATOR-CHECK's paths");

  let body;
  if (bodyFile) {
    try { body = readFileSync(bodyFile, 'utf8'); } catch (e) { return res(true, 'fail', `cannot read --body-file ${bodyFile}: ${e.message}`); }
  } else body = openPrBody(repo, branch);
  if (!body) {
    return res(true, 'fail', 'no --body-file: VALIDATOR-CHECK reads the declarations from the PR body; on a first push pass '
      + 'PR_BODY_FILE=<file> (see docs/kiro-web-parity/README.md)');
  }
  const ctx = { baseBranch: baseBranchOf(repo, baseRef), title, body, outputs: {} };
  const runnable = steps.filter((st) => st.run != null && !/^Build Gate\b/.test(st.name));
  // Every expression is checked before any step runs: an unsupported one never leaves a half-run check behind.
  for (const st of runnable) {
    for (const text of [st.run, ...Object.values(st.env)]) {
      for (const [, expr] of String(text ?? '').matchAll(EXPR)) {
        try { expressionValue(expr, ctx); } catch (e) { return res(true, 'fail', `step "${st.name}": ${e.message}`); }
      }
    }
  }
  const dir = path.join(tmp, 'validator-check');
  mkdirSync(dir, { recursive: true });
  const log = [];
  for (const [n, st] of runnable.entries()) {
    const script = path.join(dir, `step-${n + 1}.sh`);
    const output = path.join(dir, `output-${n + 1}`);
    writeFileSync(script, substitute(st.run, ctx).replace(/(?<![\w.-])\/tmp\//g, `${dir}/`));
    writeFileSync(output, '');
    const env = Object.fromEntries(Object.entries(st.env).map(([k, v]) => [k, substitute(v, ctx)]));
    const r = spawnSync('bash', [...st.shell, script],
      { cwd: repo, env: childEnv({ ...env, GITHUB_OUTPUT: output }), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600000 });
    const out = `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`.trim();
    if (r.status !== 0) {
      log.push(`step "${st.name}" failed (exit ${r.status ?? r.signal ?? 'none'}):`, out || '(no output)');
      return res(true, 'fail', log.join('\n'));
    }
    if (st.id) ctx.outputs[st.id] = readOutputs(output);
    log.push(`ok   ${st.name}${out ? `\n${lastLines(out, 20).replace(/^/gm, '     ')}` : ''}`);
  }
  log.push('not run: Build Gate (see "Not run by preflight")');
  return res(true, 'pass', log.join('\n'));
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
  return report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    console.error(`preflight.mjs: ${e.message}`);
    process.exitCode = e instanceof Usage ? 2 : 1;
  }
}
