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

// missing-tests-scanner-v1 quality filters. Recent scans produced ~338
// findings; ~60-80 of those were files that don't warrant unit tests
// (types/constants/config modules, thin re-exports, barrels). These
// filters target the noise without touching files that genuinely need
// coverage. All are env-overridable so ops can tune without a redeploy.
const MISSING_TESTS_MIN_LOC = Number.parseInt(process.env.MISSING_TESTS_MIN_LOC || '50', 10);
const MISSING_TESTS_FILENAME_DENYLIST = new Set(
  (process.env.MISSING_TESTS_FILENAME_DENYLIST ||
    'types,constants,config,defaults,registry,index').split(',').map(s => s.trim()).filter(Boolean),
);

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
    if (ext === '.d.ts' || file.endsWith('.d.ts')) continue;
    const base = path.basename(file, ext);
    // Skip files that ARE tests
    if (/\.(test|spec)$/.test(base)) continue;
    // Filename denylist — broadens the earlier index/types skip to cover
    // config/constants/defaults/registry modules that are pure data.
    if (MISSING_TESTS_FILENAME_DENYLIST.has(base)) continue;
    if (testsByStem.has(base)) continue;

    // Size + pure-export filters require reading the file. Only pay the
    // cost once we know it's a candidate.
    const lines = readLines(file);
    if (!lines) continue;
    if (lines.length < MISSING_TESTS_MIN_LOC) continue;
    if (isPureExportModule(lines)) continue;

    signals.push({
      type: 'missing_tests',
      severity: rel.includes('/routes/') ? 'medium' : 'low',
      file_path: rel,
      line_number: 1,
      message: `${rel} has no matching ${base}.test.ts`,
      suggested_action: `Add a unit or integration test file named ${base}.test.ts that covers the public surface of ${rel}.`,
      scanner: 'missing-tests-scanner-v1',
      raw: { file_loc: lines.length },
    });
  }
  return signals;
}

/**
 * True when a file's only top-level statements are imports, `export …`
 * re-exports, or pure type/interface declarations — nothing that produces
 * runtime behaviour worth unit-testing. Runs line-by-line rather than with
 * a full AST so we stay zero-dep.
 */
