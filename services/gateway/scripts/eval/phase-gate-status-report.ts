/**
 * Phase gate status report — Phase 1 W3-B0 PR 2 (VTID-03216).
 *
 * Reports the current state of every operator-side gate the Phase 1
 * autonomous loop is waiting on. Tells the operator exactly which gate
 * is blocked and gives the one-line unblock command.
 *
 * Five gates checked:
 *   1. Vertex IAM        — can the WIF SA list Vertex custom jobs?
 *   2. Prod consent      — how many prod tenants have data_export_ok=true?
 *   3. AWS mirror        — AWS_BUCKET + AWS_ROLE_ARN secrets present?
 *   4. Shadow traffic    — eval.shadow.compared count, last 24h on staging
 *   5. Dataset rows      — last CRON-DATASET-EXTRACTION row count from prod
 *
 * Read-only across the board. Does NOT set prod consent, does NOT grant
 * IAM, does NOT submit Vertex jobs, does NOT modify any state.
 *
 * Output:
 *   stdout: JSON (one report object)
 *   $REPORT_MARKDOWN_PATH (env, optional): Markdown report file
 *
 * Env (all provided by the workflow):
 *   STAGING_GATEWAY_URL          (default: https://gateway-staging-q74ibpv6ia-uc.a.run.app)
 *   PROD_GATEWAY_URL             (default: https://gateway.vitanaland.com)
 *   GATEWAY_SERVICE_TOKEN        (required — read shadow report endpoint)
 *   PROD_SUPABASE_URL            (required — read prod tenant + oasis counts)
 *   PROD_SUPABASE_SERVICE_ROLE   (required — same)
 *   VERTEX_IAM_CHECK_RESULT      (ok|denied|skipped — workflow runs gcloud, passes result)
 *   AWS_BUCKET                   (optional — empty if unset)
 *   AWS_ROLE_ARN                 (optional — empty if unset)
 *   AWS_SMOKE_RESULT             (ok|denied|skipped|not_configured — workflow attempts)
 */

import { promises as fs } from 'fs';

const STAGING_GATEWAY_URL = process.env.STAGING_GATEWAY_URL
  || 'https://gateway-staging-q74ibpv6ia-uc.a.run.app';
const PROD_GATEWAY_URL = process.env.PROD_GATEWAY_URL
  || 'https://gateway.vitanaland.com';
const GATEWAY_SERVICE_TOKEN = process.env.GATEWAY_SERVICE_TOKEN;
const PROD_SUPABASE_URL = process.env.PROD_SUPABASE_URL;
const PROD_SUPABASE_KEY = process.env.PROD_SUPABASE_SERVICE_ROLE;
const VERTEX_IAM_CHECK_RESULT = process.env.VERTEX_IAM_CHECK_RESULT ?? 'skipped';
const AWS_BUCKET = process.env.AWS_BUCKET ?? '';
const AWS_ROLE_ARN = process.env.AWS_ROLE_ARN ?? '';
const AWS_SMOKE_RESULT = process.env.AWS_SMOKE_RESULT ?? 'not_configured';
const REPORT_MARKDOWN_PATH = process.env.REPORT_MARKDOWN_PATH;

type GateStatus = 'open' | 'blocked' | 'unknown';

interface GateResult {
  name: string;
  status: GateStatus;
  detail: string;
  unblock_command?: string;
  data?: Record<string, unknown>;
}

function safeNum(n: unknown): number | null {
  if (typeof n === 'number' && Number.isFinite(n)) return n;
  return null;
}

async function checkVertexIam(): Promise<GateResult> {
  switch (VERTEX_IAM_CHECK_RESULT) {
    case 'ok':
      return {
        name: 'vertex_iam',
        status: 'open',
        detail: 'WIF SA can list Vertex custom jobs (gcloud ai operations list returned 0).',
      };
    case 'denied':
      return {
        name: 'vertex_iam',
        status: 'blocked',
        detail: 'WIF SA lacks aiplatform.user; CRON-FINETUNE-TRAINER cannot create training jobs.',
        unblock_command:
          'gcloud projects add-iam-policy-binding lovable-vitana-vers1 '
          + '--member="serviceAccount:${WIF_SA}" --role="roles/aiplatform.user"',
      };
    default:
      return {
        name: 'vertex_iam',
        status: 'unknown',
        detail: 'Vertex IAM check did not run (workflow skipped the gcloud probe).',
      };
  }
}

