/**
 * VTID-04006: local verification for the agent executor — the thing the
 * single-shot path never had. tsc and jest run inside the clone, before any
 * PR exists, and their output is fed back to the model for a bounded number
 * of fix rounds.
 */

import fs from 'fs';
import path from 'path';
import { defaultExec, type ExecFn } from './agent-workspace';
import type { CheckKind, CheckResult } from './agent-tools';

const TSC_TIMEOUT_MS = 10 * 60_000;
export const TSC_ARGS = ['--noEmit', '-p', 'tsconfig.json', '--preserveSymlinks'] as const;
/**
 * VTID-04009: tsc on the gateway project needs more than V8's default
 * old-space (~2 GB on the executor task, where Test Run #4 measured three
 * consecutive `allocation failure` aborts after ~2 min each, on a 4 GB
 * task). The heap is sized explicitly and env-tunable so the task size and
 * the check's heap can move together without a code change.
 */
const DEFAULT_CHECK_HEAP_MB = 3072;

export function checkHeapMb(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.AGENT_CHECK_HEAP_MB || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CHECK_HEAP_MB;
}

/** NODE_OPTIONS for a check process: inherited options plus the heap cap (last flag wins in node). */
export function checkNodeOptions(env: NodeJS.ProcessEnv = process.env): string {
  return [env.NODE_OPTIONS, `--max-old-space-size=${checkHeapMb(env)}`].filter(Boolean).join(' ');
}
const JEST_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_CAP = 60_000;

function cap(s: string): string {
  return s.length > OUTPUT_CAP ? `${s.slice(0, OUTPUT_CAP)}\n…[truncated]` : s;
}

interface ExecFailure extends Error {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  code?: number | string;
  killed?: boolean;
}

async function runCapture(exec: ExecFn, cmd: string, args: string[], cwd: string, timeoutMs: number, extraEnv: NodeJS.ProcessEnv = {}): Promise<CheckResult> {
  try {
    const { stdout, stderr } = await exec(cmd, args, { cwd, timeoutMs, env: { FORCE_COLOR: '0', CI: 'true', ...extraEnv } });
    return { ok: true, exit_code: 0, output: cap(`${stdout}${stderr ? `\n${stderr}` : ''}`.trim()) };
  } catch (err) {
    const e = err as ExecFailure;
    const out = `${String(e.stdout ?? '')}\n${String(e.stderr ?? '')}`.trim() || e.message;
    const code = typeof e.code === 'number' ? e.code : 1;
    return { ok: false, exit_code: e.killed ? 124 : code, output: cap(e.killed ? `timed out after ${timeoutMs}ms\n${out}` : out) };
  }
}

/** Which project dir a repo-relative path belongs to (has its own tsconfig). */
export function projectDirFor(rel: string): string | null {
  const m = /^(services\/[^/]+)\//.exec(rel);
  return m ? m[1] : null;
}

/**
 * Jest targets for a set of changed files: the changed test files
 * themselves plus the conventional test file for each changed source
 * (`services/gateway/src/**\/<name>.ts` → `services/gateway/test/**\/<name>.test.ts`
 * via a basename match performed by jest's own path regex).
 */
export function selectJestTargets(changed: string[]): { project: string; patterns: string[] }[] {
  const byProject = new Map<string, Set<string>>();
  for (const rel of changed) {
    const project = projectDirFor(rel);
    if (!project) continue;
    if (!/\.[cm]?[jt]sx?$/.test(rel)) continue;
    const inProject = rel.slice(project.length + 1);
    const set = byProject.get(project) ?? new Set<string>();
    if (/(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(inProject)) {
      set.add(inProject);
    } else {
      const base = path.basename(inProject).replace(/\.[cm]?[jt]sx?$/, '');
      if (base) set.add(`${base}\\.(test|spec)\\.[jt]sx?$`);
    }
    byProject.set(project, set);
  }
  return [...byProject.entries()].map(([project, set]) => ({ project, patterns: [...set] }));
}

/**
 * VTID-04617: a changed frontend asset (`src/frontend/**`, not TypeScript) has
 * no paired `<name>.test.ts`, but many suites read it as a file — the Command
 * Hub cache-bust pins, CSP and ownership checks read app.js, styles.css and
 * index.html. selectJestTargets finds none of them, so CI was the first to run
 * them (VTID-04614 / PR #3736). This returns, per project, the test files
 * whose source names a changed asset's basename.
 */
export function selectAssetReferencingTests(
  repoDir: string,
  changed: string[],
): { project: string; patterns: string[] }[] {
  const byProject = new Map<string, Set<string>>();
  for (const rel of changed) {
    const project = projectDirFor(rel);
    if (!project) continue;
    const inProject = rel.slice(project.length + 1);
    if (!/^src\/frontend\//.test(inProject)) continue;
    if (/\.[cm]?tsx?$/.test(inProject)) continue;
    const set = byProject.get(project) ?? new Set<string>();
    set.add(path.basename(inProject));
    byProject.set(project, set);
  }
  const out: { project: string; patterns: string[] }[] = [];
  for (const [project, basenames] of byProject) {
    const testDir = path.join(repoDir, project, 'test');
    const matches = new Set<string>();
    for (const file of listTestFiles(testDir)) {
      let src: string;
      try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const b of basenames) {
        if (src.includes(b)) { matches.add(path.relative(path.join(repoDir, project), file)); break; }
      }
    }
    if (matches.size) out.push({ project, patterns: [...matches].sort() });
  }
  return out;
}

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...listTestFiles(p)); }
    else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Paired suites plus the suites that read a changed frontend asset, merged per project. */
