/**
 * Community Group Enrollment — VTID-03089
 *
 * Auto-adds new users to system chat groups in their tenant. Currently the
 * only system group is "🎆 FIRST 100", capped at 100 members. Idempotent:
 * silently skips if the user is already a member or the cap is reached.
 * Fire-and-forget — never blocks login.
 */

import { SupabaseClient } from '@supabase/supabase-js';

const FIRST_100_CAP = 100;

export async function addUserToSystemGroups(
  userId: string,
  tenantId: string,
  supabase: SupabaseClient,
): Promise<{ added: string[]; skipped: Array<{ group_id: string; reason: string }> }> {
  const added: string[] = [];
  const skipped: Array<{ group_id: string; reason: string }> = [];
  const tag = '[GroupEnrollment]';

  try {
    const { data: groups, error: groupsErr } = await supabase
      .from('chat_groups')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .eq('is_system', true);

    if (groupsErr) {
      console.warn(`${tag} List system groups failed: ${groupsErr.message}`);
      return { added, skipped };
    }
    if (!groups || groups.length === 0) {
      return { added, skipped };
    }

    for (const group of groups as Array<{ id: string; name: string }>) {
      const { data: existing } = await supabase
        .from('chat_group_members')
        .select('user_id')
        .eq('group_id', group.id)
        .eq('user_id', userId)
        .maybeSingle();

      if (existing) {
        skipped.push({ group_id: group.id, reason: 'already_member' });
        continue;
      }

      const { count, error: countErr } = await supabase
        .from('chat_group_members')
        .select('user_id', { count: 'exact', head: true })
        .eq('group_id', group.id);

      if (countErr) {
        console.warn(`${tag} Count members for ${group.id} failed: ${countErr.message}`);
        skipped.push({ group_id: group.id, reason: 'count_failed' });
        continue;
      }

      if ((count || 0) >= FIRST_100_CAP) {
        skipped.push({ group_id: group.id, reason: 'cap_reached' });
        continue;
      }

      const { error: insertErr } = await supabase
        .from('chat_group_members')
        .insert({
          group_id: group.id,
          user_id: userId,
          tenant_id: tenantId,
          role: 'member',
        });

      if (insertErr) {
        console.warn(`${tag} Insert membership for ${group.name} failed: ${insertErr.message}`);
        skipped.push({ group_id: group.id, reason: insertErr.message });
        continue;
      }

      added.push(group.id);
      console.log(`${tag} Added ${userId.slice(0, 8)} to ${group.name} (${group.id})`);
    }

    return { added, skipped };
  } catch (err: any) {
    console.error(`${tag} Unexpected error: ${err.message}`);
    return { added, skipped };
  }
}
