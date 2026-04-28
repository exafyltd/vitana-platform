/**
 * VTID-DANCE-D11.B: Pre-post candidate scan.
 *
 * Before a user posts a fresh intent, ORB / clients can call this to see
 * what already exists in the catalog. Cheap query — no Gemini, just a SQL
 * read across user_intents + intent_compatibility + profile.dance_preferences.
 *
 *   GET /api/v1/intent-scan?intent_kind=&category_prefix=&variety=
 *
 * Returns up to 5 open compatible intents + up to 5 dance-pref community
 * members that match. Powers the voice readback "Before I post, I see N
 * people already looking for this — want to see them?"
 */

import { Router, Request, Response } from 'express';
import { requireAuth, requireTenant, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';

const router = Router();

router.get('/intent-scan', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const intentKind = String(req.query.intent_kind || '').trim();
  const categoryPrefix = req.query.category_prefix ? String(req.query.category_prefix).trim() : null;
  const variety = req.query.variety ? String(req.query.variety).toLowerCase().trim() : null;

  if (!intentKind) {
    return res.status(400).json({ ok: false, error: 'INTENT_KIND_REQUIRED' });
  }

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'supabase_unavailable' });

  // 1. Compatible kinds for this kind.
  const { data: compatRows } = await supabase
    .from('intent_compatibility')
    .select('kind_b')
    .eq('kind_a', intentKind);
  const compatibleKinds: string[] = ((compatRows as any[]) || []).map((r) => r.kind_b);
  if (compatibleKinds.length === 0) compatibleKinds.push(intentKind);

  // 2. Open compatible intents.
  let intentQ = supabase
    .from('user_intents')
    .select('intent_id, requester_vitana_id, intent_kind, category, title, scope, kind_payload, created_at')
    .in('intent_kind', compatibleKinds)
    .in('status', ['open', 'matched', 'engaged'])
    .neq('requester_user_id', identity.user_id)
    .order('created_at', { ascending: false })
    .limit(5);

  if (categoryPrefix) intentQ = intentQ.like('category', `${categoryPrefix}%`);

  const { data: intents } = await intentQ;
  let intentsList = ((intents as any[]) || []);

  // Variety filter applied in TS so we can match either kind_payload.dance.variety OR category suffix.
  if (variety) {
    intentsList = intentsList.filter((i) => {
      const v = i.kind_payload?.dance?.variety;
      return v === variety || (typeof i.category === 'string' && i.category.endsWith(`.${variety}`));
    });
  }

  // 3. Dance-pref community members (when this is a dance scan).
  let memberMatches: any[] = [];
  if (categoryPrefix?.startsWith('dance.') || variety) {
    const { data: profs } = await supabase
      .from('profiles')
      .select('user_id, vitana_id, display_name, city, dance_preferences')
      .neq('user_id', identity.user_id)
      .not('dance_preferences', 'eq', '{}')
      .limit(20);
    memberMatches = ((profs as any[]) || []).filter((p) => {
      const v = p.dance_preferences?.varieties;
      if (!Array.isArray(v) || v.length === 0) return false;
      if (!variety) return true;
      return v.map((s: any) => String(s).toLowerCase()).includes(variety);
    }).slice(0, 5);
  }

  return res.json({
    ok: true,
    open_intents: intentsList.map((i) => ({
      intent_id: i.intent_id,
      requester_vitana_id: i.requester_vitana_id,
      intent_kind: i.intent_kind,
      category: i.category,
      title: i.title,
      scope_excerpt: String(i.scope || '').slice(0, 200),
      dance_variety: i.kind_payload?.dance?.variety ?? null,
      created_at: i.created_at,
    })),
    dance_pref_members: memberMatches.map((p) => ({
      vitana_id: p.vitana_id,
      display_name: p.display_name,
      city: p.city,
      varieties: p.dance_preferences?.varieties ?? [],
    })),
    total: intentsList.length + memberMatches.length,
  });
});

export default router;
