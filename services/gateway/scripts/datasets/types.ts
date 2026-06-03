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

/**
 * Minimal shape of an oasis_events row as returned by the extraction query.
 * Shared so the preview summarizer and each extractor's row projector agree
 * on the input shape without re-declaring it.
 */
export interface OasisEventRow {
  id: string;
  created_at: string;
  topic: string;
  metadata: Record<string, unknown> | null;
  message: string | null;
}

/**
 * Read-only PREVIEW of what a real extraction WOULD produce — Phase 1 W2
 * readiness (BOOTSTRAP-DATASET-READINESS).
 *
 * Runs the SAME consent-gated query and the SAME per-target row projection as
 * the real extractor, but writes nothing (no JSONL, no GCS upload, no event
 * emit). Lets an operator confirm "X rows would extract" before and
 * immediately after flipping `tenant_settings.feature_flags.data_export_ok`,
 * without producing or persisting a dataset.
 */
export interface DatasetExtractionPreview {
  target: DatasetTarget;
  preview: true;
  /** Events returned by the consent-gated query (already post-PII-filter). */
  rows_total: number;
  /** Rows that pass this target's projection predicate (would land in JSONL, pre-dedup). */
  rows_projected: number;
  /** Rows after dedup-by-source-id — the real JSONL row count that would be written. */
  rows_after_dedup: number;
  /** Projected-row counts grouped by metadata.tenant_id ("unknown" when absent). */
  by_tenant: Record<string, number>;
  /** Projected-row counts grouped by source event topic. */
  by_source: Record<string, number>;
  /** Up to N sample projected rows (same shape that would be written to JSONL). */
  samples: DatasetRow[];
}
