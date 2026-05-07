/**
 * VTID-02754 — Voice Tool Expansion P1b: Find one community member.
 *
 * Endpoints:
 *   POST /api/v1/community/find-member
 *     Body: { query: string, excluded_vitana_ids?: string[] }
 *     Returns the FindMemberResult plus a `search_id` keying a row in
 *     community_search_history so the frontend can fetch the structured
 *     match_recipe to render a "How we searched" card on the redirected
 *     profile page.
 *
 *   GET /api/v1/community/find-member/recipe/:search_id
 *     Returns the cached match_recipe for one of the caller's recent
 *     searches (RLS gates this to the original searcher only).
 *
 * Voice flow: orb-live.ts wraps this with a `find_community_member`
 * voice tool that reads voice_summary aloud BEFORE dispatching the
 * navigate orb_directive.
 */

import { Router, Request, Response } from 'express';
import { requireAuth, requireTenant, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { findCommunityMember, hashQuery, FindMemberResult } from '../services/voice-tools/community-member-ranker';

const router = Router();

router.post('/community/find-member', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(500).json({ ok: false, error: 'supabase_unavailable' });
  }

  const body = req.body || {};
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query || query.length < 2) {
    return res.status(400).json({ ok: false, error: 'query_too_short' });
  }
  const excluded: string[] = Array.isArray(body.excluded_vitana_ids)
    ? body.excluded_vitana_ids.filter((s: any) => typeof s === 'string').slice(0, 25)
    : [];

  // requireTenant middleware guarantees tenant_id is non-null by this point.
  const tenantId = identity.tenant_id as string;
  const viewerUserId = identity.user_id;

  let outcome: Awaited<ReturnType<typeof findCommunityMember>>;
  try {
    outcome = await findCommunityMember(supabase, {
      viewer_user_id: viewerUserId,
      viewer_tenant_id: tenantId,
      query,
      excluded_vitana_ids: excluded,
    });
  } catch (err: any) {
    console.warn('[VTID-02754] find-member ranker error:', err?.message);
    return res.status(500).json({ ok: false, error: 'ranker_failed' });
  }

  // Look up the viewer's vitana_id once for persistence + analytics
  const { data: viewerRow } = await supabase
    .from('app_users')
    .select('vitana_id')
    .eq('user_id', viewerUserId)
    .maybeSingle();
  const viewerVid = (viewerRow as any)?.vitana_id ?? null;

  const queryHash = hashQuery(query, viewerUserId);

  // Persist to community_search_history. Service role bypasses RLS.
  let searchId: string | undefined;
  try {
    const { data: inserted } = await supabase
      .from('community_search_history')
      .insert({
        viewer_user_id: viewerUserId,
        viewer_vitana_id: viewerVid,
        tenant_id: tenantId,
        query,
        query_hash: queryHash,
        tier: outcome.tier,
        lane: outcome.lane,
        winner_user_id: outcome.winnerUserId,
        winner_vitana_id: outcome.result.vitana_id,
        recipe_json: outcome.result.match_recipe,
        excluded_vitana_ids: excluded,
      })
      .select('search_id')
      .maybeSingle();
    searchId = (inserted as any)?.search_id;
  } catch (err: any) {
    // Log but don't block the response — frontend gracefully handles a missing recipe.
    console.warn('[VTID-02754] community_search_history insert failed:', err?.message);
  }

  // Re-issue the redirect with the search_id baked in so the WhyThisMatchCard
  // component can fetch the recipe by id.
  const result: FindMemberResult = {
    ...outcome.result,
    search_id: searchId,
    redirect: searchId
      ? {
          screen: outcome.result.redirect.screen,
          route: appendSearchId(outcome.result.redirect.route, searchId),
        }
      : outcome.result.redirect,
  };

  return res.json(result);
});

router.get('/community/find-member/recipe/:search_id', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(500).json({ ok: false, error: 'supabase_unavailable' });
  }

  const searchId = req.params.search_id;
  if (!/^[0-9a-f-]{16,}$/i.test(searchId)) {
    return res.status(400).json({ ok: false, error: 'invalid_search_id' });
  }

  // Service role read; we filter manually so cross-user reads return 404.
  const { data, error } = await supabase
    .from('community_search_history')
    .select('search_id, viewer_user_id, query, tier, lane, winner_vitana_id, recipe_json, created_at')
    .eq('search_id', searchId)
    .maybeSingle();
  if (error || !data) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }
  if ((data as any).viewer_user_id !== identity.user_id) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }

  return res.json({
    ok: true,
    search_id: (data as any).search_id,
    query: (data as any).query,
    tier: (data as any).tier,
    lane: (data as any).lane,
    winner_vitana_id: (data as any).winner_vitana_id,
    match_recipe: (data as any).recipe_json,
    created_at: (data as any).created_at,
  });
});

function appendSearchId(route: string, searchId: string): string {
  if (route.includes('search_id=')) return route;
  const sep = route.includes('?') ? '&' : '?';
  return `${route}${sep}search_id=${searchId}`;
}

export default router;
