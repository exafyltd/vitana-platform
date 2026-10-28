/**
 * VTID-04878 — pay one occurrence of a capped VTNA rule (owner decision
 * 2026-10-05): autopilot_action_done, live_room_15min, index_new_best.
 *
 * Amount, cap and window come from the rule table (vtna-reward-rules.ts),
 * never from a caller or a client. claim_capped_reward() does the duplicate
 * check, the cap and the credit under one per-member+rule lock, so a cap
 * holds when two claims race. A failed claim is reported, never thrown —
 * paying a reward must never fail the action that earned it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getRewardRule, isRuleLive } from './vtna-reward-rules';
import * as repo from './capped-reward-repository';

export type CappedClaimOutcome =
  | 'claimed'
  | 'duplicate'
  | 'capped'
  | 'not_eligible'
  | 'not_capped_rule'
  | 'rule_off'
  | 'failed';

export interface CappedClaimResult {
  outcome: CappedClaimOutcome;
  /** VTNA actually credited by this call (0 unless outcome is 'claimed'). */
  credited: number;
  error?: string;
}

export async function claimCappedReward(
  sb: SupabaseClient,
  args: { tenantId: string | null | undefined; userId: string; ruleId: string; ref: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<CappedClaimResult> {
  const rule = getRewardRule(args.ruleId);
  if (!rule || !rule.cap || !rule.window) return { outcome: 'not_capped_rule', credited: 0 };
  if (!isRuleLive(rule, env)) return { outcome: 'rule_off', credited: 0 };

  try {
    const { data, error } = await repo.rpcClaimCappedReward(sb, {
      p_tenant_id: args.tenantId ?? null,
      p_user_id: args.userId,
      p_rule: rule.id,
      p_ref: args.ref,
      p_amount: rule.amount,
      p_cap: rule.cap.count,
      p_window: rule.window,
    });
    if (error) {
      console.error(`[capped-reward] ${rule.id} claim failed for ${args.userId.slice(0, 8)}…: ${error.message}`);
      return { outcome: 'failed', credited: 0, error: error.message };
    }
    const r = (data ?? {}) as { ok?: boolean; claimed?: boolean; reason?: string; amount?: number; error?: string };
    if (r.ok !== true) {
      if (r.error === 'NOT_ELIGIBLE') return { outcome: 'not_eligible', credited: 0 };
      console.error(`[capped-reward] ${rule.id} refused for ${args.userId.slice(0, 8)}…: ${r.error ?? 'unknown'}`);
      return { outcome: 'failed', credited: 0, error: r.error ?? 'unknown' };
    }
    if (r.claimed) return { outcome: 'claimed', credited: Number(r.amount ?? rule.amount) };
    return { outcome: r.reason === 'capped' ? 'capped' : 'duplicate', credited: 0 };
  } catch (err: any) {
    console.error(`[capped-reward] ${rule.id} claim threw for ${args.userId.slice(0, 8)}…: ${err?.message ?? err}`);
    return { outcome: 'failed', credited: 0, error: String(err?.message ?? err) };
  }
}
