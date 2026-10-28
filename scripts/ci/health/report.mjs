#!/usr/bin/env node
// VTID-05301 (plan ci-github-modernization lane ci-health) — daily CI-health report.
//
//   node scripts/ci/health/report.mjs [--runs <gh-run-list.json>] [--repo <owner/repo>]
//                                      [--branch main] [--days 30] [--out <file>] [--summary <file>]
//
// Turns the Phase-1 CI inventory into a standing signal. Reads GitHub Actions run data
// (`gh run list --json …`, read-only — never a call against production) and reports, per workflow:
//   * flake rate — a workflow is "flaky" when the same head SHA both failed and later succeeded
//     (a re-run that went green), measured over the window;
//   * red-on-main age — for every workflow whose latest `main` run concluded `failure`, how long it
//     has been red (oldest consecutive failing run on `main`);
//   * per-check median / p90 duration — from each run's createdAt→updatedAt wall time.
// It also surfaces the coverage gap from the ground-truth counts: the Playwright/e2e spec files and
// the shell/Python test scripts that no required check runs today (passed in as --coverage-gap or the
// built-in defaults), so the gap is a recurring signal rather than a one-off inventory note.
//
// Pure functions are exported for the test; main() only does I/O (read the gh JSON, write the report).
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MS_PER_HOUR = 3600 * 1000;

/** Milliseconds a run took (createdAt → updatedAt); null if either timestamp is missing or malformed. */
export function runDurationMs(run) {
  const start = Date.parse(run?.createdAt ?? '');
  const end = Date.parse(run?.updatedAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

/** Median and p90 of a list of numbers (nearest-rank p90); null for an empty list. */
export function percentiles(values) {
  const xs = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return { median: null, p90: null, count: 0 };
  const at = (p) => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1))];
  const median = xs.length % 2
    ? xs[(xs.length - 1) / 2]
    : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
  return { median, p90: at(0.9), count: xs.length };
}

/** Normalize a gh run record to the fields we use; drops runs with no workflow name. */
function norm(run) {
  return {
    name: String(run?.name ?? run?.workflowName ?? '').trim(),
    conclusion: String(run?.conclusion ?? '').trim(),
    status: String(run?.status ?? '').trim(),
    headSha: String(run?.headSha ?? run?.headBranch ?? '').trim() ? String(run?.headSha ?? '').trim() : '',
    branch: String(run?.headBranch ?? '').trim(),
    createdAt: run?.createdAt ?? '',
    updatedAt: run?.updatedAt ?? '',
    durationMs: runDurationMs(run),
  };
}

/**
 * Build the health report from an array of gh runs and the window.
 * @param {object[]} runs      gh run list --json name,conclusion,status,headSha,headBranch,createdAt,updatedAt
 * @param {object}   opts      { branch='main', nowMs=Date.now(), coverageGap=[] }
 */
