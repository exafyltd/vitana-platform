/**
 * VTID-01973: Throttle (P2-A).
 *
 * Per-user posting caps to deter spam and bound new-account abuse:
 *   - Account < 7 days old: 1 open intent across all kinds, max budget €500.
 *   - Mature accounts: 20 open intents per kind, 3 posts per kind per 24h.
 *
 * VTID-02719 (2026-05-04): per-kind open cap raised 5 → 20 after early
 * users hit the limit on legitimate use. Daily 3/24h anti-spam cap
 * unchanged.
 */

import { createClient } from '@supabase/supabase-js';
import type { IntentKind } from './intent-classifier';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;

function getSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
}

interface ThrottleResult {
  ok: boolean;
  reason?: 'new_account_cap' | 'open_intent_cap' | 'daily_post_cap' | 'budget_cap';
  detail?: string;
}

const NEW_ACCOUNT_DAYS = 7;
const NEW_ACCOUNT_MAX_OPEN = 1;
const NEW_ACCOUNT_MAX_BUDGET_EUR = 500;
const MATURE_MAX_OPEN_PER_KIND = 20;
const MATURE_MAX_POSTS_PER_KIND_PER_24H = 3;

export async function canPostIntent(args: {
  userId: string;
  kind: IntentKind;
  budgetMaxEur: number | null;
}): Promise<ThrottleResult> {
  const supabase = getSupabase();

  // 1. Account age — read auth.users.created_at via app_users (already keyed by user_id).
  const { data: appUser } = await supabase
    .from('app_users')
    .select('created_at')
    .eq('user_id', args.userId)
    .maybeSingle();

  const accountCreatedAt = appUser?.created_at ? new Date(appUser.created_at as string) : new Date();
  const accountAgeDays = (Date.now() - accountCreatedAt.getTime()) / (1000 * 60 * 60 * 24);
  const isNewAccount = accountAgeDays < NEW_ACCOUNT_DAYS;

  // 2. Open intent count.
  const { count: openCount } = await supabase
    .from('user_intents')
    .select('*', { count: 'exact', head: true })
    .eq('requester_user_id', args.userId)
    .in('status', ['open', 'matched', 'engaged']);

  if (isNewAccount && (openCount ?? 0) >= NEW_ACCOUNT_MAX_OPEN) {
    return { ok: false, reason: 'new_account_cap', detail: `New accounts (<${NEW_ACCOUNT_DAYS}d) limited to ${NEW_ACCOUNT_MAX_OPEN} open intent.` };
  }

  // Per-kind open cap (mature accounts).
  if (!isNewAccount) {
    const { count: openKindCount } = await supabase
      .from('user_intents')
      .select('*', { count: 'exact', head: true })
      .eq('requester_user_id', args.userId)
      .eq('intent_kind', args.kind)
      .in('status', ['open', 'matched', 'engaged']);

    if ((openKindCount ?? 0) >= MATURE_MAX_OPEN_PER_KIND) {
      return { ok: false, reason: 'open_intent_cap', detail: `Limit of ${MATURE_MAX_OPEN_PER_KIND} open ${args.kind} intents.` };
    }
  }

  // 3. New-account budget cap (commercial only).
  if (isNewAccount && (args.kind === 'commercial_buy' || args.kind === 'commercial_sell')) {
    if (args.budgetMaxEur !== null && args.budgetMaxEur > NEW_ACCOUNT_MAX_BUDGET_EUR) {
      return { ok: false, reason: 'budget_cap', detail: `New accounts capped at €${NEW_ACCOUNT_MAX_BUDGET_EUR}.` };
    }
  }

  // 4. Daily post cap per kind (mature).
  // VTID-02719: exclude user-closed rows so manually freeing a slot also frees
  // the 24h slot. Other terminal statuses (flagged/rejected) still count, so
  // anti-spam is preserved.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: dayCount } = await supabase
    .from('user_intents')
    .select('*', { count: 'exact', head: true })
    .eq('requester_user_id', args.userId)
    .eq('intent_kind', args.kind)
    .gte('created_at', since)
    .neq('status', 'closed');

  if (!isNewAccount && (dayCount ?? 0) >= MATURE_MAX_POSTS_PER_KIND_PER_24H) {
    return { ok: false, reason: 'daily_post_cap', detail: `Max ${MATURE_MAX_POSTS_PER_KIND_PER_24H} ${args.kind} posts per 24h.` };
  }

  return { ok: true };
}
