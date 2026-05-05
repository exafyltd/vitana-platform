export const PROVENANCE_SOURCES = [
  'user_stated',
  'user_stated_via_settings',
  'user_stated_via_memory_garden_ui',
  'admin_correction',
  'user_stated_via_onboarding',
  'user_stated_via_baseline_survey',
  'system_provision',
  'assistant_inferred'
] as const;

export type ProvenanceSource = typeof PROVENANCE_SOURCES[number];

export interface MemoryFact {
  id: string;
  user_id: string;
  fact_key: string;
  fact_value: string;
  provenance_source: ProvenanceSource;
  created_at: string;
  updated_at: string;
}