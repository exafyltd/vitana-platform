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

interface FinetuneConfig {
  target: string;
  base_model: string;
  dataset: {
    gcs_prefix: string;
    min_rows_required: number;
  };
  training: Record<string, unknown>;
  vertex_custom_job: {
    project: string;
    region: string;
    display_name_prefix: string;
    worker_pool: {
      machine_type: string;
      accelerator_type: string;
      accelerator_count: number;
      replica_count: number;
    };
    container_image: string;
    python_module: string;
    output_uri_prefix: string;
  };
}

const TARGET = process.argv[2];
const DRY_RUN = process.env.FINETUNE_DRY_RUN === '1';
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

  const runId = `${cfg.vertex_custom_job.display_name_prefix}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${randomUUID().slice(0, 8)}`;
  const outputUri = `${cfg.vertex_custom_job.output_uri_prefix}${runId}/`;

  // gcloud ai custom-jobs --worker-pool-spec accepts comma-separated
  // key=value pairs, NOT JSON. For nested specs (python_package_spec) the
  // canonical workaround is a YAML/JSON config passed via --config; this
  // also keeps shell-quoting sane.
  const jobConfig = {
    workerPoolSpecs: [
      {
        machineSpec: {
          machineType: cfg.vertex_custom_job.worker_pool.machine_type,
          acceleratorType: cfg.vertex_custom_job.worker_pool.accelerator_type,
          acceleratorCount: cfg.vertex_custom_job.worker_pool.accelerator_count,
        },
        replicaCount: cfg.vertex_custom_job.worker_pool.replica_count,
        pythonPackageSpec: {
          executorImageUri: cfg.vertex_custom_job.container_image,
          packageUris: [`${cfg.vertex_custom_job.output_uri_prefix}trainer/finetune-trainer-0.1.0.tar.gz`],
          pythonModule: cfg.vertex_custom_job.python_module,
          args: [
            `--target=${cfg.target}`,
            `--base-model=${cfg.base_model}`,
            `--dataset-prefix=${cfg.dataset.gcs_prefix}`,
            `--output-uri=${outputUri}`,
            ...Object.entries(cfg.training).map(([k, v]) => `--${k.replace(/_/g, '-')}=${v}`),
          ],
        },
      },
    ],
  };

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
  console.log(`[submit-job] config file: ${tmpConfigPath}`);
  console.log(`[submit-job] command: gcloud ${args.join(' ')}`);

  if (DRY_RUN) {
    console.log('[submit-job] dry run — not invoking gcloud');
    return;
  }

  try {
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
