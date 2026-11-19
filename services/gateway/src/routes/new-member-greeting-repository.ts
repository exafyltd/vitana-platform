/**
 * VTID-05207 — data-access seam for routes/new-member-greeting.ts.
 *
 * The one DB read the suggestion route needs: the newcomer's FIRST NAME, so
 * the composed greeting can address them by first name only. Sources, in
 * order: `profiles.first_name` (canonical), then the first token of
 * `global_community_profiles.display_name`, then `app_users.display_name`.
 * Returns null when nothing usable is found — the composer then greets warmly
 * without a name.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

function firstToken(name: string | null | undefined): string | null {
  const t = (name ?? '').trim().split(/\s+/)[0];
  return t || null;
}

export async function resolveFirstName(sb: SupabaseClient, userId: string): Promise<string | null> {
  const { data: prof } = await sb
    .from('profiles')
    .select('first_name')
    .eq('user_id', userId)
    .maybeSingle();
  const first = firstToken((prof as { first_name?: string | null } | null)?.first_name);
  if (first) return first;

  const { data: gcp } = await sb
    .from('global_community_profiles')
    .select('display_name')
    .eq('user_id', userId)
    .maybeSingle();
  const fromGcp = firstToken((gcp as { display_name?: string | null } | null)?.display_name);
  if (fromGcp) return fromGcp;

  const { data: au } = await sb
    .from('app_users')
    .select('display_name')
    .eq('user_id', userId)
    .maybeSingle();
  return firstToken((au as { display_name?: string | null } | null)?.display_name);
}
