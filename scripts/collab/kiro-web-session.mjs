#!/usr/bin/env node
/**
 * Kiro Web session kit (plan kiro-web-parity, lane session-kit; plan kiro-web-reliability, lane session-reliability).
 *
 *   node vitana-platform/scripts/collab/kiro-web-session.mjs setup [--no-codeintel] [--no-install] [--workspace <dir>]
 *     one command, all in the foreground: rules (kiro-web-steering.mjs), Kiro hooks, git hooks, reviewer agent copy,
 *     dependencies and code intelligence (~8 min on a fresh sandbox, seconds afterwards). `--no-codeintel` skips only
 *     the venv and index build; `--no-install` skips dependencies and code intelligence. (`--wait` is accepted and
 *     ignored: there is no background mode — Kiro Web stops every process a tool call started when the call returns.)
 *   node vitana-platform/scripts/collab/kiro-web-session.mjs status [--json] [--check] [--workspace <dir>]
 *   node vitana-platform/scripts/collab/kiro-web-session.mjs refresh      (UserPromptSubmit hook: keeps steering + hooks current)
 *   node vitana-platform/scripts/collab/kiro-web-session.mjs guard        (PreToolUse hook on execute_bash; stdin = hook JSON)
 *     a lane push before its PR exists names the PR title (and, when VALIDATOR-CHECK runs on it, a PR body file) in the
 *     same bash command, as a prefix (PR_TITLE='…' PR_BODY_FILE=<file> git push …, single or double quotes) or an
 *     earlier `export PR_TITLE='…' &&`; the hook process cannot see the shell's environment. The git pre-push hook
 *     does see them (they are environment variables of the `git push` process).
 *   node vitana-platform/scripts/collab/kiro-web-session.mjs git-pre-commit              (git pre-commit hook)
 *   node vitana-platform/scripts/collab/kiro-web-session.mjs git-pre-push <remote> <url> (git pre-push hook; stdin = refs)
 *   node vitana-platform/scripts/collab/kiro-web-session.mjs pr-body --vtid <V> --scope <globs> --acceptance <path>
 *     --payload <text> [--profile gateway_backend|command_hub_frontend] [--oasis no|yes]
 *   node vitana-platform/scripts/collab/kiro-web-session.mjs wait --repo <owner/repo> --sha <sha> [--timeout 1800] [--interval 120]
 *
 * What Kiro Web does (observed 2026-10-26/27, evidence docs/validation/VTID-05340/probes.md and plan
 * kiro-web-reliability §2): it runs command hooks from `<workspace>/.kiro/hooks/*.json` (not the repos' own
 * `.kiro/hooks`), only the FIRST hook entry of each file; a PreToolUse exit 2 blocks the tool; PostToolUse output never
 * reaches the agent; a process started inside a tool call does not outlive it. `~/.local` is read-only, `~/.cache` is not.
 *
 * So: `setup` writes one Kiro hook per file (guard + refresh), copies the reviewer agent to `<workspace>/.kiro/agents/`,
 * installs a git `pre-commit` and `pre-push` hook in each main checkout's `<git common dir>/hooks` (marked; an
 * unmarked hook is never overwritten), and installs dependencies and code intelligence. The git hooks are the
 * authoritative checks, bound to git itself: `pre-commit` typechecks the gateway after `git add` (so an edit that lands
 * while the agent's command runs is still checked), `pre-push` runs the existing preflight on the commit actually
 * pushed. The PreToolUse guard stays a best-effort early block before a push command runs. Every check only adds to CI;
 * none skips or loosens one; each blocks only on a real failure and never on its own internal error. CI stays the gate.
 *
 * Nothing tracked is written inside a repository. Env overrides (tests): VITANA_KIRO_WEB_CACHE (default
 * ~/.cache/vitana-kiro-web), VITANA_KIRO_WEB_PLATFORM (the vitana-platform checkout; default the one holding this
 * script), CODEINTEL_STATE_DIR, VITANA_KIRO_WEB_TSC (a shell command run instead of `npx tsc` by git-pre-commit).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = 'vitana-platform/scripts/collab/kiro-web-session.mjs';
const SELF = fileURLToPath(import.meta.url);
const PLATFORM_ROOT = process.env.VITANA_KIRO_WEB_PLATFORM || path.resolve(path.dirname(SELF), '..', '..');
const CACHE_DIR = process.env.VITANA_KIRO_WEB_CACHE || path.join(os.homedir(), '.cache', 'vitana-kiro-web');
const CODEINTEL_DIR = process.env.CODEINTEL_STATE_DIR || path.join(os.homedir(), '.cache', 'vitana-codeintel');
// Every agent branch (`kiro/**`, `claude/**`): lane and plan branches, and any other form a PR is opened from.
const LANE_BRANCH = /^(kiro|claude)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);
const REPO_SLUGS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1'];

/** Default process runner: {status, output}; status null when the process could not start. */
export function runProc(cmd, args, { cwd, timeoutMs } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  return { status: r.error ? null : r.status, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

const keyOf = (p) => path.resolve(p).replace(/[^A-Za-z0-9._-]/g, '_');
const lastLines = (text, n) => String(text || '').split('\n').slice(-n).join('\n');
/** Preflight output without the queue table / <details> noise, so the failure lines fit the agent's view. */
export function condensePreflight(text, max = 80) {
  const keep = String(text || '').split('\n').filter((l) => !/^\s*\|/.test(l) && !/^\s*<\/?(details|summary)/.test(l) && l.trim() !== '');
  const first = keep.findIndex((l) => /^FAIL\b/.test(l));
  const head = keep.filter((l) => /^(preflight |  base )/.test(l));
  const body = first >= 0 ? keep.slice(first) : keep.slice(-max);
  return [...head, ...body].slice(0, max).join('\n');
}
/**
 * The one preflight failure the guard does not block on: Collab handoff failing ONLY because PLAN-SPAR's own commit
 * (`Collab-Session: ci-plan-spar`) and the planner both commit on `<slug>/_plan` (queue.mjs counts ci-plan-spar as a
 * second session there; the agent cannot prevent it — CI still shows it red and the §7b governance-artifact rule
 * handles it at merge). Any other FAIL line, or any other problem under Collab handoff, still blocks.
 */
export function onlyPlanSparSessionFalsePositive(text) {
  const lines = String(text || '').split('\n');
  const fails = lines.filter((l) => /^FAIL\b/.test(l));
  if (fails.length !== 1 || !/^FAIL\s+Collab handoff\b/.test(fails[0])) return false;
  const i = lines.indexOf(fails[0]);
  const problems = [];
  for (let j = i + 1; j < lines.length && !/^(PASS|FAIL|WARN|SKIP)\b|^preflight:/.test(lines[j]); j++) {
    const m = /^\s*-\s+(.*)$/.exec(lines[j]);
    if (m) problems.push(m[1].trim());
  }
  return problems.length > 0 && problems.every((pr) => {
    const m = /^lane [a-z0-9][a-z0-9-]*\/_plan: commits from 2 sessions \(([^)]*)\) — one session per lane$/.exec(pr);
    if (!m) return false;
    const ss = m[1].split(',').map((x) => x.trim());
    return ss.includes('ci-plan-spar') && ss.filter((x) => x !== 'ci-plan-spar').every((x) => /^kiro-/.test(x));
  });
}
const sameBytes = (a, b) => existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));

