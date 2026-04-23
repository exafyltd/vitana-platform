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

// =============================================================================
// jest validation — run `jest --findRelatedTests` on changed paths
// =============================================================================

const JEST_TIMEOUT_MS = 180_000; // 3 min — most route tests run in <30s; pad for cold ts-jest start
const JEST_BIN = process.env.AUTOPILOT_WORKER_JEST_BIN || 'npx';
const JEST_ARGS_PREFIX = JEST_BIN === 'npx' ? ['jest'] : [];

export interface JestResult {
  ok: boolean;
  /** Truncated jest stdout — useful for the retry prompt. */
  raw?: string;
  /** Compact human-readable failure descriptions, one per failed assertion. */
  failures?: string[];
  /** Tests jest actually ran (so we can tell "no tests touched" from "all passed"). */
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  elapsedMs: number;
  error?: string;
}

interface JestJsonReport {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  testResults?: Array<{
    name: string;
    testResults?: Array<{
      ancestorTitles?: string[];
      title?: string;
      status?: string;
      failureMessages?: string[];
    }>;
  }>;
}

/**
 * Run jest with --findRelatedTests over the changed files. Targets ONLY tests
 * that exercise paths we touched, so we don't pay for the whole suite.
 *
 * paths: absolute paths returned by repo.applyFiles().
 * jestProjectDir: absolute path of the directory containing jest.config.js
 *                 (typically <CLONE_ROOT>/services/gateway).
 */
export async function runJest(
  jestProjectDir: string,
  changedAbsPaths: string[],
): Promise<JestResult> {
  const startedAt = Date.now();
  if (changedAbsPaths.length === 0) {
    return { ok: true, testsRun: 0, testsPassed: 0, testsFailed: 0, elapsedMs: 0, raw: '' };
  }

  // Pass paths relative to the jest project so jest's own resolver matches.
  const relPaths = changedAbsPaths.map(p => relative(jestProjectDir, p).replace(/\\/g, '/'));
  // Strip files outside the jest project (e.g. supabase/migrations changes
  // cited in the same plan would confuse jest).
  const inProject = relPaths.filter(p => !p.startsWith('..'));
  if (inProject.length === 0) {
    return { ok: true, testsRun: 0, testsPassed: 0, testsFailed: 0, elapsedMs: 0, raw: '(no files inside the jest project)' };
  }

  // --json gives us a structured report we can parse instead of guessing
  // from terminal output. --passWithNoTests so a non-test file with no
  // dependent tests doesn't trip on "no tests found".
  const args = [
    ...JEST_ARGS_PREFIX,
    '--findRelatedTests',
    ...inProject,
    '--passWithNoTests',
    '--json',
    '--silent',
    '--no-coverage',
    '--testTimeout=30000',
  ];

  let stdout = '';
  let stderr = '';
  try {
    const r = await exec(JEST_BIN, args, {
      cwd: jestProjectDir,
      timeout: JEST_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0', CI: 'true' },
    });
    stdout = r.stdout.toString();
    stderr = r.stderr.toString();
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; code?: number; killed?: boolean };
    if (e.killed) {
      return {
        ok: false,
        error: `jest timed out after ${Math.round(JEST_TIMEOUT_MS / 1000)}s`,
        testsRun: 0, testsPassed: 0, testsFailed: 0,
        elapsedMs: Date.now() - startedAt,
      };
    }
    stdout = e.stdout ? e.stdout.toString() : '';
    stderr = e.stderr ? e.stderr.toString() : '';
    // jest exits non-zero on failures — that's a normal "tests failed" state,
    // we still want to parse stdout for the report.
  }

  const elapsedMs = Date.now() - startedAt;
  const report = parseJestReport(stdout);
  if (!report) {
    // No parseable report — usually a config/setup error, not a test failure.
    return {
      ok: false,
      raw: (stdout + stderr).slice(-4000),
      error: 'jest produced no parseable JSON report (likely a setup error)',
      testsRun: 0, testsPassed: 0, testsFailed: 0,
      elapsedMs,
    };
  }

  const failures = extractJestFailures(report);
  const ok = failures.length === 0 && (report.numFailedTests || 0) === 0;
  console.log(
    `${LOG_PREFIX} jest ran ${report.numTotalTests || 0} test(s) in ${Math.round(elapsedMs / 1000)}s — ${report.numPassedTests || 0} passed, ${report.numFailedTests || 0} failed`,
  );
  return {
    ok,
    raw: stdout.slice(-8000),
    failures,
    testsRun: report.numTotalTests || 0,
    testsPassed: report.numPassedTests || 0,
    testsFailed: report.numFailedTests || 0,
    elapsedMs,
  };
}

/** Try to find a single JSON object in jest's stdout. Some setups print
 * setup-loader messages BEFORE the report; we just hunt for the last
 * top-level brace pair. */
export function parseJestReport(stdout: string): JestJsonReport | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  const slice = stdout.slice(start, end + 1);
  try {
    return JSON.parse(slice) as JestJsonReport;
  } catch {
    return null;
  }
}

/** Pull "TestSuite > nested > describe — assertion message (first line)"
 * for each failed test. Keeps the retry prompt small + actionable. */
export function extractJestFailures(report: JestJsonReport): string[] {
  const out: string[] = [];
  for (const file of report.testResults || []) {
    for (const t of file.testResults || []) {
      if (t.status === 'failed') {
        const fullName = [...(t.ancestorTitles || []), t.title || '(unnamed)'].join(' > ');
        const firstFailure = (t.failureMessages || [])[0] || '(no failure message)';
        // Take the first 5 lines of the failure — usually enough to see what
        // assertion failed without dragging in full stack.
        const concise = firstFailure
          .split('\n')
          .filter(l => l.trim().length > 0)
          .slice(0, 5)
          .map(l => `    ${l.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').trim()}`)
          .join('\n');
        out.push(`✗ ${fullName}\n${concise}`);
      }
    }
  }
  return out;
}
