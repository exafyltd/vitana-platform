/**
 * VTID-DANCE-D7: Open Asks public feed.
 *
 * Lists every public intent post with match_count=0 — the "cold start"
 * social-proof feed. Anyone in the community can browse, anyone can
 * respond by sharing the post or expressing interest directly.
 *
 *   GET /api/v1/community/open-asks?cursor=&limit=&kind=&category_prefix=
 *
 * Cursor is the last post's `created_at` ISO string for stable pagination.
 */

import { Router, Request, Response } from 'express';
import { requireAuth, requireTenant, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';

const router = Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

router.get('/community/open-asks', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
  const cursor = req.query.cursor ? String(req.query.cursor) : null;
  const kindFilter = req.query.kind ? String(req.query.kind) : null;
  const categoryPrefix = req.query.category_prefix ? String(req.query.category_prefix) : null;

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'supabase_unavailable' });

  let q = supabase
    .from('intent_open_asks')
    .select('intent_id, requester_vitana_id, intent_kind, category, title, scope, kind_payload, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (cursor) q = q.lt('created_at', cursor);
  if (kindFilter) q = q.eq('intent_kind', kindFilter);
  if (categoryPrefix) q = q.like('category', `${categoryPrefix}%`);

  const { data, error } = await q;
  if (error) {
    console.error('[VTID-DANCE-D7] open-asks query failed', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  const rows = (data || []) as any[];
  const next_cursor = rows.length === limit ? rows[rows.length - 1]?.created_at ?? null : null;

  return res.json({
    ok: true,
    asks: rows.map((r) => ({
      intent_id: r.intent_id,
      requester_vitana_id: r.requester_vitana_id,
      intent_kind: r.intent_kind,
      category: r.category,
      title: r.title,
      scope_excerpt: String(r.scope || '').slice(0, 280),
      kind_payload: r.kind_payload,
      created_at: r.created_at,
    })),
    next_cursor,
    limit,
  });
});

export default router;
