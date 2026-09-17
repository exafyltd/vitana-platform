/**
 * VTID-04006: local verification for the agent executor — the thing the
 * single-shot path never had. tsc and jest run inside the clone, before any
 * PR exists, and their output is fed back to the model for a bounded number
 * of fix rounds.
 */

import path from 'path';
import { defaultExec, type ExecFn } from './agent-workspace';
import type { CheckKind, CheckResult } from './agent-tools';

const TSC_TIMEOUT_MS = 10 * 60_000;
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

async function runCapture(exec: ExecFn, cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<CheckResult> {
  try {
    const { stdout, stderr } = await exec(cmd, args, { cwd, timeoutMs, env: { FORCE_COLOR: '0', CI: 'true' } });
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

export async function runTsc(repoDir: string, projectRel = 'services/gateway', exec: ExecFn = defaultExec): Promise<CheckResult> {
  const cwd = path.join(repoDir, projectRel);
  const tsc = path.join(cwd, 'node_modules', '.bin', 'tsc');
  return runCapture(exec, tsc, ['--noEmit', '-p', 'tsconfig.json'], cwd, TSC_TIMEOUT_MS);
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
