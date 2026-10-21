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
import type {
  DatasetExtractionPreview,
  DatasetExtractionRun,
  DatasetRow,
  DatasetTarget,
  OasisEventRow,
} from './types';

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
): Promise<OasisEventRow[]> {
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
  return (await resp.json()) as OasisEventRow[];
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

/**
 * PREVIEW / DRY-RUN mode flag — Phase 1 W2 readiness (BOOTSTRAP-DATASET-READINESS).
 *
 * When `DATASET_PREVIEW=1` the extractors run the SAME consent-gated query and
 * the SAME row projection, then COUNT + SAMPLE the projected rows instead of
 * writing JSONL / uploading to GCS / emitting the completion event. This is a
 * strict superset of the legacy `DATASET_DRY_RUN=1` behavior (which still wrote
 * the local JSONL): preview writes NOTHING.
 *
 * This does NOT relax the consent gate. The query in `queryOasisEvents` still
 * carries `metadata->>data_export_ok=eq.true`, so preview over an unconsented
 * prod correctly reports 0 — and reports a non-zero, correct count the instant
 * an operator flips consent, with no data written either way.
 */
export const PREVIEW_MODE = process.env.DATASET_PREVIEW === '1';

/**
 * How many sample rows the preview surfaces. Kept small — this is a readiness
 * check, not an export. Defaults to 5 and is intentionally unbound in any
 * workflow/deploy config: it ONLY affects preview mode, so a missing env var is
 * the normal case. Parsed defensively — a non-numeric / empty value falls back
 * to the default rather than producing NaN (which would silently surface 0 rows).
 */
const PREVIEW_SAMPLE_DEFAULT = 5;
export const PREVIEW_SAMPLE_LIMIT = (() => {
  const parsed = Number.parseInt(process.env.DATASET_PREVIEW_SAMPLES ?? '5', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : PREVIEW_SAMPLE_DEFAULT;
})();

/**
 * Pull a tenant identifier out of an event's metadata for preview grouping.
 * oasis_events has no top-level tenant_id column (it's a global log), so the
 * tenant — when present — lives in metadata. We check the common keys the
 * producing surfaces use; falls back to "unknown" so every projected row is
 * still counted.
 */
export function tenantKeyFromEvent(event: OasisEventRow | undefined): string {
  const meta = event?.metadata;
  if (!meta || typeof meta !== 'object') return 'unknown';
  const m = meta as Record<string, unknown>;
  const candidate =
    m.tenant_id ?? m.tenantId ?? m.tenant ?? (m.identity as Record<string, unknown> | undefined)?.tenant_id;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : 'unknown';
}

/**
 * Build a read-only preview summary from the query result and the projected
 * rows. `events` is the raw consent-gated query output (defines rows_total and
 * carries metadata for tenant grouping); `projected` is what the target's own
 * projector produced (i.e. exactly the rows that WOULD be written, pre-dedup).
 *
 * Writes nothing. Pure function — unit-testable without prod access.
 */
export function summarizePreview(
  target: DatasetTarget,
  events: OasisEventRow[],
  projected: DatasetRow[],
): DatasetExtractionPreview {
  const eventById = new Map<string, OasisEventRow>();
  for (const e of events) eventById.set(e.id, e);

  const byTenant: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const row of projected) {
    const event = eventById.get(row.source_id);
    const tenant = tenantKeyFromEvent(event);
    const source = event?.topic ?? 'unknown';
    byTenant[tenant] = (byTenant[tenant] ?? 0) + 1;
    bySource[source] = (bySource[source] ?? 0) + 1;
  }

  const deduped = dedupeBySourceId(projected);

  return {
    target,
    preview: true,
    rows_total: events.length,
    rows_projected: projected.length,
    rows_after_dedup: deduped.length,
    by_tenant: byTenant,
    by_source: bySource,
    samples: deduped.slice(0, Math.max(0, PREVIEW_SAMPLE_LIMIT)),
  };
}
