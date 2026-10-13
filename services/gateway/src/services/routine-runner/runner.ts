/**
 * VTID-05103 — In-gateway routine runner (Loop Engineering Phase 3a, loop L1).
 *
 * Replaces the deterministic claude.ai routines: an LLM session that only ran
 * a few curl calls and a threshold, needed the ingest token pasted into its
 * prompt, and (found 2026-10-12) died at the environment setup script before
 * its prompt ever ran. Each routine in sources.ts now runs once per UTC day
 * inside the gateway:
 *
 *   claim (claim_routine_run — exactly once across ECS tasks, honours the
 *   catalog's `enabled` flag) → load + check → finish (finish_routine_run,
 *   same tables the Command Hub Routines screen reads) → on a breach: the
 *   OASIS event the spec names (source routine.<name>, status warning) and
 *   the self-healing intake, the same processFailingService path
 *   routes/events.ts takes for a routine breach.
 *
 * Off unless ROUTINE_RUNNER_ENABLED === 'true'. Never on staging: staging
 * shares the production database (same guard as the reward sweep). Both are
 * checked once, at start.
 */

import { RoutineVerdict } from './checks';
import { RUNNER_ROUTINES, RunnerRoutine } from './sources';

const LOG = '[routine-runner]';
const TICK_MS = 60 * 60 * 1000;

export interface RecentRun {
  status: string;
  findings: Record<string, unknown> | null;
  error?: string | null;
}

export interface RunnerDeps {
  claim: (name: string) => Promise<string | null>;
  finish: (id: string, verdict: RoutineVerdict, error: string | null) => Promise<void>;
  emitBreach: (routine: string, verdict: RoutineVerdict) => Promise<void>;
  routeBreach: (routine: string, verdict: RoutineVerdict) => Promise<void>;
  // VTID-05141 stop rules. Optional so a dep set without them keeps the
  // VTID-05103 behaviour (no damping, no stagnation stop).
  /** The routine's latest finished gateway-runner runs, newest first. */
  recentRuns?: (name: string, limit: number) => Promise<RecentRun[]>;
  /** Switch the routine off in the catalog and emit routine.runner.stagnated. */
  stopStagnated?: (name: string, lastError: string | null) => Promise<void>;
}

/** Consecutive crashed runs (status failure) that switch a routine off. */
export const STAGNATION_RUNS = 3;
/** Consecutive earlier runs with the same breach that stop re-routing it to self-healing. */
export const DAMPING_RUNS = 3;

/** True when the previous DAMPING_RUNS runs all reported this same breach topic. */
export function shouldDampBreach(previous: RecentRun[], topic: string): boolean {
  if (previous.length < DAMPING_RUNS) return false;
  return previous
    .slice(0, DAMPING_RUNS)
    .every((r) => r.status === 'partial' && (r.findings as any)?.breach_topic === topic);
}

/** True when the latest STAGNATION_RUNS runs (this one included) all crashed. */
export function isStagnated(latest: RecentRun[]): boolean {
  return latest.length >= STAGNATION_RUNS && latest.slice(0, STAGNATION_RUNS).every((r) => r.status === 'failure');
}

export function routineRunnerAllowed(env: NodeJS.ProcessEnv = process.env): { ok: true } | { ok: false; reason: string } {
  if (env.ROUTINE_RUNNER_ENABLED !== 'true') return { ok: false, reason: 'ROUTINE_RUNNER_ENABLED is not "true"' };
  if (env.VITANA_ENV === 'staging') return { ok: false, reason: 'staging shares the production database' };
  return { ok: true };
}

/** True once the routine's UTC run time has passed today. */
export function isDue(routine: Pick<RunnerRoutine, 'hour' | 'minute'>, now: Date): boolean {
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minutes >= routine.hour * 60 + routine.minute;
}

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

/** Routines this process already claimed or saw claimed today (saves a claim call per tick). */
const settledToday = new Map<string, string>();

