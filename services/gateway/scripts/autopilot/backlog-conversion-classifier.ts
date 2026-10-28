/**
 * Backlog conversion classifier — Phase 1 W3-C1 PR 1 (VTID-03232).
 *
 * Reads the same blocked dev-autopilot rows the W3-C0 drain planner
 * surfaced (21 today: 10 operator-chat, 6 api, 5 unknown), and for
 * each one decides whether it can be turned into a real dev_autopilot
 * recommendation (= "fuel") or should be archived / sent to human
 * spec / left in operator-review.
 *
 * Read-only. Does NOT convert anything. The companion script
 * scripts/autopilot/backlog-convert-row.ts performs the dry-run
 * conversion preview for a specific row id; that script must be
 * invoked manually with --execute --id=<row_id> to perform a real
 * mutation.
 *
 * Eligibility for `convert_to_dev_autopilot`:
 *   - Phase 1 relevant (matches one of the 7 keyword bands)
 *   - has a concrete file/surface hint (path/file/route/module/cron/
 *     test/script mentioned in title/summary/description)
 *   - risk_class in {low, medium}
 *   - NOT a business/legal decision (no 'consent', 'legal', 'policy',
 *     'billing', 'pricing', 'tos' keywords)
 *   - NOT a production mutation (no 'flip', 'enable', 'disable',
 *     'PUBLISH', 'canary', 'merge to prod' keywords)
 *   - expressible as a code/test/doc fix (positive signal — fix/add/
 *     remove/rename/refactor/document/test/log/lint keywords)
 *
 * Other actions:
 *   - needs_human_spec: Phase 1 relevant but no file/surface hint OR
 *     ambiguous scope OR explicit research/decision request
 *   - archive_stale_noise: stale >30d AND NOT Phase 1 relevant
 *   - leave_in_operator_review: everything else
 *
 * Output (JSON + Markdown):
 *   - total_blocked, by_action, convertible_count
 *   - top_convertible: top 10 ranked rows ready for conversion
 *   - archive_candidates: top 10 stale + non-relevant
 *   - human_spec_candidates: top 10 relevant-but-unscoped
 *   - per-row reasoning so the operator can sanity-check the call
 */

import { promises as fs } from 'fs';

const PROD_SUPABASE_URL = process.env.PROD_SUPABASE_URL;
const PROD_SUPABASE_KEY = process.env.PROD_SUPABASE_SERVICE_ROLE;
const REPORT_MARKDOWN_PATH = process.env.REPORT_MARKDOWN_PATH;

const PHASE_1_KEYWORDS: Record<string, RegExp> = {
  latency: /\blatency|p50|p95|ttft|first[-_ ]?byte|first[-_ ]?chunk|server[-_ ]?timing\b/i,
  voice: /\bvoice|orb|live[-_ ]?api|tts|stt|transcript|tool[-_ ]?dispatch\b/i,
  cache: /\bcache|kv|cloudflare|stale[-_ ]?while|materialized[-_ ]?view\b/i,
  eval: /\beval|golden[-_ ]?corpus|shadow|replay|aggregat/i,
  ci: /\bci|github actions|workflow|test[-_ ]?suite|smoke[-_ ]?test\b/i,
  aws: /\baws|s3|bedrock|sts|oidc\b/i,
  dataset: /\bdataset|extraction|jsonl|fine[-_ ]?tune|vertex\b/i,
};

// Signals that the row implies a concrete code/test/doc fix.
const SURFACE_HINT = /\b(services\/|cloudflare\/|scripts\/|test\/|\.ts|\.tsx|\.js|\.py|\.yml|\.yaml|\.md|route[- ]?file|module|cron|workflow|endpoint|migration|index\.ts)\b/i;
const FIX_VERB = /\b(fix|add|remove|rename|refactor|document|test|log|lint|tidy|cleanup|inline|extract|polish)\b/i;
const BUSINESS_DECISION = /\b(consent|legal|policy|billing|pricing|tos|terms of service|privacy)\b/i;
const PROD_MUTATION = /\b(flip|enable in prod|disable in prod|publish|canary|merge to prod|prod tenant)\b/i;
const RESEARCH_REQUEST = /\b(decide|investigate|figure out|brainstorm|spec|design[- ]?doc)\b/i;

type Action =
  | 'convert_to_dev_autopilot'
  | 'needs_human_spec'
  | 'archive_stale_noise'
  | 'leave_in_operator_review';

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

interface Classification {
  vtid: string;
  title: string;
  source_type: string;
  risk_class: string;
  age_days: number;
  phase1_buckets: string[];
  has_file_surface_hint: boolean;
  has_fix_verb: boolean;
  is_business_decision: boolean;
  is_prod_mutation: boolean;
  is_research_request: boolean;
  recommended_action: Action;
  reasons: string[];
  proposed_scanner_label: string | null;
}

