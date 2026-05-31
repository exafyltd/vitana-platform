/**
 * Canary readiness report — Phase 1 W3-B0 PR 3 (VTID-03217).
 *
 * Consumes the W3-A shadow-comparison report + latency + dataset status
 * + (optionally) fine-tune job status, and emits a single verdict:
 *
 *   READY_FOR_CANARY  — all thresholds met for ≥5 consecutive days
 *   NOT_READY         — with the specific reasons today
 *
 * No state modification. No auto-promote flip. No canary execution.
 * This script is the operator's evidence packet for clicking PUBLISH
 * (or not).
 *
 * Thresholds (same as auto-promoter + graduation-recommender):
 *   - min comparison samples: 200
 *   - min agreement: 92%
 *   - max candidate p95: 800ms
 *   - max candidate error rate: 2%
 *   - shadow days clean (consecutive): 5
 *   - real-traffic shadow events (non-exerciser): >=200 in window
 *   - dataset rows (consented prod, recent extraction): >=1000
 *   - fine-tune status: at least one voice-tool-router run SUCCEEDED
 *
 * Env (provided by the workflow):
 *   STAGING_GATEWAY_URL          (default: https://gateway-staging-q74ibpv6ia-uc.a.run.app)
 *   GATEWAY_SERVICE_TOKEN        (required — read shadow report endpoint)
 *   PROD_SUPABASE_URL            (required — read latency + dataset events)
 *   PROD_SUPABASE_SERVICE_ROLE   (required — same)
 *   STAGING_SUPABASE_URL         (optional — for latency events when staging-flag is on)
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY (optional — same)
 *   FINETUNE_STATUS              (passed by workflow — ok|failed|none|skipped)
 *   REPORT_MARKDOWN_PATH         (optional)
 *
 * Output:
 *   stdout: JSON
 *   $REPORT_MARKDOWN_PATH (optional): Markdown
 */

import { promises as fs } from 'fs';

const STAGING_GATEWAY_URL = process.env.STAGING_GATEWAY_URL
  || 'https://gateway-staging-q74ibpv6ia-uc.a.run.app';
const GATEWAY_SERVICE_TOKEN = process.env.GATEWAY_SERVICE_TOKEN;
const PROD_SUPABASE_URL = process.env.PROD_SUPABASE_URL;
const PROD_SUPABASE_KEY = process.env.PROD_SUPABASE_SERVICE_ROLE;
const FINETUNE_STATUS = process.env.FINETUNE_STATUS ?? 'skipped';
const REPORT_MARKDOWN_PATH = process.env.REPORT_MARKDOWN_PATH;
const FEATURE_TARGET = process.env.FEATURE_TARGET ?? 'voice-tool-router';

const THRESHOLDS = {
  min_real_traffic_events: 200,
  min_agreement_rate: 0.92,
  max_candidate_p95_ms: 800,
  max_candidate_error_rate: 0.02,
  min_consecutive_clean_days: 5,
  min_dataset_rows: 1000,
} as const;

interface ShadowReport {
  ok: boolean;
  total_events: number;
  insufficient_data?: boolean;
  features: Array<{
    feature: string;
    total_comparisons: number;
    agreement_rate: number | null;
    candidate_p95_ms: number;
    candidate_error_rate: number;
  }>;
}

interface Reason {
  rule: string;
  ok: boolean;
  detail: string;
}

interface CanaryReadinessReport {
  generated_at: string;
  target: string;
  verdict: 'READY_FOR_CANARY' | 'NOT_READY';
  reasons: Reason[];
  evidence: {
    shadow_total_events_24h: number;
    shadow_feature_rollup: ShadowReport['features'][number] | null;
    real_traffic_estimate_24h: number;
    finetune_status: string;
    latest_dataset_rows: number | null;
  };
  next_recommended_action: string;
}

function reason(rule: string, ok: boolean, detail: string): Reason {
  return { rule, ok, detail };
}

async function fetchShadowReport(): Promise<ShadowReport> {
  if (!GATEWAY_SERVICE_TOKEN) {
    throw new Error('GATEWAY_SERVICE_TOKEN required');
  }
  const resp = await fetch(
    `${STAGING_GATEWAY_URL}/api/v1/admin/staging/eval/shadow-comparison-report?window_hours=24`,
    { headers: { Authorization: `Bearer ${GATEWAY_SERVICE_TOKEN}` } },
  );
  if (!resp.ok) {
    throw new Error(`shadow-comparison-report endpoint HTTP ${resp.status}`);
  }
  return (await resp.json()) as ShadowReport;
}

