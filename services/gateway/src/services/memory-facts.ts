import { SupabaseClient } from '@supabase/supabase-js';
import { ProvenanceSource } from '../types/memory-facts';

export interface WriteMemoryFactParams {
  userId: string;
  tenantId: string;
  factKey: string;
  factValue: string;
  provenanceSource?: ProvenanceSource;
}

export async function writeMemoryFact(
  supabase: SupabaseClient,
  params: WriteMemoryFactParams
): Promise<{ ok: boolean; error?: string }> {
  const {
    userId,
    tenantId,
    factKey,
    factValue,
    provenanceSource = 'user_stated'
  } = params;

  const { error } = await supabase
    .from('memory_facts')
    .upsert({
      user_id: userId,
      tenant_id: tenantId,
      fact_key: factKey,
      fact_value: factValue,
      provenance_source: provenanceSource,
    }, {
      onConflict: 'user_id, fact_key'
    });

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true };
}