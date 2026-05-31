/**
 * Autopilot backlog drain planner — Phase 1 W3-C0 PR 1 (VTID-03224).
 *
 * Reads pending dev-autopilot rows from prod vtid_ledger and produces a
 * ranked execution plan. Does NOT execute, approve, reject, or snooze
 * anything — this is an evidence + recommendation artifact only.
 *
 * Output:
 *   stdout: JSON (BacklogDrainPlan)
 *   $REPORT_MARKDOWN_PATH (env, optional): Markdown plan
 *
 * Env (provided by the workflow):
 *   PROD_SUPABASE_URL            (required)
 *   PROD_SUPABASE_SERVICE_ROLE   (required)
 *   REPORT_MARKDOWN_PATH         (optional)
 *
 * Hard scope guards built into the candidate classifier:
 *   - source_type must be in EXECUTABLE_ALLOWLIST
 *   - risk_class must be 'low' or 'medium'
 *   - effort_score must be <= 3 (or "unknown" with a downgrade)
 *   - impact_score must be at least 1 ("low") and not null
 *   - has plan (metadata.plan_id, plan_url, or spec_markdown present),
 *     OR source_type qualifies for safe lazy planning
 *   - no active execution (status NOT in {scheduled, in_progress})
 *   - no unmerged prior PR (metadata.prior_pr_open != true)
 *   - age <= 30d (older buckets get flagged but excluded from top 3)
 *   - Phase 1 relevant — see PHASE_1_KEYWORDS
 *
 * The "recommended first drain batch of 3" is the top 3 safe candidates
 * ranked by impact_score / effort_score, with no two from the same
 * source_type/scanner pair (diversity guard).
 */

import { promises as fs } from 'fs';

const PROD_SUPABASE_URL = process.env.PROD_SUPABASE_URL;
const PROD_SUPABASE_KEY = process.env.PROD_SUPABASE_SERVICE_ROLE;
const REPORT_MARKDOWN_PATH = process.env.REPORT_MARKDOWN_PATH;

// Source types that are safe to execute autonomously after planning.
// Mirrors services/gateway/src/services/autopilot-executable-source-types.ts
// in spirit — keep narrow and explicit; new types require operator review.
const EXECUTABLE_ALLOWLIST = new Set([
  'scanner-fix',
  'lint-fix',
  'rule-fix',
  'docs-fix',
  'config-cleanup',
  'test-add',
  'unused-removal',
  'comment-fix',
]);

const PHASE_1_KEYWORDS: Record<string, RegExp> = {
  latency: /\blatency|p50|p95|ttft|first[-_ ]?byte|first[-_ ]?chunk|server[-_ ]?timing\b/i,
  voice: /\bvoice|orb|live[-_ ]?api|tts|stt|transcript|tool[-_ ]?dispatch\b/i,
  cache: /\bcache|kv|cloudflare|stale[-_ ]?while|materialized[-_ ]?view\b/i,
  eval: /\beval|golden[-_ ]?corpus|shadow|replay|aggregat/i,
  ci: /\bci|github actions|workflow|test[-_ ]?suite|smoke[-_ ]?test\b/i,
  aws: /\baws|s3|bedrock|sts|oidc\b/i,
  dataset: /\bdataset|extraction|jsonl|fine[-_ ]?tune|vertex\b/i,
};

interface VtidLedgerRow {
  vtid: string;
  title: string | null;
  description: string | null;
  summary: string | null;
  layer: string | null;
  module: string | null;
  status: string | null;
  is_terminal: boolean | null;
  created_at: string;
  updated_at: string | null;
  metadata: Record<string, unknown> | null;
}

interface Candidate {
  vtid: string;
  title: string;
  source_type: string;
  source_scanner: string;
  risk_class: string;
  effort_score: number | null;
  impact_score: number | null;
  has_plan: boolean;
  age_days: number;
  phase1_buckets: string[];
  safe: boolean;
  block_reasons: string[];
  pass_reasons: string[];
  expected_metric_improvement: string | null;
  score: number;
}

