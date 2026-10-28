/**
 * VTID-05274 — the Project Manager loop (plan kiro-autonomy-fallback §5 C6).
 *
 * `startPmLoop` runs one tick every `PM_TICK_INTERVAL_MS` (default 2 min): in
 * `PM_MODE=live` the full observe → decide → act tick (`runActTick`, which takes
 * the pm_lease first and acts only while holding it); otherwise the decide-only
 * tick (`runDecideTick`). Overlapping ticks are skipped; a tick error is logged,
 * never thrown. `pmMode()`'s default stays `dry_run`.
 *
 * `liveLoopDeps()` wires the production seams: the GitHub observer, safe-merge
 * (routes/cicd.ts — the only merge path), the pm-agent GitHub writer, the
 * Operator Chat Gate 2 poster, the PostgREST pm_lease, update-branch and the
 * ledger writer. No deploy, dispatch or VTID allocation seam exists.
 */
import { pmMode, pmTickIntervalMs, pmLeaseTtlMs } from './config';
import { runActTick, runDecideTick } from './index';
import type { ActDeps } from './act';
import type { PmObserver } from './observe';
import type { PmDecisionEmitter } from './emit';
import { summarizeDecision } from './emit';

export interface PmLoopDeps {
  observer?: PmObserver;
  emitter?: PmDecisionEmitter;
  /** The act seams; without them a `live` tick only decides. */
  act?: ActDeps;
  now?: () => number;
}

export interface StartPmLoopOptions {
  /** Built lazily on the first tick and reused (the observer keeps its blob cache). */
  deps: () => PmLoopDeps;
  intervalMs?: number;
  setIntervalFn?: (fn: () => void, ms: number) => { unref?: () => void };
  clearIntervalFn?: (h: unknown) => void;
  log?: (msg: string) => void;
}

export interface PmLoop {
  tick(): Promise<void>;
  stop(): void;
}

export function startPmLoop(opts: StartPmLoopOptions): PmLoop {
  const log = opts.log ?? ((m: string) => console.log(m));
  const setI = opts.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearI = opts.clearIntervalFn ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout));
  let running = false;
  let built: PmLoopDeps | null = null;

  const tick = async (): Promise<void> => {
    if (running) return; // skip if a previous tick is still running
    running = true;
    try {
      const deps = built ?? (built = opts.deps());
      const mode = pmMode();
      if (mode === 'live' && deps.act) {
        const { decisions, act } = await runActTick({ observer: deps.observer, emitter: deps.emitter, now: deps.now, act: deps.act });
        if (decisions.length > 0 || !act.acted) {
          const acted = act.acted ? act.results.map((r) => `${r.status}: ${summarizeDecision(r.decision)}`).join('; ') : `not acted (${act.skipped_reason})`;
          log(`[PM] mode=live decisions=${decisions.length} ${acted}`);
        }
      } else {
        const decisions = await runDecideTick({ observer: deps.observer, emitter: deps.emitter, now: deps.now });
        if (decisions.length > 0) log(`[PM] mode=${mode} decisions=${decisions.length} (reported only, no act)`);
      }
    } catch (err) {
      console.warn('[PM] tick error:', (err as Error)?.message || err);
    } finally {
      running = false;
    }
  };

  const handle = setI(() => { void tick(); }, opts.intervalMs ?? pmTickIntervalMs());
  handle?.unref?.();
  return { tick, stop: () => clearI(handle) };
}

/** The production seams (lazy requires keep the module graph light in tests). */
export function liveLoopDeps(): PmLoopDeps {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { GithubObserver, GithubRestReader, SupabasePmDataReader } = require('./observe-live') as typeof import('./observe-live');
  const { GithubRepoFileWriter, GithubRestWriteClient, githubUpdateBranch, SupabaseLedgerWriter } = require('./writers') as typeof import('./writers');
  const { OperatorChatGate2Poster, RunViewGate2EvidenceResolver, SupabaseGate2Store, liveGate2SourceDeps } = require('./gate2') as typeof import('./gate2');
  const { PgLeaseManager, PostgrestLeaseClient } = require('./lease') as typeof import('./lease');
  const { safeMerge } = require('../../routes/cicd') as typeof import('../../routes/cicd');
  /* eslint-enable @typescript-eslint/no-var-requires */
  return {
    observer: new GithubObserver({ gh: new GithubRestReader(), data: new SupabasePmDataReader() }),
    act: {
      safeMerge,
      laneWriter: new GithubRepoFileWriter(new GithubRestWriteClient()),
      gate2Poster: new OperatorChatGate2Poster(new SupabaseGate2Store()),
      gate2Evidence: new RunViewGate2EvidenceResolver(liveGate2SourceDeps()),
      lease: new PgLeaseManager(new PostgrestLeaseClient(), pmLeaseTtlMs()),
      holder: `pm-${process.env.ECS_TASK_ID || process.env.HOSTNAME || process.pid}`,
      updateBranch: githubUpdateBranch,
      ledgerWriter: new SupabaseLedgerWriter(),
    },
  };
}
