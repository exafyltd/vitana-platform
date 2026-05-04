/**
 * VTID-02026 — Phase 6a — admin smoke endpoint for the Memory Broker.
 *
 * Lets exafy_admin call `getMemoryContext()` directly with a concrete
 * (tenant_id, user_id, intent) and inspect the resulting MemoryPack.
 * Used to verify Phase 6a end-to-end before any consumer wiring.
 *
 * Will be removed (or moved behind a stricter gate) in Phase 6c once the
 * broker is wired into context-pack-builder + retrieval-router.
 *
 * GET  /api/v1/admin/memory/context?tenant_id=...&user_id=...&intent=recall_history
 * POST /api/v1/admin/memory/context  (same args in body, plus required_blocks)
 */

import { Router, Response } from 'express';
import {
  requireAuth,
  requireExafyAdmin,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { getMemoryContext, MemoryIntent, MemoryBlockKind } from '../services/memory-broker';
import { buildAgentProfile } from '../services/agent-profile-service';
import { runConsolidator, LoopId } from '../services/nightly-consolidator';
import { getSupabase } from '../lib/supabase';
import { getSystemControl } from '../services/system-controls-service';

const router = Router();
// VTID-02032: Path-scoped auth — was `router.use(requireAuth)` which fired
// for every /api/v1/* request because this router is mounted at /api/v1.
// That intercepts unrelated public endpoints and 401s them. Restrict to
// the actual admin paths.
router.use('/admin/memory', requireAuth);
router.use('/admin/memory', requireExafyAdmin);
router.use('/admin/consolidator', requireAuth);
router.use('/admin/consolidator', requireExafyAdmin);

const VALID_INTENTS: MemoryIntent[] = [
  'recall_recent',
  'recall_history',
  'identity',
  'plan_next_action',
  'open_session',
  'health_query',
  'index_status',
  'goal_check',
  'social_query',
  'community_intent',
  'system_introspect',
];

router.get('/admin/memory/context', async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = String(req.query.tenant_id || '');
  const userId   = String(req.query.user_id   || '');
  const intent   = String(req.query.intent    || 'recall_history') as MemoryIntent;
  const budget   = req.query.budget_ms ? Number(req.query.budget_ms) : 1500;

  if (!tenantId || !userId) {
    return res.status(400).json({ ok: false, error: 'tenant_id and user_id are required' });
  }
  if (!VALID_INTENTS.includes(intent)) {
    return res.status(400).json({ ok: false, error: `unknown intent: ${intent}` });
  }

  const pack = await getMemoryContext({
    tenant_id: tenantId,
    user_id: userId,
    intent,
    channel: 'admin',
    role: 'admin',
    latency_budget_ms: budget,
  });

  return res.json(pack);
});

router.post('/admin/memory/context', async (req: AuthenticatedRequest, res: Response) => {
  const body = req.body || {};
  const tenantId = String(body.tenant_id || '');
  const userId   = String(body.user_id   || '');
  const intent   = String(body.intent    || 'recall_history') as MemoryIntent;
  const budget   = typeof body.latency_budget_ms === 'number' ? body.latency_budget_ms : 1500;
  const requiredBlocks = Array.isArray(body.required_blocks)
    ? (body.required_blocks as MemoryBlockKind[])
    : undefined;

  if (!tenantId || !userId) {
    return res.status(400).json({ ok: false, error: 'tenant_id and user_id are required' });
  }
  if (!VALID_INTENTS.includes(intent)) {
    return res.status(400).json({ ok: false, error: `unknown intent: ${intent}` });
  }

  const pack = await getMemoryContext({
    tenant_id: tenantId,
    user_id: userId,
    intent,
    channel: 'admin',
    role: 'admin',
    latency_budget_ms: budget,
    required_blocks: requiredBlocks,
  });

  return res.json(pack);
});