export function buildReport(runs, opts = {}) {
  const branch = opts.branch || 'main';
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const rows = (Array.isArray(runs) ? runs : []).map(norm).filter((r) => r.name);

  const byWorkflow = new Map();
  for (const r of rows) {
    if (!byWorkflow.has(r.name)) byWorkflow.set(r.name, []);
    byWorkflow.get(r.name).push(r);
  }

  const workflows = [];
  for (const [name, list] of [...byWorkflow.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const finished = list.filter((r) => r.conclusion === 'success' || r.conclusion === 'failure');
    // Flake: a head SHA that both failed and succeeded in the window.
    const byHead = new Map();
    for (const r of finished) {
      if (!r.headSha) continue;
      if (!byHead.has(r.headSha)) byHead.set(r.headSha, new Set());
      byHead.get(r.headSha).add(r.conclusion);
    }
    const flakyHeads = [...byHead.values()].filter((s) => s.has('success') && s.has('failure')).length;
    const headsWithFailure = [...byHead.values()].filter((s) => s.has('failure')).length;
    const flakeRate = headsWithFailure > 0 ? flakyHeads / headsWithFailure : 0;

    // Red-on-main age: walk the branch runs newest→oldest; if the newest concluded failure,
    // the age spans back to the oldest consecutive failing run on that branch.
    const branchRuns = finished
      .filter((r) => r.branch === branch)
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
    let redSinceMs = null;
    if (branchRuns.length && branchRuns[0].conclusion === 'failure') {
      let oldest = branchRuns[0];
      for (const r of branchRuns) {
        if (r.conclusion !== 'failure') break;
        oldest = r;
      }
      const t = Date.parse(oldest.createdAt || '');
      if (Number.isFinite(t)) redSinceMs = t;
    }
    const redAgeHours = redSinceMs === null ? null : Math.max(0, Math.round((nowMs - redSinceMs) / MS_PER_HOUR));

    const { median, p90, count } = percentiles(finished.map((r) => r.durationMs).filter((v) => v !== null));

    workflows.push({
      name,
      runs: list.length,
      finished: finished.length,
      flakeRate: Number(flakeRate.toFixed(3)),
      flakyHeads,
      redOnMain: redSinceMs !== null,
      redAgeHours,
      durationCount: count,
      medianMs: median,
      p90Ms: p90,
    });
  }

  return {
    schema: 'vitana.ci-health/v1',
    generatedAt: new Date(nowMs).toISOString(),
    branch,
    windowRuns: rows.length,
    workflows,
    coverageGap: normalizeCoverageGap(opts.coverageGap),
  };
}

/** The uncovered-test coverage gap: tests with no required check. Accepts a caller list or uses defaults. */
export function normalizeCoverageGap(gap) {
  const src = Array.isArray(gap) && gap.length ? gap : DEFAULT_COVERAGE_GAP;
  return src.map((g) => ({
    kind: String(g.kind || ''),
    glob: String(g.glob || ''),
    approxCount: Number.isFinite(g.approxCount) ? g.approxCount : null,
    note: String(g.note || ''),
  }));
}

// Ground-truth coverage gaps from the Phase-1 inventory (plan "Today" section): tests that no
// required check runs today. Approximate counts; the signal is that the gap exists and persists.
export const DEFAULT_COVERAGE_GAP = [
  { kind: 'playwright-e2e', glob: 'e2e/**/*.spec.*', approxCount: 50, note: 'No required check runs the ~50 Playwright/e2e specs.' },
  { kind: 'shell-test', glob: 'scripts/**/*test*.sh', approxCount: null, note: 'Shell test scripts in vitana-platform run under no required check.' },
  { kind: 'python-test', glob: 'scripts/**/test_*.py', approxCount: null, note: 'Python test scripts in vitana-platform run under no required check.' },
];

/** Render the report as a short Markdown summary (for the GitHub step summary / artifact). */
export function renderMarkdown(report) {
  const lines = [`## CI health — ${report.branch} (${report.windowRuns} runs)`, '', `Generated ${report.generatedAt}`, ''];
  const red = report.workflows.filter((w) => w.redOnMain);
  lines.push(red.length ? `### 🔴 Red on ${report.branch} (${red.length})` : `### ✅ No workflow red on ${report.branch}`);
  for (const w of red) lines.push(`- **${w.name}** — red ${w.redAgeHours}h`);
  lines.push('');
  const flaky = report.workflows.filter((w) => w.flakyHeads > 0).sort((a, b) => b.flakeRate - a.flakeRate);
  lines.push(flaky.length ? `### ⚠️ Flaky (${flaky.length})` : '### ✅ No flaky workflow detected');
  for (const w of flaky) lines.push(`- **${w.name}** — flake rate ${(w.flakeRate * 100).toFixed(1)}% (${w.flakyHeads} head(s))`);
  lines.push('', '### Per-check duration', '', '| Workflow | runs | median | p90 |', '| --- | ---: | ---: | ---: |');
  for (const w of report.workflows) {
    const fmt = (ms) => (ms === null ? '—' : `${(ms / 60000).toFixed(1)}m`);
    lines.push(`| ${w.name} | ${w.durationCount} | ${fmt(w.medianMs)} | ${fmt(w.p90Ms)} |`);
  }
  lines.push('', `### Coverage gap (${report.coverageGap.length})`, '', 'Tests no required check runs today:');
  for (const g of report.coverageGap) {
    lines.push(`- **${g.kind}** (${g.approxCount === null ? '?' : `~${g.approxCount}`}) \`${g.glob}\` — ${g.note}`);
  }
  return lines.join('\n') + '\n';
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  const runsPath = args.runs;
  let runs = [];
  if (runsPath && existsSync(runsPath)) {
    try { runs = JSON.parse(readFileSync(runsPath, 'utf8')); } catch (e) { console.error(`cannot read ${runsPath}: ${e.message}`); return 1; }
  } else if (runsPath) {
    console.error(`--runs file not found: ${runsPath}`);
    return 1;
  }
  const report = buildReport(runs, { branch: args.branch || 'main' });
  const json = JSON.stringify(report, null, 2) + '\n';
  if (args.out) writeFileSync(args.out, json);
  const md = renderMarkdown(report);
  if (args.summary) appendFileSync(args.summary, md);
  console.log(md);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
