/**
 * VTID-01973: Intent categories (P2-A).
 *
 * GET /api/v1/intent-categories?kind=<intent_kind>
 *
 * Returns the per-kind taxonomy (tree, hierarchical via parent_key).
 * Cached at edge for 24h via Cache-Control + ETag.
 */

import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';

const router = Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
}

router.get('/', requireAuth, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const kind = req.query.kind as string | undefined;
  const supabase = getSupabase();

  let q = supabase
    .from('intent_categories')
    .select('kind_key, category_key, parent_key, label, sort_order, active')
    .eq('active', true)
    .order('kind_key', { ascending: true })
    .order('sort_order', { ascending: true });

  if (kind) q = q.eq('kind_key', kind);

  const { data, error } = await q;
  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.set('Cache-Control', 'public, max-age=86400');
  return res.json({ ok: true, categories: data ?? [] });
});

export default router;
