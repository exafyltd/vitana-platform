#!/usr/bin/env node
/**
 * Kiro Web session kit (plan kiro-web-parity, lane session-kit).
 *
 *   node vitana-platform/scripts/collab/kiro-web-session.mjs setup [--wait] [--no-install] [--workspace <dir>]
 *   node vitana-platform/scripts/collab/kiro-web-session.mjs status [--json] [--check] [--workspace <dir>]
 *   node vitana-platform/scripts/collab/kiro-web-session.mjs guard        (PreToolUse hook on execute_bash; stdin = hook JSON)
 *     a lane push before its PR exists names the PR title in the same bash command, as a prefix
 *     (PR_TITLE='…' git push …, single or double quotes) or an earlier `export PR_TITLE='…' &&`; the hook process
 *     cannot see the shell's environment, so a title set in a previous command is not seen.
 *   node vitana-platform/scripts/collab/kiro-web-session.mjs mark-dirty   (PostToolUse hook on fs_write|str_replace)
 *   node vitana-platform/scripts/collab/kiro-web-session.mjs wait --repo <owner/repo> --sha <sha> [--timeout 1800] [--interval 120]
 *
 * What Kiro Web does (observed 2026-10-26, evidence docs/validation/<VTID>/probes.md): it runs command hooks from
 * `<workspace>/.kiro/hooks/*.json` (not the repos' own `.kiro/hooks`), only the FIRST hook entry of each file, with
 * stdin `{session_id, hook_event_name, cwd, tool_name, tool_input}`; a PreToolUse exit 2 blocks the tool and its
 * stderr reaches the agent; PostToolUse output never reaches the agent. `~/.local` is read-only, `~/.cache` is not.
 *
 * So: `setup` writes one hook per file (guard + mark-dirty), copies the reviewer agent to `<workspace>/.kiro/agents/`,
 * and installs dependencies and code intelligence (a venv under ~/.cache, then the unchanged
 * scripts/codeintel/session-setup.sh). `mark-dirty` records a gateway `src` edit; `guard` runs the gateway typecheck at
 * the next `git commit` (the Claude Code PostToolUse rule, moved to the first point Kiro Web can block) and the
 * existing preflight before a push of a `kiro/**` or `claude/**` branch. The guard only adds checks; it never skips or
 * loosens one, blocks only on a real failure, and never blocks on its own internal error. CI stays the gate.
 *
 * Nothing is written inside a repository. Env overrides (tests): VITANA_KIRO_WEB_CACHE (default ~/.cache/vitana-kiro-web),
 * VITANA_KIRO_WEB_PLATFORM (the vitana-platform checkout; default the one holding this script), CODEINTEL_STATE_DIR.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
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
      description: 'Gateway typecheck before git commit after a gateway edit; preflight before pushing a kiro/<slug>/<lane> branch. Blocks only on a real failure.',
      trigger: 'PreToolUse', matcher: '^execute_bash$', action: { type: 'command', command: `${cli} guard`, timeout: 600 } }),
    file('vitana-web-dirty.json', { name: 'vitana-web-dirty',
      description: 'Records a services/gateway/src edit so the next git commit typechecks the gateway.',
      trigger: 'PostToolUse', matcher: '^(fs_write|str_replace)$', action: { type: 'command', command: `${cli} mark-dirty`, timeout: 10 } }),
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

/** The install script setup runs (detached unless --wait): deps when missing/changed, codeintel venv + session-setup.sh. */
export function installScript({ repos, platformRoot = PLATFORM_ROOT, cacheDir = CACHE_DIR, codeintelDir = CODEINTEL_DIR }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const lines = ['set -u', `mkdir -p ${q(cacheDir)}`, 'echo "setup start $(date -u +%FT%TZ)"'];
  const depDirs = [];
  for (const r of repos) {
    if (r.slug === 'exafyltd/vitana-platform') depDirs.push(path.join(r.dir, 'services', 'gateway'));
    if (r.slug === 'exafyltd/vitana-v1') depDirs.push(r.dir);
  }
  for (const d of depDirs) {
    const stamp = path.join(cacheDir, `deps-${keyOf(d)}.sha`);
    lines.push(`if [ -f ${q(path.join(d, 'package-lock.json'))} ]; then`,
      `  sum=$(sha256sum ${q(path.join(d, 'package-lock.json'))} | cut -d' ' -f1)`,
      `  if [ ! -d ${q(path.join(d, 'node_modules'))} ] || [ "$sum" != "$(cat ${q(stamp)} 2>/dev/null)" ]; then`,
      `    s=$(date +%s); (cd ${q(d)} && npm ci --no-audit --no-fund --loglevel=error) && echo "$sum" > ${q(stamp)}; echo "deps ${d} rc=$? secs=$(( $(date +%s)-s ))"`,
      '  else echo "deps ' + d + ' up to date"; fi', 'fi');
  }
  const venv = path.join(codeintelDir, 'venv');
  lines.push(`export UV_CACHE_DIR=${q(path.join(os.homedir(), '.cache', 'uv'))} REPOWISE_TELEMETRY_DISABLED=1`,
    `if [ ! -x ${q(path.join(venv, 'bin', 'repowise'))} ] || [ ! -x ${q(path.join(venv, 'bin', 'graphify'))} ]; then`,
    `  s=$(date +%s); { command -v uv >/dev/null && uv venv -q --allow-existing ${q(venv)} && uv pip install -q -p ${q(path.join(venv, 'bin', 'python'))} repowise 'graphifyy[bedrock]'; } \\`,
    `    || { python3 -m venv ${q(venv)} && ${q(path.join(venv, 'bin', 'pip'))} install -q repowise 'graphifyy[bedrock]'; }; echo "codeintel venv rc=$? secs=$(( $(date +%s)-s ))"`,
    'fi',
    `export PATH=${q(path.join(venv, 'bin'))}:$PATH`);
  const setupSh = path.join(platformRoot, 'scripts', 'codeintel', 'session-setup.sh');
  if (repos.length) lines.push(`s=$(date +%s); bash ${q(setupSh)} --foreground ${repos.map((r) => q(r.dir)).join(' ')}; echo "codeintel index rc=$? secs=$(( $(date +%s)-s ))"`);
  lines.push(`date -u +%FT%TZ > ${q(path.join(cacheDir, 'setup.done'))}`, 'echo "setup done $(date -u +%FT%TZ)"');
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------ status
export function statusReport({ workspace, platformRoot = PLATFORM_ROOT, cacheDir = CACHE_DIR, codeintelDir = CODEINTEL_DIR,
  env = process.env, run = runProc, repos = null }) {
  const items = [];
  const add = (name, ok, required, detail) => items.push({ name, ok: !!ok, required, detail });
  const steerDir = path.join(workspace, '.kiro', 'steering');
  const steer = existsSync(steerDir) ? readdirSync(steerDir).filter((f) => f.endsWith('.md')) : [];
  const gen = path.join(platformRoot, 'scripts', 'collab', 'kiro-web-steering.mjs');
  const chk = existsSync(gen) ? run(process.execPath, [gen, '--check', '--workspace', workspace], { timeoutMs: 60000 }) : null;
  const steerOk = chk ? chk.status === 0 : steer.length > 0;
  add('workspace-steering', steerOk, true, steerOk
    ? `${steer.length} file(s) in ${steerDir}${chk ? ' (kiro-web-steering --check ok)' : ''}`
    : `${chk ? `kiro-web-steering --check failed: ${lastLines(chk.output, 3)}` : 'none'} — run node vitana-platform/scripts/collab/kiro-web-steering.mjs (the repos' .kiro/steering is not auto-loaded in Kiro Web)`);
  const hookDir = path.join(workspace, '.kiro', 'hooks');
  const missing = hookDefs({ platformRoot }).filter((d) => {
    const p = path.join(hookDir, d.file);
    return !existsSync(p) || readFileSync(p, 'utf8') !== `${JSON.stringify(d.json, null, 2)}\n`;
  }).map((d) => d.file);
  add('hooks', missing.length === 0, true, missing.length ? `missing or stale: ${missing.join(', ')} (run setup)` : `guard + mark-dirty in ${hookDir}`);
  const rsrc = path.join(platformRoot, '.kiro', 'agents', 'vitana-lane-reviewer.md');
  const rdst = path.join(workspace, '.kiro', 'agents', 'vitana-lane-reviewer.md');
  add('reviewer-agent', sameBytes(rsrc, rdst), true, sameBytes(rsrc, rdst) ? rdst : 'not copied to the workspace (run setup)');
  const gw = path.join(platformRoot, 'services', 'gateway', 'node_modules');
  add('gateway-deps', existsSync(gw), true, existsSync(gw) ? gw : 'services/gateway/node_modules missing (setup installs it)');
  const rs = repos || findRepos(workspace, run);
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
  const gh = run('gh', ['api', 'user', '--jq', '.login']);
  add('github', gh.status === 0, true, gh.status === 0 ? `REST as ${gh.output}; GraphQL and gh pr/issue are not supported by the Kiro Web proxy` : `gh api user failed: ${lastLines(gh.output, 2)}`);
  const tok = ['DEV_MEMORY_PACK_TOKEN', 'GATEWAY_SERVICE_TOKEN'].map((k) => `${k}=${env[k] ? 'set' : 'unset'}`);
  add('tokens', true, false, tok.join(', '));
  let setupDone = null;
  try { setupDone = readFileSync(path.join(cacheDir, 'setup.done'), 'utf8').trim(); } catch { /* not yet */ }
  add('installs', !!setupDone, false, setupDone ? `finished ${setupDone}` : `not finished (log ${path.join(cacheDir, 'setup.log')})`);
  return { ok: items.every((i) => i.ok || !i.required), items };
}

function renderStatus(rep) {
  const rows = rep.items.map((i) => `${i.ok ? 'OK  ' : i.required ? 'FAIL' : 'WARN'}  ${i.name.padEnd(18)} ${i.detail}`);
  return `kiro-web-session status: ${rep.ok ? 'ready' : 'NOT ready'}\n${rows.join('\n')}`;
}

// ------------------------------------------------------------------------------------------------ mark-dirty
export const dirtyFile = (cacheDir, repoRoot) => path.join(cacheDir, 'dirty', `${keyOf(repoRoot)}-gateway`);

/** PostToolUse: a services/gateway/src edit → marker for that checkout. Returns the marker path or null. */
export function markDirty(raw, { cacheDir = CACHE_DIR } = {}) {
  let input;
  try { input = JSON.parse(raw); } catch { return null; }
  const p = input?.tool_input?.path;
  if (typeof p !== 'string') return null;
  const idx = p.indexOf('/services/gateway/src/');
  if (idx <= 0) return null;
  const m = dirtyFile(cacheDir, p.slice(0, idx));
  mkdirSync(path.dirname(m), { recursive: true });
  writeFileSync(m, `${new Date().toISOString()} ${p}\n`, { flag: 'a' });
  return m;
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
  let exported = null; // `export PR_TITLE=…` in an earlier segment of the same command
  for (let words of segments(String(command || ''))) {
    let title = exported;
    if (words[0] === 'export') {
      for (const w of words.slice(1)) if (w.startsWith('PR_TITLE=')) exported = w.slice('PR_TITLE='.length) || null;
      continue;
    }
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      if (words[0].startsWith('PR_TITLE=')) title = words[0].slice('PR_TITLE='.length) || null;
      words = words.slice(1);
    }
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
    if (!ref) { out.push({ op: 'push', dir: gdir, remote, src: 'HEAD', branch: null, del, title }); continue; }
    const spec = ref.replace(/^\+/, '');
    if (spec.startsWith(':')) { out.push({ op: 'push', dir: gdir, remote, src: null, branch: stripHeads(spec.slice(1)), del: true, title }); continue; }
    const k = spec.indexOf(':');
    if (k > 0) out.push({ op: 'push', dir: gdir, remote, src: spec.slice(0, k), branch: stripHeads(spec.slice(k + 1)), del, title });
    else out.push({ op: 'push', dir: gdir, remote, src: spec, branch: stripHeads(spec), del, title });
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

function checkCommit(a, { run, cacheDir, exists }) {
  const top = toplevel(run, a.dir);
  if (!top) return ok();
  const marker = dirtyFile(cacheDir, top);
  // Trigger: the PostToolUse marker OR any staged/unstaged change under services/gateway/src against HEAD. The diff
  // covers edits the marker cannot see (bash/sed) and an edit issued in the same parallel batch as the commit, whose
  // PostToolUse lands after this PreToolUse (observed in a sub-agent, docs/validation/VTID-05340/probes.md).
  const d = run('git', ['-C', top, 'diff', '--name-only', 'HEAD', '--', 'services/gateway/src']);
  const changed = d.status === 0 && String(d.output || '').trim() !== '';
  if (!existsSync(marker) && !changed) return ok();
  const gw = path.join(top, 'services', 'gateway');
  if (!exists(path.join(gw, 'node_modules'))) {
    const n = run('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: gw, timeoutMs: 300000 });
    if (n.status !== 0) return ok(`kiro-web-session guard: gateway npm ci failed, typecheck not run (CI still typechecks): ${lastLines(n.output, 3)}`);
  }
  mkdirSync(path.join(cacheDir, 'tsc'), { recursive: true });
  const t = run('npx', ['tsc', '--noEmit', '--incremental', '--tsBuildInfoFile', path.join(cacheDir, 'tsc', `${keyOf(top)}.tsbuildinfo`)],
    { cwd: gw, timeoutMs: 540000 });
  if (t.status === 0) { try { unlinkSync(marker); } catch { /* diff-triggered */ } return ok('kiro-web-session guard: gateway typecheck passed'); }
  const errs = String(t.output).split('\n').filter((l) => l.includes('error TS'));
  if (!errs.length) return ok(`kiro-web-session guard: tsc did not run cleanly (status ${t.status}), not blocking: ${lastLines(t.output, 3)}`);
  return block(`kiro-web-session guard: gateway typecheck failed after an edit under services/gateway/src — the deploy would fail. `
    + `Fix before committing (${errs.length} error(s), first ${Math.min(10, errs.length)}):\n${errs.slice(0, 10).join('\n')}`);
}

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
  const args = [path.join(platformRoot, 'scripts', 'collab', 'preflight.mjs'), '--repo', top, '--base', 'origin/main', '--head', sha, '--branch', branch, '--required-only'];
  let title = a.title;
  if (!title && slug) {
    const t = run('gh', ['api', `repos/${slug}/pulls?head=${slug.split('/')[0]}:${branch}&state=open`, '--jq', '.[0].title // ""'], { timeoutMs: 30000 });
    title = t.status === 0 ? t.output.trim() : '';
  }
  if (!title) {
    return block(`kiro-web-session guard: no open PR for ${branch}, so the preflight has no PR title (PR-GATE reads the VTIDs from it). `
      + `Push with the title the PR will get: PR_TITLE='VTID-xxxxx (<slug>/<lane>): …' git push … (a plan branch: PR_TITLE='plan(<slug>): …').`);
  }
  args.push('--title', title);
  const p = run(process.execPath, args, { cwd: top, timeoutMs: 540000 });
  if (p.status !== 0 && onlyPlanSparSessionFalsePositive(p.output)) {
    return ok(`kiro-web-session guard: preflight's only failure is Collab handoff counting PLAN-SPAR's own ci-plan-spar commit as a `
      + `second _plan session (a known governance-artifact false positive; CI shows it red, §7b handles it at merge). Not blocking.`);
  }
  if (p.status === 0) {
    // --required-only: exit 0 means every check CI requires passed. Report-only failures are shown, never blocking,
    // and the pass is not cached so they are printed again on the next push.
    const reportOnly = /^FAIL /m.test(p.output);
    if (reportOnly) {
      return ok(`kiro-web-session guard: preflight passed every check CI requires on ${sha.slice(0, 12)}${note}; these checks are report-only in CI and failed (not blocking):\n${condensePreflight(p.output)}`);
    }
    mkdirSync(path.dirname(okFile), { recursive: true });
    writeFileSync(okFile, `${new Date().toISOString()}\n`);
    return ok(`kiro-web-session guard: preflight passed on ${sha.slice(0, 12)}${note}`);
  }
  return block(`kiro-web-session guard: preflight failed on ${sha.slice(0, 12)} (${branch}) — CI would fail the same way. `
    + `Fix every error below, commit, then push again${note}:\n${condensePreflight(p.output)}`);
}

/** PreToolUse on execute_bash. Returns {code, stdout, stderr}; code 2 blocks the command. */
export function guard(raw, { run = runProc, cacheDir = CACHE_DIR, platformRoot = PLATFORM_ROOT, exists = existsSync } = {}) {
  try {
    let input;
    try { input = JSON.parse(raw); } catch { return ok(); }
    const command = input?.tool_input?.command;
    if (typeof command !== 'string' || !/\bgit\b/.test(command)) return ok();
    const cwd = input.tool_input.cwd || input.cwd || process.cwd();
    const acts = parseCommand(command, cwd);
    if (!acts.length) return ok();
    const ci = acts.findIndex((a) => a.op === 'commit');
    const pi = acts.findIndex((a) => a.op === 'push' && !a.del && (a.branch === null || LANE_BRANCH.test(a.branch)));
    if (ci >= 0 && pi > ci) {
      return block('kiro-web-session guard: run `git commit` and `git push` as separate commands, so the preflight checks the commit being pushed.');
    }
    const notes = [];
    for (const a of acts) {
      const r = a.op === 'commit' ? checkCommit(a, { run, cacheDir, exists }) : checkPush(a, { run, cacheDir, platformRoot });
      if (r.code !== 0) return r;
      if (r.stdout) notes.push(r.stdout);
    }
    return ok(notes.join('\n'));
  } catch (e) {
    return ok(`kiro-web-session guard: internal error (${e && e.message}); not blocking — CI stays the gate`);
  }
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

function main(argv) {
  const cmd = argv[0];
  const workspace = path.resolve(opt(argv, 'workspace', defaultWorkspace()));
  if (cmd === 'guard') {
    const r = guard(readStdin());
    // The main Kiro Web session shows a blocked command as `{}` without the hook's stderr (sub-agents see it), so
    // every block is also written to a file the agent reads: ~/.cache/vitana-kiro-web/last-block.txt.
    if (r.code === 2) {
      try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(path.join(CACHE_DIR, 'last-block.txt'), `${new Date().toISOString()}\n${r.stderr}\n`); } catch { /* best effort */ }
    }
    if (r.stdout) process.stdout.write(`${r.stdout}\n`);
    if (r.stderr) process.stderr.write(`${r.stderr}\n`);
    return r.code;
  }
  if (cmd === 'mark-dirty') { try { markDirty(readStdin()); } catch { /* never fail an edit */ } return 0; }
  if (cmd === 'status') {
    const rep = statusReport({ workspace });
    process.stdout.write(argv.includes('--json') ? `${JSON.stringify(rep, null, 2)}\n` : `${renderStatus(rep)}\n`);
    return argv.includes('--check') && !rep.ok ? 1 : 0;
  }
  if (cmd === 'setup') {
    mkdirSync(CACHE_DIR, { recursive: true });
    const h = writeHooks({ workspace });
    const a = copyReviewer({ workspace });
    process.stdout.write(`hooks: written [${h.written.join(', ')}] unchanged [${h.unchanged.join(', ')}] removed [${h.removed.join(', ')}]\n`
      + `reviewer agent: ${a.missing ? 'source missing' : a.changed ? 'copied' : 'up to date'}\n`);
    if (!argv.includes('--no-install')) {
      // Developer morning pack (latest handoffs, VTIDs in progress): read-only GET, only with the token, ≤ 8 s.
      if (process.env.DEV_MEMORY_PACK_TOKEN) {
        const mp = runProc('bash', [path.join(PLATFORM_ROOT, '.claude', 'hooks', 'session-start-dev-memory-pack.sh')], { timeoutMs: 15000 });
        process.stdout.write(`morning pack:\n${mp.output || '(empty)'}\n`);
      } else {
        process.stdout.write('morning pack: skipped (DEV_MEMORY_PACK_TOKEN unset); task state comes from git: queue.mjs and the plan files\n');
      }
      const repos = findRepos(workspace);
      const script = installScript({ repos });
      const log = path.join(CACHE_DIR, 'setup.log');
      try { unlinkSync(path.join(CACHE_DIR, 'setup.done')); } catch { /* first run */ }
      if (argv.includes('--wait')) {
        const r = spawnSync('bash', ['-c', `{ ${script}\n} >> '${log}' 2>&1`], { stdio: 'inherit' });
        process.stdout.write(`installs finished (rc ${r.status}); log ${log}\n${lastLines(readFileSync(log, 'utf8'), 8)}\n`);
      } else {
        const child = spawn('bash', ['-c', `{ ${script}\n} >> '${log}' 2>&1`], { detached: true, stdio: 'ignore' });
        child.unref();
        process.stdout.write(`installs running in the background (deps, code intelligence) — log ${log}; re-run \`status\` to see readiness\n`);
      }
    }
    process.stdout.write(`${renderStatus(statusReport({ workspace }))}\n`);
    return 0;
  }
  if (cmd === 'wait') {
    const repo = opt(argv, 'repo'); const sha = opt(argv, 'sha');
    if (!repo || !sha) { process.stderr.write('usage: wait --repo <owner/repo> --sha <sha> [--timeout 1800] [--interval 120]\n'); return 2; }
    const r = waitChecks({ repo, sha, timeout: Number(opt(argv, 'timeout', 1800)), interval: Number(opt(argv, 'interval', 120)) });
    process.stdout.write(`${r.report}\n`);
    return r.code;
  }
  process.stderr.write('usage: kiro-web-session.mjs setup|status|guard|mark-dirty|wait (see the header)\n');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) process.exitCode = main(process.argv.slice(2));
