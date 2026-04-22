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
import { runTsc } from './validate';
import { buildRetryPrompt } from './retry';

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

/**
 * Run an execute task through the validation retry loop.
 *
 * - Ask Claude, parse output, apply files to a scratch clone.
 * - Run tsc --noEmit on the whole project, keep only errors that mention
 *   files we just wrote.
 * - If green: return the most-recent Claude output.
 * - If red: build a retry prompt and go again, up to VALIDATION_MAX_ATTEMPTS.
 *
 * The gateway still owns PR creation via the GitHub Contents API — this
 * function just increases confidence that the output will pass CI once
 * the gateway writes it.
 */
async function runExecuteWithValidation(
  basePrompt: string,
  model: string | undefined,
): Promise<{ ok: boolean; text?: string; usage?: RunClaudeResult['usage']; error?: string; attempts: number; validation_elapsed_ms: number }> {
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

    if (tsc.ok) {
      log(`  attempt ${attempt + 1} PASSED validation in ${Math.round(tsc.elapsedMs / 1000)}s (${parsed.files.length} files applied)`);
      await resetClean();
      return {
        ok: true,
        text: claudeResult.text,
        usage: claudeResult.usage,
        attempts: attempt + 1,
        validation_elapsed_ms: validationElapsedTotal,
      };
    }

    const errCount = (tsc.relevantErrors || []).length;
    lastError = tsc.error || `${errCount} tsc error(s) in changed files`;
    log(`  attempt ${attempt + 1} FAILED validation in ${Math.round(tsc.elapsedMs / 1000)}s — ${errCount} relevant tsc error(s)`);
    currentPrompt = buildRetryPrompt(
      basePrompt,
      claudeResult.text,
      tsc.relevantErrors && tsc.relevantErrors.length > 0
        ? tsc.relevantErrors
        : [tsc.error || 'tsc failed with no specific errors extracted'],
      attempt,
    );
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
    const result = shouldValidate
      ? await runExecuteWithValidation(prompt, row.input_payload.model)
      : await (async () => {
          const r = await runClaude(prompt, { model: row.input_payload.model, timeoutMs: TASK_TIMEOUT_MS });
          return { ok: r.ok, text: r.text, usage: r.usage, error: r.error, attempts: 1, validation_elapsed_ms: 0 } as const;
        })();
    const elapsed = Math.round((Date.now() - started) / 1000);

    if (!result.ok || !result.text) {
      log(`  task ${row.id.slice(0, 8)} failed after ${elapsed}s (${result.attempts} attempt${result.attempts === 1 ? '' : 's'}): ${result.error}`);
      await failTask(row.id, result.error || 'claude returned no text');
      return;
    }

    log(`  task ${row.id.slice(0, 8)} ok in ${elapsed}s across ${result.attempts} attempt${result.attempts === 1 ? '' : 's'} (${result.usage?.input_tokens ?? '?'} in / ${result.usage?.output_tokens ?? '?'} out)`);
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
