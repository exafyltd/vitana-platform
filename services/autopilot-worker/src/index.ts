/**
 * Dev Autopilot worker — main loop.
 *
 * Polls Supabase for pending LLM tasks, runs each through Claude Code (which
 * uses the user's Claude subscription auth), writes the result back.
 *
 * Run with:
 *   cd services/autopilot-worker
 *   npm install
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... npm run dev
 *
 * Requires `claude` (Claude Code CLI) to be installed and logged in (one-time
 * `claude login`). The subprocess inherits the CLI's auth.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { hostname, userInfo } from 'os';
import { claimNextTask, completeTask, failTask, queueDepth, type QueueRow } from './queue';
import { runClaude, type RunClaudeResult } from './claude';
import { parseExecutionOutput } from './parse';
import { applyFiles, fetchAndReset, resetClean } from './repo';
import { runTsc, runJest } from './validate';
import { join } from 'path';
import { CLONE_ROOT } from './repo';
import { buildRetryPrompt } from './retry';
import { createBranch, putFileToBranch, deleteFileOnBranch, fetchFileContent, openPullRequest } from './github';
import type { ExecutionFile } from './parse';

const LOG_PREFIX = '[autopilot-worker]';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5_000);
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS || 600_000); // 10 min
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 1);
const PID_FILE = process.env.AUTOPILOT_WORKER_PIDFILE
  || `${process.env.HOME || '/tmp'}/.local/share/autopilot-worker.pid`;

// Pre-PR validation — run tsc on Claude's output before returning it to the
// gateway. If tsc finds errors in files we just changed, feed them back and
// ask Claude to correct its output. Up to VALIDATION_MAX_ATTEMPTS total.
const VALIDATION_ENABLED = (process.env.AUTOPILOT_WORKER_VALIDATE || 'true').toLowerCase() !== 'false';
const VALIDATION_MAX_ATTEMPTS = Number(process.env.AUTOPILOT_WORKER_VALIDATION_MAX_ATTEMPTS || 3);
const VALIDATION_TSCONFIG = process.env.AUTOPILOT_WORKER_TSCONFIG
  || 'services/gateway/tsconfig.json';
const VALIDATION_BASE_BRANCH = process.env.AUTOPILOT_WORKER_BASE_BRANCH || 'main';
// Directory containing the jest.config.js that owns the changed test files.
// jest needs to be invoked from this directory so its `roots` resolve.
const VALIDATION_JEST_PROJECT_DIR = process.env.AUTOPILOT_WORKER_JEST_PROJECT_DIR
  || 'services/gateway';
// jest can be slow + flaky for some tests. The worker can skip jest and rely
// on tsc-only validation by setting AUTOPILOT_WORKER_RUN_JEST=false.
const RUN_JEST = (process.env.AUTOPILOT_WORKER_RUN_JEST || 'true').toLowerCase() !== 'false';

let running = 0;
let shuttingDown = false;

/**
 * Write our PID to PID_FILE. If a stale file exists pointing at a process
 * that's no longer running, overwrite it. If it points at a LIVE process,
 * exit — we don't want to run two workers simultaneously (Claude Code CLI
 * is single-session per auth and two `claude -p` calls from the same host
 * compete for the same stdio context).
 */
function claimPidFile(): void {
  if (existsSync(PID_FILE)) {
    try {
      const other = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
      if (Number.isFinite(other) && other > 0 && other !== process.pid) {
        try {
          process.kill(other, 0); // probe — throws if not alive
          console.error(`${LOG_PREFIX} another worker is already running (pid ${other} in ${PID_FILE}). Exiting.`);
          process.exit(0);
        } catch {
          // stale — fall through to overwrite
        }
      }
    } catch { /* unreadable — overwrite */ }
  }
  writeFileSync(PID_FILE, String(process.pid));
}

function releasePidFile(): void {
  try {
    if (existsSync(PID_FILE)) {
      const n = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
      if (n === process.pid) unlinkSync(PID_FILE);
    }
  } catch { /* best effort */ }
}

function workerId(): string {
  return `${userInfo().username}@${hostname()}/pid${process.pid}`;
}

function log(msg: string, ...rest: unknown[]): void {
  const ts = new Date().toISOString();
  console.log(`${ts} ${LOG_PREFIX} ${msg}`, ...rest);
}

interface ValidatedExecuteResult {
  ok: boolean;
  text?: string;
  /** Parsed files from the FINAL validated attempt. Caller can publish
   * these directly to GitHub instead of re-parsing the text. */
  files?: ExecutionFile[];
  pr_title?: string;
  pr_body?: string;
  usage?: RunClaudeResult['usage'];
  error?: string;
  attempts: number;
  validation_elapsed_ms: number;
}

