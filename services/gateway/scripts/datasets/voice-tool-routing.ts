/**
 * Voice tool routing dataset extractor — Phase 1 W1 (VTID-03178 DATASETS).
 *
 * Pulls (user_input, tool_chosen) pairs from prod oasis_events for the
 * voice tool router fine-tune (Gemma-2 2B LoRA, training starts W1 per the
 * 40-day plan).
 *
 * Source: orb.turn.responded events where metadata.tool_dispatched is set.
 * We derive the (user_input from metadata.transcript, tool_chosen from
 * metadata.tool_name) pair.
 *
 * Run: `npx tsx services/gateway/scripts/datasets/voice-tool-routing.ts`
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE, optional DATASET_GCS_BUCKET,
 *      optional DATASET_DRY_RUN=1 to skip GCS upload + event emit.
 */

import {
  dedupeBySourceId,
  defaultSinceIso,
  emitExtractionEvent,
  generateRunId,
  queryOasisEvents,
  uploadToGcs,
  writeJsonl,
} from './lib';
import type { DatasetExtractionRun, DatasetRow } from './types';

const TARGET = 'voice-tool-routing' as const;
const DAYS_BACK = Number(process.env.DATASET_DAYS_BACK || 30);
const LIMIT = Number(process.env.DATASET_MAX_ROWS || 50_000);
const DRY_RUN = process.env.DATASET_DRY_RUN === '1';

interface ToolResponseMetadata {
  transcript?: string;
  input_text?: string;
  tool_name?: string;
  tool_dispatched?: boolean;
  tool_call?: { name?: string; arguments?: Record<string, unknown> };
  data_export_ok?: boolean;
  [k: string]: unknown;
}

async function extract(): Promise<DatasetExtractionRun> {
  const startedAt = new Date().toISOString();
  const runId = generateRunId(TARGET);
  const since = defaultSinceIso(DAYS_BACK);

  console.log(`[${TARGET}] querying oasis_events since ${since} (limit=${LIMIT})`);

  const events = await queryOasisEvents(
    'topic=eq.orb.turn.responded',
    since,
    LIMIT,
  );

  console.log(`[${TARGET}] fetched ${events.length} candidate events`);

  const rows: DatasetRow[] = [];
  for (const e of events) {
    const meta = (e.metadata ?? {}) as ToolResponseMetadata;
    const toolName = meta.tool_name ?? meta.tool_call?.name;
    const userInput = meta.transcript ?? meta.input_text;
    if (!toolName || !userInput || typeof userInput !== 'string') continue;
    if (userInput.length < 3 || userInput.length > 800) continue;
    rows.push({
      source_id: e.id,
      source_at: e.created_at,
      payload: {
        user_input: userInput,
        tool_chosen: toolName,
        tool_arguments: meta.tool_call?.arguments ?? null,
      },
    });
  }

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
    rows_after_pii_filter: events.length, // SQL-side PII filter; reaching here = passed
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
    .then((run) => {
      console.log(JSON.stringify(run, null, 2));
    })
    .catch((err) => {
      console.error(`[${TARGET}] FAILED:`, err);
      process.exit(1);
    });
}

export { extract };
