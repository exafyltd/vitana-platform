/**
 * Preference facts — the single live source for user preferences.
 * (BOOTSTRAP-MEMORY-DAILY-LEARNING, 2026-07-05)
 *
 * The legacy pair of sources never matched the live schema: the real
 * `user_preferences` table is a wide app-settings row (autopilot/STT/TTS/AI
 * columns) with no category/preference_key/preference_value columns, and
 * `user_inferred_preferences` does not exist in production at all. Both
 * queries errored inside PostgREST and were silently swallowed, so no
 * preferences ever reached the assistant context.
 *
 * Preferences now come from `memory_facts` under the `user_preference_*`
 * fact-key prefix — rows the inline fact extractor already writes today via
 * the write_fact() RPC (auto-supersession, provenance tracking). This also
 * gives behavior-derived preferences a single destination: write a
 * `user_preference_*` fact and every consumer picks it up.
 *
 * Source mapping:
 *   provenance_source = 'user_stated'  → 'explicit' (always kept)
 *   anything else (assistant_inferred,
 *   behavior_inferred, …)              → 'inferred' (kept only at/above
 *                                         the 0.55 confidence floor)
 */

type SupabaseLike = { from: (table: string) => any };

export interface PreferenceFact {
  /** fact_key with the user_preference_ prefix stripped, e.g. 'exercise'. */
  key: string;
  value: string;
  source: 'explicit' | 'inferred';
  confidence: number;
}

export const PREFERENCE_FACT_KEY_PREFIX = 'user_preference_';
export const INFERRED_PREFERENCE_MIN_CONFIDENCE = 0.55;

export async function fetchPreferenceFacts(
  client: SupabaseLike,
  userId: string,
  opts: { tenantId?: string; limit?: number } = {},
): Promise<PreferenceFact[]> {
  if (!client || !userId) return [];
  const limit = opts.limit ?? 15;
  try {
    let query = client
      .from('memory_facts')
      .select('fact_key, fact_value, provenance_source, provenance_confidence, extracted_at')
      .eq('user_id', userId)
      .like('fact_key', `${PREFERENCE_FACT_KEY_PREFIX}%`)
      .is('superseded_at', null)
      .order('extracted_at', { ascending: false })
      .limit(Math.min(limit * 3, 60));
    if (opts.tenantId) query = query.eq('tenant_id', opts.tenantId);
    const { data, error } = await query;
    if (error || !Array.isArray(data)) return [];

    const out: PreferenceFact[] = [];
    const seen = new Set<string>();
    for (const row of data as any[]) {
      const rawKey = typeof row.fact_key === 'string' ? row.fact_key : '';
      const key = rawKey.startsWith(PREFERENCE_FACT_KEY_PREFIX)
        ? rawKey.slice(PREFERENCE_FACT_KEY_PREFIX.length)
        : '';
      if (!key || seen.has(key)) continue;
      // Newest row per key is authoritative (write_fact supersedes older
      // rows anyway) — never resurrect an older value for a skipped key.
      seen.add(key);
      const source: PreferenceFact['source'] =
        row.provenance_source === 'user_stated' ? 'explicit' : 'inferred';
      const confidence = Number(row.provenance_confidence ?? 0) || 0;
      if (source === 'inferred' && confidence < INFERRED_PREFERENCE_MIN_CONFIDENCE) continue;
      out.push({ key, value: String(row.fact_value ?? ''), source, confidence });
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}