/**
 * Run an execute task through the validation retry loop.
 *
 * - Ask Claude, parse output, apply files to a scratch clone.
 * - Run tsc --noEmit on the whole project, keep only errors that mention
 *   files we just wrote.
 * - If green: return the most-recent Claude output.
 * - If red: build a retry prompt and go again, up to VALIDATION_MAX_ATTEMPTS.
 *
 * Returns parsed files alongside the raw text — the caller can either hand
 * the text back to the gateway (legacy path) or publish the files itself
 * via the GitHub API (worker-owned-PR path).
 */
async function runExecuteWithValidation(
  basePrompt: string,
  model: string | undefined,
): Promise<ValidatedExecuteResult> {
  let currentPrompt = basePrompt;
  let lastOutput: string | undefined;
  let lastError = 'no attempts ran';
  let validationElapsedTotal = 0;

  // Reset the clone once up front so we start from a known clean state.
  const fr = await fetchAndReset(VALIDATION_BASE_BRANCH);
  if (!fr.ok) {
    // Clone infrastructure broken → skip validation entirely, fall back to
    // single-shot behaviour (raw Claude call, return whatever it emits).
    log(`validation clone unavailable (${fr.error}) — falling back to no-validate path`);
    const raw = await runClaude(basePrompt, { model, timeoutMs: TASK_TIMEOUT_MS });
    return {
      ok: raw.ok,
      text: raw.text,
      usage: raw.usage,
      error: raw.error,
      attempts: 1,
      validation_elapsed_ms: 0,
    };
  }

  for (let attempt = 0; attempt < VALIDATION_MAX_ATTEMPTS; attempt++) {
    const claudeResult = await runClaude(currentPrompt, { model, timeoutMs: TASK_TIMEOUT_MS });
    if (!claudeResult.ok || !claudeResult.text) {
      return {
        ok: false,
        error: claudeResult.error || 'claude returned no text',
        attempts: attempt + 1,
        validation_elapsed_ms: validationElapsedTotal,
      };
    }
    lastOutput = claudeResult.text;

    const parsed = parseExecutionOutput(claudeResult.text);
    if ('error' in parsed) {
      lastError = `parse: ${parsed.error}`;
      log(`  attempt ${attempt + 1} parse failed: ${parsed.error}`);
      currentPrompt = buildRetryPrompt(basePrompt, claudeResult.text, [parsed.error], attempt);
      continue;
    }

    // Fetch fresh each attempt — previous attempt may have left files around.
    await fetchAndReset(VALIDATION_BASE_BRANCH);
    const applied = await applyFiles(parsed.files);
    if (!applied.ok || !applied.paths) {
      lastError = `apply: ${applied.error}`;
      log(`  attempt ${attempt + 1} apply failed: ${applied.error}`);
      currentPrompt = buildRetryPrompt(basePrompt, claudeResult.text, [applied.error || 'apply failed'], attempt);
      continue;
    }

    const tsc = await runTsc(VALIDATION_TSCONFIG, applied.paths);
    validationElapsedTotal += tsc.elapsedMs;

    if (!tsc.ok) {
      const errCount = (tsc.relevantErrors || []).length;
      lastError = tsc.error || `${errCount} tsc error(s) in changed files`;
      log(`  attempt ${attempt + 1} FAILED tsc in ${Math.round(tsc.elapsedMs / 1000)}s — ${errCount} relevant error(s)`);
      currentPrompt = buildRetryPrompt(
        basePrompt,
        claudeResult.text,
        tsc.relevantErrors && tsc.relevantErrors.length > 0
          ? tsc.relevantErrors
          : [tsc.error || 'tsc failed with no specific errors extracted'],
        attempt,
      );
      continue;
    }

    // tsc passed. Now run jest --findRelatedTests on the same paths so
    // logic-level bugs (Claude's test asserts the wrong shape, mocks the
    // wrong module, etc.) get caught before the gateway opens the PR.
    // The class of bug we just hit on PR #844 (memory.test.ts compiled
    // fine but its assertions failed at runtime) is exactly what this
    // catches.
    if (!RUN_JEST) {
      log(`  attempt ${attempt + 1} PASSED tsc in ${Math.round(tsc.elapsedMs / 1000)}s (jest skipped)`);
      await resetClean();
      return {
        ok: true,
        text: claudeResult.text,
        files: parsed.files,
        pr_title: parsed.pr_title,
        pr_body: parsed.pr_body,
        usage: claudeResult.usage,
        attempts: attempt + 1,
        validation_elapsed_ms: validationElapsedTotal,
      };
    }

    const jest = await runJest(join(CLONE_ROOT, VALIDATION_JEST_PROJECT_DIR), applied.paths);
    validationElapsedTotal += jest.elapsedMs;

    if (jest.ok) {
      log(`  attempt ${attempt + 1} PASSED tsc + jest (${jest.testsPassed}/${jest.testsRun} tests) in ${Math.round((tsc.elapsedMs + jest.elapsedMs) / 1000)}s`);
      await resetClean();
      return {
        ok: true,
        text: claudeResult.text,
        files: parsed.files,
        pr_title: parsed.pr_title,
        pr_body: parsed.pr_body,
        usage: claudeResult.usage,
        attempts: attempt + 1,
        validation_elapsed_ms: validationElapsedTotal,
      };
    }

    const failCount = (jest.failures || []).length;
    lastError = jest.error || `${jest.testsFailed}/${jest.testsRun} jest test(s) failed`;
    log(`  attempt ${attempt + 1} FAILED jest in ${Math.round(jest.elapsedMs / 1000)}s — ${failCount} failure(s) (${jest.testsPassed}/${jest.testsRun} passed)`);
    // Feed the jest failures back to Claude — labeling them so it knows
    // these are runtime assertion errors, not type errors.
    const jestErrorBlock = jest.failures && jest.failures.length > 0
      ? jest.failures.map(f => `[jest] ${f}`)
      : [`[jest] ${jest.error || `${jest.testsFailed} test(s) failed (no specific failure messages extracted)`}`];
    currentPrompt = buildRetryPrompt(basePrompt, claudeResult.text, jestErrorBlock, attempt);
  }

  // All attempts exhausted. Return the last output anyway — some classes of
  // failure (e.g. pre-existing broken types in an unrelated file that our
  // filter didn't catch) are fixable by human review of the open PR.
  await resetClean();
  return {
    ok: false,
    text: lastOutput,
    attempts: VALIDATION_MAX_ATTEMPTS,
    error: `validation exhausted ${VALIDATION_MAX_ATTEMPTS} attempts: ${lastError}`,
    validation_elapsed_ms: validationElapsedTotal,
  };
}