// VTID-02631 — Phase 7b — agent profile smoke endpoint.
// Exposes buildAgentProfile(tenant_id, user_id) so we can inspect the
// rendered markdown digest before wiring it into the brain prompt.
router.get('/admin/memory/profile', async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = String(req.query.tenant_id || '');
  const userId   = String(req.query.user_id   || '');
  const budget   = req.query.budget_ms ? Number(req.query.budget_ms) : 1500;
  const maxChars = req.query.max_chars ? Number(req.query.max_chars) : undefined;

  if (!tenantId || !userId) {
    return res.status(400).json({ ok: false, error: 'tenant_id and user_id are required' });
  }

  const profile = await buildAgentProfile({
    tenant_id: tenantId,
    user_id: userId,
    latency_budget_ms: budget,
    max_chars: maxChars,
  });

  return res.json(profile);
});

router.post('/admin/memory/profile', async (req: AuthenticatedRequest, res: Response) => {
  const body = req.body || {};
  const tenantId = String(body.tenant_id || '');
  const userId   = String(body.user_id   || '');
  const budget   = typeof body.latency_budget_ms === 'number' ? body.latency_budget_ms : 1500;
  const maxChars = typeof body.max_chars === 'number' ? body.max_chars : undefined;

  if (!tenantId || !userId) {
    return res.status(400).json({ ok: false, error: 'tenant_id and user_id are required' });
  }

  const profile = await buildAgentProfile({
    tenant_id: tenantId,
    user_id: userId,
    latency_budget_ms: budget,
    max_chars: maxChars,
  });

  return res.json(profile);
});

// VTID-02636 — Memory Operations dashboard data feed.
// Single endpoint that aggregates everything the Command Hub
// "intelligence-memory-dev" surface needs to render the 5 tabs against
// real data. All queries are best-effort: any single failure falls back to
// 0 / empty so the dashboard always renders.
router.get('/admin/memory/health', async (_req: AuthenticatedRequest, res: Response) => {
  const t0 = Date.now();
  const supabase = getSupabase();
  if (!supabase) return res.json({ ok: false, error: 'no supabase' });

  const TABLES = [
    'mem_episodes',
    'mem_facts',
    'mem_graph_edges',
    'biometric_trends',
    'biometric_events',
    'vitana_index_trajectory_snapshots',
    'index_delta_observations',
    'drift_adaptation_plans',
    'consolidator_runs',
    'user_feature_introductions',
    'memory_diary_entries',
    'memory_facts',
    'memory_items',
    'autopilot_recommendations',
    'user_proactive_pause',
  ];

  const tableCounts: Record<string, number | null> = {};
  await Promise.all(TABLES.map(async (t) => {
    try {
      const r = await supabase.from(t).select('*', { count: 'exact', head: true });
      tableCounts[t] = r.error ? null : (r.count ?? 0);
    } catch {
      tableCounts[t] = null;
    }
  }));

  const flagKeys = [
    'memory_broker_enabled',
    'consolidator_enabled',
    'cognee_extraction_enabled',
    'index_delta_learner_enabled',
    'tier0_redis_enabled',
    'vitana_brain_enabled',
    'vitana_brain_orb_enabled',
  ];
  const flags: Record<string, boolean | null> = {};
  await Promise.all(flagKeys.map(async (k) => {
    try {
      const c = await getSystemControl(k);
      flags[k] = c ? !!c.enabled : null;
    } catch {
      flags[k] = null;
    }
  }));

  let consolidatorRuns: any[] = [];
  try {
    const r = await supabase
      .from('consolidator_runs')
      .select('id, triggered_by, triggered_at, finished_at, status, summary, tenant_id')
      .order('triggered_at', { ascending: false })
      .limit(10);
    consolidatorRuns = r.data ?? [];
  } catch { consolidatorRuns = []; }

  let memoryEvents: any[] = [];
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const r = await supabase
      .from('oasis_events')
      .select('id, topic, vtid, status, message, payload, created_at, source')
      .or('topic.ilike.memory.%,topic.ilike.orb.memory.%')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(25);
    memoryEvents = r.data ?? [];
  } catch { memoryEvents = []; }

  let identityLockAttempts: any[] = [];
  try {
    const r = await supabase
      .from('oasis_events')
      .select('id, topic, vtid, status, message, payload, created_at')
      .ilike('topic', 'memory.identity.%')
      .order('created_at', { ascending: false })
      .limit(10);
    identityLockAttempts = r.data ?? [];
  } catch { identityLockAttempts = []; }

  return res.json({
    ok: true,
    fetched_at: new Date().toISOString(),
    duration_ms: Date.now() - t0,
    flags,
    table_counts: tableCounts,
    consolidator_runs: consolidatorRuns,
    memory_events: memoryEvents,
    identity_lock_attempts: identityLockAttempts,
  });
});

