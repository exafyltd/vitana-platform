/**
 * VTID-03081 (B1 wiring): cadence signals for the wake-brief decision.
 *
 * The B1 greeting-decay policy in `orb/live/instruction/greeting-policy.ts`
 * already reads ALL of the cadence signals it needs:
 *   - seconds_since_last_turn_anywhere
 *   - sessions_today_count
 *   - is_transparent_reconnect
 *   - time_since_last_greeting_today_ms
 *   - greeting_style_last_used
 *   - wake_origin
 *   - device_handoff_signal
 *
 * The bug those rules were never enforcing is upstream: the wake-brief
 * wiring (services/wake-brief-wiring.ts) was calling
 * `decideGreetingPolicy()` with ONLY `bucket / isReconnect / wasFailure`
 * — the cadence signals were never populated, so the policy fell through
 * to the bucket-only truth table and the same "Schön, dass du wieder da
 * bist" line could fire five times in a row.
 *
 * This module reads the durable cadence signals from `user_assistant_state`
 * and writes them back when the wake-brief actually speaks. Three keys:
 *
 *   `wake_cadence:last_turn_at`         (ISO 8601) — last assistant or user
 *                                                    turn anywhere
 *   `wake_cadence:last_greeting_at`     (ISO 8601) — last time we emitted a
 *                                                    non-skip greeting
 *   `wake_cadence:last_greeting_style`  (GreetingPolicy) — what style was
 *                                                    emitted
 *   `wake_cadence:sessions_today`       (date + count) — wraps on day change
 *
 * Read paths fail-open: a DB outage MUST NOT silence the orb. On error
 * the cadence subset is returned empty — the policy degrades to the
 * existing bucket-based behavior.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  GreetingPolicy,
  GreetingPolicyInput,
} from '../orb/live/instruction/greeting-policy';

const SIGNAL_LAST_TURN_AT = 'wake_cadence:last_turn_at';
const SIGNAL_LAST_GREETING_AT = 'wake_cadence:last_greeting_at';
const SIGNAL_LAST_GREETING_STYLE = 'wake_cadence:last_greeting_style';
const SIGNAL_SESSIONS_TODAY = 'wake_cadence:sessions_today';

export const WAKE_CADENCE_SIGNAL_NAMES = [
  SIGNAL_LAST_TURN_AT,
  SIGNAL_LAST_GREETING_AT,
  SIGNAL_LAST_GREETING_STYLE,
  SIGNAL_SESSIONS_TODAY,
] as const;

export interface WakeCadenceFetchInputs {
  supabase: SupabaseClient;
  tenantId: string;
  userId: string;
  /** ISO 8601 — server-side now. Used for delta math + day-bucket. */
  nowIso?: string;
}

/**
 * Read the cadence subset of `GreetingPolicyInput` from
 * `user_assistant_state`. Returns an empty object on error or when
 * required identity is missing — the policy degrades gracefully.
 */