/**
 * Worker-owned PR creation. After validation succeeds the worker holds the
 * canonical file contents in memory; instead of returning text to the gateway
 * and asking it to write the files via the GitHub API (which kept dying when
 * Cloud Run recycled the container mid-write), the worker publishes them
 * itself in a single in-process sequence: branch → files → PR.
 *
 * Returns the PR url + number to write back to the queue row's output
 * payload — the gateway picks those up and advances the execution state to
 * 'ci' for the watcher to take over from there.
 */
async function publishToGitHub(
  files: ExecutionFile[],
  prTitle: string,
  prBody: string,
  branch: string,
  baseBranch: string,
  vtidLike: string,
): Promise<{ ok: boolean; pr_url?: string; pr_number?: number; error?: string }> {
  // Look up current shas for any "modify" / "delete" targets — GitHub's PUT
  // and DELETE on /contents both require the existing blob sha.
  const shaCache = new Map<string, string>();
  for (const f of files) {
    if (f.action === 'modify' || f.action === 'delete') {
      const existing = await fetchFileContent(f.path, baseBranch);
      if (existing.exists && existing.sha) {
        shaCache.set(f.path, existing.sha);
      }
    }
  }

  const branchR = await createBranch(branch, baseBranch);
  if (!branchR.ok) return { ok: false, error: `create branch: ${branchR.error}` };

  for (const f of files) {
    if (f.action === 'delete') {
      const sha = shaCache.get(f.path);
      if (!sha) {
        log(`  publishToGitHub: skip delete for ${f.path} (not present on ${baseBranch})`);
        continue;
      }
      const dr = await deleteFileOnBranch(branch, f.path, `${vtidLike}: delete ${f.path}`, sha);
      if (!dr.ok) return { ok: false, error: `delete ${f.path}: ${dr.error}` };
      continue;
    }
    if (typeof f.content !== 'string') {
      return { ok: false, error: `file ${f.path} missing content for action=${f.action}` };
    }
    const wr = await putFileToBranch(
      branch,
      f.path,
      f.content,
      `${vtidLike}: ${f.action} ${f.path}`,
      shaCache.get(f.path),
    );
    if (!wr.ok) return { ok: false, error: `write ${f.path}: ${wr.error}` };
  }

  const pr = await openPullRequest(branch, baseBranch, prTitle, prBody);
  if (!pr.ok) return { ok: false, error: `open PR: ${pr.error}` };
  return { ok: true, pr_url: pr.url, pr_number: pr.number };
}

