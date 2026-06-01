import { execSync } from 'child_process';

export interface FinetuneConfig {
  target: string;
  base_model: string;
  adapter_method?: string;
  lora_r?: number;
  lora_alpha?: number;
  lora_dropout?: number;
  target_modules?: string[];
  dataset: {
    gcs_prefix: string;
    format?: string;
    field_input?: string;
    field_output?: string;
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

interface BuildJobConfigInput {
  config: FinetuneConfig;
  outputUri: string;
  trainerPackageUri: string;
}

export function buildTrainerPackageUri(config: FinetuneConfig): string {
  // VTID-03244: bumped to 0.1.1 — drops torch from install_requires so it
  // doesn't shadow the container's pre-installed PyTorch (root cause of
  // CustomJob 3154255301083922432 failure 2026-06-01).
  return `${config.vertex_custom_job.output_uri_prefix}trainer/finetune-trainer-0.1.1.tar.gz`;
}

export function buildTrainingArgs(config: FinetuneConfig, outputUri: string): string[] {
  return [
    `--target=${config.target}`,
    `--base-model=${config.base_model}`,
    `--dataset-prefix=${config.dataset.gcs_prefix}`,
    `--field-input=${config.dataset.field_input ?? 'payload.user_input'}`,
    `--field-output=${config.dataset.field_output ?? 'payload.tool_chosen'}`,
    `--min-rows-required=${config.dataset.min_rows_required}`,
    `--output-uri=${outputUri}`,
    ...Object.entries(config.training).map(([k, v]) => `--${k.replace(/_/g, '-')}=${v}`),
  ];
}

export function buildJobConfig({ config, outputUri, trainerPackageUri }: BuildJobConfigInput) {
  return {
    workerPoolSpecs: [
      {
        machineSpec: {
          machineType: config.vertex_custom_job.worker_pool.machine_type,
          acceleratorType: config.vertex_custom_job.worker_pool.accelerator_type,
          acceleratorCount: config.vertex_custom_job.worker_pool.accelerator_count,
        },
        replicaCount: config.vertex_custom_job.worker_pool.replica_count,
        pythonPackageSpec: {
          executorImageUri: config.vertex_custom_job.container_image,
          packageUris: [trainerPackageUri],
          pythonModule: config.vertex_custom_job.python_module,
          args: buildTrainingArgs(config, outputUri),
        },
      },
    ],
  };
}

export function countDatasetRowsFromJsonl(files: string[]): number {
  return files.reduce((total, raw) => {
    return total + raw.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  }, 0);
}

export function assertGcsObjectExists(uri: string): void {
  try {
    execSync(`gcloud storage ls ${shellQuote(uri)}`, { stdio: 'pipe' });
  } catch {
    throw new Error(`Missing required GCS object: ${uri}`);
  }
}

export function countGcsJsonlRows(prefix: string): number {
  try {
    const raw = execSync(`gcloud storage cat ${shellQuote(`${prefix}*.jsonl`)}`, {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 512,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return countDatasetRowsFromJsonl([raw]);
  } catch {
    return 0;
  }
}

export function assertDatasetReady(config: FinetuneConfig): void {
  const rows = countGcsJsonlRows(config.dataset.gcs_prefix);
  const minRows = config.dataset.min_rows_required;
  if (rows < minRows) {
    throw new Error(
      `Dataset ${config.dataset.gcs_prefix} has ${rows} JSONL rows; ${minRows} required. ` +
      'Run consented extraction or a synthetic bootstrap smoke dataset before submitting Vertex training.',
    );
  }
  console.log(`[submit-job] dataset preflight ok: ${rows} rows >= ${minRows}`);
}

function shellQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
