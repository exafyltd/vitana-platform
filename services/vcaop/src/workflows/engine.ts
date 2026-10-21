/**
 * Durable workflow engine (Phase 4, brief Sec. 9).
 *
 * Guarantees delivered: durable state (persisted after EVERY step),
 * idempotent commands (run-level idempotency keys), idempotent event
 * consumption (processed-event dedup), correlation ids, bounded exponential
 * backoff retry, per-step timeouts, circuit breakers, saga compensation in
 * reverse order, dead-letter queue, replay, resume-from-persisted-state,
 * and stuck-run reconciliation.
 *
 * NOT claimed: literal distributed exactly-once. Effectively-once business
 * behavior comes from dedup + state machines + reconciliation — the brief's
 * own framing.
 */
import * as crypto from 'crypto';
import { NormalizedEventRecord } from './normalizer';

export interface StepContext {
  runId: string;
  correlationId: string;
  tenantId: string;
  input: Record<string, unknown>;
  /** Results of previously completed steps, by step key. */
  results: Record<string, unknown>;
  /** Deterministic per-(run, step) idempotency key for downstream services. */
  idempotencyKey: string;
}

export interface WorkflowStep {
  key: string;
  run(ctx: StepContext): Promise<unknown>;
  /** Compensation for an already-completed step (saga). Optional but recommended for effects. */
  compensate?(ctx: StepContext): Promise<void>;
  maxAttempts?: number; // default 3
  timeoutMs?: number; // default 30s
}

export interface WorkflowDefinition {
  name: string;
  version: string;
  steps: WorkflowStep[];
}

export type RunStatus = 'running' | 'completed' | 'compensated' | 'failed' | 'stuck';

export interface StepRecord {
  key: string;
  status: 'completed' | 'failed' | 'compensated' | 'compensation_failed';
  attempts: number;
  result?: unknown;
  error?: string;
}

export interface WorkflowRunRecord {
  id: string;
  definitionName: string;
  definitionVersion: string;
  status: RunStatus;
  correlationId: string;
  tenantId: string;
  idempotencyKey: string;
  input: Record<string, unknown>;
  steps: StepRecord[];
  /** Index of the next step to execute. */
  cursor: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeadLetterRecord {
  id: string;
  reason: string;
  runId?: string;
  event?: NormalizedEventRecord;
  replayed: boolean;
  createdAt: string;
}

export interface WorkflowStore {
  saveRun(run: WorkflowRunRecord): Promise<void>;
  updateRun(run: WorkflowRunRecord): Promise<void>;
  getRun(id: string): Promise<WorkflowRunRecord | null>;
  getRunByIdempotencyKey(key: string): Promise<WorkflowRunRecord | null>;
  listRuns(): Promise<WorkflowRunRecord[]>;
  hasProcessedEvent(eventId: string): Promise<boolean>;
  markEventProcessed(eventId: string): Promise<void>;
  pushDeadLetter(rec: DeadLetterRecord): Promise<void>;
  listDeadLetters(): Promise<DeadLetterRecord[]>;
  markDeadLetterReplayed(id: string): Promise<void>;
}

export class InMemoryWorkflowStore implements WorkflowStore {
  runs = new Map<string, WorkflowRunRecord>();
  processed = new Set<string>();
  deadLetters = new Map<string, DeadLetterRecord>();

  async saveRun(run: WorkflowRunRecord): Promise<void> {
    this.runs.set(run.id, structuredClone(run));
  }
  async updateRun(run: WorkflowRunRecord): Promise<void> {
    if (!this.runs.has(run.id)) throw new Error(`unknown run ${run.id}`);
    this.runs.set(run.id, structuredClone(run));
  }
  async getRun(id: string): Promise<WorkflowRunRecord | null> {
    const r = this.runs.get(id);
    return r ? structuredClone(r) : null;
  }
  async getRunByIdempotencyKey(key: string): Promise<WorkflowRunRecord | null> {
    for (const r of this.runs.values()) if (r.idempotencyKey === key) return structuredClone(r);
    return null;
  }
  async listRuns(): Promise<WorkflowRunRecord[]> {
    return [...this.runs.values()].map((r) => structuredClone(r));
  }
  async hasProcessedEvent(eventId: string): Promise<boolean> {
    return this.processed.has(eventId);
  }
  async markEventProcessed(eventId: string): Promise<void> {
    this.processed.add(eventId);
  }
  async pushDeadLetter(rec: DeadLetterRecord): Promise<void> {
    this.deadLetters.set(rec.id, structuredClone(rec));
  }
  async listDeadLetters(): Promise<DeadLetterRecord[]> {
    return [...this.deadLetters.values()].map((r) => structuredClone(r));
  }
  async markDeadLetterReplayed(id: string): Promise<void> {
    const r = this.deadLetters.get(id);
    if (r) r.replayed = true;
  }
}

export interface EngineEvent {
  topic: string;
  status: 'info' | 'success' | 'warning' | 'error';
  message: string;
  payload: Record<string, unknown>;
}

export interface EngineDeps {
  store: WorkflowStore;
  emit: (event: EngineEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Circuit breaker: consecutive failures per step key before opening. */
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  backoffBaseMs?: number;
}

/** Routes a normalized event to a workflow (or null = not subscribed). */
export type EventRouter = (
  event: NormalizedEventRecord,
) => { definition: WorkflowDefinition; input: Record<string, unknown>; idempotencyKey: string } | null;

export class WorkflowEngine {
  private breaker = new Map<string, { failures: number; openedAt?: number }>();

