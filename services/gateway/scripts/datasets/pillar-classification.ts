/**
 * Pillar classification dataset extractor — Phase 1 W1 (VTID-03178 DATASETS).
 *
 * Pulls (text, pillars[]) pairs from prod oasis_events for the pillar
 * classifier oracle fine-tune (Gemma-2 2B, training starts W2; used as a
 * labeler for ranker training, not as a runtime replacement for the
 * existing rule-based vitana-pillars.ts classifier).
 *
 * Source: memory.write.user_message + memory.write.assistant_message
 * events. We derive (text from metadata.content, pillars from
 * metadata.vitana_pillars array).
 *
 * Run: `npx tsx services/gateway/scripts/datasets/pillar-classification.ts`
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

const TARGET = 'pillar-classification' as const;
const SOURCE_QUERY = 'topic=in.(memory.write.user_message,memory.write.assistant_message)';
const DAYS_BACK = Number(process.env.DATASET_DAYS_BACK || 30);
const LIMIT = Number(process.env.DATASET_MAX_ROWS || 50_000);
const DRY_RUN = process.env.DATASET_DRY_RUN === '1';

interface PillarMetadata {
  content?: string;
  text?: string;
  vitana_pillars?: string[];
  pillars?: string[];
  [k: string]: unknown;
}

/**
 * Pure projection: oasis_events rows → dataset rows. Single source of truth so
 * the preview path counts EXACTLY what the real extractor would write.
 */
export function projectRows(events: OasisEventRow[]): DatasetRow[] {
  const rows: DatasetRow[] = [];
  for (const e of events) {
    const meta = (e.metadata ?? {}) as PillarMetadata;
    const text = meta.content ?? meta.text;
    const pillars = meta.vitana_pillars ?? meta.pillars ?? [];
    if (!text || typeof text !== 'string' || text.length < 10 || text.length > 4000) continue;
    if (!Array.isArray(pillars) || pillars.length === 0) continue;
    rows.push({
      source_id: e.id,
      source_at: e.created_at,
      payload: {
        text,
        pillars: pillars.filter((p) => typeof p === 'string'),
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
