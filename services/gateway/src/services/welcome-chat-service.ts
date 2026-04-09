/**
 * Welcome Chat Service — Automated introduction messages for new community members
 *
 * When a new user registers and first logs in, this service sends a friendly
 * introduction message FROM the new user TO every existing community member
 * within the same tenant.
 *
 * Constraints:
 *  - Only runs for tenants with ≤ 1,000 registered users (community-scale)
 *  - Skips the Vitana bot user
 *  - Idempotent: checks welcome_chat_sent flag to avoid duplicate broadcasts
 *  - Runs fire-and-forget so it never blocks login
 *  - Batches inserts to avoid overwhelming the database
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { VITANA_BOT_USER_ID } from '../lib/vitana-bot';

const MAX_COMMUNITY_SIZE = 1000;
const BATCH_SIZE = 50;

const WELCOME_MESSAGE =
  'Hello! I am a new community member and happy to join you. ' +
  'Looking forward to having a great time together! 🙌';

/**
 * Send introduction chat messages from a newly registered user to all
 * existing community members in their tenant.
 *
 * This function is idempotent — it checks a flag in app_users metadata
 * before proceeding. Safe to call multiple times.
 */
export async function sendWelcomeChatMessages(
  userId: string,
  tenantId: string,
  supabase: SupabaseClient,
): Promise<{ sent: number; skipped: boolean; reason?: string }> {
  const tag = '[WelcomeChat]';

  try {
    // 1. Check if welcome messages were already sent for this user
    const { data: appUser, error: appUserErr } = await supabase
      .from('app_users')
      .select('welcome_chat_sent')
      .eq('user_id', userId)
      .single();

    if (appUserErr) {
      console.warn(`${tag} Could not check app_users for ${userId}: ${appUserErr.message}`);
      return { sent: 0, skipped: true, reason: 'app_users lookup failed' };
    }

    if ((appUser as any)?.welcome_chat_sent) {
      console.log(`${tag} Already sent for ${userId}, skipping`);
      return { sent: 0, skipped: true, reason: 'already_sent' };
    }

    // 2. Count community members in this tenant (exclude self + bot)
    const { count, error: countErr } = await supabase
      .from('user_tenants')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .neq('user_id', userId)
      .neq('user_id', VITANA_BOT_USER_ID);

    if (countErr) {
      console.warn(`${tag} Count query failed: ${countErr.message}`);
      return { sent: 0, skipped: true, reason: 'count_failed' };
    }

    const memberCount = count || 0;
    console.log(`${tag} Tenant ${tenantId} has ${memberCount} other members`);

    if (memberCount === 0) {
      await markWelcomeSent(userId, supabase);
      return { sent: 0, skipped: true, reason: 'no_other_members' };
    }

    if (memberCount > MAX_COMMUNITY_SIZE) {
      console.log(`${tag} Community too large (${memberCount} > ${MAX_COMMUNITY_SIZE}), skipping`);
      await markWelcomeSent(userId, supabase);
      return { sent: 0, skipped: true, reason: 'community_too_large' };
    }

    // 3. Fetch all member user_ids (excluding self + bot)
    const { data: members, error: membersErr } = await supabase
      .from('user_tenants')
      .select('user_id')
      .eq('tenant_id', tenantId)
      .neq('user_id', userId)
      .neq('user_id', VITANA_BOT_USER_ID)
      .limit(MAX_COMMUNITY_SIZE);

    if (membersErr || !members) {
      console.warn(`${tag} Members fetch failed: ${membersErr?.message}`);
      return { sent: 0, skipped: true, reason: 'members_fetch_failed' };
    }

    // 4. Build chat_messages rows
    const now = new Date().toISOString();
    const rows = members.map((m: { user_id: string }) => ({
      tenant_id: tenantId,
      sender_id: userId,
      receiver_id: m.user_id,
      content: WELCOME_MESSAGE,
      message_type: 'text',
      metadata: { source: 'welcome_chat', automated: true },
      created_at: now,
    }));

    // 5. Insert in batches
    let totalSent = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error: insertErr } = await supabase
        .from('chat_messages')
        .insert(batch as any);

      if (insertErr) {
        console.warn(`${tag} Batch insert failed at offset ${i}: ${insertErr.message}`);
      } else {
        totalSent += batch.length;
      }
    }

    // 6. Mark as sent so we never duplicate
    await markWelcomeSent(userId, supabase);

    console.log(`${tag} Sent ${totalSent} welcome messages from ${userId.slice(0, 8)} to tenant ${tenantId}`);
    return { sent: totalSent, skipped: false };
  } catch (err: any) {
    console.error(`${tag} Unexpected error: ${err.message}`);
    return { sent: 0, skipped: true, reason: err.message };
  }
}

async function markWelcomeSent(userId: string, supabase: SupabaseClient): Promise<void> {
  const { error } = await supabase
    .from('app_users')
    .update({ welcome_chat_sent: true } as any)
    .eq('user_id', userId);

  if (error) {
    console.warn(`[WelcomeChat] Failed to mark welcome_chat_sent for ${userId}: ${error.message}`);
  }
}
