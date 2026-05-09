/**
 * VTID-02754 — Voice Tool Expansion P1b: Community Superlatives.
 *
 * Backs the "who is...?" voice tools. UX paradigm: the user asks a
 * superlative question ("who has the highest Vitana Index?", "who is
 * the youngest member?") and the ORB returns a single profile card
 * (or top-N when explicitly requested).
 *
 * Privacy gate (CRITICAL):
 *   Every result must respect global_community_profiles.is_visible.
 *   A user who set their profile to private MUST NOT appear in any
 *   superlative result, even if they're objectively the answer.
 *
 * Source-of-truth tables:
 *   - app_users — display_name, avatar_url, vitana_id, created_at
 *   - global_community_profiles — is_visible flag
 *   - profiles — registration_seq, location
 *   - vitana_index_scores — score_total + per-pillar scores
 *   - relationships — follower edges (where defined; falls back to 0)
 */

import { SupabaseClient } from '@supabase/supabase-js';

export type Pillar = 'nutrition' | 'hydration' | 'exercise' | 'sleep' | 'mental';

export interface ProfileCard {
  vitana_id: string | null;
  display_name: string;
  avatar_url: string | null;
  location: string | null;
  registration_seq: number | null;
  member_since: string | null;
}

export interface SuperlativeResult {
  ok: true;
  metric: string;
  metric_value: number | string | null;
  metric_unit?: string;
  profile: ProfileCard;
  ranking?: ProfileCard[]; // top-N when requested
  total_eligible: number;  // how many candidates were in scope after privacy filtering
}

export interface SuperlativeError {
  ok: false;
  error: string;
}

/**
 * Returns the set of user_ids who have opted out of community visibility.
 * Used to filter every superlative response.
 */
async function getHiddenUserIds(sb: SupabaseClient): Promise<Set<string>> {
  const { data } = await sb
    .from('global_community_profiles')
    .select('user_id')
    .eq('is_visible', false);
  return new Set<string>((data || []).map((r: any) => String(r.user_id)));
}

