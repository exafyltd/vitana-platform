/**
 * VTID-04805: Jev P2 gate C3 — why did a voice session stall?
 * (docs/JEV-INTEGRATION-PLAN.md §10.4 C3)
 *
 *   voice_slow_session   (JEV_VOICE_SLOW_SESSION_MODE = off | shadow | enforce)
 *
 * `orb.live.stall_detected` says THAT a session went silent (greeting_timeout,
 * forwarding_no_ack, audio_stall, response_timeout, text_stall) — not why.
 * In the 14 days to 2026-10-01 production stalled 71 sessions; 22 of the 24
 * forwarding_no_ack stalls had also missed a prewarmed Nova stream, which no
 * dashboard connects.
 *
 * Once per UTC day (an hourly tick, like C2), each of the previous day's
 * stalled sessions of this environment is summarised from its own events —
 * counters and timings only, never transcripts or who the member is
 * (`pii: 'forbid'`) — and sent to Jev `slow_session_cause`. A small rules
 * mapping names a cause where the counters are unambiguous; the row records
 * whether Jev agrees. One `jev_shadow_decisions` row per session, never
 * repeated. No enforce behaviour: the cause feeds findings later.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import { VITANA_ENV } from '../../../env';
import { decide, DecideOptions } from '../jev-decision-service';
import * as repo from '../jev-repository';
import { jevGateMode, recordJevShadowDecision } from '../jev-shadow';

export const SLOW_SESSION_GATE = 'voice_slow_session';
export const MAX_SESSIONS_PER_DAY = 20;
export const SLOW_CONTEXT_MS = 3000;
const SYSTEM_CALLER = { actor_id: 'orb-voice-telemetry', system: true } as const;
const TICK_MS = 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export interface SlowSessionSignals {
  stall_reason: string;
  timeout_ms?: number;
  provider?: string;
  lang?: string;
  turn_count?: number;
  audio_in_chunks?: number;
  audio_out_chunks?: number;
  greeting_sent?: boolean;
  prewarm_missed: boolean;
  context_build_ms?: number;
  context_chars?: number;
  tool_catalog_bytes?: number;
  tool_calls: number;
  tool_failures: number;
  upstream_close_reason?: string;
  reconnects: number;
}

type Meta = Record<string, unknown>;
const str = (v: unknown, max = 60): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);

/** Summarise one stalled session from its stall event and its own events, by an explicit allow-list. */
export function buildSlowSessionSignals(stall: Meta, events: Array<{ topic?: string; metadata?: Meta | null }>): SlowSessionSignals {
  const s: SlowSessionSignals = {
    stall_reason: str(stall.reason) || 'unknown',
    timeout_ms: num(stall.timeout_ms),
    turn_count: num(stall.turn_count),
    audio_out_chunks: num(stall.audio_out_chunks),
    greeting_sent: typeof stall.greeting_sent === 'boolean' ? stall.greeting_sent : undefined,
    prewarm_missed: false,
    tool_calls: 0,
    tool_failures: 0,
    reconnects: 0,
  };
  for (const e of events) {
    const m = e.metadata || {};
    const stage = e.topic === 'orb.live.diag' ? m.stage : undefined;
    if (!s.provider) s.provider = str(m.provider);
    if (e.topic === 'vtid.live.session.start') s.lang = str(m.lang, 16);
    if (e.topic === 'orb.live.context.bootstrap') {
      s.context_build_ms = Math.max(s.context_build_ms ?? 0, num(m.latency_ms) ?? 0);
      s.context_chars = Math.max(s.context_chars ?? 0, num(m.chars) ?? 0);
    }
    if (e.topic === 'orb.live.tool.executed') s.tool_calls++;
    if (stage === 'tool_failed') s.tool_failures++;
    if (stage === 'nova_prewarm_missed') s.prewarm_missed = true;
    if (stage === 'reconnect_triggered') s.reconnects++;
    if (stage === 'tool_catalog_trimmed') s.tool_catalog_bytes = num(m.bytes_after) ?? s.tool_catalog_bytes;
    if (stage === 'upstream_closed' && !s.upstream_close_reason) s.upstream_close_reason = str(m.reason);
    if (stage === 'watchdog_fired') s.audio_in_chunks = num(m.audio_in) ?? s.audio_in_chunks;
  }
  return s;
}

/** The cause the counters name on their own, or null where they do not. */
export function ruleCause(s: SlowSessionSignals): string | null {
  if (s.tool_failures > 0 || (s.stall_reason === 'response_timeout' && s.tool_calls > 0)) return 'tool_call';
  if (s.prewarm_missed && (s.stall_reason === 'forwarding_no_ack' || s.stall_reason === 'audio_stall')) return 'upstream_connection';
  if ((s.context_build_ms ?? 0) >= SLOW_CONTEXT_MS) return 'context_build';
  if (s.stall_reason === 'greeting_timeout') return 'upstream_model';
  return null;
}

