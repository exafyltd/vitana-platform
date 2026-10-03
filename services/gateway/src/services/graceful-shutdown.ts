/**
 * VTID-04835: the gateway's one SIGTERM / SIGINT handler.
 *
 * Before this there was none anywhere in the gateway. The container runs
 * `node dist/index.js` as PID 1 (Dockerfile CMD, no init), and Linux ignores a
 * signal with the default disposition for PID 1 — so when ECS replaced a task
 * (deploy, scale-in, unhealthy replacement) SIGTERM did nothing, the task sat
 * until SIGKILL at stopTimeout (ECS default 30 s; neither deploy workflow
 * sets it, they clone the live task definition), and every live ORB voice
 * session on it ended with no `vtid.live.session.stop` and no
 * voice_session_facts end.
 *
 * On the first signal:
 *   1. drain hooks run, each bounded (`emitShutdownStopsForLiveSessions`
 *      bounds itself to `drainTimeoutMs`, default 5 s; the whole drain is
 *      also raced against that bound here so a hook that ignores it cannot
 *      hold the task);
 *   2. the HTTP server stops accepting connections (`server.close()`);
 *   3. the process exits 0 once the server has closed, or after
 *      `closeGraceMs` (default 2 s) — open WebSockets / keep-alive sockets
 *      would otherwise keep `close()` pending until SIGKILL.
 * Total worst case ≈ drain + grace ≈ 7 s, well inside 30 s. ECS deregisters
 * the target from the ALB (and waits its deregistration delay) before it
 * sends SIGTERM, so no new traffic arrives during the drain.
 *
 * A second signal while draining is ignored (the first drain is already
 * bounded). Nothing here throws.
 */

import type { Server } from 'http';

export interface GracefulShutdownOptions {
  /** Bound for the drain hooks, in ms (default 5000). */
  drainTimeoutMs?: number;
  /** How long to wait for `server.close()` before exiting anyway (default 2000). */
  closeGraceMs?: number;
  /** Work to finish before the server closes. Each must be bounded itself. */
  drainHooks?: Array<(signal: string) => Promise<unknown>>;
  /** Injected for tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Injected for tests; defaults to `console`. */
  logger?: Pick<Console, 'log' | 'warn'>;
}

export type ShutdownHandler = (signal: string) => Promise<void>;

function boundedRace<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const bound = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, ms));
    if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  });
  return Promise.race([p, bound]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Build the shutdown handler (exported for tests; `installGracefulShutdown`
 * wires it to the process signals).
 */
export function createShutdownHandler(
  server: Pick<Server, 'close'> | null,
  opts: GracefulShutdownOptions = {},
): ShutdownHandler {
  const drainTimeoutMs = opts.drainTimeoutMs ?? 5_000;
  const closeGraceMs = opts.closeGraceMs ?? 2_000;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const log = opts.logger ?? console;
  let started: Promise<void> | null = null;

  return (signal: string): Promise<void> => {
    if (started) {
      log.log(`[VTID-04835] ${signal} received again — shutdown already in progress`);
      return started;
    }
    started = (async () => {
      const t0 = Date.now();
      log.log(`[VTID-04835] ${signal} received — draining (bound ${drainTimeoutMs}ms) before shutdown`);
      try {
        const hooks = (opts.drainHooks ?? []).map((h) =>
          Promise.resolve()
            .then(() => h(signal))
            .catch((err) => log.warn(`[VTID-04835] drain hook failed: ${err instanceof Error ? err.message : String(err)}`)),
        );
        const outcome = await boundedRace(Promise.allSettled(hooks), drainTimeoutMs);
        if (outcome === 'timeout') log.warn(`[VTID-04835] drain hit its ${drainTimeoutMs}ms bound — continuing shutdown`);
      } catch {
        /* never throw from a signal handler */
      }
      log.log(`[VTID-04835] drain done in ${Date.now() - t0}ms — closing HTTP server`);

      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        const t = setTimeout(finish, Math.max(0, closeGraceMs));
        if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
        try {
          if (server) server.close(() => { clearTimeout(t); finish(); });
          else { clearTimeout(t); finish(); }
        } catch {
          clearTimeout(t);
          finish();
        }
      });
      log.log(`[VTID-04835] shutdown complete in ${Date.now() - t0}ms — exiting`);
      try {
        exit(0);
      } catch {
        /* injected exit in tests may throw; nothing to do */
      }
    })();
    return started;
  };
}

let installed = false;

/**
 * Register the handler on SIGTERM and SIGINT, once per process. Returns the
 * handler (or null if already installed).
 */
export function installGracefulShutdown(
  server: Pick<Server, 'close'> | null,
  opts: GracefulShutdownOptions = {},
): ShutdownHandler | null {
  if (installed) return null;
  installed = true;
  const handler = createShutdownHandler(server, opts);
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      void handler(sig);
    });
  }
  return handler;
}
