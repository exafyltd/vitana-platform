import { getSupabase } from '../lib/supabase';
import { ProvenanceSource } from '../types/memory-facts';

export async function upsertMemoryFact(
  userId: string,
  factKey: string,
  factValue: string,
  provenanceSource: ProvenanceSource = 'user_stated'
): Promise<{ ok: boolean; error?: string }> {
  const supabase = getSupabase();
  if (!supabase) {
    return { ok: false, error: 'no supabase' };
  }

  const { error } = await supabase
    .from('memory_facts')
    .upsert(
      {
        user_id: userId,
        fact_key: factKey,
        fact_value: factValue,
        provenance_source: provenanceSource,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id, fact_key' }
    );

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true };
}