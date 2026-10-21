/**
 * Sequential dataset extraction driver — Phase 1 W1 (VTID-03178 DATASETS).
 *
 * Runs all 3 extractors in sequence. Used by the daily CRON-DATASET-EXTRACTION
 * workflow. Continues past per-target failures so one broken extractor
 * doesn't take the others down.
 *
 * Run: `npx tsx services/gateway/scripts/datasets/run-all.ts`
 * Env: DATASET_PREVIEW=1 → read-only preview (count + sample projected rows
 *      per target, write NOTHING). Phase 1 W2 readiness check.
 */

import { extract as extractVoiceToolRouting } from './voice-tool-routing';
import { extract as extractIntentKind } from './intent-kind';
import { extract as extractPillarClassification } from './pillar-classification';
import type { DatasetExtractionPreview, DatasetExtractionRun } from './types';

const PREVIEW_MODE = process.env.DATASET_PREVIEW === '1';

interface Result {
  target: string;
  ok: boolean;
  run?: DatasetExtractionRun | DatasetExtractionPreview;
  error?: string;
}

async function main(): Promise<void> {
  const results: Result[] = [];

  if (PREVIEW_MODE) {
    console.log('=== DATASET PREVIEW (read-only — no JSONL, no GCS, no events) ===');
  }

  for (const [name, fn] of [
    ['voice-tool-routing', extractVoiceToolRouting],
    ['intent-kind', extractIntentKind],
    ['pillar-classification', extractPillarClassification],
  ] as const) {
    console.log(`\n=== ${name} ===`);
    try {
      const run = await fn();
      results.push({ target: name, ok: true, run });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${name}] FAILED:`, msg);
      results.push({ target: name, ok: false, error: msg });
    }
  }

  console.log(`\n=== ${PREVIEW_MODE ? 'preview ' : ''}summary ===`);
  console.log(JSON.stringify(results, null, 2));

  if (PREVIEW_MODE) {
    const totalProjected = results.reduce((sum, r) => {
      const run = r.run as DatasetExtractionPreview | undefined;
      return sum + (run && 'rows_after_dedup' in run ? run.rows_after_dedup : 0);
    }, 0);
    console.log(`\n[preview] total rows that WOULD extract across all targets: ${totalProjected}`);
  }

  const allOk = results.every((r) => r.ok);
  process.exit(allOk ? 0 : 1);
}

if (require.main === module) {
  main();
}
