import type { SupabaseClient } from '@supabase/supabase-js';

export interface CatalogRow {
  id: string;
  tenant_id: string;
  user_id: string;
  tier: 'own' | 'vetted_partner' | 'affiliate_network';
  category: string;
  title: string;
  description: string | null;
  affiliate_url: string;
  affiliate_network: string | null;
  commission_percent: number | null;
  personal_note: string | null;
  vetting_status: 'unvetted' | 'tried' | 'endorsed';
}

export interface MatchInput {
  tenant_id: string;
  user_id: string;
  topics: string[];
}

export interface MatchResult {
  item: CatalogRow;
  score: number;
  reason: string;
}

const TIER_WEIGHT: Record<CatalogRow['tier'], number> = {
  own: 1.0,
  vetted_partner: 0.75,
  affiliate_network: 0.5,
};

const VETTING_WEIGHT: Record<CatalogRow['vetting_status'], number> = {
  endorsed: 1.0,
  tried: 0.8,
  unvetted: 0.5,
};

export async function matchCatalog(
  supabase: SupabaseClient,
  input: MatchInput,
): Promise<MatchResult[]> {
  const { data, error } = await supabase
    .from('vaea_referral_catalog')
    .select('id, tenant_id, user_id, tier, category, title, description, affiliate_url, affiliate_network, commission_percent, personal_note, vetting_status')
    .eq('tenant_id', input.tenant_id)
    .eq('user_id', input.user_id)
    .eq('active', true);

  if (error) {
    throw new Error(`catalog fetch failed: ${error.message}`);
  }

  const rows = (data || []) as CatalogRow[];
  if (rows.length === 0) return [];

  const topicsLower = input.topics.map((t) => t.toLowerCase());

  const scored: MatchResult[] = rows.map((item) => {
    const haystack = [
      item.category.toLowerCase(),
      item.title.toLowerCase(),
      (item.description || '').toLowerCase(),
    ].join(' ');

    let hits = 0;
    const matchedTopics: string[] = [];
    for (const t of topicsLower) {
      if (haystack.includes(t)) {
        hits += 1;
        matchedTopics.push(t);
      }
    }
    const topicScore = topicsLower.length === 0 ? 0 : Math.min(1, hits / Math.max(1, topicsLower.length));

    const score = Number(
      (topicScore * 0.6 + TIER_WEIGHT[item.tier] * 0.25 + VETTING_WEIGHT[item.vetting_status] * 0.15).toFixed(2),
    );

    const reason = hits > 0
      ? `matched topics: ${matchedTopics.join(', ')} · tier=${item.tier} · vetting=${item.vetting_status}`
      : `no topic overlap · tier=${item.tier} · vetting=${item.vetting_status}`;

    return { item, score, reason };
  });

  return scored.filter((m) => m.score > 0.2).sort((a, b) => b.score - a.score);
}
