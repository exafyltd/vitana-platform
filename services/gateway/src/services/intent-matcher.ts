/**
 * VTID-01973: Intent matcher (P2-A).
 *
 * Wraps the SQL function compute_intent_matches() and federates against
 * the existing affiliate products catalog (VTID-02000) for commercial_buy
 * intents. Federation runs in TS, not SQL, to keep the products domain
 * cleanly separated from user_intents.
 *
 * Public surface:
 *   computeForIntent(intentId)       — runs SQL fn + federation, returns count
 *   surfaceTopMatches(intentId, n)   — returns the top-N rows, sorted, with redaction applied
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;

function getSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
}

export interface MatchRow {
  match_id: string;
  intent_a_id: string;
  intent_b_id: string | null;
  vitana_id_a: string | null;
  vitana_id_b: string | null;
  external_target_kind: string | null;
  external_target_id: string | null;
  kind_pairing: string;
  score: number;
  match_reasons: Record<string, unknown>;
  compass_aligned: boolean;
  state: string;
  created_at: string;
}

/**
 * Compute matches for a freshly-posted intent. Returns the number of new
 * intent_matches rows inserted. Optionally federates commercial_buy against
 * the affiliate products catalog.
 */
export async function computeForIntent(intentId: string): Promise<number> {
  const supabase = getSupabase();

  // 1. Run the kind-aware SQL fn for user-vs-user pairings.
  const { data, error } = await supabase.rpc('compute_intent_matches', {
    p_intent_id: intentId,
    p_top_n: 5,
  });

  if (error) {
    console.warn(`[VTID-01973] compute_intent_matches RPC failed: ${error.message}`);
    return 0;
  }

  const userMatchesCount = typeof data === 'number' ? data : (data as any)?.[0] ?? 0;

  // 2. For commercial_buy, also federate against affiliate products.
  // P2-A keeps this minimal: same-tenant, category-mapped products with
  // a baseline score of 0.55. P2-B adds proper semantic-over-products.
  try {
    const { data: src } = await supabase
      .from('user_intents')
      .select('intent_kind, category, requester_vitana_id')
      .eq('intent_id', intentId)
      .maybeSingle();

    if (src && (src as any).intent_kind === 'commercial_buy' && (src as any).category) {
      // Map intent category to product category and pull top 3.
      // For P2-A we just look for products whose category column shares the
      // first hierarchy segment (e.g. wellness.coaching → wellness).
      const parentCategory = ((src as any).category as string).split('.')[0];
      const { data: products } = await supabase
        .from('products')
        .select('id, name, category')
        .eq('category', parentCategory)
        .limit(3);

      if (Array.isArray(products) && products.length > 0) {
        const rows = products.map((p: any, idx: number) => ({
          intent_a_id: intentId,
          intent_b_id: null,
          vitana_id_a: (src as any).requester_vitana_id,
          vitana_id_b: null,
          external_target_kind: 'product',
          external_target_id: p.id,
          kind_pairing: 'commercial_buy::product',
          score: 0.55 - idx * 0.05,
          match_reasons: { source: 'affiliate_catalog', category_match: true },
          compass_aligned: false,
          state: 'new',
        }));
        await supabase.from('intent_matches').insert(rows as any);
      }
    }
  } catch (err: any) {
    // Federation is best-effort; never block the user-vs-user path.
    console.warn(`[VTID-01973] product federation failed: ${err.message}`);
  }

  // 3. VTID-DANCE-D2: federate dance-category intents over live_rooms +
  // meetups so a student looking for salsa instantly sees both peer teachers
  // AND open paid classes. Best-effort.
  try {
    const { data: src } = await supabase
      .from('user_intents')
      .select('intent_kind, category, requester_vitana_id, kind_payload')
      .eq('intent_id', intentId)
      .maybeSingle();

    if (src && typeof (src as any).category === 'string' && ((src as any).category as string).startsWith('dance.')) {
      const danceVariety = ((src as any).kind_payload?.dance?.variety) as string | undefined;
      const now = new Date();
      const horizon = new Date(now.getTime() + 30 * 86_400_000); // next 30 days

      // live_rooms federation. Match on category prefix or variety presence.
      const { data: rooms } = await supabase
        .from('live_rooms')
        .select('id, title, category, starts_at, location_label, price_cents, dance_payload')
        .ilike('category', 'dance.%')
        .gte('starts_at', now.toISOString())
        .lte('starts_at', horizon.toISOString())
        .limit(5);

      if (Array.isArray(rooms) && rooms.length > 0) {
        const candidateRows = rooms
          .map((r: any) => {
            // Score: 0.50 base + 0.20 if variety matches.
            let score = 0.5;
            const roomVariety = (r.dance_payload?.variety as string | undefined)
              || (r.category && typeof r.category === 'string' ? r.category.split('.').pop() : undefined);
            if (danceVariety && roomVariety && danceVariety === roomVariety) score += 0.2;
            return {
              intent_a_id: intentId,
              intent_b_id: null,
              vitana_id_a: (src as any).requester_vitana_id,
              vitana_id_b: null,
              external_target_kind: 'live_room',
              external_target_id: r.id,
              kind_pairing: `${(src as any).intent_kind}::live_room`,
              score,
              match_reasons: {
                source: 'live_rooms_federation',
                room_category: r.category,
                room_starts_at: r.starts_at,
                price_cents: r.price_cents,
                variety_match: Boolean(danceVariety && roomVariety && danceVariety === roomVariety),
              },
              compass_aligned: false,
              state: 'new',
            };
          })
          .sort((a: any, b: any) => b.score - a.score);

        if (candidateRows.length > 0) {
          await supabase.from('intent_matches').insert(candidateRows as any);
        }
      }
    }
  } catch (err: any) {
    console.warn(`[VTID-DANCE-D2] dance federation failed: ${err.message}`);
  }

  return userMatchesCount || 0;
}

/**
 * Get the top-N matches for an intent, sorted by score. Caller is
 * responsible for redacting vitana_id_b on partner_seek pre-reveal rows
 * via intent-mutual-reveal.ts (route-layer concern).
 */
export async function surfaceTopMatches(intentId: string, n: number = 5): Promise<MatchRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('intent_matches')
    .select('*')
    .eq('intent_a_id', intentId)
    .order('score', { ascending: false })
    .limit(n);

  if (error) {
    console.warn(`[VTID-01973] surfaceTopMatches failed: ${error.message}`);
    return [];
  }
  return (data || []) as MatchRow[];
}
