/**
 * Delivery loop: the engine. One cycle runs observe -> reason -> plan -> execute -> verify -> learn -> improve over the GitLab delivery.
 *
 *   observe   the poller writes what GitLab shows that the webhook did not; the facts since the cursor are read from OASIS
 *   reason    each fact goes to its policy (intake, heal, review); a policy decides, records the decision and any intent
 *   execute   `drive` carries out the open intents (L3, execution armed), inside the cycle's action budget
 *   verify    `reconcileHeals` reads the branches the loop acted on and records green (verified) or red (the next attempt, or the end)
 *   learn     `learnSweep` turns outcomes into memory and repair patterns
 *   improve   `improveSweep` turns a failure that keeps coming back into a proposal for a person
 *
 * The loop keeps no state of its own. The cursor, the claim and every decision are rows in OASIS, so a restart, a second gateway task
 * or a crash in the middle of a cycle loses nothing, and every step is idempotent so a cycle that runs again over the same facts
 * repeats nothing. A cycle that finds nothing to do writes nothing (polling is not an OASIS event).
 *
 * A failure of the world (GitLab or OASIS down) stops the cycle at the fact it hit and leaves the cursor before it. A fact whose own
 * handling keeps failing is retried three times and then recorded as blocked and passed, so one bad fact cannot stop the loop.
 */
import { readControls, type Controls } from './controls';
import { toFact, FACT_TOPICS, type Cursor, type Fact, type LedgerEvent } from './facts';
import { K, T } from './keys';
import { ClaimedElsewhere, DeferredByBudget, LoopError, emptyStats, ensureClaim, may, noteSweep, record, type Ctx, type CycleStats, type LoopDeps } from './context';
import { handleIssue } from './intake';
import { handleFailedPipeline, reconcileHeals } from './heal';
import { handleGreenPipeline } from './review';
import { driveIntents } from './drive';
import { improveSweep, learnSweep } from './learn';
import { newPollState, pollProjects, type PollState } from './poll';

export const DEFAULT_CYCLE_MS = 60_000;
export const BATCH_SIZE = 100;
export const MAX_FACT_FAILURES = 3;

export interface EngineOptions {
  deps: LoopDeps;
  env?: NodeJS.ProcessEnv;
  /** The execution plane's kill switch (isAutopilotExecutionArmed); unreadable means not armed. */
  isArmed: () => Promise<boolean>;
  cycleMs?: number;
}

export interface CycleResult {
  ran: boolean;
  /** Why it did not run: `disabled`, `claimed_elsewhere`, `ledger_unreachable`. */
  reason?: string;
  stats: CycleStats;
  controls: Controls;
  /** True when the cursor stopped before the end of the batch (a failure of the world, or the action cap). */
  stoppedEarly: boolean;
}

export interface Engine {
  cycle(): Promise<CycleResult>;
  /** The cursor the engine would read from now (for tests and the status route). */
  cursor(): Cursor | null;
}

