/**
 * VTID-02950 extension (BOOTSTRAP-PUBLIC-BUSINESS-PROFILE): public storefront
 * view of another user's "Business" tab — the products they've recommended,
 * so a profile visitor can browse and buy through the existing "Recommend &
 * Earn" attribution flow (commission credited to the profile owner via
 * ?rec=<recommendation_id> -> /discover/product/:id -> /r/:id?rec_id=...).
 *
 *   GET /api/v1/discover/recommendations/:vitanaId — another user's active
 *   recommendations, WITHOUT their private click/conversion/commission stats.
 *
 * Deliberately a separate router from discover-recommendations.ts, whose
 * router is blanket-`requireAuth`'d for the *owner's own* dashboard routes —
 * this route uses requireAuth per-route (any authenticated viewer, not just
 * the owner), mirroring the existing cross-user pattern in profile-prefs.ts's
 * `GET /profiles/:vitana_id/prefs` (any logged-in user may view another
 * user's public profile data; ownership is never required for a read).
 *
 * Security note: all gateway routes use a service-role Supabase client,
 * which bypasses RLS entirely — this route's response-shaping (never
 * including status/click_count/conversion_count/commission_earned_minor/
 * currency) is the actual privacy boundary for another user's earnings data,
 * not RLS.
 */

import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth-supabase-jwt';

const router = Router();

const MAX_ITEMS = 50;

router.get('/recommendations/:vitanaId', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const rawVid = String(req.params.vitanaId || '').replace(/^@/, '').toLowerCase().trim();
  if (!rawVid) return res.status(400).json({ ok: false, error: 'vitana_id_required' });

  const { data: subject, error: subjectErr } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('vitana_id', rawVid)
    .maybeSingle();
  if (subjectErr) return res.status(500).json({ ok: false, error: subjectErr.message });
  if (!subject) return res.status(404).json({ ok: false, error: 'profile_not_found' });

  // Same visibility gate get_user_profile_by_identifier applies, so a hidden/
  // deactivated profile's recommendations can't leak via this side-channel
  // even if the main profile page itself 404s.
  const { data: gcp, error: gcpErr } = await supabase
    .from('global_community_profiles')
    .select('is_visible')
    .eq('user_id', subject.user_id)
    .maybeSingle();
  if (gcpErr) return res.status(500).json({ ok: false, error: gcpErr.message });
  if (!gcp?.is_visible) return res.status(404).json({ ok: false, error: 'profile_not_found' });

  const { data, error } = await supabase
    .from('product_recommendations')
    .select('id, product_id, created_at, products(title, images)')
    .eq('user_id', subject.user_id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(MAX_ITEMS);
  if (error) return res.status(500).json({ ok: false, error: error.message });

  // Only these 5 fields — never status/click_count/conversion_count/
  // commission_earned_minor/currency, which are private to the owner.
  const items = (data ?? []).map((r: any) => ({
    recommendation_id: r.id,
    product_id: r.product_id,
    product_title: r.products?.title ?? null,
    product_thumbnail_url: r.products?.images?.[0] ?? null,
    created_at: r.created_at,
  }));

  res.json({ ok: true, items });
});

export default router;
