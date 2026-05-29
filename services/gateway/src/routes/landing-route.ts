/**
 * VTID-03152 — Slice J: GET /api/v1/landing-route resolver.
 *
 * Backend resolver for the post-login default route. Returns:
 *   { route: string, reason: string, feature_flag_enabled: boolean }
 *
 * Today's behaviour: post-login lands on Events & Meetups.
 * Target behaviour (when the feature flag is on): community users in
 * the active-journey window land on /my-journey.
 *
 * The frontend reads this endpoint on the login redirect and routes
 * accordingly. While the feature flag is OFF (default), the resolver
 * always returns the legacy route — so deploying this code is safe
 * and doesn't change user-visible behaviour until the flag flips.
 *
 * Carve-outs (encoded here, not in the frontend):
 *   - Non-community roles (admin / professional / developer) → unchanged
 *     role-specific landing.
 *   - Journey complete (is_past_total_days and not renewed) → legacy
 *     route until the completion-flow slice ships.
 *   - Journey paused → /my-journey (so the user sees the resume affordance).
 *   - Active community journey → /my-journey.
 *
 * Deep-link override is the FRONTEND's responsibility: when a URL or
 * notification deep-links to a specific surface, the frontend must
 * respect the link and skip the resolver entirely. The resolver only
 * decides the *default* destination when no deep-link is present.
 */

import { Router, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getJourneyState } from '../services/journey/user-journey-service';

const router = Router();

const VTID = 'VTID-03152';
const LEGACY_ROUTE = '/events';
const JOURNEY_ROUTE = '/my-journey';

function getServiceClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function flagEnabled(): boolean {
  const raw = (process.env.LANDING_ROUTE_TO_MY_JOURNEY_ENABLED ?? '').toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

async function getActiveRole(client: SupabaseClient, userId: string): Promise<string | null> {
  try {
    const { data } = await client
      .from('user_tenants')
      .select('active_role, is_primary')
      .eq('user_id', userId)
      .order('is_primary', { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data?.active_role as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * GET /api/v1/landing-route
 *
 * Auth: requires user JWT. Returns the post-login default route for the
 * authenticated user, with a `reason` explaining the decision.
 */
router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  }

  const flag = flagEnabled();

  // When the flag is off, never change behaviour — always return legacy.
  if (!flag) {
    return res.status(200).json({
      ok: true,
      vtid: VTID,
      route: LEGACY_ROUTE,
      reason: 'feature_flag_off',
      feature_flag_enabled: false,
    });
  }

  const client = getServiceClient();
  if (!client) {
    return res.status(200).json({
      ok: true,
      vtid: VTID,
      route: LEGACY_ROUTE,
      reason: 'supabase_unavailable_fallback',
      feature_flag_enabled: true,
    });
  }

  try {
    const role = await getActiveRole(client, userId);

    // Non-community roles keep their existing landing.
    if (role && role !== 'community') {
      return res.status(200).json({
        ok: true,
        vtid: VTID,
        route: LEGACY_ROUTE,
        reason: `role_not_community:${role}`,
        feature_flag_enabled: true,
      });
    }

    const journey = await getJourneyState(client, userId);

    // No journey state at all (very rare — backfill + ensure should cover
    // everyone). Conservative fallback to legacy.
    if (!journey) {
      return res.status(200).json({
        ok: true,
        vtid: VTID,
        route: LEGACY_ROUTE,
        reason: 'no_journey_state',
        feature_flag_enabled: true,
      });
    }

    // Journey complete and not renewed — legacy until the completion flow
    // ships.
    if (journey.status === 'complete' || journey.is_past_total_days) {
      return res.status(200).json({
        ok: true,
        vtid: VTID,
        route: LEGACY_ROUTE,
        reason: 'journey_past_total_days_or_complete',
        feature_flag_enabled: true,
      });
    }

    // Active or paused journey in the window → My Journey.
    return res.status(200).json({
      ok: true,
      vtid: VTID,
      route: JOURNEY_ROUTE,
      reason: `journey_${journey.status}`,
      feature_flag_enabled: true,
    });
  } catch (err: any) {
    console.error('[VTID-03152] GET /landing-route unexpected:', err.message);
    return res.status(200).json({
      ok: true,
      vtid: VTID,
      route: LEGACY_ROUTE,
      reason: 'resolver_error_fallback',
      feature_flag_enabled: true,
      error: err.message,
    });
  }
});

export default router;
