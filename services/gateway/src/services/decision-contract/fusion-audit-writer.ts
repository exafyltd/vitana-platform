// VTID-03144 — D42 fusion audit writer.
//
// Boundary module for the `d42_fusion_audit` INSERT that previously
// lived inside `d42-context-fusion-engine.ts`. With this module in
// place, the D42 file no longer imports `@supabase/supabase-js`
// directly: the writer terminates the Supabase boundary inside
// `services/decision-contract/*` and routes through the two approved
// helpers (`getSupabase()` for service-role writes,
// `createUserSupabaseClient(token)` for user-token / RLS writes).
//
// Byte-identical behaviour vs the pre-VTID-03144 d42 path:
//   - Same table: `d42_fusion_audit`.
//   - Same payload columns and ordering as the original `.insert({...})`.
//   - Same gate: user-token path if `authToken` is provided; otherwise
//     service-role path only inside a dev/sandbox environment; otherwise
//     refuse with a `Cannot store audit without auth` warning.
//   - Same return shape: `Promise<boolean>` (`true` on insert success,
//     `false` on any failure, including missing config).
//   - Same log prefix `[D42-Fusion]` so existing log monitors keep
//     matching.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../lib/supabase';
import { createUserSupabaseClient } from '../../lib/supabase-user';
import type { FusionAuditEntry } from '../../types/context-fusion';

const LOG_PREFIX = '[D42-Fusion]';

/**
 * Mirror of the pre-VTID-03144 `isDevSandbox()` predicate that the d42
 * engine previously kept inline. Lifted here so the writer owns the
 * full decision of whether a service-role write is permitted.
 */
function isDevSandbox(): boolean {
  const env = (process.env.ENVIRONMENT || process.env.VITANA_ENV || '').toLowerCase();
  return env === 'dev-sandbox' ||
         env === 'dev' ||
         env === 'development' ||
         env === 'sandbox' ||
         env.includes('dev') ||
         env.includes('sandbox');
}

function resolveClient(authToken: string | undefined): SupabaseClient | null {
  if (authToken) {
    try {
      return createUserSupabaseClient(authToken);
    } catch (e: any) {
      console.warn(`${LOG_PREFIX} ${e?.message ?? e}`);
      return null;
    }
  }
  if (isDevSandbox()) {
    return getSupabase();
  }
  console.warn(`${LOG_PREFIX} Cannot store audit without auth`);
  return null;
}

export async function storeFusionAudit(
  entry: FusionAuditEntry,
  authToken?: string,
): Promise<boolean> {
  try {
    const supabase = resolveClient(authToken);
    if (!supabase) {
      return false;
    }

    const { error } = await supabase
      .from('d42_fusion_audit')
      .insert({
        id: entry.id,
        tenant_id: entry.tenant_id,
        user_id: entry.user_id,
        session_id: entry.session_id,
        turn_id: entry.turn_id,
        input_summary: entry.input_summary,
        resolved_plan: entry.resolved_plan,
        conflicts_count: entry.conflicts_count,
        rules_applied: entry.rules_applied,
        duration_ms: entry.duration_ms,
        created_at: entry.created_at,
      });

    if (error) {
      console.warn(`${LOG_PREFIX} Failed to store audit:`, error.message);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`${LOG_PREFIX} Error storing audit:`, error);
    return false;
  }
}
