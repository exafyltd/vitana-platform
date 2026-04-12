/**
 * Settings section: Tenant Settings API
 *
 * Mounted at /api/v1/admin/tenants/:tenantId/settings
 *
 * Endpoints:
 *   GET  /    — Full settings object
 *   PUT  /    — Update settings (partial merge)
 */

import { Router, Response } from 'express';
import { requireTenantAdmin } from '../../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';

const router = Router({ mergeParams: true });

// GET / — read settings
router.get('/', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;

    const { data, error } = await supabase
      .from('tenant_settings')
      .select('*')
      .eq('tenant_id', tenantId)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows
      return res.status(500).json({ ok: false, error: error.message });
    }

    // Return defaults if no row exists yet
    const settings = data || {
      tenant_id: tenantId,
      profile: {},
      branding: {},
      feature_flags: {},
      integrations: {},
      domains: {},
      billing: {},
    };

    return res.json({ ok: true, settings });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// PUT / — update settings (partial merge per section)
router.put('/', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const { profile, branding, feature_flags, integrations, domains } = req.body;

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
      updated_by: req.identity!.user_id,
    };
    if (profile !== undefined) updates.profile = profile;
    if (branding !== undefined) updates.branding = branding;
    if (feature_flags !== undefined) updates.feature_flags = feature_flags;
    if (integrations !== undefined) updates.integrations = integrations;
    if (domains !== undefined) updates.domains = domains;
    // billing is read-only from admin — not updatable via this endpoint

    const { data, error } = await supabase
      .from('tenant_settings')
      .upsert({ tenant_id: tenantId, ...updates }, { onConflict: 'tenant_id' })
      .select('*')
      .single();

    if (error) return res.status(500).json({ ok: false, error: error.message });

    return res.json({ ok: true, settings: data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
