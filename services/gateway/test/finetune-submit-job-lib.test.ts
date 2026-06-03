import {
  buildJobConfig,
  buildTrainerPackageUri,
  buildTrainingArgs,
  countDatasetRowsFromJsonl,
  assertBaseModelSubmitSafe,
  isKnownGatedBaseModel,
  type FinetuneConfig,
} from '../scripts/finetune/submit-job-lib';

const config: FinetuneConfig = {
  target: 'voice-tool-router',
  base_model: 'Qwen/Qwen2.5-0.5B-Instruct',
  adapter_method: 'lora',
  dataset: {
    gcs_prefix: 'gs://vitana-artifacts-staging/datasets/voice-tool-routing/',
    format: 'jsonl',
    field_input: 'payload.user_input',
    field_output: 'payload.tool_chosen',
    min_rows_required: 1000,
  },
  training: {
    epochs: 3,
    batch_size: 16,
    learning_rate: '2.0e-4',
  },
  vertex_custom_job: {
    project: 'lovable-vitana-vers1',
    region: 'us-central1',
    display_name_prefix: 'voice-tool-router-ft',
    worker_pool: {
      machine_type: 'g2-standard-8',
      accelerator_type: 'NVIDIA_L4',
      accelerator_count: 1,
      replica_count: 1,
    },
    container_image: 'us-docker.pkg.dev/vertex-ai/training/pytorch-gpu.2-3.py310:latest',
    python_module: 'finetune.train',
    output_uri_prefix: 'gs://vitana-artifacts-staging/finetune-runs/voice-tool-router/',
  },
};

describe('finetune submit job config', () => {
  test('builds the trainer package URI from the configured output prefix', () => {
    expect(buildTrainerPackageUri(config)).toBe(
      'gs://vitana-artifacts-staging/finetune-runs/voice-tool-router/trainer/finetune-trainer-0.1.3.tar.gz',
    );
  });

  test('passes dataset contract arguments into the Vertex trainer', () => {
    expect(buildTrainingArgs(config, 'gs://out/run-1/')).toEqual(
      expect.arrayContaining([
        '--target=voice-tool-router',
        '--dataset-prefix=gs://vitana-artifacts-staging/datasets/voice-tool-routing/',
        '--field-input=payload.user_input',
        '--field-output=payload.tool_chosen',
        '--min-rows-required=1000',
        '--output-uri=gs://out/run-1/',
      ]),
    );
  });

  test('uses the uploaded trainer tarball in the Vertex python package spec', () => {
    const jobConfig = buildJobConfig({
      config,
      outputUri: 'gs://out/run-1/',
      trainerPackageUri: buildTrainerPackageUri(config),
    });

    expect(jobConfig.workerPoolSpecs[0].pythonPackageSpec.packageUris).toEqual([
      'gs://vitana-artifacts-staging/finetune-runs/voice-tool-router/trainer/finetune-trainer-0.1.3.tar.gz',
    ]);
    expect(jobConfig.workerPoolSpecs[0].pythonPackageSpec.pythonModule).toBe('finetune.train');
  });

  test('detects gated Hugging Face base models before submitting Vertex jobs', () => {
    expect(isKnownGatedBaseModel('google/gemma-2-2b-it')).toBe(true);
    expect(isKnownGatedBaseModel('Qwen/Qwen2.5-1.5B-Instruct')).toBe(false);

    expect(() => assertBaseModelSubmitSafe({
      ...config,
      base_model: 'google/gemma-2-2b-it',
    })).toThrow(/known gated Hugging Face repo/);
  });
});

describe('countDatasetRowsFromJsonl', () => {
  test('counts non-empty JSONL rows across multiple files', () => {
    const files = [
      '{"payload":{"user_input":"a","tool_chosen":"search_knowledge"}}\n\n',
      '{"payload":{"user_input":"b","tool_chosen":"get_schedule"}}\n',
    ];

    expect(countDatasetRowsFromJsonl(files)).toBe(2);
  });
});