export async function runDueRoutines(
  deps: RunnerDeps,
  now: Date = new Date(),
  routines: readonly RunnerRoutine[] = RUNNER_ROUTINES
): Promise<Array<{ name: string; outcome: 'ran' | 'not_due' | 'settled' | 'not_claimed'; status?: string }>> {
  const day = utcDay(now);
  const results: Array<{ name: string; outcome: 'ran' | 'not_due' | 'settled' | 'not_claimed'; status?: string }> = [];

  for (const routine of routines) {
    if (!isDue(routine, now)) {
      results.push({ name: routine.name, outcome: 'not_due' });
      continue;
    }
    if (settledToday.get(routine.name) === day) {
      results.push({ name: routine.name, outcome: 'settled' });
      continue;
    }

    let runId: string | null;
    try {
      runId = await deps.claim(routine.name);
    } catch (err: any) {
      console.warn(`${LOG} claim ${routine.name} failed: ${err?.message || err}`);
      results.push({ name: routine.name, outcome: 'not_claimed' });
      continue; // try again next tick
    }
    settledToday.set(routine.name, day);
    if (!runId) {
      results.push({ name: routine.name, outcome: 'not_claimed' });
      continue; // disabled in the catalog, or another task has it today
    }

    let verdict: RoutineVerdict;
    let error: string | null = null;
    try {
      verdict = await routine.run();
    } catch (err: any) {
      error = String(err?.message || err);
      verdict = { status: 'failure', summary: `❌ ${routine.name} failed before a verdict — see error`, findings: {} };
    }

    if (verdict.breach) {
      const topic = verdict.breach.topic;
      // Recorded on the run so the next days can tell an open, already-routed problem.
      verdict = { ...verdict, findings: { ...verdict.findings, breach_topic: topic } };
      try {
        await deps.emitBreach(routine.name, verdict);
      } catch (err: any) {
        console.warn(`${LOG} ${routine.name}: OASIS emit failed: ${err?.message || err}`);
      }
      let damped = false;
      if (deps.recentRuns) {
        try {
          damped = shouldDampBreach(await deps.recentRuns(routine.name, DAMPING_RUNS), topic);
        } catch (err: any) {
          console.warn(`${LOG} ${routine.name}: recent runs read failed, routing as usual: ${err?.message || err}`);
        }
      }
      if (damped) {
        verdict = { ...verdict, findings: { ...verdict.findings, self_healing_damped: true } };
      } else {
        try {
          await deps.routeBreach(routine.name, verdict);
        } catch (err: any) {
          console.warn(`${LOG} ${routine.name}: self-healing routing failed (non-fatal): ${err?.message || err}`);
        }
      }
    }

    try {
      await deps.finish(runId, verdict, error);
    } catch (err: any) {
      console.warn(`${LOG} finish ${routine.name} failed: ${err?.message || err}`);
    }

    if (verdict.status === 'failure' && deps.recentRuns && deps.stopStagnated) {
      try {
        if (isStagnated(await deps.recentRuns(routine.name, STAGNATION_RUNS))) {
          await deps.stopStagnated(routine.name, error ?? verdict.summary);
        }
      } catch (err: any) {
        console.warn(`${LOG} ${routine.name}: stagnation check failed: ${err?.message || err}`);
      }
    }
    results.push({ name: routine.name, outcome: 'ran', status: verdict.status });
  }
  return results;
}

// =============================================================================
// Production dependencies
// =============================================================================