// ------------------------------------------------------------------------------------------------ setup: hooks, agent
/** The generated hooks, one hook entry per file (Kiro Web runs only the first entry of a file). */
export function hookDefs({ platformRoot = PLATFORM_ROOT } = {}) {
  const cli = `node "${path.join(platformRoot, 'scripts', 'collab', 'kiro-web-session.mjs')}"`;
  const file = (name, hook) => ({ file: name, json: { version: 'v1', generatedBy: MARKER, hooks: [hook] } });
  return [
    file('vitana-web-guard.json', { name: 'vitana-web-guard',
      description: 'Preflight before pushing any kiro/** or claude/** branch (a push after a commit in the same command is checked by the git pre-push hook on the real commit; the git pre-commit hook typechecks the gateway). Blocks only on a real failure.',
      trigger: 'PreToolUse', matcher: '^execute_bash$', action: { type: 'command', command: `${cli} guard`, timeout: 600 } }),
    file('vitana-web-refresh.json', { name: 'vitana-web-refresh',
      description: 'Keeps the workspace steering, Kiro hooks and git hooks current when main moves; prints one line only when it fixed something or the session is not ready.',
      trigger: 'UserPromptSubmit', action: { type: 'command', command: `${cli} refresh`, timeout: 120 } }),
  ];
}

const isMarked = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')).generatedBy === MARKER; } catch { return false; }
};

/** Writes the hooks under <workspace>/.kiro/hooks/, removes stale marked files, leaves unmarked files alone. */
export function writeHooks({ workspace, platformRoot = PLATFORM_ROOT }) {
  const dir = path.join(workspace, '.kiro', 'hooks');
  mkdirSync(dir, { recursive: true });
  const defs = hookDefs({ platformRoot });
  const out = { written: [], unchanged: [], removed: [] };
  for (const d of defs) {
    const p = path.join(dir, d.file);
    const text = `${JSON.stringify(d.json, null, 2)}\n`;
    if (existsSync(p) && readFileSync(p, 'utf8') === text) { out.unchanged.push(d.file); continue; }
    writeFileSync(p, text);
    out.written.push(d.file);
  }
  const keep = new Set(defs.map((d) => d.file));
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || keep.has(f)) continue;
    if (isMarked(path.join(dir, f))) { unlinkSync(path.join(dir, f)); out.removed.push(f); }
  }
  return out;
}