export function createEngine(options: EngineOptions): Engine {
  const { deps } = options;
  const env = options.env ?? process.env;
  const cycleMs = options.cycleMs ?? DEFAULT_CYCLE_MS;
  let cursor: Cursor | null = null;
  let cursorLoaded = false;
  /** The cursor as last stored in the ledger (or loaded from it): a cycle row is written only when the cursor moves past this. */
  let lastWritten: string | null = null;
  const failures = new Map<string, number>();
  const poll: PollState = newPollState();

  async function loadCursor(ctx: Ctx): Promise<void> {
    if (cursorLoaded) return;
    // The newest cycle row that carries a cursor: where the previous run of the loop (this task or another) stopped.
    const r = await deps.ledger.find({ topic: T.cycle, limit: 1 });
    if (!r.ok) throw new LoopError('ledger.find', r.error);
    const m = r.events[0]?.metadata;
    if (m && typeof m.cursor_created_at === 'string' && typeof m.cursor_id === 'string') cursor = { created_at: m.cursor_created_at, id: m.cursor_id };
    // What is stored is the baseline: only a cursor that moves past it is worth a row.
    lastWritten = cursor ? `${cursor.created_at}|${cursor.id}` : null;
    cursorLoaded = true;
  }

  async function cycle(): Promise<CycleResult> {
    const controls = await readControls(env, options.isArmed);
    const stats = emptyStats();
    const empty = (reason: string, ran = false): CycleResult => ({ ran, reason, stats, controls, stoppedEarly: false });
    if (!controls.enabled) return empty('disabled');

    const window = Math.floor(deps.now() / cycleMs);
    const ctx: Ctx = {
      deps,
      env,
      controls,
      stats,
      budget: { actions: controls.maxActions },
      claim: {
        state: 'unclaimed',
        // One gateway task runs a window: the task whose claim row is the first of the window. A repeat is `duplicate`.
        acquire: async () => {
          const r = await deps.ledger.record({
            type: T.claim,
            status: 'info',
            message: `Delivery loop claimed window ${window}`,
            payload: { window, cycle_ms: cycleMs, autonomy: controls.autonomy },
            key: K.claim(window),
          });
          if (!r.ok) throw new LoopError('ledger.claim', r.error);
          return r.duplicate ? 'lost' : 'held';
        },
      },
    };

    let stoppedEarly = false;
    try {
      await loadCursor(ctx);

      // observe: the poller (writes only when GitLab shows something the ledger does not have), then the facts since the cursor
      await guarded(ctx, () => pollProjects(ctx, poll));

      const read = await deps.ledger.read({ topics: FACT_TOPICS, after: cursor, limit: BATCH_SIZE });
      if (!read.ok) throw new LoopError('ledger.read', read.error);

      let last: LedgerEvent | null = null;
      for (const row of read.events) {
        const fact = toFact(row);
        if (fact === null) {
          last = row;
          continue;
        }
        stats.facts += 1;
        const outcome = await handleFact(ctx, fact);
        if (outcome === 'stop') {
          stoppedEarly = true;
          break;
        }
        last = row;
      }

      // drive, verify, learn, improve: each is independent of the facts and runs every cycle
      await guarded(ctx, () => driveIntents(ctx));
      await guarded(ctx, () => reconcileHeals(ctx));
      await guarded(ctx, () => noteSweep(ctx));
      await guarded(ctx, () => learnSweep(ctx));
      await guarded(ctx, () => improveSweep(ctx));

      if (last) cursor = { created_at: last.created_at, id: last.id };
      await bookkeeping(ctx, window, cursor, stoppedEarly);
    } catch (e) {
      if (e instanceof ClaimedElsewhere) return empty('claimed_elsewhere');
      if (e instanceof LoopError) {
        stats.errors += 1;
        return { ran: false, reason: 'ledger_unreachable', stats, controls, stoppedEarly: true };
      }
      throw e;
    }
    return { ran: true, stats, controls, stoppedEarly };
  }

  /**
   * One fact. `stop` ends the batch here without passing the fact: the world failed (GitLab, OASIS) or the action budget is spent, so
   * the fact is read again next cycle. A fact that fails for itself MAX_FACT_FAILURES times is recorded as blocked and passed.
   */
  async function handleFact(ctx: Ctx, fact: Fact): Promise<'pass' | 'stop'> {
    try {
      if (fact.kind === 'issue') await handleIssue(ctx, fact);
      else if (fact.kind === 'pipeline') {
        if (fact.status === 'failed') await handleFailedPipeline(ctx, fact);
        else await handleGreenPipeline(ctx, fact);
      }
      failures.delete(fact.event.id);
      return 'pass';
    } catch (e) {
      if (e instanceof ClaimedElsewhere) throw e;
      if (e instanceof DeferredByBudget) return 'stop';
      ctx.stats.errors += 1;
      if (e instanceof LoopError) return 'stop'; // the world failed: not this fact's fault
      const n = (failures.get(fact.event.id) ?? 0) + 1;
      failures.set(fact.event.id, n);
      if (n < MAX_FACT_FAILURES) return 'stop';
      try {
        await record(ctx, {
          type: T.blocked,
          status: 'warning',
          message: `A fact was set aside after ${n} failures: ${fact.event.topic}`,
          payload: { fact: fact.event.id, topic: fact.event.topic, project: fact.project, error: String((e as Error).message ?? e).slice(0, 200) },
          key: K.blocked(fact.event.id),
        });
      } catch {
        return 'stop';
      }
      failures.delete(fact.event.id);
      return 'pass';
    }
  }

  /** A phase that fails for the world's reasons does not end the cycle; a claim lost does. */
  async function guarded(ctx: Ctx, phase: () => Promise<void>): Promise<void> {
    try {
      await phase();
    } catch (e) {
      if (e instanceof ClaimedElsewhere) throw e;
      if (e instanceof DeferredByBudget) return;
      ctx.stats.errors += 1;
    }
  }

  /** The cycle row: the cursor and what the cycle did. Written only when the cycle did something or moved the cursor. */
  async function bookkeeping(ctx: Ctx, window: number, cur: Cursor | null, stoppedEarly: boolean): Promise<void> {
    const s = ctx.stats;
    const didSomething = s.facts + s.decisions + s.intents + s.dispatched + s.retried + s.notes + s.reviews + s.verified + s.exhausted + s.learned + s.proposals + s.polled + s.errors > 0;
    if (!didSomething && !cursorMoved(cur)) return;
    if (!may(ctx, 'record')) return;
    await ensureClaim(ctx);
    const written = await record(ctx, {
      type: T.cycle,
      status: s.errors > 0 ? 'warning' : 'info',
      message: `Delivery loop cycle: ${s.facts} fact${s.facts === 1 ? '' : 's'}, ${s.dispatched + s.retried} action${s.dispatched + s.retried === 1 ? '' : 's'}, ${s.errors} error${s.errors === 1 ? '' : 's'}`,
      payload: {
        window, autonomy: ctx.controls.autonomy, armed: ctx.controls.armed, stopped_early: stoppedEarly, stats: { ...s },
        ...(cur ? { cursor_created_at: cur.created_at, cursor_id: cur.id } : {}),
      },
      key: K.cycle(window),
    });
    // The baseline is the cursor of the row that is now in the ledger, whichever way the cycle came to write it (it did something, or the
    // cursor moved). A baseline set only on the quiet path would leave an active cycle's cursor looking "new" to the next, quiet, cycle,
    // which would then write a claim and a cycle row for nothing (found by the rehearsal on a real GitLab).
    if (written.ok) lastWritten = cursorId(cur);
  }

  const cursorId = (cur: Cursor | null): string | null => (cur ? `${cur.created_at}|${cur.id}` : null);
  /** Pure: has the cursor moved past what the ledger already holds? Never changes the baseline (only a written cycle row does). */
  function cursorMoved(cur: Cursor | null): boolean {
    const id = cursorId(cur);
    return id !== null && id !== lastWritten;
  }

  return { cycle, cursor: () => cursor };
}