async function rpc<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE not set');
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`rpc ${fn} → ${res.status} ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

async function rest<T>(path: string, init: { method?: string; body?: string } = {}): Promise<T | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE not set');
  const res = await fetch(`${url}${path}`, {
    method: init.method || 'GET',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: init.body,
  });
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path.split('?')[0]} → ${res.status} ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export const productionDeps: RunnerDeps = {
  claim: async (name) => (await rpc<string | null>('claim_routine_run', { p_name: name })) || null,
  finish: async (id, verdict, error) => {
    await rpc('finish_routine_run', {
      p_id: id,
      p_status: verdict.status,
      p_summary: verdict.summary,
      p_findings: verdict.findings,
      p_error: error,
    });
  },
  emitBreach: async (routine, verdict) => {
    const b = verdict.breach!;
    const { emitOasisEvent } = require('../oasis-event-service');
    await emitOasisEvent({
      vtid: b.vtid,
      type: b.topic,
      source: `routine.${routine}`,
      status: b.status || 'warning',
      message: b.message,
      payload: b.payload,
    });
  },
  recentRuns: async (name, limit) => {
    const rows = await rest<RecentRun[]>(
      `/rest/v1/routine_runs?routine_name=eq.${encodeURIComponent(name)}&trigger=eq.gateway-runner` +
        `&status=neq.running&select=status,findings,error&order=started_at.desc&limit=${limit}`
    );
    return rows || [];
  },
  stopStagnated: async (name, lastError) => {
    await rest(`/rest/v1/routines?name=eq.${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false, updated_at: new Date().toISOString() }),
    });
    const { emitOasisEvent } = require('../oasis-event-service');
    await emitOasisEvent({
      vtid: 'VTID-05141',
      type: 'routine.runner.stagnated',
      source: `routine.${name}`,
      status: 'error',
      message: `${name} failed ${STAGNATION_RUNS} runs in a row and was switched off in the routine catalog; re-enable it once fixed`,
      payload: { routine: name, last_error: (lastError || '').slice(0, 1000) },
    });
    console.warn(`${LOG} ${name}: ${STAGNATION_RUNS} failed runs in a row — switched off (routine.runner.stagnated)`);
  },
  // Same synthetic failure routes/events.ts builds for a routine breach, so
  // dedup, circuit breaker and the autonomy level apply exactly as before.
  routeBreach: async (routine, verdict) => {
    const b = verdict.breach!;
    const { processFailingService, getAutonomyLevel } = require('../../routes/self-healing');
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_');
    await processFailingService(
      {
        name: `routine.${routine}`,
        endpoint: `routine-incident://${safe(routine)}/${safe(b.topic)}`,
        status: 'down',
        http_status: null,
        response_body: '',
        response_time_ms: 0,
        error_message: `${b.message} | payload=${JSON.stringify(b.payload ?? {}).slice(0, 1500)}`,
      },
      await getAutonomyLevel()
    );
  },
};

let timerId: ReturnType<typeof setInterval> | null = null;

/** Hourly tick; each routine runs once per UTC day after its time. Returns false when off. */
export function startRoutineRunner(env: NodeJS.ProcessEnv = process.env, deps: RunnerDeps = productionDeps): boolean {
  if (timerId) return false;
  const allowed = routineRunnerAllowed(env);
  if (!allowed.ok) return false;
  const tick = async () => {
    try {
      await runDueRoutines(deps);
    } catch (err: any) {
      console.warn(`${LOG} tick failed: ${err?.message || err}`);
    }
  };
  timerId = setInterval(() => { void tick(); }, TICK_MS);
  timerId.unref?.();
  void tick();
  return true;
}

export function routineRunnerStatus(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()) {
  const allowed = routineRunnerAllowed(env);
  const day = utcDay(now);
  return {
    enabled: allowed.ok,
    reason: allowed.ok ? null : allowed.reason,
    env: env.VITANA_ENV || null,
    started: timerId !== null,
    routines: RUNNER_ROUTINES.map((r) => ({
      name: r.name,
      run_at_utc: `${String(r.hour).padStart(2, '0')}:${String(r.minute).padStart(2, '0')}`,
      due_today: isDue(r, now),
      settled_today: settledToday.get(r.name) === day,
    })),
  };
}

export function resetRoutineRunnerForTest(): void {
  if (timerId) clearInterval(timerId);
  timerId = null;
  settledToday.clear();
}