function isPureExportModule(lines) {
  let inBlockComment = false;
  let braceDepth = 0;
  let sawExecutable = false;
  for (let raw of lines) {
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end < 0) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    // Strip trailing line comments and inline block comments.
    line = line.replace(/\/\*[\s\S]*?\*\//g, '');
    const blockStart = line.indexOf('/*');
    if (blockStart >= 0 && line.indexOf('*/', blockStart) < 0) {
      line = line.slice(0, blockStart);
      inBlockComment = true;
    }
    line = line.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    // Track brace depth so bodies of type/interface blocks don't trip us.
    if (braceDepth > 0) {
      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;
      if (braceDepth < 0) braceDepth = 0;
      continue;
    }
    if (/^import\s/.test(line)) continue;
    if (/^export\s+\*(\s|$)/.test(line)) continue;
    if (/^export\s+\{/.test(line)) continue;
    if (/^export\s+type\b/.test(line)) {
      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;
      if (braceDepth < 0) braceDepth = 0;
      continue;
    }
    if (/^export\s+interface\b/.test(line) || /^export\s+enum\b/.test(line)) {
      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;
      if (braceDepth < 0) braceDepth = 0;
      continue;
    }
    // Anything else (function, class, const expression, top-level call) counts
    // as executable — unit tests could plausibly cover it.
    sawExecutable = true;
    break;
  }
  return !sawExecutable;
}

// =============================================================================
// Scanner: safety_gap
// =============================================================================

/**
 * Infrastructure-class test gaps — routes without integration coverage,
 * migrations without RLS assertions, governance toggles without tests.
 * These have bitten production more often than line-coverage gaps, so
 * they emit at medium severity and higher impact.
 *
 * Each item is a static inventory entry; we check the repo state once
 * per scan and emit a finding when the expected guard file is absent.
 * Adding a new gap here is cheap and doesn't need LLM help.
 */
function scanSafetyGaps() {
  const signals = [];
  const gaps = [
    {
      key: 'approvals-integration',
      title: 'Approvals route integration test missing',
      source_file: 'services/gateway/src/routes/approvals.ts',
      test_file: 'services/gateway/test/approvals.test.ts',
      description: 'Integration test covering /api/v1/approvals auth + happy path + rejection path.',
    },
    {
      key: 'autopilot-integration',
      title: 'Autopilot route integration test missing',
      source_file: 'services/gateway/src/routes/autopilot.ts',
      test_file: 'services/gateway/test/autopilot.test.ts',
      description: 'Integration test covering /api/v1/autopilot list + auto-approve gating.',
    },
    {
      key: 'route-guard',
      title: 'Route-guard startup test missing',
      source_file: 'services/gateway/src/index.ts',
      test_file: 'services/gateway/test/route-guard.test.ts',
      description: 'Startup test that asserts no duplicate route registrations across the gateway.',
    },
    {
      key: 'admin-auth-coverage',
      title: 'Admin route auth-middleware coverage missing',
      source_file: 'services/gateway/src/routes/admin',
      test_file: 'services/gateway/test/admin-auth.test.ts',
      description: 'Test that every handler under routes/admin/ + routes/tenant-admin/ rejects non-admin sessions.',
    },
    {
      key: 'schema-vs-migrations',
      title: 'Schema-vs-migrations validator missing',
      source_file: 'services/gateway/src',
      test_file: 'services/gateway/test/schema-vs-migrations.test.ts',
      description: 'Test that greps every from(...).select(...) in the gateway and asserts every column exists in the latest supabase/migrations SQL.',
    },
    {
      key: 'rls-write-guard',
      title: 'RLS-write-deny assertion test missing',
      source_file: 'supabase/migrations',
      test_file: 'services/gateway/test/rls-write-deny.test.ts',
      description: 'Test that hits each write-target table with the anon key and asserts RLS rejects the write.',
    },
    {
      key: 'oasis-event-emission',
      title: 'OASIS event emission contract test missing',
      source_file: 'services/gateway/src/routes',
      test_file: 'services/gateway/test/oasis-emission.test.ts',
      description: 'Contract test: every state-mutating route handler emits a documented OASIS event from services/gateway/src/types/cicd.ts.',
    },
    {
      key: 'governance-gates',
      title: 'Governance kill-switch test missing',
      source_file: 'services/gateway/src/services',
      test_file: 'services/gateway/test/governance-gates.test.ts',
      description: 'Test that EXECUTION_DISARMED and AUTOPILOT_LOOP_ENABLED, when flipped, actually block the executor/approve paths.',
    },
    {
      key: 'deploy-smoke',
      title: 'Post-deploy smoke step missing in EXEC-DEPLOY',
      source_file: '.github/workflows/EXEC-DEPLOY.yml',
      test_file: '.github/workflows/EXEC-DEPLOY.yml',
      description: 'EXEC-DEPLOY should curl /alive and /api/v1/vtid/list post-deploy and hard-fail on non-JSON 200.',
    },
    {
      key: 'e2e-playwright-autopilot',
      title: 'Playwright smoke for task/approval/execution missing',
      source_file: 'e2e/command-hub/roles/developer',
      test_file: 'e2e/command-hub/roles/developer/autopilot-flow.spec.ts',
      description: 'e2e spec that creates a task, approves a finding, and watches one execution through to merge.',
    },
  ];

  for (const gap of gaps) {
    const rel = gap.test_file;
    const abs = path.join(REPO_ROOT, rel);
    // Only emit when the expected guard file is absent. Stale-coverage
    // detection is a follow-up — start simple, catch the binary gap.
    if (fs.existsSync(abs)) continue;
    signals.push({
      type: 'safety_gap',
      severity: 'medium',
      file_path: gap.source_file,
      line_number: 1,
      message: gap.title,
      suggested_action: `Add ${rel}. ${gap.description}`,
      scanner: 'safety-gap-scanner-v1',
      raw: { gap_key: gap.key, expected_test_file: rel },
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
  const safetyGaps = scanSafetyGaps();
  const signals = [...todos, ...largeFiles, ...missingTests, ...safetyGaps];

  console.log(`[dev-autopilot-scan] signals: todo=${todos.length} large_file=${largeFiles.length} missing_tests=${missingTests.length} safety_gap=${safetyGaps.length} total=${signals.length}`);

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
