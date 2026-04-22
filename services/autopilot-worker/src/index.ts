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
import { claimNextTask, completeTask, failTask, queueDepth } from './queue';
import { runClaude } from './claude';

const LOG_PREFIX = '[autopilot-worker]';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5_000);
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS || 600_000); // 10 min
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 1);
const PID_FILE = process.env.AUTOPILOT_WORKER_PIDFILE
  || `${process.env.HOME || '/tmp'}/.local/share/autopilot-worker.pid`;

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
    const result = await runClaude(prompt, {
      model: row.input_payload.model,
      timeoutMs: TASK_TIMEOUT_MS,
    });
    const elapsed = Math.round((Date.now() - started) / 1000);

    if (!result.ok || !result.text) {
      log(`  task ${row.id.slice(0, 8)} failed after ${elapsed}s: ${result.error}`);
      await failTask(row.id, result.error || 'claude returned no text');
      return;
    }

    log(`  task ${row.id.slice(0, 8)} ok in ${elapsed}s (${result.usage?.input_tokens ?? '?'} in / ${result.usage?.output_tokens ?? '?'} out, stop=${result.stop_reason ?? '?'})`);
    await completeTask(row.id, {
      text: result.text,
      usage: result.usage,
      extra: {
        worker_id: wid,
        duration_ms: result.duration_ms,
        stop_reason: result.stop_reason,
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