async function checkProdConsent(): Promise<GateResult> {
  if (!PROD_SUPABASE_URL || !PROD_SUPABASE_KEY) {
    return {
      name: 'prod_consent',
      status: 'unknown',
      detail: 'Prod Supabase URL/key not resolved; cannot count consented tenants.',
    };
  }
  try {
    const resp = await fetch(
      `${PROD_SUPABASE_URL}/rest/v1/tenant_settings?select=tenant_id&feature_flags->>data_export_ok=eq.true&limit=10000`,
      {
        headers: {
          apikey: PROD_SUPABASE_KEY,
          Authorization: `Bearer ${PROD_SUPABASE_KEY}`,
          Prefer: 'count=exact',
        },
      },
    );
    if (!resp.ok) {
      return {
        name: 'prod_consent',
        status: 'unknown',
        detail: `tenant_settings query failed: ${resp.status}`,
      };
    }
    const rows = (await resp.json()) as Array<{ tenant_id: string }>;
    const count = rows.length;
    const status: GateStatus = count > 0 ? 'open' : 'blocked';
    const detail = count > 0
      ? `${count} prod tenant(s) have feature_flags.data_export_ok=true.`
      : 'No prod tenant has feature_flags.data_export_ok=true; dataset extraction will continue to yield 0 rows.';
    return {
      name: 'prod_consent',
      status,
      detail,
      unblock_command: count === 0
        ? "UPDATE tenant_settings SET feature_flags = jsonb_set(COALESCE(feature_flags, '{}'::jsonb), '{data_export_ok}', 'true'::jsonb) WHERE tenant_id IN (...);"
        : undefined,
      data: { consented_tenant_count: count },
    };
  } catch (err) {
    return {
      name: 'prod_consent',
      status: 'unknown',
      detail: `tenant_settings query threw: ${(err as Error).message}`,
    };
  }
}

async function checkAwsMirror(): Promise<GateResult> {
  if (!AWS_BUCKET || !AWS_ROLE_ARN) {
    return {
      name: 'aws_mirror',
      status: 'blocked',
      detail: 'AWS_BUCKET and/or AWS_ROLE_ARN repo secrets not set; MIRROR-ARTIFACTS-S3.yml dormant.',
      unblock_command:
        'gh secret set AWS_BUCKET --repo exafyltd/vitana-platform; '
        + 'gh secret set AWS_ROLE_ARN --repo exafyltd/vitana-platform',
    };
  }
  if (AWS_SMOKE_RESULT === 'ok') {
    return {
      name: 'aws_mirror',
      status: 'open',
      detail: 'AWS secrets present and SMOKE-AWS-MIRROR returned ok.',
      data: { aws_bucket_set: true, aws_role_arn_set: true },
    };
  }
  if (AWS_SMOKE_RESULT === 'denied') {
    return {
      name: 'aws_mirror',
      status: 'blocked',
      detail: 'AWS secrets present but smoke failed — likely AWS trust policy missing for the GitHub OIDC subject.',
      unblock_command: 'See scripts/aws/README.md for the IAM trust policy snippet.',
    };
  }
  return {
    name: 'aws_mirror',
    status: 'unknown',
    detail: `AWS secrets present; smoke result: ${AWS_SMOKE_RESULT}.`,
    data: { aws_bucket_set: true, aws_role_arn_set: true, smoke: AWS_SMOKE_RESULT },
  };
}

