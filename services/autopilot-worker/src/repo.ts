/**
 * Local git clone manager used by pre-PR validation.
 *
 * Keeps one persistent clone of the target repo under
 * $AUTOPILOT_WORKER_REPO_CLONE (default: ~/.cache/vitana-autopilot-worker/<repo>).
 * For each execute task:
 *
 *   1. fetchAndReset(baseBranch) — git fetch; hard-reset a throwaway
 *      worktree branch to origin/<baseBranch> so we start clean.
 *   2. applyFiles(files) — write each ExecutionFile to disk under the clone
 *      path. For action='delete', unlink. For 'modify'/'create', overwrite.
 *
 * We NEVER push from here. The gateway still owns branch creation + PR
 * opening via the GitHub Contents API; this module exists purely as a
 * scratch filesystem so `tsc --noEmit` (and later jest) have something
 * real to check against.
 *
 * The gateway can't validate because Cloud Run containers are stateless
 * and carrying a several-GB clone around is impractical. The worker has
 * a persistent filesystem and we only clone once.
 */

import { execFile } from 'child_process';
import { constants as fsc, existsSync } from 'fs';
import { mkdir, access, writeFile, unlink, rm } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { promisify } from 'util';

import type { ExecutionFile } from './parse';

const exec = promisify(execFile);

const LOG_PREFIX = '[autopilot-worker/repo]';

const DEFAULT_REMOTE = process.env.AUTOPILOT_WORKER_REPO_URL
  || 'https://github.com/exafyltd/vitana-platform.git';
const REPO_NAME = (() => {
  const m = DEFAULT_REMOTE.match(/\/([^\/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : 'vitana-platform';
})();

const CLONE_ROOT = process.env.AUTOPILOT_WORKER_REPO_CLONE
  || join(homedir(), '.cache', 'vitana-autopilot-worker', REPO_NAME);

const GIT_TIMEOUT_MS = 120_000;

async function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await exec(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
    maxBuffer: 50 * 1024 * 1024,
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path, fsc.F_OK); return true; } catch { return false; }
}

export function clonePath(): string {
  return CLONE_ROOT;
}

/**
 * Ensure a working clone exists at CLONE_ROOT. Creates it if missing.
 * Idempotent — safe to call on every task.
 */
export async function ensureClone(): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    if (await exists(join(CLONE_ROOT, '.git'))) {
      return { ok: true, path: CLONE_ROOT };
    }
    await mkdir(dirname(CLONE_ROOT), { recursive: true });
    console.log(`${LOG_PREFIX} cloning ${DEFAULT_REMOTE} → ${CLONE_ROOT} (first run, slow)`);
    // Shallow clone keeps the initial cost reasonable; we only need
    // latest main to validate typechecks against.
    await run('git', ['clone', '--depth', '50', DEFAULT_REMOTE, CLONE_ROOT], { timeoutMs: 600_000 });
    return { ok: true, path: CLONE_ROOT };
  } catch (err) {
    return { ok: false, error: `ensureClone failed: ${String(err).slice(0, 400)}` };
  }
}

/**
 * Fetch the latest from origin and hard-reset the working tree to
 * origin/<baseBranch>, dropping any files from a previous task. Leaves
 * the clone in a "fresh copy of baseBranch" state, ready to receive
 * applyFiles().
 */
export async function fetchAndReset(baseBranch: string): Promise<{ ok: boolean; sha?: string; error?: string }> {
  try {
    const init = await ensureClone();
    if (!init.ok) return { ok: false, error: init.error };

    // Clean out any stray changes from last task
    await run('git', ['reset', '--hard', 'HEAD'], { cwd: CLONE_ROOT }).catch(() => undefined);
    await run('git', ['clean', '-fdx', '-e', 'node_modules/'], { cwd: CLONE_ROOT }).catch(() => undefined);
    await run('git', ['fetch', '--depth', '50', 'origin', baseBranch], { cwd: CLONE_ROOT, timeoutMs: 300_000 });
    await run('git', ['checkout', '-B', '_autopilot_scratch', `origin/${baseBranch}`], { cwd: CLONE_ROOT });
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: CLONE_ROOT });
    return { ok: true, sha: stdout.trim() };
  } catch (err) {
    return { ok: false, error: `fetchAndReset failed: ${String(err).slice(0, 400)}` };
  }
}

/**
 * Apply the parsed file set to the clone. For each file:
 *   - 'delete' → unlink (missing file is fine)
 *   - 'create' / 'modify' → mkdir -p + write the content verbatim
 *
 * Returns the absolute paths of the changed files so the validator can
 * target them.
 */
export async function applyFiles(files: ExecutionFile[]): Promise<{ ok: boolean; paths?: string[]; error?: string }> {
  try {
    const touched: string[] = [];
    for (const f of files) {
      if (!f.path || f.path.includes('..') || f.path.startsWith('/')) {
        return { ok: false, error: `rejecting unsafe path: ${f.path}` };
      }
      const abs = join(CLONE_ROOT, f.path);
      if (f.action === 'delete') {
        await unlink(abs).catch(() => undefined);
        touched.push(abs);
        continue;
      }
      if (typeof f.content !== 'string') {
        return { ok: false, error: `file ${f.path} missing content for action=${f.action}` };
      }
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.content, 'utf-8');
      touched.push(abs);
    }
    return { ok: true, paths: touched };
  } catch (err) {
    return { ok: false, error: `applyFiles failed: ${String(err).slice(0, 400)}` };
  }
}

/**
 * Reset back to the clean base so the clone is ready for the next task.
 * Called after validation completes (green or red).
 */
export async function resetClean(): Promise<void> {
  if (!existsSync(CLONE_ROOT)) return;
  await run('git', ['reset', '--hard', 'HEAD'], { cwd: CLONE_ROOT }).catch(() => undefined);
  await run('git', ['clean', '-fd'], { cwd: CLONE_ROOT }).catch(() => undefined);
}

export { CLONE_ROOT, DEFAULT_REMOTE };
