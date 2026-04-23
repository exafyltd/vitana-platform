#!/usr/bin/env node
/**
 * Dev Autopilot scanner driver.
 *
 * Iterates the canonical scanner list (scripts/ci/scanners/registry.mjs),
 * runs each scanner, aggregates the signals, and POSTs them to
 * POST /api/v1/dev-autopilot/scan.
 *
 * Adding a new scanner:
 *   1. Create scripts/ci/scanners/<name>.mjs exporting `meta` + `run({ files, repoRoot })`.
 *   2. Register it in scripts/ci/scanners/registry.mjs.
 *   3. Run the scanner locally with DEV_AUTOPILOT_SCAN_DRY_RUN=true to
 *      verify it produces reasonable output.
 *
 * Env:
 *   GATEWAY_URL                https://gateway-q74ibpv6ia-uc.a.run.app
 *   DEV_AUTOPILOT_SCAN_TOKEN   matches gateway's DEV_AUTOPILOT_SCAN_TOKEN
 *   GITHUB_SHA / GITHUB_RUN_ID optional — included in run metadata
 *   DEV_AUTOPILOT_SCAN_DRY_RUN if 'true', print signals.json and skip POST
 *   SCANNER_ALLOWLIST          comma-separated list of scanner ids to run
 *                              (default: all enabled scanners in the registry)
 *   SCANNER_DENYLIST           comma-separated list to skip (default: empty)
 */

import fs from 'node:fs';
import path from 'node:path';
import { walk, readFileSafe, relFromRepo, SOURCE_EXTS } from './scanners/_shared.mjs';
import { SCANNERS } from './scanners/registry.mjs';

const REPO_ROOT = process.cwd();
const LARGE_FILE_THRESHOLD = 1000;
const TODO_PATTERN = /\b(TODO|FIXME|HACK|XXX)\b[:\s]?([^\n]*)/;

// missing-tests-scanner-v1 tunables — ops can override without a redeploy.
const MISSING_TESTS_MIN_LOC = Number.parseInt(process.env.MISSING_TESTS_MIN_LOC || '50', 10);
const MISSING_TESTS_FILENAME_DENYLIST = new Set(
  (process.env.MISSING_TESTS_FILENAME_DENYLIST ||
    'types,constants,config,defaults,registry,index').split(',').map(s => s.trim()).filter(Boolean),
);

// File-walk config — shared across the inline scanners below.
const SCAN_ROOTS = [
  'services/gateway/src',
  'services/agents',
  'services/worker-runner/src',
  'services/data-sync/src',
  'scripts',
  'supabase/migrations',
];
const TEST_PAIR_ROOTS = [
  'services/gateway/src/services',
  'services/gateway/src/routes',
];

function relFromRepoLocal(p) { return relFromRepo(REPO_ROOT, p); }

// =============================================================================
// Inline legacy scanners — the four that existed before the scanner-registry PR.
// Kept inline to avoid churn; new scanners live under scripts/ci/scanners/*.mjs.
// =============================================================================

function scanTodos(files) {
  const signals = [];
  for (const file of files) {
    const ext = path.extname(file);
    if (!SOURCE_EXTS.has(ext)) continue;
    const src = readFileSafe(file);
    if (!src) continue;
    const lines = src.split('\n');
    lines.forEach((line, idx) => {
      const m = line.match(TODO_PATTERN);
      if (!m) return;
      const rest = (m[2] || '').trim();
      if (rest.length < 3) return;
      signals.push({
        type: 'todo',
        severity: m[1] === 'FIXME' || m[1] === 'HACK' ? 'medium' : 'low',
        file_path: relFromRepoLocal(file),
        line_number: idx + 1,
        message: `${m[1]}: ${rest.slice(0, 140)}`,
        suggested_action: `Resolve the ${m[1]} at ${relFromRepoLocal(file)}:${idx + 1} — either implement, file an issue, or remove if stale.`,
        scanner: 'todo-scanner-v1',
      });
    });
  }
  return signals;
}

function scanLargeFiles(files) {
  const signals = [];
  for (const file of files) {
    const ext = path.extname(file);
    if (!SOURCE_EXTS.has(ext)) continue;
    const src = readFileSafe(file);
    if (!src) continue;
    const lineCount = src.split('\n').length;
    if (lineCount < LARGE_FILE_THRESHOLD) continue;
    const relPath = relFromRepoLocal(file);
    signals.push({
      type: 'large_file',
      severity: lineCount > 2000 ? 'high' : 'medium',
      file_path: relPath,
      line_number: 1,
      message: `${relPath} is ${lineCount} lines — above the ${LARGE_FILE_THRESHOLD}-line threshold`,
      suggested_action: `Split ${relPath} into smaller modules along a natural seam (e.g. extract helpers, split by domain). Aim for under ${LARGE_FILE_THRESHOLD} lines.`,
      scanner: 'large-file-scanner-v1',
    });
  }
  return signals;
}

