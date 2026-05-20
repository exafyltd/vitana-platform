/**
 * User Category Preferences API
 *
 * Endpoints:
 * - GET /    — Get user's notification categories with preference state
 * - PUT /:categoryId — Toggle a category on/off
 *
 * Security:
 * - All endpoints require Bearer token (standard user auth)
 */

import { Router, Request, Response } from 'express';
import {
  requireAuth,
  requireTenant,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { createClient } from '@supabase/supabase-js';
import { tt, type GatewayI18nKey } from '../i18n/catalog';
import { getUserLocale } from '../i18n/server-locale';

const router = Router();

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE!
  );
}

// ── GET / — Get categories with user preference state ───────

router.get('/', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();

  // Fetch all active categories (global + tenant-specific)
  const { data: categories, error: catError } = await supabase
    .from('notification_categories')
    .select('id, type, slug, display_name, description, icon, sort_order, default_enabled')
    .eq('is_active', true)
    .or(`tenant_id.eq.${identity.tenant_id},tenant_id.is.null`)
    .order('type')
    .order('sort_order', { ascending: true });

  if (catError) {
    console.error('[USER-CAT-PREFS] GET / categories error:', catError.message);
    return res.status(500).json({ ok: false, error: catError.message });
  }

  // Fetch user's existing preferences
  const { data: userPrefs, error: prefError } = await supabase
    .from('user_category_preferences')
    .select('category_id, enabled')
    .eq('user_id', identity.user_id)
    .eq('tenant_id', identity.tenant_id);

  if (prefError) {
    console.error('[USER-CAT-PREFS] GET / preferences error:', prefError.message);
    return res.status(500).json({ ok: false, error: prefError.message });
  }

  // Build a lookup map for user preferences
  const prefMap = new Map<string, boolean>();
  for (const pref of userPrefs || []) {
    prefMap.set(pref.category_id, pref.enabled);
  }

  // Resolve the user's preferred locale once. Used to translate
  // display_name + description for every category row. Falls back to DE.
  const locale = await getUserLocale(supabase, identity.user_id);

  // Group categories by type, merging in the user's preference state.
  // Translate display_name + description on the fly via the gateway catalog:
  //   notif.category.<type>.<slug>.{label,desc}
  // If the key is missing from the catalog, fall back to the DB literal so
  // newly-added categories never break the UI.
  const grouped: Record<string, any[]> = { chat: [], calendar: [], community: [] };
  for (const cat of categories || []) {
    const userPref = prefMap.get(cat.id);
    const enabled = userPref !== undefined ? userPref : cat.default_enabled;

    const labelKey = `notif.category.${cat.type}.${cat.slug}.label` as GatewayI18nKey;
    const descKey = `notif.category.${cat.type}.${cat.slug}.desc` as GatewayI18nKey;
    const translatedLabel = tt(labelKey, locale);
    const translatedDesc = tt(descKey, locale);

    const entry = {
      id: cat.id,
      slug: cat.slug,
      // If the catalog has no entry for this slug, `tt()` echoes the key
      // string back. In that case fall back to the original DB literal.
      display_name: translatedLabel === labelKey ? cat.display_name : translatedLabel,
      description: translatedDesc === descKey ? cat.description : translatedDesc,
      icon: cat.icon,
      enabled,
    };

    if (grouped[cat.type]) {
      grouped[cat.type].push(entry);
    }
  }

  return res.json({ ok: true, data: grouped });
});

// ── PUT /:categoryId — Toggle a category on/off ────────────

router.put('/:categoryId', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'enabled must be a boolean' });
  }

  const supabase = getSupabase();
  const categoryId = req.params.categoryId;

  // Verify the category exists and is active
  const { data: category, error: catError } = await supabase
    .from('notification_categories')
    .select('id')
    .eq('id', categoryId)
    .eq('is_active', true)
    .single();

  if (catError || !category) {
    return res.status(404).json({ ok: false, error: 'CATEGORY_NOT_FOUND' });
  }

  // Upsert the user's preference
  const { data, error } = await supabase
    .from('user_category_preferences')
    .upsert(
      {
        user_id: identity.user_id,
        tenant_id: identity.tenant_id,
        category_id: categoryId,
        enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,category_id' }
    )
    .select()
    .single();

  if (error) {
    console.error('[USER-CAT-PREFS] PUT /:categoryId error:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }

  return res.json({ ok: true, data });
});

export default router;