export async function fetchWakeCadenceSignals(
  inputs: WakeCadenceFetchInputs,
): Promise<Partial<GreetingPolicyInput>> {
  if (!inputs.tenantId || !inputs.userId) return {};
  const nowIso = inputs.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) return {};
  const todayKey = nowIso.slice(0, 10); // YYYY-MM-DD UTC

  try {
    const { data, error } = await inputs.supabase
      .from('user_assistant_state')
      .select('signal_name, value, last_seen_at')
      .eq('tenant_id', inputs.tenantId)
      .eq('user_id', inputs.userId)
      .in('signal_name', WAKE_CADENCE_SIGNAL_NAMES as unknown as string[]);
    if (error) return {};
    const rows = (data || []) as Array<{
      signal_name: string;
      value: unknown;
      last_seen_at: string;
    }>;
    const out: Partial<GreetingPolicyInput> = {};
    for (const row of rows) {
      switch (row.signal_name) {
        case SIGNAL_LAST_TURN_AT: {
          const ts = pickIso(row.value, row.last_seen_at);
          const secs = secondsBetween(ts, nowMs);
          if (secs !== null) out.seconds_since_last_turn_anywhere = secs;
          break;
        }
        case SIGNAL_LAST_GREETING_AT: {
          const ts = pickIso(row.value, row.last_seen_at);
          const ms = msBetween(ts, nowMs);
          if (ms !== null && sameUtcDay(ts, nowIso)) {
            out.time_since_last_greeting_today_ms = ms;
          }
          break;
        }
        case SIGNAL_LAST_GREETING_STYLE: {
          const style = pickGreetingStyle(row.value);
          if (style) out.greeting_style_last_used = style;
          break;
        }
        case SIGNAL_SESSIONS_TODAY: {
          const count = pickSessionsTodayCount(row.value, todayKey);
          if (count !== null) out.sessions_today_count = count;
          break;
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Write paths — called after wake-brief speaks (fire-and-forget).
// ---------------------------------------------------------------------------

export interface RecordWakeBriefEmittedInputs {
  supabase: SupabaseClient;
  tenantId: string;
  userId: string;
  /** The picked greeting style. `skip` MUST NOT be recorded — we only
   *  record when a greeting actually emits. */
  style: GreetingPolicy;
  nowIso?: string;
}

/**
 * Persist `last_greeting_at` + `last_greeting_style` so the next session
 * can apply the 15-min skip rule and same-style downgrade. Fire-and-forget
 * at the caller — this function awaits the upsert so test assertions can
 * see the row, but production callers can `void` it. Never throws.
 */
export async function recordWakeBriefEmitted(
  inputs: RecordWakeBriefEmittedInputs,
): Promise<{ ok: boolean; reason?: string }> {
  if (!inputs.tenantId || !inputs.userId) {
    return { ok: false, reason: 'missing_identity' };
  }
  if (inputs.style === 'skip') {
    return { ok: false, reason: 'skip_not_recorded' };
  }
  const nowIso = inputs.nowIso ?? new Date().toISOString();
  try {
    const { error } = await inputs.supabase
      .from('user_assistant_state')
      .upsert(
        [
          {
            tenant_id: inputs.tenantId,
            user_id: inputs.userId,
            signal_name: SIGNAL_LAST_GREETING_AT,
            value: { iso: nowIso },
            last_seen_at: nowIso,
          },
          {
            tenant_id: inputs.tenantId,
            user_id: inputs.userId,
            signal_name: SIGNAL_LAST_GREETING_STYLE,
            value: { style: inputs.style },
            last_seen_at: nowIso,
          },
        ],
        { onConflict: 'tenant_id,user_id,signal_name' },
      );
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Persist a session-start tick for `sessions_today_count`. Fire-and-forget.
 *
 * Storage shape: `{ date: 'YYYY-MM-DD', count: N }`. On a new UTC day the
 * count resets to 1; same day increments. Never throws.
 */
export async function recordWakeSessionStart(
  inputs: RecordWakeBriefEmittedInputs,
): Promise<{ ok: boolean; reason?: string }> {
  if (!inputs.tenantId || !inputs.userId) {
    return { ok: false, reason: 'missing_identity' };
  }
  const nowIso = inputs.nowIso ?? new Date().toISOString();
  const today = nowIso.slice(0, 10);
  try {
    // Read-modify-write — small race window but the policy degrades
    // gracefully on inaccurate counts (over-count → softer greeting,
    // under-count → louder; both safe).
    const { data: existing } = await inputs.supabase
      .from('user_assistant_state')
      .select('value')
      .eq('tenant_id', inputs.tenantId)
      .eq('user_id', inputs.userId)
      .eq('signal_name', SIGNAL_SESSIONS_TODAY)
      .maybeSingle();
    let nextCount = 1;
    if (existing && typeof existing === 'object') {
      const prev = (existing as { value: unknown }).value;
      if (prev && typeof prev === 'object') {
        const prevDate = (prev as { date?: unknown }).date;
        const prevCount = (prev as { count?: unknown }).count;
        if (prevDate === today && typeof prevCount === 'number') {
          nextCount = prevCount + 1;
        }
      }
    }
    const { error } = await inputs.supabase
      .from('user_assistant_state')
      .upsert(
        {
          tenant_id: inputs.tenantId,
          user_id: inputs.userId,
          signal_name: SIGNAL_SESSIONS_TODAY,
          value: { date: today, count: nextCount },
          last_seen_at: nowIso,
        },
        { onConflict: 'tenant_id,user_id,signal_name' },
      );
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * DEV-COMHU-0503 — ORB Recovery 2+3: persist `wake_cadence:last_turn_at`.
 *
 * This is the MISSING WRITER. `fetchWakeCadenceSignals` already reads
 * `last_turn_at` to compute `seconds_since_last_turn_anywhere`, but nothing in
 * the live path ever wrote it — so the policy always saw "no prior turn" and
 * the same wake line could fire on every reopen. Call on every meaningful
 * user/assistant turn (fire-and-forget). Never throws.
 */
export async function recordWakeTurn(
  inputs: { supabase: SupabaseClient; tenantId: string; userId: string; nowIso?: string },
): Promise<{ ok: boolean; reason?: string }> {
  if (!inputs.tenantId || !inputs.userId) {
    return { ok: false, reason: 'missing_identity' };
  }
  const nowIso = inputs.nowIso ?? new Date().toISOString();
  try {
    const { error } = await inputs.supabase
      .from('user_assistant_state')
      .upsert(
        {
          tenant_id: inputs.tenantId,
          user_id: inputs.userId,
          signal_name: SIGNAL_LAST_TURN_AT,
          value: { iso: nowIso },
          last_seen_at: nowIso,
        },
        { onConflict: 'tenant_id,user_id,signal_name' },
      );
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests.
// ---------------------------------------------------------------------------

export function pickIso(value: unknown, fallback: string | null): string | null {
  if (value && typeof value === 'object') {
    const iso = (value as { iso?: unknown }).iso;
    if (typeof iso === 'string' && iso) return iso;
  }
  return fallback;
}

export function pickGreetingStyle(value: unknown): GreetingPolicy | null {
  if (value && typeof value === 'object') {
    const s = (value as { style?: unknown }).style;
    if (s === 'skip' || s === 'brief_resume' || s === 'warm_return' || s === 'fresh_intro') {
      return s;
    }
  }
  return null;
}

export function pickSessionsTodayCount(value: unknown, todayKey: string): number | null {
  if (value && typeof value === 'object') {
    const date = (value as { date?: unknown }).date;
    const count = (value as { count?: unknown }).count;
    if (date === todayKey && typeof count === 'number' && Number.isFinite(count) && count >= 0) {
      return count;
    }
  }
  return null;
}

export function secondsBetween(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  const seconds = Math.max(0, Math.floor((nowMs - ts) / 1000));
  return seconds;
}

export function msBetween(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, nowMs - ts);
}

export function sameUtcDay(iso: string | null, nowIso: string): boolean {
  if (!iso) return false;
  return iso.slice(0, 10) === nowIso.slice(0, 10);
}
