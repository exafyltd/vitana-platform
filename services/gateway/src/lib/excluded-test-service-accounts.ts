/**
 * VTID-03991 — shared exclusion set for surfaces that list, search, rank,
 * or recommend community member profiles to a REAL end user.
 *
 * VTID-03990 fixed one specific leak (the welcome-chat broadcast) by adding
 * `service_bot_accounts`. The same class of account is also excluded by
 * `notification_test_actors` (`exafyltd/vitana-v1`, VTID-03506) for
 * notification fan-out. Both tables live in the same Supabase project, so a
 * gateway service can read both directly. This module is the ONE place that
 * unions them, so a member-facing surface never has to remember there are
 * two separate allowlists to check.
 *
 * Fails OPEN, deliberately, unlike VTID-03990's own guard: this is a read
 * path (a directory listing, a voice "who is...?" answer), not a fan-out
 * write. If either lookup errors, the surface should still work — a test
 * account slipping through occasionally is a far smaller cost than breaking
 * a real member's directory/search/voice tool. Mirrors
 * `notification_test_actors`'s own fail-open precedent.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchExcludedTestServiceAccountIds(sb: SupabaseClient): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const [serviceBots, testActors] = await Promise.all([
      sb.from('service_bot_accounts').select('user_id'),
      sb.from('notification_test_actors').select('user_id'),
    ]);
    for (const r of (serviceBots.data as any[]) || []) {
      if (r?.user_id) ids.add(String(r.user_id));
    }
    for (const r of (testActors.data as any[]) || []) {
      if (r?.user_id) ids.add(String(r.user_id));
    }
  } catch (err: any) {
    console.warn(`[excluded-test-service-accounts] lookup failed, proceeding with no exclusions: ${err?.message}`);
  }
  return ids;
}

/**
 * VTID-04735 — the same exclusion set, failing CLOSED. For money paths (a
 * commission credit), "could not tell" must never mean "not excluded": a
 * lookup error or a `{ error }` result from either table returns `ok:false`,
 * and the caller stops without paying. Use the fail-open variant above only
 * for read/display surfaces.
 */
export async function fetchExcludedTestServiceAccountIdsStrict(
  sb: SupabaseClient,
): Promise<{ ok: true; ids: Set<string> } | { ok: false; error: string }> {
  try {
    const [serviceBots, testActors] = await Promise.all([
      sb.from('service_bot_accounts').select('user_id'),
      sb.from('notification_test_actors').select('user_id'),
    ]);
    const failed = serviceBots.error ?? testActors.error;
    if (failed) return { ok: false, error: failed.message };
    const ids = new Set<string>();
    for (const r of [...((serviceBots.data as any[]) || []), ...((testActors.data as any[]) || [])]) {
      if (r?.user_id) ids.add(String(r.user_id));
    }
    return { ok: true, ids };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'exclusion lookup failed' };
  }
}
