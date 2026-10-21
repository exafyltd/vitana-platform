#!/usr/bin/env node
/**
 * BOOTSTRAP-VALIDATOR-LOCAL-PREFLIGHT — run VALIDATOR-CHECK.yml's PR-body and
 * metadata gates locally, in under a second, instead of discovering a format
 * miss only after a full ~2-3 minute CI run.
 *
 * Real cost this exists to avoid: PR #3330 (VTID-03933) and PR #3332
 * (VTID-03934) each round-tripped through a full CI run TWICE for two
 * separate strict-format misses in the PR body — "Verified manually:"
 * instead of a leading `TEST:` token (Acceptance Mapping Gate, exit 41), and
 * `OASIS_IMPACT: None — pure logic change` instead of the literal token
 * `OASIS_IMPACT: yes` or `OASIS_IMPACT: no` (OASIS Traceability Gate, exit
 * 80). Neither miss touched the actual engineering verification (tests,
 * mutation checks, tsc, the full suite) — both were pure PR-metadata
 * formatting that CI could only report after ~19 other jobs had already run.
 *
 * This script mirrors VALIDATOR-CHECK.yml's `validate-pr` job step-by-step,
 * SAME ORDER, SAME EXIT CODES, so its output can be diffed 1:1 against a CI
 * log. It reuses `validator-path-guard.cjs` directly for the three checks
 * that already live there (path ownership, CSP-added-lines, route-mount
 * trigger) rather than re-implementing them — that module has its own tests
 * and its own hard-won lessons about parsing traps; duplicating its logic
 * here would just create a second copy to keep in sync (the exact failure
 * mode VTID-03696's header comment already warns about for REMIT).
 *
 * DELIBERATELY NOT INCLUDED: the Build Gate (`npm ci && npm run build`,
 * ~1-2 minutes). That step is real engineering verification, not formatting,
 * and the whole point of this tool is to catch cheap mistakes cheaply
 * without giving anyone a reason to skip the expensive, load-bearing check.
 * Run it yourself (`cd services/gateway && npm run build`) as you already
 * would; `--build` here will run the identical command if you want one tool
 * to call both.
 *
 * USAGE
 *   node scripts/ci/validate-pr-locally.cjs \
 *     --title "VTID-03933: Fix guessAreaFromText() Auth ordering bug" \
 *     --body-file /tmp/pr-body.md \
 *     [--base main] [--build]
 *
 *   node scripts/ci/validate-pr-locally.cjs --title-file /tmp/pr-title.txt --body-file /tmp/pr-body.md
 *
 * Exit codes are IDENTICAL to VALIDATOR-CHECK.yml's `validate-pr` job — see
 * that workflow's inline comments for what each one means. 0 = APPROVED.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const { readFileSync, existsSync, statSync } = require('node:fs');
const path = require('node:path');

const {
  evaluate: evaluatePathOwnership,
  routeEvidenceRequired,
  cspViolationsInAddedLines,
  CSP_SURFACE,
} = require('./validator-path-guard.cjs');

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function gitDiffNameOnly(root, base) {
  execFileSync('git', ['fetch', 'origin', base], { cwd: root, stdio: 'pipe' });
  const out = execFileSync('git', ['diff', '--name-only', `origin/${base}...HEAD`], {
    cwd: root,
    encoding: 'utf8',
  });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

function gitDiffScoped(root, base, pathspecs) {
  try {
    return execFileSync('git', ['diff', `origin/${base}...HEAD`, '--', ...pathspecs], {
      cwd: root,
      encoding: 'utf8',
    });
  } catch {
    return '';
  }
}

/** Mirrors the workflow's `grep -Eo '<pattern>' | head -n1 | awk '{print $2}'` idiom:
 * the regex match is a single string (label + optional whitespace + value);
 * awk then splits on whitespace and takes the SECOND field. If the PR body
 * writes "LABEL:value" with no space, awk's $2 is empty — same here. */
function grepAwkSecondField(text, pattern) {
  const m = text.match(pattern);
  if (!m) return '';
  const fields = m[0].trim().split(/\s+/);
  return fields[1] || '';
}

function extractVtid(title, body) {
  const titleMatch = title.match(/VTID-[0-9]{4,5}/);
  if (titleMatch) return titleMatch[0];
  const lineMatch = body.match(/^[ \t]*VTID:[ \t]*VTID-[0-9]{4,5}/m);
  if (lineMatch) {
    const inner = lineMatch[0].match(/VTID-[0-9]{4,5}/);
    if (inner) return inner[0];
  }
  return null;
}

