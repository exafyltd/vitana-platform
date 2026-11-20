/**
 * Delivery loop: the runtime. Builds the real dependencies from the environment, runs the engine on a timer, and answers what the
 * loop is doing for the status route. Modelled on the Project Manager loop (services/project-manager/loop.ts): a timer that never lets
 * two ticks overlap, is unref'd so it cannot keep the process alive, and logs and carries on when a tick fails.
 *
 *   off by default       DELIVERY_LOOP_ENABLED must be exactly 'true' (controls.ts); nothing here starts a timer otherwise
 *   built lazily         the dependencies are built on the first tick, so a missing GitLab token is one logged line, never a boot failure
 *   no GitLab, no loop   without GITLAB_API_URL and GITLAB_API_TOKEN the loop does not run (it cannot observe or act), and says why
 *   one reader of state  the status is computed from the last cycle's result in this process; nothing is stored outside OASIS
 */
import { isAutopilotExecutionArmed } from '../system-controls-service';
import { gitlabClientFromEnv } from './gitlab-client';
import { projectsFrom, isLoopEnabled, autonomyFrom } from './controls';
import { createOasisLedger } from './ledger';
import { createEngine, DEFAULT_CYCLE_MS, type CycleResult, type Engine } from './engine';
import { createExecutorTaskPort, createLearnPort, createReviewerPort, executorFromEnv, type ExecutorGateway, type Llm, type DevMemoryWriter, type PatternStore } from './adapters';
import { createDevAutopilotGitlabGateway } from './dev-autopilot-gateway';
import type { LoopDeps } from './context';
import type { ReviewerPort } from './ports';

/** What the runtime needs from the rest of the gateway, so it is tested without any of it. */
export interface RuntimeBindings {
  writeMemory: DevMemoryWriter;
  patterns: PatternStore;
  /** The LLM for reviews; null when none is configured (the loop then does not review). */
  llm: Llm | null;
  /** The executors the owner may name in DELIVERY_LOOP_EXECUTOR. */
  executors: { 'dev-autopilot'?: ExecutorGateway };
  isArmed: () => Promise<boolean>;
}

export interface LoopStatus {
  enabled: boolean;
  /** Why the loop is not running, when it is not. */
  not_running_reason: string | null;
  autonomy: string;
  projects: string[];
  gitlab_configured: boolean;
  reviewer_configured: boolean;
  executor: string | null;
  cycle_ms: number;
  last_cycle: { at: string; ran: boolean; reason: string | null; stats: CycleResult['stats']; stopped_early: boolean } | null;
}

export interface DeliveryLoop {
  /** Runs one cycle now (the timer calls this). Never throws; never overlaps itself. */
  tick(): Promise<CycleResult | null>;
  stop(): void;
  status(): LoopStatus;
}

export interface StartOptions {
  env?: NodeJS.ProcessEnv;
  bindings: RuntimeBindings;
  cycleMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (m: string) => void;
  setIntervalFn?: (fn: () => void, ms: number) => { unref?: () => void };
  clearIntervalFn?: (h: unknown) => void;
}

export function cycleMsFrom(env: NodeJS.ProcessEnv): number {
  const raw = env.DELIVERY_LOOP_CYCLE_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_CYCLE_MS;
  const n = Number(raw);
  // Between 15 seconds and 15 minutes: faster is a load on GitLab and OASIS, slower is a loop that does not feel alive.
  return Number.isInteger(n) && n >= 15_000 && n <= 900_000 ? n : DEFAULT_CYCLE_MS;
}

/** Null when something the loop cannot run without is missing, with the reason. */
export function buildDeps(env: NodeJS.ProcessEnv, b: RuntimeBindings, opts: { fetchImpl?: typeof fetch; now?: () => number } = {}): { deps: LoopDeps } | { missing: string } {
  const projects = projectsFrom(env);
  if (projects.length === 0) return { missing: 'DELIVERY_LOOP_PROJECTS names no project' };
  const gitlab = gitlabClientFromEnv(env, projects, opts.fetchImpl);
  if (!gitlab) return { missing: 'GITLAB_API_URL and GITLAB_API_TOKEN are not both set' };

  const reviewer: ReviewerPort | null = b.llm ? createReviewerPort({ llm: b.llm }) : null;
  return {
    deps: {
      gitlab,
      ledger: createOasisLedger({ env, fetch: opts.fetchImpl }),
      tasks: createExecutorTaskPort(executorFromEnv(env, b.executors)),
      reviewer,
      learn: createLearnPort({ writeMemory: b.writeMemory, patterns: b.patterns }),
      now: opts.now ?? Date.now,
    },
  };
}

