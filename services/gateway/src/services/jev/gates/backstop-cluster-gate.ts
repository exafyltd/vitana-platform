/**
 * VTID-04804: Jev P2 gate C2 — voice backstop firings, clustered per day,
 * judged as defect candidates. (docs/JEV-INTEGRATION-PLAN.md §10.4 C2)
 *
 *   voice_backstop_clusters   (JEV_VOICE_BACKSTOP_CLUSTERS_MODE = off | shadow | enforce)
 *
 * Every backstop firing (`orb.live.diag` stages below) is the gateway doing
 * something the voice model should have done itself: a remember request the
 * model claimed without calling remember_fact, a recall it refused, a held
 * reply it dropped. In the 14 days to 2026-10-01 production recorded e.g.
 * remember_hold_dropped/remember_request 116, recall_backstop/denied 49,
 * remember_backstop/stored_value_echoed 31, …/claimed_without_call 23.
 * Nobody turns those counts into work.
 *
 * Once per UTC day (an hourly tick, idempotent per day like the product
 * analytics rollup), the previous day's firings of this environment are
 * grouped by stage + sub-cause (reason / trigger / outcome). Each cluster with
 * at least MIN_FIRINGS firings is sent to Jev `backstop_cluster_defect`:
 * counts and session metrics only (`pii: 'forbid'`). One
 * `jev_shadow_decisions` row per cluster per day; a row already written for
 * the same cluster key (another gateway task, a restart) is never repeated.
 * No enforce behaviour: turning a defect cluster into a Dev Autopilot
 * finding is a later slice, after the data.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import { VITANA_ENV } from '../../../env';
import { decide, DecideOptions } from '../jev-decision-service';
import * as repo from '../jev-repository';
import { jevGateMode, recordJevShadowDecision } from '../jev-shadow';

export const BACKSTOP_CLUSTER_GATE = 'voice_backstop_clusters';
export const MIN_FIRINGS = 3;
export const MAX_CLUSTERS_PER_DAY = 12;
const SYSTEM_CALLER = { actor_id: 'orb-voice-telemetry', system: true } as const;
const TICK_MS = 60 * 60 * 1000;

/** The backstop stages and what each firing means, for the model and for people. */
export const BACKSTOP_STAGES: Record<string, string> = {
  remember_backstop: 'The member asked Vitana to remember something and the model did not call remember_fact; the gateway stored it itself.',
  recall_backstop: 'The member asked about something stored and the model refused or did not look it up; the gateway answered from memory.',
  forget_backstop: 'The member asked to forget something and the model did not call the forget tool; the gateway did.',
  remember_hold_dropped: 'A reply held back for a pending remember/recall was dropped instead of being released.',
  remember_hold_released: 'A held reply was released after the remember/recall check.',
  recall_hold_suspect: 'A reply to a question about stored facts looked like a refusal and was held.',
  tool_loop_guard: 'The model called tools in a loop and the guard stopped it.',
  opening_action_refused: 'The model refused the action the session opened with.',
  nav_open_backstop: 'The member asked to open a screen and the model did not navigate; the gateway did.',
  muted_leak_recovery: 'Audio that should have been muted leaked and was recovered.',
};

interface DiagMeta {
  stage?: string;
  reason?: string;
  trigger?: string;
  outcome?: string;
  env?: string;
  session_id?: string;
  turn_count?: number;
}

export interface BackstopCluster {
  stage: string;
  sub: string;
  firings: number;
  sessions: number;
  avg_turns: number | null;
}

/** Group one day's diag rows (this environment only) into clusters, biggest first. */
export function clusterBackstops(rows: Array<{ metadata?: DiagMeta | null }>, env: string): BackstopCluster[] {
  const map = new Map<string, { stage: string; sub: string; firings: number; sessions: Set<string>; turns: number[] }>();
  for (const r of rows) {
    const m = r.metadata || {};
    if (!m.stage || !(m.stage in BACKSTOP_STAGES)) continue;
    if (m.env && m.env !== env) continue;
    const sub = (m.reason || m.trigger || m.outcome || 'none').slice(0, 60);
    const key = `${m.stage}:${sub}`;
    const c = map.get(key) || { stage: m.stage, sub, firings: 0, sessions: new Set<string>(), turns: [] };
    c.firings++;
    if (m.session_id) c.sessions.add(m.session_id);
    if (typeof m.turn_count === 'number') c.turns.push(m.turn_count);
    map.set(key, c);
  }
  return [...map.values()]
    .map((c) => ({
      stage: c.stage,
      sub: c.sub,
      firings: c.firings,
      sessions: c.sessions.size,
      avg_turns: c.turns.length ? Math.round((c.turns.reduce((a, b) => a + b, 0) / c.turns.length) * 10) / 10 : null,
    }))
    .sort((a, b) => b.firings - a.firings);
}

