import type { SupabaseClient } from '@supabase/supabase-js';
import { ProvenanceSource, MemoryFact } from '../types/memory-facts';

export async function upsertMemoryFact(
  supabase: SupabaseClient,
  params: {
    userId: string;
    tenantId: string;
    factType: string;
    factValue: string;
    provenanceSource?: ProvenanceSource;
  }
): Promise<{ ok: boolean; data?: MemoryFact; error?: string }> {
  const provenance = params.provenanceSource || 'user_stated';

  const { data, error } = await supabase
    .from('memory_facts')
    .upsert({
      user_id: params.userId,
      tenant_id: params.tenantId,
      fact_type: params.factType,
      fact_value: params.factValue,
      provenance_source: provenance,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'user_id,tenant_id,fact_type'
    })
    .select()
    .single();

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true, data };
}