interface BacklogDrainPlan {
  generated_at: string;
  source: 'prod_vtid_ledger';
  totals: {
    pending: number;
    by_source_type: Record<string, number>;
    by_source_scanner: Record<string, number>;
    by_risk_class: Record<string, number>;
    by_effort_bucket: Record<string, number>;
    by_impact_bucket: Record<string, number>;
    has_plan: number;
    missing_plan: number;
    auto_actionable: number;
    blocked: number;
    stale_over_7d: number;
    stale_over_14d: number;
    stale_over_30d: number;
    prior_failed_or_unmerged: number;
    by_phase1_relevance: Record<string, number>;
  };
  top_10_safe: Candidate[];
  top_10_blocked_buckets: Array<{ source_type: string; count: number; sample_vtids: string[]; main_block_reason: string }>;
  recommended_first_drain_batch: Candidate[];
  notes: string[];
}

function ageDays(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

function getStr(meta: Record<string, unknown> | null, ...keys: string[]): string {
  if (!meta) return 'unknown';
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return 'unknown';
}

function getNum(meta: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (!meta) return null;
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function getBool(meta: Record<string, unknown> | null, ...keys: string[]): boolean | null {
  if (!meta) return null;
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === 'boolean') return v;
  }
  return null;
}

function phase1BucketsFor(text: string): string[] {
  const out: string[] = [];
  for (const [bucket, re] of Object.entries(PHASE_1_KEYWORDS)) {
    if (re.test(text)) out.push(bucket);
  }
  return out;
}

function effortBucket(n: number | null): string {
  if (n === null) return 'unknown';
  if (n <= 1) return 'tiny';
  if (n <= 3) return 'small';
  if (n <= 5) return 'medium';
  return 'large';
}

function impactBucket(n: number | null): string {
  if (n === null) return 'unknown';
  if (n <= 1) return 'low';
  if (n <= 3) return 'medium';
  return 'high';
}

async function fetchPendingLedger(): Promise<VtidLedgerRow[]> {
  if (!PROD_SUPABASE_URL || !PROD_SUPABASE_KEY) {
    throw new Error('PROD_SUPABASE_URL / PROD_SUPABASE_SERVICE_ROLE required');
  }
  // status NOT terminal — includes pending, scheduled, etc. layer='DEV' is
  // the dev-autopilot lane (vs COM/ADM user-facing autopilot).
  const url = `${PROD_SUPABASE_URL}/rest/v1/vtid_ledger`
    + '?layer=eq.DEV'
    + '&is_terminal=eq.false'
    + '&status=in.(pending,scheduled,planned,planning,blocked)'
    + '&order=created_at.asc&limit=5000'
    + '&select=vtid,title,description,summary,layer,module,status,is_terminal,created_at,updated_at,metadata';
  const resp = await fetch(url, {
    headers: { apikey: PROD_SUPABASE_KEY, Authorization: `Bearer ${PROD_SUPABASE_KEY}` },
  });
  if (!resp.ok) {
    throw new Error(`vtid_ledger query failed: ${resp.status} ${await resp.text()}`);
  }
  return (await resp.json()) as VtidLedgerRow[];
}

