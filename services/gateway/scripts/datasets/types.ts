/**
 * Dataset extraction types — Phase 1 W1 (VTID-03178 DATASETS).
 *
 * Three datasets target the three Phase 1 fine-tunes:
 *   - voice-tool-routing: (user_input, tool_chosen) pairs for the voice tool
 *     router fine-tune (Gemma-2 2B LoRA — first to train in W1)
 *   - intent-kind: (signal_text, intent_kind) pairs for the 6-kind intent
 *     classifier (Qwen-2.5 7B LoRA — trains in W3)
 *   - pillar-classification: (text, pillars[]) pairs for the pillar classifier
 *     oracle (Gemma-2 2B — trains in W2, used as ranker labeler not runtime)
 */

export type DatasetTarget =
  | 'voice-tool-routing'
  | 'intent-kind'
  | 'pillar-classification';

export interface DatasetRow {
  /** Stable id derived from source event id; lets us dedupe across runs. */
  source_id: string;
  /** ISO timestamp of the source event. */
  source_at: string;
  /** Free-form payload — shape varies per target. */
  payload: Record<string, unknown>;
}

export interface DatasetExtractionRun {
  target: DatasetTarget;
  started_at: string;
  finished_at: string;
  rows_total: number;
  rows_after_pii_filter: number;
  rows_after_dedup: number;
  output_path: string;          // local path written
  gcs_uri?: string;             // gs://bucket/path if uploaded
  hf_dataset_id?: string;       // huggingface dataset id if pushed
  dry_run: boolean;
}
