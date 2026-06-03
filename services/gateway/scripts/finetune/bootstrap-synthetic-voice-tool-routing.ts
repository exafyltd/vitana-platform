/**
 * Creates a PII-free synthetic voice-tool-routing dataset for infrastructure
 * smoke training. This is not promotion evidence; consented production rows
 * still gate real model graduation.
 */

import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import toolManifest from '../../src/services/tool-manifest.json';

interface ToolManifestEntry {
  name: string;
  surface?: string;
  category?: string;
  status?: string;
  description?: string;
}

interface SyntheticRow {
  source_id: string;
  source_at: string;
  payload: {
    user_input: string;
    tool_chosen: string;
    tool_arguments: null;
    synthetic: true;
    training_only: true;
    generator: 'bootstrap-synthetic-voice-tool-routing';
  };
}

const TARGET = 'voice-tool-routing';
const ROWS = Number(process.env.SYNTHETIC_ROWS || 1200);
const GCS_BUCKET = process.env.DATASET_GCS_BUCKET || 'gs://vitana-artifacts-staging';
const OUTPUT_ROOT = process.env.DATASET_OUTPUT_ROOT || '/tmp/vitana-datasets';
const DRY_RUN = process.env.DATASET_DRY_RUN === '1';

export function buildSyntheticVoiceToolRows(tools: ToolManifestEntry[], rows: number, now = new Date()): SyntheticRow[] {
  const liveTools = tools.filter((tool) => tool.name && (tool.status ?? 'live') === 'live');
  if (liveTools.length === 0) {
    throw new Error('tool manifest has no live tools');
  }

  const templates = [
    (tool: ToolManifestEntry) => `Can you ${humanizeToolName(tool.name)} for me?`,
    (tool: ToolManifestEntry) => `I need help with ${tool.surface ?? tool.category ?? humanizeToolName(tool.name)}.`,
    (tool: ToolManifestEntry) => `Use ${tool.name} to handle this request.`,
    (tool: ToolManifestEntry) => tool.description ? `Please ${sentenceToRequest(tool.description)}` : `Please run ${humanizeToolName(tool.name)}.`,
    (tool: ToolManifestEntry) => `Hey Orb, ${humanizeToolName(tool.name)} now.`,
    (tool: ToolManifestEntry) => `Start the ${tool.category ?? tool.surface ?? 'Vitana'} action for ${humanizeToolName(tool.name)}.`,
    (tool: ToolManifestEntry) => `Find the right Vitana action to ${humanizeToolName(tool.name)}.`,
    (tool: ToolManifestEntry) => `Voice command: ${humanizeToolName(tool.name)}.`,
  ];

  const out: SyntheticRow[] = [];
  for (let i = 0; i < rows; i += 1) {
    const tool = liveTools[i % liveTools.length];
    const template = templates[Math.floor(i / liveTools.length) % templates.length];
    out.push({
      source_id: `synthetic-${TARGET}-${tool.name}-${i}`,
      source_at: now.toISOString(),
      payload: {
        user_input: template(tool),
        tool_chosen: tool.name,
        tool_arguments: null,
        synthetic: true,
        training_only: true,
        generator: 'bootstrap-synthetic-voice-tool-routing',
      },
    });
  }
  return out;
}

async function main(): Promise<void> {
  const runId = `${TARGET}-synthetic-bootstrap-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const rows = buildSyntheticVoiceToolRows((toolManifest as { tools: ToolManifestEntry[] }).tools, ROWS);
  const outDir = path.join(OUTPUT_ROOT, TARGET);
  await fs.mkdir(outDir, { recursive: true });
  const localPath = path.join(outDir, `${runId}.jsonl`);
  await fs.writeFile(localPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  console.log(`[synthetic-dataset] wrote ${rows.length} rows -> ${localPath}`);

  if (DRY_RUN) {
    console.log('[synthetic-dataset] dry run; not uploading');
    return;
  }

  const gcsUri = `${GCS_BUCKET}/datasets/${TARGET}/${runId}.jsonl`;
  execSync(`gcloud storage cp ${shellQuote(localPath)} ${shellQuote(gcsUri)}`, { stdio: 'inherit' });
  console.log(`[synthetic-dataset] uploaded ${gcsUri}`);
}

function humanizeToolName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function sentenceToRequest(description: string): string {
  const trimmed = description.trim().replace(/\.$/, '');
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

function shellQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[synthetic-dataset] FAILED:', err);
    process.exit(1);
  });
}