export function isSlowSessionOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(SLOW_SESSION_GATE, env) !== 'off';
}

/**
 * Judge one UTC day (YYYY-MM-DD). Never throws. Returns the number of rows
 * written (0 when off, nothing stalled, or every session already judged).
 */
export async function runSlowSessionDay(
  day: string,
  opts: { env?: NodeJS.ProcessEnv; vitanaEnv?: string; sb?: SupabaseClient | null; decideOptions?: Omit<DecideOptions, 'source' | 'env'> } = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const mode = jevGateMode(SLOW_SESSION_GATE, env);
  if (mode === 'off') return 0;
  const sb = opts.sb === undefined ? getSupabase() : opts.sb;
  if (!sb) return 0;
  const vitanaEnv = opts.vitanaEnv ?? VITANA_ENV;
  try {
    const since = `${day}T00:00:00.000Z`;
    const until = new Date(Date.parse(since) + 24 * HOUR).toISOString();
    const { data, error } = await repo.fetchStallEvents(sb, since, until);
    if (error || !data) return 0;
    const stalls = new Map<string, Meta>();
    for (const row of data as Array<{ metadata?: Meta | null }>) {
      const m = row.metadata || {};
      const sid = str(m.session_id, 120);
      if (!sid || (m.env && m.env !== vitanaEnv) || stalls.has(sid)) continue;
      stalls.set(sid, m);
    }
    let written = 0;
    for (const [sid, stall] of [...stalls].slice(0, MAX_SESSIONS_PER_DAY)) {
      const seen = await repo.fetchRecentShadowBySubject(sb, SLOW_SESSION_GATE, sid, since);
      if (!seen.error && seen.data) continue;
      const ev = await repo.fetchSessionEvents(sb, sid, new Date(Date.parse(since) - HOUR).toISOString(), new Date(Date.parse(until) + HOUR).toISOString());
      const signals = buildSlowSessionSignals(stall, ev.error || !ev.data ? [] : (ev.data as Array<{ topic?: string; metadata?: Meta }>));
      const rule = ruleCause(signals);
      const r = await decide('slow_session_cause', { ...signals }, SYSTEM_CALLER, { ...(opts.decideOptions || {}), source: `gate:${SLOW_SESSION_GATE}`, env });
      const cause = r.ok && r.outcome === 'decided' ? String(r.verdict.value) : null;
      const agreed = cause && rule ? cause === rule : null;
      const id = await recordJevShadowDecision(
        {
          gate: SLOW_SESSION_GATE,
          decision: 'slow_session_cause',
          mode,
          plane: 'internal',
          tenant_id: null,
          subject_type: 'voice_session',
          subject_ref: sid,
          jev_outcome: r.outcome,
          jev_verdict: r.ok
            ? { cause: r.verdict.value, fixable: r.answers.fixable?.probability ?? null, rule_cause: rule, ...signals, day }
            : { reason: r.reason, rule_cause: rule, ...signals, day },
          jev_confidence: r.ok ? r.verdict.confidence : null,
          system_action: rule ? `rule:${rule}` : 'rule:none',
          cost_usd: r.ok ? r.cost_usd : 0,
          agreed,
          outcome: agreed === null ? null : 'compared_with_rule_cause',
          outcome_at: agreed === null ? null : new Date().toISOString(),
        },
        sb,
      );
      if (id) written++;
    }
    return written;
  } catch (err: any) {
    console.warn(`[jev] ${SLOW_SESSION_GATE} day ${day} failed: ${err?.message || err}`);
    return 0;
  }
}

let timerId: ReturnType<typeof setInterval> | null = null;
let lastDay: string | null = null;

/** Hourly tick, judges yesterday (UTC) once. Off unless the gate's mode is set. */
export function startSlowSessionScheduler(env: NodeJS.ProcessEnv = process.env): boolean {
  if (timerId || !isSlowSessionOn(env)) return false;
  const tick = async () => {
    const yesterday = new Date(Date.now() - 24 * HOUR).toISOString().slice(0, 10);
    if (lastDay === yesterday) return;
    await runSlowSessionDay(yesterday);
    lastDay = yesterday;
  };
  timerId = setInterval(() => { void tick(); }, TICK_MS);
  timerId.unref?.();
  void tick();
  return true;
}

export function stopSlowSessionSchedulerForTest(): void {
  if (timerId) clearInterval(timerId);
  timerId = null;
  lastDay = null;
}