/** Copies the reviewer agent to <workspace>/.kiro/agents/ (byte-identical) so the driver's review step can run it. */
export function copyReviewer({ workspace, platformRoot = PLATFORM_ROOT }) {
  const src = path.join(platformRoot, '.kiro', 'agents', 'vitana-lane-reviewer.md');
  const dst = path.join(workspace, '.kiro', 'agents', 'vitana-lane-reviewer.md');
  if (!existsSync(src)) return { changed: false, missing: true };
  if (sameBytes(src, dst)) return { changed: false };
  mkdirSync(path.dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  return { changed: true };
}

/**
 * The workspace = the folder holding the main vitana-platform checkout. From a linked worktree (`.git` is a file) the
 * main checkout is found through `git rev-parse --git-common-dir`, so hooks never land next to a worktree.
 */
export function defaultWorkspace(platformRoot = PLATFORM_ROOT, run = runProc) {
  let main = platformRoot;
  try {
    if (!statSync(path.join(platformRoot, '.git')).isDirectory()) {
      const r = run('git', ['-C', platformRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
      const common = (r.output || '').split('\n')[0].trim();
      if (r.status === 0 && common) main = path.dirname(common);
    }
  } catch { /* no .git: keep platformRoot */ }
  return path.dirname(main);
}

/** Direct children of the workspace that are main checkouts (`.git` directory, not a worktree) of the two Vitana repos. */
export function findRepos(workspace, run = runProc) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(workspace, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(workspace, e.name);
    try { if (!statSync(path.join(dir, '.git')).isDirectory()) continue; } catch { continue; }
    const url = run('git', ['-C', dir, 'remote', 'get-url', 'origin']).output || '';
    const slug = REPO_SLUGS.find((s) => url.replace(/\.git$/, '').endsWith(s));
    if (slug) out.push({ dir, slug, name: e.name });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ setup: git hooks
/** The marker line every generated git hook carries; a hook without it is the user's and is never overwritten. */
export const GIT_HOOK_MARKER = `# generated by ${MARKER}`;
export const GIT_HOOKS = ['pre-commit', 'pre-push'];
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The text of a generated git hook. Only exit 1 (a real failure) blocks; a missing script or a crash never does. */
export function gitHookText(kind, { script = path.join(PLATFORM_ROOT, 'scripts', 'collab', 'kiro-web-session.mjs'), node = process.execPath } = {}) {
  const what = kind === 'pre-commit' ? 'gateway typecheck of the commit, after git add' : 'preflight on the pushed commit of a kiro/** or claude/** branch';
  return ['#!/bin/sh', GIT_HOOK_MARKER, `# ${kind}: ${what} (plan kiro-web-reliability §3.2.2).`,
    '# Exit 1 = a real failure: fix it, then run the same git command again. The hook\'s own errors never block.',
    `NODE=${shq(node)}; [ -x "$NODE" ] || NODE=node`, `SCRIPT=${shq(script)}`, '[ -f "$SCRIPT" ] || exit 0',
    `"$NODE" "$SCRIPT" git-${kind} "$@"`, 'rc=$?', '[ "$rc" -eq 1 ] && exit 1', 'exit 0', ''].join('\n');
}

function commonDir(run, dir) {
  const r = run('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  const s = (r.output || '').split('\n')[0].trim();
  return r.status === 0 && s ? s : null;
}
const hasMarker = (text) => String(text).split('\n').includes(GIT_HOOK_MARKER);

/** Installs pre-commit + pre-push in each checkout's <git common dir>/hooks (shared by its linked worktrees). */
export function installGitHooks({ repos, run = runProc, script, node } = {}) {
  return (repos || []).map((r) => {
    const out = { dir: r.dir, hooksDir: null, written: [], unchanged: [], skipped: [] };
    const cd = commonDir(run, r.dir);
    if (!cd) return { ...out, error: 'not a git checkout' };
    out.hooksDir = path.join(cd, 'hooks');
    mkdirSync(out.hooksDir, { recursive: true });
    for (const kind of GIT_HOOKS) {
      const p = path.join(out.hooksDir, kind);
      const text = gitHookText(kind, { script, node });
      if (existsSync(p)) {
        const cur = readFileSync(p, 'utf8');
        if (!hasMarker(cur)) { out.skipped.push(kind); continue; }
        if (cur === text && statSync(p).mode & 0o111) { out.unchanged.push(kind); continue; }
      }
      writeFileSync(p, text);
      chmodSync(p, 0o755);
      out.written.push(kind);
    }
    return out;
  });
}

/** Both git hooks present, marked and executable in every main checkout. */
export function gitHooksState({ repos, run = runProc }) {
  const problems = [];
  const dirs = [];
  if (!repos || !repos.length) problems.push('no main checkout found');
  for (const r of repos || []) {
    const name = r.name || r.dir;
    const cd = commonDir(run, r.dir);
    if (!cd) { problems.push(`${name}: not a git checkout`); continue; }
    dirs.push(path.join(cd, 'hooks'));
    for (const kind of GIT_HOOKS) {
      const p = path.join(cd, 'hooks', kind);
      if (!existsSync(p)) problems.push(`${name}: ${kind} missing`);
      else if (!hasMarker(readFileSync(p, 'utf8'))) problems.push(`${name}: ${kind} unmarked (not generated by setup; left alone)`);
      else if (!(statSync(p).mode & 0o111)) problems.push(`${name}: ${kind} not executable`);
    }
  }
  return { ok: problems.length === 0, problems, dirs };
}

// ------------------------------------------------------------------------------------------------ setup: stamps, installs
const isoNow = () => new Date().toISOString();
export function writeStamp(cacheDir, name) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(path.join(cacheDir, name), `${isoNow()}\n`); }
const readStamp = (cacheDir, name) => { try { return readFileSync(path.join(cacheDir, name), 'utf8').trim() || null; } catch { return null; } };

function depDirs(repos) {
  const out = [];
  for (const r of repos || []) {
    if (r.slug === 'exafyltd/vitana-platform') out.push(path.join(r.dir, 'services', 'gateway'));
    if (r.slug === 'exafyltd/vitana-v1') out.push(r.dir);
  }
  return out;
}

/** The steps of a setup, each with its stamp: steering, hooks, deps-<checkout> per lockfile, codeintel (done|skipped). */
export function expectedSteps(repos, exists = existsSync) {
  return ['steering', 'hooks', ...depDirs(repos).filter((d) => exists(path.join(d, 'package-lock.json'))).map((d) => `deps-${keyOf(d)}`), 'codeintel'];
}

/** A stamp counts only when it is not older than the last setup.start. */
export function stampStatus({ cacheDir, repos }) {
  const steps = expectedSteps(repos);
  const start = readStamp(cacheDir, 'setup.start');
  if (!start) return { ok: false, start: null, missing: steps, detail: `setup never ran (no ${path.join(cacheDir, 'setup.start')})` };
  const fresh = (s) => (s === 'codeintel' ? ['codeintel.done', 'codeintel.skipped'] : [`${s}.done`]).some((n) => { const t = readStamp(cacheDir, n); return !!t && t >= start; });
  const missing = steps.filter((s) => !fresh(s));
  return { ok: missing.length === 0, start, missing, detail: missing.length
    ? `setup.start ${start}; missing or older than it: ${missing.join(', ')} (re-run setup; log ${path.join(cacheDir, 'setup.log')})`
    : `every step of the setup at ${start} finished: ${steps.join(', ')}` };
}

/** The install script setup runs in the foreground: deps when missing/changed, then (unless codeintel=false) venv + indexes. */
export function installScript({ repos, platformRoot = PLATFORM_ROOT, cacheDir = CACHE_DIR, codeintelDir = CODEINTEL_DIR, codeintel = true }) {
  const q = shq;
  const stamp = (name) => `date -u +%Y-%m-%dT%H:%M:%S.%3NZ > ${q(path.join(cacheDir, name))}`;
  const out = ['set -u', `mkdir -p ${q(cacheDir)}`, 'echo "installs start $(date -u +%FT%TZ)"'];
  for (const d of depDirs(repos)) {
    const sha = path.join(cacheDir, `deps-${keyOf(d)}.sha`);
    const done = `deps-${keyOf(d)}.done`;
    out.push(`if [ -f ${q(path.join(d, 'package-lock.json'))} ]; then`,
      `  sum=$(sha256sum ${q(path.join(d, 'package-lock.json'))} | cut -d' ' -f1)`,
      `  if [ ! -d ${q(path.join(d, 'node_modules'))} ] || [ "$sum" != "$(cat ${q(sha)} 2>/dev/null)" ]; then`,
      `    s=$(date +%s); if (cd ${q(d)} && npm ci --no-audit --no-fund --loglevel=error); then echo "$sum" > ${q(sha)}; ${stamp(done)}; echo "deps ${d} ok secs=$(( $(date +%s)-s ))"; else echo "deps ${d} FAILED secs=$(( $(date +%s)-s ))"; fi`,
      `  else ${stamp(done)}; echo "deps ${d} up to date"; fi`, 'fi');
  }
  if (!codeintel) {
    out.push(stamp('codeintel.skipped'), 'echo "codeintel skipped (--no-codeintel)"');
  } else {
    const venv = path.join(codeintelDir, 'venv');
    out.push(`export UV_CACHE_DIR=${q(path.join(os.homedir(), '.cache', 'uv'))} REPOWISE_TELEMETRY_DISABLED=1`,
      `if [ ! -x ${q(path.join(venv, 'bin', 'repowise'))} ] || [ ! -x ${q(path.join(venv, 'bin', 'graphify'))} ]; then`,
      `  s=$(date +%s); { command -v uv >/dev/null && uv venv -q --allow-existing ${q(venv)} && uv pip install -q -p ${q(path.join(venv, 'bin', 'python'))} repowise 'graphifyy[bedrock]'; } \\`,
      `    || { python3 -m venv ${q(venv)} && ${q(path.join(venv, 'bin', 'pip'))} install -q repowise 'graphifyy[bedrock]'; }; echo "codeintel venv rc=$? secs=$(( $(date +%s)-s ))"`,
      'fi',
      `export PATH=${q(path.join(venv, 'bin'))}:$PATH`);
    const setupSh = path.join(platformRoot, 'scripts', 'codeintel', 'session-setup.sh');
    if (repos.length) {
      out.push(`s=$(date +%s); bash ${q(setupSh)} --foreground ${repos.map((r) => q(r.dir)).join(' ')}; rc=$?; echo "codeintel index rc=$rc secs=$(( $(date +%s)-s ))"`,
        `[ "$rc" -eq 0 ] && ${stamp('codeintel.done')}`);
    }
  }
  out.push('echo "installs done $(date -u +%FT%TZ)"', 'exit 0');
  return out.join('\n');
}

// ------------------------------------------------------------------------------------------------ status
export function statusReport({ workspace, platformRoot = PLATFORM_ROOT, cacheDir = CACHE_DIR, codeintelDir = CODEINTEL_DIR,
  env = process.env, run = runProc, repos = null, offline = false }) {
  const items = [];
  const add = (name, ok, required, detail) => items.push({ name, ok: !!ok, required, detail });
  const steerDir = path.join(workspace, '.kiro', 'steering');
  const steer = existsSync(steerDir) ? readdirSync(steerDir).filter((f) => f.endsWith('.md')) : [];
  const gen = path.join(platformRoot, 'scripts', 'collab', 'kiro-web-steering.mjs');
  const chk = existsSync(gen) ? run(process.execPath, [gen, '--check', '--workspace', workspace], { timeoutMs: 60000 }) : null;
  const steerOk = chk ? chk.status === 0 : steer.length > 0;
  add('workspace-steering', steerOk, true, steerOk
    ? `${steer.length} file(s) in ${steerDir}${chk ? ' (kiro-web-steering --check ok)' : ''}`
    : `${chk ? `kiro-web-steering --check failed: ${lastLines(chk.output, 3)}` : 'none'} — run node vitana-platform/scripts/collab/kiro-web-session.mjs setup (the repos' .kiro/steering is not auto-loaded in Kiro Web)`);
  const hookDir = path.join(workspace, '.kiro', 'hooks');
  const defs = hookDefs({ platformRoot });
  const missing = defs.filter((d) => {
    const p = path.join(hookDir, d.file);
    return !existsSync(p) || readFileSync(p, 'utf8') !== `${JSON.stringify(d.json, null, 2)}\n`;
  }).map((d) => d.file);
  add('hooks', missing.length === 0, true, missing.length ? `missing or stale: ${missing.join(', ')} (run setup)`
    : `${defs.map((d) => d.json.hooks[0].name).join(' + ')} in ${hookDir}`);
  const rs = repos || findRepos(workspace, run);
  const gs = gitHooksState({ repos: rs, run });
  add('git-hooks', gs.ok, true, gs.ok ? `${GIT_HOOKS.join(' + ')} (marked, executable) in ${gs.dirs.join(', ')}` : `${gs.problems.join('; ')} (run setup)`);
  const rsrc = path.join(platformRoot, '.kiro', 'agents', 'vitana-lane-reviewer.md');
  const rdst = path.join(workspace, '.kiro', 'agents', 'vitana-lane-reviewer.md');
  add('reviewer-agent', sameBytes(rsrc, rdst), true, sameBytes(rsrc, rdst) ? rdst : 'not copied to the workspace (run setup)');
  const gw = path.join(platformRoot, 'services', 'gateway', 'node_modules');
  add('gateway-deps', existsSync(gw), true, existsSync(gw) ? gw : 'services/gateway/node_modules missing (setup installs it)');
  const v1 = rs.find((r) => r.slug === 'exafyltd/vitana-v1');
  if (v1) add('v1-deps', existsSync(path.join(v1.dir, 'node_modules')), false, existsSync(path.join(v1.dir, 'node_modules')) ? 'present' : 'missing (setup installs it)');
  const ci = [];
  for (const r of rs.length ? rs : [{ name: path.basename(platformRoot) }]) {
    let st = null;
    try { st = JSON.parse(readFileSync(path.join(codeintelDir, `${r.name}.json`), 'utf8')); } catch { /* never run */ }
    ci.push(`${r.name}: ${st ? `${st.state}${st.repowise ? ` (repowise ${st.repowise.pages} pages, graphify ${st.graphify?.ok})` : ''}` : 'never-run'}`);
  }
  const venvBin = path.join(codeintelDir, 'venv', 'bin');
  add('codeintel', ci.every((c) => /: ready/.test(c)), false, `${ci.join('; ')}; CLI: ${venvBin}/repowise, ${venvBin}/graphify (no MCP in Kiro Web)`);
  if (!offline) {
    const gh = run('gh', ['api', 'user', '--jq', '.login']);
    add('github', gh.status === 0, true, gh.status === 0 ? `REST as ${gh.output}; GraphQL and gh pr/issue are not supported by the Kiro Web proxy` : `gh api user failed: ${lastLines(gh.output, 2)}`);
  }
  const tok = ['DEV_MEMORY_PACK_TOKEN', 'GATEWAY_SERVICE_TOKEN'].map((k) => `${k}=${env[k] ? 'set' : 'unset'}`);
  add('tokens', true, false, tok.join(', '));
  const ss = stampStatus({ cacheDir, repos: rs });
  add('installs', ss.ok, false, ss.detail);
  return { ok: items.every((i) => i.ok || !i.required), items };
}

function renderStatus(rep) {
  const rows = rep.items.map((i) => `${i.ok ? 'OK  ' : i.required ? 'FAIL' : 'WARN'}  ${i.name.padEnd(18)} ${i.detail}`);
  return `kiro-web-session status: ${rep.ok ? 'ready' : 'NOT ready'}\n${rows.join('\n')}`;
}

// ------------------------------------------------------------------------------------------------ guard
/** Shell-ish split: segments on unquoted && || ; | and newlines, words with quotes removed. */
function segments(command) {
  const segs = [[]];
  let word = null;
  let q = null;
  const push = () => { if (word !== null) segs[segs.length - 1].push(word); word = null; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; word = word ?? ''; continue; }
    if (c === '\\' && i + 1 < command.length) { word = (word ?? '') + command[++i]; continue; }
    if (c === ' ' || c === '\t') { push(); continue; }
    if (c === '\n' || c === ';' || c === '|' || (c === '&' && command[i + 1] === '&')) {
      push();
      if ((c === '&' || c === '|') && command[i + 1] === c) i++;
      segs.push([]);
      continue;
    }
    word = (word ?? '') + c;
  }
  push();
  return segs.filter((s) => s.length);
}

const stripHeads = (r) => (r || '').replace(/^refs\/heads\//, '');

/** Every `git commit` / `git push` in a bash command, in order, with the directory it runs in. */
export function parseCommand(command, cwd) {
  const out = [];
  let dir = cwd;
  // `export PR_TITLE=…` / `export PR_BODY_FILE=…` in an earlier segment of the same command
  const exported = { PR_TITLE: null, PR_BODY_FILE: null };
  const val = (w, k) => (w.startsWith(`${k}=`) ? w.slice(k.length + 1) || null : undefined);
  for (let words of segments(String(command || ''))) {
    const env = { ...exported };
    if (words[0] === 'export') {
      for (const w of words.slice(1)) for (const k of Object.keys(exported)) { const v = val(w, k); if (v !== undefined) exported[k] = v; }
      continue;
    }
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      for (const k of Object.keys(env)) { const v = val(words[0], k); if (v !== undefined) env[k] = v; }
      words = words.slice(1);
    }
    const title = env.PR_TITLE;
    const bodyFile = env.PR_BODY_FILE;
    if (!words.length) continue;
    if (words[0] === 'cd' && words[1]) { dir = path.resolve(dir, words[1]); continue; }
    if (words[0] !== 'git') continue;
    let i = 1;
    let gdir = dir;
    while (i < words.length && words[i].startsWith('-')) {
      if (words[i] === '-C') { gdir = path.resolve(gdir, words[i + 1] || '.'); i += 2; } else if (words[i] === '-c') i += 2; else i++;
    }
    const sub = words[i];
    if (sub === 'commit') { out.push({ op: 'commit', dir: gdir }); continue; }
    if (sub !== 'push') continue;
    let del = false;
    const pos = [];
    for (let j = i + 1; j < words.length; j++) {
      const w = words[j];
      if (w === '--delete' || w === '-d') { del = true; continue; }
      if (w === '-o' || w === '--push-option' || w === '--repo' || w === '--receive-pack' || w === '--exec') { j++; continue; }
      if (w.startsWith('-')) continue;
      pos.push(w);
    }
    const [remote = null, ref] = pos;
    if (!ref) { out.push({ op: 'push', dir: gdir, remote, src: 'HEAD', branch: null, del, title, bodyFile }); continue; }
    const spec = ref.replace(/^\+/, '');
    if (spec.startsWith(':')) { out.push({ op: 'push', dir: gdir, remote, src: null, branch: stripHeads(spec.slice(1)), del: true, title, bodyFile }); continue; }
    const k = spec.indexOf(':');
    if (k > 0) out.push({ op: 'push', dir: gdir, remote, src: spec.slice(0, k), branch: stripHeads(spec.slice(k + 1)), del, title, bodyFile });
    else out.push({ op: 'push', dir: gdir, remote, src: spec, branch: stripHeads(spec), del, title, bodyFile });
  }
  return out;
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const block = (stderr) => ({ code: 2, stdout: '', stderr: `${stderr}\n(also in ~/.cache/vitana-kiro-web/last-block.txt)` });

function toplevel(run, dir) {
  const r = run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  return r.status === 0 && r.output ? r.output.split('\n')[0].trim() : null;
}
function revParse(run, dir, ref) {
  const r = run('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const s = (r.output || '').split('\n')[0].trim();
  return r.status === 0 && /^[0-9a-f]{40}$/.test(s) ? s : null;
}

const lines = (r) => (r && r.status === 0 ? String(r.output || '').split('\n').map((l) => l.trim()).filter(Boolean) : []);

// ------------------------------------------------------------------------------------------------ git-pre-commit
/**
 * git pre-commit: a staged (or unstaged) change under services/gateway/src → incremental `tsc --noEmit` in that
 * worktree's services/gateway. It runs after `git add`, so an edit that landed while the agent's command ran is checked.
 * tsc reads the working tree, so an unstaged type error also blocks (conservative); the message names those files.
 * Returns {code, stdout, stderr}: 1 blocks the commit, 0 lets it through (also on any internal error).
 */
export function gitPreCommit({ top, run = runProc, cacheDir = CACHE_DIR, exists = existsSync, env = process.env }) {
  try {
    const staged = lines(run('git', ['-C', top, 'diff', '--cached', '--name-only', '--', 'services/gateway/src']));
    const unstaged = lines(run('git', ['-C', top, 'diff', '--name-only', '--', 'services/gateway/src']));
    if (!staged.length && !unstaged.length) return ok();
    const gw = path.join(top, 'services', 'gateway');
    if (!exists(path.join(gw, 'node_modules'))) {
      // A linked worktree (parallel builder) has no node_modules: install them there. Never a symlink to the main
      // checkout's node_modules (tsc then reports false TS2742 portability errors).
      const n = run('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: gw, timeoutMs: 300000 });
      if (n.status !== 0) return ok(`kiro-web-session pre-commit: gateway npm ci failed, typecheck not run (CI still typechecks): ${lastLines(n.output, 3)}`);
    }
    mkdirSync(path.join(cacheDir, 'tsc'), { recursive: true });
    const t = env.VITANA_KIRO_WEB_TSC
      ? run('sh', ['-c', env.VITANA_KIRO_WEB_TSC], { cwd: gw, timeoutMs: 540000 })
      : run('npx', ['tsc', '--noEmit', '--incremental', '--tsBuildInfoFile', path.join(cacheDir, 'tsc', `${keyOf(top)}.tsbuildinfo`)], { cwd: gw, timeoutMs: 540000 });
    if (t.status === 0) return ok('kiro-web-session pre-commit: gateway typecheck passed');
    const errs = String(t.output).split('\n').filter((l) => l.includes('error TS'));
    if (!errs.length) return ok(`kiro-web-session pre-commit: tsc did not run cleanly (status ${t.status}), not blocking: ${lastLines(t.output, 3)}`);
    const un = unstaged.length ? `\nUnstaged changes under services/gateway/src are part of what tsc read (stage, fix or revert them): ${unstaged.join(', ')}` : '';
    return { code: 1, stdout: '', stderr: 'kiro-web-session pre-commit: gateway typecheck failed — the deploy would fail. Fix, then commit again '
      + `(${errs.length} error(s), first ${Math.min(10, errs.length)}):\n${errs.slice(0, 10).join('\n')}${un}` };
  } catch (e) {
    return ok(`kiro-web-session pre-commit: internal error (${e && e.message}); not blocking — CI stays the gate`);
  }
}

// ------------------------------------------------------------------------------------------------ push check
/** VALIDATOR-CHECK's `on.pull_request.paths`, read from the workflow text (no YAML dependency). */
export function workflowPaths(text) {
  const out = [];
  const ls = String(text || '').split('\n');
  let pr = -1;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    const ind = l.length - l.trimStart().length;
    const m = /^(\s*)pull_request:\s*$/.exec(l);
    if (m) { pr = m[1].length; continue; }
    if (pr < 0 || !l.trim() || l.trim().startsWith('#')) continue;
    if (ind <= pr) { pr = -1; continue; }
    if (/^\s*paths:\s*$/.test(l)) {
      for (let j = i + 1; j < ls.length; j++) {
        if (!ls[j].trim() || ls[j].trim().startsWith('#')) continue;
        const it = /^\s*-\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(ls[j]);
        if (!it) break;
        out.push(it[1]);
      }
      return out;
    }
  }
  return out;
}

/** Glob match as GitHub path filters use it: `**` crosses `/`, `*` does not. */
export function globMatch(glob, file) {
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const re = glob.split('**').map((part) => part.split('*').map(esc).join('[^/]*')).join('.*');
  return new RegExp(`^${re}$`).test(file);
}

function validatorApplies(top, sha, run) {
  const wf = path.join(top, '.github', 'workflows', 'VALIDATOR-CHECK.yml');
  if (!existsSync(wf)) return { applies: false };
  const globs = workflowPaths(readFileSync(wf, 'utf8'));
  if (!globs.length) return { applies: false };
  const d = run('git', ['-C', top, 'diff', '--name-only', `origin/main...${sha}`]);
  if (d.status !== 0) return { applies: false };
  const hit = lines(d).find((f) => globs.some((gl) => globMatch(gl, f)));
  return { applies: !!hit, file: hit };
}

/** The --body-file interface (plan §3.3): passed only to a preflight whose source knows the option. */
const preflightSupportsBodyFile = (platformRoot) => {
  try { return readFileSync(path.join(platformRoot, 'scripts', 'collab', 'preflight.mjs'), 'utf8').includes("'body-file'"); } catch { return false; }
};

function checkPush(a, { run, cacheDir, platformRoot }) {
  if (a.del) return ok();
  let branch = a.branch;
  if (!branch) {
    const r = run('git', ['-C', a.dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
    branch = r.status === 0 ? r.output.trim() : null;
  }
  if (!branch || !LANE_BRANCH.test(branch)) return ok();
  const top = toplevel(run, a.dir);
  if (!top) return ok();
  const head = revParse(run, top, 'HEAD');
  if (!head) return ok();
  let sha = head;
  let note = '';
  if (a.src && a.src !== 'HEAD') {
    if (/[$`]/.test(a.src)) note = ` (source "${a.src}" is a shell expansion; checked the checked-out HEAD)`;
    else sha = revParse(run, top, a.src) || head;
  }
  if (sha !== head) {
    return block(`kiro-web-session guard: the pushed commit ${sha.slice(0, 12)} is not the checked-out HEAD ${head.slice(0, 12)} of ${top}. `
      + 'Preflight judges the checked-out tree; check out the commit you push (or push HEAD), then push again.');
  }
  const okFile = path.join(cacheDir, 'preflight-ok', `${keyOf(top)}-${sha}`);
  if (existsSync(okFile)) return ok(`kiro-web-session guard: preflight already passed on ${sha.slice(0, 12)}${note}`);
  run('git', ['-C', top, 'fetch', '-q', 'origin', 'main'], { timeoutMs: 60000 });
  const url = run('git', ['-C', top, 'remote', 'get-url', 'origin']).output || '';
  const slug = REPO_SLUGS.find((s) => url.replace(/\.git$/, '').endsWith(s));
  const prQuery = slug ? `repos/${slug}/pulls?head=${slug.split('/')[0]}:${branch}&state=open` : null;
  const args = [path.join(platformRoot, 'scripts', 'collab', 'preflight.mjs'), '--repo', top, '--base', 'origin/main', '--head', sha, '--branch', branch];
  let title = a.title;
  if (!title && prQuery) {
    const t = run('gh', ['api', prQuery, '--jq', '.[0].title // ""'], { timeoutMs: 30000 });
    title = t.status === 0 ? t.output.trim() : '';
  }
  if (!title) {
    return block(`kiro-web-session guard: no open PR for ${branch}, so the preflight has no PR title (PR-GATE reads the VTIDs from it). `
      + `Push with the title the PR will get: PR_TITLE='VTID-xxxxx (<slug>/<lane>): …' git push … (a plan branch: PR_TITLE='plan(<slug>): …').`);
  }
  args.push('--title', title);
  // PR body (VALIDATOR-CHECK reads the five declarations from it): PR_BODY_FILE, else the open PR's body.
  const supports = preflightSupportsBodyFile(platformRoot);
  let bodyPath = null;
  if (a.bodyFile) {
    const p = path.resolve(a.dir, a.bodyFile);
    if (!existsSync(p)) return block(`kiro-web-session guard: PR_BODY_FILE=${a.bodyFile} does not exist (${p}). Write the PR body there first (kiro-web-session.mjs pr-body …).`);
    bodyPath = p;
  } else {
    const v = validatorApplies(top, sha, run);
    if (supports || v.applies) {
      let body = '';
      if (prQuery) { const b = run('gh', ['api', prQuery, '--jq', '.[0].body // ""'], { timeoutMs: 30000 }); body = b.status === 0 ? String(b.output || '') : ''; }
      if (body.trim()) {
        bodyPath = path.join(cacheDir, 'pr-body', `${keyOf(top)}-${sha}.md`);
        mkdirSync(path.dirname(bodyPath), { recursive: true });
        writeFileSync(bodyPath, `${body}\n`);
      } else if (v.applies) {
        return block(`kiro-web-session guard: ${branch} has no open PR body, and VALIDATOR-CHECK runs on this push (${v.file}) and reads the five `
          + 'declarations from the PR body. Write the body to a file and push with it: node vitana-platform/scripts/collab/kiro-web-session.mjs pr-body '
          + "--vtid <VTID> --scope '<globs>' --acceptance docs/validation/<VTID>/acceptance.md --payload '<what a merge deploys>' > <file>, then "
          + "PR_TITLE='…' PR_BODY_FILE=<file> git push … (docs/kiro-web-parity/README.md).");
      }
    }
  }
  if (bodyPath && supports) args.push('--body-file', bodyPath);
  const p = run(process.execPath, args, { cwd: top, timeoutMs: 540000 });
  if (p.status !== 0 && onlyPlanSparSessionFalsePositive(p.output)) {
    return ok(`kiro-web-session guard: preflight's only failure is Collab handoff counting PLAN-SPAR's own ci-plan-spar commit as a `
      + `second _plan session (a known governance-artifact false positive; CI shows it red, §7b handles it at merge). Not blocking.`);
  }
  if (p.status === 0) {
    mkdirSync(path.dirname(okFile), { recursive: true });
    writeFileSync(okFile, `${new Date().toISOString()}\n`);
    return ok(`kiro-web-session guard: preflight passed on ${sha.slice(0, 12)}${note}`);
  }
  return block(`kiro-web-session guard: preflight failed on ${sha.slice(0, 12)} (${branch}) — CI would fail the same way. `
    + `Fix every error below, commit, then push again${note}:\n${condensePreflight(p.output)}`);
}

/** The marked pre-push hook is installed for the checkout holding `dir`. */
function prePushInstalled(run, dir) {
  const cd = commonDir(run, dir);
  const p = cd && path.join(cd, 'hooks', 'pre-push');
  return !!p && existsSync(p) && hasMarker(readFileSync(p, 'utf8'));
}

/**
 * PreToolUse on execute_bash (best effort: it reads the command text). Returns {code, stdout, stderr}; code 2 blocks.
 * A push after a commit in the same command is not checked here (the commit does not exist yet): the git pre-push
 * hook checks the real commit. Without that hook in the checkout, such a command is still blocked.
 */
export function guard(raw, { run = runProc, cacheDir = CACHE_DIR, platformRoot = PLATFORM_ROOT } = {}) {
  try {
    let input;
    try { input = JSON.parse(raw); } catch { return ok(); }
    const command = input?.tool_input?.command;
    if (typeof command !== 'string' || !/\bgit\b/.test(command)) return ok();
    const cwd = input.tool_input.cwd || input.cwd || process.cwd();
    const acts = parseCommand(command, cwd);
    const notes = [];
    let committed = false;
    for (const a of acts) {
      if (a.op === 'commit') { committed = true; continue; }
      if (committed && !a.del) {
        let branch = a.branch;
        if (!branch) { const r = run('git', ['-C', a.dir, 'rev-parse', '--abbrev-ref', 'HEAD']); branch = r.status === 0 ? r.output.trim() : null; }
        if (!branch || !LANE_BRANCH.test(branch)) continue;
        if (!prePushInstalled(run, a.dir)) {
          return block(`kiro-web-session guard: \`git commit … && git push …\` needs the git pre-push hook to check the new commit, and the checkout at ${a.dir} `
            + 'has none. Run node vitana-platform/scripts/collab/kiro-web-session.mjs setup (installs it), then run the same command again.');
        }
        notes.push(`kiro-web-session guard: push of ${branch} after a commit in this command — the git pre-push hook checks the new commit`);
        continue;
      }
      const r = checkPush(a, { run, cacheDir, platformRoot });
      if (r.code !== 0) return r;
      if (r.stdout) notes.push(r.stdout);
    }
    return ok(notes.join('\n'));
  } catch (e) {
    return ok(`kiro-web-session guard: internal error (${e && e.message}); not blocking — CI stays the gate`);
  }
}

// ------------------------------------------------------------------------------------------------ git-pre-push
/**
 * git pre-push: stdin lines `<local ref> <local sha> <remote ref> <remote sha>`. Each lane branch (`kiro/**`,
 * `claude/**`) with a non-zero local sha gets the push check on that sha (HEAD must equal it). Title from PR_TITLE or
 * the open PR, body from PR_BODY_FILE or the open PR. Returns {code}: 1 blocks the push; 0 otherwise (also on error).
 */
export function gitPrePush({ top, stdin, run = runProc, cacheDir = CACHE_DIR, platformRoot = PLATFORM_ROOT, env = process.env }) {
  try {
    const notes = [];
    const relabel = (s) => String(s || '').replace(/kiro-web-session guard:/g, 'kiro-web-session pre-push:');
    for (const l of String(stdin || '').split('\n')) {
      const [, lsha, rref] = l.trim().split(/\s+/);
      if (!rref || !/^refs\/heads\//.test(rref) || !lsha || /^0+$/.test(lsha)) continue;
      const branch = stripHeads(rref);
      if (!LANE_BRANCH.test(branch)) continue;
      const r = checkPush({ op: 'push', dir: top, src: lsha, branch, del: false, title: env.PR_TITLE || null, bodyFile: env.PR_BODY_FILE || null },
        { run, cacheDir, platformRoot });
      if (r.code !== 0) return { code: 1, stdout: '', stderr: relabel(r.stderr) };
      if (r.stdout) notes.push(relabel(r.stdout));
    }
    return ok(notes.join('\n'));
  } catch (e) {
    return ok(`kiro-web-session pre-push: internal error (${e && e.message}); not blocking — CI stays the gate`);
  }
}

// ------------------------------------------------------------------------------------------------ pr-body
const PROFILES = ['gateway_backend', 'command_hub_frontend'];
const DECLARATIONS = ['VALIDATION_PROFILE', 'SCOPE_ALLOWLIST', 'ACCEPTANCE', 'MERGE_PAYLOAD_PREVIEW', 'OASIS_IMPACT'];

/** A PR body from .github/pull_request_template.md with the five VALIDATOR-CHECK declarations filled. */
export function prBody({ vtid, scope, acceptance, payload, profile = 'gateway_backend', oasis = 'no', platformRoot = PLATFORM_ROOT }) {
  if (!PROFILES.includes(profile)) throw new Error(`--profile must be one of ${PROFILES.join(', ')} (got ${profile})`);
  if (!['no', 'yes'].includes(oasis)) throw new Error(`--oasis must be no or yes (got ${oasis})`);
  for (const [k, v] of Object.entries({ vtid, scope, payload })) if (!v || !String(v).trim()) throw new Error(`--${k} is required`);
  const values = { VALIDATION_PROFILE: profile, SCOPE_ALLOWLIST: scope, ACCEPTANCE: acceptance || `docs/validation/${vtid}/acceptance.md`,
    MERGE_PAYLOAD_PREVIEW: payload, OASIS_IMPACT: oasis };
  let text = '';
  try { text = readFileSync(path.join(platformRoot, '.github', 'pull_request_template.md'), 'utf8'); } catch { /* template missing: declarations only */ }
  for (const k of DECLARATIONS) {
    const re = new RegExp(`^${k}:.*$`, 'm');
    const line = `${k}: ${String(values[k]).replace(/\n/g, ' ')}`;
    text = re.test(text) ? text.replace(re, () => line) : `${text.replace(/\n*$/, '\n')}${line}\n`;
  }
  return text;
}

// ------------------------------------------------------------------------------------------------ refresh
/**
 * UserPromptSubmit: regenerate stale workspace steering, rewrite stale Kiro hooks / reviewer copy / git hooks, append one
 * line to refresh.log. Returns {fixed, ready, line}; `line` is empty when nothing was fixed and the session is ready.
 * Never throws.
 */
export function refresh({ workspace, platformRoot = PLATFORM_ROOT, cacheDir = CACHE_DIR, run = runProc, script } = {}) {
  let res = { fixed: [], ready: false, line: '' };
  try {
    const fixed = [];
    const gen = path.join(platformRoot, 'scripts', 'collab', 'kiro-web-steering.mjs');
    if (existsSync(gen) && run(process.execPath, [gen, '--check', '--workspace', workspace], { timeoutMs: 60000 }).status !== 0) {
      const w = run(process.execPath, [gen, '--workspace', workspace], { timeoutMs: 120000 });
      fixed.push(w.status === 0 ? 'steering' : 'steering (generator failed)');
    }
    const h = writeHooks({ workspace, platformRoot });
    if (h.written.length || h.removed.length) fixed.push('kiro hooks');
    if (copyReviewer({ workspace, platformRoot }).changed) fixed.push('reviewer agent');
    const repos = findRepos(workspace, run);
    const gitScript = script || path.join(platformRoot, 'scripts', 'collab', 'kiro-web-session.mjs');
    if (installGitHooks({ repos, run, script: gitScript }).some((r) => r.written.length)) fixed.push('git hooks');
    const rep = statusReport({ workspace, platformRoot, cacheDir, run, repos, offline: true });
    const bad = rep.items.filter((i) => i.required && !i.ok).map((i) => i.name);
    const line = fixed.length || bad.length
      ? `kiro-web-session refresh: ${fixed.length ? `fixed ${fixed.join(', ')}` : 'nothing to fix'}${bad.length ? `; NOT ready: ${bad.join(', ')} (run node vitana-platform/scripts/collab/kiro-web-session.mjs setup)` : ''}`
      : '';
    res = { fixed, ready: bad.length === 0, line };
  } catch (e) {
    res = { fixed: [], ready: false, line: `kiro-web-session refresh: internal error (${e && e.message}); run node vitana-platform/scripts/collab/kiro-web-session.mjs status` };
  }
  try {
    mkdirSync(cacheDir, { recursive: true });
    appendFileSync(path.join(cacheDir, 'refresh.log'), `${isoNow()} ${res.line || 'ok (ready, nothing to fix)'}\n`);
  } catch { /* best effort */ }
  return res;
}

// ------------------------------------------------------------------------------------------------ wait
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** Polls a commit's check runs until all completed (0 green, 1 failed + logs) or timeout (3). */
export function waitChecks({ repo, sha, timeout = 1800, interval = 120 },
  { gh = (args) => runProc('gh', args, { timeoutMs: 120000 }), sleep = sleepSync, now = Date.now } = {}) {
  const start = now();
  for (;;) {
    const r = gh(['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`]);
    let runs = [];
    try { runs = JSON.parse(r.output).check_runs || []; } catch { /* transient: poll again */ }
    if (runs.length && runs.every((c) => c.status === 'completed')) {
      const failed = runs.filter((c) => FAILED.has(c.conclusion));
      if (!failed.length) return { code: 0, report: `all ${runs.length} check run(s) green on ${sha.slice(0, 12)}` };
      const parts = [`${failed.length} of ${runs.length} check run(s) failed on ${sha.slice(0, 12)}:`];
      const seen = new Set();
      for (const c of failed) {
        parts.push(`- ${c.name}: ${c.conclusion} ${c.html_url || ''}`);
        const id = /\/actions\/runs\/(\d+)/.exec(c.details_url || '')?.[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const log = gh(['run', 'view', id, '-R', repo, '--log-failed']);
        parts.push(`  log (run ${id}, last 80 lines):\n${lastLines(log.output, 80)}`);
      }
      return { code: 1, report: parts.join('\n') };
    }
    if (now() - start + interval * 1000 > timeout * 1000) {
      const pending = runs.filter((c) => c.status !== 'completed').map((c) => `${c.name} (${c.status})`);
      return { code: 3, report: `timeout after ${timeout}s on ${sha.slice(0, 12)}; pending: ${pending.join(', ') || 'no check run yet'}` };
    }
    sleep(interval * 1000);
  }
}

// ------------------------------------------------------------------------------------------------ CLI
function readStdin() { try { return readFileSync(0, 'utf8'); } catch { return ''; } }
function opt(argv, name, dflt) { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; }
const say = (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);

/** Every block also goes to ~/.cache/vitana-kiro-web/last-block.txt (the main session may show a blocked command as `{}`). */
function report(r, blockCode) {
  if (r.code !== 0) {
    try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(path.join(CACHE_DIR, 'last-block.txt'), `${new Date().toISOString()}\n${r.stderr}\n`); } catch { /* best effort */ }
  }
  if (r.stdout) process.stdout.write(`${r.stdout}\n`);
  if (r.stderr) process.stderr.write(`${r.stderr}\n`);
  return r.code === 0 ? 0 : blockCode;
}

function gitTop() {
  const r = runProc('git', ['rev-parse', '--show-toplevel']);
  return r.status === 0 && r.output ? r.output.split('\n')[0].trim() : process.cwd();
}

function setup(argv, workspace) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const start = isoNow();
  writeFileSync(path.join(CACHE_DIR, 'setup.start'), `${start}\n`);
  say(`kiro-web-session setup ${start} (foreground; log ${path.join(CACHE_DIR, 'setup.log')})`);
  // 1. rules: the workspace-root steering (the repos' .kiro/steering is not auto-loaded in Kiro Web)
  const gen = path.join(PLATFORM_ROOT, 'scripts', 'collab', 'kiro-web-steering.mjs');
  if (existsSync(gen)) {
    const s = runProc(process.execPath, [gen, '--workspace', workspace], { timeoutMs: 120000 });
    say(`steering: ${s.status === 0 ? 'ok' : `FAILED (rc ${s.status})`} — ${lastLines(s.output, 1)}`);
    if (s.status === 0) writeStamp(CACHE_DIR, 'steering.done');
  } else {
    say(`steering: generator missing (${gen})`);
  }
  // 2. Kiro hooks (stale marked files, e.g. the old vitana-web-dirty.json, are deleted), reviewer copy, git hooks
  const h = writeHooks({ workspace });
  const a = copyReviewer({ workspace });
  const repos = findRepos(workspace);
  const gh = installGitHooks({ repos });
  const gs = gitHooksState({ repos });
  say(`hooks: written [${h.written.join(', ')}] unchanged [${h.unchanged.join(', ')}] removed [${h.removed.join(', ')}]`);
  say(`reviewer agent: ${a.missing ? 'source missing' : a.changed ? 'copied' : 'up to date'}`);
  for (const r of gh) {
    say(`git hooks ${r.dir}: ${r.error || `written [${r.written.join(', ')}] unchanged [${r.unchanged.join(', ')}]`
      + `${r.skipped.length ? ` NOT installed, an unmarked hook exists [${r.skipped.join(', ')}] — left alone` : ''}`}`);
  }
  if (!a.missing && gs.ok) writeStamp(CACHE_DIR, 'hooks.done');
  // 3. dependencies and code intelligence, in the foreground
  if (!argv.includes('--no-install')) {
    // Developer morning pack (latest handoffs, VTIDs in progress): read-only GET, only with the token, ≤ 8 s.
    if (process.env.DEV_MEMORY_PACK_TOKEN) {
      const mp = runProc('bash', [path.join(PLATFORM_ROOT, '.claude', 'hooks', 'session-start-dev-memory-pack.sh')], { timeoutMs: 15000 });
      say(`morning pack:\n${mp.output || '(empty)'}`);
    } else {
      say('morning pack: skipped (DEV_MEMORY_PACK_TOKEN unset); task state comes from git: queue.mjs and the plan files');
    }
    const codeintel = !argv.includes('--no-codeintel');
    say(`installs: dependencies${codeintel ? ' and code intelligence (~8 min on a fresh sandbox, seconds afterwards)' : ' (code intelligence skipped: --no-codeintel)'} …`);
    const r = spawnSync('bash', ['-c', installScript({ repos, codeintel })], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    try { appendFileSync(path.join(CACHE_DIR, 'setup.log'), `--- setup ${start}\n${out}\n`); } catch { /* best effort */ }
    say(`${lastLines(out.trim(), 12)}\ninstalls finished (rc ${r.status})`);
  }
  say(renderStatus(statusReport({ workspace })));
  return 0;
}

function main(argv) {
  // Output survives a closed pipe (`setup | head -2`): an EPIPE on stdout/stderr is ignored, never a crash.
  for (const s of [process.stdout, process.stderr]) s.on('error', (e) => { if (!e || e.code !== 'EPIPE') throw e; });
  const cmd = argv[0];
  const ws = () => path.resolve(opt(argv, 'workspace', defaultWorkspace()));
  if (cmd === 'guard') return report(guard(readStdin()), 2);
  if (cmd === 'git-pre-commit') return report(gitPreCommit({ top: gitTop() }), 1);
  if (cmd === 'git-pre-push') return report(gitPrePush({ top: gitTop(), stdin: readStdin() }), 1);
  if (cmd === 'mark-dirty') return 0; // the PostToolUse hook is gone (plan kiro-web-reliability §3.2.2); a stale hook file must never fail an edit
  if (cmd === 'refresh') {
    const r = refresh({ workspace: ws() });
    if (r.line) say(r.line);
    return 0;
  }
  if (cmd === 'pr-body') {
    try {
      const oasis = opt(argv, 'oasis', 'no');
      const acceptance = opt(argv, 'acceptance');
      process.stdout.write(prBody({ vtid: opt(argv, 'vtid'), scope: opt(argv, 'scope'), acceptance, payload: opt(argv, 'payload'),
        profile: opt(argv, 'profile', 'gateway_backend'), oasis }));
      if (oasis === 'yes' && acceptance && existsSync(acceptance) && !readFileSync(acceptance, 'utf8').includes('OASIS_PROOF:')) {
        process.stderr.write(`pr-body: --oasis yes needs an OASIS_PROOF: line in ${acceptance} (VALIDATOR-CHECK OASIS Traceability Gate)\n`);
      }
      return 0;
    } catch (e) {
      process.stderr.write(`pr-body: ${e.message}\nusage: pr-body --vtid <V> --scope <globs> --acceptance <path> --payload <text> [--profile gateway_backend|command_hub_frontend] [--oasis no|yes]\n`);
      return 2;
    }
  }
  if (cmd === 'status') {
    const rep = statusReport({ workspace: ws() });
    say(argv.includes('--json') ? JSON.stringify(rep, null, 2) : renderStatus(rep));
    return argv.includes('--check') && !rep.ok ? 1 : 0;
  }
  if (cmd === 'setup') return setup(argv, ws());
  if (cmd === 'wait') {
    const repo = opt(argv, 'repo'); const sha = opt(argv, 'sha');
    if (!repo || !sha) { process.stderr.write('usage: wait --repo <owner/repo> --sha <sha> [--timeout 1800] [--interval 120]\n'); return 2; }
    const r = waitChecks({ repo, sha, timeout: Number(opt(argv, 'timeout', 1800)), interval: Number(opt(argv, 'interval', 120)) });
    say(r.report);
    return r.code;
  }
  process.stderr.write('usage: kiro-web-session.mjs setup|status|refresh|guard|git-pre-commit|git-pre-push|pr-body|wait (see the header)\n');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) process.exitCode = main(process.argv.slice(2));
