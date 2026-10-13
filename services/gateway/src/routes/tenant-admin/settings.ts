/**
 * Settings section: Tenant Settings API
 *
 * Mounted at /api/v1/admin/tenants/:tenantId/settings
 *
 * Endpoints:
 *   GET  /    — Full settings object
 *   PUT  /    — Update settings (partial merge; feature_flags merged per key,
 *               `jev` governed — exafy_admin only, VTID-05150)
 */

import { Router, Response } from 'express';
import { requireTenantAdmin } from '../../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';
import * as repo from './settings-repository';
import { GovernedJevFlagSchema } from '../../services/tenant-provisioning/schemas';

const router = Router({ mergeParams: true });

// GET / — read settings
router.get('/', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;

    const { data, error } = await repo.fetchTenantSettings(supabase, tenantId);

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
//
// VTID-05150: feature_flags is MERGED server-side in one SQL statement
// (top-level keys; keys the client omits stay). The governed `jev` key
// (enabled, planes, monthly_budget_usd — the Jev budget) is ignored unless the
// caller is exafy_admin; the response lists ignored keys. Before migration
// 20261014000400 is applied the merge function does not exist, and the same
// merge (with the same jev guard) runs here instead.
const GOVERNED_FLAG_KEYS = ['jev'];

function isMissingFunction(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === 'PGRST202' || err.code === '42883' || /could not find the function/i.test(err.message || '');
}

router.put('/', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const { profile, branding, feature_flags, integrations, domains } = req.body;
    const isExafyAdmin = req.identity?.exafy_admin === true;

    if (feature_flags !== undefined && (feature_flags === null || typeof feature_flags !== 'object' || Array.isArray(feature_flags))) {
      return res.status(400).json({ ok: false, error: 'INVALID_FEATURE_FLAGS' });
    }
    // An exafy_admin may change the governed jev key, but only to a complete,
    // valid flag inside the provisioning budget bound — never an arbitrary object.
    if (isExafyAdmin && feature_flags !== undefined && Object.prototype.hasOwnProperty.call(feature_flags, 'jev')) {
      const jev = GovernedJevFlagSchema.safeParse(feature_flags.jev);
      if (!jev.success) {
        return res.status(400).json({ ok: false, error: 'INVALID_JEV_FLAG', details: jev.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
      }
    }

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
      updated_by: req.identity!.user_id,
    };
    if (profile !== undefined) updates.profile = profile;
    if (branding !== undefined) updates.branding = branding;
    if (integrations !== undefined) updates.integrations = integrations;
    if (domains !== undefined) updates.domains = domains;
    // billing is read-only from admin — not updatable via this endpoint

    const ignoredKeys = feature_flags !== undefined && !isExafyAdmin
      ? GOVERNED_FLAG_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(feature_flags, k))
      : [];

    let settings: unknown = null;
    const hasSections = Object.keys(updates).length > 2;
    if (hasSections || feature_flags === undefined) {
      const { data, error } = await repo.upsertTenantSettings(supabase, { tenant_id: tenantId, ...updates });
      if (error) return res.status(500).json({ ok: false, error: error.message });
      settings = data;
    }

    if (feature_flags !== undefined) {
      const merged = await repo.mergeTenantFeatureFlags(supabase, tenantId, feature_flags, isExafyAdmin, req.identity!.user_id);
      if (merged.error && isMissingFunction(merged.error)) {
        const current = await repo.fetchTenantSettings(supabase, tenantId);
        if (current.error && current.error.code !== 'PGRST116') return res.status(500).json({ ok: false, error: current.error.message });
        const clientFlags: Record<string, unknown> = { ...feature_flags };
        if (!isExafyAdmin) for (const k of GOVERNED_FLAG_KEYS) delete clientFlags[k];
        const stored = ((current.data as any)?.feature_flags ?? {}) as Record<string, unknown>;
        const { data, error } = await repo.upsertTenantSettings(supabase, {
          tenant_id: tenantId,
          feature_flags: { ...stored, ...clientFlags },
          updated_at: new Date().toISOString(),
          updated_by: req.identity!.user_id,
        });
        if (error) return res.status(500).json({ ok: false, error: error.message });
        settings = data;
      } else if (merged.error) {
        return res.status(500).json({ ok: false, error: merged.error.message });
      } else {
        settings = merged.data;
      }
    }

    return res.json({ ok: true, settings, ...(ignoredKeys.length ? { ignored_keys: ignoredKeys } : {}) });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