router.get('/admin/memory/graph-sample', async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.json({ ok: false, error: 'no supabase' });
  const userId = req.query.user_id ? String(req.query.user_id) : null;

  let memEdges: any[] = [];
  try {
    let q = supabase
      .from('mem_graph_edges')
      .select('id, tenant_id, user_id, source_kind, source_id, edge_type, target_kind, target_id, strength, asserted_at')
      .order('asserted_at', { ascending: false })
      .limit(50);
    if (userId) q = q.eq('user_id', userId);
    const r = await q;
    memEdges = r.data ?? [];
  } catch { memEdges = []; }

  let legacyEdges: any[] = [];
  try {
    let q = supabase
      .from('relationship_edges')
      .select('id, tenant_id, source_type, source_id, target_type, target_id, edge_type, strength, last_interaction_at')
      .order('last_interaction_at', { ascending: false, nullsFirst: false })
      .limit(50);
    if (userId) q = q.eq('source_id', userId);
    const r = await q;
    legacyEdges = r.data ?? [];
  } catch { legacyEdges = []; }

  return res.json({
    ok: true,
    mem_graph_edges: memEdges,
    relationship_edges: legacyEdges,
  });
});

router.get('/admin/memory/embeddings', async (_req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.json({ ok: false, error: 'no supabase' });

  const collections = [
    { key: 'memory_items',     model: 'text-embedding-3-small', dimensions: 1536 },
    { key: 'mem_episodes',     model: 'text-embedding-3-small', dimensions: 1536 },
    { key: 'memory_diary_entries', model: 'text-embedding-3-small', dimensions: 1536 },
  ];

  const out: any[] = [];
  await Promise.all(collections.map(async (c) => {
    try {
      const r = await supabase.from(c.key).select('*', { count: 'exact', head: true });
      out.push({ ...c, vectors: r.error ? null : (r.count ?? 0), status: r.error ? 'error' : 'active' });
    } catch {
      out.push({ ...c, vectors: null, status: 'error' });
    }
  }));

  return res.json({ ok: true, collections: out });
});

// VTID-02632 — Phase 8 — admin consolidator smoke endpoint.
// Triggers the nightly consolidator on demand. Body:
//   { tenant_id?, user_id?, loops?: LoopId[] }
// If tenant_id+user_id are both supplied, the run is scoped to that user.
// Otherwise it sweeps all users (heavy — only run from admin tooling).
router.post('/admin/consolidator/run', async (req: AuthenticatedRequest, res: Response) => {
  const body = req.body || {};
  const tenantId = body.tenant_id ? String(body.tenant_id) : undefined;
  const userId   = body.user_id   ? String(body.user_id)   : undefined;
  const loops = Array.isArray(body.loops) ? (body.loops as LoopId[]) : undefined;

  const userScope = (tenantId && userId)
    ? { tenant_id: tenantId, user_id: userId }
    : undefined;

  const result = await runConsolidator({
    triggered_by: 'admin',
    user_scope: userScope,
    loops,
  });

  return res.json(result);
});

export default router;
