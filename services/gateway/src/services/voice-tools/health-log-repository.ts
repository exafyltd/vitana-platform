// Genuinely tested via test/services/voice-tools/health-log.test.ts,
// which drives a real functional fake SupabaseClient (table-keyed
// query mock via ./supabase-mock's createQueryMock — not a wholesale
// module mock).
/**
 * services/voice-tools/health-log.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * voice-tools/health-log.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchUserTenantIdForVoiceLog(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).limit(1).maybeSingle();
}

export async function fetchVitanaIndexScoreTotal(sb: SupabaseClient, userId: string, date: string) {
  return sb.from('vitana_index_scores').select('score_total').eq('user_id', userId).eq('date', date).maybeSingle();
}

export async function upsertHealthFeatureDaily(
  sb: SupabaseClient,
  row: {
    tenant_id: string;
    user_id: string;
    date: string;
    feature_key: string;
    feature_value: number;
    feature_unit: string;
    sample_count: number;
    confidence: number;
    metadata: Record<string, unknown>;
  },
) {
  return sb.from('health_features_daily').upsert(row, { onConflict: 'tenant_id,user_id,date,feature_key' });
}

export async function upsertManualEntryUserIntegration(
  sb: SupabaseClient,
  row: {
    user_id: string;
    integration_id: string;
    status: string;
    connected_at: string;
    last_sync_at: string;
    metadata: Record<string, unknown>;
    updated_at: string;
  },
) {
  return sb.from('user_integrations').upsert(row, { onConflict: 'user_id,integration_id' });
}

export async function computeVitanaIndexForUser(sb: SupabaseClient, userId: string, date: string) {
  return sb.rpc('health_compute_vitana_index_for_user', { p_user_id: userId, p_date: date });
}
