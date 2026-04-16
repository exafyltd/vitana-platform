/**
 * VTID-02000: Wearables waitlist — Phase 0 stub endpoint.
 *
 * Replaces the lying "Connected" badges on the placeholder wearable tiles
 * with an honest "Notify me when live" flow. Users signal interest per
 * provider; Phase 1 (Terra + iOS companion) emails them when that provider
 * goes live.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getSupabase } from '../lib/supabase';
import * as jose from 'jose';

const router = Router();

const WaitlistSignupSchema = z.object({
  provider: z.enum([
    'apple_health',
    'fitbit',
    'oura',
    'garmin',
    'whoop',
    'google_fit',
    'samsung_health',
    'strava',
    'myfitnesspal',
  ]),
  notify_via: z.enum(['email', 'push', 'in_app']).default('email'),
});

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

router.post('/', async (req: Request, res: Response) => {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const parsed = WaitlistSignupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'Validation failed', details: parsed.error.flatten() });
  }

  const tenantId = user.tenant_id ?? (await resolveTenantId(user.user_id, supabase));
  if (!tenantId) return res.status(400).json({ ok: false, error: 'Tenant not found for user' });

  const { data, error } = await supabase
    .from('wearable_waitlist')
    .upsert(
      {
        user_id: user.user_id,
        tenant_id: tenantId,
        provider: parsed.data.provider,
        notify_via: parsed.data.notify_via,
      },
      { onConflict: 'user_id,provider' }
    )
    .select('*')
    .single();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, waitlist_entry: data });
});

router.get('/', async (req: Request, res: Response) => {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { data, error } = await supabase
    .from('wearable_waitlist')
    .select('provider, created_at, notified_at, notify_via')
    .eq('user_id', user.user_id);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, entries: data ?? [] });
});

router.delete('/:provider', async (req: Request, res: Response) => {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { error } = await supabase
    .from('wearable_waitlist')
    .delete()
    .eq('user_id', user.user_id)
    .eq('provider', req.params.provider);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

export default router;