async function handleTask(wid: string): Promise<void> {
  if (running >= MAX_CONCURRENT) return;
  running++;
  try {
    const row = await claimNextTask(wid);
    if (!row) return;

    log(`claimed task ${row.id.slice(0, 8)} kind=${row.kind} finding=${row.finding_id.slice(0, 8)} attempts=${row.attempts}`);

    const prompt = row.input_payload?.prompt;
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      await failTask(row.id, 'input_payload.prompt is missing or empty');
      return;
    }

    const started = Date.now();
    const shouldValidate = VALIDATION_ENABLED && row.kind === 'execute';
    const result: ValidatedExecuteResult = shouldValidate
      ? await runExecuteWithValidation(prompt, row.input_payload.model)
      : await (async () => {
          const r = await runClaude(prompt, { model: row.input_payload.model, timeoutMs: TASK_TIMEOUT_MS });
          return { ok: r.ok, text: r.text, usage: r.usage, error: r.error, attempts: 1, validation_elapsed_ms: 0 };
        })();
    const elapsed = Math.round((Date.now() - started) / 1000);

    if (!result.ok || !result.text) {
      log(`  task ${row.id.slice(0, 8)} failed after ${elapsed}s (${result.attempts} attempt${result.attempts === 1 ? '' : 's'}): ${result.error}`);
      await failTask(row.id, result.error || 'claude returned no text');
      return;
    }

    log(`  task ${row.id.slice(0, 8)} ok in ${elapsed}s across ${result.attempts} attempt${result.attempts === 1 ? '' : 's'} (${result.usage?.input_tokens ?? '?'} in / ${result.usage?.output_tokens ?? '?'} out)`);

    // Worker-owned-PR path: when the gateway opted in by setting
    // input_payload.worker_owns_pr=true, the worker creates the branch +
    // writes files + opens the PR itself, then writes pr_url back to the
    // queue row. This avoids the gateway / Cloud Run instability that kept
    // killing fire-and-forget runExecutionSession promises.
    const ownsPr = row.input_payload?.worker_owns_pr === true && row.kind === 'execute';
    if (ownsPr && result.files && result.pr_title && result.pr_body) {
      const branch = row.input_payload?.branch_name as string
        || `dev-autopilot/${(row.execution_id || row.id).slice(0, 8)}`;
      const baseBranch = (row.input_payload?.base_branch as string) || 'main';
      const vtidLike = (row.input_payload?.vtid_like as string)
        || `VTID-DA-${(row.execution_id || row.id).slice(0, 8)}`;
      log(`  publishing PR for task ${row.id.slice(0, 8)}: branch=${branch} files=${result.files.length}`);
      const pub = await publishToGitHub(result.files, result.pr_title, result.pr_body, branch, baseBranch, vtidLike);
      if (!pub.ok) {
        log(`  PR publish FAILED for ${row.id.slice(0, 8)}: ${pub.error}`);
        await failTask(row.id, `publish PR: ${pub.error}`);
        return;
      }
      log(`  PR opened: ${pub.pr_url}`);
      await completeTask(row.id, {
        text: result.text,
        usage: result.usage,
        extra: {
          worker_id: wid,
          attempts: result.attempts,
          validated: shouldValidate,
          validation_elapsed_ms: result.validation_elapsed_ms,
          // Fields the gateway watches for to advance execution row → 'ci'
          worker_owns_pr: true,
          pr_url: pub.pr_url,
          pr_number: pub.pr_number,
          branch,
        },
      });
      return;
    }

    await completeTask(row.id, {
      text: result.text,
      usage: result.usage,
      extra: {
        worker_id: wid,
        attempts: result.attempts,
        validated: shouldValidate,
        validation_elapsed_ms: result.validation_elapsed_ms,
      },
    });
  } catch (err) {
    log(`unhandled error in handleTask:`, err);
  } finally {
    running--;
  }
}

async function mainLoop(): Promise<void> {
  claimPidFile();
  const wid = workerId();
  log(`starting — worker_id=${wid} pid_file=${PID_FILE} poll=${POLL_INTERVAL_MS}ms task_timeout=${TASK_TIMEOUT_MS}ms max_concurrent=${MAX_CONCURRENT}`);

  const depth = await queueDepth();
  if ('error' in depth) {
    log(`initial queueDepth check failed: ${depth.error} — refusing to start`);
    process.exit(2);
  }
  log(`queue depth at startup: pending=${depth.pending} running=${depth.running}`);

  while (!shuttingDown) {
    try {
      await handleTask(wid);
    } catch (err) {
      log('mainLoop handleTask error:', err);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  log('shutdown complete');
}

// Graceful shutdown — also release the PID file so a new worker can claim it.
process.on('exit', releasePidFile);
process.on('SIGINT', () => {
  log('SIGINT — draining before exit…');
  shuttingDown = true;
  const wait = setInterval(() => {
    if (running === 0) {
      releasePidFile();
      clearInterval(wait);
      process.exit(0);
    }
  }, 500);
});
process.on('SIGTERM', () => {
  log('SIGTERM — draining before exit…');
  shuttingDown = true;
  const wait = setInterval(() => {
    if (running === 0) {
      releasePidFile();
      clearInterval(wait);
      process.exit(0);
    }
  }, 500);
});

mainLoop().catch(err => {
  log('fatal:', err);
  process.exit(1);
});
