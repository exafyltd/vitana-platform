/**
 * Dataset extraction shared lib — Phase 1 W1 (VTID-03178 DATASETS).
 *
 * Common helpers for the three dataset extractors. Reads from prod Supabase
 * via SUPABASE_URL + SUPABASE_SERVICE_ROLE (the loop is the only Phase 1
 * autonomous job that touches prod; it's a pure read).
 *
 * PII rule (see PII_FILTER.md for the full policy): drop any source row
 * whose topic begins with `safety.guardrail.` OR whose metadata lacks
 * `data_export_ok: true`. Both conditions are checked at the SQL layer so
 * filtered rows never enter Node memory.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { DatasetExtractionRun, DatasetRow, DatasetTarget } from './types';

const PROD_SUPABASE_URL = process.env.SUPABASE_URL;
const PROD_SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE;
const GCS_BUCKET = process.env.DATASET_GCS_BUCKET || 'gs://vitana-artifacts-staging';
const OUTPUT_ROOT = process.env.DATASET_OUTPUT_ROOT || '/tmp/vitana-datasets';

if (!PROD_SUPABASE_URL || !PROD_SUPABASE_KEY) {
  console.warn(
    '[dataset-extraction] SUPABASE_URL / SUPABASE_SERVICE_ROLE not set; ' +
      'extractors will return zero rows. Set in the cron workflow secrets.',
  );
}

/**
 * Query oasis_events. The PII filter is applied here so filtered rows never
 * cross the wire. `where` is appended to the existing filter — caller passes
 * topic constraints (e.g. `topic=eq.orb.turn.responded`).
 */
export async function queryOasisEvents(
  where: string,
  sinceIso: string,
  limit = 50_000,
): Promise<Array<{ id: string; created_at: string; topic: string; metadata: Record<string, unknown> | null; message: string | null }>> {
  if (!PROD_SUPABASE_URL || !PROD_SUPABASE_KEY) return [];

  // PII guards encoded as PostgREST filters (independent query params,
  // implicitly AND-ed by PostgREST). The earlier `and=(not.topic.like...,
  // metadata->data_export_ok.eq.true)` form failed to parse — PostgREST's
  // `and=(...)` doesn't accept the `->` JSON-path operator inside the
  // grouping. Splitting them outside the group works on both row-level
  // columns and JSONB paths.
  //
  //   1. topic must NOT match safety.guardrail.* (`%` is the SQL LIKE wildcard)
  //   2. metadata.data_export_ok must equal true
  const piiTopicFilter = 'topic=not.like.safety.guardrail.%25';
  const piiConsentFilter = 'metadata->>data_export_ok=eq.true';
  const baseFilter = `created_at=gte.${encodeURIComponent(sinceIso)}`;
  const url = `${PROD_SUPABASE_URL}/rest/v1/oasis_events?${baseFilter}&${where}&${piiTopicFilter}&${piiConsentFilter}&order=created_at.asc&limit=${limit}&select=id,created_at,topic,metadata,message`;

  const resp = await fetch(url, {
    headers: {
      apikey: PROD_SUPABASE_KEY,
      Authorization: `Bearer ${PROD_SUPABASE_KEY}`,
    },
  });
  if (!resp.ok) {
    throw new Error(`oasis_events query failed: ${resp.status} ${await resp.text()}`);
  }
  return (await resp.json()) as Array<{ id: string; created_at: string; topic: string; metadata: Record<string, unknown> | null; message: string | null }>;
}

export async function writeJsonl(rows: DatasetRow[], target: DatasetTarget, runId: string): Promise<string> {
  const dir = path.join(OUTPUT_ROOT, target);
  await fs.mkdir(dir, { recursive: true });
  const filename = `${runId}.jsonl`;
  const fullPath = path.join(dir, filename);
  const handle = await fs.open(fullPath, 'w');
  try {
    for (const row of rows) {
      await handle.write(`${JSON.stringify(row)}\n`);
    }
  } finally {
    await handle.close();
  }
  return fullPath;
}

export function uploadToGcs(localPath: string, target: DatasetTarget, runId: string): string | undefined {
  try {
    const gcsUri = `${GCS_BUCKET}/datasets/${target}/${runId}.jsonl`;
    execFileSync('gsutil', ['cp', localPath, gcsUri], { stdio: 'inherit' });
    return gcsUri;
  } catch (err) {
    console.error('[dataset-extraction] GCS upload failed:', err);
    return undefined;
  }
}

export function dedupeBySourceId(rows: DatasetRow[]): DatasetRow[] {
  const seen = new Set<string>();
  const out: DatasetRow[] = [];
  for (const row of rows) {
    if (seen.has(row.source_id)) continue;
    seen.add(row.source_id);
    out.push(row);
  }
  return out;
}

export async function emitExtractionEvent(run: DatasetExtractionRun): Promise<void> {
  if (!PROD_SUPABASE_URL || !PROD_SUPABASE_KEY) return;
  const evt = {
    vtid: 'VTID-03178',
    topic: 'dataset.extraction.completed',
    service: 'gateway/datasets',
    role: 'CICD',
    model: 'dataset-extraction',
    status: 'success',
    message: `extracted ${run.rows_after_dedup} rows for ${run.target}${run.dry_run ? ' (dry run)' : ''}`,
    metadata: {
      env: 'production',
      target: run.target,
      rows_total: run.rows_total,
      rows_after_pii_filter: run.rows_after_pii_filter,
      rows_after_dedup: run.rows_after_dedup,
      output_path: run.output_path,
      gcs_uri: run.gcs_uri,
      hf_dataset_id: run.hf_dataset_id,
      dry_run: run.dry_run,
    },
  };
  try {
    await fetch(`${PROD_SUPABASE_URL}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: PROD_SUPABASE_KEY,
        Authorization: `Bearer ${PROD_SUPABASE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(evt),
    });
  } catch (err) {
    console.error('[dataset-extraction] event emit failed:', err);
  }
}

export function defaultSinceIso(daysBack: number): string {
  return new Date(Date.now() - daysBack * 86_400_000).toISOString();
}

export function generateRunId(target: DatasetTarget): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${target}-${ts}`;
}