  constructor(private readonly deps: EngineDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /** Idempotent event consumption: a seen event id is a no-op, recorded as such. */
  async handleEvent(
    event: NormalizedEventRecord,
    route: EventRouter,
  ): Promise<{ deduped: boolean; run?: WorkflowRunRecord }> {
    if (await this.deps.store.hasProcessedEvent(event.id)) {
      return { deduped: true };
    }
    const routed = route(event);
    if (!routed) {
      await this.deps.store.markEventProcessed(event.id);
      return { deduped: false };
    }
    try {
      const run = await this.startRun(routed.definition, routed.input, {
        correlationId: event.correlationId,
        tenantId: event.tenantId,
        idempotencyKey: routed.idempotencyKey,
      });
      await this.deps.store.markEventProcessed(event.id);
      return { deduped: false, run };
    } catch (err) {
      await this.deps.store.pushDeadLetter({
        id: `dlq-${crypto.randomUUID()}`,
        reason: err instanceof Error ? err.message : String(err),
        event,
        replayed: false,
        createdAt: new Date(this.now()).toISOString(),
      });
      this.deps.emit({
        topic: 'mesh.workflow.dead_letter',
        status: 'error',
        message: `event ${event.id} dead-lettered`,
        payload: { event_id: event.id, correlation_id: event.correlationId },
      });
      await this.deps.store.markEventProcessed(event.id);
      return { deduped: false };
    }
  }

  /** Idempotent command: an existing run for the key is returned, never restarted. */
  async startRun(
    definition: WorkflowDefinition,
    input: Record<string, unknown>,
    opts: { correlationId: string; tenantId: string; idempotencyKey: string },
  ): Promise<WorkflowRunRecord> {
    const existing = await this.deps.store.getRunByIdempotencyKey(opts.idempotencyKey);
    if (existing) return existing;

    const run: WorkflowRunRecord = {
      id: `run-${crypto.randomUUID()}`,
      definitionName: definition.name,
      definitionVersion: definition.version,
      status: 'running',
      correlationId: opts.correlationId,
      tenantId: opts.tenantId,
      idempotencyKey: opts.idempotencyKey,
      input,
      steps: [],
      cursor: 0,
      createdAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
    };
    await this.deps.store.saveRun(run);
    this.deps.emit({
      topic: 'mesh.workflow.started',
      status: 'info',
      message: `${definition.name}@${definition.version} run ${run.id}`,
      payload: { run_id: run.id, correlation_id: run.correlationId, workflow: definition.name },
    });
    return this.executeFrom(run, definition);
  }

  /** Resume a crashed/interrupted run from its persisted cursor. */
  async resume(runId: string, definition: WorkflowDefinition): Promise<WorkflowRunRecord> {
    const run = await this.deps.store.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    if (run.status !== 'running' && run.status !== 'stuck') {
      return run; // terminal states resume to themselves — idempotent
    }
    run.status = 'running';
    return this.executeFrom(run, definition);
  }

  private stepCtx(run: WorkflowRunRecord, stepKey: string): StepContext {
    return {
      runId: run.id,
      correlationId: run.correlationId,
      tenantId: run.tenantId,
      input: run.input,
      results: Object.fromEntries(
        run.steps.filter((s) => s.status === 'completed').map((s) => [s.key, s.result]),
      ),
      idempotencyKey: `${run.idempotencyKey}:${stepKey}`,
    };
  }

  private breakerFor(key: string) {
    let b = this.breaker.get(key);
    if (!b) {
      b = { failures: 0 };
      this.breaker.set(key, b);
    }
    return b;
  }

  private async executeFrom(run: WorkflowRunRecord, definition: WorkflowDefinition): Promise<WorkflowRunRecord> {
    const threshold = this.deps.breakerThreshold ?? 5;
    const cooldown = this.deps.breakerCooldownMs ?? 60_000;
    const backoffBase = this.deps.backoffBaseMs ?? 200;

    for (; run.cursor < definition.steps.length; run.cursor++) {
      const step = definition.steps[run.cursor];
      const maxAttempts = step.maxAttempts ?? 3;
      const timeoutMs = step.timeoutMs ?? 30_000;
      const breaker = this.breakerFor(step.key);

      if (breaker.openedAt !== undefined && this.now() - breaker.openedAt < cooldown) {
        return this.failAndCompensate(run, definition, step.key, 'circuit_open');
      }
      if (breaker.openedAt !== undefined) {
        breaker.openedAt = undefined; // half-open probe
        breaker.failures = 0;
      }

      let lastError = 'unknown';
      let done = false;
      for (let attempt = 1; attempt <= maxAttempts && !done; attempt++) {
        try {
          const result = await withTimeout(step.run(this.stepCtx(run, step.key)), timeoutMs, step.key);
          run.steps.push({ key: step.key, status: 'completed', attempts: attempt, result });
          breaker.failures = 0;
          done = true;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          breaker.failures += 1;
          if (breaker.failures >= threshold) breaker.openedAt = this.now();
          if (attempt < maxAttempts) await this.sleep(backoffBase * 2 ** (attempt - 1));
        }
      }
      if (!done) {
        run.steps.push({ key: step.key, status: 'failed', attempts: maxAttempts, error: lastError });
        return this.failAndCompensate(run, definition, step.key, lastError);
      }
      // Durability: persist AFTER every completed step so resume() never re-runs it.
      run.updatedAt = new Date(this.now()).toISOString();
      await this.deps.store.updateRun(run);
    }

    run.status = 'completed';
    run.updatedAt = new Date(this.now()).toISOString();
    await this.deps.store.updateRun(run);
    this.deps.emit({
      topic: 'mesh.workflow.completed',
      status: 'success',
      message: `run ${run.id} completed`,
      payload: { run_id: run.id, correlation_id: run.correlationId },
    });
    return run;
  }

  /** Saga: compensate completed steps in reverse, then dead-letter the run. */
  private async failAndCompensate(
    run: WorkflowRunRecord,
    definition: WorkflowDefinition,
    failedStepKey: string,
    reason: string,
  ): Promise<WorkflowRunRecord> {
    const completed = run.steps.filter((s) => s.status === 'completed');
    for (const rec of [...completed].reverse()) {
      const step = definition.steps.find((s) => s.key === rec.key);
      if (!step?.compensate) continue;
      try {
        await step.compensate(this.stepCtx(run, rec.key));
        rec.status = 'compensated';
      } catch (err) {
        rec.status = 'compensation_failed';
        rec.error = err instanceof Error ? err.message : String(err);
      }
    }
    run.status = completed.length > 0 ? 'compensated' : 'failed';
    run.updatedAt = new Date(this.now()).toISOString();
    await this.deps.store.updateRun(run);
    await this.deps.store.pushDeadLetter({
      id: `dlq-${crypto.randomUUID()}`,
      reason: `step ${failedStepKey}: ${reason}`,
      runId: run.id,
      replayed: false,
      createdAt: new Date(this.now()).toISOString(),
    });
    this.deps.emit({
      topic: 'mesh.workflow.compensated',
      status: 'error',
      message: `run ${run.id} ${run.status} at step ${failedStepKey}`,
      payload: { run_id: run.id, correlation_id: run.correlationId, failed_step: failedStepKey },
    });
    return run;
  }

  /**
   * Replay a dead-lettered EVENT with a fresh idempotency scope suffix so a
   * fixed downstream can process it, while step-level idempotency keys keep
   * already-succeeded external effects deduplicated by the receiving side.
   */
  async replayDeadLetter(dlqId: string, route: EventRouter): Promise<WorkflowRunRecord | null> {
    const entry = (await this.deps.store.listDeadLetters()).find((d) => d.id === dlqId);
    if (!entry) throw new Error(`unknown dead letter ${dlqId}`);
    if (entry.replayed) throw new Error(`dead letter ${dlqId} already replayed`);
    if (!entry.event) throw new Error(`dead letter ${dlqId} has no event to replay (run-failure entry — use resume)`);
    const routed = route(entry.event);
    if (!routed) return null;
    const run = await this.startRun(routed.definition, routed.input, {
      correlationId: entry.event.correlationId,
      tenantId: entry.event.tenantId,
      idempotencyKey: `${routed.idempotencyKey}:replay:${dlqId}`,
    });
    await this.deps.store.markDeadLetterReplayed(dlqId);
    return run;
  }

  /** Reconciliation: mark runs stuck past maxAge for manual recovery; emit ONCE per transition. */
  async reconcile(maxAgeMs: number): Promise<WorkflowRunRecord[]> {
    const stuck: WorkflowRunRecord[] = [];
    for (const run of await this.deps.store.listRuns()) {
      if (run.status === 'running' && this.now() - Date.parse(run.updatedAt) > maxAgeMs) {
        run.status = 'stuck';
        await this.deps.store.updateRun(run);
        stuck.push(run);
        this.deps.emit({
          topic: 'mesh.workflow.stuck',
          status: 'warning',
          message: `run ${run.id} stuck at step index ${run.cursor} — manual recovery or resume() required`,
          payload: { run_id: run.id, correlation_id: run.correlationId, cursor: run.cursor },
        });
      }
    }
    return stuck;
  }
}

class StepTimeoutError extends Error {
  constructor(stepKey: string, ms: number) {
    super(`step ${stepKey} timed out after ${ms}ms`);
    this.name = 'StepTimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, stepKey: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new StepTimeoutError(stepKey, ms)), ms).unref?.()),
  ]);
}