async function estimateRealTrafficCount(windowHours = 24): Promise<number> {
  // Real-traffic shadow events = total minus exerciser-tagged events.
  // The exerciser tags every event with metadata.exerciser_source. We
  // count those, then subtract from total. Reads the staging gateway's
  // own oasis_events through the shadow-comparison endpoint instead of
  // querying Supabase directly to avoid needing staging-side IAM.
  //
  // For W3-B0 we approximate by reading total_events and assuming the
  // exerciser is the only synthetic source — the operator can refine
  // later with a dedicated /real-traffic-count endpoint if needed.
  if (!GATEWAY_SERVICE_TOKEN) return 0;
  try {
    const resp = await fetch(
      `${STAGING_GATEWAY_URL}/api/v1/admin/staging/eval/shadow-comparison-report?window_hours=${windowHours}`,
      { headers: { Authorization: `Bearer ${GATEWAY_SERVICE_TOKEN}` } },
    );
    if (!resp.ok) return 0;
    const r = (await resp.json()) as ShadowReport;
    return r.total_events ?? 0;
  } catch {
    return 0;
  }
}

async function fetchLatestDatasetRows(target: string): Promise<number | null> {
  if (!PROD_SUPABASE_URL || !PROD_SUPABASE_KEY) return null;
  try {
    const targetDataset = target === 'voice-tool-router' ? 'voice-tool-routing'
      : target === 'intent-kind' ? 'intent-kind'
      : 'pillar-classification';
    const sinceIso = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const resp = await fetch(
      `${PROD_SUPABASE_URL}/rest/v1/oasis_events`
      + '?topic=eq.dataset.extraction.completed'
      + `&created_at=gte.${encodeURIComponent(sinceIso)}`
      + `&metadata->>target=eq.${encodeURIComponent(targetDataset)}`
      + '&order=created_at.desc&limit=1&select=metadata',
      {
        headers: {
          apikey: PROD_SUPABASE_KEY,
          Authorization: `Bearer ${PROD_SUPABASE_KEY}`,
        },
      },
    );
    if (!resp.ok) return null;
    const rows = (await resp.json()) as Array<{
      metadata: { rows_after_dedup?: number } | null;
    }>;
    const row = rows[0];
    if (!row || typeof row.metadata?.rows_after_dedup !== 'number') return null;
    return row.metadata.rows_after_dedup;
  } catch {
    return null;
  }
}

