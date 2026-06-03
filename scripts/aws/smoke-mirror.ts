#!/usr/bin/env -S npx -y tsx
/**
 * smoke-mirror.ts — VTID-03200 (Phase 1 W2, Track A — AWS S3 runway)
 *
 * Proves the GCS -> S3 mirror wiring end-to-end against a tiny NON-WEIGHT
 * marker file, BEFORE any real fine-tune weights exist. Used by
 * .github/workflows/SMOKE-AWS-MIRROR.yml (workflow_dispatch only).
 *
 *   1. Write a dated marker file to GCS  (gs://<staging>/smoke/<marker>)
 *   2. Run the same mirror logic the dormant MIRROR-ARTIFACTS-S3 job uses
 *      (gsutil cp -> local -> aws s3 cp)
 *   3. Assert the marker appears in S3  (aws s3api head-object)
 *   4. Best-effort cleanup of both copies
 *
 * Refuses (exit 1) with a clear message if the AWS secrets are not set, so
 * a dispatch with empty secrets fails loudly instead of silently no-op-ing.
 *
 * No new npm deps: shells out to the `gsutil` and `aws` CLIs that the GitHub
 * runner already provides (same approach as the YAML mirror job).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STAGING_BUCKET = process.env.STAGING_BUCKET || 'gs://vitana-artifacts-staging';
const AWS_BUCKET = process.env.AWS_BUCKET || '';
const AWS_ROLE_ARN = process.env.AWS_ROLE_ARN || '';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

function fail(msg: string): never {
  console.error(`smoke-mirror: ERROR — ${msg}`);
  process.exit(1);
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

// --- Guard: refuse without AWS secrets (clear, exact messages) ----------
if (!AWS_BUCKET) fail('AWS_BUCKET secret not set');
if (!AWS_ROLE_ARN) fail('AWS_ROLE_ARN secret not set');

console.log(`smoke-mirror: staging=${STAGING_BUCKET} aws_bucket=${AWS_BUCKET} region=${AWS_REGION}`);

// --- 1. Build a dated marker file --------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const rand = Math.random().toString(36).slice(2, 8);
const markerName = `marker-${stamp}-${rand}.txt`;
const gcsMarker = `${STAGING_BUCKET}/smoke/${markerName}`;
const s3Marker = `s3://${AWS_BUCKET}/smoke/${markerName}`;
const s3Key = `smoke/${markerName}`;

const workdir = mkdtempSync(join(tmpdir(), 'aws-smoke-'));
const localUp = join(workdir, markerName);
const localDown = join(workdir, `down-${markerName}`);
writeFileSync(localUp, `vitana aws-mirror smoke @ ${new Date().toISOString()}\n`);

let ok = false;
try {
  // --- 1. Write marker to GCS -----------------------------------------
  console.log(`smoke-mirror: writing marker -> ${gcsMarker}`);
  run('gsutil', ['cp', localUp, gcsMarker]);

  // --- 2. Mirror GCS -> S3 (same shape as the YAML weights mirror) ----
  console.log('smoke-mirror: mirroring GCS -> S3');
  run('gsutil', ['cp', gcsMarker, localDown]);
  run('aws', ['s3', 'cp', localDown, s3Marker, '--region', AWS_REGION]);

  // --- 3. Assert it landed in S3 --------------------------------------
  console.log(`smoke-mirror: asserting ${s3Marker} exists`);
  run('aws', ['s3api', 'head-object', '--bucket', AWS_BUCKET, '--key', s3Key, '--region', AWS_REGION]);
  ok = true;
  console.log('smoke-mirror: PASS — marker round-tripped GCS -> S3');
} catch (err) {
  console.error('smoke-mirror: mirror/assert step failed');
  if (err instanceof Error) console.error(err.message);
} finally {
  // --- 4. Best-effort cleanup -----------------------------------------
  try { run('gsutil', ['rm', '-f', gcsMarker]); } catch { /* ignore */ }
  try { run('aws', ['s3', 'rm', s3Marker, '--region', AWS_REGION]); } catch { /* ignore */ }
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (!ok) fail('smoke test did not confirm the marker in S3');
