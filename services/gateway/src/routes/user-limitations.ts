/**
 * VTID-02000: User limitations routes — /api/v1/user/limitations/*
 *
 * User-facing CRUD for `user_limitations` + a live impact counter for the
 * /ecosystem/preferences page.
 *
 * Auth: user JWT (Bearer).
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getSupabase } from '../lib/supabase';
import { invalidateUserHealthContext } from '../services/user-health-context';
import { emitPreferencesUpdated } from '../services/reward-events';
import * as jose from 'jose';

const router = Router();

function getUserFromReq(req: Request): { user_id: string; tenant_id: string | null } | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    const claims = jose.decodeJwt(token);
    const user_id = typeof claims.sub === 'string' ? claims.sub : null;
    if (!user_id) return null;
    const app_metadata = (claims as { app_metadata?: { active_tenant_id?: string } }).app_metadata;
    const tenant_id = app_metadata?.active_tenant_id ?? null;
    return { user_id, tenant_id };
  } catch {
    return null;
  }
}

// ==================== GET /user/limitations ====================

router.get('/', async (req: Request, res: Response) => {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { data, error } = await supabase
    .from('user_limitations')
    .select('*')
    .eq('user_id', user.user_id)
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });

  // Return existing row or a baseline empty row shape so the UI can render
  if (data) return res.json({ ok: true, limitations: data });
  return res.json({
    ok: true,
    limitations: {
      user_id: user.user_id,
      tenant_id: user.tenant_id,
      allergies: [],
      dietary_restrictions: [],
      contraindications: [],
      current_medications: [],
      pregnancy_status: null,
      age_bracket: null,
      religious_restrictions: [],
      ingredient_sensitivities: [],
      physical_accessibility_needs: [],
      budget_max_per_product_cents: null,
      budget_monthly_cap_cents: null,
      budget_preferred_band: null,
      user_set_fields: {},
      field_last_verified: {},
    },
  });
});

// ==================== PATCH /user/limitations ====================

const UpdateLimitationsSchema = z.object({
  allergies: z.array(z.string()).optional(),
  dietary_restrictions: z.array(z.string()).optional(),
  contraindications: z.array(z.string()).optional(),
  current_medications: z.array(z.string()).optional(),
  pregnancy_status: z.enum(['not_pregnant', 'pregnant', 'nursing', 'prefer_not_say', 'unknown']).optional(),
  age_bracket: z.enum(['child', 'teen', 'adult', 'senior']).optional(),
  religious_restrictions: z.array(z.string()).optional(),
  ingredient_sensitivities: z.array(z.string()).optional(),
  physical_accessibility_needs: z.array(z.string()).optional(),
  budget_max_per_product_cents: z.number().int().min(0).nullable().optional(),
  budget_monthly_cap_cents: z.number().int().min(0).nullable().optional(),
  budget_preferred_band: z.enum(['budget', 'mid', 'premium', 'any']).nullable().optional(),
});

router.patch('/', async (req: Request, res: Response) => {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const parsed = UpdateLimitationsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: parsed.error.flatten(),
    });
  }
  const fields = parsed.data;
  const changedFields = Object.keys(fields);
  if (changedFields.length === 0) return res.status(400).json({ ok: false, error: 'No fields to update' });

  const now = new Date().toISOString();
  // Load existing for field_last_verified merge
  const { data: existing } = await supabase
    .from('user_limitations')
    .select('user_set_fields, field_last_verified')
    .eq('user_id', user.user_id)
    .maybeSingle();

  const user_set_fields: Record<string, boolean> = (existing?.user_set_fields as Record<string, boolean>) ?? {};
  const field_last_verified: Record<string, string> = (existing?.field_last_verified as Record<string, string>) ?? {};
  for (const f of changedFields) {
    user_set_fields[f] = true;
    field_last_verified[f] = now;
  }

  const tenantId = user.tenant_id ?? (await resolveTenantId(user.user_id, supabase));
  if (!tenantId) return res.status(400).json({ ok: false, error: 'Tenant not found for user' });

  const payload = {
    user_id: user.user_id,
    tenant_id: tenantId,
    ...fields,
    user_set_fields,
    field_last_verified,
    updated_at: now,
  };

  const { data, error } = await supabase
    .from('user_limitations')
    .upsert(payload, { onConflict: 'user_id' })
    .select('*')
    .single();
  if (error) return res.status(500).json({ ok: false, error: error.message });

  invalidateUserHealthContext(user.user_id);

  // Emit preferences-updated event for reward system
  emitPreferencesUpdated({
    user_id: user.user_id,
    tenant_id: tenantId,
    fields_changed: changedFields,
    source: 'preferences_page',
  }).catch(() => {});

  res.json({ ok: true, limitations: data });
});

// ==================== GET /user/limitations/impact ====================

router.get('/impact', async (req: Request, res: Response) => {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { data, error } = await supabase.rpc('get_user_limitations_impact', { p_user_id: user.user_id });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json(data ?? { ok: true });
});

// ==================== Helper ====================

async function resolveTenantId(userId: string, supabase: ReturnType<typeof getSupabase>): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase
    .from('user_tenants')
    .select('tenant_id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  return data?.tenant_id ?? null;
}

export default router;
