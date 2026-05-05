export const PROVENANCE_SOURCES = [
  'user_stated',
  'user_stated_via_settings',
  'user_stated_via_memory_garden_ui',
  'user_stated_via_onboarding',
  'user_stated_via_baseline_survey',
  'admin_correction',
  'system_provision',
  'consolidator',
  'assistant_inferred'
] as const;

export type ProvenanceSource = typeof PROVENANCE_SOURCES[number];

export interface MemoryFactPayload {
  user_id: string;
  fact_key: string;
  fact_value: string;
  provenance_source?: ProvenanceSource;
}