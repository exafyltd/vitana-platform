/**
 * Pre-PR validation: run `tsc --noEmit` on the repo, keep only the
 * diagnostics that reference files we just changed (or files those files
 * import — detected by path prefix).
 *
 * Filter vs. run-only-changed-files: `tsc` without `--project` can't see
 * cross-file types, so it would spuriously reject anything that imports
 * from another module. Running the whole project is the only way to get
 * real answers. But we don't care about pre-existing errors in files we
 * didn't touch — those are main's problem, not ours. Hence the filter.
 */

import { execFile } from 'child_process';
import { relative } from 'path';
import { promisify } from 'util';

import { CLONE_ROOT } from './repo';

const exec = promisify(execFile);

const LOG_PREFIX = '[autopilot-worker/validate]';
const TSC_TIMEOUT_MS = 120_000;
const TSC_BIN = process.env.AUTOPILOT_WORKER_TSC_BIN || 'npx';
// If TSC_BIN is `npx`, we invoke `npx tsc`. If someone sets TSC_BIN to an
// explicit path (e.g. node_modules/.bin/tsc), we use it directly.
const TSC_ARGS_PREFIX = TSC_BIN === 'npx' ? ['tsc'] : [];

export interface ValidationResult {
  ok: boolean;
  /** Full tsc stdout (truncated). Useful for the retry prompt. */
  raw?: string;
  /** Only the errors that mention paths we changed. */
  relevantErrors?: string[];
  /** Elapsed time in ms. */
  elapsedMs: number;
  error?: string;
}

/**
 * Run `tsc --noEmit -p <tsconfig>` and return filtered diagnostics.
 *
 * changedAbsPaths is the list of absolute paths that were written by
 * applyFiles(). We keep only tsc errors whose first line path component
 * matches one of those (relative to the clone root).
 */
export async function runTsc(
  tsconfigPath: string,
  changedAbsPaths: string[],
): Promise<ValidationResult> {
  const startedAt = Date.now();
  const cwd = CLONE_ROOT;
  const relChanged = new Set(
    changedAbsPaths
      .map(p => relative(cwd, p))
      // normalize to POSIX for matching against tsc output
      .map(p => p.replace(/\\/g, '/')),
  );

  try {
    const { stdout } = await exec(
      TSC_BIN,
      [...TSC_ARGS_PREFIX, '--noEmit', '-p', tsconfigPath],
      {
        cwd,
        timeout: TSC_TIMEOUT_MS,
        maxBuffer: 50 * 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: '0' },
      },
    );
    // tsc prints nothing on success.
    const raw = stdout.toString();
    return {
      ok: true,
      raw,
      relevantErrors: [],
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    // Non-zero exit from tsc → there are errors. Extract them.
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; code?: number; killed?: boolean };
    if (e.killed) {
      return {
        ok: false,
        error: `tsc timed out after ${Math.round(TSC_TIMEOUT_MS / 1000)}s`,
        elapsedMs: Date.now() - startedAt,
      };
    }
    const raw = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    const relevantErrors = filterErrorsToChangedFiles(raw, relChanged);
    const relevantCount = relevantErrors.length;
    console.log(`${LOG_PREFIX} tsc produced ${raw.split('\n').length} lines, ${relevantCount} relevant to changed files`);
    return {
      ok: relevantCount === 0, // tsc failed overall, but none of the errors are OURS → not our problem
      raw,
      relevantErrors,
      elapsedMs: Date.now() - startedAt,
    };
  }
}

/**
 * tsc error line format:
 *   services/gateway/src/routes/tasks.test.ts(21,27): error TS2307: Cannot find module '../src/routes/tasks'
 *
 * We keep the line IF the path before `(` matches one of our changed
 * files. We ALSO include continuation lines (ones that don't start with
 * a path) that immediately follow a kept line, so multi-line diagnostic
 * bodies aren't truncated.
 */
export function filterErrorsToChangedFiles(
  rawTscOutput: string,
  changedRelPaths: Set<string>,
): string[] {
  const lines = rawTscOutput.split(/\r?\n/);
  const out: string[] = [];
  let keeping = false;
  for (const line of lines) {
    // Match lines like `path(L,C): error TSxxxx: ...`
    const m = line.match(/^([^\s(][^(]+?)\(\d+,\d+\):\s*(error|warning)\s/);
    if (m) {
      const p = m[1].replace(/\\/g, '/');
      keeping = changedRelPaths.has(p);
      if (keeping) out.push(line);
    } else if (keeping && line.trim().length > 0) {
      // continuation of a kept diagnostic (e.g. "Overload 1 of 2…")
      out.push(line);
    } else {
      keeping = false;
    }
  }
  return out;
}
