/**
 * Builds and uploads the Python trainer package consumed by Vertex AI Custom
 * Training. The submitter preflights this exact GCS object before creating
 * the Vertex job.
 */

import { execFileSync, execSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { buildTrainerPackageUri, type FinetuneConfig } from './submit-job-lib';

const TARGET = process.argv[2];
const VALID_TARGETS = new Set(['voice-tool-router', 'intent-kind', 'pillar-classifier']);

if (!TARGET || !VALID_TARGETS.has(TARGET)) {
  console.error(`Usage: tsx package-trainer.ts <target>\n  target: ${[...VALID_TARGETS].join(' | ')}`);
  process.exit(2);
}

async function parseYaml(file: string): Promise<FinetuneConfig> {
  const raw = await fs.readFile(file, 'utf-8');
  const jsYaml = await import('js-yaml');
  return jsYaml.load(raw) as FinetuneConfig;
}

async function main(): Promise<void> {
  const configPath = path.join(__dirname, TARGET, 'config.yaml');
  const cfg = await parseYaml(configPath);
  const trainerDir = path.join(__dirname, 'trainer-package');
  const trainerUri = buildTrainerPackageUri(cfg);
  // Keep this label in lock-step with the version in trainer-package/setup.py.
  // v0.1.3: numpy<2 pin (training runs) + PEFT adapter saved with
  // safe_serialization=False (save no longer trips on Qwen2.5 tied weights).
  // See setup.py for the full failure history.
  const archivePath = path.join(os.tmpdir(), 'finetune-trainer-0.1.3.tar.gz');

  await fs.access(path.join(trainerDir, 'setup.py'));
  execFileSync('tar', ['-czf', archivePath, '-C', trainerDir, '.'], { stdio: 'inherit' });
  execSync(`gcloud storage cp ${shellQuote(archivePath)} ${shellQuote(trainerUri)}`, { stdio: 'inherit' });
  console.log(`[package-trainer] uploaded ${trainerUri}`);
}

function shellQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

main().catch((err) => {
  console.error('[package-trainer] FAILED:', err);
  process.exit(1);
});