async function checkShadowTraffic(): Promise<GateResult> {
  if (!GATEWAY_SERVICE_TOKEN) {
    return {
      name: 'shadow_traffic',
      status: 'unknown',
      detail: 'GATEWAY_SERVICE_TOKEN not provided; cannot query shadow-comparison report.',
    };
  }
  try {
    const resp = await fetch(
      `${STAGING_GATEWAY_URL}/api/v1/admin/staging/eval/shadow-comparison-report?window_hours=24`,
      { headers: { Authorization: `Bearer ${GATEWAY_SERVICE_TOKEN}` } },
    );
    if (!resp.ok) {
      return {
        name: 'shadow_traffic',
        status: 'unknown',
        detail: `shadow-comparison-report endpoint returned HTTP ${resp.status}`,
      };
    }
    const report = (await resp.json()) as {
      total_events?: number;
      insufficient_data?: boolean;
    };
    const events = safeNum(report.total_events) ?? 0;
    const status: GateStatus = events > 0 ? 'open' : 'blocked';
    return {
      name: 'shadow_traffic',
      status,
      detail: events > 0
        ? `${events} eval.shadow.compared event(s) in last 24h on staging.`
        : 'Zero eval.shadow.compared events in last 24h; downstream reports stay empty.',
      unblock_command: events === 0
        ? 'gh workflow run EXERCISE-STAGING-SHADOW.yml --ref main -f prompts_count=15'
        : undefined,
      data: { events_24h: events },
    };
  } catch (err) {
    return {
      name: 'shadow_traffic',
      status: 'unknown',
      detail: `shadow report fetch threw: ${(err as Error).message}`,
    };
  }
}

async function checkDatasetRows(): Promise<GateResult> {
  if (!PROD_SUPABASE_URL || !PROD_SUPABASE_KEY) {
    return {
      name: 'dataset_rows',
      status: 'unknown',
      detail: 'Prod Supabase URL/key not resolved; cannot read dataset.extraction.completed.',
    };
  }
  try {
    const sinceIso = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const resp = await fetch(
      `${PROD_SUPABASE_URL}/rest/v1/oasis_events?topic=eq.dataset.extraction.completed`
      + `&created_at=gte.${encodeURIComponent(sinceIso)}`
      + `&order=created_at.desc&limit=10&select=id,created_at,metadata`,
      {
        headers: {
          apikey: PROD_SUPABASE_KEY,
          Authorization: `Bearer ${PROD_SUPABASE_KEY}`,
        },
      },
    );
    if (!resp.ok) {
      return {
        name: 'dataset_rows',
        status: 'unknown',
        detail: `dataset.extraction.completed query failed: ${resp.status}`,
      };
    }
    const events = (await resp.json()) as Array<{
      created_at: string;
      metadata: Record<string, unknown> | null;
    }>;
    if (events.length === 0) {
      return {
        name: 'dataset_rows',
        status: 'blocked',
        detail: 'No dataset.extraction.completed events in the last 7d on prod; cron may not have run.',
        unblock_command: 'gh workflow run CRON-DATASET-EXTRACTION.yml --ref main -f dry_run=false -f max_rows=5000 -f days_back=7',
      };
    }
    // Pick the most recent run's rows_after_dedup, summed per target if same run id.
    let totalRows = 0;
    const perTarget: Record<string, number> = {};
    let mostRecentRunIso = '';
    for (const e of events) {
      const m = (e.metadata ?? {}) as { target?: string; rows_after_dedup?: number };
      if (mostRecentRunIso === '') mostRecentRunIso = e.created_at;
      if (e.created_at.slice(0, 10) !== mostRecentRunIso.slice(0, 10)) continue; // only most recent day
      const target = m.target ?? 'unknown';
      const rows = safeNum(m.rows_after_dedup) ?? 0;
      perTarget[target] = (perTarget[target] ?? 0) + rows;
      totalRows += rows;
    }
    const status: GateStatus = totalRows > 0 ? 'open' : 'blocked';
    return {
      name: 'dataset_rows',
      status,
      detail: totalRows > 0
        ? `${totalRows} dataset row(s) extracted in most recent run (${mostRecentRunIso.slice(0, 10)}).`
        : `${events.length} extraction event(s) but zero rows; prod consent is the likely gate.`,
      unblock_command: totalRows === 0
        ? 'See prod_consent gate — dataset extraction only yields rows for tenants with data_export_ok=true.'
        : undefined,
      data: {
        most_recent_run_at: mostRecentRunIso,
        total_rows_most_recent: totalRows,
        per_target_rows: perTarget,
        event_count_last_7d: events.length,
      },
    };
  } catch (err) {
    return {
      name: 'dataset_rows',
      status: 'unknown',
      detail: `dataset events fetch threw: ${(err as Error).message}`,
    };
  }
}

interface PhaseGateReport {
  generated_at: string;
  overall: {
    gates_total: number;
    gates_open: number;
    gates_blocked: number;
    gates_unknown: number;
    ready_for_w3_b_to_g: boolean;
    first_blocker: string | null;
    blocked_by_priority: string[];
  };
  gates: GateResult[];
}

