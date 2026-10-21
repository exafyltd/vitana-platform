/**
 * Vertex CustomJob status monitor runner — Training Ops
 * (BOOTSTRAP-TRAINING-OPS-MONITOR).
 *
 * Read-only monitor for the fine-tune pipeline. The submit path
 * (submit-job.ts / CRON-FINETUNE-TRAINER.yml) is fire-and-forget; this script
 * answers "what is the latest <target> job actually doing right now?" by:
 *   1. `gcloud ai custom-jobs list` to find the latest run for the target's
 *      display-name prefix (or describing an explicit FINETUNE_JOB_ID).
 *   2. `gcloud ai custom-jobs describe` for the full state/timestamps/error.
 *   3. classifyJob() (pure, in status-monitor-lib.ts) -> verdict + quota-wait.
 *   4. Writes a Markdown summary to docs/ (and the GitHub step summary when
 *      run in CI) and optionally emits an OASIS `finetune.job.status` event.
 *
 * This NEVER creates, cancels, or mutates a job — describe/list only.
 *
 * Run: `npx tsx scripts/finetune/status-monitor.ts <target>`
 *      target: voice-tool-router | intent-kind | pillar-classifier
 *
 * Env:
 *   GCP_PROJECT (default lovable-vitana-vers1)
 *   FINETUNE_REGION  — override region to query (default: target config.yaml)
 *   FINETUNE_JOB_ID  — describe this exact numeric job id instead of listing
 *   FINETUNE_STATUS_OUT — output Markdown path (default docs/finetune-status-<target>.md)
 *   STAGING_SUPABASE_URL / STAGING_SUPABASE_SERVICE_ROLE_KEY — if both set,
 *     emit an OASIS finetune.job.status event to staging oasis_events.
 *   GITHUB_STEP_SUMMARY — when set (CI), the summary is appended there too.
 */

import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import {
  classifyJob,
  pickLatestJob,
  verdictToEventStatus,
  type FinetuneStatusReport,
  type VertexJobDescribe,
} from './status-monitor-lib';

const TARGET = process.argv[2];
const VALID_TARGETS = new Set(['voice-tool-router', 'intent-kind', 'pillar-classifier']);
const GCP_PROJECT = process.env.GCP_PROJECT || 'lovable-vitana-vers1';
const JOB_ID = (process.env.FINETUNE_JOB_ID || '').trim();
const REGION_OVERRIDE = (process.env.FINETUNE_REGION || '').trim();
const STAGING_URL = process.env.STAGING_SUPABASE_URL;
const STAGING_KEY = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY;

if (!TARGET || !VALID_TARGETS.has(TARGET)) {
  console.error(`Usage: tsx status-monitor.ts <target>\n  target: ${[...VALID_TARGETS].join(' | ')}`);
  process.exit(2);
}

interface TargetConfig {
  region: string;
  displayNamePrefix: string;
}

async function loadTargetConfig(): Promise<TargetConfig> {
  const configPath = path.join(__dirname, TARGET, 'config.yaml');
  const raw = await fs.readFile(configPath, 'utf-8');
  const jsYaml = await import('js-yaml');
  const cfg = jsYaml.load(raw) as {
    vertex_custom_job: { region: string; display_name_prefix: string };
  };
  return {
    region: REGION_OVERRIDE || cfg.vertex_custom_job.region,
    displayNamePrefix: cfg.vertex_custom_job.display_name_prefix,
  };
}

const DESCRIBE_FORMAT = 'json(name,displayName,state,createTime,startTime,endTime,error)';