function classify(row: VtidLedgerRow): Candidate {
  const meta = row.metadata;
  const source_type = getStr(meta, 'source_type', 'source', 'origin');
  const source_scanner = getStr(meta, 'source_scanner', 'scanner', 'rule');
  const risk_class = getStr(meta, 'risk_class', 'risk').toLowerCase();
  const effort_score = getNum(meta, 'effort_score', 'effort');
  const impact_score = getNum(meta, 'impact_score', 'impact');
  const plan_present = Boolean(
    getStr(meta, 'plan_id', 'plan_url', 'plan_path') !== 'unknown'
    || getBool(meta, 'has_plan') === true,
  );
  const has_active_exec = (row.status ?? '').toLowerCase() === 'in_progress'
    || (row.status ?? '').toLowerCase() === 'scheduled';
  const prior_pr_open = getBool(meta, 'prior_pr_open', 'pr_open') === true;
  const age_days = ageDays(row.created_at);
  const text = `${row.title ?? ''} ${row.summary ?? ''} ${row.description ?? ''}`;
  const phase1_buckets = phase1BucketsFor(text);

  const block_reasons: string[] = [];
  const pass_reasons: string[] = [];

  if (!EXECUTABLE_ALLOWLIST.has(source_type)) {
    block_reasons.push(`source_type='${source_type}' not in executable allowlist`);
  } else {
    pass_reasons.push(`source_type='${source_type}' is auto-executable`);
  }
  if (risk_class !== 'low' && risk_class !== 'medium') {
    block_reasons.push(`risk_class='${risk_class}' not in {low, medium}`);
  } else {
    pass_reasons.push(`risk_class='${risk_class}' acceptable`);
  }
  if (effort_score !== null && effort_score > 3) {
    block_reasons.push(`effort_score=${effort_score} > 3`);
  } else if (effort_score !== null) {
    pass_reasons.push(`effort_score=${effort_score} small`);
  } else {
    block_reasons.push('effort_score missing');
  }
  if (impact_score === null) {
    block_reasons.push('impact_score missing');
  } else if (impact_score < 1) {
    block_reasons.push(`impact_score=${impact_score} too low`);
  } else {
    pass_reasons.push(`impact_score=${impact_score}`);
  }
  if (!plan_present) {
    block_reasons.push('no plan present; cannot lazy-plan in this gate');
  } else {
    pass_reasons.push('plan present');
  }
  if (has_active_exec) {
    block_reasons.push(`status='${row.status}' indicates active execution`);
  }
  if (prior_pr_open) {
    block_reasons.push('prior PR still open/unmerged');
  }
  if (age_days > 30) {
    block_reasons.push(`age ${age_days}d > 30 (stale)`);
  }
  if (phase1_buckets.length === 0) {
    block_reasons.push('not Phase 1 relevant (no matching keyword)');
  } else {
    pass_reasons.push(`phase1 relevance: ${phase1_buckets.join(',')}`);
  }

  const safe = block_reasons.length === 0;

  // Ranking score: impact / effort, with phase1 multiplier.
  // Stable + reproducible — no randomness.
  const baseScore = (impact_score ?? 0) / Math.max(1, effort_score ?? 1);
  const phaseBoost = 1 + 0.25 * phase1_buckets.length;
  const score = safe ? baseScore * phaseBoost : 0;

  // Expected metric improvement hint — best-effort from phase1 bucket
  const expected_metric_improvement = safe
    ? (phase1_buckets[0] === 'latency'  ? 'voice TTFT p95 or screen TTFB p95'
     : phase1_buckets[0] === 'voice'    ? 'voice turn quality or stability'
     : phase1_buckets[0] === 'cache'    ? 'top-N route hit rate / TTFB'
     : phase1_buckets[0] === 'eval'     ? 'eval coverage or shadow signal'
     : phase1_buckets[0] === 'ci'       ? 'CI stability / deploy throughput'
     : phase1_buckets[0] === 'aws'      ? 'AWS readiness / mirror reliability'
     : phase1_buckets[0] === 'dataset'  ? 'dataset row yield / training input quality'
     : null)
    : null;

  return {
    vtid: row.vtid,
    title: row.title ?? '(no title)',
    source_type,
    source_scanner,
    risk_class,
    effort_score,
    impact_score,
    has_plan: plan_present,
    age_days,
    phase1_buckets,
    safe,
    block_reasons,
    pass_reasons,
    expected_metric_improvement,
    score,
  };
}

function aggregateTotals(rows: VtidLedgerRow[], candidates: Candidate[]): BacklogDrainPlan['totals'] {
  const t: BacklogDrainPlan['totals'] = {
    pending: rows.length,
    by_source_type: {},
    by_source_scanner: {},
    by_risk_class: {},
    by_effort_bucket: {},
    by_impact_bucket: {},
    has_plan: 0,
    missing_plan: 0,
    auto_actionable: 0,
    blocked: 0,
    stale_over_7d: 0,
    stale_over_14d: 0,
    stale_over_30d: 0,
    prior_failed_or_unmerged: 0,
    by_phase1_relevance: {},
  };
  for (const c of candidates) {
    t.by_source_type[c.source_type] = (t.by_source_type[c.source_type] ?? 0) + 1;
    t.by_source_scanner[c.source_scanner] = (t.by_source_scanner[c.source_scanner] ?? 0) + 1;
    t.by_risk_class[c.risk_class] = (t.by_risk_class[c.risk_class] ?? 0) + 1;
    t.by_effort_bucket[effortBucket(c.effort_score)] = (t.by_effort_bucket[effortBucket(c.effort_score)] ?? 0) + 1;
    t.by_impact_bucket[impactBucket(c.impact_score)] = (t.by_impact_bucket[impactBucket(c.impact_score)] ?? 0) + 1;
    if (c.has_plan) t.has_plan++; else t.missing_plan++;
    if (c.safe) t.auto_actionable++; else t.blocked++;
    if (c.age_days > 7) t.stale_over_7d++;
    if (c.age_days > 14) t.stale_over_14d++;
    if (c.age_days > 30) t.stale_over_30d++;
    if (c.block_reasons.some((r) => r.includes('prior PR'))) t.prior_failed_or_unmerged++;
    if (c.phase1_buckets.length === 0) {
      t.by_phase1_relevance.unrelated = (t.by_phase1_relevance.unrelated ?? 0) + 1;
    } else {
      for (const b of c.phase1_buckets) {
        t.by_phase1_relevance[b] = (t.by_phase1_relevance[b] ?? 0) + 1;
      }
    }
  }
  return t;
}

