#!/usr/bin/env -S npx -y tsx
/**
 * mirror-preflight.ts — BOOTSTRAP-EVIDENCE-ARTIFACTS.
 *
 * Dry-run / preflight for MIRROR-ARTIFACTS-S3.yml. Reports exactly WHAT the
 * dormant mirror job WOULD copy GCS -> S3, WITHOUT needing the AWS secrets.
 *
 * The real mirror job (and the smoke) refuse without AWS_BUCKET / AWS_ROLE_ARN.
 * That makes the GCS->S3 wiring un-inspectable until an operator provisions
 * AWS — you can't see whether there's anything to mirror. This preflight
 * closes that gap: it enumerates the GCS source side ONLY (gsutil ls), using
 * the SAME source globs the mirror job uses, and prints a manifest of what
 * would be mirrored plus the S3 destination keys it would write to.
 *
 * It NEVER touches AWS, NEVER copies anything, NEVER deletes anything — pure
 * read-only enumeration of the GCS staging bucket. Safe to run on the daily
 * schedule alongside the dormant mirror.
 *
 * The three source groups mirror the MIRROR-ARTIFACTS-S3.yml job exactly:
 *   1. per-target current weights:  finetune-current/<target>/weights.tar.gz
 *   2. eval-coverage reports:       eval-reports/**
 *   3. dataset manifests:           datasets/<name>/manifest.json
 *
 * Output:
 *   stdout: JSON manifest
 *   $PREFLIGHT_MARKDOWN_PATH (env, optional): Markdown manifest file
 *
 * Env:
 *   STAGING_BUCKET (default gs://vitana-artifacts-staging)
 *   AWS_BUCKET     (optional — used only to render the destination S3 keys;
 *                   when empty, destinations show as s3://<AWS_BUCKET>/... so
 *                   the manifest is still readable pre-provisioning)
 */
import { execFileSync } from 'node:child_process';

const STAGING_BUCKET = process.env.STAGING_BUCKET || 'gs://vitana-artifacts-staging';
const AWS_BUCKET = process.env.AWS_BUCKET || '';
const PREFLIGHT_MARKDOWN_PATH = process.env.PREFLIGHT_MARKDOWN_PATH;
const TARGETS = ['voice-tool-router', 'intent-kind', 'pillar-classifier'] as const;

/** Run gsutil; return stdout lines. Missing path / non-zero exit => []. */
function gsutilLs(pattern: string): string[] {
  try {
    const out = execFileSync('gsutil', ['ls', pattern], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('gs://'));
  } catch {
    // gsutil exits non-zero when the glob matches nothing — that's an
    // expected "nothing to mirror yet" state, not an error.
    return [];
  }
}

/** Convert a gs:// source URI to the S3 destination the mirror job would use. */
function s3Dest(gsUri: string, group: 'weights' | 'eval' | 'manifest'): string {
  const bucket = AWS_BUCKET || '<AWS_BUCKET>';
  // Mirror job preserves the path under the staging bucket root.
  const rel = gsUri.replace(`${STAGING_BUCKET}/`, '');
  switch (group) {
    case 'weights':
    case 'eval':
    case 'manifest':
      return `s3://${bucket}/${rel}`;
  }
}

interface MirrorItem {
  group: 'weights' | 'eval-reports' | 'dataset-manifests';
  source: string;
  destination: string;
}

interface PreflightManifest {
  generated_at: string;
  staging_bucket: string;
  aws_bucket_set: boolean;
  would_mirror_count: number;
  groups: {
    weights: { target: string; present: boolean; source: string; destination: string }[];
    eval_reports: { source: string; destination: string }[];
    dataset_manifests: { name: string; source: string; destination: string }[];
  };
  items: MirrorItem[];
}