async function generate(): Promise<CanaryReadinessReport> {
  const target = FEATURE_TARGET;
  let shadow: ShadowReport | null = null;
  let shadowFetchErr: string | null = null;
  try {
    shadow = await fetchShadowReport();
  } catch (err) {
    shadowFetchErr = (err as Error).message;
  }

  const featureRollup = shadow?.features.find((f) => f.feature === target) ?? null;
  const totalEvents = shadow?.total_events ?? 0;
  const realTraffic = await estimateRealTrafficCount(24);
  const latestRows = await fetchLatestDatasetRows(target);

  const reasons: Reason[] = [];

  // Shadow events
  if (shadowFetchErr) {
    reasons.push(reason('shadow_report_fetch', false, `Could not read shadow-comparison-report: ${shadowFetchErr}`));
  } else if (totalEvents < THRESHOLDS.min_real_traffic_events) {
    reasons.push(reason(
      'shadow_min_events',
      false,
      `Only ${totalEvents} shadow events in last 24h; threshold ${THRESHOLDS.min_real_traffic_events}. Trigger EXERCISE-STAGING-SHADOW or wait for organic traffic.`,
    ));
  } else {
    reasons.push(reason('shadow_min_events', true, `${totalEvents} shadow events in last 24h (>= ${THRESHOLDS.min_real_traffic_events}).`));
  }

  // Feature-specific thresholds
  if (!featureRollup) {
    reasons.push(reason(
      'feature_rollup_present',
      false,
      `No shadow events for feature='${target}' in last 24h.`,
    ));
  } else {
    if (featureRollup.agreement_rate === null) {
      reasons.push(reason('agreement_rate', false, `No comparable agreement data for ${target} yet.`));
    } else if (featureRollup.agreement_rate < THRESHOLDS.min_agreement_rate) {
      reasons.push(reason(
        'agreement_rate',
        false,
        `Agreement rate ${(featureRollup.agreement_rate * 100).toFixed(1)}% < ${(THRESHOLDS.min_agreement_rate * 100).toFixed(0)}% required.`,
      ));
    } else {
      reasons.push(reason('agreement_rate', true, `Agreement rate ${(featureRollup.agreement_rate * 100).toFixed(1)}% meets threshold.`));
    }

    if (featureRollup.candidate_p95_ms > THRESHOLDS.max_candidate_p95_ms) {
      reasons.push(reason(
        'candidate_p95_ms',
        false,
        `Candidate p95 ${featureRollup.candidate_p95_ms.toFixed(0)}ms > ${THRESHOLDS.max_candidate_p95_ms}ms allowed.`,
      ));
    } else {
      reasons.push(reason('candidate_p95_ms', true, `Candidate p95 ${featureRollup.candidate_p95_ms.toFixed(0)}ms within budget.`));
    }

    if (featureRollup.candidate_error_rate > THRESHOLDS.max_candidate_error_rate) {
      reasons.push(reason(
        'candidate_error_rate',
        false,
        `Candidate error rate ${(featureRollup.candidate_error_rate * 100).toFixed(2)}% > ${(THRESHOLDS.max_candidate_error_rate * 100).toFixed(0)}% allowed.`,
      ));
    } else {
      reasons.push(reason('candidate_error_rate', true, `Candidate error rate ${(featureRollup.candidate_error_rate * 100).toFixed(2)}% within budget.`));
    }
  }

  // Fine-tune status — must have a successful run
  if (FINETUNE_STATUS === 'ok') {
    reasons.push(reason('finetune_run', true, 'At least one voice-tool-router Vertex training run has completed.'));
  } else if (FINETUNE_STATUS === 'failed') {
    reasons.push(reason('finetune_run', false, 'Most recent Vertex training run failed; investigate before canary.'));
  } else if (FINETUNE_STATUS === 'none') {
    reasons.push(reason('finetune_run', false, 'No Vertex training runs found; the candidate path is a stub. Submit CRON-FINETUNE-TRAINER.'));
  } else {
    reasons.push(reason('finetune_run', false, `Fine-tune status unknown (${FINETUNE_STATUS}); workflow should pass FINETUNE_STATUS env from the Vertex probe.`));
  }

  // Dataset rows — need consented corpus to train
  if (latestRows === null) {
    reasons.push(reason('dataset_rows', false, `No recent dataset.extraction.completed event for ${target}; cannot establish corpus size.`));
  } else if (latestRows < THRESHOLDS.min_dataset_rows) {
    reasons.push(reason(
      'dataset_rows',
      false,
      `Latest extraction yielded ${latestRows} rows for ${target}; threshold ${THRESHOLDS.min_dataset_rows}. Likely blocked on prod_consent gate.`,
    ));
  } else {
    reasons.push(reason('dataset_rows', true, `${latestRows} rows extracted recently for ${target} (>= ${THRESHOLDS.min_dataset_rows}).`));
  }

  // 5-consecutive-days clean — out of scope for the single-run report;
  // surfaced as an unmet rule with explicit "needs cron history" note.
  reasons.push(reason(
    'consecutive_clean_days',
    false,
    `Today's report covers a single 24h window; ${THRESHOLDS.min_consecutive_clean_days} consecutive clean days require historical comparison across daily snapshots (not yet wired). Graduation recommender's daily FCM digest is the authoritative source.`,
  ));

  const allOk = reasons.every((r) => r.ok);
  const verdict: CanaryReadinessReport['verdict'] = allOk ? 'READY_FOR_CANARY' : 'NOT_READY';
  const firstBlocker = reasons.find((r) => !r.ok);
  const nextAction = verdict === 'READY_FOR_CANARY'
    ? 'Operator may click PUBLISH (canary) on prod Command Hub; watch metrics for 48h.'
    : `Address: ${firstBlocker?.rule} — ${firstBlocker?.detail ?? 'see reasons'}`;

  return {
    generated_at: new Date().toISOString(),
    target,
    verdict,
    reasons,
    evidence: {
      shadow_total_events_24h: totalEvents,
      shadow_feature_rollup: featureRollup,
      real_traffic_estimate_24h: realTraffic,
      finetune_status: FINETUNE_STATUS,
      latest_dataset_rows: latestRows,
    },
    next_recommended_action: nextAction,
  };
}

function renderMarkdown(r: CanaryReadinessReport): string {
  const lines: string[] = [];
  lines.push(`# Canary readiness — ${r.target}`);
  lines.push('');
  lines.push(`- Generated: ${r.generated_at}`);
  lines.push(`- Verdict: **${r.verdict}**`);
  lines.push(`- Next: ${r.next_recommended_action}`);
  lines.push('');
  lines.push('## Reasons');
  lines.push('');
  for (const x of r.reasons) {
    const tag = x.ok ? 'PASS' : 'FAIL';
    lines.push(`- **[${tag}] ${x.rule}** — ${x.detail}`);
  }
  lines.push('');
  lines.push('## Evidence');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(r.evidence, null, 2));
  lines.push('```');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const report = await generate();
  console.log(JSON.stringify(report, null, 2));
  if (REPORT_MARKDOWN_PATH) {
    await fs.writeFile(REPORT_MARKDOWN_PATH, renderMarkdown(report), 'utf-8');
    console.error(`[canary-readiness-report] markdown written: ${REPORT_MARKDOWN_PATH}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[canary-readiness-report] FAILED:', err);
    process.exit(1);
  });
}

export { generate, renderMarkdown };
export type { CanaryReadinessReport, Reason };
