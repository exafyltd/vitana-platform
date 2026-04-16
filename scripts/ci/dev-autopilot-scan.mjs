#!/usr/bin/env node
/**
 * Dev Autopilot scanner (PR-10)
 *
 * Walks the repo, produces DevAutopilotSignal[] matching the ScanInput
 * schema in services/gateway/src/services/dev-autopilot-synthesis.ts,
 * and POSTs them to POST /api/v1/dev-autopilot/scan with the scan token.
 *
 * Kept small and zero-dep so GitHub Actions can run it without an npm
 * install. Three heuristic scanners land here:
 *
 *   - todo:          TODO / FIXME / HACK / XXX markers in source files
 *   - large_file:    files > LARGE_FILE_THRESHOLD lines (1000)
 *   - missing_tests: .ts files in src/services or src/routes without a
 *                    paired test file
 *
 * More scanners (dead_code, duplication, circular_dep, etc.) can be
 * added incrementally — each just needs to push into `signals[]`.
 *
 * Env:
 *   GATEWAY_URL                  https://gateway-q74ibpv6ia-uc.a.run.app
 *   DEV_AUTOPILOT_SCAN_TOKEN     matches gateway's DEV_AUTOPILOT_SCAN_TOKEN
 *   GITHUB_SHA                   optional — included in run metadata
 *   GITHUB_RUN_ID                optional — included in run metadata
 *   DEV_AUTOPILOT_SCAN_DRY_RUN   if 'true', print signals.json and exit
 *                                without POSTing (useful for manual runs)
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const LARGE_FILE_THRESHOLD = 1000;
const TODO_PATTERN = /\b(TODO|FIXME|HACK|XXX)\b[:\s]?([^\n]*)/;

// Only walk these roots — keeps the scan bounded and skips node_modules / dist
const SCAN_ROOTS = [
  'services/gateway/src',
  'services/agents',
  'services/worker-runner/src',
  'services/data-sync/src',
  'scripts',
  'supabase/migrations',
];

// Exts we understand — keeps the noise floor low.
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

// Services/routes that need a paired test file
const TEST_PAIR_ROOTS = [
  'services/gateway/src/services',
  'services/gateway/src/routes',
];

// Files we never scan — generated / vendored / non-source
const SKIP_SEGMENTS = new Set([
  'node_modules', 'dist', 'build', '.next', 'coverage', '__tests__',
  '.git', '.turbo', '.cache', 'vendor', '.venv', 'venv',
]);

function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (SKIP_SEGMENTS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, acc);
    } else if (e.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

function relFromRepo(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join('/');
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return null;
  }
}

// =============================================================================
// Scanner: TODO / FIXME / HACK / XXX
// =============================================================================

function scanTodos(files) {
  const signals = [];
  for (const file of files) {
    const ext = path.extname(file);
    if (!SOURCE_EXTS.has(ext)) continue;
    const lines = readLines(file);
    if (!lines) continue;
    lines.forEach((line, idx) => {
      const m = line.match(TODO_PATTERN);
      if (!m) return;
      // Cheap noise filter: skip lines inside a comment keyword word-boundary
      // with no real message (e.g. just "// TODO" on its own) — those are
      // usually placeholders, not actionable items.
      const rest = (m[2] || '').trim();
      if (rest.length < 3) return;
      signals.push({
        type: 'todo',
        severity: m[1] === 'FIXME' || m[1] === 'HACK' ? 'medium' : 'low',
        file_path: relFromRepo(file),
        line_number: idx + 1,
        message: `${m[1]}: ${rest.slice(0, 140)}`,
        suggested_action: `Resolve the ${m[1]} at ${relFromRepo(file)}:${idx + 1} — either implement, file an issue, or remove if stale.`,
        scanner: 'todo-scanner-v1',
      });
    });
  }
  return signals;
}

// =============================================================================
// Scanner: large_file
// =============================================================================

function scanLargeFiles(files) {
  const signals = [];
  for (const file of files) {
    const ext = path.extname(file);
    if (!SOURCE_EXTS.has(ext)) continue;
    const lines = readLines(file);
    if (!lines) continue;
    if (lines.length < LARGE_FILE_THRESHOLD) continue;
    const relPath = relFromRepo(file);
    signals.push({
      type: 'large_file',
      severity: lines.length > 2000 ? 'high' : 'medium',
      file_path: relPath,
      line_number: 1,
      message: `${relPath} is ${lines.length} lines — above the ${LARGE_FILE_THRESHOLD}-line threshold`,
      suggested_action: `Split ${relPath} into smaller modules along a natural seam (e.g. extract helpers, split by domain). Aim for under ${LARGE_FILE_THRESHOLD} lines.`,
      scanner: 'large-file-scanner-v1',
    });
  }
  return signals;
}

// =============================================================================
// Scanner: missing_tests
// =============================================================================

function scanMissingTests(files) {
  const signals = [];
  const testsByStem = new Map();
  // Index known tests once — filenames are *.test.ts / *.spec.ts in test/ dirs.
  for (const f of files) {
    const base = path.basename(f);
    const m = base.match(/^(.+?)\.(test|spec)\.(ts|tsx|js|mjs)$/);
    if (!m) continue;
    testsByStem.set(m[1], true);
  }

  for (const file of files) {
    const rel = relFromRepo(file);
    if (!TEST_PAIR_ROOTS.some((root) => rel.startsWith(root + '/'))) continue;
    const ext = path.extname(file);
    if (!SOURCE_EXTS.has(ext)) continue;
    const base = path.basename(file, ext);
    // Skip files that ARE tests
    if (/\.(test|spec)$/.test(base)) continue;
    // Skip barrel / type-only files
    if (base === 'index' || base === 'types') continue;
    if (testsByStem.has(base)) continue;

    signals.push({
      type: 'missing_tests',
      severity: rel.includes('/routes/') ? 'medium' : 'low',
      file_path: rel,
      line_number: 1,
      message: `${rel} has no matching ${base}.test.ts`,
      suggested_action: `Add a unit or integration test file named ${base}.test.ts that covers the public surface of ${rel}.`,
      scanner: 'missing-tests-scanner-v1',
    });
  }
  return signals;
}

// =============================================================================
// Driver
// =============================================================================

async function main() {
  const gatewayUrl = process.env.GATEWAY_URL || '';
  const scanToken = process.env.DEV_AUTOPILOT_SCAN_TOKEN || '';
  const dryRun = (process.env.DEV_AUTOPILOT_SCAN_DRY_RUN || '').toLowerCase() === 'true';

  console.log(`[dev-autopilot-scan] starting in ${REPO_ROOT}`);

  // Collect files from every scan root, once.
  const allFiles = [];
  for (const root of SCAN_ROOTS) {
    const abs = path.join(REPO_ROOT, root);
    if (!fs.existsSync(abs)) continue;
    walk(abs, allFiles);
  }
  console.log(`[dev-autopilot-scan] walked ${allFiles.length} files across ${SCAN_ROOTS.length} roots`);

  const todos = scanTodos(allFiles);
  const largeFiles = scanLargeFiles(allFiles);
  const missingTests = scanMissingTests(allFiles);
  const signals = [...todos, ...largeFiles, ...missingTests];

  console.log(`[dev-autopilot-scan] signals: todo=${todos.length} large_file=${largeFiles.length} missing_tests=${missingTests.length} total=${signals.length}`);

  // Persist signals.json next to the script so the workflow can attach it
  // as an artifact if needed.
  const outPath = path.join(REPO_ROOT, 'dev-autopilot-signals.json');
  fs.writeFileSync(outPath, JSON.stringify({ signals }, null, 2));
  console.log(`[dev-autopilot-scan] wrote ${outPath}`);

  if (dryRun) {
    console.log(`[dev-autopilot-scan] DEV_AUTOPILOT_SCAN_DRY_RUN=true — skipping POST`);
    return;
  }

  if (!gatewayUrl || !scanToken) {
    console.error(`[dev-autopilot-scan] GATEWAY_URL and DEV_AUTOPILOT_SCAN_TOKEN required for POST`);
    process.exit(1);
  }

  const body = {
    signals,
    triggered_by: 'github-actions',
    metadata: {
      github_sha: process.env.GITHUB_SHA || null,
      github_run_id: process.env.GITHUB_RUN_ID || null,
      github_ref: process.env.GITHUB_REF || null,
    },
  };

  const res = await fetch(`${gatewayUrl}/api/v1/dev-autopilot/scan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-DevAutopilot-Scan-Token': scanToken,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`[dev-autopilot-scan] POST failed ${res.status}: ${text}`);
    process.exit(1);
  }
  console.log(`[dev-autopilot-scan] POST ok ${res.status}: ${text}`);
}

main().catch((err) => {
  console.error(`[dev-autopilot-scan] unhandled error:`, err);
  process.exit(1);
});