function isPureExportModule(lines) {
  let inBlockComment = false;
  let braceDepth = 0;
  for (let raw of lines) {
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end < 0) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    line = line.replace(/\/\*[\s\S]*?\*\//g, '');
    const blockStart = line.indexOf('/*');
    if (blockStart >= 0 && line.indexOf('*/', blockStart) < 0) {
      line = line.slice(0, blockStart);
      inBlockComment = true;
    }
    line = line.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (braceDepth > 0) {
      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;
      if (braceDepth < 0) braceDepth = 0;
      continue;
    }
    if (/^import\s/.test(line)) continue;
    if (/^export\s+\*(\s|$)/.test(line)) continue;
    if (/^export\s+\{/.test(line)) continue;
    if (/^export\s+type\b/.test(line) || /^export\s+interface\b/.test(line) || /^export\s+enum\b/.test(line)) {
      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;
      if (braceDepth < 0) braceDepth = 0;
      continue;
    }
    return false; // executable top-level statement found
  }
  return true;
}

function scanMissingTests(files) {
  const signals = [];
  const testsByStem = new Map();
  for (const f of files) {
    const base = path.basename(f);
    const m = base.match(/^(.+?)\.(test|spec)\.(ts|tsx|js|mjs)$/);
    if (!m) continue;
    testsByStem.set(m[1], true);
  }

  for (const file of files) {
    const rel = relFromRepoLocal(file);
    if (!TEST_PAIR_ROOTS.some((root) => rel.startsWith(root + '/'))) continue;
    const ext = path.extname(file);
    if (!SOURCE_EXTS.has(ext)) continue;
    if (file.endsWith('.d.ts')) continue;
    const base = path.basename(file, ext);
    if (/\.(test|spec)$/.test(base)) continue;
    if (MISSING_TESTS_FILENAME_DENYLIST.has(base)) continue;
    if (testsByStem.has(base)) continue;

    const src = readFileSafe(file);
    if (!src) continue;
    const lines = src.split('\n');
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

function scanSafetyGaps() {
  const signals = [];
  const gaps = [
    { key: 'approvals-integration', title: 'Approvals route integration test missing', source_file: 'services/gateway/src/routes/approvals.ts', test_file: 'services/gateway/test/approvals.test.ts', description: 'Integration test covering /api/v1/approvals auth + happy path + rejection path.' },
    { key: 'autopilot-integration', title: 'Autopilot route integration test missing', source_file: 'services/gateway/src/routes/autopilot.ts', test_file: 'services/gateway/test/autopilot.test.ts', description: 'Integration test covering /api/v1/autopilot list + auto-approve gating.' },
    { key: 'route-guard', title: 'Route-guard startup test missing', source_file: 'services/gateway/src/index.ts', test_file: 'services/gateway/test/route-guard.test.ts', description: 'Startup test that asserts no duplicate route registrations across the gateway.' },
    { key: 'admin-auth-coverage', title: 'Admin route auth-middleware coverage missing', source_file: 'services/gateway/src/routes/admin', test_file: 'services/gateway/test/admin-auth.test.ts', description: 'Test that every handler under routes/admin/ + routes/tenant-admin/ rejects non-admin sessions.' },
    { key: 'schema-vs-migrations', title: 'Schema-vs-migrations validator missing', source_file: 'services/gateway/src', test_file: 'services/gateway/test/schema-vs-migrations.test.ts', description: 'Test that greps every from(...).select(...) in the gateway and asserts every column exists in the latest supabase/migrations SQL.' },
    { key: 'rls-write-guard', title: 'RLS-write-deny assertion test missing', source_file: 'supabase/migrations', test_file: 'services/gateway/test/rls-write-deny.test.ts', description: 'Test that hits each write-target table with the anon key and asserts RLS rejects the write.' },
    { key: 'oasis-event-emission', title: 'OASIS event emission contract test missing', source_file: 'services/gateway/src/routes', test_file: 'services/gateway/test/oasis-emission.test.ts', description: 'Contract test: every state-mutating route handler emits a documented OASIS event from services/gateway/src/types/cicd.ts.' },
    { key: 'governance-gates', title: 'Governance kill-switch test missing', source_file: 'services/gateway/src/services', test_file: 'services/gateway/test/governance-gates.test.ts', description: 'Test that EXECUTION_DISARMED and AUTOPILOT_LOOP_ENABLED, when flipped, actually block the executor/approve paths.' },
    { key: 'deploy-smoke', title: 'Post-deploy smoke step missing in EXEC-DEPLOY', source_file: '.github/workflows/EXEC-DEPLOY.yml', test_file: '.github/workflows/EXEC-DEPLOY.yml', description: 'EXEC-DEPLOY should curl /alive and /api/v1/vtid/list post-deploy and hard-fail on non-JSON 200.' },
    { key: 'e2e-playwright-autopilot', title: 'Playwright smoke for task/approval/execution missing', source_file: 'e2e/command-hub/roles/developer', test_file: 'e2e/command-hub/roles/developer/autopilot-flow.spec.ts', description: 'e2e spec that creates a task, approves a finding, and watches one execution through to merge.' },
  ];
  for (const gap of gaps) {
    const abs = path.join(REPO_ROOT, gap.test_file);
    if (fs.existsSync(abs)) continue;
    signals.push({
      type: 'safety_gap',
      severity: 'medium',
      file_path: gap.source_file,
      line_number: 1,
      message: gap.title,
      suggested_action: `Add ${gap.test_file}. ${gap.description}`,
      scanner: 'safety-gap-scanner-v1',
      raw: { gap_key: gap.key, expected_test_file: gap.test_file },
    });
  }
  return signals;
}

// =============================================================================
// Module-loaded scanners (the 8 new ones under scripts/ci/scanners/)
// =============================================================================

// Dynamic import keeps the driver light if a scanner file is broken —
// we log and skip rather than failing the whole scan.
async function loadModuleScanners() {
  const out = new Map();
  const moduleScanners = [
    'rls-policy', 'schema-drift', 'route-auth', 'secret-exposure',
    'npm-audit', 'stale-feature-flag', 'dead-code', 'product-gap',
  ];
  for (const name of moduleScanners) {
    try {
      const mod = await import(`./scanners/${name}.mjs`);
      if (mod && mod.meta && typeof mod.run === 'function') {
        out.set(mod.meta.scanner, mod);
      }
    } catch (err) {
      console.warn(`[dev-autopilot-scan] failed to load scanner ${name}: ${err.message}`);
    }
  }
  return out;
}

// =============================================================================
// Main driver
// =============================================================================

async function main() {
  const gatewayUrl = process.env.GATEWAY_URL || '';
  const scanToken = process.env.DEV_AUTOPILOT_SCAN_TOKEN || '';
  const dryRun = (process.env.DEV_AUTOPILOT_SCAN_DRY_RUN || '').toLowerCase() === 'true';
  const allowlist = new Set((process.env.SCANNER_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean));
  const denylist = new Set((process.env.SCANNER_DENYLIST || '').split(',').map(s => s.trim()).filter(Boolean));

  console.log(`[dev-autopilot-scan] starting in ${REPO_ROOT}`);

  const allFiles = [];
  for (const root of SCAN_ROOTS) {
    const abs = path.join(REPO_ROOT, root);
    if (!fs.existsSync(abs)) continue;
    walk(abs, allFiles);
  }
  console.log(`[dev-autopilot-scan] walked ${allFiles.length} files across ${SCAN_ROOTS.length} roots`);

  const moduleScanners = await loadModuleScanners();

  function isEnabled(scannerId) {
    if (denylist.has(scannerId)) return false;
    if (allowlist.size > 0 && !allowlist.has(scannerId)) return false;
    const entry = SCANNERS.find(s => s.scanner === scannerId);
    return entry ? entry.enabled : true;
  }

  const counts = {};
  const all = [];

  // Inline legacy scanners
  for (const [id, fn] of [
    ['todo-scanner-v1', () => scanTodos(allFiles)],
    ['large-file-scanner-v1', () => scanLargeFiles(allFiles)],
    ['missing-tests-scanner-v1', () => scanMissingTests(allFiles)],
    ['safety-gap-scanner-v1', () => scanSafetyGaps()],
  ]) {
    if (!isEnabled(id)) { counts[id] = 'skipped'; continue; }
    try {
      const signals = fn();
      counts[id] = signals.length;
      all.push(...signals);
    } catch (err) {
      console.warn(`[dev-autopilot-scan] ${id} threw: ${err.message}`);
      counts[id] = 'error';
    }
  }

  // Module scanners
  for (const [id, mod] of moduleScanners) {
    if (!isEnabled(id)) { counts[id] = 'skipped'; continue; }
    try {
      const signals = await mod.run({ files: allFiles, repoRoot: REPO_ROOT });
      counts[id] = signals.length;
      all.push(...signals);
    } catch (err) {
      console.warn(`[dev-autopilot-scan] ${id} threw: ${err.message}`);
      counts[id] = 'error';
    }
  }

  const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`[dev-autopilot-scan] signals: ${summary} total=${all.length}`);

  const outPath = path.join(REPO_ROOT, 'dev-autopilot-signals.json');
  fs.writeFileSync(outPath, JSON.stringify({ signals: all, counts }, null, 2));
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
    signals: all,
    triggered_by: 'github-actions',
    metadata: {
      github_sha: process.env.GITHUB_SHA || null,
      github_run_id: process.env.GITHUB_RUN_ID || null,
      github_ref: process.env.GITHUB_REF || null,
      scanner_counts: counts,
    },
  };
  const res = await fetch(`${gatewayUrl}/api/v1/dev-autopilot/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DevAutopilot-Scan-Token': scanToken },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`[dev-autopilot-scan] POST failed ${res.status}: ${text}`);
    process.exit(1);
  }
  console.log(`[dev-autopilot-scan] POST ok ${res.status}: ${text}`);
}

main().catch(err => {
  console.error(`[dev-autopilot-scan] unhandled error:`, err);
  process.exit(1);
});