function top10Safe(candidates: Candidate[]): Candidate[] {
  return candidates.filter((c) => c.safe).sort((a, b) => b.score - a.score).slice(0, 10);
}

function top10BlockedBuckets(candidates: Candidate[]): BacklogDrainPlan['top_10_blocked_buckets'] {
  const blocked = candidates.filter((c) => !c.safe);
  const byBucket = new Map<string, { count: number; vtids: string[]; firstReason: string }>();
  for (const c of blocked) {
    const key = c.source_type;
    const entry = byBucket.get(key) ?? { count: 0, vtids: [], firstReason: c.block_reasons[0] ?? 'unknown' };
    entry.count++;
    if (entry.vtids.length < 3) entry.vtids.push(c.vtid);
    byBucket.set(key, entry);
  }
  return [...byBucket.entries()]
    .map(([source_type, v]) => ({
      source_type,
      count: v.count,
      sample_vtids: v.vtids,
      main_block_reason: v.firstReason,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function recommendedFirstBatch(topSafe: Candidate[]): Candidate[] {
  // Pick top 3, but no two from the same source_type/scanner pair
  // (diversity guard so a single scanner doesn't monopolize the drain
  // lane and surface a systemic issue we'd want to investigate first).
  const picked: Candidate[] = [];
  const seenPairs = new Set<string>();
  for (const c of topSafe) {
    const key = `${c.source_type}::${c.source_scanner}`;
    if (seenPairs.has(key)) continue;
    picked.push(c);
    seenPairs.add(key);
    if (picked.length >= 3) break;
  }
  return picked;
}

async function generate(): Promise<BacklogDrainPlan> {
  const rows = await fetchPendingLedger();
  const candidates = rows.map(classify);
  const totals = aggregateTotals(rows, candidates);
  const topSafe = top10Safe(candidates);
  const topBlocked = top10BlockedBuckets(candidates);
  const firstBatch = recommendedFirstBatch(topSafe);
  const notes: string[] = [];
  if (rows.length === 0) {
    notes.push('No pending dev-autopilot rows in vtid_ledger right now. Queue is empty.');
  }
  if (topSafe.length === 0 && rows.length > 0) {
    notes.push('No candidates pass all drain-safety filters today. Inspect top_10_blocked_buckets for the dominant block reason and consider a small filter relaxation or upstream fix.');
  }
  if (firstBatch.length > 0) {
    notes.push('recommended_first_drain_batch is for operator review. Do NOT run autonomously — the planner intentionally does not execute, approve, or snooze anything.');
  }
  notes.push('Source_type metadata fields are read defensively (source_type / source / origin). Rows without recognized source_type appear as "unknown" and are blocked.');
  return {
    generated_at: new Date().toISOString(),
    source: 'prod_vtid_ledger',
    totals,
    top_10_safe: topSafe,
    top_10_blocked_buckets: topBlocked,
    recommended_first_drain_batch: firstBatch,
    notes,
  };
}

function renderMarkdown(plan: BacklogDrainPlan): string {
  const lines: string[] = [];
  lines.push('# Autopilot backlog drain plan');
  lines.push('');
  lines.push(`- Generated: ${plan.generated_at}`);
  lines.push(`- Source: ${plan.source}`);
  lines.push(`- Pending total: ${plan.totals.pending}`);
  lines.push(`- Auto-actionable: ${plan.totals.auto_actionable}  |  Blocked: ${plan.totals.blocked}`);
  lines.push(`- Has plan: ${plan.totals.has_plan}  |  Missing plan: ${plan.totals.missing_plan}`);
  lines.push(`- Stale: 7d=${plan.totals.stale_over_7d}  14d=${plan.totals.stale_over_14d}  30d=${plan.totals.stale_over_30d}`);
  lines.push(`- Prior PR open/unmerged: ${plan.totals.prior_failed_or_unmerged}`);
  lines.push('');
  lines.push('## Bucket counts');
  lines.push('');
  for (const [label, m] of [
    ['by source_type', plan.totals.by_source_type],
    ['by scanner/rule', plan.totals.by_source_scanner],
    ['by risk_class', plan.totals.by_risk_class],
    ['by effort bucket', plan.totals.by_effort_bucket],
    ['by impact bucket', plan.totals.by_impact_bucket],
    ['by Phase 1 relevance', plan.totals.by_phase1_relevance],
  ] as const) {
    lines.push(`### ${label}`);
    lines.push('');
    const entries = Object.entries(m).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) lines.push('(empty)');
    for (const [k, v] of entries) lines.push(`- ${k}: ${v}`);
    lines.push('');
  }

  lines.push('## Recommended first drain batch (top 3, diversity-filtered)');
  lines.push('');
  if (plan.recommended_first_drain_batch.length === 0) {
    lines.push('(no candidates pass all filters today)');
  } else {
    for (const c of plan.recommended_first_drain_batch) {
      lines.push(`- **${c.vtid}** — ${c.title}`);
      lines.push(`  - source_type=${c.source_type}, scanner=${c.source_scanner}, risk=${c.risk_class}, effort=${c.effort_score}, impact=${c.impact_score}`);
      lines.push(`  - Phase 1 buckets: ${c.phase1_buckets.join(', ') || '(none)'}`);
      lines.push(`  - score: ${c.score.toFixed(2)}`);
      lines.push(`  - expected metric improvement: ${c.expected_metric_improvement ?? '(none)'}`);
      lines.push('  - safe because:');
      for (const r of c.pass_reasons) lines.push(`    - ${r}`);
    }
  }
  lines.push('');

  lines.push('## Top 10 safe candidates');
  lines.push('');
  if (plan.top_10_safe.length === 0) {
    lines.push('(none)');
  } else {
    lines.push('| vtid | source_type | scanner | risk | effort | impact | phase1 | score |');
    lines.push('| --- | --- | --- | --- | ---: | ---: | --- | ---: |');
    for (const c of plan.top_10_safe) {
      lines.push(`| \`${c.vtid}\` | ${c.source_type} | ${c.source_scanner} | ${c.risk_class} | ${c.effort_score ?? '?'} | ${c.impact_score ?? '?'} | ${c.phase1_buckets.join(',') || '-'} | ${c.score.toFixed(2)} |`);
    }
  }
  lines.push('');

  lines.push('## Top 10 blocked buckets');
  lines.push('');
  if (plan.top_10_blocked_buckets.length === 0) {
    lines.push('(none)');
  } else {
    lines.push('| source_type | count | sample vtids | main block reason |');
    lines.push('| --- | ---: | --- | --- |');
    for (const b of plan.top_10_blocked_buckets) {
      lines.push(`| ${b.source_type} | ${b.count} | ${b.sample_vtids.map((v) => '`'+v+'`').join(', ')} | ${b.main_block_reason} |`);
    }
  }
  lines.push('');

  lines.push('## Notes');
  lines.push('');
  for (const n of plan.notes) lines.push(`- ${n}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const plan = await generate();
  console.log(JSON.stringify(plan, null, 2));
  if (REPORT_MARKDOWN_PATH) {
    await fs.writeFile(REPORT_MARKDOWN_PATH, renderMarkdown(plan), 'utf-8');
    console.error(`[backlog-drain-plan] markdown written: ${REPORT_MARKDOWN_PATH}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[backlog-drain-plan] FAILED:', err);
    process.exit(1);
  });
}

export { generate, renderMarkdown };
export type { BacklogDrainPlan, Candidate };
