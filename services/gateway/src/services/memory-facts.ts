import type { SupabaseClient } from '@supabase/supabase-js';
import { ProvenanceSource, MemoryFact } from '../types/memory-facts';
import * as repo from './memory-facts-repository';

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

  const { data, error } = await repo.upsertMemoryFactRow(supabase, {
    user_id: params.userId,
    tenant_id: params.tenantId,
    fact_type: params.factType,
    fact_value: params.factValue,
    provenance_source: provenance,
    updated_at: new Date().toISOString()
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true, data };
}