function describeJob(jobId: string, region: string): VertexJobDescribe {
  const out = execSync(
    `gcloud ai custom-jobs describe ${shellQuote(jobId)} ` +
      `--project=${shellQuote(GCP_PROJECT)} --region=${shellQuote(region)} ` +
      `--format=${shellQuote(DESCRIBE_FORMAT)}`,
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(out) as VertexJobDescribe;
}

function listJobsForPrefix(prefix: string, region: string): VertexJobDescribe[] {
  // `list` does not server-side filter on a displayName prefix reliably across
  // gcloud versions, so we pull recent jobs and filter client-side.
  const out = execSync(
    `gcloud ai custom-jobs list ` +
      `--project=${shellQuote(GCP_PROJECT)} --region=${shellQuote(region)} ` +
      `--sort-by=~createTime --limit=50 ` +
      `--format=${shellQuote(DESCRIBE_FORMAT.replace('json(', 'json('))}`,
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const all = (JSON.parse(out || '[]') as VertexJobDescribe[]) || [];
  return all.filter((j) => (j.displayName || '').startsWith(prefix));
}

function renderMarkdown(report: FinetuneStatusReport, region: string): string {
  const stamp = new Date().toISOString();
  return [
    `# Fine-tune status — ${TARGET}`,
    '',
    `_Generated ${stamp} (BOOTSTRAP-TRAINING-OPS-MONITOR, read-only)_`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Target | \`${TARGET}\` |`,
    `| Region | \`${region}\` |`,
    `| Job ID | ${report.jobId ? `\`${report.jobId}\`` : '_(none found)_'} |`,
    `| Display name | ${report.displayName ? `\`${report.displayName}\`` : '—'} |`,
    `| State | \`${report.state}\` |`,
    `| Verdict | **${report.verdict}** |`,
    `| Quota wait | ${report.quotaWait ? '⚠️ YES' : 'no'} |`,
    `| Needs attention | ${report.needsAttention ? 'YES' : 'no'} |`,
    `| Age (min) | ${report.ageMinutes ?? '—'} |`,
    `| Error | ${report.errorMessage ? `\`${report.errorMessage}\`` : '—'} |`,
    '',
    `> ${report.summary}`,
    '',
    report.quotaWait
      ? '**Action:** the job was accepted but never started — almost certainly GPU ' +
        'quota pressure (Google credits only begin once a job STARTS). Re-submit via ' +
        'CRON-FINETUNE-TRAINER with `region_override` / `accelerator_type_override` ' +
        '(PR #2515) to capacity that has quota.'
      : '',
    '',
  ].join('\n');
}

async function emitOasisEvent(report: FinetuneStatusReport, region: string): Promise<void> {
  if (!STAGING_URL || !STAGING_KEY) {
    console.log('[status-monitor] STAGING_SUPABASE_* not set — skipping OASIS event emit');
    return;
  }
  const body = {
    vtid: 'VTID-03179',
    topic: 'finetune.job.status',
    service: 'gateway/finetune-status-monitor',
    role: 'CICD',
    model: 'finetune-status-monitor',
    status: verdictToEventStatus(report.verdict),
    message: report.summary,
    metadata: {
      env: 'staging',
      target: TARGET,
      region,
      job_id: report.jobId,
      display_name: report.displayName,
      state: report.state,
      verdict: report.verdict,
      quota_wait: report.quotaWait,
      needs_attention: report.needsAttention,
      age_minutes: report.ageMinutes,
      error_message: report.errorMessage,
    },
  };
  try {
    await fetch(`${STAGING_URL}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: STAGING_KEY,
        Authorization: `Bearer ${STAGING_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(body),
    });
    console.log('[status-monitor] emitted OASIS finetune.job.status event');
  } catch (err) {
    console.error('[status-monitor] OASIS event emit failed:', err);
  }
}

async function main(): Promise<void> {
  const { region, displayNamePrefix } = await loadTargetConfig();
  console.log(`[status-monitor] target=${TARGET} region=${region} prefix=${displayNamePrefix}`);

  let job: VertexJobDescribe | null = null;
  try {
    if (JOB_ID) {
      console.log(`[status-monitor] describing explicit job ${JOB_ID}`);
      job = describeJob(JOB_ID, region);
    } else {
      const jobs = listJobsForPrefix(displayNamePrefix, region);
      console.log(`[status-monitor] found ${jobs.length} job(s) matching prefix`);
      job = pickLatestJob(jobs);
    }
  } catch (err) {
    console.error('[status-monitor] gcloud query failed:', err);
    // Still emit an UNKNOWN report so the operator sees the monitor ran.
    job = null;
  }

  const report = classifyJob(job ?? {}, Date.now());
  console.log(`[status-monitor] verdict=${report.verdict} quotaWait=${report.quotaWait}`);
  console.log(`[status-monitor] ${report.summary}`);

  const md = renderMarkdown(report, region);
  const outPath = process.env.FINETUNE_STATUS_OUT
    ? path.resolve(process.env.FINETUNE_STATUS_OUT)
    : path.join(__dirname, '..', '..', '..', '..', 'docs', `finetune-status-${TARGET}.md`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, md, 'utf-8');
  console.log(`[status-monitor] wrote status summary -> ${outPath}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `\n${md}\n`, 'utf-8');
  }

  await emitOasisEvent(report, region);

  // Machine-readable line for downstream tooling / log scraping.
  console.log(`[status-monitor] result ${JSON.stringify(report)}`);
}

function shellQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

main();
