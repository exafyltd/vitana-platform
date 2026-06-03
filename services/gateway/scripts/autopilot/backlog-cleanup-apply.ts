/**
 * Backlog cleanup APPLY — Phase 1 W3 "Autopilot Backlog Cleanup" lane
 * (BOOTSTRAP-AUTOPILOT-BACKLOG-CLEANUP).
 *
 * Safely ARCHIVES the dev-autopilot backlog rows that the existing
 * conversion classifier (scripts/autopilot/backlog-conversion-classifier.ts,
 * VTID-03232) already labelled `archive_stale_noise` — and ONLY those rows.
 *
 * This script reuses the classifier verbatim. It does NOT re-derive any
 * classification logic, keyword bands, or action ladder. It calls the
 * exported `generate()` and acts on the classifier's verdict.
 *
 * Scope (what it touches):
 *   - rows classified `archive_stale_noise`      → ARCHIVE
 *   - rows classified `leave_in_operator_review` → UNTOUCHED
 *   - rows classified `needs_human_spec`         → UNTOUCHED (human-spec item,
 *                                                   e.g. VTID-01227 auth/ORB)
 *   - rows classified `convert_to_dev_autopilot` → UNTOUCHED (operator-driven
 *                                                   conversion via convert-row)
 *
 * Archive semantics (matches the vtid_ledger status enum in CLAUDE.md:
 *   scheduled, in_progress, completed, pending, blocked, cancelled):
 *   - status            = 'cancelled'   (the terminal "did not / will not run" enum value)
 *   - is_terminal       = true
 *   - terminal_outcome  = 'cancelled'   (mirrors the documented terminal_outcome enum)
 *   - metadata.archived = { by, reason, action, archived_at }
 *
 * NEVER deletes a row. NEVER modifies executor allowlists. NEVER converts.
 *
 * DRY-RUN BY DEFAULT. Refuses to write unless BOTH:
 *   --execute
 *   --confirm=archive-stale
 *
 * Env:
 *   PROD_SUPABASE_URL            (required — read + write)
 *   PROD_SUPABASE_SERVICE_ROLE   (required — read + write)
 *   REPORT_MARKDOWN_PATH         (optional — writes a Markdown summary)
 *
 * Usage:
 *   # Dry run (default) — prints the plan, writes nothing
 *   npx tsx services/gateway/scripts/autopilot/backlog-cleanup-apply.ts
 *
 *   # Apply (operator only) — archives ONLY the archive_stale_noise rows
 *   npx tsx services/gateway/scripts/autopilot/backlog-cleanup-apply.ts \
 *     --execute --confirm=archive-stale
 */

import { promises as fs } from 'fs';
import { generate, type Classification, type ConversionPlan } from './backlog-conversion-classifier';

const PROD_SUPABASE_URL = process.env.PROD_SUPABASE_URL;
const PROD_SUPABASE_KEY = process.env.PROD_SUPABASE_SERVICE_ROLE;
const REPORT_MARKDOWN_PATH = process.env.REPORT_MARKDOWN_PATH;

const SOURCE_SCRIPT = 'scripts/autopilot/backlog-cleanup-apply.ts';
const ARCHIVE_STATUS = 'cancelled' as const;
const ARCHIVE_TERMINAL_OUTCOME = 'cancelled' as const;
const CONFIRM_TOKEN = 'archive-stale';

interface Args {
  execute: boolean;
  confirm?: string;
}

interface ArchiveResult {
  vtid: string;
  ok: boolean;
  error?: string;
}

interface CleanupSummary {
  generated_at: string;
  mode: 'dry_run' | 'executed';
  total_scanned: number;
  to_archive: Classification[];
  needs_human_spec: Classification[];
  convert_candidates: Classification[];
  left_in_operator_review_count: number;
  archive_results: ArchiveResult[];
  notes: string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = { execute: false };
  for (const a of argv.slice(2)) {
    if (a === '--execute') out.execute = true;
    else if (a.startsWith('--confirm=')) out.confirm = a.slice('--confirm='.length);
  }
  return out;
}

