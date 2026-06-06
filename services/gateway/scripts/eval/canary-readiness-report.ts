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
 *   FINETUNE_STATUS              (passed by workflow — ok|iam_blocked|failed|none|skipped)
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
  // BOOTSTRAP-SHADOW-CORPUS-ACCURACY: ground-truth accuracy gate. Agreement
  // alone can't catch two models confidently agreeing on the WRONG tool — only
  // accuracy-vs-truth can. These apply once the window carries enough
  // golden-corpus-grounded comparisons (events with primary_correct /
  // candidate_correct) to be statistically meaningful.
  min_labeled_comparisons: 50,
  min_candidate_accuracy: 0.85,
  // The candidate may not be materially worse than the primary it would replace.
  max_accuracy_regression: 0.05,
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
    // Ground-truth accuracy (present once corpus-grounded shadow events land).
    labeled_comparisons?: number;
    primary_accuracy?: number | null;
    candidate_accuracy?: number | null;
    // Real-model-only accuracy (excludes simulated_models=true). The gate keys
    // off these so a candidate never graduates on simulated evidence.
    real_labeled_comparisons?: number;
    real_primary_accuracy?: number | null;
    real_candidate_accuracy?: number | null;
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
    snapshot_date: string;
    clean_today: boolean;
    consecutive_clean_days: number;
  };
  next_recommended_action: string;
}

function reason(rule: string, ok: boolean, detail: string): Reason {
  return { rule, ok, detail };
}

/**
 * BOOTSTRAP-SHADOW-CORPUS-ACCURACY: ground-truth accuracy gate.
 *
 * Pure + exported so it's unit-tested without the network/env the rest of this
 * script needs. Returns the `candidate_accuracy` Reason for a feature rollup:
 *   - Not enough labeled (golden-corpus-grounded) comparisons → FAIL with a
 *     "run the corpus exerciser" nudge (consistent with how every other
 *     insufficient-evidence rule blocks here).
 *   - Candidate below the absolute floor → FAIL.
 *   - Candidate materially worse than the primary it would replace → FAIL.
 *   - Otherwise → PASS with the numbers.
 */