function buildManifest(): PreflightManifest {
  const items: MirrorItem[] = [];

  // 1. Per-target current weights (exact path the mirror job checks).
  const weights = TARGETS.map((target) => {
    const src = `${STAGING_BUCKET}/finetune-current/${target}/weights.tar.gz`;
    const present = gsutilLs(src).length > 0;
    const dest = s3Dest(src, 'weights');
    if (present) items.push({ group: 'weights', source: src, destination: dest });
    return { target, present, source: src, destination: dest };
  });

  // 2. Eval-coverage reports (rsync of the whole prefix).
  const evalFiles = gsutilLs(`${STAGING_BUCKET}/eval-reports/**`);
  const eval_reports = evalFiles.map((src) => {
    const dest = s3Dest(src, 'eval');
    items.push({ group: 'eval-reports', source: src, destination: dest });
    return { source: src, destination: dest };
  });

  // 3. Dataset manifests (one per dataset dir).
  const manifestFiles = gsutilLs(`${STAGING_BUCKET}/datasets/*/manifest.json`);
  const dataset_manifests = manifestFiles.map((src) => {
    const m = src.match(/\/datasets\/([^/]+)\/manifest\.json$/);
    const name = m ? m[1] : 'unknown';
    const dest = s3Dest(src, 'manifest');
    items.push({ group: 'dataset-manifests', source: src, destination: dest });
    return { name, source: src, destination: dest };
  });

  return {
    generated_at: new Date().toISOString(),
    staging_bucket: STAGING_BUCKET,
    aws_bucket_set: AWS_BUCKET.length > 0,
    would_mirror_count: items.length,
    groups: { weights, eval_reports, dataset_manifests },
    items,
  };
}

function renderMarkdown(m: PreflightManifest): string {
  const L: string[] = [];
  L.push('# MIRROR-ARTIFACTS-S3 preflight (dry-run)');
  L.push('');
  L.push(`- Generated: ${m.generated_at}`);
  L.push(`- Staging bucket: \`${m.staging_bucket}\``);
  L.push(`- AWS_BUCKET secret set: **${m.aws_bucket_set ? 'YES' : 'NO (destinations shown as placeholder)'}**`);
  L.push(`- Objects that WOULD mirror: **${m.would_mirror_count}**`);
  L.push('');
  L.push('> Read-only GCS enumeration. No AWS calls, no copies, no deletes.');
  L.push('> Proves the GCS source side of the mirror without the AWS secrets.');
  L.push('');

  L.push('## Weights (per target)');
  L.push('');
  L.push('| Target | Present | Source | Destination |');
  L.push('| --- | --- | --- | --- |');
  for (const w of m.groups.weights) {
    L.push(`| ${w.target} | ${w.present ? 'yes' : 'no'} | \`${w.source}\` | \`${w.destination}\` |`);
  }
  L.push('');

  L.push('## Eval-coverage reports');
  L.push('');
  if (m.groups.eval_reports.length === 0) {
    L.push('_None present in GCS yet._');
  } else {
    L.push('| Source | Destination |');
    L.push('| --- | --- |');
    for (const e of m.groups.eval_reports) {
      L.push(`| \`${e.source}\` | \`${e.destination}\` |`);
    }
  }
  L.push('');

  L.push('## Dataset manifests');
  L.push('');
  if (m.groups.dataset_manifests.length === 0) {
    L.push('_None present in GCS yet._');
  } else {
    L.push('| Dataset | Source | Destination |');
    L.push('| --- | --- | --- |');
    for (const d of m.groups.dataset_manifests) {
      L.push(`| ${d.name} | \`${d.source}\` | \`${d.destination}\` |`);
    }
  }
  L.push('');

  if (m.would_mirror_count === 0) {
    L.push('> Nothing to mirror yet — expected pre-W3 (no weights, reports, or manifests in staging).');
    L.push('> Once `STAGE-ARTIFACTS-GCS.yml` and the dataset/eval crons populate these prefixes,');
    L.push('> this preflight will enumerate them and the dormant mirror will carry them once AWS lands.');
  }
  L.push('');
  return L.join('\n') + '\n';
}

function main(): void {
  const manifest = buildManifest();
  console.log(JSON.stringify(manifest, null, 2));
  if (PREFLIGHT_MARKDOWN_PATH) {
    // Synchronous write — small file, keeps this script dep-free.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(PREFLIGHT_MARKDOWN_PATH, renderMarkdown(manifest), 'utf-8');
    console.error(`[mirror-preflight] markdown written: ${PREFLIGHT_MARKDOWN_PATH}`);
  }
}

if (require.main === module) {
  main();
}

export { buildManifest, renderMarkdown };
export type { PreflightManifest, MirrorItem };
