/**
 * Sequential dataset extraction driver — Phase 1 W1 (VTID-03178 DATASETS).
 *
 * Runs all 3 extractors in sequence. Used by the daily CRON-DATASET-EXTRACTION
 * workflow. Continues past per-target failures so one broken extractor
 * doesn't take the others down.
 *
 * Run: `npx tsx services/gateway/scripts/datasets/run-all.ts`
 */

import { extract as extractVoiceToolRouting } from './voice-tool-routing';
import { extract as extractIntentKind } from './intent-kind';
import { extract as extractPillarClassification } from './pillar-classification';
import type { DatasetExtractionRun } from './types';

interface Result {
  target: string;
  ok: boolean;
  run?: DatasetExtractionRun;
  error?: string;
}

async function main(): Promise<void> {
  const results: Result[] = [];

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

  console.log('\n=== summary ===');
  console.log(JSON.stringify(results, null, 2));

  const allOk = results.every((r) => r.ok);
  process.exit(allOk ? 0 : 1);
}

if (require.main === module) {
  main();
}
