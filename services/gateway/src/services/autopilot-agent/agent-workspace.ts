/**
 * VTID-04006: git workspace for one agent execution.
 *
 * A shallow clone into a scratch directory, a fresh branch, and at the end
 * one commit pushed to that branch. The token never appears in logs: it is
 * embedded in the remote URL only, and errors are scrubbed before they are
 * surfaced. `exec` is injectable so the parsing helpers are unit-testable
 * without a real git.
 */

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileP = promisify(execFile);

export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export const defaultExec: ExecFn = async (cmd, args, opts) => {
  const { stdout, stderr } = await execFileP(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) },
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
};

export interface Workspace {
  /** Scratch root (deleted by `cleanupWorkspace`). */
  root: string;
  /** The clone. All tools are jailed here. */
  repoDir: string;
  branch: string;
  baseSha: string;
}

export interface ChangedFile {
  path: string;
  action: 'create' | 'modify' | 'delete';
}

export function scrubSecret(text: string, secret?: string): string {
  if (!secret) return text;
  return text.split(secret).join('***');
}

function remoteUrl(owner: string, repo: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

export async function prepareWorkspace(opts: {
  owner: string;
  repo: string;
  baseBranch: string;
  branch: string;
  token: string;
  workRoot?: string;
  exec?: ExecFn;
  depth?: number;
  /** VTID-04017 fix mode: `branch` already exists on the remote (the parent
   *  execution's PR branch) — clone it directly and stay on it. */
  existingBranch?: boolean;
}): Promise<Workspace> {
  const exec = opts.exec ?? defaultExec;
  const root = await fs.mkdtemp(path.join(opts.workRoot || os.tmpdir(), 'autopilot-agent-'));
  const repoDir = path.join(root, opts.repo);
  try {
    const cloneBranch = opts.existingBranch ? opts.branch : opts.baseBranch;
    await exec('git', ['clone', '--depth', String(opts.depth ?? 1), '--branch', cloneBranch, '--single-branch', remoteUrl(opts.owner, opts.repo, opts.token), repoDir], { timeoutMs: 600_000 });
    await exec('git', ['config', 'user.name', 'vitana-dev-autopilot'], { cwd: repoDir });
    await exec('git', ['config', 'user.email', 'dev-autopilot@vitanaland.com'], { cwd: repoDir });
    if (!opts.existingBranch) await exec('git', ['checkout', '-b', opts.branch], { cwd: repoDir });
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
    return { root, repoDir, branch: opts.branch, baseSha: stdout.trim() };
  } catch (err) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`workspace clone failed: ${scrubSecret(err instanceof Error ? err.message : String(err), opts.token)}`);
  }
}

/**
 * VTID-04017: fetch one ref from origin (shallow) and return its SHA. Used
 * in fix mode to diff the PR branch against its base.
 */
export async function fetchRefSha(repoDir: string, ref: string, exec: ExecFn = defaultExec): Promise<string> {
  await exec('git', ['fetch', '--depth', '1', 'origin', ref], { cwd: repoDir, timeoutMs: 300_000 });
  const { stdout } = await exec('git', ['rev-parse', 'FETCH_HEAD'], { cwd: repoDir });
  return stdout.trim();
}

/** Parse `git diff --name-status` output into changed files. */
export function parseNameStatus(stdout: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('\t');
    const code = parts[0] || '';
    const p = parts[parts.length - 1] || '';
    if (!p) continue;
    const c = code[0];
    const action: ChangedFile['action'] = c === 'D' ? 'delete' : c === 'A' ? 'create' : 'modify';
    out.push({ path: p, action });
  }
  return out;
}

/**
 * VTID-04017: every file that differs between the working tree (untracked
 * included) and `baseSha` — in fix mode that is the whole PR, committed
 * parent work plus this run's edits.
 */
export async function listChangedFilesSince(repoDir: string, baseSha: string, exec: ExecFn = defaultExec): Promise<ChangedFile[]> {
  await exec('git', ['add', '-A', '--intent-to-add'], { cwd: repoDir }).catch(() => undefined);
  const { stdout } = await exec('git', ['diff', '--name-status', baseSha], { cwd: repoDir });
  return parseNameStatus(stdout);
}

