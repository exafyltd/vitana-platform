/**
 * Intent-kind dataset extractor — Phase 1 W1 (VTID-03178 DATASETS).
 *
 * Pulls (signal_text, intent_kind) pairs from prod oasis_events for the
 * 6-kind intent classifier fine-tune (Qwen-2.5 7B LoRA, training starts W3).
 *
 * Source: autopilot.intent.created events. We derive (signal_text from
 * metadata.detected_text or metadata.user_message, intent_kind from
 * metadata.intent_kind).
 *
 * Run: `npx tsx services/gateway/scripts/datasets/intent-kind.ts`
 * Env: optional DATASET_PREVIEW=1 to count + sample projected rows WITHOUT
 *      writing any dataset (Phase 1 W2 readiness — BOOTSTRAP-DATASET-READINESS).
 */

import {
  PREVIEW_MODE,
  dedupeBySourceId,
  defaultSinceIso,
  emitExtractionEvent,
  generateRunId,
  queryOasisEvents,
  summarizePreview,
  uploadToGcs,
  writeJsonl,
} from './lib';
import type {
  DatasetExtractionPreview,
  DatasetExtractionRun,
  DatasetRow,
  OasisEventRow,
} from './types';

const TARGET = 'intent-kind' as const;
const SOURCE_QUERY = 'topic=eq.autopilot.intent.created';
const DAYS_BACK = Number(process.env.DATASET_DAYS_BACK || 30);
const LIMIT = Number(process.env.DATASET_MAX_ROWS || 50_000);
const DRY_RUN = process.env.DATASET_DRY_RUN === '1';

const VALID_KINDS = new Set([
  'task',
  'memory',
  'communication',
  'calendar',
  'goal',
  'preference',
]);

interface IntentMetadata {
  intent_kind?: string;
  detected_text?: string;
  user_message?: string;
  confidence?: number;
  [k: string]: unknown;
}

/**
 * Pure projection: oasis_events rows → dataset rows. Single source of truth so
 * the preview path counts EXACTLY what the real extractor would write.
 */
export function projectRows(events: OasisEventRow[]): DatasetRow[] {
  const rows: DatasetRow[] = [];
  for (const e of events) {
    const meta = (e.metadata ?? {}) as IntentMetadata;
    const kind = meta.intent_kind;
    const text = meta.detected_text ?? meta.user_message;
    if (!kind || !VALID_KINDS.has(kind)) continue;
    if (!text || typeof text !== 'string' || text.length < 3 || text.length > 1500) continue;
    rows.push({
      source_id: e.id,
      source_at: e.created_at,
      payload: {
        signal_text: text,
        intent_kind: kind,
        confidence: typeof meta.confidence === 'number' ? meta.confidence : null,
      },
    });
  }
  return rows;
}

/** Read-only preview — same query + same projection, writes nothing, consent gate untouched. */
async function preview(): Promise<DatasetExtractionPreview> {
  const since = defaultSinceIso(DAYS_BACK);
  console.log(`[${TARGET}] PREVIEW querying oasis_events since ${since} (limit=${LIMIT})`);
  const events = await queryOasisEvents(SOURCE_QUERY, since, LIMIT);
  console.log(`[${TARGET}] PREVIEW fetched ${events.length} candidate events`);
  const summary = summarizePreview(TARGET, events, projectRows(events));
  console.log(`[${TARGET}] PREVIEW would extract ${summary.rows_after_dedup} rows (nothing written)`);
  return summary;
}

async function extract(): Promise<DatasetExtractionRun | DatasetExtractionPreview> {
  if (PREVIEW_MODE) return preview();

  const startedAt = new Date().toISOString();
  const runId = generateRunId(TARGET);
  const since = defaultSinceIso(DAYS_BACK);

  console.log(`[${TARGET}] querying oasis_events since ${since} (limit=${LIMIT})`);

  const events = await queryOasisEvents(SOURCE_QUERY, since, LIMIT);

  console.log(`[${TARGET}] fetched ${events.length} candidate events`);

  const rows = projectRows(events);

  const deduped = dedupeBySourceId(rows);
  const outputPath = await writeJsonl(deduped, TARGET, runId);
  console.log(`[${TARGET}] wrote ${deduped.length} rows -> ${outputPath}`);

  let gcsUri: string | undefined;
  if (!DRY_RUN) {
    gcsUri = uploadToGcs(outputPath, TARGET, runId);
  }

  const run: DatasetExtractionRun = {
    target: TARGET,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    rows_total: events.length,
    rows_after_pii_filter: events.length,
    rows_after_dedup: deduped.length,
    output_path: outputPath,
    gcs_uri: gcsUri,
    dry_run: DRY_RUN,
  };

  if (!DRY_RUN) {
    await emitExtractionEvent(run);
  }
  return run;
}

if (require.main === module) {
  extract()
    .then((run) => console.log(JSON.stringify(run, null, 2)))
    .catch((err) => {
      console.error(`[${TARGET}] FAILED:`, err);
      process.exit(1);
    });
}

export { extract };
