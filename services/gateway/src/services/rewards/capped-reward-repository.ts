/**
 * VTID-04878 — DB access for capped VTNA rewards. The claim itself (cap,
 * duplicate check, credit) is one locked SQL call, claim_capped_reward().
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export function rpcClaimCappedReward(sb: SupabaseClient, params: {
  p_tenant_id: string | null;
  p_user_id: string;
  p_rule: string;
  p_ref: string;
  p_amount: number;
  p_cap: number;
  p_window: string;
}) {
  return sb.rpc('claim_capped_reward', params);
}
