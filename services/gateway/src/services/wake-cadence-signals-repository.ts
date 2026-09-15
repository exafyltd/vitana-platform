// Genuinely tested via test/services/wake-cadence-signals.test.ts and
// test/services/orb-recovery-greeting-cadence.test.ts, which drive a
// real functional fake SupabaseClient (pattern-matched by chain shape,
// not call order or filter values) — covers fetchWakeCadenceSignals,
// recordWakeBriefEmitted, and recordWakeTurn's queries. The
// read-modify-write select in recordWakeSessionStart is not exercised
// by either fake (neither defines `.maybeSingle()`); wholesale-mocked
// by test/routes/orb-livekit.test.ts otherwise.
/**
 * services/wake-cadence-signals.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in wake-cadence-signals.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchWakeCadenceSignalRows(sb: SupabaseClient, tenantId: string, userId: string, signalNames: readonly string[]) {
  return sb
    .from('user_assistant_state')
    .select('signal_name, value, last_seen_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .in('signal_name', signalNames as unknown as string[]);
}

export async function upsertWakeBriefEmittedSignals(
  sb: SupabaseClient,
  rows: Array<{ tenant_id: string; user_id: string; signal_name: string; value: unknown; last_seen_at: string }>,
) {
  return sb.from('user_assistant_state').upsert(rows, { onConflict: 'tenant_id,user_id,signal_name' });
}

export async function fetchWakeSessionsTodaySignal(sb: SupabaseClient, tenantId: string, userId: string, signalName: string) {
  return sb
    .from('user_assistant_state')
    .select('value')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('signal_name', signalName)
    .maybeSingle();
}

export async function upsertWakeCadenceSignal(
  sb: SupabaseClient,
  row: { tenant_id: string; user_id: string; signal_name: string; value: unknown; last_seen_at: string },
) {
  return sb.from('user_assistant_state').upsert(row, { onConflict: 'tenant_id,user_id,signal_name' });
}
