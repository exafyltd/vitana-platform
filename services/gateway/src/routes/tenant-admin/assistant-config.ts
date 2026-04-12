/**
 * Batch 1.B2: Tenant Assistant Configuration API
 *
 * Mounted at /api/v1/admin/tenants/:tenantId/assistant
 *
 * Endpoints:
 *   GET  /                    — List all surface configs (global + tenant overrides)
 *   GET  /:surfaceKey         — Single surface: global default + tenant override
 *   PUT  /:surfaceKey         — Update tenant override for a surface
 *   DELETE /:surfaceKey       — Remove tenant override (revert to global)
 */

import { Router, Response } from 'express';
import { requireTenantAdmin } from '../../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import {
  VALID_SURFACE_KEYS,
  PersonalitySurfaceKey,
  getPersonalityConfig,
  getEffectiveConfig,
  getTenantAssistantConfig,
  upsertTenantAssistantConfig,
} from '../../services/ai-personality-service';
import { getSupabase } from '../../lib/supabase';

const router = Router({ mergeParams: true });

// GET / — all surfaces with effective config
router.get('/', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const results = [];

    for (const surfaceKey of VALID_SURFACE_KEYS) {
      const globalConfig = await getPersonalityConfig(surfaceKey);
      const tenantOverride = await getTenantAssistantConfig(tenantId, surfaceKey);
      const effective = await getEffectiveConfig(surfaceKey, tenantId);

      results.push({
        surface_key: surfaceKey,
        global_defaults: globalConfig.defaults,
        global_config: globalConfig.config,
        global_is_customized: globalConfig.is_customized,
        tenant_override: tenantOverride,
        effective_config: effective,
        has_tenant_override: !!tenantOverride,
      });
    }

    return res.json({ ok: true, surfaces: results });
  } catch (err: any) {
    console.error('[TENANT-ASSISTANT] List error:', err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /:surfaceKey — single surface detail
router.get('/:surfaceKey', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const surfaceKey = req.params.surfaceKey as PersonalitySurfaceKey;

    if (!VALID_SURFACE_KEYS.includes(surfaceKey)) {
      return res.status(400).json({ ok: false, error: 'INVALID_SURFACE_KEY' });
    }

    const globalConfig = await getPersonalityConfig(surfaceKey);
    const tenantOverride = await getTenantAssistantConfig(tenantId, surfaceKey);
    const effective = await getEffectiveConfig(surfaceKey, tenantId);

    return res.json({
      ok: true,
      surface_key: surfaceKey,
      global_defaults: globalConfig.defaults,
      global_config: globalConfig.config,
      tenant_override: tenantOverride,
      effective_config: effective,
      has_tenant_override: !!tenantOverride,
    });
  } catch (err: any) {
    console.error('[TENANT-ASSISTANT] Get error:', err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// PUT /:surfaceKey — update tenant override
router.put('/:surfaceKey', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const surfaceKey = req.params.surfaceKey as PersonalitySurfaceKey;

    if (!VALID_SURFACE_KEYS.includes(surfaceKey)) {
      return res.status(400).json({ ok: false, error: 'INVALID_SURFACE_KEY' });
    }

    const { system_prompt_override, voice_config_override, tool_overrides, model_routing_override, extra_config } = req.body;

    const updates: Record<string, unknown> = {};
    if (system_prompt_override !== undefined) updates.system_prompt_override = system_prompt_override;
    if (voice_config_override !== undefined) updates.voice_config_override = voice_config_override;
    if (tool_overrides !== undefined) updates.tool_overrides = tool_overrides;
    if (model_routing_override !== undefined) updates.model_routing_override = model_routing_override;
    if (extra_config !== undefined) updates.extra_config = extra_config;

    const result = await upsertTenantAssistantConfig(
      tenantId,
      surfaceKey,
      updates,
      req.identity!.user_id
    );

    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }

    // Return the new effective config
    const effective = await getEffectiveConfig(surfaceKey, tenantId);
    return res.json({ ok: true, effective_config: effective });
  } catch (err: any) {
    console.error('[TENANT-ASSISTANT] Update error:', err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// DELETE /:surfaceKey — remove tenant override
router.delete('/:surfaceKey', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const surfaceKey = req.params.surfaceKey as PersonalitySurfaceKey;

    if (!VALID_SURFACE_KEYS.includes(surfaceKey)) {
      return res.status(400).json({ ok: false, error: 'INVALID_SURFACE_KEY' });
    }

    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    await supabase
      .from('tenant_assistant_config')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('surface_key', surfaceKey);

    return res.json({ ok: true, message: `Tenant override removed for ${surfaceKey}. Now using global config.` });
  } catch (err: any) {
    console.error('[TENANT-ASSISTANT] Delete error:', err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
