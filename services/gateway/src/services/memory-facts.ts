import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../lib/supabase';
import { ProvenanceSource, MemoryFact } from '../types/memory-facts';

export async function upsertMemoryFact(
  userId: string,
  factKey: string,
  factValue: string,
  provenanceSource: ProvenanceSource = 'user_stated',
  supabaseClient?: SupabaseClient
): Promise<{ ok: boolean; data?: MemoryFact; error?: string }> {
  const supabase = supabaseClient ?? getSupabase();
  if (!supabase) {
    return { ok: false, error: 'no supabase' };
  }

  const { data, error } = await supabase
    .from('memory_facts')
    .upsert(
      {
        user_id: userId,
        fact_key: factKey,
        fact_value: factValue,
        provenance_source: provenanceSource,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id, fact_key' }
    )
    .select()
    .single();

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true, data };
}