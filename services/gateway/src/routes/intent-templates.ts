/**
 * VTID-DANCE-D7: Auto-templated demands route.
 *
 *   GET /api/v1/intent-templates?intent_kind=&category=
 *
 * Returns the template_title + template_scope + payload_hint for the given
 * (kind, category). The IntentComposer prefills these fields so the user
 * starts editing rather than from blank.
 *
 * Falls back to the kind-level template (category_key IS NULL) when no
 * specific match exists.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import * as repo from './intent-templates-repository';

const router = Router();

router.get('/intent-templates', requireAuth, async (req: Request, res: Response) => {
  const intentKind = String(req.query.intent_kind || '').trim();
  const category = req.query.category ? String(req.query.category).trim() : null;

  if (!intentKind) {
    return res.status(400).json({ ok: false, error: 'INTENT_KIND_REQUIRED' });
  }

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'supabase_unavailable' });

  // Try exact category match first, then kind-level fallback.
  const { data: exactRows } = await repo.fetchIntentScopeTemplatesByCategory(supabase, intentKind, category);
  let rows = (exactRows || []) as any[];

  if (rows.length === 0) {
    const { data: fallback } = await repo.fetchIntentScopeTemplatesNoCategoryFallback(supabase, intentKind);
    rows = (fallback || []) as any[];
  }

  if (rows.length === 0) {
    return res.json({ ok: true, template: null });
  }

  return res.json({
    ok: true,
    template: {
      title: rows[0].template_title,
      scope: rows[0].template_scope,
      payload_hint: rows[0].payload_hint || {},
      category_key: rows[0].category_key,
    },
  });
});

export default router;