function accuracyReason(
  rollup: Pick<ShadowReport['features'][number], 'real_labeled_comparisons' | 'real_primary_accuracy' | 'real_candidate_accuracy'> | null,
  thresholds: Pick<typeof THRESHOLDS, 'min_labeled_comparisons' | 'min_candidate_accuracy' | 'max_accuracy_regression'> = THRESHOLDS,
): Reason {
  // Real-model evidence ONLY — simulated comparisons never graduate a candidate.
  const labeled = rollup?.real_labeled_comparisons ?? 0;
  const candAcc = rollup?.real_candidate_accuracy ?? null;
  const primAcc = rollup?.real_primary_accuracy ?? null;

  if (labeled < thresholds.min_labeled_comparisons || candAcc === null) {
    return reason(
      'candidate_accuracy',
      false,
      `Only ${labeled} REAL (non-simulated) corpus-grounded comparisons (need ${thresholds.min_labeled_comparisons}). Deploy the fine-tuned candidate to a Vertex endpoint (set CANDIDATE_ENDPOINT__voice_tool_router) and run EXERCISE-STAGING-SHADOW with source=golden-corpus — simulated comparisons do not count toward readiness.`,
    );
  }
  if (candAcc < thresholds.min_candidate_accuracy) {
    return reason(
      'candidate_accuracy',
      false,
      `Candidate accuracy ${(candAcc * 100).toFixed(1)}% < ${(thresholds.min_candidate_accuracy * 100).toFixed(0)}% floor (over ${labeled} labeled turns).`,
    );
  }
  if (primAcc !== null && candAcc < primAcc - thresholds.max_accuracy_regression) {
    return reason(
      'candidate_accuracy',
      false,
      `Candidate accuracy ${(candAcc * 100).toFixed(1)}% regresses >${(thresholds.max_accuracy_regression * 100).toFixed(0)}pp below primary ${(primAcc * 100).toFixed(1)}%.`,
    );
  }
  return reason(
    'candidate_accuracy',
    true,
    `Candidate accuracy ${(candAcc * 100).toFixed(1)}%${primAcc !== null ? ` vs primary ${(primAcc * 100).toFixed(1)}%` : ''} over ${labeled} labeled turns (>= ${(thresholds.min_candidate_accuracy * 100).toFixed(0)}% floor).`,
  );
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

// ───────────────────────── consecutive-clean-days (G5b) ─────────────────────
// BOOTSTRAP-SHADOW-REAL-CANDIDATE: the gate's "5 consecutive clean days" rule
// needs cross-day history. Each run persists a per-day snapshot of whether the
// day was otherwise-ready ("clean"), and reads prior snapshots to count the
// streak — turning a permanently-false rule into one that can actually be met.

const READINESS_SNAPSHOT_TOPIC = 'canary.readiness.snapshot';

export interface ReadinessSnapshot {
  date: string; // 'YYYY-MM-DD' (UTC)
  clean: boolean;
}

/** Previous calendar day (UTC) for a 'YYYY-MM-DD' string. */
export function prevUtcDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Longest run of consecutive clean days ending today. Today's cleanliness is
 * passed in (computed this run, before the snapshot is persisted); prior days
 * come from stored snapshots. A missing calendar day breaks the streak — "N
 * consecutive clean days" requires evidence for each day, so a gap is not clean.
 */
export function computeConsecutiveCleanDays(
  history: ReadinessSnapshot[],
  todayClean: boolean,
  today: string,
): number {
  if (!todayClean) return 0;
  // Latest snapshot per date wins (history is newest-first).
  const byDate = new Map<string, boolean>();
  for (const h of history) {
    if (!byDate.has(h.date)) byDate.set(h.date, h.clean);
  }
  let streak = 1; // today
  let cursor = prevUtcDay(today);
  while (byDate.get(cursor) === true) {
    streak++;
    cursor = prevUtcDay(cursor);
  }
  return streak;
}

/** Read prior daily readiness snapshots for a target (last ~14 days). */
async function fetchReadinessSnapshots(target: string): Promise<ReadinessSnapshot[]> {
  if (!PROD_SUPABASE_URL || !PROD_SUPABASE_KEY) return [];
  try {
    const sinceIso = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const resp = await fetch(
      `${PROD_SUPABASE_URL}/rest/v1/oasis_events`
      + `?topic=eq.${READINESS_SNAPSHOT_TOPIC}`
      + `&created_at=gte.${encodeURIComponent(sinceIso)}`
      + `&metadata->>target=eq.${encodeURIComponent(target)}`
      + '&order=created_at.desc&limit=200&select=created_at,metadata',
      { headers: { apikey: PROD_SUPABASE_KEY, Authorization: `Bearer ${PROD_SUPABASE_KEY}` } },
    );
    if (!resp.ok) return [];
    const rows = (await resp.json()) as Array<{ created_at: string; metadata: { date?: string; clean?: boolean } | null }>;
    const out: ReadinessSnapshot[] = [];
    for (const r of rows) {
      const date = r.metadata?.date ?? (typeof r.created_at === 'string' ? r.created_at.slice(0, 10) : null);
      if (date && typeof r.metadata?.clean === 'boolean') out.push({ date, clean: r.metadata.clean });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Persist today's snapshot so tomorrow's run can read it. Written to the SAME
 * prod store the read path uses (read/write consistency — the gateway-emit path
 * would route to a different DB). Best-effort: never fails the report.
 */
async function emitReadinessSnapshot(target: string, date: string, clean: boolean, verdict: string): Promise<void> {
  if (!PROD_SUPABASE_URL || !PROD_SUPABASE_KEY) return;
  try {
    await fetch(`${PROD_SUPABASE_URL}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        apikey: PROD_SUPABASE_KEY,
        Authorization: `Bearer ${PROD_SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        vtid: 'VTID-03217',
        topic: READINESS_SNAPSHOT_TOPIC,
        service: 'canary-readiness-report',
        role: 'eval',
        status: clean ? 'success' : 'info',
        message: `canary readiness snapshot ${target} ${date}: clean=${clean} verdict=${verdict}`,
        source: 'scripts/eval/canary-readiness-report',
        metadata: { target, date, clean, verdict },
      }),
    });
  } catch {
    /* best-effort telemetry */
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

    // Ground-truth accuracy gate (BOOTSTRAP-SHADOW-CORPUS-ACCURACY): the real
    // "is the candidate right?" check, beyond mutual agreement.
    reasons.push(accuracyReason(featureRollup));
  }

  // Fine-tune status — must have a successful run
  // VTID-03225 (Phase 1 W3-C0): explicit iam_blocked case so this report
  // agrees with PHASE-GATE-STATUS-REPORT's Vertex gate verdict instead
  // of reporting 'skipped' (which reads as "we don't know") when the
  // real state is "WIF SA lacks aiplatform.user".
  if (FINETUNE_STATUS === 'ok') {
    reasons.push(reason('finetune_run', true, 'At least one voice-tool-router Vertex training run has completed.'));
  } else if (FINETUNE_STATUS === 'iam_blocked') {
    reasons.push(reason(
      'finetune_run',
      false,
      'Vertex IAM blocked: WIF SA lacks roles/aiplatform.user; CRON-FINETUNE-TRAINER cannot queue. See PHASE-GATE-STATUS-REPORT for the gcloud unblock command.',
    ));
  } else if (FINETUNE_STATUS === 'failed') {
    reasons.push(reason('finetune_run', false, 'Most recent Vertex training run failed; investigate before canary.'));
  } else if (FINETUNE_STATUS === 'none') {
    reasons.push(reason('finetune_run', false, 'No Vertex training runs found; the candidate path is a stub. Submit CRON-FINETUNE-TRAINER.'));
  } else {
    reasons.push(reason('finetune_run', false, `Fine-tune status unknown (${FINETUNE_STATUS}); workflow probe did not classify cleanly.`));
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

  // 5-consecutive-days clean (G5b): a "clean day" is one where every OTHER
  // criterion passed. Compute today's cleanliness from the reasons gathered so
  // far, read prior daily snapshots, and count the streak ending today. main()
  // persists today's snapshot afterward so tomorrow's run can read it.
  const snapshotDate = new Date().toISOString().slice(0, 10);
  const cleanToday = reasons.every((r) => r.ok);
  const snapshotHistory = await fetchReadinessSnapshots(target);
  const consecutiveClean = computeConsecutiveCleanDays(snapshotHistory, cleanToday, snapshotDate);
  reasons.push(reason(
    'consecutive_clean_days',
    consecutiveClean >= THRESHOLDS.min_consecutive_clean_days,
    `${consecutiveClean} consecutive clean day(s)${cleanToday ? '' : ' — today not clean, streak reset'}; need ${THRESHOLDS.min_consecutive_clean_days} (read ${snapshotHistory.length} prior daily snapshot(s)).`,
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
      snapshot_date: snapshotDate,
      clean_today: cleanToday,
      consecutive_clean_days: consecutiveClean,
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
  // Persist today's snapshot so tomorrow's run can extend the streak (G5b).
  await emitReadinessSnapshot(
    report.target,
    report.evidence.snapshot_date,
    report.evidence.clean_today,
    report.verdict,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[canary-readiness-report] FAILED:', err);
    process.exit(1);
  });
}

export { generate, renderMarkdown, accuracyReason, computeConsecutiveCleanDays, prevUtcDay };
export type { CanaryReadinessReport, Reason };