/**
 * Archive ONE row via a defensive PATCH. The PATCH is scoped to the exact vtid
 * AND requires is_terminal=false in the filter, so we can never re-terminalize
 * an already-terminal row or accidentally touch a sibling. No DELETE, ever.
 *
 * metadata is JSONB; we read the current value first and merge the archive
 * marker into it so existing provenance is preserved.
 */
async function archiveRow(c: Classification): Promise<ArchiveResult> {
  if (!PROD_SUPABASE_URL || !PROD_SUPABASE_KEY) {
    return { vtid: c.vtid, ok: false, error: 'PROD_SUPABASE_URL / PROD_SUPABASE_SERVICE_ROLE required' };
  }

  let existingMeta: Record<string, unknown> = {};
  try {
    const readResp = await fetch(
      `${PROD_SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(c.vtid)}&select=metadata&limit=1`,
      { headers: { apikey: PROD_SUPABASE_KEY, Authorization: `Bearer ${PROD_SUPABASE_KEY}` } },
    );
    if (readResp.ok) {
      const rows = (await readResp.json()) as Array<{ metadata: Record<string, unknown> | null }>;
      existingMeta = rows[0]?.metadata ?? {};
    }
  } catch {
    existingMeta = {};
  }

  const body = {
    status: ARCHIVE_STATUS,
    is_terminal: true,
    terminal_outcome: ARCHIVE_TERMINAL_OUTCOME,
    metadata: {
      ...existingMeta,
      archived: {
        by: SOURCE_SCRIPT,
        action: 'archive_stale_noise',
        reason: c.reasons.join('; '),
        archived_at: new Date().toISOString(),
      },
    },
  };

  const url = `${PROD_SUPABASE_URL}/rest/v1/vtid_ledger`
    + `?vtid=eq.${encodeURIComponent(c.vtid)}`
    + '&is_terminal=eq.false';

  try {
    const resp = await fetch(url, {
      method: 'PATCH',
      headers: {
        apikey: PROD_SUPABASE_KEY,
        Authorization: `Bearer ${PROD_SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      return { vtid: c.vtid, ok: false, error: `${resp.status} ${await resp.text()}` };
    }
    const updated = (await resp.json()) as unknown[];
    if (updated.length === 0) {
      // Filter matched nothing — row was already terminal (idempotent no-op).
      return { vtid: c.vtid, ok: true, error: 'already_terminal_no_op' };
    }
    return { vtid: c.vtid, ok: true };
  } catch (err) {
    return { vtid: c.vtid, ok: false, error: String(err) };
  }
}

async function run(args: Args): Promise<CleanupSummary> {
  // Reuse the classifier verbatim — single source of truth for classification.
  const plan: ConversionPlan = await generate();

  // generate() truncates each bucket to top 10 for the report. The documented
  // backlog is exactly 10 archive candidates / 10 operator-review / 1 human-spec
  // / 0 convertible, so the truncation is a non-issue here. We re-classify
  // nothing; we act ONLY on the classifier's archive_candidates list.
  const to_archive = plan.archive_candidates;
  const needs_human_spec = plan.human_spec_candidates;
  const convert_candidates = plan.top_convertible;

  const notes: string[] = [];
  notes.push(`Classifier verdict: total_blocked=${plan.total_blocked}, `
    + `archive_stale_noise=${plan.by_action.archive_stale_noise}, `
    + `needs_human_spec=${plan.by_action.needs_human_spec}, `
    + `leave_in_operator_review=${plan.by_action.leave_in_operator_review}, `
    + `convert_to_dev_autopilot=${plan.by_action.convert_to_dev_autopilot}.`);
  notes.push('This script archives ONLY archive_stale_noise rows. '
    + 'leave_in_operator_review and needs_human_spec rows are untouched.');
  notes.push('Archive = status=cancelled + is_terminal=true + terminal_outcome=cancelled. '
    + 'No row is ever deleted. No executor allowlist is ever modified.');
  if (plan.by_action.needs_human_spec > 0) {
    notes.push(`Human-spec item(s) (${needs_human_spec.map((c) => c.vtid).join(', ') || 'see classifier'}) `
      + 'are LEFT for human spec — e.g. VTID-01227 (unified auth / ORB auth).');
  }

  const archive_results: ArchiveResult[] = [];

  if (!args.execute) {
    notes.push('DRY RUN — no writes performed. Re-run with --execute --confirm=archive-stale to apply.');
    return {
      generated_at: new Date().toISOString(),
      mode: 'dry_run',
      total_scanned: plan.total_blocked,
      to_archive,
      needs_human_spec,
      convert_candidates,
      left_in_operator_review_count: plan.by_action.leave_in_operator_review,
      archive_results,
      notes,
    };
  }

  if (args.confirm !== CONFIRM_TOKEN) {
    throw new Error(`--execute requires --confirm=${CONFIRM_TOKEN}`);
  }

  // Execute path: archive each archive_stale_noise row, one PATCH at a time.
  for (const c of to_archive) {
    const result = await archiveRow(c);
    archive_results.push(result);
    console.error(`[backlog-cleanup-apply] ${result.ok ? 'archived' : 'FAILED'} ${c.vtid}${result.error ? ` (${result.error})` : ''}`);
  }
  notes.push(`EXECUTED: ${archive_results.filter((r) => r.ok).length}/${archive_results.length} rows archived.`);

  return {
    generated_at: new Date().toISOString(),
    mode: 'executed',
    total_scanned: plan.total_blocked,
    to_archive,
    needs_human_spec,
    convert_candidates,
    left_in_operator_review_count: plan.by_action.leave_in_operator_review,
    archive_results,
    notes,
  };
}

function renderMarkdown(summary: CleanupSummary): string {
  const lines: string[] = [];
  lines.push('# Autopilot backlog cleanup summary');
  lines.push('');
  lines.push(`- Generated: ${summary.generated_at}`);
  lines.push(`- Mode: **${summary.mode}**`);
  lines.push(`- Total backlog rows scanned: ${summary.total_scanned}`);
  lines.push(`- Rows to archive: ${summary.to_archive.length}`);
  lines.push(`- Rows left for human spec: ${summary.needs_human_spec.length}`);
  lines.push(`- Rows left in operator review: ${summary.left_in_operator_review_count}`);
  lines.push(`- Convert candidates (untouched, operator-driven): ${summary.convert_candidates.length}`);
  lines.push('');

  lines.push('## Would archive (archive_stale_noise)');
  lines.push('');
  if (summary.to_archive.length === 0) {
    lines.push('(none)');
  } else {
    for (const c of summary.to_archive) {
      lines.push(`- **${c.vtid}** — ${c.title} (age=${c.age_days}d)`);
      for (const r of c.reasons) lines.push(`  - ${r}`);
    }
  }
  lines.push('');

  lines.push('## Left for human spec (needs_human_spec) — UNTOUCHED');
  lines.push('');
  if (summary.needs_human_spec.length === 0) {
    lines.push('(none)');
  } else {
    for (const c of summary.needs_human_spec) {
      lines.push(`- **${c.vtid}** — ${c.title}`);
      lines.push(`  - phase1: ${c.phase1_buckets.join(',') || '(none)'}`);
      for (const r of c.reasons) lines.push(`  - ${r}`);
    }
  }
  lines.push('');

  if (summary.mode === 'executed') {
    lines.push('## Archive results');
    lines.push('');
    for (const r of summary.archive_results) {
      lines.push(`- ${r.ok ? 'OK' : 'FAILED'} \`${r.vtid}\`${r.error ? ` — ${r.error}` : ''}`);
    }
    lines.push('');
  }

  lines.push('## Notes');
  lines.push('');
  for (const n of summary.notes) lines.push(`- ${n}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const summary = await run(args);
  console.log(JSON.stringify(summary, null, 2));
  if (REPORT_MARKDOWN_PATH) {
    await fs.writeFile(REPORT_MARKDOWN_PATH, renderMarkdown(summary), 'utf-8');
    console.error(`[backlog-cleanup-apply] markdown written: ${REPORT_MARKDOWN_PATH}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[backlog-cleanup-apply] FAILED:', err);
    process.exit(1);
  });
}

export { run, renderMarkdown, archiveRow };
export type { CleanupSummary, ArchiveResult };
