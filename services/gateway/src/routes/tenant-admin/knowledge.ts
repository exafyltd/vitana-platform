/**
 * Batch 1.B2: Tenant Knowledge Base API
 *
 * Mounted at /api/v1/admin/tenants/:tenantId/kb
 *
 * Endpoints:
 *   GET    /documents          — List KB docs (tenant + non-opted-out baseline)
 *   POST   /documents          — Upload a new KB doc for this tenant
 *   GET    /documents/:id      — Single doc detail
 *   PUT    /documents/:id      — Update doc metadata/body
 *   DELETE /documents/:id      — Delete a tenant doc (can't delete baseline)
 *   POST   /documents/:id/reindex — Trigger re-indexing via cognee
 *   POST   /baseline/:documentId/optout — Opt out of a baseline doc
 *   DELETE /baseline/:documentId/optout — Opt back in to a baseline doc
 *   GET    /search              — Search tenant's KB (tenant docs ranked higher)
 *   GET    /topics              — List distinct topics for this tenant's docs
 */

import { Router, Response } from 'express';
import { requireTenantAdmin } from '../../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';

const router = Router({ mergeParams: true });
const VTID = 'TENANT-KB';

// GET /documents — list tenant docs + baseline (minus opt-outs)
router.get('/documents', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const source = (req.query.source as string || '').trim();
    const status = (req.query.status as string || '').trim();
    const q = (req.query.q as string || '').trim();

    // Get opt-out IDs for this tenant
    const { data: optouts } = await supabase
      .from('tenant_kb_baseline_optouts')
      .select('document_id')
      .eq('tenant_id', tenantId);
    const optoutIds = new Set((optouts || []).map((o: any) => o.document_id));

    // Fetch tenant docs + baseline docs
    let query = supabase
      .from('kb_documents')
      .select('*')
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
      .order('created_at', { ascending: false });

    if (source === 'tenant') {
      query = supabase.from('kb_documents').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false });
    } else if (source === 'baseline') {
      query = supabase.from('kb_documents').select('*').is('tenant_id', null).order('created_at', { ascending: false });
    }

    if (status) query = query.eq('status', status);
    if (q) query = query.ilike('title', `%${q}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ ok: false, error: error.message });

    // Mark baseline docs as opted-out if they're in the optout set
    const docs = (data || []).map((d: any) => ({
      ...d,
      is_baseline: d.tenant_id === null,
      is_opted_out: d.tenant_id === null && optoutIds.has(d.id),
    }));

    return res.json({ ok: true, documents: docs });
  } catch (err: any) {
    console.error(`[${VTID}] List error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// POST /documents — upload new tenant doc
router.post('/documents', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const { title, body, source, topics, visibility } = req.body;

    if (!title) return res.status(400).json({ ok: false, error: 'TITLE_REQUIRED' });

    const { data, error } = await supabase
      .from('kb_documents')
      .insert({
        tenant_id: tenantId,
        title,
        body: body || null,
        source: source || 'upload',
        topics: topics || [],
        visibility: visibility || {},
        status: 'pending',
        created_by: req.identity!.user_id,
      })
      .select('*')
      .single();

    if (error) return res.status(500).json({ ok: false, error: error.message });

    // TODO: trigger cognee indexing via cognee-extractor-client
    console.log(`[${VTID}] Document created: ${data.id} in tenant ${tenantId}`);
    return res.status(201).json({ ok: true, document: data });
  } catch (err: any) {
    console.error(`[${VTID}] Create error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /documents/:id — single doc
router.get('/documents/:id', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const { id } = req.params;

    const { data, error } = await supabase
      .from('kb_documents')
      .select('*')
      .eq('id', id)
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
      .single();

    if (error || !data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, document: data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// PUT /documents/:id — update tenant doc (can't update baseline)
router.put('/documents/:id', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const { id } = req.params;
    const { title, body, topics, visibility, status } = req.body;

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = title;
    if (body !== undefined) updates.body = body;
    if (topics !== undefined) updates.topics = topics;
    if (visibility !== undefined) updates.visibility = visibility;
    if (status !== undefined) updates.status = status;

    const { data, error } = await supabase
      .from('kb_documents')
      .update(updates)
      .eq('id', id)
      .eq('tenant_id', tenantId) // can only update own tenant's docs
      .select('*')
      .single();

    if (error || !data) return res.status(404).json({ ok: false, error: 'NOT_FOUND_OR_BASELINE' });
    return res.json({ ok: true, document: data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// DELETE /documents/:id — delete tenant doc
router.delete('/documents/:id', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const { id } = req.params;

    const { error } = await supabase
      .from('kb_documents')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId); // can only delete own tenant's docs

    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// POST /documents/:id/reindex — trigger re-indexing
router.post('/documents/:id/reindex', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const { id } = req.params;

    // Mark as pending re-index
    await supabase
      .from('kb_documents')
      .update({ status: 'pending', indexed_at: null })
      .eq('id', id)
      .eq('tenant_id', tenantId);

    // TODO: call cognee-extractor-client to trigger actual indexing
    console.log(`[${VTID}] Reindex requested for doc ${id} in tenant ${tenantId}`);
    return res.json({ ok: true, message: 'Re-indexing queued' });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// POST /baseline/:documentId/optout — opt out of a baseline doc
router.post('/baseline/:documentId/optout', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const { documentId } = req.params;

    const { error } = await supabase
      .from('tenant_kb_baseline_optouts')
      .upsert(
        { tenant_id: tenantId, document_id: documentId, opted_out_by: req.identity!.user_id },
        { onConflict: 'tenant_id,document_id' }
      );

    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, message: 'Opted out of baseline document' });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// DELETE /baseline/:documentId/optout — opt back in
router.delete('/baseline/:documentId/optout', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const { documentId } = req.params;

    await supabase
      .from('tenant_kb_baseline_optouts')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('document_id', documentId);

    return res.json({ ok: true, message: 'Opted back in to baseline document' });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /search — search tenant KB (tenant docs ranked higher)
router.get('/search', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const q = (req.query.q as string || '').trim();

    if (!q) return res.status(400).json({ ok: false, error: 'QUERY_REQUIRED' });

    // Simple text search — tenant docs first, then baseline
    const { data: tenantDocs } = await supabase
      .from('kb_documents')
      .select('id, title, topics, status')
      .eq('tenant_id', tenantId)
      .eq('status', 'indexed')
      .ilike('title', `%${q}%`)
      .limit(10);

    const { data: baselineDocs } = await supabase
      .from('kb_documents')
      .select('id, title, topics, status')
      .is('tenant_id', null)
      .eq('status', 'indexed')
      .ilike('title', `%${q}%`)
      .limit(10);

    // Filter out opted-out baseline docs
    const { data: optouts } = await supabase
      .from('tenant_kb_baseline_optouts')
      .select('document_id')
      .eq('tenant_id', tenantId);
    const optoutIds = new Set((optouts || []).map((o: any) => o.document_id));

    const filteredBaseline = (baselineDocs || []).filter((d: any) => !optoutIds.has(d.id));

    return res.json({
      ok: true,
      results: [
        ...(tenantDocs || []).map((d: any) => ({ ...d, source: 'tenant', rank: 'high' })),
        ...filteredBaseline.map((d: any) => ({ ...d, source: 'baseline', rank: 'low' })),
      ],
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /unified-tree
 * Returns a merged, auto-grouped tree of all three KB scopes:
 *   - system   (knowledge_docs, namespace=vitana_system — Book of the Vitana Index + others)
 *   - baseline (kb_documents WHERE tenant_id IS NULL, with per-tenant opt-out flag)
 *   - tenant   (kb_documents WHERE tenant_id = :tenantId)
 *
 * Response shape:
 *   {
 *     ok: true,
 *     tree: {
 *       system:   [{ group: string, docs: Doc[] }, ...],
 *       baseline: [{ group: string, docs: Doc[] }, ...],
 *       tenant:   [{ group: string, docs: Doc[] }, ...]
 *     }
 *   }
 *   Doc = { id, title, path, source, status, topics[], updated_at, is_opted_out? }
 *
 * Read-only for tenant admins; exafy admins get the same shape. Editing still
 * flows through the existing per-scope endpoints:
 *   - tenant  → PUT /documents/:id
 *   - baseline→ (exafy admin only; not yet surfaced in this router)
 *   - system  → /api/v1/admin/system-kb (exafy admin only)
 */
router.get('/unified-tree', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;

    const [optoutsRes, kbDocsRes, systemDocsRes] = await Promise.allSettled([
      supabase
        .from('tenant_kb_baseline_optouts')
        .select('document_id')
        .eq('tenant_id', tenantId),
      supabase
        .from('kb_documents')
        .select('id, title, tenant_id, topics, status, created_at, updated_at')
        .or(`tenant_id.eq.${tenantId},tenant_id.is.null`),
      supabase
        .from('knowledge_docs')
        .select('id, title, path, tags, source_type, word_count, created_at, updated_at')
        .order('path', { ascending: true })
        .limit(500),
    ]);

    const optoutIds = new Set<string>();
    if (optoutsRes.status === 'fulfilled' && optoutsRes.value.data) {
      optoutsRes.value.data.forEach((o: any) => optoutIds.add(o.document_id));
    }

    const kbDocs: any[] =
      kbDocsRes.status === 'fulfilled' && kbDocsRes.value.data ? kbDocsRes.value.data : [];
    const systemDocs: any[] =
      systemDocsRes.status === 'fulfilled' && systemDocsRes.value.data
        ? systemDocsRes.value.data
        : [];

    // --- System scope ---
    const systemFriendly: Record<string, string> = {
      'index-book': 'Book of the Vitana Index',
      vaea: 'VAEA',
      agents: 'Agents',
      assistant: 'Assistant',
      autopilot: 'Autopilot',
    };
    const systemGroups: Record<string, any[]> = {};
    for (const d of systemDocs) {
      const parts = String(d.path || '').split('/').filter(Boolean);
      // Expected: kb/vitana-system/<area>/<file>
      const area = parts[2] || 'other';
      const groupName = systemFriendly[area] ?? area.charAt(0).toUpperCase() + area.slice(1);
      if (!systemGroups[groupName]) systemGroups[groupName] = [];
      systemGroups[groupName].push({
        id: d.id,
        title: d.title,
        path: d.path,
        source: 'system' as const,
        status: 'indexed' as const,
        topics: d.tags || [],
        updated_at: d.updated_at,
      });
    }
    const systemTree = Object.entries(systemGroups)
      .map(([group, docs]) => ({
        group,
        docs: docs.sort((a, b) => String(a.path).localeCompare(String(b.path))),
      }))
      .sort((a, b) => a.group.localeCompare(b.group));

    // --- Baseline + Tenant scopes (both from kb_documents) ---
    const baselineBuckets: Record<string, any[]> = {};
    const tenantBuckets: Record<string, any[]> = {};
    for (const d of kbDocs) {
      const isBaseline = d.tenant_id === null;
      const topic = (d.topics && d.topics[0]) || 'Uncategorized';
      const group = topic.charAt(0).toUpperCase() + topic.slice(1);
      const entry = {
        id: d.id,
        title: d.title,
        path: null,
        source: isBaseline ? 'baseline' : 'tenant',
        status: d.status,
        topics: d.topics || [],
        updated_at: d.updated_at,
        created_at: d.created_at,
        ...(isBaseline ? { is_opted_out: optoutIds.has(d.id) } : {}),
      };
      const target = isBaseline ? baselineBuckets : tenantBuckets;
      if (!target[group]) target[group] = [];
      target[group].push(entry);
    }
    const toTree = (buckets: Record<string, any[]>) =>
      Object.entries(buckets)
        .map(([group, docs]) => ({
          group,
          docs: docs.sort((a, b) =>
            String(b.updated_at || b.created_at || '').localeCompare(
              String(a.updated_at || a.created_at || '')
            )
          ),
        }))
        .sort((a, b) => a.group.localeCompare(b.group));

    return res.json({
      ok: true,
      tree: {
        system: systemTree,
        baseline: toTree(baselineBuckets),
        tenant: toTree(tenantBuckets),
      },
    });
  } catch (err: any) {
    console.error(`[${VTID}] unified-tree error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /system-docs/:id
 * Read-only viewer for knowledge_docs content. Tenant admins can READ system
 * docs so the unified-tree viewer works; editing stays on /api/v1/admin/system-kb.
 */
router.get('/system-docs/:id', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const { id } = req.params;
    const { data, error } = await supabase
      .from('knowledge_docs')
      .select('id, title, path, content, tags, source_type, word_count, created_at, updated_at')
      .eq('id', id)
      .maybeSingle();

    if (error) return res.status(500).json({ ok: false, error: error.message });
    if (!data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    return res.json({ ok: true, document: data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /topics — distinct topics for this tenant
router.get('/topics', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;

    const { data } = await supabase
      .from('kb_documents')
      .select('topics')
      .eq('tenant_id', tenantId);

    const topicSet = new Set<string>();
    (data || []).forEach((d: any) => {
      (d.topics || []).forEach((t: string) => topicSet.add(t));
    });

    return res.json({ ok: true, topics: Array.from(topicSet).sort() });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
