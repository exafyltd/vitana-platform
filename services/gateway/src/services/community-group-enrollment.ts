/**
 * Community Group Enrollment — VTID-03089 / Alle Beisammen
 *
 * Auto-adds users to system chat groups in their tenant. The per-group member
 * cap is metadata-driven (chat_groups.metadata.cap): a number caps the group
 * ("🎆 FIRST 100" = 100), while NULL/absent means uncapped ("Alle Beisammen 🤗"
 * — everyone belongs). Idempotent: silently skips if the user is already a
 * member or the cap is reached. Fire-and-forget — never blocks login.
 *
 * This is the login-time defense-in-depth path; the primary enrollment happens
 * in the fire_welcome_chat_on_membership() DB trigger on registration.
 */

import { SupabaseClient } from '@supabase/supabase-js';

/**
 * Reads a numeric member cap from a group's metadata. Returns null (uncapped)
 * when metadata.cap is absent, null, or not a finite number.
 */
function groupMemberCap(metadata: unknown): number | null {
  if (metadata && typeof metadata === 'object') {
    const raw = (metadata as Record<string, unknown>).cap;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

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
      .select('id, name, metadata')
      .eq('tenant_id', tenantId)
      .eq('is_system', true);

    if (groupsErr) {
      console.warn(`${tag} List system groups failed: ${groupsErr.message}`);
      return { added, skipped };
    }
    if (!groups || groups.length === 0) {
      return { added, skipped };
    }

    for (const group of groups as Array<{ id: string; name: string; metadata: unknown }>) {
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

      const cap = groupMemberCap(group.metadata);

      // Only count members when a cap applies — uncapped groups skip the query.
      if (cap !== null) {
        const { count, error: countErr } = await supabase
          .from('chat_group_members')
          .select('user_id', { count: 'exact', head: true })
          .eq('group_id', group.id);

        if (countErr) {
          console.warn(`${tag} Count members for ${group.id} failed: ${countErr.message}`);
          skipped.push({ group_id: group.id, reason: 'count_failed' });
          continue;
        }

        if ((count || 0) >= cap) {
          skipped.push({ group_id: group.id, reason: 'cap_reached' });
          continue;
        }
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
