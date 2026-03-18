/**
 * Automations API Routes — VTID-01250
 *
 * Endpoints:
 *   GET  /api/v1/automations/registry         — List all automations with status
 *   GET  /api/v1/automations/registry/summary  — Summary dashboard
 *   GET  /api/v1/automations/registry/:id      — Get single automation details
 *   POST /api/v1/automations/execute/:id       — Execute a single automation manually
 *   POST /api/v1/automations/heartbeat         — Run one heartbeat cycle
 *   POST /api/v1/automations/dispatch          — Dispatch an OASIS event to automations
 *   POST /api/v1/automations/cron/:id          — Cron trigger for a specific automation
 *   GET  /api/v1/automations/runs              — Get run history
 *   GET  /api/v1/automations/runs/active       — Get currently running automations
 *   GET  /api/v1/automations/health            — Health check
 *
 * Wallet endpoints:
 *   GET  /api/v1/automations/wallet/balance     — Get user wallet balance
 *   GET  /api/v1/automations/wallet/transactions — Get user wallet transactions
 *
 * Sharing endpoints:
 *   POST /api/v1/automations/sharing/generate-link — Generate a sharing link
 *   GET  /api/v1/automations/sharing/links        — Get user's sharing links
 *   GET  /api/v1/automations/referrals             — Get user's referrals
 */

import { Router, Request, Response } from 'express';
import {
  AUTOMATION_REGISTRY,
  getAutomation,
  getAutomationsByDomain,
  getAutomationsByRole,
  getRegistrySummary,
} from '../services/automation-registry';
import {
  executeAutomation,
  runHeartbeatCycle,
  dispatchEvent,
  getRunHistory,
  getActiveRuns,
} from '../services/automation-executor';
import { randomUUID } from 'crypto';

const router = Router();
const VTID = 'VTID-01250';

// ── Helper: get tenant_id ───────────────────────────────────
function getTenantId(req: Request): string | null {
  return (req as any).identity?.tenant_id || req.body?.tenant_id || process.env.DEFAULT_TENANT_ID || null;
}

function getUserId(req: Request): string | null {
  return (req as any).identity?.user_id || null;
}

// ── Helper: service-role Supabase client ────────────────────
async function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key);
}

// =============================================================================
// Registry endpoints
// =============================================================================

router.get('/registry', (_req: Request, res: Response) => {
  const domain = _req.query.domain as string | undefined;
  const status = _req.query.status as string | undefined;
  const role = _req.query.role as string | undefined;

  let automations = domain ? getAutomationsByDomain(domain) : [...AUTOMATION_REGISTRY];
  if (status) automations = automations.filter(a => a.status === status);
  if (role) automations = automations.filter(a => a.targetRoles === 'all' || a.targetRoles.includes(role as any));

  return res.json({ ok: true, total: automations.length, automations });
});

router.get('/registry/summary', (_req: Request, res: Response) => {
  return res.json({ ok: true, ...getRegistrySummary() });
});

router.get('/registry/:id', (req: Request, res: Response) => {
  const def = getAutomation(req.params.id);
  if (!def) return res.status(404).json({ ok: false, error: `Unknown automation: ${req.params.id}` });
  return res.json({ ok: true, automation: def });
});

// =============================================================================
// Execution endpoints
// =============================================================================

router.post('/execute/:id', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const result = await executeAutomation(
    req.params.id,
    tenantId,
    'manual',
    getUserId(req) || 'api',
    req.body?.payload
  );

  return res.status(result.ok ? 200 : 500).json(result);
});

router.post('/heartbeat', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const result = await runHeartbeatCycle(tenantId);

  console.log(`[${VTID}] Heartbeat: executed=${result.executed.length} skipped=${result.skipped.length} failed=${result.failed.length}`);
  return res.json({ ok: true, ...result });
});

router.post('/dispatch', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  const { event_topic, event_payload } = req.body || {};
  if (!tenantId || !event_topic) {
    return res.status(400).json({ ok: false, error: 'tenant_id and event_topic required' });
  }

  const result = await dispatchEvent(tenantId, event_topic, event_payload || {});
  return res.json({ ok: true, ...result });
});

