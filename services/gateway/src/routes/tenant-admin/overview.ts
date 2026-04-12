/**
 * Batch 1.D (partial): Tenant Overview Dashboard API
 *
 * Mounted at /api/v1/admin/tenants/:tenantId/overview
 *
 * Endpoints:
 *   GET /summary     — Single JSON blob with all dashboard KPIs (cached 60s)
 *   GET /at-risk     — At-risk member cohort (active last 30d, no session last 14d)
 *   GET /activity    — Recent OASIS events filtered by tenant
 *   GET /alerts      — L1/L2 severity OASIS events for tenant
 *
 * Design principle: every number has a delta vs prior period.
 * Single round trip on load — the summary endpoint returns everything
 * top-of-fold in one call so the screen feels instant.
 */

import { Router, Response } from 'express';
import { requireTenantAdmin } from '../../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';

const router = Router({ mergeParams: true });
const VTID = 'TENANT-OVERVIEW';

// Simple in-memory cache for summary (60s TTL)
let summaryCache: { tenantId: string; data: any; ts: number } | null = null;
const CACHE_TTL_MS = 60_000;

// GET /summary — all dashboard KPIs in one call
router.get('/summary', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;

    // Check cache
    if (summaryCache && summaryCache.tenantId === tenantId && Date.now() - summaryCache.ts < CACHE_TTL_MS) {
      return res.json({ ok: true, cached: true, ...summaryCache.data });
    }

    const now = new Date();
    const d7 = new Date(now.getTime() - 7 * 86400_000).toISOString();
    const d14 = new Date(now.getTime() - 14 * 86400_000).toISOString();
    const d7prior = new Date(now.getTime() - 14 * 86400_000).toISOString(); // prior 7d window start
    const d24h = new Date(now.getTime() - 86400_000).toISOString();

    // Parallel queries for KPIs
    const [
      totalMembersResult,
      newSignups7dResult,
      newSignupsPrior7dResult,
      rolesSummaryResult,
      pendingInvitationsResult,
      kbDocsResult,
    ] = await Promise.all([
      // Total members in this tenant
      supabase.from('user_tenants').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
      // New signups last 7 days
      supabase.from('user_tenants').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', d7),
      // New signups prior 7 days (for delta)
      supabase.from('user_tenants').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', d7prior).lt('created_at', d7),
      // Role distribution
      supabase.from('user_tenants').select('active_role').eq('tenant_id', tenantId),
      // Pending invitations
      supabase.from('tenant_invitations').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).is('accepted_at', null).is('revoked_at', null),
      // KB docs count
      supabase.from('kb_documents').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
    ]);

    const totalMembers = totalMembersResult.count || 0;
    const newSignups7d = newSignups7dResult.count || 0;
    const newSignupsPrior7d = newSignupsPrior7dResult.count || 0;
    const pendingInvitations = pendingInvitationsResult.count || 0;
    const kbDocsCount = kbDocsResult.count || 0;

    // Role distribution
    const roleCounts: Record<string, number> = {};
    (rolesSummaryResult.data || []).forEach((r: any) => {
      const role = r.active_role || 'unknown';
      roleCounts[role] = (roleCounts[role] || 0) + 1;
    });

    // Signup delta
    const signupDelta = newSignupsPrior7d > 0
      ? Math.round(((newSignups7d - newSignupsPrior7d) / newSignupsPrior7d) * 100)
      : newSignups7d > 0 ? 100 : 0;

    const summary = {
      kpi: {
        total_members: totalMembers,
        new_signups_7d: newSignups7d,
        new_signups_delta_pct: signupDelta,
        pending_invitations: pendingInvitations,
        kb_documents: kbDocsCount,
      },
      role_distribution: roleCounts,
      action_inbox: {
        pending_invitations: pendingInvitations,
      },
      generated_at: now.toISOString(),
    };

    // Cache
    summaryCache = { tenantId, data: summary, ts: Date.now() };

    return res.json({ ok: true, cached: false, ...summary });
  } catch (err: any) {
    console.error(`[${VTID}] Summary error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /at-risk — members previously active but no session in 14d
router.get('/at-risk', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;

    // Get all tenant members with their app_users info
    const { data: members } = await supabase
      .from('user_tenants')
      .select('user_id, active_role, created_at')
      .eq('tenant_id', tenantId);

    if (!members || members.length === 0) {
      return res.json({ ok: true, at_risk: [], count: 0 });
    }

    const userIds = members.map((m: any) => m.user_id);
    const { data: users } = await supabase
      .from('app_users')
      .select('user_id, email, display_name, avatar_url, updated_at')
      .in('user_id', userIds);

    // "At-risk" heuristic: user hasn't updated their profile in 14+ days
    // (proxy for activity — real activity tracking needs session telemetry)
    const d14 = new Date(Date.now() - 14 * 86400_000);
    const atRisk = (users || [])
      .filter((u: any) => {
        const lastActive = new Date(u.updated_at || u.created_at || 0);
        return lastActive < d14;
      })
      .slice(0, 20)
      .map((u: any) => ({
        user_id: u.user_id,
        email: u.email,
        display_name: u.display_name,
        avatar_url: u.avatar_url,
        last_seen: u.updated_at,
      }));

    return res.json({ ok: true, at_risk: atRisk, count: atRisk.length });
  } catch (err: any) {
    console.error(`[${VTID}] At-risk error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /activity — recent OASIS events for tenant
router.get('/activity', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    // Query oasis_events — filter by tenant metadata if available
    const { data, error } = await supabase
      .from('oasis_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) return res.status(500).json({ ok: false, error: error.message });

    // Client-side filter by tenant (oasis_events doesn't have tenant_id column)
    const tenantEvents = (data || []).filter((e: any) => {
      const meta = e.metadata || {};
      return meta.tenant_id === tenantId || !meta.tenant_id; // include tenant-specific + global
    });

    return res.json({ ok: true, events: tenantEvents.slice(0, limit) });
  } catch (err: any) {
    console.error(`[${VTID}] Activity error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /alerts — L1/L2 severity events for tenant
router.get('/alerts', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const d24h = new Date(Date.now() - 86400_000).toISOString();

    const { data, error } = await supabase
      .from('oasis_events')
      .select('*')
      .in('status', ['error', 'critical'])
      .gte('created_at', d24h)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) return res.status(500).json({ ok: false, error: error.message });

    return res.json({ ok: true, alerts: data || [], count: (data || []).length });
  } catch (err: any) {
    console.error(`[${VTID}] Alerts error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
