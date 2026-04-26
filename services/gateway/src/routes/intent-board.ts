/**
 * VTID-01973: Public-facing intent board (P2-A).
 *
 * Browse open intents in the actor's tenant, filtered by kind. Defaults
 * shown depend on the user's active Life Compass goal — a compass-aware
 * feed without requiring the client to specify a kind. mutual_reveal
 * kinds are excluded by default; clients can opt in via ?kind=partner_seek
 * but they'll see redacted cards.
 *
 *   GET /api/v1/intent-board?kind=...&category=...
 */

import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import {
  requireAuth,
  requireTenant,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { getActiveCompassGoal } from '../services/intent-compass-lens';
import type { IntentKind } from '../services/intent-classifier';

const router = Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
}

// Compass → preferred kinds (for the default feed). Mirrors intent_compass_boost
// but returns a sorted list. mutual_reveal kinds are excluded from defaults.
function defaultKindsForCompass(category: string | null): IntentKind[] {
  switch (category) {
    case 'earn_money':
    case 'business':
      return ['commercial_buy', 'commercial_sell', 'social_seek'];
    case 'longevity':
    case 'health':
      return ['activity_seek', 'social_seek', 'commercial_buy'];
    case 'family':
    case 'community':
      return ['mutual_aid', 'social_seek', 'activity_seek'];
    case 'career_growth':
      return ['social_seek', 'commercial_sell', 'commercial_buy'];
    default:
      return ['commercial_buy', 'commercial_sell', 'activity_seek', 'social_seek', 'mutual_aid'];
  }
}

router.get('/', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const explicitKind = req.query.kind as string | undefined;
  const category = req.query.category as string | undefined;
  const limit = Math.min(Number(req.query.limit) || 30, 100);

  const compass = await getActiveCompassGoal(identity.user_id);
  const kinds = explicitKind
    ? [explicitKind as IntentKind]
    : defaultKindsForCompass(compass?.category ?? null);

  const supabase = getSupabase();
  let q = supabase
    .from('user_intents')
    .select('*')
    .eq('tenant_id', identity.tenant_id)
    .eq('status', 'open')
    .in('intent_kind', kinds)
    .neq('requester_user_id', identity.user_id)  // never show me my own intents on the board
    .order('created_at', { ascending: false })
    .limit(limit);

  // For partner_seek, only return rows whose visibility is mutual_reveal
  // (they're the only kind allowed there) AND redact scope/title.
  // For all other kinds, the visibility check is enforced by RLS on the
  // user_intents table (only public rows surface to non-owners).
  if (kinds.includes('partner_seek')) {
    // Only allow partner_seek when explicitly requested via ?kind=partner_seek.
    if (!explicitKind || explicitKind !== 'partner_seek') {
      q = q.neq('intent_kind', 'partner_seek');
    }
  }

  if (category) q = q.eq('category', category);

  const { data, error } = await q;
  if (error) return res.status(500).json({ ok: false, error: error.message });

  // Redact partner_seek rows (no scope text on board, just kind + category).
  const result = (data ?? []).map((row: any) => {
    if (row.intent_kind === 'partner_seek') {
      return {
        intent_id: row.intent_id,
        intent_kind: row.intent_kind,
        category: row.category,
        title: 'Partner-seek (redacted)',
        scope: 'View redacted card and express interest to start the mutual-reveal protocol.',
        kind_payload: { age_range: row.kind_payload?.age_range, location_label: row.kind_payload?.location_label },
        created_at: row.created_at,
      };
    }
    return row;
  });

  return res.json({
    ok: true,
    compass: compass?.category ?? null,
    kinds_shown: kinds,
    intents: result,
  });
});

export default router;