router.post('/cron/:id', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const result = await executeAutomation(req.params.id, tenantId, 'cron', 'cloud-scheduler');
  return res.status(result.ok ? 200 : 500).json(result);
});

// =============================================================================
// Run history
// =============================================================================

router.get('/runs', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const automationId = req.query.automation_id as string | undefined;
  const limit = parseInt(req.query.limit as string) || 50;

  const runs = await getRunHistory(tenantId, automationId, limit);
  return res.json({ ok: true, total: runs.length, runs });
});

router.get('/runs/active', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const runs = await getActiveRuns(tenantId);
  return res.json({ ok: true, total: runs.length, runs });
});

// =============================================================================
// Wallet endpoints
// =============================================================================

router.get('/wallet/balance', async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const tenantId = getTenantId(req);
  if (!userId || !tenantId) return res.status(401).json({ ok: false, error: 'Authentication required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const { data } = await supa
    .from('wallet_balances')
    .select('balance, total_earned, total_spent, updated_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .maybeSingle();

  return res.json({
    ok: true,
    balance: data?.balance || 0,
    total_earned: data?.total_earned || 0,
    total_spent: data?.total_spent || 0,
    updated_at: data?.updated_at || null,
  });
});

router.get('/wallet/transactions', async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const tenantId = getTenantId(req);
  if (!userId || !tenantId) return res.status(401).json({ ok: false, error: 'Authentication required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const limit = parseInt(req.query.limit as string) || 50;
  const { data } = await supa
    .from('wallet_transactions')
    .select('id, amount, type, source, description, balance_after, created_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  return res.json({ ok: true, transactions: data || [] });
});

// =============================================================================
// Sharing endpoints
// =============================================================================

router.post('/sharing/generate-link', async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const tenantId = getTenantId(req);
  if (!userId || !tenantId) return res.status(401).json({ ok: false, error: 'Authentication required' });

  const { target_type, target_id, utm_campaign } = req.body || {};
  if (!target_type || !target_id) {
    return res.status(400).json({ ok: false, error: 'target_type and target_id required' });
  }

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const shortCode = randomUUID().replace(/-/g, '').substring(0, 8);
  const appUrl = process.env.APP_URL || 'https://vitana.app';

  const { data, error } = await supa.from('sharing_links').insert({
    tenant_id: tenantId,
    user_id: userId,
    target_type,
    target_id,
    short_code: shortCode,
    utm_campaign: utm_campaign || `${target_type}_share`,
  }).select('id, short_code').single();

  if (error) return res.status(500).json({ ok: false, error: error.message });

  const shareUrl = `${appUrl}/s/${shortCode}`;
  const whatsappUrl = `whatsapp://send?text=${encodeURIComponent(shareUrl)}`;

  return res.json({
    ok: true,
    link: {
      id: data.id,
      short_code: shortCode,
      url: shareUrl,
      whatsapp_url: whatsappUrl,
    },
  });
});

router.get('/sharing/links', async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const tenantId = getTenantId(req);
  if (!userId || !tenantId) return res.status(401).json({ ok: false, error: 'Authentication required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const { data } = await supa
    .from('sharing_links')
    .select('id, target_type, target_id, short_code, click_count, signup_count, created_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);

  return res.json({ ok: true, links: data || [] });
});

router.get('/referrals', async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const tenantId = getTenantId(req);
  if (!userId || !tenantId) return res.status(401).json({ ok: false, error: 'Authentication required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const { data } = await supa
    .from('referrals')
    .select('id, source, status, reward_amount, click_count, created_at, activated_at')
    .eq('tenant_id', tenantId)
    .eq('referrer_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);

  return res.json({ ok: true, referrals: data || [] });
});

// =============================================================================
// Health check
// =============================================================================

router.get('/health', (_req: Request, res: Response) => {
  const summary = getRegistrySummary();
  return res.json({
    ok: true,
    service: 'automations-engine',
    vtid: VTID,
    total_automations: summary.total,
    executable: summary.executable,
    planned: summary.planned,
  });
});

export default router;
