/**
 * VTID-02950: "Recommend & Earn" — user product recommendations.
 *
 *   POST /api/v1/discover/recommendations       — create/find a recommendation, get a share link
 *   GET  /api/v1/discover/my-recommendations    — the caller's recommended products + stats
 *
 * A recommendation is per (user, product) — resharing the same product reuses
 * the same row and share link rather than minting duplicates.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth-supabase-jwt';

const router = Router();
router.use(requireAuth as any);

function getUserId(req: Request): string {
  return String((req as any).identity?.user_id || '');
}
function getTenantId(req: Request): string | null {
  return (req as any).identity?.tenant_id ?? null;
}

function shortCode(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

const CreateRecommendationSchema = z.object({
  product_id: z.string().uuid(),
});

router.post('/recommendations', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const parsed = CreateRecommendationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'INVALID_BODY', message: parsed.error.message });
  }
  const userId = getUserId(req);
  const tenantId = getTenantId(req);
  const { product_id } = parsed.data;

  const { data: product, error: productErr } = await supabase
    .from('products')
    .select('id, merchant_id, title, is_active')
    .eq('id', product_id)
    .eq('is_active', true)
    .maybeSingle();
  if (productErr || !product) return res.status(404).json({ ok: false, error: 'PRODUCT_NOT_FOUND' });

  // Find-or-create — one recommendation per (user, product).
  const { data: existing } = await supabase
    .from('product_recommendations')
    .select('id, sharing_link_id')
    .eq('user_id', userId)
    .eq('product_id', product_id)
    .maybeSingle();

  let recommendationId: string;
  if (existing) {
    recommendationId = existing.id;
  } else {
    const { data: link, error: linkErr } = await supabase
      .from('sharing_links')
      .insert({
        tenant_id: tenantId,
        user_id: userId,
        target_type: 'product',
        target_id: product_id,
        short_code: shortCode(),
        utm_source: 'vitana',
        utm_medium: 'recommend',
        utm_campaign: 'discover_recommend',
      })
      .select('id')
      .single();
    if (linkErr || !link) {
      return res.status(500).json({ ok: false, error: 'SHARING_LINK_FAILED', message: linkErr?.message });
    }

    const { data: created, error: createErr } = await supabase
      .from('product_recommendations')
      .insert({
        tenant_id: tenantId,
        user_id: userId,
        product_id,
        merchant_id: product.merchant_id,
        sharing_link_id: link.id,
      })
      .select('id')
      .single();
    if (createErr || !created) {
      return res.status(500).json({ ok: false, error: 'RECOMMENDATION_CREATE_FAILED', message: createErr?.message });
    }
    recommendationId = created.id;
  }

  const origin = (process.env.COMMUNITY_APP_URL || 'https://community-app-q74ibpv6ia-uc.a.run.app').replace(/\/+$/, '');
  const share_url = `${origin}/discover/product/${product_id}?rec=${recommendationId}`;

  res.json({ ok: true, recommendation_id: recommendationId, share_url, product_title: product.title });
});

router.get('/my-recommendations', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const userId = getUserId(req);

  const { data, error } = await supabase
    .from('product_recommendations')
    .select(
      'id, product_id, status, click_count, conversion_count, commission_earned_minor, commission_currency, created_at, products(title, images)'
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: error.message });

  const items = (data ?? []).map((r: any) => ({
    id: r.id,
    product_id: r.product_id,
    product_title: r.products?.title ?? null,
    product_thumbnail_url: r.products?.images?.[0] ?? null,
    status: r.status,
    click_count: r.click_count,
    conversion_count: r.conversion_count,
    commission_earned_minor: r.commission_earned_minor,
    currency: r.commission_currency,
    created_at: r.created_at,
  }));

  res.json({ ok: true, items });
});

export default router;
