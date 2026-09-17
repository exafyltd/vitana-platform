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
}): Promise<Workspace> {
  const exec = opts.exec ?? defaultExec;
  const root = await fs.mkdtemp(path.join(opts.workRoot || os.tmpdir(), 'autopilot-agent-'));
  const repoDir = path.join(root, opts.repo);
  try {
    await exec('git', ['clone', '--depth', String(opts.depth ?? 1), '--branch', opts.baseBranch, '--single-branch', remoteUrl(opts.owner, opts.repo, opts.token), repoDir], { timeoutMs: 600_000 });
    await exec('git', ['config', 'user.name', 'vitana-dev-autopilot'], { cwd: repoDir });
    await exec('git', ['config', 'user.email', 'dev-autopilot@vitanaland.com'], { cwd: repoDir });
    await exec('git', ['checkout', '-b', opts.branch], { cwd: repoDir });
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
    return { root, repoDir, branch: opts.branch, baseSha: stdout.trim() };
  } catch (err) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`workspace clone failed: ${scrubSecret(err instanceof Error ? err.message : String(err), opts.token)}`);
  }
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

export async function commitAndPush(
  repoDir: string,
  opts: { message: string; branch: string; token: string; exec?: ExecFn },
): Promise<{ sha: string }> {
  const exec = opts.exec ?? defaultExec;
  try {
    await exec('git', ['add', '-A'], { cwd: repoDir });
    await exec('git', ['commit', '-q', '-m', opts.message], { cwd: repoDir });
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
    // The branch name is unique to this execution (dev-autopilot/<exec8>);
    // a stale remote branch from an earlier attempt of the same execution is
    // replaced, never a branch anyone else owns.
    await exec('git', ['push', '--force', '-u', 'origin', opts.branch], { cwd: repoDir, timeoutMs: 300_000 });
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