async function generate(): Promise<PhaseGateReport> {
  const gates = await Promise.all([
    checkVertexIam(),
    checkProdConsent(),
    checkAwsMirror(),
    checkShadowTraffic(),
    checkDatasetRows(),
  ]);
  const open = gates.filter((g) => g.status === 'open').length;
  const blocked = gates.filter((g) => g.status === 'blocked').length;
  const unknown = gates.filter((g) => g.status === 'unknown').length;

  // VTID-03222 (Phase 1 W3-B1): deterministic first_blocker ordering.
  // Previously `gates.find(blocked)` returned whichever blocked gate
  // happened to be first in array order. Operators iterating "unblock
  // them in order" need a stable priority so the same gate appears
  // first across runs even as gate state changes. Priority reflects
  // dependency order — prod_consent unblocks dataset_rows; vertex_iam
  // unblocks fine-tune training; aws_mirror unblocks W3-D; shadow
  // traffic + dataset_rows are downstream gates whose state depends on
  // the upstream ones being open.
  const GATE_PRIORITY = [
    'prod_consent',
    'vertex_iam',
    'aws_mirror',
    'shadow_traffic',
    'dataset_rows',
  ] as const;
  const blockedByPriority: GateResult[] = [];
  for (const name of GATE_PRIORITY) {
    const g = gates.find((x) => x.name === name);
    if (g && g.status === 'blocked') blockedByPriority.push(g);
  }
  // Any gates blocked but NOT in the priority list (future additions)
  // append at the end, preserving the explicit order for the known ones.
  for (const g of gates) {
    if (g.status === 'blocked' && !GATE_PRIORITY.includes(g.name as typeof GATE_PRIORITY[number])) {
      blockedByPriority.push(g);
    }
  }
  const firstBlocker = blockedByPriority[0];

  return {
    generated_at: new Date().toISOString(),
    overall: {
      gates_total: gates.length,
      gates_open: open,
      gates_blocked: blocked,
      gates_unknown: unknown,
      ready_for_w3_b_to_g: blocked === 0 && unknown === 0,
      first_blocker: firstBlocker?.name ?? null,
      blocked_by_priority: blockedByPriority.map((g) => g.name),
    },
    gates,
  };
}

function statusIcon(s: GateStatus): string {
  switch (s) {
    case 'open': return 'OPEN';
    case 'blocked': return 'BLOCKED';
    default: return 'UNKNOWN';
  }
}

function renderMarkdown(r: PhaseGateReport): string {
  const lines: string[] = [];
  lines.push('# Phase gate status report');
  lines.push('');
  lines.push(`- Generated: ${r.generated_at}`);
  lines.push(`- Gates: ${r.overall.gates_open} open / ${r.overall.gates_blocked} blocked / ${r.overall.gates_unknown} unknown`);
  lines.push(`- Ready to start W3-B..G build wave: **${r.overall.ready_for_w3_b_to_g ? 'YES' : 'NO'}**`);
  if (r.overall.first_blocker) {
    lines.push(`- First blocker: **${r.overall.first_blocker}**`);
  }
  lines.push('');
  lines.push('## Gates');
  lines.push('');
  for (const g of r.gates) {
    lines.push(`### ${g.name} — ${statusIcon(g.status)}`);
    lines.push('');
    lines.push(g.detail);
    if (g.unblock_command) {
      lines.push('');
      lines.push('Unblock command:');
      lines.push('```bash');
      lines.push(g.unblock_command);
      lines.push('```');
    }
    if (g.data) {
      lines.push('');
      lines.push('Data:');
      lines.push('```json');
      lines.push(JSON.stringify(g.data, null, 2));
      lines.push('```');
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const report = await generate();
  console.log(JSON.stringify(report, null, 2));
  if (REPORT_MARKDOWN_PATH) {
    await fs.writeFile(REPORT_MARKDOWN_PATH, renderMarkdown(report), 'utf-8');
    console.error(`[phase-gate-status-report] markdown written: ${REPORT_MARKDOWN_PATH}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[phase-gate-status-report] FAILED:', err);
    process.exit(1);
  });
}

export { generate, renderMarkdown };
export type { PhaseGateReport, GateResult, GateStatus };
