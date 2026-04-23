/**
 * Admin System KB — platform-admin-only view of the system-wide knowledge_docs
 * table (not the tenant-scoped kb_documents table used by the existing
 * /admin/tenants/:tenantId/kb UI).
 *
 * This is where the Book of the Vitana Index and other vitana_system docs
 * live. Admin reads them here; the retrieval-router also reads this table
 * at priority 100 for Assistant grounding.
 *
 * Endpoints:
 *   GET  /api/v1/admin/system-kb/docs
 *        Query params:
 *          path_prefix  — optional, filter by leading path (e.g., 'kb/vitana-system/index-book/')
 *          tag          — optional, filter by single tag
 *          q            — optional, full-text search
 *        Returns list of {id, title, path, tags, word_count, created_at, updated_at}
 *   GET  /api/v1/admin/system-kb/docs/:id
 *        Returns {id, title, path, content, tags, source_type, created_at, updated_at}
 *
 * Auth: requireAuth + requireExafyAdmin (platform admin only — these are
 * system docs, not per-tenant).
 */

import { Router, Response } from 'express';
import { requireAuth, requireExafyAdmin, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';

const router = Router();

router.use(requireAuth);
router.use(requireExafyAdmin);

// GET /docs — list knowledge_docs rows with optional filters
router.get('/docs', async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  }

  const pathPrefix = (req.query.path_prefix as string | undefined)?.trim();
  const tag = (req.query.tag as string | undefined)?.trim();
  const q = (req.query.q as string | undefined)?.trim();

  try {
    let query = supabase
      .from('knowledge_docs')
      .select('id, title, path, tags, word_count, source_type, created_at, updated_at')
      .order('path', { ascending: true });

    if (pathPrefix) {
      query = query.like('path', `${pathPrefix}%`);
    }
    if (tag) {
      query = query.contains('tags', [tag]);
    }
    if (q) {
      // Full-text on title + content via tsvector if available; fall back to ilike.
      query = query.or(`title.ilike.%${q}%,path.ilike.%${q}%`);
    }

    const { data, error } = await query.limit(500);
    if (error) {
      console.error('[admin-system-kb] list error:', error.message);
      return res.status(400).json({ ok: false, error: error.message });
    }
    return res.status(200).json({ ok: true, documents: data ?? [] });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /docs/:id — full content
router.get('/docs/:id', async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  }
  const id = req.params.id;
  try {
    const { data, error } = await supabase
      .from('knowledge_docs')
      .select('id, title, path, content, tags, source_type, word_count, created_at, updated_at')
      .eq('id', id)
      .maybeSingle();
    if (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
    if (!data) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    }
    return res.status(200).json({ ok: true, document: data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /docs/:id — edit a knowledge_docs row (exafy admin only).
// This is the system-scope edit path: changes apply immediately to the
// Vitana Assistant's retrieval-router priority-100 grounding for every tenant.
router.put('/docs/:id', async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const id = req.params.id;
  const { title, content, tags } = req.body ?? {};
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof title === 'string') updates.title = title;
  if (typeof content === 'string') {
    updates.content = content;
    updates.word_count = content.trim().split(/\s+/).filter(Boolean).length;
  }
  if (Array.isArray(tags)) updates.tags = tags;

  if (Object.keys(updates).length === 1) {
    return res.status(400).json({ ok: false, error: 'NO_FIELDS' });
  }

  try {
    const { data, error } = await supabase
      .from('knowledge_docs')
      .update(updates)
      .eq('id', id)
      .select('id, title, path, content, tags, word_count, source_type, created_at, updated_at')
      .maybeSingle();
    if (error) {
      console.error('[admin-system-kb] update error:', error.message);
      return res.status(400).json({ ok: false, error: error.message });
    }
    if (!data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    console.log(
      `[admin-system-kb] system doc ${id} edited by exafy_admin user ${req.identity?.user_id}`,
    );
    return res.status(200).json({ ok: true, document: data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /baseline-docs/:id — edit a baseline kb_documents row (tenant_id IS NULL).
// Exafy admin only. Changes apply to every tenant that hasn't opted out.
router.put('/baseline-docs/:id', async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const id = req.params.id;
  const { title, body, topics } = req.body ?? {};
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof title === 'string') updates.title = title;
  if (typeof body === 'string') updates.body = body;
  if (Array.isArray(topics)) updates.topics = topics;

  if (Object.keys(updates).length === 1) {
    return res.status(400).json({ ok: false, error: 'NO_FIELDS' });
  }

  try {
    const { data, error } = await supabase
      .from('kb_documents')
      .update(updates)
      .eq('id', id)
      .is('tenant_id', null) // enforce baseline scope
      .select('*')
      .maybeSingle();
    if (error) {
      console.error('[admin-system-kb] baseline update error:', error.message);
      return res.status(400).json({ ok: false, error: error.message });
    }
    if (!data) return res.status(404).json({ ok: false, error: 'NOT_FOUND_OR_NOT_BASELINE' });
    console.log(
      `[admin-system-kb] baseline doc ${id} edited by exafy_admin user ${req.identity?.user_id}`,
    );
    return res.status(200).json({ ok: true, document: data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET / — router health
router.get('/', (_req, res: Response) => {
  res.status(200).json({
    ok: true,
    service: 'admin-system-kb',
    endpoints: [
      'GET /api/v1/admin/system-kb/docs?path_prefix&tag&q',
      'GET /api/v1/admin/system-kb/docs/:id',
      'PUT /api/v1/admin/system-kb/docs/:id',
      'PUT /api/v1/admin/system-kb/baseline-docs/:id',
    ],
  });
});

export default router;