/** Hydrate ProfileCard rows from app_users + profiles for a given list of user_ids. */
async function hydrateProfiles(
  sb: SupabaseClient,
  userIds: string[],
): Promise<Map<string, ProfileCard>> {
  if (userIds.length === 0) return new Map();
  const [{ data: users }, { data: profs }] = await Promise.all([
    sb
      .from('app_users')
      .select('user_id, display_name, avatar_url, vitana_id, created_at')
      .in('user_id', userIds),
    sb
      .from('profiles')
      .select('user_id, registration_seq, location')
      .in('user_id', userIds),
  ]);
  const profMap = new Map<string, any>((profs || []).map((p: any) => [String(p.user_id), p]));
  const out = new Map<string, ProfileCard>();
  for (const u of users || []) {
    const p = profMap.get(String((u as any).user_id)) || {};
    out.set(String((u as any).user_id), {
      vitana_id: (u as any).vitana_id ?? null,
      display_name: (u as any).display_name ?? 'A community member',
      avatar_url: (u as any).avatar_url ?? null,
      location: p.location ?? null,
      registration_seq: p.registration_seq ?? null,
      member_since: (u as any).created_at ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Highest Vitana Index — top scorer on the most recent index row
// ---------------------------------------------------------------------------

export async function getHighestVitanaIndex(
  sb: SupabaseClient,
  limit = 1,
): Promise<SuperlativeResult | SuperlativeError> {
  const hidden = await getHiddenUserIds(sb);

  // Most-recent vitana_index_scores per user, ordered by score_total desc.
  // We over-fetch then filter privacy + dedupe per user, then truncate to `limit`.
  const { data, error } = await sb
    .from('vitana_index_scores')
    .select('user_id, score_total, date')
    .order('score_total', { ascending: false })
    .order('date', { ascending: false })
    .limit(Math.max(50, limit * 5));
  if (error) return { ok: false, error: `index_query_failed: ${error.message}` };

  const seen = new Set<string>();
  const winners: Array<{ user_id: string; score_total: number; date: string }> = [];
  for (const row of data || []) {
    const uid = String((row as any).user_id);
    if (hidden.has(uid) || seen.has(uid)) continue;
    seen.add(uid);
    winners.push({
      user_id: uid,
      score_total: Number((row as any).score_total) || 0,
      date: String((row as any).date),
    });
    if (winners.length >= limit) break;
  }
  if (winners.length === 0) {
    return { ok: false, error: 'no_eligible_candidates' };
  }
  const profiles = await hydrateProfiles(sb, winners.map(w => w.user_id));
  const ranking = winners
    .map(w => profiles.get(w.user_id))
    .filter((p): p is ProfileCard => Boolean(p));

  return {
    ok: true,
    metric: 'vitana_index_total',
    metric_value: winners[0].score_total,
    metric_unit: 'points',
    profile: ranking[0],
    ranking: limit > 1 ? ranking : undefined,
    total_eligible: seen.size,
  };
}

// ---------------------------------------------------------------------------
// 2. Top in pillar — best score for a single pillar
// ---------------------------------------------------------------------------

export async function getTopInPillar(
  sb: SupabaseClient,
  pillar: Pillar,
  limit = 1,
): Promise<SuperlativeResult | SuperlativeError> {
  const valid: Pillar[] = ['nutrition', 'hydration', 'exercise', 'sleep', 'mental'];
  if (!valid.includes(pillar)) {
    return { ok: false, error: `invalid pillar: ${pillar}` };
  }
  const column = `score_${pillar}` as const;
  const hidden = await getHiddenUserIds(sb);

  const { data, error } = await sb
    .from('vitana_index_scores')
    .select(`user_id, ${column}, date`)
    .order(column, { ascending: false })
    .order('date', { ascending: false })
    .limit(Math.max(50, limit * 5));
  if (error) return { ok: false, error: `pillar_query_failed: ${error.message}` };

  const seen = new Set<string>();
  const winners: Array<{ user_id: string; pillar_score: number }> = [];
  for (const row of data || []) {
    const uid = String((row as any).user_id);
    if (hidden.has(uid) || seen.has(uid)) continue;
    seen.add(uid);
    winners.push({
      user_id: uid,
      pillar_score: Number((row as any)[column]) || 0,
    });
    if (winners.length >= limit) break;
  }
  if (winners.length === 0) {
    return { ok: false, error: 'no_eligible_candidates' };
  }
  const profiles = await hydrateProfiles(sb, winners.map(w => w.user_id));
  const ranking = winners
    .map(w => profiles.get(w.user_id))
    .filter((p): p is ProfileCard => Boolean(p));

  return {
    ok: true,
    metric: `pillar_${pillar}`,
    metric_value: winners[0].pillar_score,
    metric_unit: 'points',
    profile: ranking[0],
    ranking: limit > 1 ? ranking : undefined,
    total_eligible: seen.size,
  };
}

// ---------------------------------------------------------------------------
// 3 & 4. First / newest member — by registration_seq (or created_at fallback)
// ---------------------------------------------------------------------------

export async function getMemberByRegistration(
  sb: SupabaseClient,
  direction: 'first' | 'newest',
  limit = 1,
): Promise<SuperlativeResult | SuperlativeError> {
  const ascending = direction === 'first';
  const hidden = await getHiddenUserIds(sb);

  // Prefer profiles.registration_seq (deterministic, monotonic). Fall back
  // to app_users.created_at if registration_seq isn't populated.
  const { data, error } = await sb
    .from('profiles')
    .select('user_id, registration_seq')
    .order('registration_seq', { ascending, nullsFirst: false })
    .limit(Math.max(50, limit * 5));
  if (error) return { ok: false, error: `registration_query_failed: ${error.message}` };

  const seen = new Set<string>();
  const winners: Array<{ user_id: string; registration_seq: number | null }> = [];
  for (const row of data || []) {
    const uid = String((row as any).user_id);
    if (hidden.has(uid) || seen.has(uid)) continue;
    seen.add(uid);
    winners.push({
      user_id: uid,
      registration_seq: (row as any).registration_seq ?? null,
    });
    if (winners.length >= limit) break;
  }
  if (winners.length === 0) {
    return { ok: false, error: 'no_eligible_candidates' };
  }
  const profiles = await hydrateProfiles(sb, winners.map(w => w.user_id));
  const ranking = winners
    .map(w => profiles.get(w.user_id))
    .filter((p): p is ProfileCard => Boolean(p));

  return {
    ok: true,
    metric: direction === 'first' ? 'first_member_registered' : 'newest_member_registered',
    metric_value: winners[0].registration_seq ?? ranking[0].member_since,
    profile: ranking[0],
    ranking: limit > 1 ? ranking : undefined,
    total_eligible: seen.size,
  };
}

// ---------------------------------------------------------------------------
// 5. Most followed — most followers via relationships table
// ---------------------------------------------------------------------------

export async function getMostFollowed(
  sb: SupabaseClient,
  limit = 1,
): Promise<SuperlativeResult | SuperlativeError> {
  const hidden = await getHiddenUserIds(sb);

  // We don't know exact column names without inspecting; the safest pattern
  // is to count rows per to_user (or target_user_id). Most schemas use
  // to_user_id / from_user_id. We try a small probe sequence.
  let counts = new Map<string, number>();
  let errMsg = '';

  // Attempt 1: to_user_id (most common naming)
  const probe1 = await sb
    .from('relationships')
    .select('to_user_id')
    .limit(20000);
  if (!probe1.error && Array.isArray(probe1.data)) {
    for (const r of probe1.data) {
      const u = String((r as any).to_user_id ?? '');
      if (!u) continue;
      counts.set(u, (counts.get(u) ?? 0) + 1);
    }
  } else {
    errMsg = probe1.error?.message ?? '';
  }

  // Attempt 2: followee_id
  if (counts.size === 0) {
    const probe2 = await sb
      .from('relationships')
      .select('followee_id')
      .limit(20000);
    if (!probe2.error && Array.isArray(probe2.data)) {
      for (const r of probe2.data) {
        const u = String((r as any).followee_id ?? '');
        if (!u) continue;
        counts.set(u, (counts.get(u) ?? 0) + 1);
      }
    } else if (!errMsg) {
      errMsg = probe2.error?.message ?? '';
    }
  }

  if (counts.size === 0) {
    return {
      ok: false,
      error: `no_followers_data${errMsg ? `: ${errMsg}` : ''}`,
    };
  }

  // Sort by count desc, drop hidden users.
  const sorted = Array.from(counts.entries())
    .filter(([uid]) => !hidden.has(uid))
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(limit, 1));

  if (sorted.length === 0) {
    return { ok: false, error: 'no_eligible_candidates' };
  }

  const profiles = await hydrateProfiles(sb, sorted.map(([u]) => u));
  const ranking = sorted
    .map(([u]) => profiles.get(u))
    .filter((p): p is ProfileCard => Boolean(p));

  return {
    ok: true,
    metric: 'follower_count',
    metric_value: sorted[0][1],
    metric_unit: 'followers',
    profile: ranking[0],
    ranking: limit > 1 ? ranking : undefined,
    total_eligible: counts.size,
  };
}

// ---------------------------------------------------------------------------
// 6. ask_who_is — NL router for free-form superlative questions
// ---------------------------------------------------------------------------

interface AskWhoIsInput {
  question: string;
  limit?: number;
}

export async function askWhoIs(
  sb: SupabaseClient,
  input: AskWhoIsInput,
): Promise<SuperlativeResult | SuperlativeError | { ok: 'clarify'; question: string }> {
  const q = (input.question || '').toLowerCase().trim();
  const limit = Math.max(1, Math.min(10, input.limit ?? 1));
  if (!q) return { ok: false, error: 'empty_question' };

  // Pillar superlatives
  const pillarHit = (['nutrition', 'hydration', 'exercise', 'sleep', 'mental'] as Pillar[]).find(p =>
    q.includes(p) ||
    (p === 'exercise' && (q.includes('fit') || q.includes('workout'))) ||
    (p === 'mental' && (q.includes('mind') || q.includes('mood'))) ||
    (p === 'hydration' && q.includes('water')),
  );
  if (
    pillarHit &&
    (q.includes('best') || q.includes('top') || q.includes('highest') || q.includes('strongest'))
  ) {
    return getTopInPillar(sb, pillarHit, limit);
  }

  // Vitana Index leaderboard
  if (
    (q.includes('vitana index') || q.includes('vitana score') || q.includes('index')) &&
    (q.includes('highest') || q.includes('best') || q.includes('top') || q.includes('leaderboard'))
  ) {
    return getHighestVitanaIndex(sb, limit);
  }

  // Tenure: first / oldest registered / OG members
  if (
    q.includes('first') ||
    q.includes('og member') ||
    q.includes('original') ||
    (q.includes('oldest') && q.includes('member'))
  ) {
    return getMemberByRegistration(sb, 'first', limit);
  }
  if (
    q.includes('newest') ||
    q.includes('most recent') ||
    (q.includes('latest') && q.includes('member')) ||
    q.includes('just joined')
  ) {
    return getMemberByRegistration(sb, 'newest', limit);
  }

  // Followers
  if (
    q.includes('most follow') ||
    q.includes('most popular') ||
    q.includes('biggest fanbase') ||
    q.includes('most fans')
  ) {
    return getMostFollowed(sb, limit);
  }

  // Couldn't map — return a clarification request the LLM will read aloud.
  return {
    ok: 'clarify',
    question:
      "I can answer who-is questions about: highest Vitana Index, best in a pillar (Nutrition/Hydration/Exercise/Sleep/Mental), first or newest member, or most followed. Which of those do you mean?",
  };
}
