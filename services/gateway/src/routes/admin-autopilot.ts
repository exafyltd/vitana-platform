/**
 * VTID-AP-ADMIN: Tenant-scoped Autopilot administration routes.
 *
 * All endpoints gated by requireTenantAdmin — supports both exafy_admin
 * (super-admin, all tenants) and tenant-admin (own tenant only).
 *
 * Mounted at /api/v1/admin/autopilot
 */

import { Router, Request, Response } from 'express';
import { requireTenantAdmin } from '../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { AUTOMATION_REGISTRY } from '../services/automation-registry';
import { DEFAULT_WAVE_CONFIG, WaveDefinition } from '../services/wave-defaults';

const router = Router();
const VTID = 'VTID-AP-ADMIN';

// ── Helpers ──────────────────────────────────────────────────────────────────

function getTenantId(req: Request): string {
  return (req as any).targetTenantId || (req as AuthenticatedRequest).identity?.tenant_id;
}

function getUserId(req: Request): string | undefined {
  return (req as AuthenticatedRequest).identity?.user_id;
}

// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * GET /settings
 * Returns tenant autopilot settings (creates default row if none exists).
 */
router.get('/settings', requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    let { data, error } = await supabase
      .from('tenant_autopilot_settings')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (error) throw error;

    // Auto-provision defaults on first access
    if (!data) {
      const { data: created, error: createErr } = await supabase
        .from('tenant_autopilot_settings')
        .insert({ tenant_id: tenantId })
        .select('*')
        .single();
      if (createErr) throw createErr;
      data = created;
    }

    res.json({ ok: true, data });
  } catch (err: any) {
    console.error(`[${VTID}] GET /settings error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * PATCH /settings
 * Update tenant autopilot settings.
 */
router.patch('/settings', requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const userId = getUserId(req);
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const allowed = [
      'enabled', 'max_recommendations_per_day', 'max_activations_per_day',
      'allowed_domains', 'allowed_risk_levels', 'auto_activate_threshold',
      'recommendation_retention_days', 'generation_schedule', 'wave_config',
    ];
    const updates: Record<string, unknown> = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ ok: false, error: 'NO_CHANGES', message: 'No valid fields to update' });
    }
    updates.updated_by = userId;

    // Ensure row exists first
    const { data: existing } = await supabase
      .from('tenant_autopilot_settings')
      .select('id')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!existing) {
      // Create with overrides
      const { data, error } = await supabase
        .from('tenant_autopilot_settings')
        .insert({ tenant_id: tenantId, ...updates })
        .select('*')
        .single();
      if (error) throw error;
      return res.json({ ok: true, data });
    }

    const { data, error } = await supabase
      .from('tenant_autopilot_settings')
      .update(updates)
      .eq('tenant_id', tenantId)
      .select('*')
      .single();

    if (error) throw error;
    res.json({ ok: true, data });
  } catch (err: any) {
    console.error(`[${VTID}] PATCH /settings error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Bindings (Active Automations) ────────────────────────────────────────────

/**
 * GET /bindings
 * List all automation bindings for the tenant.
 */
router.get('/bindings', requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const { enabled } = req.query;
    let query = supabase
      .from('tenant_autopilot_bindings')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('automation_id', { ascending: true });

    if (enabled === 'true') query = query.eq('enabled', true);
    if (enabled === 'false') query = query.eq('enabled', false);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ ok: true, data: data || [] });
  } catch (err: any) {
    console.error(`[${VTID}] GET /bindings error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /bindings
 * Create or upsert a binding for a specific automation.
 */
router.post('/bindings', requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const userId = getUserId(req);
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const { automation_id, enabled, schedule, guardrails, role_allowances,
            requires_approval, max_runs_per_day, max_runs_per_user_per_day } = req.body;

    if (!automation_id) {
      return res.status(400).json({ ok: false, error: 'MISSING_AUTOMATION_ID' });
    }

    const row = {
      tenant_id: tenantId,
      automation_id,
      enabled: enabled ?? true,
      schedule: schedule ?? null,
      guardrails: guardrails ?? null,
      role_allowances: role_allowances ?? ['admin'],
      requires_approval: requires_approval ?? true,
      max_runs_per_day: max_runs_per_day ?? null,
      max_runs_per_user_per_day: max_runs_per_user_per_day ?? null,
      updated_by: userId,
    };

    const { data, error } = await supabase
      .from('tenant_autopilot_bindings')
      .upsert(row, { onConflict: 'tenant_id,automation_id' })
      .select('*')
      .single();

    if (error) throw error;
    res.json({ ok: true, data });
  } catch (err: any) {
    console.error(`[${VTID}] POST /bindings error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * PATCH /bindings/:bindingId
 * Update an existing binding.
 */
router.patch('/bindings/:bindingId', requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const userId = getUserId(req);
    const { bindingId } = req.params;
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const allowed = [
      'enabled', 'schedule', 'guardrails', 'role_allowances',
      'requires_approval', 'max_runs_per_day', 'max_runs_per_user_per_day',
    ];
    const updates: Record<string, unknown> = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ ok: false, error: 'NO_CHANGES' });
    }
    updates.updated_by = userId;

    const { data, error } = await supabase
      .from('tenant_autopilot_bindings')
      .update(updates)
      .eq('id', bindingId)
      .eq('tenant_id', tenantId)
      .select('*')
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    res.json({ ok: true, data });
  } catch (err: any) {
    console.error(`[${VTID}] PATCH /bindings/:bindingId error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /bindings/:bindingId
 * Remove a binding.
 */
router.delete('/bindings/:bindingId', requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { bindingId } = req.params;
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const { error } = await supabase
      .from('tenant_autopilot_bindings')
      .delete()
      .eq('id', bindingId)
      .eq('tenant_id', tenantId);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err: any) {
    console.error(`[${VTID}] DELETE /bindings/:bindingId error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Runs (Execution History) ─────────────────────────────────────────────────

/**
 * GET /runs
 * List execution runs for the tenant (paginated, filterable).
 */
router.get('/runs', requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const { status, automation_id } = req.query;

    let query = supabase
      .from('tenant_autopilot_runs')
      .select('*', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .order('started_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (automation_id) query = query.eq('automation_id', automation_id);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ ok: true, data: data || [], total: count || 0 });
  } catch (err: any) {
    console.error(`[${VTID}] GET /runs error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /runs/stats
 * Aggregate run statistics for the Growth tab.
 */
router.get('/runs/stats', requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const days = parseInt(req.query.days as string) || 30;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const { data: runs, error } = await supabase
      .from('tenant_autopilot_runs')
      .select('status, duration_ms, started_at, automation_id')
      .eq('tenant_id', tenantId)
      .gte('started_at', since);

    if (error) throw error;

    const allRuns = runs || [];
    const completed = allRuns.filter(r => r.status === 'completed');
    const failed = allRuns.filter(r => r.status === 'failed');

    // Time saved estimate: each completed automation saves ~15 min of manual work
    const timeSavedMinutes = completed.length * 15;

    // Per-automation breakdown
    const byAutomation: Record<string, { total: number; completed: number; failed: number; avg_duration_ms: number }> = {};
    for (const run of allRuns) {
      if (!byAutomation[run.automation_id]) {
        byAutomation[run.automation_id] = { total: 0, completed: 0, failed: 0, avg_duration_ms: 0 };
      }
      const entry = byAutomation[run.automation_id];
      entry.total++;
      if (run.status === 'completed') {
        entry.completed++;
        entry.avg_duration_ms += (run.duration_ms || 0);
      }
      if (run.status === 'failed') entry.failed++;
    }
    // Average duration
    for (const key of Object.keys(byAutomation)) {
      const entry = byAutomation[key];
      if (entry.completed > 0) entry.avg_duration_ms = Math.round(entry.avg_duration_ms / entry.completed);
    }

    // Daily trend (runs per day)
    const dailyTrend: Record<string, number> = {};
    for (const run of allRuns) {
      const day = run.started_at.slice(0, 10);
      dailyTrend[day] = (dailyTrend[day] || 0) + 1;
    }

    res.json({
      ok: true,
      data: {
        period_days: days,
        total_runs: allRuns.length,
        completed: completed.length,
        failed: failed.length,
        success_rate: allRuns.length > 0 ? Math.round((completed.length / allRuns.length) * 100) : 0,
        time_saved_minutes: timeSavedMinutes,
        by_automation: byAutomation,
        daily_trend: Object.entries(dailyTrend)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, count]) => ({ date, count })),
      },
    });
  } catch (err: any) {
    console.error(`[${VTID}] GET /runs/stats error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Recommendations (tenant-filtered view) ───────────────────────────────────

/**
 * GET /recommendations
 * Tenant-scoped recommendation list. Wraps the existing autopilot_recommendations
 * table with tenant settings awareness (allowed domains, risk levels).
 */
router.get('/recommendations', requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const { status, domain, risk_level } = req.query;

    // Get tenant settings for filtering
    const { data: settings } = await supabase
      .from('tenant_autopilot_settings')
      .select('allowed_domains, allowed_risk_levels, enabled')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    // If autopilot is disabled for this tenant, return empty
    if (settings && !settings.enabled) {
      return res.json({ ok: true, data: [], total: 0, autopilot_enabled: false });
    }

    const allowedDomains = settings?.allowed_domains || ['health', 'community', 'longevity', 'professional', 'general'];
    const allowedRisks = settings?.allowed_risk_levels || ['low', 'medium'];

    let query = supabase
      .from('autopilot_recommendations')
      .select('*', { count: 'exact' })
      .in('domain', allowedDomains)
      .in('risk_level', allowedRisks)
      .order('impact_score', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Exclude snoozed
    query = query.or('snoozed_until.is.null,snoozed_until.lt.' + new Date().toISOString());

    if (status) query = query.eq('status', status as string);
    if (domain) query = query.eq('domain', domain as string);
    if (risk_level) query = query.eq('risk_level', risk_level as string);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ ok: true, data: data || [], total: count || 0, autopilot_enabled: true });
  } catch (err: any) {
    console.error(`[${VTID}] GET /recommendations error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /recommendations/summary
 * Quick counts for the Recommendations tab header badges.
 */
router.get('/recommendations/summary', requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const { data: settings } = await supabase
      .from('tenant_autopilot_settings')
      .select('allowed_domains, allowed_risk_levels, enabled')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (settings && !settings.enabled) {
      return res.json({ ok: true, data: { new: 0, activated: 0, rejected: 0, snoozed: 0, total: 0 } });
    }

    const allowedDomains = settings?.allowed_domains || ['health', 'community', 'longevity', 'professional', 'general'];
    const allowedRisks = settings?.allowed_risk_levels || ['low', 'medium'];

    const { data, error } = await supabase
      .from('autopilot_recommendations')
      .select('status')
      .in('domain', allowedDomains)
      .in('risk_level', allowedRisks);

    if (error) throw error;

    const counts = { new: 0, activated: 0, rejected: 0, snoozed: 0, total: 0 };
    for (const row of data || []) {
      counts.total++;
      if (row.status === 'new') counts.new++;
      else if (row.status === 'activated') counts.activated++;
      else if (row.status === 'rejected') counts.rejected++;
      else if (row.status === 'snoozed') counts.snoozed++;
    }

    res.json({ ok: true, data: counts });
  } catch (err: any) {
    console.error(`[${VTID}] GET /recommendations/summary error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Waves (Planning tab) ────────────────────────────────────────────────────

/**
 * GET /waves
 * Returns wave definitions enriched with automation binding data for this tenant.
 */
router.get('/waves', requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    // Get tenant wave_config overrides
    const { data: settings } = await supabase
      .from('tenant_autopilot_settings')
      .select('wave_config')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    const overrides: Record<string, Partial<WaveDefinition>> = settings?.wave_config || {};

    // Get tenant bindings for automation status
    const { data: bindings } = await supabase
      .from('tenant_autopilot_bindings')
      .select('automation_id, enabled')
      .eq('tenant_id', tenantId);

    const bindingMap = new Map((bindings || []).map((b: any) => [b.automation_id, b.enabled]));
    const registryMap = new Map(AUTOMATION_REGISTRY.map(a => [a.id, a]));

    // Merge defaults with tenant overrides
    const waves = DEFAULT_WAVE_CONFIG.map(wave => {
      const override = overrides[wave.id] || {};
      const merged = { ...wave, ...override };

      // Compute automation stats
      const automations = wave.automation_ids.map(id => {
        const reg = registryMap.get(id);
        return {
          id,
          name: reg?.name || id,
          status: reg?.status || 'PLANNED',
          enabled: bindingMap.get(id) ?? false,
        };
      });

      return {
        ...merged,
        automations,
        total_automations: automations.length,
        enabled_automations: automations.filter(a => a.enabled).length,
        implemented_automations: automations.filter(a => a.status === 'IMPLEMENTED' || a.status === 'LIVE').length,
        total_templates: wave.recommendation_templates.length,
      };
    });

    res.json({ ok: true, data: waves });
  } catch (err: any) {
    console.error(`[${VTID}] GET /waves error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * PATCH /waves/:waveId
 * Toggle a wave ON/OFF for this tenant. Also batch-updates bindings for its automations.
 */
router.patch('/waves/:waveId', requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const userId = getUserId(req);
    const { waveId } = req.params;
    const { enabled } = req.body;
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const wave = DEFAULT_WAVE_CONFIG.find(w => w.id === waveId);
    if (!wave) return res.status(404).json({ ok: false, error: 'WAVE_NOT_FOUND' });
    if (typeof enabled !== 'boolean') return res.status(400).json({ ok: false, error: 'MISSING_ENABLED' });

    // Get or create settings
    let { data: settings } = await supabase
      .from('tenant_autopilot_settings')
      .select('wave_config')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!settings) {
      await supabase.from('tenant_autopilot_settings').insert({ tenant_id: tenantId });
      settings = { wave_config: {} };
    }

    const waveConfig = settings.wave_config || {};
    waveConfig[waveId] = { ...(waveConfig[waveId] || {}), enabled };

    // Save wave_config
    const { error: updateErr } = await supabase
      .from('tenant_autopilot_settings')
      .update({ wave_config: waveConfig, updated_by: userId })
      .eq('tenant_id', tenantId);

    if (updateErr) throw updateErr;

    // Batch update automation bindings for this wave
    if (wave.automation_ids.length > 0) {
      const rows = wave.automation_ids.map(automation_id => ({
        tenant_id: tenantId,
        automation_id,
        enabled,
        updated_by: userId,
      }));

      for (const row of rows) {
        await supabase
          .from('tenant_autopilot_bindings')
          .upsert(row, { onConflict: 'tenant_id,automation_id' });
      }
    }

    res.json({ ok: true, data: { wave_id: waveId, enabled } });
  } catch (err: any) {
    console.error(`[${VTID}] PATCH /waves/:waveId error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Catalog (available automations for the Automations tab) ──────────────────

/**
 * GET /catalog
 * Returns the full AP automation catalog with the tenant's binding status overlaid.
 * This is a JOIN of the static catalog with tenant_autopilot_bindings.
 */
router.get('/catalog', requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    // Get tenant bindings
    const { data: bindings, error: bErr } = await supabase
      .from('tenant_autopilot_bindings')
      .select('*')
      .eq('tenant_id', tenantId);

    if (bErr) throw bErr;

    // Real AP-XXXX catalog from automation-registry.ts (116 automations)
    const bindingMap = new Map((bindings || []).map(b => [b.automation_id, b]));

    const items = AUTOMATION_REGISTRY.map(entry => ({
      id: entry.id,
      name: entry.name,
      domain: entry.domain,
      status: entry.status,
      priority: entry.priority,
      trigger_type: entry.triggerType,
      trigger_config: entry.triggerConfig || null,
      target_roles: entry.targetRoles,
      has_handler: !!entry.handler,
      requires: entry.requires || [],
      binding: bindingMap.get(entry.id) || null,
      enabled: bindingMap.get(entry.id)?.enabled ?? false,
    }));

    res.json({ ok: true, data: items });
  } catch (err: any) {
    console.error(`[${VTID}] GET /catalog error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