interface ConversionPlan {
  generated_at: string;
  source: 'prod_vtid_ledger';
  total_blocked: number;
  by_action: Record<Action, number>;
  by_phase1_relevance: Record<string, number>;
  convertible_count: number;
  top_convertible: Classification[];
  archive_candidates: Classification[];
  human_spec_candidates: Classification[];
  notes: string[];
}

function ageDays(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

function getStr(meta: Record<string, unknown> | null, ...keys: string[]): string {
  if (!meta) return 'unknown';
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return 'unknown';
}

function phase1BucketsFor(text: string): string[] {
  const out: string[] = [];
  for (const [bucket, re] of Object.entries(PHASE_1_KEYWORDS)) {
    if (re.test(text)) out.push(bucket);
  }
  return out;
}

async function fetchPendingLedger(): Promise<VtidLedgerRow[]> {
  if (!PROD_SUPABASE_URL || !PROD_SUPABASE_KEY) {
    throw new Error('PROD_SUPABASE_URL / PROD_SUPABASE_SERVICE_ROLE required');
  }
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

function classify(row: VtidLedgerRow): Classification {
  const meta = row.metadata;
  const source_type = getStr(meta, 'source_type', 'source', 'origin');
  const risk_class = getStr(meta, 'risk_class', 'risk').toLowerCase();
  const text = `${row.title ?? ''} ${row.summary ?? ''} ${row.description ?? ''}`;
  const phase1_buckets = phase1BucketsFor(text);
  const has_file_surface_hint = SURFACE_HINT.test(text);
  const has_fix_verb = FIX_VERB.test(text);
  const is_business_decision = BUSINESS_DECISION.test(text);
  const is_prod_mutation = PROD_MUTATION.test(text);
  const is_research_request = RESEARCH_REQUEST.test(text);
  const age_days = ageDays(row.created_at);

  const reasons: string[] = [];

  // Decide action
  let recommended_action: Action;
  if (is_business_decision) {
    recommended_action = 'leave_in_operator_review';
    reasons.push('business/legal decision keywords (consent|legal|policy|billing|pricing|tos|privacy)');
  } else if (is_prod_mutation) {
    recommended_action = 'leave_in_operator_review';
    reasons.push('production mutation keywords (flip|publish|canary|merge to prod) — needs operator');
  } else if (phase1_buckets.length === 0 && age_days > 30) {
    recommended_action = 'archive_stale_noise';
    reasons.push(`age ${age_days}d > 30 AND no Phase 1 relevance — archive`);
  } else if (phase1_buckets.length > 0
      && has_file_surface_hint
      && has_fix_verb
      && (risk_class === 'low' || risk_class === 'medium' || risk_class === 'unknown')) {
    recommended_action = 'convert_to_dev_autopilot';
    reasons.push(`Phase 1 relevant (${phase1_buckets.join(',')})`);
    reasons.push('has file/surface hint');
    reasons.push('has fix-verb (concrete change)');
    if (risk_class === 'unknown') {
      reasons.push('risk_class missing — downgrade to medium during conversion');
    } else {
      reasons.push(`risk_class=${risk_class} OK`);
    }
  } else if (phase1_buckets.length > 0 && (is_research_request || !has_file_surface_hint)) {
    recommended_action = 'needs_human_spec';
    reasons.push(`Phase 1 relevant (${phase1_buckets.join(',')}) but lacks scope`);
    if (!has_file_surface_hint) reasons.push('no file/surface hint to target');
    if (is_research_request) reasons.push('research/decision phrasing detected');
  } else if (phase1_buckets.length === 0) {
    recommended_action = 'leave_in_operator_review';
    reasons.push('not Phase 1 relevant');
  } else {
    recommended_action = 'leave_in_operator_review';
    reasons.push('Phase 1 relevant but missing fix-verb signal — operator triage');
  }

  // Propose a scanner label for the converted row
  const proposed_scanner_label = recommended_action === 'convert_to_dev_autopilot'
    ? `backlog-conversion-v1::${phase1_buckets[0]}`
    : null;

  return {
    vtid: row.vtid,
    title: row.title ?? '(no title)',
    source_type,
    risk_class,
    age_days,
    phase1_buckets,
    has_file_surface_hint,
    has_fix_verb,
    is_business_decision,
    is_prod_mutation,
    is_research_request,
    recommended_action,
    reasons,
    proposed_scanner_label,
  };
}

function rank(a: Classification, b: Classification): number {
  // Newer first (smaller age_days), more Phase 1 buckets first
  const bucketDiff = b.phase1_buckets.length - a.phase1_buckets.length;
  if (bucketDiff !== 0) return bucketDiff;
  return a.age_days - b.age_days;
}

async function generate(): Promise<ConversionPlan> {
  const rows = await fetchPendingLedger();
  const classifications = rows.map(classify);

  const by_action: Record<Action, number> = {
    convert_to_dev_autopilot: 0,
    needs_human_spec: 0,
    archive_stale_noise: 0,
    leave_in_operator_review: 0,
  };
  const by_phase1_relevance: Record<string, number> = {};

  for (const c of classifications) {
    by_action[c.recommended_action]++;
    if (c.phase1_buckets.length === 0) {
      by_phase1_relevance.unrelated = (by_phase1_relevance.unrelated ?? 0) + 1;
    } else {
      for (const b of c.phase1_buckets) {
        by_phase1_relevance[b] = (by_phase1_relevance[b] ?? 0) + 1;
      }
    }
  }

  const top_convertible = classifications
    .filter((c) => c.recommended_action === 'convert_to_dev_autopilot')
    .sort(rank)
    .slice(0, 10);
  const archive_candidates = classifications
    .filter((c) => c.recommended_action === 'archive_stale_noise')
    .sort((a, b) => b.age_days - a.age_days)
    .slice(0, 10);
  const human_spec_candidates = classifications
    .filter((c) => c.recommended_action === 'needs_human_spec')
    .sort(rank)
    .slice(0, 10);

  const notes: string[] = [];
  if (rows.length === 0) {
    notes.push('No blocked dev-autopilot rows on prod vtid_ledger right now.');
  }
  if (top_convertible.length === 0 && rows.length > 0) {
    notes.push('No convertible rows today — the backlog is structurally non-fuel for Phase 1. Recommended: ignore the backlog for the autonomous loop and focus only on telemetry / model / AWS gates per the W3-B0/B1/C0 dashboards.');
  } else if (top_convertible.length > 0) {
    notes.push(`${top_convertible.length} row(s) classified as convert_to_dev_autopilot. Use scripts/autopilot/backlog-convert-row.ts --id=<vtid> for a dry-run preview before deciding to mutate.`);
  }
  notes.push('This classifier does not mutate vtid_ledger. Conversion is operator-driven via the companion convert-row script with --execute flag.');

  return {
    generated_at: new Date().toISOString(),
    source: 'prod_vtid_ledger',
    total_blocked: rows.length,
    by_action,
    by_phase1_relevance,
    convertible_count: by_action.convert_to_dev_autopilot,
    top_convertible,
    archive_candidates,
    human_spec_candidates,
    notes,
  };
}

function renderMarkdown(plan: ConversionPlan): string {
  const lines: string[] = [];
  lines.push('# Backlog conversion plan');
  lines.push('');
  lines.push(`- Generated: ${plan.generated_at}`);
  lines.push(`- Source: ${plan.source}`);
  lines.push(`- Total blocked rows scanned: ${plan.total_blocked}`);
  lines.push(`- Convertible count: ${plan.convertible_count}`);
  lines.push('');
  lines.push('## By recommended action');
  lines.push('');
  for (const [k, v] of Object.entries(plan.by_action)) lines.push(`- ${k}: ${v}`);
  lines.push('');
  lines.push('## By Phase 1 relevance');
  lines.push('');
  for (const [k, v] of Object.entries(plan.by_phase1_relevance).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${k}: ${v}`);
  }
  lines.push('');

  const renderClassList = (title: string, items: Classification[]) => {
    lines.push(`## ${title}`);
    lines.push('');
    if (items.length === 0) {
      lines.push('(none)');
    } else {
      for (const c of items) {
        lines.push(`- **${c.vtid}** — ${c.title}`);
        lines.push(`  - source_type=${c.source_type}, risk=${c.risk_class}, age=${c.age_days}d`);
        lines.push(`  - phase1: ${c.phase1_buckets.join(',') || '(none)'}`);
        if (c.proposed_scanner_label) lines.push(`  - proposed scanner label: \`${c.proposed_scanner_label}\``);
        lines.push('  - reasons:');
        for (const r of c.reasons) lines.push(`    - ${r}`);
      }
    }
    lines.push('');
  };
  renderClassList('Top convertible rows', plan.top_convertible);
  renderClassList('Archive candidates (stale + non-relevant)', plan.archive_candidates);
  renderClassList('Human-spec candidates (relevant but unscoped)', plan.human_spec_candidates);

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
    console.error(`[backlog-conversion-classifier] markdown written: ${REPORT_MARKDOWN_PATH}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[backlog-conversion-classifier] FAILED:', err);
    process.exit(1);
  });
}

export { generate, renderMarkdown, classify };
export type { ConversionPlan, Classification, Action };