/** Port of the workflow's Acceptance Mapping Gate python block, unchanged
 * logic: every `AC-\d+` line must be followed, within the next 12 lines, by
 * a line starting with TEST:/CURL:/UI:. */
function checkAcceptanceMapping(acceptancePath) {
  const messages = [];
  const txt = readFileSync(acceptancePath, 'utf8').split('\n');
  const acIdx = [];
  txt.forEach((l, i) => {
    if (/^AC-\d+/.test(l.trim())) acIdx.push(i);
  });
  if (acIdx.length === 0) {
    messages.push('REJECTED: acceptance.md has no AC- entries');
    return { code: 40, messages };
  }
  for (const i of acIdx) {
    const window = txt.slice(i + 1, i + 13);
    const mapped = window.some((w) => /^(TEST:|CURL:|UI:)/.test(w.trim()));
    if (!mapped) {
      messages.push(`REJECTED: AC at line ${i + 1} has no TEST:/CURL:/UI: mapping within 12 lines`);
      return { code: 41, messages };
    }
  }
  messages.push('Acceptance mapping OK');
  return { code: 0, messages };
}

function validate({ title, body, base, root, runBuild }) {
  const messages = [];
  const fail = (code, ...lines) => {
    messages.push(...lines);
    return { code, messages };
  };

  // --- "Collect PR text (title/body)" ---------------------------------
  if (!title.trim()) return fail(2, 'REJECTED: empty PR title');
  if (!body.trim()) return fail(2, 'REJECTED: empty PR body');

  // --- "Extract VTID + Validation Profile" ----------------------------
  const vtid = extractVtid(title, body);
  if (!vtid) {
    return fail(10, "REJECTED: no VTID in the title, and no explicit 'VTID: VTID-XXXXX' line in the body");
  }
  const profile = grepAwkSecondField(body, /VALIDATION_PROFILE:\s*[a-zA-Z0-9_/-]+/);
  if (!profile) return fail(11, 'REJECTED: VALIDATION_PROFILE missing in PR body');
  messages.push(`Detected VTID=${vtid} PROFILE=${profile}`);

  // --- "Require PR markers" -------------------------------------------
  if (!/SCOPE_ALLOWLIST:/.test(body)) return fail(12, 'REJECTED: missing SCOPE_ALLOWLIST:');
  if (!/ACCEPTANCE:/.test(body)) return fail(13, 'REJECTED: missing ACCEPTANCE:');
  if (!/MERGE_PAYLOAD_PREVIEW:/.test(body)) return fail(14, 'REJECTED: missing MERGE_PAYLOAD_PREVIEW:');
  if (!/OASIS_IMPACT:/.test(body)) return fail(15, 'REJECTED: missing OASIS_IMPACT:');

  // --- "Compute changed files" ------------------------------------------
  const changedFiles = gitDiffNameOnly(root, base);
  messages.push(`Changed files: ${changedFiles.length}`);
  if (changedFiles.length === 0) return fail(16, 'REJECTED: no changes detected');

  // --- "Enforce Path Ownership Guard (profile-based)" -------------------
  const pathResult = evaluatePathOwnership({
    profile,
    changedFiles,
    dependencyChangeDeclared: /DEPENDENCY_CHANGE:/.test(body),
  });
  messages.push(...pathResult.messages);
  if (pathResult.code !== 0) return { code: pathResult.code, messages };

  // --- "Evidence Pack Gate" ---------------------------------------------
  const evid = path.join(root, 'docs', 'validation', vtid);
  if (!existsSync(evid) || !statSync(evid).isDirectory()) {
    return fail(30, `REJECTED: missing evidence dir docs/validation/${vtid}`);
  }
  const acceptancePath = path.join(evid, 'acceptance.md');
  if (!existsSync(acceptancePath)) {
    return fail(31, `REJECTED: missing docs/validation/${vtid}/acceptance.md`);
  }
  if (!existsSync(path.join(evid, 'commands.log'))) {
    return fail(32, `REJECTED: missing docs/validation/${vtid}/commands.log`);
  }
  const outputsDir = path.join(evid, 'outputs');
  if (!existsSync(outputsDir) || !statSync(outputsDir).isDirectory()) {
    return fail(33, `REJECTED: missing docs/validation/${vtid}/outputs/`);
  }

  // --- "Acceptance Mapping Gate (no unmapped ACs)" ----------------------
  const mapping = checkAcceptanceMapping(acceptancePath);
  messages.push(...mapping.messages);
  if (mapping.code !== 0) return { code: mapping.code, messages };

  // --- "CSP Governance Gate (scan added lines only)" --------------------
  const cspDiff = gitDiffScoped(root, base, CSP_SURFACE);
  const cspViolations = cspViolationsInAddedLines(cspDiff.split('\n'));
  if (cspViolations.length > 0) {
    cspViolations.forEach((v) =>
      messages.push(`REJECTED: CSP pattern hit in an added line :: /${v.pattern}/\n  ${v.line}`),
    );
    return { code: 50, messages };
  }
  messages.push('CSP scan: no pattern hits in added lines.');

  // --- "Build Gate (profile-based)" — opt-in, see header comment --------
  if (runBuild) {
    messages.push('Running Build Gate (--build): npm ci && npm run build ...');
    const gatewayDir = path.join(root, 'services', 'gateway');
    execFileSync('npm', ['ci'], { cwd: gatewayDir, stdio: 'inherit' });
    execFileSync('npm', ['run', 'build'], { cwd: gatewayDir, stdio: 'inherit' });
    if (profile === 'command_hub_frontend') {
      const srcChanged = changedFiles.some((f) => f.startsWith('services/gateway/src/frontend/command-hub/'));
      const distChanged = changedFiles.some((f) => f.startsWith('services/gateway/dist/frontend/command-hub/'));
      if (!srcChanged || !distChanged) {
        return fail(60, 'REJECTED: command_hub_frontend requires src+dist both updated');
      }
    }
    messages.push('Build Gate OK.');
  } else {
    messages.push('Build Gate SKIPPED (pass --build to run npm ci && npm run build locally too).');
  }

  // --- "Route Mount Evidence Gate (conditional)" ------------------------
  const routeDiff = gitDiffScoped(root, base, [
    'services/gateway/src/routes/',
    'services/gateway/src/index.ts',
    'services/gateway/src/app.ts',
  ]);
  if (routeEvidenceRequired(routeDiff.split('\n'))) {
    const acceptanceText = readFileSync(acceptancePath, 'utf8');
    if (!/ROUTE_MOUNT:/.test(acceptanceText)) return fail(70, 'REJECTED: missing ROUTE_MOUNT:');
    if (!/FINAL_URL:/.test(acceptanceText)) return fail(71, 'REJECTED: missing FINAL_URL:');
    if (!/CURL_PROOF:/.test(acceptanceText)) return fail(72, 'REJECTED: missing CURL_PROOF:');
    messages.push('Route Mount Evidence Gate: route added, evidence present.');
  } else {
    messages.push('Route Mount Evidence Gate: no route registration added, skipped.');
  }

  // --- "OASIS Traceability Gate (conditional)" --------------------------
  const impact = grepAwkSecondField(body, /OASIS_IMPACT:\s*(yes|no)/);
  if (!impact) return fail(80, 'REJECTED: invalid OASIS_IMPACT value');
  if (impact === 'yes') {
    const acceptanceText = readFileSync(acceptancePath, 'utf8');
    if (!/OASIS_PROOF:/.test(acceptanceText)) return fail(81, 'REJECTED: missing OASIS_PROOF:');
  }
  messages.push(`OASIS Traceability Gate: OASIS_IMPACT=${impact}.`);

  // --- "Merge Deploy Gate" ----------------------------------------------
  if (!title.includes(vtid)) return fail(90, 'REJECTED: PR title must contain VTID for autodeploy gate');
  if (!/MERGE_PAYLOAD_PREVIEW:/.test(body)) return fail(91, 'REJECTED: missing MERGE_PAYLOAD_PREVIEW:');

  // --- "PASS summary" -----------------------------------------------------
  messages.push('APPROVED');
  messages.push(`VTID=${vtid}`);
  messages.push(`PROFILE=${profile}`);
  messages.push(`Evidence=docs/validation/${vtid}/`);
  return { code: 0, messages };
}

module.exports = { validate, extractVtid, grepAwkSecondField, checkAcceptanceMapping };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = { base: 'main', runBuild: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--title':
        opts.title = args[++i];
        break;
      case '--title-file':
        opts.title = readFileSync(args[++i], 'utf8');
        break;
      case '--body-file':
        opts.body = readFileSync(args[++i], 'utf8');
        break;
      case '--base':
        opts.base = args[++i];
        break;
      case '--build':
        opts.runBuild = true;
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(2);
    }
  }
  if (opts.title === undefined || opts.body === undefined) {
    console.error(
      'usage: validate-pr-locally.cjs (--title <str> | --title-file <path>) --body-file <path> [--base <branch>] [--build]',
    );
    process.exit(2);
  }

  const root = repoRoot();
  const { code, messages } = validate({
    title: opts.title,
    body: opts.body,
    base: opts.base,
    root,
    runBuild: opts.runBuild,
  });
  messages.forEach((m) => console.log(m));
  process.exit(code);
}
