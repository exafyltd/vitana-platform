/**
 * Shadow-comparison report — Phase 1 W3-A (VTID-03212).
 *
 * Calls the staging-only admin endpoint
 *   GET /api/v1/admin/staging/eval/shadow-comparison-report?window_hours=N
 * (added in the same PR; see services/gateway/src/routes/admin-staging.ts)
 * and emits a structured report to stdout as JSON, plus a human-readable
 * Markdown rendering to a sibling file.
 *
 * Used by the daily CRON-SHADOW-COMPARISON-REPORT workflow and runnable
 * locally for spot-checks.
 *
 * Output:
 *   - stdout: JSON (machine-readable, suitable for piping into jq / further
 *     analysis)
 *   - $REPORT_MARKDOWN_PATH (env, optional): Markdown file written to disk
 *     for the workflow to upload as an artifact
 *
 * Insufficient-data behavior: exits 0 with a clearly-marked
 * "insufficient shadow data" payload. Never throws on empty windows —
 * that's the expected state until staging voice traffic accumulates.
 *
 * Env:
 *   STAGING_GATEWAY_URL (default: https://gateway-staging-q74ibpv6ia-uc.a.run.app)
 *   GATEWAY_SERVICE_TOKEN (required)
 *   WINDOW_HOURS (default 24)
 *   REPORT_MARKDOWN_PATH (optional)
 */

import { promises as fs } from 'fs';

const STAGING_GATEWAY_URL = process.env.STAGING_GATEWAY_URL
  || 'https://gateway-staging-q74ibpv6ia-uc.a.run.app';
const SERVICE_TOKEN = process.env.GATEWAY_SERVICE_TOKEN;
const WINDOW_HOURS = Number(process.env.WINDOW_HOURS ?? 24);
const REPORT_MARKDOWN_PATH = process.env.REPORT_MARKDOWN_PATH;

interface FeatureRollup {
  feature: string;
  total_comparisons: number;
  agreement_rate: number | null;
  mismatch_rate: number | null;
  primary_p50_ms: number;
  primary_p95_ms: number;
  candidate_p50_ms: number;
  candidate_p95_ms: number;
  delta_p50_pct: number | null;
  delta_p95_pct: number | null;
  candidate_error_rate: number;
  candidate_fallback_count: number;
}

interface ReportResponse {
  ok: boolean;
  env: string;
  window_hours: number;
  since_iso: string;
  generated_at: string;
  total_events: number;
  insufficient_data: boolean;
  message?: string;
  features: FeatureRollup[];
}

function pct(n: number | null): string {
  if (n === null) return '—';
  return `${n.toFixed(2)}%`;
}

function num(n: number | null | undefined, suffix = ''): string {
  if (n === null || n === undefined) return '—';
  return `${n.toFixed(1)}${suffix}`;
}

function rate(n: number | null): string {
  if (n === null) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function renderMarkdown(report: ReportResponse): string {
  const lines: string[] = [];
  lines.push('# Shadow-comparison report');
  lines.push('');
  lines.push(`- **Generated:** ${report.generated_at}`);
  lines.push(`- **Env:** ${report.env}`);
  lines.push(`- **Window:** last ${report.window_hours}h (since ${report.since_iso})`);
  lines.push(`- **Total comparisons:** ${report.total_events}`);
  lines.push('');

  if (report.insufficient_data) {
    lines.push('> **Insufficient shadow data.** No `eval.shadow.compared` events were emitted in this window.');
    lines.push('> Expected until staging voice traffic accumulates against the `FEATURE_SHADOW_TOOL_ROUTER_ENV=staging-only` path.');
    lines.push('');
    lines.push(`Status: \`${report.message ?? 'insufficient data'}\``);
    return lines.join('\n') + '\n';
  }

  lines.push('## Per-feature rollup');
  lines.push('');
  lines.push('| Feature | n | Agreement | Mismatch | Primary p50/p95 | Candidate p50/p95 | Δ p50 / Δ p95 | Err rate | Fallback |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const f of report.features) {
    lines.push(
      `| \`${f.feature}\` | ${f.total_comparisons} | ${rate(f.agreement_rate)} | ${rate(f.mismatch_rate)}`
      + ` | ${num(f.primary_p50_ms, 'ms')} / ${num(f.primary_p95_ms, 'ms')}`
      + ` | ${num(f.candidate_p50_ms, 'ms')} / ${num(f.candidate_p95_ms, 'ms')}`
      + ` | ${pct(f.delta_p50_pct)} / ${pct(f.delta_p95_pct)}`
      + ` | ${rate(f.candidate_error_rate)} | ${f.candidate_fallback_count} |`,
    );
  }
  lines.push('');
  lines.push('## Reading the columns');
  lines.push('');
  lines.push('- **Agreement** = primary and candidate produced the same `extractKey()` result.');
  lines.push('- **Δ p50 / Δ p95** = candidate latency relative to primary (negative = faster).');
  lines.push('- **Err rate** = fraction of comparisons where the candidate path threw.');
  lines.push('- **Fallback** = count of comparisons where the candidate returned `no_decision` or `candidate_fallback`.');
  lines.push('');
  lines.push('## Graduation thresholds (auto-promoter defaults)');
  lines.push('');
  lines.push('- min samples per feature: 200');
  lines.push('- min agreement: 92%');
  lines.push('- max candidate p95: 800ms');
  lines.push('- max candidate error rate: 2%');
  lines.push('');
  lines.push('These are the same thresholds the hourly auto-promoter applies. A feature meeting all four is what the graduation recommender will eventually flag as PUBLISH-ready.');

  return lines.join('\n') + '\n';
}

async function fetchReport(): Promise<ReportResponse> {
  if (!SERVICE_TOKEN) {
    throw new Error('GATEWAY_SERVICE_TOKEN env var is required');
  }
  const url = `${STAGING_GATEWAY_URL}/api/v1/admin/staging/eval/shadow-comparison-report?window_hours=${WINDOW_HOURS}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '<no body>');
    throw new Error(`endpoint returned HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  return (await resp.json()) as ReportResponse;
}

async function main(): Promise<void> {
  const report = await fetchReport();
  console.log(JSON.stringify(report, null, 2));

  if (REPORT_MARKDOWN_PATH) {
    await fs.writeFile(REPORT_MARKDOWN_PATH, renderMarkdown(report), 'utf-8');
    console.error(`[shadow-comparison-report] markdown written: ${REPORT_MARKDOWN_PATH}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[shadow-comparison-report] FAILED:', err);
    process.exit(1);
  });
}

export { fetchReport, renderMarkdown };
export type { ReportResponse, FeatureRollup };