export function startDeliveryLoop(opts: StartOptions): DeliveryLoop {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.log(m));
  const setI = opts.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearI = opts.clearIntervalFn ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout));
  const cycleMs = opts.cycleMs ?? cycleMsFrom(env);

  let engine: Engine | null = null;
  let notRunning: string | null = isLoopEnabled(env) ? null : 'DELIVERY_LOOP_ENABLED is not "true"';
  let hasReviewer = false;
  let running = false;
  let last: LoopStatus['last_cycle'] = null;
  let warned = false;

  const ensureEngine = (): Engine | null => {
    if (engine) return engine;
    const built = buildDeps(env, opts.bindings, { fetchImpl: opts.fetchImpl, now: opts.now });
    if ('missing' in built) {
      notRunning = built.missing;
      if (!warned) log(`[delivery-loop] not running: ${built.missing}`);
      warned = true;
      return null;
    }
    notRunning = null;
    hasReviewer = built.deps.reviewer !== null;
    engine = createEngine({ deps: built.deps, env, isArmed: opts.bindings.isArmed, cycleMs });
    return engine;
  };

  const tick = async (): Promise<CycleResult | null> => {
    if (running) return null; // a previous tick is still running
    if (!isLoopEnabled(env)) {
      notRunning = 'DELIVERY_LOOP_ENABLED is not "true"';
      return null;
    }
    running = true;
    try {
      const e = ensureEngine();
      if (!e) return null;
      const r = await e.cycle();
      last = { at: new Date((opts.now ?? Date.now)()).toISOString(), ran: r.ran, reason: r.reason ?? null, stats: r.stats, stopped_early: r.stoppedEarly };
      const s = r.stats;
      if (r.ran && (s.facts + s.dispatched + s.retried + s.notes + s.errors > 0)) {
        log(`[delivery-loop] facts=${s.facts} dispatched=${s.dispatched} retried=${s.retried} notes=${s.notes} verified=${s.verified} errors=${s.errors}${r.stoppedEarly ? ' (stopped early)' : ''}`);
      }
      return r;
    } catch (err) {
      console.warn('[delivery-loop] tick error:', (err as Error)?.message || err);
      return null;
    } finally {
      running = false;
    }
  };

  const handle = setI(() => { void tick(); }, cycleMs);
  handle?.unref?.();

  return {
    tick,
    stop: () => clearI(handle),
    status: () => ({
      enabled: isLoopEnabled(env),
      not_running_reason: notRunning,
      autonomy: autonomyFrom(env),
      projects: projectsFrom(env),
      gitlab_configured: Boolean(env.GITLAB_API_URL && env.GITLAB_API_TOKEN),
      reviewer_configured: hasReviewer,
      executor: env.DELIVERY_LOOP_EXECUTOR === 'dev-autopilot' ? 'dev-autopilot' : null,
      cycle_ms: cycleMs,
      last_cycle: last,
    }),
  };
}

/**
 * The bindings of this gateway: the real memory writer, repair-pattern store, LLM router and execution kill switch. Required lazily so
 * importing this module (the status route does) loads none of them.
 */
export function gatewayBindings(): RuntimeBindings {
  /* eslint-disable @typescript-eslint/no-var-requires */
  return {
    writeMemory: async (input) => {
      const { writeDevMemory } = require('../dev-agent-memory') as typeof import('../dev-agent-memory');
      return writeDevMemory({ ...input, source: 'autopilot' });
    },
    patterns: {
      record: async (input) => (require('../repair-pattern-store') as typeof import('../repair-pattern-store')).recordPattern(input),
      find: async (signature) => (require('../repair-pattern-store') as typeof import('../repair-pattern-store')).findPatternBySignature(signature),
    },
    // The `validator` stage of the router: Claude on Bedrock by the standing rule, never Google, never silently another family.
    llm: async ({ system, user }) => {
      const { callViaRouter } = require('../llm-router') as typeof import('../llm-router');
      const r = await callViaRouter('validator', user, { service: 'delivery-loop', systemPrompt: system, maxTokens: 2000, allowFallback: true });
      return r.ok && typeof r.text === 'string' && !r.truncated ? { ok: true, text: r.text, model: r.model ?? null } : { ok: false, error: r.truncated ? 'reviewer_answer_truncated' : r.error ?? 'llm_failed' };
    },
    // The GitLab-native Dev Autopilot executor (repairs of failed merge-request pipelines, on the merge request's own branch). Bound is
    // not on: the port refuses every dispatch until the owner sets DELIVERY_LOOP_EXECUTOR=dev-autopilot (executorFromEnv).
    executors: { 'dev-autopilot': createDevAutopilotGitlabGateway() },
    isArmed: () => isAutopilotExecutionArmed(),
  };
  /* eslint-enable @typescript-eslint/no-var-requires */
}
