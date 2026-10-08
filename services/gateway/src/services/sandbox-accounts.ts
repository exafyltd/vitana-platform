/**
 * VTID-04971 — the OpenAI reviewer sandbox (owner decision 2026-10-08, Option A).
 *
 * A sandbox supplier is a registered test/service account (service_bot_accounts
 * or notification_test_actors, the same allowlists that already keep such
 * accounts away from members, notifications and commissions). No new column:
 * the OWNER of the organization decides, exactly like `supplier_listing_block`
 * (VTID-04769) which keeps such a supplier's products from ever going live.
 *
 * What the sandbox changes in the supplier flow:
 *  - submit_for_verification records the request and stops: the organization
 *    keeps its state, so it never reaches the review queue and never goes live;
 *  - connect_store only recognises the platform: no connection, no integration
 *    manifest is created for another admin to see;
 *  - the Command Hub review list leaves sandbox organizations out.
 *
 * Fails toward the normal flow on a lookup error (a real supplier must never be
 * stuck): the products can still not go live (database gate) and the review list
 * filter is a second line.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export const SANDBOX_SUBMIT_NOTE =
  'This is a review sandbox: the submission is recorded, but it does not go to Vitanaland staff and nothing goes live.';

/** True when the account is a registered test or service account. */
export async function isSandboxAccount(sb: SupabaseClient, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    const [bots, actors] = await Promise.all([
      sb.from('service_bot_accounts').select('user_id').eq('user_id', userId).limit(1),
      sb.from('notification_test_actors').select('user_id').eq('user_id', userId).limit(1),
    ]);
    if (bots.error || actors.error) return false;
    return ((bots.data as unknown[]) ?? []).length > 0 || ((actors.data as unknown[]) ?? []).length > 0;
  } catch {
    return false;
  }
}
