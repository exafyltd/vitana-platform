/**
 * E2 — partner_preferences + service_offerings PATCH endpoints.
 *
 * Self-only writes to profiles.{partner_preferences, service_offerings}
 * jsonb columns introduced in 20260507000200_profile_partner_service_offerings.sql.
 * Visibility on the public profile page is gated separately by E5
 * (account_visibility). These endpoints just persist the data; the
 * visibility default for partner_preferences is private.
 */

import { Router, Request, Response } from 'express';
import { requireAuth, requireTenant, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

interface PartnerPreferences {
  gender_pref?: 'female' | 'male' | 'any';
  age_range?: [number, number];
  max_radius_km?: number;
  location_label?: string;
  relationship_intent?: 'dating' | 'life_partner' | 'companionship' | 'open';
  must_haves?: string[];
  deal_breakers?: string[];
}

interface ServiceOffering {
  category: string;
  title: string;
  short_description?: string;
  price_min_cents?: number;
  price_max_cents?: number;
  currency?: string;
  contact_via?: 'message' | 'profile';
}

interface ServiceOfferings {
  offers?: ServiceOffering[];
}

function sanitizePartnerPrefs(input: any): PartnerPreferences {
  const out: PartnerPreferences = {};
  if (input?.gender_pref && ['female', 'male', 'any'].includes(input.gender_pref)) {
    out.gender_pref = input.gender_pref;
  }
  if (Array.isArray(input?.age_range) && input.age_range.length === 2) {
    const [lo, hi] = input.age_range.map((n: any) => Number(n));
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi >= lo && hi <= 120) {
      out.age_range = [lo, hi];
    }
  }
  if (Number.isFinite(input?.max_radius_km) && input.max_radius_km >= 0 && input.max_radius_km <= 20000) {
    out.max_radius_km = Number(input.max_radius_km);
  }
  if (typeof input?.location_label === 'string' && input.location_label.length <= 200) {
    out.location_label = input.location_label;
  }
  if (input?.relationship_intent && ['dating', 'life_partner', 'companionship', 'open'].includes(input.relationship_intent)) {
    out.relationship_intent = input.relationship_intent;
  }
  if (Array.isArray(input?.must_haves)) {
    out.must_haves = input.must_haves.filter((s: any) => typeof s === 'string' && s.length <= 100).slice(0, 10);
  }
  if (Array.isArray(input?.deal_breakers)) {
    out.deal_breakers = input.deal_breakers.filter((s: any) => typeof s === 'string' && s.length <= 100).slice(0, 10);
  }
  return out;
}

function sanitizeServiceOfferings(input: any): ServiceOfferings {
  if (!Array.isArray(input?.offers)) return { offers: [] };
  const offers: ServiceOffering[] = input.offers
    .map((raw: any): ServiceOffering | null => {
      if (typeof raw?.category !== 'string' || typeof raw?.title !== 'string') return null;
      const o: ServiceOffering = {
        category: raw.category.slice(0, 100),
        title: raw.title.slice(0, 140),
      };
      if (typeof raw.short_description === 'string') o.short_description = raw.short_description.slice(0, 500);
      if (Number.isFinite(raw.price_min_cents) && raw.price_min_cents >= 0) o.price_min_cents = Number(raw.price_min_cents);
      if (Number.isFinite(raw.price_max_cents) && raw.price_max_cents >= 0) o.price_max_cents = Number(raw.price_max_cents);
      if (typeof raw.currency === 'string' && raw.currency.length <= 5) o.currency = raw.currency.toUpperCase();
      if (raw.contact_via === 'message' || raw.contact_via === 'profile') o.contact_via = raw.contact_via;
      return o;
    })
    .filter((o: ServiceOffering | null): o is ServiceOffering => o !== null)
    .slice(0, 20);
  return { offers };
}

async function patchProfileColumn(
  res: Response,
  req: Request,
  column: 'partner_preferences' | 'service_offerings',
  payload: any,
  topic: string,
) {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'supabase_unavailable' });

  const { data, error } = await supabase
    .from('profiles')
    .update({ [column]: payload })
    .eq('user_id', identity.user_id)
    .select(column)
    .single();

  if (error) {
    console.error('[E2] profile-prefs update failed', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  // Best-effort audit. Don't block the response on OASIS.
  try {
    await emitOasisEvent({
      vtid: 'VTID-02607',
      type: topic as any,
      source: 'profile-prefs',
      status: 'info',
      message: `${column} updated`,
      payload: { user_id: identity.user_id },
      actor_id: identity.user_id,
      actor_role: 'user',
      surface: 'api',
      vitana_id: identity.vitana_id ?? undefined,
    });
  } catch { /* best-effort */ }

  return res.json({ ok: true, [column]: (data as any)?.[column] ?? payload });
}

router.patch('/profiles/me/partner-preferences', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const sanitized = sanitizePartnerPrefs(req.body);
  return patchProfileColumn(res, req, 'partner_preferences', sanitized, 'profile.partner_preferences.updated');
});

router.patch('/profiles/me/service-offerings', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const sanitized = sanitizeServiceOfferings(req.body);
  return patchProfileColumn(res, req, 'service_offerings', sanitized, 'profile.service_offerings.updated');
});

router.get('/profiles/me/prefs', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'supabase_unavailable' });

  const { data, error } = await supabase
    .from('profiles')
    .select('partner_preferences, service_offerings, account_visibility')
    .eq('user_id', identity.user_id)
    .single();

  if (error) return res.status(500).json({ ok: false, error: error.message });

  return res.json({
    ok: true,
    partner_preferences: (data as any)?.partner_preferences ?? {},
    service_offerings: (data as any)?.service_offerings ?? {},
    account_visibility: (data as any)?.account_visibility ?? {},
  });
});

export default router;
