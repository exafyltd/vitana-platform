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

/**
 * E6 — surface-aware redaction. When `surface=find_a_partner` is present,
 * partner_seek rows are returned UNREDACTED (posting under Find a Partner
 * is implicit consent for that surface). The default `/intents/board`
 * surface keeps the existing redaction. Per-user `account_visibility`
 * overrides still win for any field a subject has marked private (E5).
 */
type Surface = 'default' | 'find_a_partner';

router.get('/', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const explicitKind = req.query.kind as string | undefined;
  const category = req.query.category as string | undefined;
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const surface: Surface = req.query.surface === 'find_a_partner' ? 'find_a_partner' : 'default';

  // Optional `categories` array (comma-separated). Each entry can be an
  // exact match (`activity_seek`) or a prefix glob (`dance.*`, `fitness.*`).
  const categoriesParam = req.query.categories as string | undefined;
  const categoryPrefixes: string[] = [];
  const categoryExacts: string[] = [];
  if (categoriesParam) {
    for (const raw of categoriesParam.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (raw.endsWith('.*')) {
        categoryPrefixes.push(raw.slice(0, -1)); // 'dance.*' → 'dance.'
      } else {
        categoryExacts.push(raw);
      }
    }
  }

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

  // For partner_seek on the default surface, only return rows when
  // explicitly requested. On the find_a_partner surface, include
  // partner_seek freely — posting there is implicit consent.
  if (kinds.includes('partner_seek') && surface === 'default') {
    if (!explicitKind || explicitKind !== 'partner_seek') {
      q = q.neq('intent_kind', 'partner_seek');
    }
  }

  if (category) {
    q = q.eq('category', category);
  } else if (categoryPrefixes.length > 0 || categoryExacts.length > 0) {
    // Build an OR clause: exact matches OR prefix LIKEs.
    const clauses: string[] = [];
    for (const exact of categoryExacts) clauses.push(`category.eq.${exact}`);
    for (const prefix of categoryPrefixes) clauses.push(`category.like.${prefix}%`);
    q = q.or(clauses.join(','));
  }

  const { data, error } = await q;
  if (error) return res.status(500).json({ ok: false, error: error.message });

  // Redaction: default surface redacts partner_seek; find_a_partner does not.
  const result = (data ?? []).map((row: any) => {
    if (row.intent_kind === 'partner_seek' && surface === 'default') {
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
    surface,
    intents: result,
  });
});

export default router;