export function selectRunnerJestTargets(repoDir: string, changed: string[]): { project: string; patterns: string[] }[] {
  const merged = new Map<string, Set<string>>();
  for (const t of [...selectJestTargets(changed), ...selectAssetReferencingTests(repoDir, changed)]) {
    const set = merged.get(t.project) ?? new Set<string>();
    t.patterns.forEach((p) => set.add(p));
    merged.set(t.project, set);
  }
  return [...merged.entries()].map(([project, set]) => ({ project, patterns: [...set] }));
}

export async function runTsc(repoDir: string, projectRel = 'services/gateway', exec: ExecFn = defaultExec): Promise<CheckResult> {
  const cwd = path.join(repoDir, projectRel);
  const tsc = path.join(cwd, 'node_modules', '.bin', 'tsc');
  // VTID-04013: the clone's node_modules is a symlink to the image's tree
  // (linkNodeModules). Without --preserveSymlinks TypeScript resolves the
  // realpath and reports TS2742 ("cannot be named without a reference to
  // '../../../../../..'") on exports whose inferred type lives in a library —
  // an environment artifact, not a defect in the code (Test Run #4b).
  return runCapture(exec, tsc, [...TSC_ARGS], cwd, TSC_TIMEOUT_MS, { NODE_OPTIONS: checkNodeOptions() });
}

export async function runJest(repoDir: string, projectRel: string, patterns: string[], exec: ExecFn = defaultExec): Promise<CheckResult> {
  const cwd = path.join(repoDir, projectRel);
  const jest = path.join(cwd, 'node_modules', '.bin', 'jest');
  const args = ['--ci', '--silent', '--forceExit', ...(patterns.length ? patterns : [])];
  return runCapture(exec, jest, args, cwd, JEST_TIMEOUT_MS);
}

export async function runNodeCheck(repoDir: string, fileRel: string, exec: ExecFn = defaultExec): Promise<CheckResult> {
  return runCapture(exec, 'node', ['--check', fileRel], repoDir, 60_000);
}

/** The `run_check` implementation handed to the tool executor. */
export function makeCheckRunner(repoDir: string, exec: ExecFn = defaultExec): (kind: CheckKind, target?: string) => Promise<CheckResult> {
  return async (kind, target) => {
    switch (kind) {
      case 'tsc':
        return runTsc(repoDir, target && /^services\/[^/]+$/.test(target) ? target : 'services/gateway', exec);
      case 'jest': {
        const targets = (target || '').split(/\s+/).filter(Boolean);
        if (targets.length === 0) return { ok: false, exit_code: 2, output: 'jest needs target: one or more repo-root-relative test paths' };
        const project = projectDirFor(targets[0]) || 'services/gateway';
        const inProject = targets.map((t) => (t.startsWith(project + '/') ? t.slice(project.length + 1) : t));
        return runJest(repoDir, project, inProject, exec);
      }
      case 'node_check':
        if (!target) return { ok: false, exit_code: 2, output: 'node_check needs target: a file path' };
        return runNodeCheck(repoDir, target, exec);
      case 'git_diff':
        return runCapture(exec, 'git', ['diff', 'HEAD', '--', '.'], repoDir, 60_000).then(async (r) => {
          // include untracked files
          const st = await runCapture(exec, 'git', ['status', '--porcelain', '--untracked-files=all'], repoDir, 60_000);
          return { ...r, output: cap(`${r.output}\n\n# git status --porcelain\n${st.output}`) };
        });
      case 'git_status':
        return runCapture(exec, 'git', ['status', '--porcelain', '--untracked-files=all'], repoDir, 60_000);
      default:
        return { ok: false, exit_code: 2, output: `unknown check ${String(kind)}` };
    }
  };
}
