/**
 * VTID-DANCE-D4: Public community members directory.
 *
 * The anti-loneliness primer for the first ~1000 users. Returns a
 * scrollable, paginated list of community members so a new signup can
 * see "you are not alone" the moment they join — and find someone to
 * connect with by voice/text/share.
 *
 * Endpoints:
 *   GET /api/v1/community/members
 *     Query: ?cursor=&limit=&sort=newest|oldest|name&filter[dance]=salsa
 *     Returns paginated members with vitana_id, registration_seq,
 *     display_name, avatar, location, dance preview chip when set.
 *
 * Visibility: respects global_community_profiles.is_visible. The default
 * for new signups is true (per existing seed). Per-field visibility on
 * profiles.account_visibility is honoured by client-side rendering.
 */

import { Router, Request, Response } from 'express';
import { requireAuth, requireTenant, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';

const router = Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

type SortMode = 'newest' | 'oldest' | 'name';

interface MemberRow {
  vitana_id: string | null;
  registration_seq: number | null;
  display_name: string | null;
  avatar_url: string | null;
  location: string | null;
  member_since: string | null;
  dance_preview: { variety: string | null; level: string | null; role: string | null } | null;
}

/**
 * E6 — Members count. Powers the Find a Partner "Members" sub-tab gate
 * (visible only while community total ≤ 1000). Reuses the same
 * is_visible filter as the list endpoint.
 */
router.get('/community/members/count', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(500).json({ ok: false, error: 'supabase_unavailable' });
  }

  const { data: hiddenRows } = await supabase
    .from('global_community_profiles')
    .select('user_id')
    .eq('is_visible', false);
  const hiddenIds = new Set<string>((hiddenRows || []).map((r: any) => String(r.user_id)));

  const { count, error } = await supabase
    .from('profiles')
    .select('user_id', { count: 'exact', head: true })
    .neq('user_id', identity.user_id);

  if (error) {
    console.error('[E6] community/members/count failed', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  // The count above is the total profiles minus self. Subtract hidden ones.
  // For small N this is fine; promote to a SQL-side view if it ever matters.
  const total = Math.max(0, (count ?? 0) - hiddenIds.size);
  return res.json({ ok: true, total });
});

router.get('/community/members', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
  const sort: SortMode = (() => {
    const raw = String(req.query.sort ?? 'newest').toLowerCase();
    return (raw === 'oldest' || raw === 'name') ? raw : 'newest';
  })();
  const cursor = req.query.cursor ? String(req.query.cursor) : null;
  const danceFilter = req.query.dance ? String(req.query.dance).toLowerCase() : null;

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(500).json({ ok: false, error: 'supabase_unavailable' });
  }

  // Pull from profiles (the source of truth for vitana_id + registration_seq
  // + dance_preferences). We exclude the requesting user from their own list.
  // Visibility gate: separately fetch hidden user_ids and filter them out
  // (PostgREST doesn't expose a FK between profiles and
  // global_community_profiles to inner-join here). Default for new signups
  // is is_visible=true so the hidden list is normally tiny / empty.
  const { data: hiddenRows } = await supabase
    .from('global_community_profiles')
    .select('user_id')
    .eq('is_visible', false);
  const hiddenIds = new Set<string>((hiddenRows || []).map((r: any) => String(r.user_id)));

  let q = supabase
    .from('profiles')
    .select(
      'user_id, vitana_id, registration_seq, display_name, full_name, avatar_url, location, dance_preferences, created_at'
    )
    .neq('user_id', identity.user_id);

  if (sort === 'newest') {
    q = q.order('registration_seq', { ascending: false, nullsFirst: false });
    if (cursor) q = q.lt('registration_seq', parseInt(cursor, 10));
  } else if (sort === 'oldest') {
    q = q.order('registration_seq', { ascending: true, nullsFirst: true });
    if (cursor) q = q.gt('registration_seq', parseInt(cursor, 10));
  } else {
    q = q.order('display_name', { ascending: true });
    if (cursor) q = q.gt('display_name', cursor);
  }

  q = q.limit(limit);

  const { data, error } = await q;
  if (error) {
    console.error('[VTID-DANCE-D4] community/members query failed', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  const rows = (data || []) as any[];

  // Drop hidden users (those with global_community_profiles.is_visible=false).
  let filtered = rows.filter((r) => !hiddenIds.has(String(r.user_id)));

  // Apply dance filter in TS (small N today; promote to SQL when matters).
  if (danceFilter) {
    filtered = rows.filter((r) => {
      const prefs = r.dance_preferences || {};
      const varieties: string[] = Array.isArray(prefs.varieties)
        ? prefs.varieties.map((v: any) => String(v).toLowerCase())
        : [];
      return varieties.includes(danceFilter);
    });
  }

  const members: MemberRow[] = filtered.map((r) => {
    const prefs = r.dance_preferences || {};
    const variety = Array.isArray(prefs.varieties) && prefs.varieties.length > 0 ? String(prefs.varieties[0]) : null;
    const level = (variety && prefs.levels && typeof prefs.levels === 'object') ? (prefs.levels[variety] ?? null) : null;
    const role = Array.isArray(prefs.roles) && prefs.roles.length > 0 ? String(prefs.roles[0]) : null;
    return {
      vitana_id: r.vitana_id,
      registration_seq: typeof r.registration_seq === 'number' ? r.registration_seq : null,
      display_name: r.display_name || r.full_name,
      avatar_url: r.avatar_url,
      location: r.location,
      member_since: r.created_at,
      dance_preview: variety || role ? { variety, level, role } : null,
    };
  });

  const last = members[members.length - 1];
  const next_cursor: string | null = (() => {
    if (!last || members.length < limit) return null;
    if (sort === 'name') return last.display_name;
    return last.registration_seq != null ? String(last.registration_seq) : null;
  })();

  return res.json({
    ok: true,
    members,
    next_cursor,
    limit,
    sort,
  });
});

export default router;
