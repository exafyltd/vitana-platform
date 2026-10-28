/**
 * VTID-04775: Jev P1 gate C1 — how did an ORB voice session end?
 * (docs/JEV-INTEGRATION-PLAN.md §10.4 C1)
 *
 *   voice_session_outcome   (JEV_VOICE_SESSION_OUTCOME_MODE = off | shadow | enforce)
 *
 * Post-session TELEMETRY only: counters, the stop reason and the session's
 * own flags (provider, language, greeting sent, reconnects, last watchdog
 * reason, tool-call streak). Never a transcript, never memory, never who
 * the member is — `pii: 'forbid'` refuses any state that looks personal.
 *
 * Runs once per session from the existing voice self-healing dispatch
 * (every stop site already calls it, fire-and-forget), after the rule-based
 * classifier (voice-failure-taxonomy) has answered. One
 * `jev_shadow_decisions` row per session: Jev's outcome class and
 * "needs fix" next to the rule class. Where the rules named a class, the
 * row says whether Jev agrees; where they said nothing, `agreed` is null and
 * the row counts how often Jev sees a fixable failure the rules miss — the
 * blind spot (e.g. content-filter closes read as idle timeouts) C1 exists
 * to measure. There is no enforce behaviour: the outcome feeds C2/C4 later.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import { decide, DecideOptions } from '../jev-decision-service';
import { jevGateMode, recordJevShadowDecision } from '../jev-shadow';

export const VOICE_OUTCOME_GATE = 'voice_session_outcome';
const SYSTEM_CALLER = { actor_id: 'orb-voice-telemetry', system: true } as const;

export interface VoiceOutcomeSignals {
  stop_reason?: string;
  provider?: string;
  lang?: string;
  greeting_sent?: boolean;
  reconnects?: number;
  watchdog_reason?: string | null;
  tool_call_streak?: number;
  connection_failed?: boolean;
}

const str = (v: unknown, max = 80): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);

/**
 * Reads the outcome signals off a live session object. Counters and flags
 * only, by an explicit allow-list — nothing else on the session is touched.
 */
export function buildVoiceOutcomeSignals(session: unknown, stopReason: string): VoiceOutcomeSignals {
  const s = (session && typeof session === 'object' ? session : {}) as Record<string, unknown>;
  return {
    stop_reason: str(stopReason),
    provider: str(s.upstreamProvider, 40),
    lang: str(s.lang, 16),
    greeting_sent: typeof s.greetingSent === 'boolean' ? s.greetingSent : undefined,
    reconnects: int(s._reconnectCount),
    watchdog_reason: str(s.responseWatchdogReason) ?? null,
    tool_call_streak: int(s.consecutiveToolCalls),
  };
}

/** Rule class (voice-failure-taxonomy) → the outcome class it implies, for agreement. */
const RULE_TO_OUTCOME: Record<string, string> = {
  'voice.no_engagement': 'no_engagement',
  'voice.low_turn_progression': 'no_engagement',
  'voice.model_under_responds': 'one_way_audio',
  'voice.audio_one_way': 'one_way_audio',
  'voice.model_stall': 'model_stalled',
  'voice.upstream_disconnect': 'connection_dropped',
  'voice.tool_loop': 'looping',
  'voice.auth_rejected': 'failed_to_start',
  'voice.config_missing': 'failed_to_start',
  'voice.permission_denied': 'failed_to_start',
};

export function ruleOutcome(ruleClass: string | null | undefined): string | null {
  return ruleClass ? RULE_TO_OUTCOME[ruleClass] ?? null : null;
}

export interface VoiceOutcomeArgs {
  sessionId: string;
  metrics?: {
    audio_in_chunks?: number;
    audio_in_forwarded?: number;
    audio_out_chunks?: number;
    duration_ms?: number;
    turn_count?: number;
    user_turns?: number;
    model_turns?: number;
  };
  signals?: VoiceOutcomeSignals;
  /** The rule-based class the self-healing dispatch reached, if any. */
  ruleClass?: string | null;
  synthetic?: boolean;
  env?: NodeJS.ProcessEnv;
  sb?: SupabaseClient | null;
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
}

export function isVoiceOutcomeOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(VOICE_OUTCOME_GATE, env) !== 'off';
}

/** Never throws. Returns the shadow row id, or null when off/skipped/failed. */
export async function runVoiceOutcomeCheck(a: VoiceOutcomeArgs): Promise<string | null> {
  const env = a.env ?? process.env;
  const mode = jevGateMode(VOICE_OUTCOME_GATE, env);
  if (mode === 'off' || a.synthetic) return null;
  // A session with no metrics at all is a fast-fail before anything started:
  // still worth a row when the caller says the connection failed.
  if (!a.metrics && !a.signals?.connection_failed) return null;
  try {
    const m = a.metrics || {};
    const sig = a.signals || {};
    const r = await decide(
      'voice_session_outcome',
      {
        stop_reason: sig.stop_reason,
        provider: sig.provider,
        lang: sig.lang,
        duration_s: Math.round((m.duration_ms || 0) / 100) / 10,
        turns: m.turn_count || 0,
        user_turns: m.user_turns,
        model_turns: m.model_turns,
        audio_in_chunks: m.audio_in_chunks || 0,
        audio_in_forwarded: m.audio_in_forwarded,
        audio_out_chunks: m.audio_out_chunks || 0,
        greeting_sent: sig.greeting_sent,
        reconnects: sig.reconnects,
        watchdog_reason: sig.watchdog_reason ?? undefined,
        tool_call_streak: sig.tool_call_streak,
        connection_failed: sig.connection_failed,
        rule_class: a.ruleClass ?? undefined,
      },
      SYSTEM_CALLER,
      { ...(a.decideOptions || {}), source: `gate:${VOICE_OUTCOME_GATE}`, env },
    );
    const outcome = r.ok && r.outcome === 'decided' ? String(r.verdict.value) : null;
    const expected = ruleOutcome(a.ruleClass);
    const agreed = outcome && expected ? outcome === expected : null;
    // VTID-05012: an abstained row is scored on its lean; `agreed` stays decided-only.
    const lean = r.ok && r.outcome === 'abstained' ? String(r.verdict.value) : null;
    const leanAgreed = lean && expected ? lean === expected : null;
    const compared = agreed !== null || leanAgreed !== null;
    return await recordJevShadowDecision(
      {
        gate: VOICE_OUTCOME_GATE,
        decision: 'voice_session_outcome',
        mode,
        plane: 'internal',
        tenant_id: null,
        subject_type: 'orb_voice_session',
        subject_ref: a.sessionId,
        jev_outcome: r.outcome,
        jev_verdict: r.ok
          ? {
              outcome: r.verdict.value,
              needs_fix: r.answers.needs_fix?.probability ?? null,
              provider: sig.provider ?? null,
              stop_reason: sig.stop_reason ?? null,
              rule_outcome: expected,
              ...(lean !== null ? { lean } : {}),
            }
          : { reason: r.reason },
        jev_confidence: r.ok ? r.verdict.confidence : null,
        system_action: a.ruleClass || 'no_rule_class',
        agreed,
        lean_agreed: leanAgreed,
        outcome: compared ? 'compared_with_rule_class' : null,
        outcome_at: compared ? new Date().toISOString() : null,
        cost_usd: r.ok ? r.cost_usd : 0,
      },
      a.sb === undefined ? getSupabase() : a.sb,
    );
  } catch (err: any) {
    console.warn(`[jev] ${VOICE_OUTCOME_GATE} check failed for ${a.sessionId}: ${err?.message || err}`);
    return null;
  }
}
