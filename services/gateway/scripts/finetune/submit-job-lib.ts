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

export const DEFAULT_SYNTHETIC_SMOKE_BASE_MODEL = 'Qwen/Qwen2.5-0.5B-Instruct';

const KNOWN_GATED_MODEL_PREFIXES = [
  'google/gemma-',
  'meta-llama/',
];

export function buildTrainerPackageUri(config: FinetuneConfig): string {
  // This governs BOTH the GCS object the trainer tarball is uploaded to
  // (package-trainer.ts) and the packageUris the Vertex job installs from, so
  // the version here must stay in lock-step with trainer-package/setup.py.
  // History: v0.1.2 pinned numpy<2 so `import torch` works (job 3852431990582149120);
  // v0.1.3 saves the PEFT adapter with safe_serialization=False so the post-training
  // save no longer trips on Qwen2.5's tied embeddings (job 3932080612898242560).
  return `${config.vertex_custom_job.output_uri_prefix}trainer/finetune-trainer-0.1.3.tar.gz`;
}

export function isKnownGatedBaseModel(baseModel: string): boolean {
  return KNOWN_GATED_MODEL_PREFIXES.some((prefix) => baseModel.startsWith(prefix));
}

export function assertBaseModelSubmitSafe(config: FinetuneConfig): void {
  if (!isKnownGatedBaseModel(config.base_model)) return;
  if (process.env.FINETUNE_ALLOW_GATED_BASE_MODEL === '1') return;

  throw new Error(
    `Base model ${config.base_model} is a known gated Hugging Face repo. ` +
    'Vertex workers cannot access it without an HF-authenticated trainer path, so this job would fail at from_pretrained(). ' +
    `Use an ungated override such as ${DEFAULT_SYNTHETIC_SMOKE_BASE_MODEL}, or implement the gated-model HF token path first.`,
  );
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
