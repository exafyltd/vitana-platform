export type ProvenanceSource =
  | 'user_stated'
  | 'user_stated_via_settings'
  | 'user_stated_via_memory_garden_ui'
  | 'user_stated_via_onboarding'
  | 'user_stated_via_baseline_survey'
  | 'admin_correction'
  | 'system_provision'
  | 'assistant_inferred'
  | 'consolidator';

export interface MemoryFact {
  id: string;
  user_id: string;
  tenant_id: string;
  fact_type: string;
  fact_value: string;
  provenance_source: ProvenanceSource;
  created_at?: string;
  updated_at?: string;
}