/**
 * VTID-05477: new-member card listing, served by the gateway.
 *
 *   GET /api/v1/community/new-members?limit=<1..5>
 *
 * The News feed and Community tab used to read `global_community_profiles`
 * straight from the browser, which cannot read the service-side allowlists
 * (`service_bot_accounts`, `notification_test_actors`), so a test or bot
 * account could appear on the card (NEVER 43/45). This route returns the same
 * rows the browser query returned (visible, opted in to be introduced, joined in
 * the last 7 days, newest first) and removes every excluded account and the caller.
 *
 * No tenant filter: `global_community_profiles` has no tenant column and its SELECT
 * policy is not tenant-scoped, so every community member sees the same rows today.
 * `requireTenant` is an auth gate only, as on /community/members.
 *
 * Fails CLOSED: if the exclusion lookup fails the route answers 503 and the
 * client shows no card, rather than risk listing a test account.
 */
import { Router, Request, Response } from 'express';
import { requireAuth, requireTenant, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { fetchExcludedTestServiceAccountIdsStrict } from '../lib/excluded-test-service-accounts';

const router = Router();

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 5;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

router.get('/community/new-members', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const parsed = parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10);
  const limit = Number.isNaN(parsed) ? DEFAULT_LIMIT : Math.min(MAX_LIMIT, Math.max(1, parsed));

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'supabase_unavailable' });

  const excluded = await fetchExcludedTestServiceAccountIdsStrict(supabase);
  if (!excluded.ok) {
    console.error('[VTID-05477] community/new-members exclusion lookup failed:', excluded.error);
    return res.status(503).json({ ok: false, error: 'exclusion_lookup_failed' });
  }

  // Over-fetch by the number of ids we will drop so the card still fills.
  const fetchCount = limit + excluded.ids.size + 1;
  const { data, error } = await supabase
    .from('global_community_profiles')
    .select('user_id, display_name, avatar_url, bio, created_at')
    .eq('is_visible', true)
    .eq('community_intro_opt_in', true)
    .gte('created_at', new Date(Date.now() - WINDOW_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(fetchCount);

  if (error) {
    console.error('[VTID-05477] community/new-members query failed:', error.message);
    return res.status(500).json({ ok: false, error: 'query_failed' });
  }

  const members = ((data || []) as any[])
    .filter((r) => r.user_id && r.user_id !== identity.user_id && !excluded.ids.has(String(r.user_id)))
    .slice(0, limit)
    .map((r) => ({
      user_id: String(r.user_id),
      display_name: r.display_name ?? null,
      avatar_url: r.avatar_url ?? null,
      bio: r.bio ?? null,
      created_at: r.created_at,
    }));

  return res.json({ ok: true, members });
});

export default router;