export function clusterKey(env: string, day: string, c: Pick<BackstopCluster, 'stage' | 'sub'>): string {
  return `${env}:${day}:${c.stage}:${c.sub}`;
}

export function isBackstopClustersOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(BACKSTOP_CLUSTER_GATE, env) !== 'off';
}

/**
 * Judge one UTC day (YYYY-MM-DD). Never throws. Returns the number of rows
 * written (0 when off, nothing to judge, or every cluster already judged).
 */
export async function runBackstopClusterDay(
  day: string,
  opts: { env?: NodeJS.ProcessEnv; vitanaEnv?: string; sb?: SupabaseClient | null; decideOptions?: Omit<DecideOptions, 'source' | 'env'> } = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const mode = jevGateMode(BACKSTOP_CLUSTER_GATE, env);
  if (mode === 'off') return 0;
  const sb = opts.sb === undefined ? getSupabase() : opts.sb;
  if (!sb) return 0;
  const vitanaEnv = opts.vitanaEnv ?? VITANA_ENV;
  try {
    const since = `${day}T00:00:00.000Z`;
    const until = new Date(Date.parse(since) + 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await repo.fetchVoiceDiagEvents(sb, Object.keys(BACKSTOP_STAGES), since, until);
    if (error || !data) return 0;
    const clusters = clusterBackstops(data as Array<{ metadata?: DiagMeta }>, vitanaEnv)
      .filter((c) => c.firings >= MIN_FIRINGS)
      .slice(0, MAX_CLUSTERS_PER_DAY);
    let written = 0;
    for (const c of clusters) {
      const key = clusterKey(vitanaEnv, day, c);
      const seen = await repo.fetchRecentShadowBySubject(sb, BACKSTOP_CLUSTER_GATE, key, since);
      if (!seen.error && seen.data) continue;
      const r = await decide(
        'backstop_cluster_defect',
        {
          stage: c.stage,
          sub_cause: c.sub,
          firings: c.firings,
          sessions: c.sessions,
          window_hours: 24,
          avg_turns: c.avg_turns ?? undefined,
          what_it_means: BACKSTOP_STAGES[c.stage],
        },
        SYSTEM_CALLER,
        { ...(opts.decideOptions || {}), source: `gate:${BACKSTOP_CLUSTER_GATE}`, env },
      );
      const id = await recordJevShadowDecision(
        {
          gate: BACKSTOP_CLUSTER_GATE,
          decision: 'backstop_cluster_defect',
          mode,
          plane: 'internal',
          tenant_id: null,
          subject_type: 'voice_backstop_cluster',
          subject_ref: key,
          jev_outcome: r.outcome,
          jev_verdict: r.ok
            ? { defect: r.outcome === 'decided' ? r.verdict.value === true : null, probability: r.answers.defect?.probability ?? null, kind: r.answers.kind?.value ?? null, ...c, day }
            : { reason: r.reason, ...c, day },
          jev_confidence: r.ok ? r.verdict.confidence : null,
          system_action: 'no_finding',
          cost_usd: r.ok ? r.cost_usd : 0,
        },
        sb,
      );
      if (id) written++;
    }
    return written;
  } catch (err: any) {
    console.warn(`[jev] ${BACKSTOP_CLUSTER_GATE} day ${day} failed: ${err?.message || err}`);
    return 0;
  }
}

let timerId: ReturnType<typeof setInterval> | null = null;
let lastDay: string | null = null;

/** Hourly tick, judges yesterday (UTC) once. Off unless the gate's mode is set. */
export function startBackstopClusterScheduler(env: NodeJS.ProcessEnv = process.env): boolean {
  if (timerId || !isBackstopClustersOn(env)) return false;
  const tick = async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (lastDay === yesterday) return;
    await runBackstopClusterDay(yesterday);
    lastDay = yesterday;
  };
  timerId = setInterval(() => { void tick(); }, TICK_MS);
  timerId.unref?.();
  void tick();
  return true;
}

export function stopBackstopClusterSchedulerForTest(): void {
  if (timerId) clearInterval(timerId);
  timerId = null;
  lastDay = null;
}
