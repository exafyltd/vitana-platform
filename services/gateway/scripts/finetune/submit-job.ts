/**
 * Vertex AI Custom Training submitter — Phase 1 W1 (VTID-03179 FINETUNES).
 *
 * Wraps `gcloud ai custom-jobs create` with parameters from a finetune
 * config YAML. Used by CRON-FINETUNE-TRAINER.yml (weekly) and by ad-hoc
 * manual triggers ("submit voice-tool-router for first training").
 *
 * Run: `npx tsx services/gateway/scripts/finetune/submit-job.ts <target>`
 *      where <target> is one of: voice-tool-router | intent-kind | pillar-classifier
 *
 * Env:
 *   GCP_PROJECT (default lovable-vitana-vers1)
 *   GCP_REGION  (default us-central1)
 *   FINETUNE_DRY_RUN=1 — print the gcloud command without invoking
 */

import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  assertDatasetReady,
  assertGcsObjectExists,
  buildJobConfig,
  buildTrainerPackageUri,
  type FinetuneConfig,
} from './submit-job-lib';

const TARGET = process.argv[2];
const DRY_RUN = process.env.FINETUNE_DRY_RUN === '1';
const BASE_MODEL_OVERRIDE = process.env.FINETUNE_BASE_MODEL_OVERRIDE;
const VALID_TARGETS = new Set(['voice-tool-router', 'intent-kind', 'pillar-classifier']);

if (!TARGET || !VALID_TARGETS.has(TARGET)) {
  console.error(`Usage: tsx submit-job.ts <target>\n  target: ${[...VALID_TARGETS].join(' | ')}`);
  process.exit(2);
}

async function parseYaml(file: string): Promise<FinetuneConfig> {
  const raw = await fs.readFile(file, 'utf-8');
  const jsYaml = await import('js-yaml');
  return jsYaml.load(raw) as FinetuneConfig;
}

async function main(): Promise<void> {
  const configPath = path.join(__dirname, TARGET, 'config.yaml');
  console.log(`[submit-job] loading ${configPath}`);
  const cfg = await parseYaml(configPath);
  if (BASE_MODEL_OVERRIDE) {
    console.log(`[submit-job] overriding base_model ${cfg.base_model} -> ${BASE_MODEL_OVERRIDE}`);
    cfg.base_model = BASE_MODEL_OVERRIDE;
  }

  const runId = `${cfg.vertex_custom_job.display_name_prefix}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${randomUUID().slice(0, 8)}`;
  const outputUri = `${cfg.vertex_custom_job.output_uri_prefix}${runId}/`;
  const trainerPackageUri = buildTrainerPackageUri(cfg);

  const jobConfig = buildJobConfig({ config: cfg, outputUri, trainerPackageUri });

  const tmpConfigPath = `/tmp/finetune-job-${runId}.yaml`;
  const jsYaml = await import('js-yaml');
  await fs.writeFile(tmpConfigPath, jsYaml.dump(jobConfig), 'utf-8');

  const args = [
    'ai', 'custom-jobs', 'create',
    `--project=${cfg.vertex_custom_job.project}`,
    `--region=${cfg.vertex_custom_job.region}`,
    `--display-name=${runId}`,
    `--config=${tmpConfigPath}`,
  ];

  console.log(`[submit-job] job: ${runId}`);
  console.log(`[submit-job] output_uri: ${outputUri}`);
  console.log(`[submit-job] trainer_package: ${trainerPackageUri}`);
  console.log(`[submit-job] config file: ${tmpConfigPath}`);
  console.log(`[submit-job] command: gcloud ${args.join(' ')}`);

  if (DRY_RUN) {
    console.log('[submit-job] dry run — not invoking gcloud');
    return;
  }

  try {
    assertGcsObjectExists(trainerPackageUri);
    assertDatasetReady(cfg);
    execSync(['gcloud', ...args].join(' '), { stdio: 'inherit' });
    console.log(`[submit-job] submitted ${runId}`);
  } catch (err) {
    console.error('[submit-job] gcloud failed:', err);
    process.exit(1);
  } finally {
    try { await fs.unlink(tmpConfigPath); } catch { /* ignore */ }
  }
}

main();