/** Parse `git status --porcelain` into repo-relative changed files. */
export function parsePorcelain(stdout: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const raw of stdout.split('\n')) {
    if (!raw.trim()) continue;
    const code = raw.slice(0, 2);
    let p = raw.slice(3).trim();
    if (p.includes(' -> ')) p = p.split(' -> ')[1];
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    const x = code[0];
    const y = code[1];
    let action: ChangedFile['action'];
    if (x === 'D' || y === 'D') action = 'delete';
    else if (x === '?' || x === 'A') action = 'create';
    else action = 'modify';
    out.push({ path: p, action });
  }
  return out;
}

export async function listChangedFiles(repoDir: string, exec: ExecFn = defaultExec): Promise<ChangedFile[]> {
  const { stdout } = await exec('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repoDir });
  return parsePorcelain(stdout);
}

export async function gitDiff(repoDir: string, exec: ExecFn = defaultExec): Promise<string> {
  // Untracked files are not in `git diff`; stage everything into the index
  // view without committing so the model sees new files too.
  await exec('git', ['add', '-A', '--intent-to-add'], { cwd: repoDir }).catch(() => undefined);
  const { stdout } = await exec('git', ['diff'], { cwd: repoDir });
  return stdout;
}

/**
 * VTID-04029: the committed diff of HEAD against a base sha — `--stat` plus
 * the full patch — for the approval preview that is stored on the execution
 * row when the agent stops before opening a PR. Read-only; callers bound it.
 */
export async function gitDiffAgainstBase(
  repoDir: string,
  baseSha: string,
  exec: ExecFn = defaultExec,
): Promise<{ stat: string; patch: string; files: string[] }> {
  const { stdout: stat } = await exec('git', ['diff', '--stat=120', `${baseSha}..HEAD`], { cwd: repoDir });
  const { stdout: patch } = await exec('git', ['diff', `${baseSha}..HEAD`], { cwd: repoDir });
  const { stdout: names } = await exec('git', ['diff', '--name-only', `${baseSha}..HEAD`], { cwd: repoDir });
  return { stat, patch, files: names.split('\n').map((l) => l.trim()).filter(Boolean) };
}

export async function commitAndPush(
  repoDir: string,
  opts: { message: string; branch: string; token: string; exec?: ExecFn; force?: boolean },
): Promise<{ sha: string }> {
  const exec = opts.exec ?? defaultExec;
  try {
    await exec('git', ['add', '-A'], { cwd: repoDir });
    await exec('git', ['commit', '-q', '-m', opts.message], { cwd: repoDir });
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
    // The branch name is unique to this execution (dev-autopilot/<exec8>);
    // a stale remote branch from an earlier attempt of the same execution is
    // replaced, never a branch anyone else owns. VTID-04017 fix mode pushes
    // a plain fast-forward onto the parent's PR branch (force=false).
    const force = opts.force !== false;
    await exec('git', ['push', ...(force ? ['--force'] : []), '-u', 'origin', opts.branch], { cwd: repoDir, timeoutMs: 300_000 });
    return { sha: stdout.trim() };
  } catch (err) {
    throw new Error(`commit/push failed: ${scrubSecret(err instanceof Error ? err.message : String(err), opts.token)}`);
  }
}

/**
 * Make `<repoDir>/<projectRel>/node_modules` available without an install:
 * symlink the executor image's own dependency tree (the image is built from
 * the same package.json family). No-op when the source does not exist or the
 * project already has node_modules.
 */
export async function linkNodeModules(repoDir: string, projectRel: string, source: string): Promise<'linked' | 'present' | 'no_source'> {
  const target = path.join(repoDir, projectRel, 'node_modules');
  try {
    await fs.access(target);
    return 'present';
  } catch {
    /* absent — fall through */
  }
  try {
    await fs.access(source);
  } catch {
    return 'no_source';
  }
  await fs.symlink(source, target, 'dir');
  return 'linked';
}

export async function cleanupWorkspace(ws: Workspace | null | undefined): Promise<void> {
  if (!ws) return;
  await fs.rm(ws.root, { recursive: true, force: true }).catch(() => undefined);
}
